import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { PrivateKeyAccount } from "viem/accounts";
import { VERSION, type BotStatus, type StrategyConfig } from "@dat-bot/shared";
import { appConfig } from "./config.js";
import { logger } from "./logger.js";
import { activity } from "./activity.js";
import { ownershipIndexingAvailable } from "./index-tokens.js";
import { tightenPrivateFile, writePrivateFileAtomic } from "./private-file.js";

// Central mutable runtime state. Single hot wallet, single strategy config.

/**
 * Parsed-list cache, keyed by file and invalidated on mtime+size.
 *
 * These four files are read on the HOT PATH: fetchOffenseCandidates reads the ally and
 * do-not-target lists on every offense sweep (once per block with a WebSocket), and
 * readTargets reads them again on every dashboard poll — each read a synchronous
 * readFileSync + JSON.parse (measured at 0.19 ms for the pair). They only change when the
 * user edits one by hand or installs a release containing updated files.
 *
 * Keyed on mtimeMs + size rather than a TTL so a hand edit is picked up on the very next
 * read, with no staleness window — the whole point of the files being
 * user-editable. `statSync` is ~an order of magnitude cheaper than reading and parsing.
 *
 * Deliberately NOT keyed on content hash: hashing means reading the file, which is the
 * cost being avoided.
 */
const fileCache = new Map<string, { key: string; value: unknown }>();

export type AllyTokenLoadResult =
  | { ok: true; tokenIds: string[] }
  | { ok: false; error: string };

/** Derived ally-list parse, tied to readJsonCached's object identity. */
let allyMemo: { src: unknown; out: AllyTokenLoadResult } | null = null;
let lastAllyRosterError: string | null = null;
let lastDoNotTargetError: string | null = null;

/**
 * Read and parse a JSON file, reusing the last parse while the file is unchanged.
 * Returns null when metadata cannot be read. Individual callers decide whether absence
 * is advisory or a hard failure; notably the ally offense roster must fail closed.
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
  allyMemo = null;
  dntMemo = null;
  lastAllyRosterError = null;
  lastDoNotTargetError = null;
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
export function loadAllyTokensResult(): AllyTokenLoadResult {
  let raw: unknown;
  try {
    raw = readJsonCached("ally-tokens.json");
  } catch (err) {
    return { ok: false, error: `could not read or parse file: ${(err as Error).message}` };
  }
  if (raw === null) {
    return { ok: false, error: "file is missing or unreadable" };
  }
  const memo = allyMemo;
  if (memo !== null && memo.src === raw) return memo.out;

  const parsed = tokenIds.safeParse(raw);
  const out: AllyTokenLoadResult = parsed.success
    ? { ok: true, tokenIds: parsed.data }
    : { ok: false, error: `invalid token list: ${parsed.error.issues[0]?.message ?? "validation failed"}` };
  allyMemo = { src: raw, out };
  return out;
}

function reportAllyRosterFailure(error: string): void {
  if (lastAllyRosterError === error) return;
  lastAllyRosterError = error;
  logger.error(`Ally safety roster unavailable; automated offense is blocked: ${error}`);
}

/**
 * Dashboard-safe ally read. A roster failure is reported loudly but represented as an
 * empty list so status endpoints remain available. Automated offense must use the strict
 * variant below: an empty fallback is unsafe there because it removes the hard block.
 */
export function loadAllyTokens(): string[] {
  const result = loadAllyTokensResult();
  if (!result.ok) {
    reportAllyRosterFailure(result.error);
    return [];
  }
  lastAllyRosterError = null;
  return result.tokenIds;
}

/** Hard-safety read for the shared offense chokepoint. Never converts failure to []. */
export function loadAllyTokensStrict(): string[] {
  const result = loadAllyTokensResult();
  if (!result.ok) {
    reportAllyRosterFailure(result.error);
    throw new Error(`Ally safety roster unavailable; refusing automated offense: ${result.error}`);
  }
  lastAllyRosterError = null;
  return result.tokenIds;
}

