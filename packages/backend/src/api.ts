import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { generatePrivateKey } from "viem/accounts";
import { appConfig, loadSettings, saveSettings, deriveUrlsFromKey } from "./config.js";
import { publicClient, reinitClients, accountFromPrivateKey, getChainId, getBalanceCached, invalidateBalanceCache, getLatestBlockCached } from "./chain.js";
import { runtime, loadRivalSkippers, loadDefaultRivalTargets, adoptRefreshedLists } from "./runtime.js";
import { nonces } from "./nonce.js";
import { activity } from "./activity.js";
import { logger } from "./logger.js";
import {
  encryptPrivateKey,
  decryptPrivateKey,
  saveKeystore,
  loadKeystore,
  loadWallets,
  saveWallets,
  passphraseMatches,
  keystoreExists,
  normalizePrivateKey,
} from "./keystore.js";
import { getGameSnapshot } from "./contract.js";
import { invalidateTokenCaches } from "./index-tokens.js";
import { invalidateEmigrationRoster } from "./emigration.js";
import { resolveJitTarget } from "./logic.js";
import { startEngine, stopEngine, scheduleJitBoundary, schedulePreBoundaryPay, schedulePreBoundaryAudit, schedulePreBoundaryBundle, scheduleDefenseBoundary, resetJitState, manualPayToCurrent, manualUseBribe, scheduleAwayWake, clearAwayTimers } from "./strategy.js";
import { readOwnedStatuses, readTargets, readEmigrated, readAllies,
  readBigBoys, invalidateLiveCandidates, prewarmTargets } from "./service.js";
import { getTargetScores, startTargetScores } from "./target-scores.js";
import { runPostMortem } from "./postmortem.js";
import { syncDefaultLists } from "./list-sync.js";

const strategyPatch = z
  .object({
    enabled: z.boolean(),
    autoDefendAudit: z.boolean(),
    proactivePay: z.boolean(),
    prepayEpochs: z.number().int().min(1).max(7),
    maxAutoPayEpochs: z.number().int().min(1),
    jitEnabled: z.boolean(),
    jitTargetEpoch: z.number().int().min(1).nullable(),
    jitTokenIds: z.array(z.string()),
    excludedTokenIds: z.array(z.string()),
    preBoundaryPay: z.boolean(),
    preBoundaryLeadMs: z.number().int().min(250).max(8000),
    preBoundaryLeadMainnetMs: z.number().int().min(250).max(11000),
    awayMode: z.boolean(),
    awayLeadMinutes: z.number().int().min(1).max(720),
    offenseEnabled: z.boolean(),
    autoAudit: z.boolean(),
    autoKill: z.boolean(),
    endgameOnlyWithin: z.number().int().min(0).nullable(),
    offenseTargetTokenIds: z.array(z.string()),
    preBoundaryAudit: z.boolean(),
    preBoundaryKill: z.boolean(),
    combinedBoundaryBundle: z.boolean(),
    maxBaseFeeGwei: z.number().positive(),
    priorityFeeGwei: z.number().min(0),
    minBalanceEth: z.number().min(0),
    separateOffenseGas: z.boolean(),
    offenseMaxBaseFeeGwei: z.number().positive(),
    offensePriorityFeeGwei: z.number().min(0),
    offenseDynamicTipEnabled: z.boolean(),
    offenseDynamicTipMaxGwei: z.number().positive(),
    racePublicMempool: z.boolean(),
    dynamicTipEnabled: z.boolean(),
    dynamicTipMaxGwei: z.number().positive(),
    maxPaymentEth: z.number().min(0),
    coinbaseBidEth: z.number().min(0),
    coinbaseBidAuditOnlyEth: z.number().min(0),
    coinbasePayerAddress: z.string().regex(/^(0x[a-fA-F0-9]{40})?$/, "must be a 0x address or empty"),
  })
  .partial();

