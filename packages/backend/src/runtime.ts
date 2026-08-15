import fs from "node:fs";
import path from "node:path";
import type { PrivateKeyAccount } from "viem/accounts";
import { VERSION, type BotStatus, type StrategyConfig } from "@dat-bot/shared";
import { appConfig } from "./config.js";
import { logger } from "./logger.js";
import { activity } from "./activity.js";
import { ownershipIndexingAvailable } from "./index-tokens.js";
import { versionState } from "./version-check.js";

// Central mutable runtime state. Single hot wallet, single strategy config.

/**
 * Parsed-list cache, keyed by file and invalidated on mtime+size.
 *
 * These four files are read on the HOT PATH: fetchOffenseCandidates reads the ally and
 * big-boy lists on every offense sweep (once per block with a WebSocket), and
 * readTargets reads them again on every dashboard poll — each read a synchronous
 * readFileSync + JSON.parse (measured at 0.19 ms for the pair). They only change when the
 * startup sync rewrites them or the user edits one by hand.
 *
 * Keyed on mtimeMs + size rather than a TTL so a hand edit or a list-sync write is picked
 * up on the very next read, with no staleness window — the whole point of the files being
 * user-editable. `statSync` is ~an order of magnitude cheaper than reading and parsing.
 *
 * Deliberately NOT keyed on content hash: hashing means reading the file, which is the
 * cost being avoided.
 */
const fileCache = new Map<string, { key: string; value: unknown }>();

/**
 * Read and parse a JSON file, reusing the last parse while the file is unchanged.
 * Returns null when the file is absent or unreadable, so callers keep their existing
 * "missing means empty" behaviour.
 *
 * The cached value is returned BY REFERENCE, so callers must not mutate it. Every caller
 * below derives a new array/Set from it, which is why this is safe.
 */
function readJsonCached(fileName: string): unknown | null {
  const p = path.join(appConfig.dataDir, fileName);
  let key: string;
  try {
    const st = fs.statSync(p);
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    // Absent (or unreadable) — drop any cached parse so a later re-appearance is seen.
    fileCache.delete(fileName);
    return null;
  }
  const hit = fileCache.get(fileName);
  if (hit && hit.key === key) return hit.value;
  const value = JSON.parse(fs.readFileSync(p, "utf8"));
  fileCache.set(fileName, { key, value });
  return value;
}

/** Drop every cached list parse. For tests, which rewrite data files within the same
 *  millisecond — fine in production (mtime+size moves) but not at test speed. */
export function invalidateListCache(): void {
  fileCache.clear();
}

// Curated rival token IDs ship in git (data/rival-targets.json, unlike the
// gitignored data/config.json) so a fresh clone has offense targets without
// needing to `cp data/config.example.json data/config.json` first.
function loadRivalIdFile(fileName: string, label: string): string[] {
  try {
    const ids = readJsonCached(fileName);
    if (Array.isArray(ids)) return ids.map(String);
  } catch (err) {
    logger.warn(`Could not load ${label}:`, (err as Error).message);
  }
  return [];
}

export function loadDefaultRivalTargets(): string[] {
  return loadRivalIdFile("rival-targets.json", "default rival targets");
}

/**
 * "Rival skippers" — a curated subset of the default targets that empirically pay
 * on a ~2-epoch cadence (they let themselves go 2+ epochs behind, so they're
 * auditable at every second boundary). Shipped in git (data/rival-skippers.json)
 * and offered in the Config UI as a one-click focused target list. Regenerate with
 * scripts/rival-skippers.mjs (see that file for the detection heuristic).
 */
export function loadRivalSkippers(): string[] {
  return loadRivalIdFile("rival-skippers.json", "rival skippers");
}

/**
 * Allied citizens (data/ally-tokens.json) — tokens played by people we're cooperating
 * with. They are NOT rivals: the offense engine must never audit or kill them, and they
 * get their own dashboard panel rather than appearing under "Rival targets", where a
 * delinquent ally reads as a kill candidate.
 */
export function loadAllyTokens(): string[] {
  return loadRivalIdFile("ally-tokens.json", "ally tokens");
}