/**
 * "Do not target" (data/do-not-target.json) — rival citizens we deliberately never audit,
 * grouped by the operator who runs them.
 *
 * These are still RIVALS (unlike allies): they're just not worth attacking. An operator
 * with deep reserves and a standing builder relationship cures at the top of the boundary
 * block regardless of how delinquent it looks, so an audit aimed at one burns a scarce
 * auditor slot on a race that cannot be won. The list is curated rather than derived —
 * the evidence heuristic in the target analysis catches only the ones that have already
 * demonstrated top-of-block cures, which is a strict subset.
 *
 * Returns the flat id list plus the owner grouping, so the UI can tag each id with who
 * runs it.
 */
export function loadDoNotTarget(): { tokenIds: string[]; owners: Record<string, string[]> } {
  try {
    const raw = readJsonCached("do-not-target.json") as { owners?: Record<string, unknown> } | null;
    if (!raw) {
      reportDoNotTargetFailure("file is missing or unreadable");
      return { tokenIds: [], owners: {} };
    }
    // Memoize the DERIVED shape against the same parsed object, not just the parse: the
    // normalize + dedupe below runs on every offense sweep and every dashboard poll, and
    // its input only changes when the file does. Identity holds because readJsonCached
    // returns the cached parse by reference.
    const memo = dntMemo;
    if (memo && memo.src === raw) return memo.out;
    const owners: Record<string, string[]> = {};
    for (const [name, ids] of Object.entries(raw.owners ?? {})) {
      if (!Array.isArray(ids)) continue;
      owners[name] = ids.map(String).filter((id) => /^\d+$/.test(id));
    }
    // De-duplicated across owners: a token listed twice must not be counted twice.
    const tokenIds = [...new Set(Object.values(owners).flat())];
    const out = { tokenIds, owners };
    dntMemo = { src: raw, out };
    lastDoNotTargetError = null;
    return out;
  } catch (err) {
    reportDoNotTargetFailure((err as Error).message);
    return { tokenIds: [], owners: {} };
  }
}

function reportDoNotTargetFailure(error: string): void {
  if (lastDoNotTargetError === error) return;
  lastDoNotTargetError = error;
  logger.warn(`Could not load advisory do-not-target roster; continuing without it: ${error}`);
}

/** Memo for loadDoNotTarget's derived output, tied to the identity of the parsed file. */
let dntMemo: {
  src: object;
  out: { tokenIds: string[]; owners: Record<string, string[]> };
} | null = null;

/** Flat lookup of tokenId -> operator name, for tagging rows in the UI. */
export function doNotTargetOwnerOf(): Record<string, string> {
  const { owners } = loadDoNotTarget();
  const map: Record<string, string> = {};
  for (const [name, ids] of Object.entries(owners)) for (const id of ids) map[id] = name;
  return map;
}

const UINT256_MAX = (1n << 256n) - 1n;
const tokenId = z
  .string()
  .trim()
  .regex(/^(0|[1-9]\d*)$/, "must be a canonical decimal token ID")
  .refine((id) => BigInt(id) <= UINT256_MAX, "token ID exceeds uint256")
  .transform((id) => BigInt(id).toString());
const tokenIds = z
  .array(tokenId)
  .max(10_000, "too many token IDs")
  .transform((ids) => [...new Set(ids)]);
const safeEpoch = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ethAmount = z.number().finite().nonnegative().max(1_000_000);
const gasGwei = z.number().finite().nonnegative().max(1_000_000);

/**
 * Authoritative strategy validation for both persisted configuration and API writes.
 * Unknown fields are rejected, token IDs are bounded/canonicalized/de-duplicated, and
 * every numeric control has a finite range before it can influence transaction values.
 */
