import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import websocket from "@fastify/websocket";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { generatePrivateKey } from "viem/accounts";
import { appConfig, loadSettings, saveSettings, deriveUrlsFromKey } from "./config.js";
import { publicClient, reinitClients, accountFromPrivateKey, getChainId, validateRpcConfiguration, getBalanceCached, invalidateBalanceCache, getLatestBlockCached } from "./chain.js";
import { runtime, strategyPatchSchema } from "./runtime.js";
import { nonces } from "./nonce.js";
import { activity } from "./activity.js";
import { logger } from "./logger.js";
import {
  encryptPrivateKeyAsync,
  decryptPrivateKeyAsync,
  saveKeystore,
  loadWallets,
  saveWallets,
  passphraseMatchesAsync,
  keystoreExists,
  normalizePrivateKey,
} from "./keystore.js";
import {
  hostnameOf,
  isAllowedDashboardOrigin,
  isLoopbackHostname,
  isMutationMethod,
  isSafeFetchSite,
  PasswordAttemptLimiter,
  sessionTokenMatches,
} from "./api-security.js";
import { getGameSnapshot } from "./contract.js";
import { invalidateTokenCaches } from "./index-tokens.js";
import { resolveJitTarget } from "./logic.js";
import { startEngine, stopEngine, quiesceEngine, hasActiveEngineWork, beginEngineMaintenance, isEngineMaintenanceActive, type EngineMaintenanceLease, scheduleJitBoundary, schedulePreBoundaryPay, scheduleDefenseBoundary, resetJitState, manualPayToCurrent, manualUseBribe, scheduleAwayWake, clearAwayTimers } from "./strategy.js";
import { readOwnedStatuses } from "./service.js";
import { runPostMortem } from "./postmortem.js";
import { defaultDashboardRoot, registerDashboard } from "./dashboard.js";

