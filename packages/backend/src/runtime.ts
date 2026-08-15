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
    maxBaseFeeGwei: gasGwei.positive(),
    priorityFeeGwei: gasGwei,
    minBalanceEth: ethAmount,
    dynamicTipEnabled: z.boolean(),
    dynamicTipMaxGwei: gasGwei.positive(),
    coinbaseBidEth: ethAmount,
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
  // Payment gas — tuned to win the boundary bundle race. Measured rivals tip up to
  // ~29 gwei at the boundary (and one outlier at ~90), so a 20.1 gwei static tip
  // clears the common field with margin and the dynamic tip can escalate to 69.1 in
  // a contested block. The base-fee cap is generous (boundary blocks run near-empty
  // at <1 gwei; the cap only guards against a fee spike).
  maxBaseFeeGwei: 69.1,
  priorityFeeGwei: 20.1,
  minBalanceEth: 0.01,
  dynamicTipEnabled: true,
  dynamicTipMaxGwei: 69.1,
  coinbaseBidEth: 0, // off; flat builder payment for top-of-block, opt-in
  // No implicit third-party payer. Enabling a bid requires an explicitly configured
  // deployment whose runtime code hash is allowlisted (see .env.example).
  coinbasePayerAddress: "",
  maxPaymentEth: 0, // 0 = no cap (opt-in guardrail)
};

/**
 * Bump ONLY when the recommended defaults change (gas tuning or behaviour flags).
 *
 * A saved `data/config.json` stamped with an older value is migrated on load: the
 * RECOMMENDED_FIELDS below are refreshed to the current defaults, so a user who
 * carries their data/ folder across updates isn't silently stuck on stale settings.
 * Tied to this constant rather than VERSION so an unrelated release doesn't reset
 * anyone's tuning.
 */
export const DEFAULTS_VERSION = 6;

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
  coinbaseBidEth: 1,
  coinbasePayerAddress: 1,
  excludedTokenIds: 4,
  // These appeared while v4 was still the persisted stamp, so an old v4 file may omit
  // them even though a later v4 runtime knew about them.
  awayMode: 5,
  awayLeadMinutes: 5,
  autoDefendAudit: 5,
};

/** Known fields removed from older configs. Typos and all other unknown keys still fail. */
const LEGACY_RETIRED_FIELDS = new Set([
  "dryRun",
  "auditSafetyBufferSeconds",
  "autoUseBribe",
  "offenseBoundaryScheduling",
  // Retired in v6: the bot is defensive-only (JIT / pay / bribe). Existing configs keep
  // their payment settings; these keys are dropped on load.
  "offenseEnabled",
  "autoAudit",
  "autoKill",
  "endgameOnlyWithin",
  "offenseTargetTokenIds",
  "preBoundaryAudit",
  "preBoundaryKill",
  "combinedBoundaryBundle",
  "separateOffenseGas",
  "offenseMaxBaseFeeGwei",
  "offensePriorityFeeGwei",
  "offenseDynamicTipEnabled",
  "offenseDynamicTipMaxGwei",
  "racePublicMempool",
  "coinbaseBidAuditOnlyEth",
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
    completed[key] = DEFAULT_STRATEGY[key];
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
 * (enabled), wallet-side settings (coinbaseBidEth, coinbasePayerAddress), spend
 * guardrails (minBalanceEth, maxPaymentEth), and JIT session (jitEnabled,
 * jitTargetEpoch, jitTokenIds).
 */
const RECOMMENDED_FIELDS: (keyof StrategyConfig)[] = [
  "proactivePay", "prepayEpochs", "maxAutoPayEpochs",
  "preBoundaryPay", "preBoundaryLeadMs", "preBoundaryLeadMainnetMs",
  "maxBaseFeeGwei", "priorityFeeGwei",
  "dynamicTipEnabled", "dynamicTipMaxGwei",
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
   * payTaxes/useBribe are owner-only on-chain (verified by simulation), so
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

  /** True if `addr` is one of our unlocked wallets. */
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
      if (savedDefaults < DEFAULTS_VERSION) {
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
    // disappears on restart (especially a spend-limit change).
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