export const strategyConfigSchema = z
  .object({
    enabled: z.boolean(),
    autoDefendAudit: z.boolean(),
    proactivePay: z.boolean(),
    prepayEpochs: z.number().int().min(1).max(7),
    maxAutoPayEpochs: z.number().int().min(1).max(7),
    jitEnabled: z.boolean(),
    jitTargetEpoch: safeEpoch.min(1).nullable(),
    jitTokenIds: tokenIds,
    excludedTokenIds: tokenIds,
    preBoundaryPay: z.boolean(),
    preBoundaryLeadMs: z.number().int().min(250).max(8_000),
    preBoundaryLeadMainnetMs: z.number().int().min(250).max(11_000),
    awayMode: z.boolean(),
    awayLeadMinutes: z.number().int().min(1).max(720),
    offenseEnabled: z.boolean(),
    autoAudit: z.boolean(),
    autoKill: z.boolean(),
    endgameOnlyWithin: safeEpoch.max(1_000_000).nullable(),
    offenseTargetTokenIds: tokenIds,
    preBoundaryAudit: z.boolean(),
    preBoundaryKill: z.boolean(),
    combinedBoundaryBundle: z.boolean(),
    maxBaseFeeGwei: gasGwei.positive(),
    priorityFeeGwei: gasGwei,
    minBalanceEth: ethAmount,
    separateOffenseGas: z.boolean(),
    offenseMaxBaseFeeGwei: gasGwei.positive(),
    offensePriorityFeeGwei: gasGwei,
    offenseDynamicTipEnabled: z.boolean(),
    offenseDynamicTipMaxGwei: gasGwei.positive(),
    racePublicMempool: z.boolean(),
    dynamicTipEnabled: z.boolean(),
    dynamicTipMaxGwei: gasGwei.positive(),
    coinbaseBidEth: ethAmount,
    coinbaseBidAuditOnlyEth: ethAmount,
    coinbasePayerAddress: z.union([
      z.literal(""),
      z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x address or empty"),
    ]),
    maxPaymentEth: ethAmount,
  })
  .strict();

export const strategyPatchSchema = strategyConfigSchema.partial().strict();

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
  // Spending against rivals is opt-in. The curated list and supporting settings are
  // pre-populated, but a fresh install cannot audit merely because the engine starts.
  offenseEnabled: false,
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
  // Payment gas — tuned to win the boundary bundle race. Measured rivals tip up to
  // ~29 gwei at the boundary (and one outlier at ~90), so a 20.1 gwei static tip
  // clears the common field with margin and the dynamic tip can escalate to 69.1 in
  // a contested block. The base-fee cap is generous (boundary blocks run near-empty
  // at <1 gwei; the cap only guards against a fee spike).
  maxBaseFeeGwei: 69.1,
  priorityFeeGwei: 20.1,
  minBalanceEth: 0.01,
  // Offense (audit/kill) bids its own gas, independent of payments — it's a race
  // against rivals where a payment isn't. Matched to the payment ceilings so an
  // audit isn't the weak link at a contested boundary.
  separateOffenseGas: true,
  offenseMaxBaseFeeGwei: 69.1,
  offensePriorityFeeGwei: 20.1,
  offenseDynamicTipEnabled: true,
  offenseDynamicTipMaxGwei: 69.1,
  racePublicMempool: true,
  dynamicTipEnabled: true,
  dynamicTipMaxGwei: 69.1,
  coinbaseBidEth: 0, // off; flat builder payment for top-of-block, opt-in
  // Audit-only boundaries bid separately: that bundle is smaller and losing it costs only
  // the audit fee, so it rarely warrants what a must-land payment bundle does.
  coinbaseBidAuditOnlyEth: 0,
  // No implicit third-party payer. Enabling a bid requires an explicitly configured
  // deployment whose runtime code hash is allowlisted (see .env.example).
  coinbasePayerAddress: "",
  maxPaymentEth: 0, // 0 = no cap (opt-in guardrail)
};

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
export const DEFAULTS_VERSION = 5;

/**
 * The first persisted-defaults version whose complete schema included each field.
 * A config stamped with an earlier version may omit ONLY these explicitly enumerated
 * additions. Every field not listed here existed in the original persisted schema and
 * remains required, including the spend caps and minimum-balance floor.
 *
 * Some fields landed while v4 was current. They are assigned to v5 here so an authentic
 * v4 file written before those additions has a deterministic upgrade path; once stamped
 * v5, the full current schema is mandatory.
 */