export async function buildServer(options: { dashboardRoot?: string } = {}): Promise<FastifyInstance> {
  if (!isLoopbackHostname(appConfig.host)) {
    throw new Error(
      `Refusing to bind unauthenticated wallet API to non-loopback HOST=${appConfig.host}. ` +
        "Use 127.0.0.1, localhost, or ::1.",
    );
  }

  const app = Fastify({ logger: false });
  await app.register(websocket);

  const sessionToken = randomBytes(32).toString("base64url");
  const passwordLimiter = new PasswordAttemptLimiter();
  const allowedHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  const unsafeActivityMessage = /(https?:\/\/|wss?:\/\/|api[_ -]?key|private key|passphrase|authorization)/i;

  const rejectPasswordAttempt = (reply: FastifyReply) => {
    const decision = passwordLimiter.begin();
    if (decision.allowed) return false;
    const retryAfter = Math.max(1, Math.ceil(decision.retryAfterMs / 1_000));
    void reply.header("Retry-After", String(retryAfter)).code(429).send({
      error: "Password verification is temporarily rate limited",
    });
    return true;
  };

  const internalFailure = (
    reply: FastifyReply,
    error: unknown,
    context: string,
    statusCode: 500 | 502 = 500,
  ) => {
    // Provider errors often include full RPC URLs (and therefore API keys). Record only
    // the error class; neither the response nor durable logs should receive raw detail.
    logger.warn(`${context} (${error instanceof Error ? error.name : "unknown error"})`);
    return reply.code(statusCode).send({ error: context });
  };

  const withEngineMaintenance = async <T>(
    reply: FastifyReply,
    work: (lease: EngineMaintenanceLease) => Promise<T> | T,
  ): Promise<T | FastifyReply> => {
    const lease = beginEngineMaintenance();
    if (!lease) {
      return reply.code(409).send({
        error: "Another wallet, engine, or RPC maintenance operation is still in progress",
      });
    }
    try {
      return await work(lease);
    } finally {
      lease.release();
    }
  };

  app.setErrorHandler((error, req, reply) => {
    // Last-resort boundary: no thrown provider/filesystem error may reach a response
    // with a credential-bearing URL or internal path. Expected validation/auth failures
    // are handled explicitly in their routes and never arrive here.
    logger.error(
      `Unhandled API failure for ${req.method} ${req.url.split("?", 1)[0]} ` +
        `(${error instanceof Error ? error.name : "unknown error"})`,
    );
    void reply.code(500).send({ error: "Internal request failure" });
  });

  // DNS rebinding, browser CSRF, and drive-by socket reads are distinct attacks.
  // Host validation stops rebinding. Browser metadata + a per-process, non-safelisted
  // token stop ordinary cross-origin requests. The token is intentionally available
  // from a read-only endpoint so local CLI clients can fetch and send it too.
  app.addHook("onRequest", async (req, reply) => {
    if (!allowedHosts.has(hostnameOf(req.headers.host ?? ""))) {
      return reply.code(403).send({ error: "Forbidden: unexpected Host header" });
    }
    if (req.url.split("?", 1)[0] === "/api/session") return;

    // Every API response can expose wallet state or trigger expensive provider work.
    // Requiring the non-safelisted session header on reads as well as writes prevents
    // cross-origin pages from using GET endpoints for drive-by disclosure or RPC DoS.
    if (req.url.startsWith("/api/")) {
      const supplied = req.headers["x-dat-bot-session"];
      if (!sessionTokenMatches(sessionToken, typeof supplied === "string" ? supplied : undefined)) {
        return reply.code(403).send({ error: "Forbidden request" });
      }
    }
    if (!isMutationMethod(req.method)) return;

    const origin = req.headers.origin;
    const fetchSite = req.headers["sec-fetch-site"];
    if (
      (origin !== undefined && !isAllowedDashboardOrigin(origin)) ||
      !isSafeFetchSite(fetchSite)
    ) {
      logger.warn(`Rejected cross-origin or unauthenticated API mutation: ${req.method} ${req.url}`);
      return reply.code(403).send({ error: "Forbidden request" });
    }
    if (
      req.url.startsWith("/api/") &&
      (req.headers["content-length"] !== undefined || req.headers["transfer-encoding"] !== undefined) &&
      req.headers["content-length"] !== "0" &&
      !(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")
    ) {
      return reply.code(415).send({ error: "API request bodies must be JSON" });
    }
  });

  app.addHook("onSend", async (req, reply, payload) => {
    if (req.url.startsWith("/api/")) {
      void reply.header("Cache-Control", "no-store");
      void reply.header("X-Content-Type-Options", "nosniff");
      void reply.header("Referrer-Policy", "no-referrer");
    }
    return payload;
  });

  app.get("/api/session", async (req, reply) => {
    const origin = req.headers.origin;
    if (
      (origin !== undefined && !isAllowedDashboardOrigin(origin)) ||
      !isSafeFetchSite(req.headers["sec-fetch-site"])
    ) {
      return reply.code(403).send({ error: "Forbidden request" });
    }
    return { token: sessionToken };
  });

  // --- status & config ---
  app.get("/api/status", async () => runtime.status());
  app.get("/api/config", async () => runtime.strategy);

  app.post("/api/config", async (req, reply) => withEngineMaintenance(reply, async () => {
    const parsed = strategyPatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const preview = { ...runtime.strategy, ...parsed.data };
    if (runtime.running || hasActiveEngineWork()) {
      if (!preview.enabled) {
        // Disabling every strategy is the one running mutation allowed: quiesce first so
        // no captured tick signs after this response reports the bot disabled.
        await quiesceEngine();
      } else {
        return reply.code(409).send({
          error: "Stop the bot before changing strategy or spending configuration",
        });
      }
    }
    const next = runtime.saveStrategy(parsed.data);
    const nowActive = next.enabled;
    // Saving strategy never auto-STARTS the engine — starting is explicit (the "Start
    // bot" button, or arming a JIT payment) so the user can finish configuring (coinbase
    // bid, gas, payment strategy) before going live. We still auto-STOP in the safe
    // direction: if every strategy flag is now off, a running engine has nothing to do.
    if (!nowActive && runtime.running) await quiesceEngine();
    // Away mode owns when the engine runs, so any config change re-evaluates it: turning
    // it on arms the wake timer, turning it off cancels, and arming/disarming JIT
    // changes whether there is anything to wake FOR.
    if (next.awayMode) scheduleAwayWake(); else clearAwayTimers();
    scheduleDefenseBoundary();
    schedulePreBoundaryPay();
    activity.add({
      kind: "info",
      status: "info",
      message: `Strategy configuration changed (${Object.keys(parsed.data).sort().join(", ")})`,
    });
    return next;
  }));

  // --- keystore lifecycle ---
  app.get("/api/keystore", async () => {
    const files = loadWallets(appConfig.dataDir);
    return {
      exists: keystoreExists(appConfig.dataDir),
      address: files[0]?.address ?? null,
      // Addresses and labels only — never any key material, and safe while locked.
      wallets: files.map((f, i) => ({
        address: f.address,
        label: f.label ?? (i === 0 ? "primary" : `wallet-${i + 1}`),
      })),
    };
  });

  /**
   * Add another wallet to the keystore.
   *
   * Every entry is encrypted under the SAME passphrase, so the passphrase is verified
   * against an existing entry first — otherwise the keystore would end up in a state no
   * single passphrase can fully unlock, and the stranded wallet's citizens would silently
   * stop being managed.
   */
  app.post("/api/wallets", async (req, reply) => withEngineMaintenance(reply, async (maintenanceLease) => {
    const schema = z.object({
      mode: z.enum(["import", "generate"]),
      privateKey: z.string().optional(),
      passphrase: z.string().min(8).max(1_024),
      label: z.string().max(40).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { mode, passphrase, label } = parsed.data;

    if (!keystoreExists(appConfig.dataDir)) {
      return reply.code(400).send({ error: "Create the first wallet before adding more" });
    }
    let pk: `0x${string}`;
    if (mode === "generate") {
      pk = generatePrivateKey();
    } else {
      const normalized = normalizePrivateKey(parsed.data.privateKey ?? "");
      if (!normalized) {
        return reply.code(400).send({ error: "Invalid private key (expected 64 hex characters, with or without a 0x prefix)" });
      }
      pk = normalized;
    }
    const account = accountFromPrivateKey(pk);
    const existing = loadWallets(appConfig.dataDir);
    if (existing.some((w) => w.address.toLowerCase() === account.address.toLowerCase())) {
      return reply.code(409).send({ error: `Wallet ${account.address} is already in the keystore` });
    }
    if (rejectPasswordAttempt(reply)) return;
    let passphraseAccepted = false;
    let entry;
    let resumeEngine = false;
    try {
      passphraseAccepted = await passphraseMatchesAsync(appConfig.dataDir, passphrase);
      if (!passphraseAccepted) {
        logger.warn("Rejected wallet addition: incorrect keystore passphrase");
        return reply.code(401).send({
          error: "Passphrase does not match the existing keystore — every wallet shares one passphrase",
        });
      }
      entry = await encryptPrivateKeyAsync(pk, passphrase, account.address);
      entry.label = label?.trim() || `wallet-${existing.length + 1}`;
      resumeEngine = runtime.running;
      if (runtime.running || hasActiveEngineWork()) await quiesceEngine();
      saveWallets(appConfig.dataDir, [...existing, entry]);
    } finally {
      passwordLimiter.finish(passphraseAccepted);
    }

    // Adopt it immediately if we're already unlocked, so its citizens are managed from
    // this tick rather than only after a lock/unlock cycle.
    if (runtime.unlocked) {
      runtime.setWallets([
        ...runtime.wallets,
        { account, label: entry.label, balanceWei: null },
      ]);
      nonces.retain(runtime.addresses as `0x${string}`[]);
      invalidateTokenCaches();
      publicClient
        .getBalance({ address: account.address })
        .then((bal) => { runtime.setBalance(account.address, bal); runtime.emitStatus(); })
        .catch(() => {});
      runtime.emitStatus();
    }
    // Runtime adoption above is isolated from captured ticks. Restore an engine that
    // was running only after the complete wallet set and nonce registry agree.
    if (resumeEngine) startEngine(maintenanceLease);
    logger.info(`Wallet added: ${account.address} (${entry.label})`);
    activity.add({ kind: "info", status: "info", message: `Wallet ${account.address} added to the keystore` });
    return { address: account.address, label: entry.label, generated: mode === "generate" };
  }));

  /**
   * Remove a wallet. The key is permanently discarded, so this refuses unless the caller
   * repeats the address — a mis-click here loses access to whatever that wallet holds.
   */
  app.delete("/api/wallets/:address", async (req, reply) => withEngineMaintenance(reply, async () => {
    const params = z.object({ address: z.string() }).safeParse(req.params);
    const body = z.object({
      confirmAddress: z.string(),
      passphrase: z.string().max(1_024),
    }).safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "address, confirmAddress, and passphrase are required" });
    }
    const target = params.data.address.toLowerCase();
    if (body.data.confirmAddress.toLowerCase() !== target) {
      return reply.code(400).send({ error: "confirmAddress does not match the wallet being removed" });
    }
    const existing = loadWallets(appConfig.dataDir);
    if (!existing.some((w) => w.address.toLowerCase() === target)) {
      return reply.code(404).send({ error: "No such wallet in the keystore" });
    }
    if (existing.length === 1) {
      return reply.code(400).send({ error: "Cannot remove the last wallet — the bot would have no key" });
    }
    if (rejectPasswordAttempt(reply)) return;
    let passphraseAccepted = false;
    try {
      passphraseAccepted = await passphraseMatchesAsync(appConfig.dataDir, body.data.passphrase);
      if (!passphraseAccepted) {
        logger.warn(`Rejected removal of wallet ${target}: incorrect keystore passphrase`);
        return reply.code(401).send({ error: "Incorrect passphrase" });
      }
    } finally {
      passwordLimiter.finish(passphraseAccepted);
    }
    await quiesceEngine();
    saveWallets(appConfig.dataDir, existing.filter((w) => w.address.toLowerCase() !== target));
    // A tick may have captured the removed signer before the password check awaited.
    // Stop rather than allowing that stale in-memory key to submit after removal; the
    // operator can review the remaining wallet set and start again explicitly.
    if (runtime.unlocked) {
      runtime.setWallets(runtime.wallets.filter((w) => w.account.address.toLowerCase() !== target));
      // Drop the unlocked in-memory manager. Any durable unresolved reservation remains
      // in the journal and is restored if this address is re-added, preventing key
      // removal/re-addition from bypassing the nonce quarantine.
      nonces.retain(runtime.addresses as `0x${string}`[]);
      invalidateTokenCaches();
      runtime.emitStatus();
    }
    logger.warn(`Wallet removed from keystore: ${target}`);
    activity.add({
      kind: "info",
      status: "info",
      message: `Wallet ${target} removed from the active keystore; an owner-only encrypted backup was retained`,
    });
    return { ok: true, remaining: existing.length - 1 };
  }));

  app.post("/api/keystore", async (req, reply) => withEngineMaintenance(reply, async () => {
    const schema = z.object({
      mode: z.enum(["import", "generate"]),
      privateKey: z.string().optional(),
      passphrase: z.string().min(8).max(1_024),
      overwrite: z.boolean().optional(),
      currentPassphrase: z.string().max(1_024).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { mode, passphrase } = parsed.data;

    // Never silently clobber an existing keystore — that permanently discards the
    // old wallet's key (and access to any funds it holds). Require an explicit opt-in.
    const replacing = keystoreExists(appConfig.dataDir);
    if (replacing && !parsed.data.overwrite) {
      return reply.code(409).send({
        error: "A wallet keystore already exists. Overwriting permanently discards the old key — resend with overwrite:true to confirm.",
      });
    }
    if (replacing && !parsed.data.currentPassphrase) {
      return reply.code(400).send({
        error: "currentPassphrase is required to overwrite an existing keystore",
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
    if (rejectPasswordAttempt(reply)) return;
    let passphraseAccepted = !replacing;
    try {
      if (replacing) {
        passphraseAccepted = await passphraseMatchesAsync(
          appConfig.dataDir,
          parsed.data.currentPassphrase ?? "",
        );
        if (!passphraseAccepted) {
          logger.warn("Rejected keystore replacement: incorrect current passphrase");
          return reply.code(401).send({ error: "Incorrect current passphrase" });
        }
        await quiesceEngine();
      }
      const file = await encryptPrivateKeyAsync(pk, passphrase, account.address);
      saveKeystore(appConfig.dataDir, file);
    } finally {
      passwordLimiter.finish(passphraseAccepted);
    }
    if (replacing) {
      runtime.lock();
      nonces.retain([]);
      invalidateTokenCaches();
    }
    logger.info(`Keystore created for ${account.address}`);
    activity.add({
      kind: "info",
      status: "info",
      message: replacing
        ? `Active keystore replaced with ${account.address}; the previous encrypted keystore was retained as an owner-only backup and the bot was locked`
        : `Keystore created for ${account.address}`,
    });
    return { address: account.address };
  }));

  app.post("/api/unlock", async (req, reply) => withEngineMaintenance(reply, async () => {
    const schema = z.object({ passphrase: z.string().max(1_024) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const files = loadWallets(appConfig.dataDir);
    if (files.length === 0) return reply.code(400).send({ error: "No keystore found" });
    if (rejectPasswordAttempt(reply)) return;
    let wallets;
    try {
      // Every wallet is encrypted under the same passphrase, so one unlock opens them
      // all. If any single entry fails to decrypt the whole unlock fails rather than
      // half-unlocking — a silently-missing wallet would look like its citizens simply
      // stopped being managed.
      wallets = [];
      for (const [i, file] of files.entries()) {
        const account = accountFromPrivateKey(
          await decryptPrivateKeyAsync(file, parsed.data.passphrase),
        );
        wallets.push({
          account,
          label: file.label ?? (i === 0 ? "primary" : `wallet-${i + 1}`),
          balanceWei: null,
        });
      }
      passwordLimiter.finish(true);
    } catch {
      passwordLimiter.finish(false);
      logger.warn("Rejected wallet unlock: incorrect passphrase or invalid keystore");
      activity.add({ kind: "error", status: "skipped", message: "Rejected wallet unlock attempt" });
      return reply.code(401).send({ error: "Incorrect passphrase" });
    }

    try {
      // Validate the connected chain before placing decrypted accounts into runtime.
      // A provider/configuration error must never leave a half-unlocked process behind.
      const chainId = await getChainId();
      await quiesceEngine();
      runtime.setWallets(wallets);
      nonces.retain(runtime.addresses as `0x${string}`[]);
      runtime.chainId = chainId;
      runtime.emitStatus();
      logger.info(`Unlocked ${wallets.length} wallet(s): ${wallets.map((w) => w.account.address).join(", ")}`);
      activity.add({ kind: "info", status: "info", message: `Unlocked ${wallets.length} wallet(s); engine remains paused` });
      // Populate chain state immediately so the UI can show epoch/countdown even
      // when the engine is paused.
      getGameSnapshot().then((snap) => {
        runtime.currentEpoch = snap.currentEpoch;
        runtime.startTime = snap.startTime;
        runtime.gameState = snap.state;
        runtime.citizenSupply = snap.citizenSupply;
        runtime.citizensAddress = snap.citizensAddress;
        runtime.emitStatus();
        // Away mode can only arm once the wallet is unlocked and the epoch grid is
        // known — both are true right here.
        if (runtime.strategy.awayMode) scheduleAwayWake();
      }).catch((err: unknown) => {
        // Header stats (epoch, supply, citizens left) are only repopulated by an engine
        // tick or "Refresh data", so swallowing this left them blank indefinitely with no
        // clue why — indistinguishable from a bad key. Surface it where the user is
        // already looking.
        logger.warn(`Unlock-time chain read failed (${err instanceof Error ? err.name : "unknown error"})`);
        activity.add({
          kind: "error",
          status: "skipped",
          message: "Could not read chain state on unlock — check the Alchemy key, then press Refresh data",
        });
      });
      // Fetch the wallet balance up front too — otherwise it stays blank until
      // the engine is started (balance is otherwise only read inside tick()).
      // Balances up front, per wallet — otherwise they stay blank until the engine runs.
      void Promise.all(
        runtime.wallets.map(async (w) => {
          try { runtime.setBalance(w.account.address, await publicClient.getBalance({ address: w.account.address })); }
          catch { /* a single wallet's balance read must not fail the unlock */ }
        }),
      ).then(() => runtime.emitStatus());
      // Engine stays paused on unlock — user must press Start manually.
      return runtime.status();
    } catch {
      stopEngine();
      runtime.lock();
      logger.warn("Wallet unlock refused because RPC identity validation failed");
      return reply.code(502).send({ error: "RPC identity validation failed; wallet remains locked" });
    }
  }));

  app.post("/api/lock", async (_req, reply) => withEngineMaintenance(reply, async () => {
      await quiesceEngine();
      runtime.lock();
      activity.add({ kind: "info", status: "info", message: "Wallet keys locked" });
      return { ok: true };
    }));

  // --- engine control ---
  app.post("/api/start", async (_req, reply) => {
    if (!runtime.unlocked) return reply.code(400).send({ error: "Unlock the wallet first" });
    if (isEngineMaintenanceActive() || !startEngine()) {
      return reply.code(409).send({ error: "Engine maintenance is still in progress" });
    }
    return runtime.status();
  });

  app.post("/api/stop", async (_req, reply) => withEngineMaintenance(reply, async () => {
      await quiesceEngine();
      return runtime.status();
    }));

  // --- manual, user-initiated token actions (dashboard buttons) ---
  // Priced with normal network gas at press time, and NOT subject to the Auto-Pay
  // Limit — that cap bounds what the bot spends on its own; pressing the button is
  // the user's own decision. Works whether or not the engine is running.
  const tokenAction = z.object({ tokenId: z.string().min(1) });

  app.post("/api/token/pay", async (req, reply) => withEngineMaintenance(reply, async (maintenanceLease) => {
    const resumeEngine = runtime.running;
    try {
      await quiesceEngine();
      const parsed = tokenAction.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      let id: bigint;
      try { id = BigInt(parsed.data.tokenId); } catch { return reply.code(400).send({ error: "Invalid token ID" }); }
      const res = await manualPayToCurrent(id);
      if (!res.ok) {
        logger.warn(`Manual pay request failed for #${id}`);
        return reply.code(400).send({ error: "Manual payment could not be submitted; check local activity" });
      }
      return res;
    } finally {
      if (resumeEngine) startEngine(maintenanceLease);
    }
  }));

  app.post("/api/token/bribe", async (req, reply) => withEngineMaintenance(reply, async (maintenanceLease) => {
    const resumeEngine = runtime.running;
    try {
      await quiesceEngine();
      const parsed = tokenAction.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      let id: bigint;
      try { id = BigInt(parsed.data.tokenId); } catch { return reply.code(400).send({ error: "Invalid token ID" }); }
      const res = await manualUseBribe(id);
      if (!res.ok) {
        logger.warn(`Manual bribe request failed for #${id}`);
        return reply.code(400).send({ error: "Manual bribe action could not be submitted; check local activity" });
      }
      return res;
    } finally {
      if (resumeEngine) startEngine(maintenanceLease);
    }
  }));

  // --- just-in-time single-epoch payment ---
  app.post("/api/jit", async (req, reply) => withEngineMaintenance(reply, async (maintenanceLease) => {
    const schema = z.object({
      enable: z.boolean(),
      targetEpoch: z.number().int().min(1).optional(),
      tokenIds: z.array(z.string()).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { enable, targetEpoch, tokenIds } = parsed.data;

    if (!enable) {
      const resumeEngine = runtime.running;
      await quiesceEngine();
      resetJitState();
      runtime.saveStrategy({ jitEnabled: false, jitTargetEpoch: null });
      scheduleJitBoundary();
      schedulePreBoundaryPay();
      // Disarming changes what there is to wake for, exactly as arming does — re-evaluate
      // rather than leaving a wake armed for a JIT that no longer exists.
      if (runtime.strategy.awayMode) scheduleAwayWake();
      if (resumeEngine) startEngine(maintenanceLease);
      return runtime.status();
    }

    if (!runtime.unlocked) return reply.code(400).send({ error: "Unlock the wallet first" });

    // The target epoch is computed relative to the CURRENT epoch, so read it fresh
    // from chain here — do NOT trust runtime.currentEpoch, which is only refreshed by
    // the engine's tick loop (refreshSnapshot) and is frozen at its unlock-time value
    // while the engine is paused. Arming off a stale epoch made "next epoch" resolve
    // to one that had already begun, and jitPass then pays it on the next block instead
    // of at the boundary. Fail closed (don't arm off a possibly-stale cache) if the
    // read fails.
    try {
      const snap = await getGameSnapshot();
      runtime.currentEpoch = snap.currentEpoch;
      runtime.startTime = snap.startTime;
      runtime.gameState = snap.state;
      runtime.citizenSupply = snap.citizenSupply;
      runtime.citizensAddress = snap.citizensAddress;
      runtime.emitStatus();
    } catch (err) {
      return internalFailure(reply, err, "Could not read the current epoch from chain; try again", 502);
    }

    const resolved = resolveJitTarget(
      runtime.currentEpoch !== null ? Number(runtime.currentEpoch) : null,
      targetEpoch,
    );
    if (!resolved.ok) return reply.code(400).send({ error: resolved.error });
    const target = resolved.target;
    const resumeEngine = runtime.running;
    await quiesceEngine();
    runtime.saveStrategy({
      jitEnabled: true,
      jitTargetEpoch: target,
      jitTokenIds: tokenIds ?? [],
      enabled: true,
    });
    resetJitState(); // clear any prior submission bookkeeping for this epoch
    // Away mode owns the run window: arming gives it something to wake for, but the
    // engine stays idle until the lead timer fires rather than polling until then.
    if (runtime.strategy.awayMode) scheduleAwayWake();
    if (resumeEngine || !runtime.strategy.awayMode) startEngine(maintenanceLease);
    scheduleJitBoundary();
    schedulePreBoundaryPay();
    return runtime.status();
  }));

  // --- Alchemy / RPC settings ---
  app.get("/api/settings", async () => {
    const s = loadSettings();
    return {
      alchemyKeySet: !!s.alchemyApiKey || !!process.env.ALCHEMY_API_KEY,
      mode: appConfig.mode,
    };
  });

  app.post("/api/settings", async (req, reply) => withEngineMaintenance(reply, async () => {
    if (runtime.running || hasActiveEngineWork()) {
      return reply.code(409).send({ error: "Stop the bot before changing RPC or submission mode" });
    }
    const schema = z.object({
      alchemyApiKey: z.string().min(1).optional(),
      mode: z.enum(["mainnet", "public"]).optional(),
    }).refine((d) => d.alchemyApiKey !== undefined || d.mode !== undefined, {
      message: "Provide at least one of: alchemyApiKey, mode",
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { alchemyApiKey, mode } = parsed.data;
    if (appConfig.mode === "local" && alchemyApiKey && !mode) {
      return reply.code(400).send({
        error: "Choose mainnet or public mode explicitly before applying a live RPC key",
      });
    }

    const existing = loadSettings();
    const nextMode = mode ?? appConfig.mode;
    const urls = alchemyApiKey ? deriveUrlsFromKey(alchemyApiKey) : null;
    const candidateHttpUrl = urls?.httpUrl ?? appConfig.httpUrl;
    let chainId: number;
    try {
      // Probe an isolated candidate client first. Bad credentials, the wrong chain, or
      // unexpected game bytecode must not replace the working client or reach disk.
      chainId = await validateRpcConfiguration(
        candidateHttpUrl,
        nextMode,
        urls?.wsUrl ?? appConfig.wsUrl,
      );
    } catch (error) {
      logger.warn(`Rejected RPC settings: identity validation failed (${error instanceof Error ? error.name : "unknown error"})`);
      return reply.code(400).send({
        error: "RPC configuration failed Ethereum/game-contract identity validation",
      });
    }

    const nextSettings = {
      ...existing,
      ...(alchemyApiKey ? { alchemyApiKey } : {}),
      ...(mode ? { mode } : {}),
    };
    saveSettings(nextSettings);

    if (alchemyApiKey && urls) {
      process.env.ALCHEMY_API_KEY = alchemyApiKey;
      appConfig.httpUrl = urls.httpUrl;
      appConfig.wsUrl = urls.wsUrl;
      appConfig.nftUrl = urls.nftUrl;
      reinitClients(urls.httpUrl, urls.wsUrl);
      // Everything read before this point came from either no key or the wrong one, so it
      // has to be thrown away. reinitClients only drops the block and balance caches; the
      // ownership caches survive it, and makeIdCache is stale-while-revalidate — it
      // serves the cached value immediately even when expired and refreshes behind you.
      // So without this, the first reads after fixing the key still return the empty
      // results cached while it was missing, and the UI only heals a poll or two later.
      invalidateTokenCaches();
      logger.info("Alchemy API key saved; RPC clients reinitialized and caches rebuilt.");
    }

    if (mode) {
      appConfig.mode = mode;
      logger.info(`Submission mode switched to: ${mode}`);
    }

    runtime.chainId = chainId;

    activity.add({
      kind: "info",
      status: "info",
      message: `RPC settings validated and applied in ${appConfig.mode} mode`,
    });

    return { ok: true, mode: appConfig.mode };
  }));

  // --- reads for the dashboard ---
  app.get("/api/tokens", async (_req, reply) => {
    if (!runtime.unlocked) return reply.code(400).send({ error: "locked" });
    try {
      return await readOwnedStatuses();
    } catch (err) {
      return internalFailure(reply, err, "Could not read owned token status");
    }
  });

  /**
   * Manual "Refresh data" — force a genuinely fresh read.
   *
   * Two things the ordinary GETs can't do:
   *  1. The header stats (epoch, balance, citizens left, block, spend) live on `runtime`
   *     and are only written by refreshSnapshot() inside a TICK. With the engine stopped
   *     — which is the normal state in away mode — they never update, so the dashboard
   *     would show whatever was true when the engine last ran.
   *  2. Ownership/enumeration sets are stale-while-revalidate, so a zero TTL still hands
   *     back the old value. They're invalidated here so the follow-up GETs refetch.
   */
  app.post("/api/refresh", async (_req, reply) => {
    try {
      invalidateTokenCaches();
      // getGameSnapshot() with no TTL argument always reads the chain.
      const snap = await getGameSnapshot();
      runtime.currentEpoch = snap.currentEpoch;
      runtime.startTime = snap.startTime;
      runtime.gameState = snap.state;
      runtime.citizenSupply = snap.citizenSupply;
      runtime.citizensAddress = snap.citizensAddress;
      if (runtime.unlocked) {
        invalidateBalanceCache(); // the 30s cache would otherwise answer this
        await Promise.all(
          runtime.wallets.map(async (w) =>
            runtime.setBalance(w.account.address, await getBalanceCached(w.account.address as `0x${string}`, 0)),
          ),
        );
      }
      const block = await getLatestBlockCached(0);
      runtime.lastBlock = block.number;
      runtime.emitStatus();
      // The epoch may have rolled while idle, which changes when the next wake is due.
      if (runtime.strategy.awayMode) scheduleAwayWake();
      return runtime.status();
    } catch (err) {
      return internalFailure(reply, err, "Could not refresh chain data", 502);
    }
  });

  app.get("/api/activity", async (req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 200);
    return activity.recent(limit).map((entry) => (
      unsafeActivityMessage.test(entry.message)
        ? { ...entry, message: "Sensitive provider or credential detail was redacted" }
        : entry
    ));
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
      return internalFailure(reply, err, "Could not generate the transaction post-mortem", 502);
    }
  });

  // --- websocket: push status + activity ---
  const activeSockets = new Set<object>();
  const maxSocketConnections = 8;
  app.get("/ws", {
    websocket: true,
    preValidation: async (req, reply) => {
      const query = req.query as { session?: string };
      if (
        !isAllowedDashboardOrigin(req.headers.origin) ||
        !isSafeFetchSite(req.headers["sec-fetch-site"]) ||
        !sessionTokenMatches(sessionToken, query.session)
      ) {
        logger.warn("Rejected unauthenticated or cross-origin WebSocket upgrade");
        return reply.code(403).send({ error: "Forbidden WebSocket upgrade" });
      }
      if (activeSockets.size >= maxSocketConnections) {
        return reply.code(503).send({ error: "WebSocket connection limit reached" });
      }
    },
  }, (socket) => {
    activeSockets.add(socket);
    const send = (type: string, data: unknown) => {
      try {
        socket.send(JSON.stringify({ type, data }));
      } catch {
        /* ignore */
      }
    };
    send("status", runtime.status());
    send("activity-batch", activity.recent(100).map((entry) => (
      unsafeActivityMessage.test(entry.message)
        ? { ...entry, message: "Sensitive provider or credential detail was redacted" }
        : entry
    )));
    const offStatus = runtime.onStatus((s) => send("status", s));
    const offActivity = activity.subscribe((entry) => send(
      "activity",
      unsafeActivityMessage.test(entry.message)
        ? { ...entry, message: "Sensitive provider or credential detail was redacted" }
        : entry,
    ));
    socket.once("close", () => {
      activeSockets.delete(socket);
      offStatus();
      offActivity();
    });
  });

  // After `npm run build`, serve the Vite dashboard from this same loopback port
  // so `npm start` has a UI at GET /. Dev still uses the Vite server on :5173.
  registerDashboard(app, options.dashboardRoot ?? defaultDashboardRoot());

  return app;
}