/**
 * The "big boys" (data/big-boys.json) — the heavyweight operators, grouped by whoever runs
 * them.
 *
 * These ARE targets. The roster used to be do-not-target.json and excluded them from every
 * offense path; the team now attacks them in a coordinated push, so the grouping survives
 * purely for ATTRIBUTION — the dashboard gives them their own section and tags each id with
 * its operator, which is what turns bare ids into "that one is Graveyard's" when reading the
 * board. Nothing here is excluded from offense and nothing is greyed.
 *
 * Allies (ally-tokens.json) remain the one hard block, and a pin cannot override that.
 *
 * Returns the flat id list plus the owner grouping, so the UI can tag each id with who
 * runs it.
 */
export function loadBigBoys(): { tokenIds: string[]; owners: Record<string, string[]> } {
  try {
    const raw = readJsonCached("big-boys.json") as { owners?: Record<string, unknown> } | null;
    if (!raw) return { tokenIds: [], owners: {} };
    // Memoize the DERIVED shape against the same parsed object, not just the parse: the
    // normalize + dedupe below runs on every offense sweep and every dashboard poll, and
    // its input only changes when the file does. Identity holds because readJsonCached
    // returns the cached parse by reference.
    const memo = bigBoyMemo;
    if (memo && memo.src === raw) return memo.out;
    const owners: Record<string, string[]> = {};
    for (const [name, ids] of Object.entries(raw.owners ?? {})) {
      if (!Array.isArray(ids)) continue;
      owners[name] = ids.map(String).filter((id) => /^\d+$/.test(id));
    }
    // De-duplicated across owners: a token listed twice must not be counted twice.
    const tokenIds = [...new Set(Object.values(owners).flat())];
    const out = { tokenIds, owners };
    bigBoyMemo = { src: raw, out };
    return out;
  } catch {
    return { tokenIds: [], owners: {} };
  }
}

/** Memo for loadBigBoys's derived output, tied to the identity of the parsed file. */
let bigBoyMemo: {
  src: object;
  out: { tokenIds: string[]; owners: Record<string, string[]> };
} | null = null;

/** Flat lookup of tokenId -> operator name, for tagging rows in the UI. */
export function bigBoyOwnerOf(): Record<string, string> {
  const { owners } = loadBigBoys();
  const map: Record<string, string> = {};
  for (const [name, ids] of Object.entries(owners)) for (const id of ids) map[id] = name;
  return map;
}

