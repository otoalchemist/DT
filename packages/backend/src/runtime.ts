import fs from "node:fs";
import path from "node:path";
import type { WalletClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { VERSION, type BotStatus, type StrategyConfig } from "@dat-bot/shared";
import { appConfig } from "./config.js";
import { logger } from "./logger.js";
import { activity } from "./activity.js";
import { ownershipIndexingAvailable } from "./index-tokens.js";

// Central mutable runtime state. Single hot wallet, single strategy config.

// Curated rival token IDs ship in git (data/rival-targets.json, unlike the
// gitignored data/config.json) so a fresh clone has offense targets without
// needing to `cp data/config.example.json data/config.json` first.
function loadDefaultRivalTargets(): string[] {
  try {
    const p = path.join(appConfig.dataDir, "rival-targets.json");
    if (fs.existsSync(p)) {
      const ids = JSON.parse(fs.readFileSync(p, "utf8"));
      if (Array.isArray(ids)) return ids.map(String);
    }
  } catch (err) {
    logger.warn("Could not load default rival targets:", (err as Error).message);
  }
  return [];
}

export const DEFAULT_STRATEGY: StrategyConfig = {
  enabled: false,
  dryRun: true,
  auditSafetyBufferSeconds: 3 * 60 * 60, // clear audits with >=3h to spare
  proactivePay: true,
  prepayEpochs: 1,
  autoUseBribe: false, // never auto-spend bribes; pay taxes to clear audits instead
  maxAutoPayEpochs: 1, // auto-payments cover at most 1 epoch (1 day) each; JIT always fires
  jitEnabled: false,
  jitTargetEpoch: null,
  jitTokenIds: [],
  preBoundaryPay: true,
  preBoundaryLeadMs: 3000,
  preBoundaryLeadMainnetMs: 5000,
  // Offense stays OFF by default (it spends ETH and is a game strategy, not a
  // profit engine) — but when a user turns it on, these are the settings that
  // actually work, so they're pre-armed rather than left for them to discover.
  offenseEnabled: false,
  autoAudit: true,
  autoKill: false, // opt-in: killing an expired-audit token is free but aggressive
  endgameOnlyWithin: null,
  offenseTargetTokenIds: loadDefaultRivalTargets(),
  preBoundaryAudit: true,
  preBoundaryKill: false, // opt-in: race kills into the first block after audit expiry
  // On by default, but self-guarding: it only fuses payment + audit into one bundle
  // when a coinbase bid is set (coinbaseBidEth > 0). Without a bid it's a no-op — the
  // bot sends separate bundles so audits keep their mempool fallback — so leaving it
  // on is safe and means a later bid "just works" without a second toggle to find.
  combinedBoundaryBundle: true,
  // Payment gas — tuned to win the boundary bundle race: a ~15 gwei tip clears
  // the observed batch-audit bundles (~3 gwei) with margin, dynamic tip scales it
  // up in contested boundary blocks, and the base-fee cap is generous (boundary
  // blocks run near-empty at <1 gwei, but the cap protects against a fee spike).
  maxBaseFeeGwei: 69.1,
  priorityFeeGwei: 15.1,
  minBalanceEth: 0.01,
  // Offense (audit/kill) bids its own gas, independent of payments — it's a race
  // against rivals where a payment isn't, so it carries a higher static tip and a
  // tighter base-fee cap.
  separateOffenseGas: true,
  offenseMaxBaseFeeGwei: 25.1,
  offensePriorityFeeGwei: 10.1,
  offenseDynamicTipEnabled: true,
  offenseDynamicTipMaxGwei: 20.1,
  racePublicMempool: true,
  dynamicTipEnabled: true,
  dynamicTipMaxGwei: 50.1,
  coinbaseBidEth: 0, // off; flat builder payment for top-of-block, opt-in
  // Shared CoinbasePayer forwarder (verified on-chain to forward 100% to
  // block.coinbase). Only used when coinbaseBidEth > 0; deploy your own if you'd
  // rather not share (see contracts/CoinbasePayer.sol).
  coinbasePayerAddress: "0xb69D1Bb4613722bdAb1aA77BA8F4409071f0a815",
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
export const DEFAULTS_VERSION = 1;

/**
 * Refreshed to DEFAULT_STRATEGY when the defaults version changes. Everything NOT
 * listed is PRESERVED from the user's saved config — their mode/run-state
 * (enabled, dryRun, offenseEnabled, endgameOnlyWithin), wallet-side settings
 * (coinbaseBidEth, coinbasePayerAddress), spend guardrails (minBalanceEth,
 * maxPaymentEth), and JIT session (jitEnabled, jitTargetEpoch, jitTokenIds).
 */
const RECOMMENDED_FIELDS: (keyof StrategyConfig)[] = [
  "auditSafetyBufferSeconds", "proactivePay", "prepayEpochs", "autoUseBribe", "maxAutoPayEpochs",
  "preBoundaryPay", "preBoundaryLeadMs", "preBoundaryLeadMainnetMs",
  "autoAudit", "autoKill", "preBoundaryAudit", "preBoundaryKill", "combinedBoundaryBundle",
  "maxBaseFeeGwei", "priorityFeeGwei",
  "separateOffenseGas", "offenseMaxBaseFeeGwei", "offensePriorityFeeGwei",
  "offenseDynamicTipEnabled", "offenseDynamicTipMaxGwei",
  "racePublicMempool", "dynamicTipEnabled", "dynamicTipMaxGwei",
  // Re-pulls the curated list shipped in data/rival-targets.json.
  "offenseTargetTokenIds",
];

class Runtime {
  account: PrivateKeyAccount | null = null;
  walletClient: WalletClient | null = null;
  strategy: StrategyConfig = { ...DEFAULT_STRATEGY };

  running = false;

  // status fields
  chainId: number | null = null;
  balanceWei: bigint | null = null;
  currentEpoch: bigint | null = null;
  gameState: number | null = null;
  citizenSupply: bigint | null = null;
  citizensAddress: string | null = null;
  lastBlock: bigint | null = null;
  startTime: bigint | null = null;

  // spend tracking
  private spentThisEpoch = 0n;
  private spendEpoch: bigint | null = null;

  private statusListeners = new Set<(s: BotStatus) => void>();

  constructor() {
    this.loadStrategy();
  }

  get unlocked(): boolean {
    return this.account !== null;
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
    return {
      version: VERSION,
      running: this.running,
      unlocked: this.unlocked,
      dryRun: this.strategy.dryRun,
      address: this.account?.address ?? null,
      balanceWei: this.balanceWei?.toString() ?? null,
      chainId: this.chainId,
      currentEpoch: this.currentEpoch?.toString() ?? null,
      gameState: this.gameState,
      citizenSupply: this.citizenSupply?.toString() ?? null,
      citizensAddress: this.citizensAddress,
      lastBlock: this.lastBlock?.toString() ?? null,
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
    this.account = null;
    this.walletClient = null;
    this.running = false;
    this.emitStatus();
  }
}

export const runtime = new Runtime();
