import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import type { StrategyConfig } from "@dat-bot/shared";
import { generatePrivateKey } from "viem/accounts";
import {
  appConfig,
  API_LOOPBACK_HOSTS,
  loadSettings,
  saveSettings,
  deriveUrlsFromKey,
  validateMainnetRpcCandidate,
} from "./config.js";
import { publicClient, reinitClients, accountFromPrivateKey, makeWalletClient, getChainId } from "./chain.js";
import { RevisionConflictError, runtime, strategyPatchSchema } from "./runtime.js";
import { activity } from "./activity.js";
import { logger } from "./logger.js";
import { AtomicWriteCommittedError } from "./durability.js";
import {
  encryptPrivateKey,
  decryptPrivateKey,
  saveKeystore,
  loadKeystore,
  keystoreExists,
  normalizePrivateKey,
} from "./keystore.js";
import { getGameSnapshot } from "./contract.js";
import {
  startEngine,
  stopEngine,
  waitForEngineIdle,
  scheduleJitBoundary,
  schedulePreBoundaryPay,
  schedulePreBoundaryAudit,
  resetJitState,
  preflightSubmissionRecovery,
  recoverAuthorizedSubmissions,
  hasUnresolvedJitCampaignWork,
} from "./strategy.js";
import { readOwnedStatuses, readTargets } from "./service.js";
import { filterOwnedTokenIds } from "./index-tokens.js";
import { runPostMortem } from "./postmortem.js";

const strategyMutationSchema = z.object({
  expectedRevision: z.number().int().min(0),
  patch: strategyPatchSchema.refine((patch) => Object.keys(patch).length > 0, "patch must not be empty"),
}).strict();

function revisionConflict(reply: FastifyReply, err: unknown) {
  if (!(err instanceof RevisionConflictError)) throw err;
  return reply.code(409).send({ error: err.message, currentRevision: err.currentRevision });
}

/** Extract the hostname from a Host header, dropping the port (handles [::1]). */
function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim();
  if (h.startsWith("[")) return h.slice(1, h.indexOf("]")).toLowerCase(); // [IPv6]:port
  const i = h.lastIndexOf(":");
  return (i >= 0 ? h.slice(0, i) : h).toLowerCase();
}

function originHostname(origin: string): string | null {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const hostname = parsed.hostname.toLowerCase();
    return hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  } catch {
    return null;
  }
}

function chainModeError(mode: "mainnet" | "public" | "local", chainId: number): string | null {
  if (mode === "local") {
    return chainId === 1
      ? "local mode refuses Ethereum mainnet (chain ID 1); use an Anvil/non-mainnet RPC"
      : null;
  }
  return chainId === 1
    ? null
    : `${mode} mode requires Ethereum mainnet (1), RPC reported ${chainId}`;
}

/** Apply a new Alchemy key without overriding operator-owned endpoint env vars.
 * An explicit HTTP endpoint also suppresses an implicit Alchemy websocket so a
 * local/custom RPC can never receive block events from mainnet. */