const LEGACY_FIELD_INTRODUCED_BY_VERSION: Partial<Record<keyof StrategyConfig, number>> = {
  maxAutoPayEpochs: 1,
  preBoundaryPay: 1,
  preBoundaryLeadMs: 1,
  preBoundaryLeadMainnetMs: 1,
  preBoundaryAudit: 1,
  preBoundaryKill: 1,
  combinedBoundaryBundle: 1,
  separateOffenseGas: 1,
  offenseMaxBaseFeeGwei: 1,
  offensePriorityFeeGwei: 1,
  offenseDynamicTipEnabled: 1,
  offenseDynamicTipMaxGwei: 1,
  coinbaseBidEth: 1,
  coinbasePayerAddress: 1,
  excludedTokenIds: 4,
  // These appeared while v4 was still the persisted stamp, so an old v4 file may omit
  // them even though a later v4 runtime knew about them.
  awayMode: 5,
  awayLeadMinutes: 5,
  autoDefendAudit: 5,
  coinbaseBidAuditOnlyEth: 5,
};

/** Known fields removed from pre-v4 configs. Typos and all other unknown keys still fail. */
const LEGACY_RETIRED_FIELDS = new Set([
  "dryRun",
  "auditSafetyBufferSeconds",
  "autoUseBribe",
  "offenseBoundaryScheduling",
]);

function completeLegacyStrategyConfig(
  raw: Record<string, unknown>,
  fromVersion: number,
): StrategyConfig {
  const completed: Record<string, unknown> = {};
  const added: string[] = [];
  for (const key of Object.keys(DEFAULT_STRATEGY) as (keyof StrategyConfig)[]) {
    if (key in raw) {
      completed[key] = raw[key];
      continue;
    }
    const introducedBy = LEGACY_FIELD_INTRODUCED_BY_VERSION[key];
    if (introducedBy === undefined || fromVersion >= introducedBy) {
      throw new Error(`missing required strategy config field: ${key}`);
    }
    // Before the bid was split, the one configured value applied to both bundle shapes.
    // Preserve that historical behavior instead of silently dropping audit-only bids.
    if (
      key === "coinbaseBidAuditOnlyEth" &&
      typeof raw.coinbaseBidEth === "number" &&
      raw.coinbaseBidEth > 0
    ) {
      completed[key] = raw.coinbaseBidEth;
    } else {
      completed[key] = DEFAULT_STRATEGY[key];
    }
    added.push(key);
  }
  const parsed = strategyConfigSchema.parse(completed) as StrategyConfig;
  if (added.length > 0) {
    logger.info(
      `Config schema migration from defaults v${fromVersion}: added ${added.join(", ")}`,
    );
  }
  return parsed;
}

/**
 * Refreshed to DEFAULT_STRATEGY when the defaults version changes. Everything NOT
 * listed is PRESERVED from the user's saved config — their mode/run-state
 * (enabled, endgameOnlyWithin), wallet-side settings
 * (coinbaseBidEth, coinbasePayerAddress), spend guardrails (minBalanceEth,
 * maxPaymentEth), and JIT session (jitEnabled, jitTargetEpoch, jitTokenIds).
 */