export const DEFAULT_STRATEGY: StrategyConfig = {
  enabled: false,
  // Pays an unbounded catch-up with no keypress, so opt-in — and deliberately NOT a
  // RECOMMENDED_FIELD: a defaults bump must never switch on automatic spending.
  autoDefendAudit: false,
  proactivePay: true,
  prepayEpochs: 1,
  maxAutoPayEpochs: 1, // auto-payments cover at most 1 epoch (1 day) each; JIT always fires
  jitEnabled: false,
  jitTargetEpoch: null,
  jitTokenIds: [],
  // Per-citizen "never pay" opt-out. Deliberately NOT a RECOMMENDED_FIELD: it's a user
  // decision about their own citizens, so a defaults-version bump must never silently
  // re-enable payments on a citizen they chose to abandon.
  excludedTokenIds: [],
  preBoundaryPay: true,
  preBoundaryLeadMs: 3000,
  preBoundaryLeadMainnetMs: 5000,
  // Away mode is a run-mode choice like `enabled`, so it is NOT a RECOMMENDED_FIELD —
  // a defaults bump must never silently put the engine back on 24/7 polling.
  awayMode: false,
  awayLeadMinutes: 15,
  // Offense is ON by default, focused on the curated "skippers" list (rivals that
  // reliably fall 2+ epochs behind, so they're auditable at every boundary). The
  // supporting settings below are pre-armed so it works out of the box.
  offenseEnabled: true,
  autoAudit: true,
  autoKill: false, // opt-in: killing an expired-audit token is free but aggressive
  endgameOnlyWithin: null,
  offenseTargetTokenIds: loadRivalSkippers(),
  preBoundaryAudit: true,
  preBoundaryKill: true, // race kills into the first block after audit expiry (no-op unless autoKill is on)
  // On by default, but self-guarding: it only fuses payment + audit into one bundle
  // when a coinbase bid is set (coinbaseBidEth > 0). Without a bid it's a no-op — the
  // bot sends separate bundles so audits keep their mempool fallback — so leaving it
  // on is safe and means a later bid "just works" without a second toggle to find.
  combinedBoundaryBundle: true,
  // Payment gas — tuned to win the boundary bundle race. The base-fee cap is generous
  // (boundary blocks run near-empty at <1 gwei; the cap only guards against a spike).
  maxBaseFeeGwei: 69.1,
  // 120 gwei static. Measured across recent boundaries: tip is what the value-sorting
  // builders rank on once bids are equal, and it is the ONLY lever on a solo-built block
  // — vanilla geth orders by priority fee and ignores coinbase transfers entirely, which
  // is ~10% of boundaries. 120 gwei/gas clears the common field outright (rivals defended
  // at 80-114 gwei/gas over the last six boundaries) before a wei of bid is spent.
  //
  // NOTE this sits ABOVE dynamicTipMaxGwei (69.1), which makes the dynamic tip inert:
  // dynamicTipGwei() clamps its ceiling up to the static base, so it returns 120 flat
  // rather than escalating. Harmless — you get the static tip — but there is no
  // escalation headroom in a contested block until that ceiling is raised too.
  priorityFeeGwei: 120,
  minBalanceEth: 0.01,
  // Offense (audit/kill) bids its own gas, independent of payments — it's a race
  // against rivals where a payment isn't. Matched to the payment ceilings so an
  // audit isn't the weak link at a contested boundary.
  separateOffenseGas: true,
  offenseMaxBaseFeeGwei: 69.1,
  offensePriorityFeeGwei: 120, // matched to the payment tip; see the note there
  offenseDynamicTipEnabled: true,
  offenseDynamicTipMaxGwei: 69.1,
  racePublicMempool: true,
  dynamicTipEnabled: true,
  dynamicTipMaxGwei: 69.1,
  coinbaseBidEth: 0, // off; flat builder payment for top-of-block, opt-in
  // Audit-only boundaries bid separately: that bundle is smaller and losing it costs only
  // the audit fee, so it rarely warrants what a must-land payment bundle does.
  coinbaseBidAuditOnlyEth: 0,
  // Shared CoinbasePayer forwarder (verified on-chain to forward 100% to
  // block.coinbase). Only used when coinbaseBidEth > 0; deploy your own if you'd
  // rather not share (see contracts/CoinbasePayer.sol).
  coinbasePayerAddress: "0xb69D1Bb4613722bdAb1aA77BA8F4409071f0a815",
  // Off. Unlike the payer above there is deliberately NO shared default: a vault holds
  // citizens, so pointing at someone else's would be pointing at their portfolio. Each
  // operator deploys their own (contracts/CitizenVault.sol) or leaves this empty.
  vaultAddress: "",
  maxPaymentEth: 0, // 0 = no cap (opt-in guardrail)
};

/**
 * Re-seed the shipped defaults from the list files on disk, after the startup sync in
 * list-sync.ts has refreshed them.
 *
 * DEFAULT_STRATEGY captures `loadRivalSkippers()` at import time, which is BEFORE the
 * sync runs, so without this the freshly-downloaded skippers list would reach every
 * consumer that reads the file live (offense filters, the panels, /api/rival-skippers)
 * but not the one place that snapshots it: the pinned offense targets.
 *
 * `previousSkippers` is the list as it was before the sync. The user's saved pins are
 * only re-pointed at the new list when they still match the old one exactly — i.e. they
 * were tracking the curated default and never customised. A hand-edited target box is
 * the user's own strategy and is left alone; they can re-adopt with the one-click
 * "skippers" template in the Config UI.
 *
 * Returns true when the saved pins were re-pointed, so startup can say so.
 */
export function adoptRefreshedLists(previousSkippers: string[]): boolean {
  const fresh = loadRivalSkippers();
  DEFAULT_STRATEGY.offenseTargetTokenIds = fresh;

  // Compared by canonical BigInt string so a pure formatting difference ("0084" vs "84")
  // between two versions of the file doesn't read as the user having customised. A
  // non-numeric entry can't be canonicalised, so it's compared literally rather than
  // throwing and taking startup down.
  const canon = (id: string) => { try { return BigInt(id).toString(); } catch { return id; } };
  const sameIds = (a: string[], b: string[]) =>
    a.length === b.length && a.every((id, i) => canon(id) === canon(b[i] ?? ""));

  if (sameIds(fresh, previousSkippers)) return false; // list didn't change; nothing to do
  if (!sameIds(runtime.strategy.offenseTargetTokenIds, previousSkippers)) return false; // customised

  runtime.saveStrategy({ offenseTargetTokenIds: fresh });
  return true;
}