function effectiveUrlsForKey(key: string) {
  const derived = deriveUrlsFromKey(key);
  const overrides = appConfig.endpointOverrides ?? { http: false, ws: false, nft: false };
  return {
    httpUrl: overrides.http ? appConfig.httpUrl : derived.httpUrl,
    wsUrl: overrides.ws
      ? appConfig.wsUrl
      : overrides.http
        ? undefined
        : derived.wsUrl,
    nftUrl: overrides.nft ? appConfig.nftUrl : derived.nftUrl,
  };
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  // Serialize lifecycle mutations so a later Stop/Lock cannot race an earlier
  // Settings/Unlock continuation that was waiting for the same old tick.
  let lifecycleTail: Promise<void> = Promise.resolve();
  const runLifecycle = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = lifecycleTail.then(operation, operation);
    lifecycleTail = run.then(() => undefined, () => undefined);
    return run;
  };

  // Defense in depth for the loopback-only listener: a hostile web page can
  // still target localhost, so reject DNS-rebound Host names and foreign browser
  // origins even though Fastify never listens on a LAN interface.
  const loopbackHosts = new Set<string>(API_LOOPBACK_HOSTS);
  app.addHook("onRequest", async (req, reply) => {
    const requestHost = hostnameOf(req.headers.host ?? "");
    if (!loopbackHosts.has(requestHost)) {
      return reply.code(403).send({ error: "Forbidden: unexpected Host header" });
    }
    // Origin-less local CLI requests remain supported.
    if (req.headers["sec-fetch-site"]?.toLowerCase() === "cross-site") {
      return reply.code(403).send({ error: "Forbidden: cross-site browser request" });
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      const originHost = originHostname(origin);
      const allowed = originHost !== null
        && loopbackHosts.has(originHost);
      if (!allowed) {
        return reply.code(403).send({ error: "Forbidden: unexpected Origin header" });
      }
    }
  });

  // --- status & config ---
  app.get("/api/status", async () => runtime.status());
  app.get("/api/config", async () => runtime.strategySnapshot());

  const mutateStrategy = async (req: FastifyRequest, reply: FastifyReply) => runLifecycle(async () => {
    const parsed = strategyMutationSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    if (parsed.data.expectedRevision !== runtime.strategyRevision) {
      return reply.code(409).send({
        error: `Revision conflict; current revision is ${runtime.strategyRevision}`,
        currentRevision: runtime.strategyRevision,
      });
    }
    const wasRunning = runtime.running;
    if (wasRunning) stopEngine();
    // Always wait: another request may already have set running=false while its
    // old generation is still unwinding.
    await waitForEngineIdle();
    let durabilityFailed = false;
    try {
      return runtime.saveStrategy(
        parsed.data.patch as Partial<StrategyConfig>,
        parsed.data.expectedRevision,
      );
    } catch (err) {
      if (err instanceof AtomicWriteCommittedError) {
        durabilityFailed = true;
        logger.error(err.message);
        return reply.code(503).send({
          error: "Configuration was applied, but filesystem durability could not be confirmed; the engine remains paused",
          ...runtime.strategySnapshot(),
        });
      }
      return revisionConflict(reply, err);
    } finally {
      // A config save preserves the prior run/pause state and never starts a
      // manually paused engine merely because a feature was enabled.
      if (!durabilityFailed && wasRunning && runtime.unlocked && !runtime.running) startEngine();
      schedulePreBoundaryPay();
      scheduleJitBoundary();
      schedulePreBoundaryAudit();
    }
  });
  app.post("/api/config", mutateStrategy);
  app.patch("/api/config", mutateStrategy);

  // --- keystore lifecycle ---
  app.get("/api/keystore", async () => {
    const file = loadKeystore(appConfig.dataDir);
    return { exists: keystoreExists(appConfig.dataDir), address: file?.address ?? null };
  });

  app.post("/api/keystore", async (req, reply) => runLifecycle(async () => {
    const schema = z.object({
      mode: z.enum(["import", "generate"]),
      privateKey: z.string().optional(),
      passphrase: z.string().min(8),
      overwrite: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { mode, passphrase } = parsed.data;

    // Never silently clobber an existing keystore — that permanently discards the
    // old wallet's key (and access to any funds it holds). Require an explicit opt-in.
    if (keystoreExists(appConfig.dataDir) && !parsed.data.overwrite) {
      return reply.code(409).send({
        error: "A wallet keystore already exists. Overwriting permanently discards the old key — resend with overwrite:true to confirm.",
      });
    }

    let pk: `0x${string}`;
    if (mode === "generate") {
      pk = generatePrivateKey();
    } else {
      // Accept a 64-hex key with or without the 0x prefix (and stray whitespace).
      const normalized = parsed.data.privateKey ? normalizePrivateKey(parsed.data.privateKey) : null;
      if (!normalized) {
        return reply.code(400).send({ error: "Invalid private key (expected 64 hex characters, with or without a 0x prefix)" });
      }
      pk = normalized;
    }
    const account = accountFromPrivateKey(pk);
    const file = encryptPrivateKey(pk, passphrase, account.address);
    const wasRunning = runtime.running;
    if (wasRunning) stopEngine();
    await waitForEngineIdle();
    let durabilityFailed = false;
    try {
      saveKeystore(appConfig.dataDir, file);
    } catch (err) {
      if (!(err instanceof AtomicWriteCommittedError)) {
        if (wasRunning && runtime.unlocked) startEngine();
        throw err;
      }
      durabilityFailed = true;
      logger.error(err.message);
    }
    // The persisted identity is now different; never leave the previous account
    // active in memory after a confirmed overwrite.
    if (runtime.unlocked) runtime.lock();
    logger.info(`Keystore created for ${account.address}`);
    if (durabilityFailed) {
      return reply.code(503).send({
        error: "Keystore was replaced, but filesystem durability could not be confirmed; the prior wallet was locked and the engine remains paused",
        address: account.address,
      });
    }
    return { address: account.address };
  }));

  app.post("/api/unlock", async (req, reply) => runLifecycle(async () => {
    const schema = z.object({ passphrase: z.string() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const file = loadKeystore(appConfig.dataDir);
    if (!file) return reply.code(400).send({ error: "No keystore found" });
    let account: ReturnType<typeof accountFromPrivateKey>;
    try {
      const pk = decryptPrivateKey(file, parsed.data.passphrase);
      account = accountFromPrivateKey(pk);
    } catch {
      return reply.code(401).send({ error: "Incorrect passphrase" });
    }
    // Freeze the active identity for every execution. A live tick may already
    // have fetched ownership and reserved a nonce for the old account.
    if (runtime.running) stopEngine();
    await waitForEngineIdle();
    let chainId: number;
    try {
      chainId = await getChainId();
    } catch (err) {
      runtime.lock();
      return reply.code(503).send({
        error: `Could not verify RPC chain ID; wallet remains locked: ${(err as Error).message}`,
      });
    }
    const modeError = chainModeError(appConfig.mode, chainId);
    if (modeError) {
      runtime.lock();
      return reply.code(503).send({
        error: `Refusing to unlock: ${modeError}`,
      });
    }
    runtime.account = account;
    runtime.walletClient = makeWalletClient(account);
    runtime.chainId = chainId;
    try {
      await preflightSubmissionRecovery(account.address);
    } catch (err) {
      const message = (err as Error).message;
      logger.error(`Wallet recovery preflight failed: ${message}`);
      return reply.code(503).send({
        error: `Wallet unlocked, but submission recovery failed; engine remains paused: ${message}`,
        status: runtime.status(),
      });
    }
    runtime.emitStatus();
    logger.info(`Wallet unlocked: ${account.address}`);
    // Populate chain state immediately so the UI can show epoch/countdown even
    // when the engine is paused.
    getGameSnapshot().then((snap) => {
      if (runtime.account?.address !== account.address) return;
      runtime.currentEpoch = snap.currentEpoch;
      runtime.startTime = snap.startTime;
      runtime.gameState = snap.state;
      runtime.citizenSupply = snap.citizenSupply;
      runtime.citizensAddress = snap.citizensAddress;
      runtime.emitStatus();
    }).catch(() => {});
    // Fetch the wallet balance up front too — otherwise it stays blank until
    // the engine is started (balance is otherwise only read inside tick()).
    publicClient.getBalance({ address: account.address }).then((bal) => {
      if (runtime.account?.address !== account.address) return;
      runtime.balanceWei = bal;
      runtime.emitStatus();
    }).catch(() => {});
    // Engine stays paused on unlock — user must press Start manually.
    return runtime.status();
  }));

  app.post("/api/lock", async () => {
    // Lock and Stop are emergency controls. Invalidate live execution before
    // waiting behind a slow settings/unlock validation already in lifecycleTail.
    // Repeat the stop inside the queue as well so an older operation cannot
    // restart the engine in its finally block after this request arrived.
    stopEngine();
    return runLifecycle(async () => {
      stopEngine();
      await waitForEngineIdle();
      runtime.lock();
      return { ok: true };
    });
  });

  // --- engine control ---
  app.post("/api/start", async (_req, reply) => runLifecycle(async () => {
    if (!runtime.unlocked) return reply.code(400).send({ error: "Unlock the wallet first" });
    if (!runtime.running) {
      // An auto-stopping JIT tick can set running=false before its journal/nonce
      // cleanup reaches finally. Never recover or start a new generation until
      // that old exclusive execution has fully unwound.
      await waitForEngineIdle();
      if (!runtime.unlocked || !runtime.account) {
        return reply.code(400).send({ error: "Unlock the wallet first" });
      }
      let chainId: number;
      try {
        chainId = await getChainId();
      } catch (err) {
        return reply.code(503).send({ error: `Cannot verify RPC chain ID: ${(err as Error).message}` });
      }
      runtime.chainId = chainId;
      const modeError = chainModeError(appConfig.mode, chainId);
      if (modeError) {
        return reply.code(503).send({
          error: `Cannot start: ${modeError}`,
        });
      }
      try {
        await recoverAuthorizedSubmissions(runtime.account!.address);
      } catch (err) {
        return reply.code(503).send({
          error: `Cannot start engine: ${(err as Error).message}`,
          status: runtime.status(),
        });
      }
    }
    startEngine();
    return runtime.status();
  }));

  app.post("/api/stop", async () => {
    // Fail-safe immediately even when another lifecycle request is doing remote
    // validation. The queued stop closes the race with an older finally/restart.
    stopEngine();
    return runLifecycle(async () => {
      stopEngine();
      await waitForEngineIdle();
      return runtime.status();
    });
  });

  // --- just-in-time single-epoch payment ---
  app.post("/api/jit", async (req, reply) => runLifecycle(async () => {
    const schema = z.object({
      enable: z.boolean(),
      expectedRevision: z.number().int().min(0),
      targetEpoch: z.number().int().min(1).optional(),
      tokenIds: z.array(z.string().regex(/^\d+$/, "tokenIds must contain decimal integers")).min(1).optional(),
    }).strict();
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { enable, expectedRevision, targetEpoch, tokenIds } = parsed.data;
    if (expectedRevision !== runtime.jitCampaign.revision) {
      return reply.code(409).send({
        error: `Revision conflict; current revision is ${runtime.jitCampaign.revision}`,
        currentRevision: runtime.jitCampaign.revision,
      });
    }
    let target: number | null = null;
    let selectedIds: string[] = [];
    const wasRunning = runtime.running;
    const campaignSnapshot = {
      ...runtime.jitCampaign,
      tokenIds: [...runtime.jitCampaign.tokenIds],
    };
    const campaignOwnedEngine = campaignSnapshot.autoStopOnCompletion;
    if (enable && !runtime.unlocked) {
      return reply.code(400).send({ error: "Unlock the wallet first" });
    }
    if (enable && (targetEpoch === undefined || tokenIds === undefined)) {
      return reply.code(400).send({ error: "Arming JIT requires an explicit targetEpoch and tokenIds" });
    }
    // Freeze execution before any asynchronous epoch/ownership validation. This
    // prevents an active tick from completing/terminalizing the campaign while
    // this request is authoring its replacement command.
    if (wasRunning) stopEngine();
    await waitForEngineIdle();
    let saved = false;
    let durabilityFailed = false;
    let unresolvedCancellation = false;
    let cancellationCleanupOwnsEngine = false;
    try {
      if (enable) {
        let fresh;
        try {
          fresh = await getGameSnapshot();
        } catch (err) {
          return reply.code(503).send({ error: `Could not read current epoch: ${(err as Error).message}` });
        }
        runtime.currentEpoch = fresh.currentEpoch;
        runtime.startTime = fresh.startTime;
        runtime.gameState = fresh.state;
        runtime.citizenSupply = fresh.citizenSupply;
        runtime.citizensAddress = fresh.citizensAddress;
        runtime.emitStatus();
        const current = Number(fresh.currentEpoch);
        if (targetEpoch! <= current) {
          return reply.code(400).send({ error: `targetEpoch must be after current epoch ${current}` });
        }
        target = targetEpoch!;
        selectedIds = [...new Set(tokenIds!.map((id) => BigInt(id).toString()))];
        try {
          const owned = new Set((await filterOwnedTokenIds(
            fresh.citizensAddress,
            selectedIds.map((tokenId) => BigInt(tokenId)),
            runtime.account!.address,
          )).map((tokenId) => tokenId.toString()));
          const missing = selectedIds.filter((id) => !owned.has(id));
          if (missing.length > 0) {
            return reply.code(400).send({ error: `Wallet does not own Citizen token(s): ${missing.join(", ")}` });
          }
        } catch (err) {
          return reply.code(503).send({ error: `Could not verify selected Citizens: ${(err as Error).message}` });
        }
        if (!wasRunning) {
          let chainId: number;
          try {
            chainId = await getChainId();
          } catch (err) {
            return reply.code(503).send({
              error: `Cannot arm JIT campaign because chain ID could not be verified: ${(err as Error).message}`,
            });
          }
          runtime.chainId = chainId;
          const modeError = chainModeError(appConfig.mode, chainId);
          if (modeError) {
            return reply.code(503).send({
              error: `Cannot arm JIT campaign: ${modeError}`,
            });
          }
          try {
            await recoverAuthorizedSubmissions(runtime.account!.address);
          } catch (err) {
            return reply.code(503).send({
              error: `Cannot arm JIT campaign: ${(err as Error).message}`,
              status: runtime.status(),
            });
          }
        }
      }
      if (!enable) {
        unresolvedCancellation = hasUnresolvedJitCampaignWork(campaignSnapshot);
        // Preserve an operator-owned running engine. If the engine was already
        // paused, this request owns the temporary cleanup run and strategy will
        // stop it again after the retained same-nonce work becomes terminal.
        cancellationCleanupOwnsEngine = unresolvedCancellation
          && (campaignOwnedEngine || !wasRunning);
      }
      runtime.saveJitCampaign(
        enable
          ? {
              state: "armed",
              targetEpoch: target,
              tokenIds: selectedIds,
              autoStopOnCompletion: !wasRunning || campaignOwnedEngine,
              message: undefined,
              completedAt: undefined,
            }
          : {
              state: "cancelled",
              targetEpoch: unresolvedCancellation ? campaignSnapshot.targetEpoch : null,
              tokenIds: unresolvedCancellation ? campaignSnapshot.tokenIds : [],
              autoStopOnCompletion: cancellationCleanupOwnsEngine,
              message: unresolvedCancellation
                ? "Cancelled by operator; pending transaction cleanup in progress"
                : "Cancelled by operator",
              completedAt: unresolvedCancellation ? undefined : Date.now(),
            },
        expectedRevision,
      );
      saved = true;
      resetJitState();
    } catch (err) {
      if (err instanceof AtomicWriteCommittedError) {
        saved = true;
        durabilityFailed = true;
        resetJitState();
        logger.error(err.message);
        return reply.code(503).send({
          error: "JIT campaign was applied, but filesystem durability could not be confirmed; the engine remains paused",
          status: runtime.status(),
        });
      }
      return revisionConflict(reply, err);
    } finally {
      const completedOwnedCancellation = !enable
        && saved
        && campaignOwnedEngine
        && !unresolvedCancellation
        && !runtime.strategy.defenseEnabled
        && !runtime.strategy.offenseEnabled;
      const restartForCleanup = !enable && saved && unresolvedCancellation;
      if (
        !durabilityFailed
        && !completedOwnedCancellation
        && (wasRunning || (enable && saved) || restartForCleanup)
        && runtime.unlocked
        && !runtime.running
      ) {
        startEngine();
      }
      scheduleJitBoundary();
      schedulePreBoundaryPay();
    }
    return runtime.status();
  }));

  // --- Alchemy / RPC settings ---
  app.get("/api/settings", async () => {
    const s = loadSettings();
    const rpcConfigured = Boolean(appConfig.httpUrl);
    const ownershipConfigured = Boolean(appConfig.nftUrl)
      || (appConfig.ownedTokensOverride?.length ?? 0) > 0;
    return {
      alchemyKeySet: !!s.alchemyApiKey || !!process.env.ALCHEMY_API_KEY,
      rpcConfigured,
      ownershipConfigured,
      setupReady: rpcConfigured && ownershipConfigured,
      mode: appConfig.mode,
      modeConfiguredByEnvironment: appConfig.modeConfiguredByEnvironment ?? false,
      keyConfiguredByEnvironment: appConfig.keyConfiguredByEnvironment ?? false,
    };
  });

  app.post("/api/settings", async (req, reply) => runLifecycle(async () => {
    const schema = z.object({
      alchemyApiKey: z.string().trim().min(10).optional(),
      mode: z.enum(["mainnet", "public"]).optional(),
    }).refine((d) => d.alchemyApiKey !== undefined || d.mode !== undefined, {
      message: "Provide at least one of: alchemyApiKey, mode",
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { alchemyApiKey, mode } = parsed.data;
    if (alchemyApiKey && (appConfig.keyConfiguredByEnvironment ?? false)) {
      return reply.code(400).send({
        error: "The Alchemy key is fixed by the ALCHEMY_API_KEY environment variable; edit it and restart",
      });
    }
    if (alchemyApiKey && appConfig.mode === "local") {
      return reply.code(400).send({
        error: "Alchemy keys cannot be changed at runtime in local mode; set the desired endpoints in the environment and restart",
      });
    }
    if (mode && (appConfig.modeConfiguredByEnvironment ?? false)) {
      return reply.code(400).send({
        error: "Submission mode is fixed by the MODE environment variable; edit it and restart",
      });
    }
    const candidateUrls = alchemyApiKey ? effectiveUrlsForKey(alchemyApiKey) : null;
    if (candidateUrls) {
      if (!candidateUrls.httpUrl || !candidateUrls.nftUrl) {
        return reply.code(400).send({
          error: "The effective RPC/NFT endpoints are incomplete; configure RPC_HTTP_URL and ALCHEMY_NFT_URL explicitly or remove the overrides",
        });
      }
      try {
        await validateMainnetRpcCandidate({
          httpUrl: candidateUrls.httpUrl,
          nftUrl: candidateUrls.nftUrl,
          gameAddress: appConfig.gameAddress,
        });
      } catch (err) {
        return reply.code(400).send({ error: `Alchemy RPC validation failed: ${(err as Error).message}` });
      }
    }
    // Reject a semantically incompatible mode before persisting it. This keeps a
    // failed local/public transition from being applied behind stale dashboard
    // state. A key-bearing candidate was already chain-validated above.
    if (mode && !candidateUrls) {
      let chainId: number;
      try {
        chainId = await getChainId();
      } catch (err) {
        return reply.code(400).send({
          error: `Cannot switch mode because chain ID could not be verified: ${(err as Error).message}`,
        });
      }
      const modeError = chainModeError(mode, chainId);
      if (modeError) return reply.code(400).send({ error: `Cannot switch mode: ${modeError}` });
    }
    const wasRunning = runtime.running;
    if (wasRunning) {
      // Do not replace RPC clients or submission semantics underneath a batch
      // that has already synced a nonce and captured the current mode.
      stopEngine();
    }
    await waitForEngineIdle();

    const existing = loadSettings();
    let restartValidated = false;
    let durabilityFailed = false;
    try {
      const nextSettings = { ...existing, ...(alchemyApiKey ? { alchemyApiKey } : {}), ...(mode ? { mode } : {}) };
      try {
        saveSettings(nextSettings);
      } catch (err) {
        if (!(err instanceof AtomicWriteCommittedError)) throw err;
        durabilityFailed = true;
        logger.error(err.message);
      }
      if (alchemyApiKey && candidateUrls) {
        process.env.ALCHEMY_API_KEY = alchemyApiKey;
        appConfig.httpUrl = candidateUrls.httpUrl;
        appConfig.wsUrl = candidateUrls.wsUrl;
        appConfig.nftUrl = candidateUrls.nftUrl;
        reinitClients(candidateUrls.httpUrl, candidateUrls.wsUrl);
        logger.info("Alchemy API key saved and RPC clients reinitialized.");
      }

      if (mode) {
        appConfig.mode = mode;
        logger.info(`Submission mode switched to: ${mode}`);
      }

      if (durabilityFailed) {
        return reply.code(503).send({
          error: "Settings were applied, but filesystem durability could not be confirmed; the engine remains paused",
          mode: appConfig.mode,
        });
      }

      if (wasRunning && runtime.unlocked) {
        let chainId: number;
        try {
          chainId = await getChainId();
        } catch (err) {
          return reply.code(503).send({
            error: `Settings saved, but engine remains paused because chain ID could not be verified: ${(err as Error).message}`,
            mode: appConfig.mode,
          });
        }
        runtime.chainId = chainId;
        const modeError = chainModeError(appConfig.mode, chainId);
        if (modeError) {
          return reply.code(503).send({
            error: `Settings saved, but engine remains paused: ${modeError}`,
            mode: appConfig.mode,
          });
        }
        restartValidated = true;
      }

      return { ok: true, mode: appConfig.mode };
    } finally {
      if (wasRunning && runtime.unlocked && restartValidated) startEngine();
    }
  }));

  // --- reads for the dashboard ---
  app.get("/api/tokens", async (_req, reply) => {
    if (!runtime.unlocked) return reply.code(400).send({ error: "locked" });
    try {
      return await readOwnedStatuses();
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.get("/api/targets", async (_req, reply) => {
    try {
      return await readTargets();
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.get("/api/activity", async (req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 200);
    return activity.recent(limit);
  });

  // --- race post-mortem: compare our tx(s) vs rival tx(s) on-chain ---
  app.post("/api/postmortem", async (req, reply) => {
    const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "invalid tx hash");
    const schema = z.object({
      ours: z.array(hash).min(1).max(20),
      rivals: z.array(hash).max(20).default([]),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    if (!appConfig.httpUrl) {
      return reply.code(400).send({ error: "No RPC configured — set the Alchemy key first." });
    }
    try {
      const result = await runPostMortem(
        parsed.data.ours as `0x${string}`[],
        parsed.data.rivals as `0x${string}`[],
      );
      return result;
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // --- websocket: push status + activity ---
  app.get("/ws", { websocket: true }, (socket) => {
    const send = (type: string, data: unknown) => {
      try {
        socket.send(JSON.stringify({ type, data }));
      } catch {
        /* ignore */
      }
    };
    send("status", runtime.status());
    send("activity-batch", activity.recent(100));
    const offStatus = runtime.onStatus((s) => send("status", s));
    const offActivity = activity.subscribe((e) => send("activity", e));
    socket.on("close", () => {
      offStatus();
      offActivity();
    });
  });

  return app;
}