/** Extract the hostname from a Host header, dropping the port (handles [::1]). */
function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim();
  if (h.startsWith("[")) return h.slice(1, h.indexOf("]")).toLowerCase(); // [IPv6]:port
  const i = h.lastIndexOf(":");
  return (i >= 0 ? h.slice(0, i) : h).toLowerCase();
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket);

  // DNS-rebinding guard: when bound to loopback (the default, documented secure
  // setup), only accept requests whose Host header is a loopback name. This stops
  // a malicious web page from rebinding a domain to 127.0.0.1 and driving the
  // wallet API. If the operator deliberately bound to a non-loopback interface,
  // they've opted into exposure, so we don't second-guess their Host header.
  const boundToLoopback = ["127.0.0.1", "::1", "localhost"].includes(appConfig.host);
  if (boundToLoopback) {
    const allowedHosts = new Set(["127.0.0.1", "localhost", "::1"]);
    app.addHook("onRequest", async (req, reply) => {
      if (!allowedHosts.has(hostnameOf(req.headers.host ?? ""))) {
        return reply.code(403).send({ error: "Forbidden: unexpected Host header" });
      }
    });
  }

  // --- status & config ---
  app.get("/api/status", async () => runtime.status());
  app.get("/api/config", async () => runtime.strategy);

  // Curated rival target IDs shipped in git (data/rival-targets.json). Exposed so
  // the Config UI can offer a "reset to default" that restores the shipped list
  // after the user has edited their offense targets.
  app.get("/api/default-rival-targets", async () => ({
    tokenIds: loadDefaultRivalTargets(),
  }));

  // "Rival skippers" — the subset of default targets that pay on a ~2-epoch cadence
  // (data/rival-skippers.json). Offered as a one-click focused target list.
  app.get("/api/rival-skippers", async () => ({
    tokenIds: loadRivalSkippers(),
  }));

  // Re-pull the curated lists from master without a restart. The startup sync is the
  // normal path; this exists because a list can change mid-session (the game moves
  // faster than restarts), and re-downloading the bot to get it is exactly what the
  // auto-update removes. Same guards as startup — a git checkout and locally-edited
  // files are left alone, and an empty remote list is rejected.
  app.post("/api/refresh-lists", async (_req, reply) => {
    try {
      const before = loadRivalSkippers();
      const outcomes = await syncDefaultLists();
      const repointed = adoptRefreshedLists(before);
      // Panels read the list files live, but their rows are built from cached
      // ownership/status sets, so a new list wouldn't show until the next natural
      // refresh without this.
      if (outcomes.some((o) => o.result === "updated")) invalidateLiveCandidates();
      return { outcomes, repointed };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // --- on-demand rival scoring (dashboard "Analyze targets") ---
  // The scan takes minutes, so POST starts it in the background and the UI polls GET.
  app.get("/api/target-scores", async () => getTargetScores());
  app.post("/api/target-scores", async () => startTargetScores());

  app.post("/api/config", async (req, reply) => {
    const parsed = strategyPatch.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const next = runtime.saveStrategy(parsed.data);
    const nowActive = next.enabled || next.offenseEnabled;
    // Saving strategy never auto-STARTS the engine — starting is explicit (the "Start
    // bot" button, or arming a JIT payment) so the user can finish configuring (coinbase
    // bid, gas, payment strategy) before going live. We still auto-STOP in the safe
    // direction: if every strategy flag is now off, a running engine has nothing to do.
    if (!nowActive && runtime.running) stopEngine();
    // Away mode owns when the engine runs, so any config change re-evaluates it: turning
    // it on arms the wake timer, turning it off cancels, and arming/disarming JIT or
    // offense changes whether there is anything to wake FOR.
    if (next.awayMode) scheduleAwayWake(); else clearAwayTimers();
    scheduleDefenseBoundary();
    schedulePreBoundaryPay();
    schedulePreBoundaryAudit();
    schedulePreBoundaryBundle();
    return next;
  });

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
  app.post("/api/wallets", async (req, reply) => {
    const schema = z.object({
      mode: z.enum(["import", "generate"]),
      privateKey: z.string().optional(),
      passphrase: z.string().min(8),
      label: z.string().max(40).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { mode, passphrase, label } = parsed.data;

    if (!keystoreExists(appConfig.dataDir)) {
      return reply.code(400).send({ error: "Create the first wallet before adding more" });
    }
    if (!passphraseMatches(appConfig.dataDir, passphrase)) {
      return reply.code(401).send({
        error: "Passphrase does not match the existing keystore — every wallet shares one passphrase",
      });
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
    const entry = encryptPrivateKey(pk, passphrase, account.address);
    entry.label = label?.trim() || `wallet-${existing.length + 1}`;
    saveWallets(appConfig.dataDir, [...existing, entry]);

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
    logger.info(`Wallet added: ${account.address} (${entry.label})`);
    return { address: account.address, label: entry.label, generated: mode === "generate" };
  });

  /**
   * Remove a wallet. The key is permanently discarded, so this refuses unless the caller
   * repeats the address — a mis-click here loses access to whatever that wallet holds.
   */
  app.delete("/api/wallets/:address", async (req, reply) => {
    const params = z.object({ address: z.string() }).safeParse(req.params);
    const body = z.object({ confirmAddress: z.string() }).safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "address and confirmAddress are required" });
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
    saveWallets(appConfig.dataDir, existing.filter((w) => w.address.toLowerCase() !== target));
    if (runtime.unlocked) {
      runtime.setWallets(runtime.wallets.filter((w) => w.account.address.toLowerCase() !== target));
      // Drop its nonce state too, so re-adding the wallet later starts from chain truth
      // rather than a stale reservation held from this session.
      nonces.retain(runtime.addresses as `0x${string}`[]);
      invalidateTokenCaches();
      runtime.emitStatus();
    }
    logger.warn(`Wallet removed from keystore: ${target}`);
    return { ok: true, remaining: existing.length - 1 };
  });

  app.post("/api/keystore", async (req, reply) => {
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
    saveKeystore(appConfig.dataDir, file);
    logger.info(`Keystore created for ${account.address}`);
    return { address: account.address };
  });

  app.post("/api/unlock", async (req, reply) => {
    const schema = z.object({ passphrase: z.string() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const files = loadWallets(appConfig.dataDir);
    if (files.length === 0) return reply.code(400).send({ error: "No keystore found" });
    try {
      // Every wallet is encrypted under the same passphrase, so one unlock opens them
      // all. If any single entry fails to decrypt the whole unlock fails rather than
      // half-unlocking — a silently-missing wallet would look like its citizens simply
      // stopped being managed.
      const wallets = files.map((f, i) => {
        const account = accountFromPrivateKey(decryptPrivateKey(f, parsed.data.passphrase));
        return { account, label: f.label ?? (i === 0 ? "primary" : `wallet-${i + 1}`), balanceWei: null };
      });
      runtime.setWallets(wallets);
      nonces.retain(runtime.addresses as `0x${string}`[]);
      runtime.chainId = await getChainId();
      runtime.emitStatus();
      logger.info(`Unlocked ${wallets.length} wallet(s): ${wallets.map((w) => w.account.address).join(", ")}`);
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
        const msg = (err as Error).message;
        logger.warn("Unlock-time chain read failed:", msg);
        activity.add({
          kind: "error",
          status: "skipped",
          message: `Could not read chain state on unlock (${msg}) — check the Alchemy key, then press Refresh data`,
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
      return reply.code(401).send({ error: "Incorrect passphrase" });
    }
  });

  app.post("/api/lock", async () => {
    stopEngine();
    runtime.lock();
    return { ok: true };
  });

  // --- engine control ---
  app.post("/api/start", async (_req, reply) => {
    if (!runtime.unlocked) return reply.code(400).send({ error: "Unlock the wallet first" });
    startEngine();
    return runtime.status();
  });

  app.post("/api/stop", async () => {
    stopEngine();
    return runtime.status();
  });

  // --- manual, user-initiated token actions (dashboard buttons) ---
  // Priced with normal network gas at press time, and NOT subject to the Auto-Pay
  // Limit — that cap bounds what the bot spends on its own; pressing the button is
  // the user's own decision. Works whether or not the engine is running.
  const tokenAction = z.object({ tokenId: z.string().min(1) });

  app.post("/api/token/pay", async (req, reply) => {
    const parsed = tokenAction.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    let id: bigint;
    try { id = BigInt(parsed.data.tokenId); } catch { return reply.code(400).send({ error: "Invalid token ID" }); }
    const res = await manualPayToCurrent(id);
    if (!res.ok) return reply.code(400).send({ error: res.message });
    return res;
  });

  app.post("/api/token/bribe", async (req, reply) => {
    const parsed = tokenAction.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    let id: bigint;
    try { id = BigInt(parsed.data.tokenId); } catch { return reply.code(400).send({ error: "Invalid token ID" }); }
    const res = await manualUseBribe(id);
    if (!res.ok) return reply.code(400).send({ error: res.message });
    return res;
  });

  // --- just-in-time single-epoch payment ---
  app.post("/api/jit", async (req, reply) => {
    const schema = z.object({
      enable: z.boolean(),
      targetEpoch: z.number().int().min(1).optional(),
      tokenIds: z.array(z.string()).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { enable, targetEpoch, tokenIds } = parsed.data;

    if (!enable) {
      runtime.saveStrategy({ jitEnabled: false, jitTargetEpoch: null });
      scheduleJitBoundary();
      // All three, because which one owns the boundary depends on combinedBundleActive:
      // with a bid configured schedulePreBoundaryPay() returns immediately and the bundle
      // scheduler is the one that matters. Arming only the pay path left the bundle to be
      // picked up by the next refreshSnapshot — correct today, but a dependency on tick
      // ordering that nothing states.
      schedulePreBoundaryPay();
      schedulePreBoundaryAudit();
      schedulePreBoundaryBundle();
      // Disarming changes what there is to wake for, exactly as arming does — re-evaluate
      // rather than leaving a wake armed for a JIT that no longer exists.
      if (runtime.strategy.awayMode) scheduleAwayWake();
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
      return reply.code(502).send({ error: `Could not read the current epoch from chain — try again: ${(err as Error).message}` });
    }

    const resolved = resolveJitTarget(
      runtime.currentEpoch !== null ? Number(runtime.currentEpoch) : null,
      targetEpoch,
    );
    if (!resolved.ok) return reply.code(400).send({ error: resolved.error });
    const target = resolved.target;
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
    else if (!runtime.running) startEngine();
    scheduleJitBoundary();
    // Same as the disarm path above: arm every pre-boundary scheduler and let each one
    // decide whether it owns this boundary, rather than assuming the pay path does.
    schedulePreBoundaryPay();
    schedulePreBoundaryAudit();
    schedulePreBoundaryBundle();
    return runtime.status();
  });

  // --- Alchemy / RPC settings ---
  app.get("/api/settings", async () => {
    const s = loadSettings();
    return {
      alchemyKeySet: !!s.alchemyApiKey || !!process.env.ALCHEMY_API_KEY,
      mode: appConfig.mode,
    };
  });

  app.post("/api/settings", async (req, reply) => {
    const schema = z.object({
      alchemyApiKey: z.string().min(1).optional(),
      mode: z.enum(["mainnet", "public"]).optional(),
    }).refine((d) => d.alchemyApiKey !== undefined || d.mode !== undefined, {
      message: "Provide at least one of: alchemyApiKey, mode",
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { alchemyApiKey, mode } = parsed.data;

    const existing = loadSettings();

    if (alchemyApiKey) {
      saveSettings({ ...existing, alchemyApiKey, ...(mode ? { mode } : {}) });
      process.env.ALCHEMY_API_KEY = alchemyApiKey;
      const urls = deriveUrlsFromKey(alchemyApiKey);
      appConfig.httpUrl = urls.httpUrl;
      appConfig.wsUrl = urls.wsUrl;
      appConfig.nftUrl = urls.nftUrl;
      reinitClients(urls.httpUrl, urls.wsUrl);
      // Everything read before this point came from either no key or the wrong one, so it
      // has to be thrown away. reinitClients only drops the block and balance caches; the
      // ownership, live-candidate and emigration caches survive it, and makeIdCache is
      // stale-while-revalidate — it serves the cached value immediately even when expired
      // and refreshes behind you. So without this, the first reads after fixing the key
      // still return the empty results cached while it was missing, and the UI only heals
      // a poll or two later. That is what made "re-enter the same key" look like a fix.
      invalidateTokenCaches();
      invalidateLiveCandidates();
      invalidateEmigrationRoster();
      // Warm them again. main.ts only prewarms when a key exists AT BOOT, which is never
      // true on a fresh install — so the first dashboard load after setup paid the full
      // ~15s cold collection enumeration against a blank screen.
      void prewarmTargets();
      logger.info("Alchemy API key saved; RPC clients reinitialized and caches rebuilt.");
    }

    if (mode) {
      saveSettings({ ...existing, ...(alchemyApiKey ? { alchemyApiKey } : {}), mode });
      appConfig.mode = mode;
      logger.info(`Submission mode switched to: ${mode}`);
    }

    return { ok: true, mode: appConfig.mode };
  });

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

  // Citizens held by the Emigration contract — out of the main game, so they're
  // filtered out of /api/targets and every offense sweep and listed only here.
  app.get("/api/emigrated", async (_req, reply) => {
    try {
      return await readEmigrated();
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // Allied citizens (data/ally-tokens.json) — teammates' tokens, listed in their own
  // panel and excluded from every rival/offense path.
  app.get("/api/allies", async (_req, reply) => {
    try {
      return await readAllies();
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // The "big boys" (data/big-boys.json) — heavyweight operators, tagged by who runs them.
  // Full offense candidates; the roster only gives them their own panel section so they
  // aren't listed twice.
  app.get("/api/big-boys", async (_req, reply) => {
    try {
      return await readBigBoys();
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
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
      invalidateLiveCandidates();
      invalidateEmigrationRoster();
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