/**
 * Bump ONLY when the recommended defaults change (gas tuning, behaviour flags, or
 * the curated rival-target list in data/rival-targets.json).
 *
 * A saved `data/config.json` stamped with an older value is migrated on load: the
 * RECOMMENDED_FIELDS below are refreshed to the current defaults, so a user who
 * carries their data/ folder across updates isn't silently stuck on stale settings.
 * Tied to this constant rather than VERSION so an unrelated release doesn't reset
 * anyone's tuning.
 */
// NOT bumped for the 120 gwei tip default (v1.3.4). Deliberate: priorityFeeGwei and
// offensePriorityFeeGwei are RECOMMENDED_FIELDS, so bumping this would OVERWRITE every
// existing user's tip with 120 — a ~6x spend increase on every transaction, applied
// without them asking. It would also reset the rest of their gas tuning in that list
// (base-fee caps, dynamic tip ceilings, pre-boundary lead) back to shipped values.
// Leaving it at 4 means 120 reaches NEW installs only; existing users keep what they set
// and can opt in themselves.
export const DEFAULTS_VERSION = 4;

/**
 * Refreshed to DEFAULT_STRATEGY when the defaults version changes. Everything NOT
 * listed is PRESERVED from the user's saved config — their mode/run-state
 * (enabled, offenseEnabled, endgameOnlyWithin), wallet-side settings
 * (coinbaseBidEth, coinbasePayerAddress, vaultAddress), spend guardrails (minBalanceEth,
 * maxPaymentEth), and JIT session (jitEnabled, jitTargetEpoch, jitTokenIds).
 *
 * vaultAddress in particular must NEVER be listed below: a defaults bump that cleared it
 * would silently move a user off their vault, and one that set it would point them at a
 * contract holding someone else's citizens.
 */
const RECOMMENDED_FIELDS: (keyof StrategyConfig)[] = [
  "proactivePay", "prepayEpochs", "maxAutoPayEpochs",
  "preBoundaryPay", "preBoundaryLeadMs", "preBoundaryLeadMainnetMs",
  "autoAudit", "autoKill", "preBoundaryAudit", "preBoundaryKill", "combinedBoundaryBundle",
  "maxBaseFeeGwei", "priorityFeeGwei",
  "separateOffenseGas", "offenseMaxBaseFeeGwei", "offensePriorityFeeGwei",
  "offenseDynamicTipEnabled", "offenseDynamicTipMaxGwei",
  "racePublicMempool", "dynamicTipEnabled", "dynamicTipMaxGwei",
  // Re-pulls the curated skippers list shipped in data/rival-skippers.json.
  "offenseTargetTokenIds",
];

/**
 * One unlocked hot wallet.
 *
 * No WalletClient here: every submission path signs with `account.signTransaction` and
 * sends the raw tx (or bundles it), so the viem wallet client was write-only state even
 * in the single-wallet design. Carrying one per wallet would just multiply dead weight.
 */
export interface Wallet {
  account: PrivateKeyAccount;
  /** Human name from the keystore, e.g. "cold-1". */
  label: string;
  /** Last-read on-chain balance. Per-wallet because the min-balance floor is
   *  per-wallet — each wallet pays its own gas. */
  balanceWei: bigint | null;
}

class Runtime {
  /**
   * Every unlocked wallet, in keystore order. `wallets[0]` is the PRIMARY: it funds the
   * coinbase bid, since one bid buys position for the whole bundle regardless of how many
   * wallets contributed txs to it.
   *
   * payTaxes/audit/kill/useBribe are all owner-only on-chain (verified by simulation), so
   * an action on a citizen must be signed by the wallet that holds it — see walletFor().
   */
  wallets: Wallet[] = [];
  strategy: StrategyConfig = { ...DEFAULT_STRATEGY };

  running = false;