const RECOMMENDED_FIELDS: (keyof StrategyConfig)[] = [
  // Security migration: offense is now opt-in on fresh and existing installs. Users who
  // want it can explicitly re-enable after reviewing the curated target list.
  "offenseEnabled",
  "proactivePay", "prepayEpochs", "maxAutoPayEpochs",
  "preBoundaryPay", "preBoundaryLeadMs", "preBoundaryLeadMainnetMs",
  "autoAudit", "autoKill", "preBoundaryAudit", "preBoundaryKill", "combinedBoundaryBundle",
  "maxBaseFeeGwei", "priorityFeeGwei",
  "separateOffenseGas", "offenseMaxBaseFeeGwei", "offensePriorityFeeGwei",
  "offenseDynamicTipEnabled", "offenseDynamicTipMaxGwei",
  "racePublicMempool", "dynamicTipEnabled", "dynamicTipMaxGwei",
  // Re-applies the curated skippers list shipped in data/rival-skippers.json.
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
      tightenPrivateFile(p);
      const raw: unknown = JSON.parse(fs.readFileSync(p, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("strategy config must be a JSON object");
      }
      const rawConfig = raw as Record<string, unknown>;
      // Meta key, not part of StrategyConfig. Absent => pre-versioning config (0).
      const savedDefaults = rawConfig.defaultsVersion === undefined
        ? 0
        : z.number().int().nonnegative().parse(rawConfig.defaultsVersion);
      if (savedDefaults > DEFAULTS_VERSION) {
        throw new Error(
          `config defaults version ${savedDefaults} is newer than supported version ${DEFAULTS_VERSION}`,
        );
      }

      const allowedKeys = new Set([...Object.keys(DEFAULT_STRATEGY), "defaultsVersion"]);
      if (savedDefaults < 4) {
        for (const key of LEGACY_RETIRED_FIELDS) allowedKeys.add(key);
      }
      const unknownKeys = Object.keys(rawConfig).filter((key) => !allowedKeys.has(key));
      if (unknownKeys.length > 0) {
        throw new Error(`unknown strategy config field(s): ${unknownKeys.join(", ")}`);
      }
      // A file already stamped with the current version must be a complete current
      // config. Never fill a missing guardrail from DEFAULT_STRATEGY: several defaults
      // (notably maxPaymentEth=0) are intentionally permissive and are unsafe fallbacks.
      if (savedDefaults === DEFAULTS_VERSION) {
        const persisted = Object.fromEntries(
          Object.entries(rawConfig).filter(([key]) => key !== "defaultsVersion"),
        );
        this.strategy = strategyConfigSchema.parse(persisted) as StrategyConfig;
      } else {
        // Legacy completion is deliberately narrow: only fields known to have been
        // introduced after the file's stamp may be supplied by an explicit migration.
        this.strategy = completeLegacyStrategyConfig(rawConfig, savedDefaults);
      }
      if (savedDefaults < DEFAULTS_VERSION) {
        this.strategy = this.applyRecommendedDefaults(this.strategy, savedDefaults);
        this.writeConfig(); // persist the migration + new stamp so it runs once
      }
    } catch (err) {
      logger.warn("Could not load strategy config:", (err as Error).message);
      // A malformed or misspelled guardrail must never fall back to permissive
      // defaults (for example maxPaymentEth=0 means "no cap"). Refuse startup so the
      // operator has to correct or remove the invalid file before any key is unlocked.
      throw new Error("Invalid strategy configuration; refusing to start");
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
    // Retire only the exact historical shared payer. Preserve every operator-supplied
    // address; all payer deployments are separately code-hash checked before a bid.
    const retiredSharedPayer = "0xb69d1bb4613722bdab1aa77ba8f4409071f0a815";
    if (out.coinbasePayerAddress.toLowerCase() === retiredSharedPayer) {
      out.coinbasePayerAddress = "";
      changed.push("coinbasePayerAddress (retired shared deployment)");
    }
    const detail = changed.length ? `refreshed: ${changed.join(", ")}` : "already current";
    const msg =
      `Config updated to recommended defaults v${DEFAULTS_VERSION} (was v${fromVersion}) — ${detail}. ` +
      `Kept your run mode, operator-supplied payer, coinbase bid, spend caps and JIT selection.`;
    logger.info(msg);
    activity.add({ kind: "info", status: "info", message: msg });
    return out;
  }

  /** Write config.json, stamping the defaults version it was written against. */
  private writeConfig(strategy: StrategyConfig = this.strategy): void {
    writePrivateFileAtomic(
      this.configPath(),
      JSON.stringify({ ...strategy, defaultsVersion: DEFAULTS_VERSION }, null, 2),
    );
  }

  saveStrategy(next: Partial<StrategyConfig>): StrategyConfig {
    const validated = strategyConfigSchema.parse({ ...this.strategy, ...next }) as StrategyConfig;
    // Persist first so a disk/permission failure cannot activate a strategy that silently
    // disappears on restart (especially an offense or spend-limit change).
    this.writeConfig(validated);
    this.strategy = validated;
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
    return {
      version: VERSION,
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
