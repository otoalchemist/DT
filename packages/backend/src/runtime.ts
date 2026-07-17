import fs from "node:fs";
import path from "node:path";
import type { WalletClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { BotStatus, StrategyConfig } from "@dat-bot/shared";
import { appConfig } from "./config.js";
import { logger } from "./logger.js";
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
  autoKill: true,
  endgameOnlyWithin: null,
  offenseTargetTokenIds: loadDefaultRivalTargets(),
  preBoundaryAudit: true,
  preBoundaryKill: true,
  maxBaseFeeGwei: 30,
  priorityFeeGwei: 2,
  minBalanceEth: 0.01,
  // Offense gas defaults mirror the base settings; they only take effect once
  // separateOffenseGas is turned on, so a fresh/upgraded config behaves exactly
  // as before until the user opts in.
  separateOffenseGas: false,
  offenseMaxBaseFeeGwei: 30,
  offensePriorityFeeGwei: 2,
  offenseDynamicTipEnabled: false,
  offenseDynamicTipMaxGwei: 50,
  offenseBoundaryScheduling: false,
  racePublicMempool: true,
  dynamicTipEnabled: false,
  dynamicTipMaxGwei: 50,
  maxPaymentEth: 0, // 0 = no cap (opt-in guardrail)
};

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
      if (fs.existsSync(p)) {
        const saved = JSON.parse(fs.readFileSync(p, "utf8"));
        this.strategy = { ...DEFAULT_STRATEGY, ...saved };
      }
    } catch (err) {
      logger.warn("Could not load strategy config:", (err as Error).message);
    }
  }

  saveStrategy(next: Partial<StrategyConfig>): StrategyConfig {
    this.strategy = { ...this.strategy, ...next };
    try {
      fs.mkdirSync(appConfig.dataDir, { recursive: true });
      fs.writeFileSync(this.configPath(), JSON.stringify(this.strategy, null, 2));
    } catch (err) {
      logger.warn("Could not save strategy config:", (err as Error).message);
    }
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