  // status fields
  chainId: number | null = null;
  currentEpoch: bigint | null = null;
  gameState: number | null = null;
  citizenSupply: bigint | null = null;
  citizensAddress: string | null = null;
  lastBlock: bigint | null = null;
  startTime: bigint | null = null;
  /** Next away-mode wake (unix seconds); set by the away scheduler in strategy.ts.
   *  Held here rather than imported to avoid a runtime <-> strategy import cycle. */
  awayNextWakeSec: number | null = null;

  // spend tracking
  private spentThisEpoch = 0n;
  private spendEpoch: bigint | null = null;

  private statusListeners = new Set<(s: BotStatus) => void>();

  constructor() {
    this.loadStrategy();
  }

  get unlocked(): boolean {
    return this.wallets.length > 0;
  }

  /** The primary wallet — bid payer, and the single identity the UI shows. */
  get primary(): Wallet | null {
    return this.wallets[0] ?? null;
  }

  /** Back-compat alias: the primary account. Only for paths that genuinely want ONE
   *  wallet (the bid payer, the header address). Anything acting on a citizen must use
   *  walletFor() instead, or it will sign with the wrong wallet and revert. */
  get account(): PrivateKeyAccount | null {
    return this.primary?.account ?? null;
  }

  /** Total across every unlocked wallet — what the header "Balance" stat means now. */
  get balanceWei(): bigint | null {
    if (this.wallets.length === 0) return null;
    let total = 0n;
    let seen = false;
    for (const w of this.wallets) {
      if (w.balanceWei === null) continue;
      total += w.balanceWei;
      seen = true;
    }
    return seen ? total : null;
  }

  /** The wallet holding `owner`, or null if we don't hold that address. */
  walletFor(owner: string): Wallet | null {
    const want = owner.toLowerCase();
    return this.wallets.find((w) => w.account.address.toLowerCase() === want) ?? null;
  }

  /** True if `addr` is one of ours — used to keep our own citizens out of target lists. */
  ownsAddress(addr: string): boolean {
    return this.walletFor(addr) !== null;
  }

  get addresses(): string[] {
    return this.wallets.map((w) => w.account.address);
  }

  /** Replace the unlocked set (unlock, or a wallet added/removed while unlocked). */
  setWallets(wallets: Wallet[]): void {
    this.wallets = wallets;
  }

  /** Record a freshly-read balance for one wallet. No-op for an address we don't hold. */
  setBalance(address: string, wei: bigint): void {
    const w = this.walletFor(address);
    if (w) w.balanceWei = wei;
  }

  private configPath(): string {
    return path.join(appConfig.dataDir, "config.json");
  }

  loadStrategy(): void {
    try {
      const p = this.configPath();
      // No saved config (fresh install/extract) -> DEFAULT_STRATEGY already IS the
      // recommended set, so there's nothing to migrate.
      if (!fs.existsSync(p)) return;
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      // Meta key, not part of StrategyConfig. Absent => pre-versioning config (0).
      const savedDefaults = typeof raw.defaultsVersion === "number" ? raw.defaultsVersion : 0;
      // Keep only keys DEFAULT_STRATEGY still declares, so config.json doesn't carry
      // dead fields from retired settings across upgrades (and `defaultsVersion`
      // itself, which is file meta rather than strategy, is dropped here too).
      const merged: Record<string, unknown> = {};
      for (const k of Object.keys(DEFAULT_STRATEGY) as (keyof StrategyConfig)[]) {
        merged[k] = k in raw ? raw[k] : DEFAULT_STRATEGY[k];
      }
      // Upgrade path for the split coinbase bid. A config written before
      // coinbaseBidAuditOnlyEth existed has one bid that covered BOTH boundary kinds, so
      // defaulting the new field to 0 would silently stop bidding on every audit-only
      // night — and, worse, drop those audits back to the mempool-mirror path. Carry the
      // old value across so behaviour is unchanged on upgrade; 0 means 0 from then on,
      // which is what makes "bid on payments only" expressible at all.
      if (!("coinbaseBidAuditOnlyEth" in raw) && typeof raw.coinbaseBidEth === "number" && raw.coinbaseBidEth > 0) {
        (merged as Record<string, unknown>).coinbaseBidAuditOnlyEth = raw.coinbaseBidEth;
        logger.info(
          `Config upgrade: audit-only coinbase bid seeded from the existing bid (${raw.coinbaseBidEth} ETH). ` +
            `Set it separately to bid less on offense-only boundaries.`,
        );
      }
      this.strategy = merged as unknown as StrategyConfig;
      if (savedDefaults < DEFAULTS_VERSION) {
        this.strategy = this.applyRecommendedDefaults(this.strategy, savedDefaults);
        this.writeConfig(); // persist the migration + new stamp so it runs once
      }
    } catch (err) {
      logger.warn("Could not load strategy config:", (err as Error).message);
    }
  }

  /** Refresh the RECOMMENDED_FIELDS to current defaults, preserving user choices.
   *  Reports exactly what changed so the refresh is never silent. */
  private applyRecommendedDefaults(saved: StrategyConfig, fromVersion: number): StrategyConfig {
    const out = { ...saved };
    const changed: string[] = [];
    for (const k of RECOMMENDED_FIELDS) {
      const def = DEFAULT_STRATEGY[k];
      if (JSON.stringify(out[k]) !== JSON.stringify(def)) changed.push(k);
      (out as Record<string, unknown>)[k] = def;
    }
    const detail = changed.length ? `refreshed: ${changed.join(", ")}` : "already current";
    const msg =
      `Config updated to recommended defaults v${DEFAULTS_VERSION} (was v${fromVersion}) — ${detail}. ` +
      `Kept your run mode, wallet/payer, coinbase bid, spend caps and JIT selection.`;
    logger.info(msg);
    activity.add({ kind: "info", status: "info", message: msg });
    return out;
  }

  /** Write config.json, stamping the defaults version it was written against. */
  private writeConfig(): void {
    try {
      fs.mkdirSync(appConfig.dataDir, { recursive: true });
      fs.writeFileSync(
        this.configPath(),
        JSON.stringify({ ...this.strategy, defaultsVersion: DEFAULTS_VERSION }, null, 2),
      );
    } catch (err) {
      logger.warn("Could not save strategy config:", (err as Error).message);
    }
  }

  saveStrategy(next: Partial<StrategyConfig>): StrategyConfig {
    this.strategy = { ...this.strategy, ...next };
    this.writeConfig();
    this.emitStatus();
    return this.strategy;
  }

  /** Track spend for the current epoch; resets automatically on epoch change. */
  recordSpend(wei: bigint): void {
    if (this.spendEpoch !== this.currentEpoch) {
      this.spendEpoch = this.currentEpoch;
      this.spentThisEpoch = 0n;
    }
    this.spentThisEpoch += wei;
  }

  spentThisEpochWei(): bigint {
    if (this.spendEpoch !== this.currentEpoch) return 0n;
    return this.spentThisEpoch;
  }

  status(): BotStatus {
    const ver = versionState();
    return {
      version: VERSION,
      latestVersion: ver.latest,
      updateAvailable: ver.behind,
      running: this.running,
      unlocked: this.unlocked,
      // The primary address stays the single headline identity; `wallets` carries the
      // full roster so the dashboard can show each one's balance separately.
      address: this.account?.address ?? null,
      balanceWei: this.balanceWei?.toString() ?? null,
      wallets: this.wallets.map((w) => ({
        address: w.account.address,
        label: w.label,
        balanceWei: w.balanceWei?.toString() ?? null,
      })),
      chainId: this.chainId,
      currentEpoch: this.currentEpoch?.toString() ?? null,
      gameState: this.gameState,
      citizenSupply: this.citizenSupply?.toString() ?? null,
      citizensAddress: this.citizensAddress,
      lastBlock: this.lastBlock?.toString() ?? null,
      awayNextWakeSec: this.awayNextWakeSec,
      spentThisEpochWei: this.spentThisEpochWei().toString(),
      startTime: this.startTime?.toString() ?? null,
      jitEnabled: this.strategy.jitEnabled,
      jitTargetEpoch: this.strategy.jitTargetEpoch,
      nftConfigured: ownershipIndexingAvailable(),
    };
  }

  onStatus(l: (s: BotStatus) => void): () => void {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  }

  emitStatus(): void {
    const s = this.status();
    for (const l of this.statusListeners) {
      try {
        l(s);
      } catch {
        /* ignore */
      }
    }
  }

  lock(): void {
    this.wallets = [];
    this.running = false;
    this.emitStatus();
  }
}

export const runtime = new Runtime();
