import fs from "node:fs";
import path from "node:path";
import type { WalletClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { z } from "zod";
import {
  VERSION,
  type BotStatus,
  type JitCampaign,
  type StrategyConfig,
  type StrategySnapshot,
} from "@dat-bot/shared";
import { appConfig, bundledDataDir, writeJsonAtomic } from "./config.js";
import { logger } from "./logger.js";
import { ownershipIndexingAvailable } from "./index-tokens.js";
import { AtomicWriteCommittedError } from "./durability.js";

// Central mutable runtime state. Single hot wallet, single strategy config.

// Curated rival token IDs ship in git (data/rival-targets.json, unlike the
// gitignored data/config.json) so a fresh clone has offense targets without
// needing to `cp data/config.example.json data/config.json` first.
function loadDefaultRivalTargets(): string[] {
  try {
    // This is a packaged, immutable default asset. Mutable instance state may
    // live under a custom DATA_DIR and must not change which targets ship.
    const p = path.join(bundledDataDir, "rival-targets.json");
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
  defenseEnabled: false,
  dryRun: true,
  auditSafetyBufferSeconds: 24 * 60 * 60, // clear a fresh 24h audit immediately
  proactivePay: true,
  prepayEpochs: 1,
  autoUseBribe: false, // never auto-spend bribes; pay taxes to clear audits instead
  maxAutoPayEpochs: 1, // auto-payments cover at most 1 epoch (1 day) each; JIT always fires
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
  preBoundaryAudit: false,
  preBoundaryKill: false,
  // Payment gas — tuned to win the boundary bundle race: a ~15 gwei tip clears
  // the observed batch-audit bundles (~3 gwei) with margin, dynamic tip scales it
  // up in contested boundary blocks, and the base-fee cap is generous (boundary
  // blocks run near-empty at <1 gwei, but the cap protects against a fee spike).
  maxBaseFeeGwei: 69.1,
  priorityFeeGwei: 15.1,
  minBalanceEth: 0.01,
  replacementPriorityFeeCapGwei: 50.1,
  // Offense (audit/kill) bids its own gas, independent of payments — it's a race
  // against rivals where a payment isn't, so it carries a higher static tip and a
  // tighter base-fee cap.
  separateOffenseGas: true,
  offenseMaxBaseFeeGwei: 25.1,
  offensePriorityFeeGwei: 10.1,
  offenseDynamicTipEnabled: true,
  offenseDynamicTipMaxGwei: 20.1,
  offenseReplacementPriorityFeeCapGwei: 20.1,
  offenseBoundaryScheduling: false,
  racePublicMempool: true,
  dynamicTipEnabled: true,
  dynamicTipMaxGwei: 50.1,
  maxPaymentEth: 0, // 0 = no cap (opt-in guardrail)
};

export const strategyConfigSchema = z.object({
  defenseEnabled: z.boolean(),
  dryRun: z.boolean(),
  auditSafetyBufferSeconds: z.number().int().min(0),
  proactivePay: z.boolean(),
  prepayEpochs: z.number().int().min(1).max(7),
  autoUseBribe: z.boolean(),
  maxAutoPayEpochs: z.number().int().min(1).max(7),
  preBoundaryPay: z.boolean(),
  preBoundaryLeadMs: z.number().int().min(250).max(8000),
  preBoundaryLeadMainnetMs: z.number().int().min(250).max(11000),
  offenseEnabled: z.boolean(),
  autoAudit: z.boolean(),
  autoKill: z.boolean(),
  endgameOnlyWithin: z.number().int().min(0).nullable(),
  offenseTargetTokenIds: z.array(z.string().regex(/^\d+$/)).transform((ids) =>
    [...new Set(ids.map((id) => BigInt(id).toString()))]
  ),
  preBoundaryAudit: z.boolean(),
  preBoundaryKill: z.boolean(),
  maxBaseFeeGwei: z.number().positive(),
  priorityFeeGwei: z.number().min(0),
  minBalanceEth: z.number().min(0),
  replacementPriorityFeeCapGwei: z.number().positive(),
  separateOffenseGas: z.boolean(),
  offenseMaxBaseFeeGwei: z.number().positive(),
  offensePriorityFeeGwei: z.number().min(0),
  offenseDynamicTipEnabled: z.boolean(),
  offenseDynamicTipMaxGwei: z.number().positive(),
  offenseReplacementPriorityFeeCapGwei: z.number().positive(),
  offenseBoundaryScheduling: z.boolean(),
  racePublicMempool: z.boolean(),
  dynamicTipEnabled: z.boolean(),
  dynamicTipMaxGwei: z.number().positive(),
  maxPaymentEth: z.number().min(0),
}).strict();

export const strategyPatchSchema = strategyConfigSchema.partial().strict();

const jitCampaignSchema = z.object({
  revision: z.number().int().min(0),
  state: z.enum(["armed", "completed", "completed-dry-run", "cancelled", "failed"]),
  targetEpoch: z.number().int().min(1).nullable(),
  tokenIds: z.array(z.string().regex(/^\d+$/)).transform((ids) =>
    [...new Set(ids.map((id) => BigInt(id).toString()))]
  ),
  autoStopOnCompletion: z.boolean(),
  message: z.string().optional(),
  completedAt: z.number().int().min(0).optional(),
}).strict();

const STRATEGY_SCHEMA_VERSION = 2 as const;
const persistedEnvelopeSchema = z.object({
  schemaVersion: z.literal(STRATEGY_SCHEMA_VERSION),
  strategy: z.object({
    revision: z.number().int().min(0),
    config: strategyConfigSchema,
  }).strict(),
  jitCampaign: jitCampaignSchema,
}).strict();

type PersistedEnvelope = z.infer<typeof persistedEnvelopeSchema>;

export class RevisionConflictError extends Error {
  constructor(public readonly currentRevision: number) {
    super(`Revision conflict; current revision is ${currentRevision}`);
    this.name = "RevisionConflictError";
  }
}

function defaultCampaign(): JitCampaign {
  return {
    revision: 0,
    state: "cancelled",
    targetEpoch: null,
    tokenIds: [],
    autoStopOnCompletion: false,
  };
}

export class Runtime {
  account: PrivateKeyAccount | null = null;
  walletClient: WalletClient | null = null;
  strategy: StrategyConfig = { ...DEFAULT_STRATEGY };
  strategyRevision = 0;
  jitCampaign: JitCampaign = defaultCampaign();

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
  private pendingExposure = 0n;
  private journalHealthy = true;
  private journalError: string | null = null;

  private statusListeners = new Set<(s: BotStatus) => void>();

  constructor(private readonly dataDir = appConfig.dataDir) {
    this.loadStrategy();
  }

  get unlocked(): boolean {
    return this.account !== null;
  }

  private configPath(): string {
    return path.join(this.dataDir, "config.json");
  }

  private envelope(
    strategy = this.strategy,
    strategyRevision = this.strategyRevision,
    jitCampaign = this.jitCampaign,
  ): PersistedEnvelope {
    return {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      strategy: { revision: strategyRevision, config: strategy },
      jitCampaign,
    };
  }

  private persist(envelope: PersistedEnvelope): void {
    writeJsonAtomic(this.configPath(), envelope);
  }

  private migrateLegacy(saved: Record<string, unknown>): PersistedEnvelope {
    const legacyDefense = typeof saved.defenseEnabled === "boolean"
      ? saved.defenseEnabled
      : typeof saved.enabled === "boolean"
        ? saved.enabled
        : DEFAULT_STRATEGY.defenseEnabled;
    const migratedBuffer = saved.auditSafetyBufferSeconds === 10_800
      ? 86_400
      : saved.auditSafetyBufferSeconds;
    const paymentPriority = typeof saved.priorityFeeGwei === "number"
      ? saved.priorityFeeGwei
      : DEFAULT_STRATEGY.priorityFeeGwei;
    const paymentDynamicMax = typeof saved.dynamicTipMaxGwei === "number"
      ? saved.dynamicTipMaxGwei
      : DEFAULT_STRATEGY.dynamicTipMaxGwei;
    const replacementPriorityFeeCapGwei = typeof saved.replacementPriorityFeeCapGwei === "number"
      ? saved.replacementPriorityFeeCapGwei
      : saved.dynamicTipEnabled === false
        ? paymentPriority
        : Math.max(paymentPriority, paymentDynamicMax);
    const offensePriority = typeof saved.offensePriorityFeeGwei === "number"
      ? saved.offensePriorityFeeGwei
      : DEFAULT_STRATEGY.offensePriorityFeeGwei;
    const offenseDynamicMax = typeof saved.offenseDynamicTipMaxGwei === "number"
      ? saved.offenseDynamicTipMaxGwei
      : DEFAULT_STRATEGY.offenseDynamicTipMaxGwei;
    const offenseReplacementPriorityFeeCapGwei = typeof saved.offenseReplacementPriorityFeeCapGwei === "number"
      ? saved.offenseReplacementPriorityFeeCapGwei
      : saved.separateOffenseGas === false
        ? replacementPriorityFeeCapGwei
        : saved.offenseDynamicTipEnabled === false
          ? offensePriority
          : Math.max(offensePriority, offenseDynamicMax);
    const merged = {
      ...DEFAULT_STRATEGY,
      ...saved,
      defenseEnabled: legacyDefense,
      // 0.2 accepted values above seven even though payTaxes/prepayEpochs could
      // never use more than seven. Preserve the prior effective behavior while
      // migrating into the stricter 0.3 schema.
      ...(typeof saved.maxAutoPayEpochs === "number"
        && Number.isInteger(saved.maxAutoPayEpochs)
        && saved.maxAutoPayEpochs >= 1
        ? { maxAutoPayEpochs: Math.min(saved.maxAutoPayEpochs, 7) }
        : {}),
      replacementPriorityFeeCapGwei,
      offenseReplacementPriorityFeeCapGwei,
      ...(migratedBuffer === undefined ? {} : { auditSafetyBufferSeconds: migratedBuffer }),
    } as Record<string, unknown>;
    delete merged.enabled;
    delete merged.jitEnabled;
    delete merged.jitTargetEpoch;
    delete merged.jitTokenIds;
    const strategy = strategyConfigSchema.parse(merged);

    const legacyIds = Array.isArray(saved.jitTokenIds)
      ? [...new Set(saved.jitTokenIds.map(String).filter((id) => /^\d+$/.test(id)).map((id) => BigInt(id).toString()))]
      : [];
    const legacyTarget = typeof saved.jitTargetEpoch === "number"
      && Number.isSafeInteger(saved.jitTargetEpoch)
      && saved.jitTargetEpoch > 0
      ? saved.jitTargetEpoch
      : null;
    // The old empty list meant "all owned". Do not silently preserve that broad
    // spending scope; only migrate an armed campaign when its IDs were explicit.
    const legacyEnabled = saved.jitEnabled === true && legacyTarget !== null && legacyIds.length > 0;
    return persistedEnvelopeSchema.parse({
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      strategy: { revision: 1, config: strategy },
      jitCampaign: {
        revision: legacyEnabled || saved.jitEnabled === true ? 1 : 0,
        state: legacyEnabled ? "armed" : "cancelled",
        targetEpoch: legacyEnabled ? legacyTarget : null,
        tokenIds: legacyEnabled ? legacyIds : [],
        // The legacy format did not record whether JIT had started the engine,
        // so never infer authority to stop an operator-run process.
        autoStopOnCompletion: false,
      },
    });
  }

  loadStrategy(): void {
    const p = this.configPath();
    if (!fs.existsSync(p)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
      const rawRecord = z.record(z.unknown()).parse(raw);
      if (rawRecord.schemaVersion !== undefined && rawRecord.schemaVersion !== STRATEGY_SCHEMA_VERSION) {
        throw new Error(`Unsupported strategy schemaVersion ${String(rawRecord.schemaVersion)}`);
      }
      const current = persistedEnvelopeSchema.safeParse(raw);
      if (rawRecord.schemaVersion === STRATEGY_SCHEMA_VERSION && !current.success) {
        throw new Error(`Invalid strategy envelope: ${current.error.message}`);
      }
      const envelope = current.success ? current.data : this.migrateLegacy(rawRecord);
      this.strategy = envelope.strategy.config;
      this.strategyRevision = envelope.strategy.revision;
      this.jitCampaign = envelope.jitCampaign;
      if (!current.success) this.persist(envelope);
    } catch (err) {
      throw new Error(`Could not load strategy config: ${(err as Error).message}`);
    }
  }

  strategySnapshot(): StrategySnapshot {
    return { revision: this.strategyRevision, config: { ...this.strategy } };
  }

  saveStrategy(next: Partial<StrategyConfig>, expectedRevision = this.strategyRevision): StrategySnapshot {
    if (expectedRevision !== this.strategyRevision) throw new RevisionConflictError(this.strategyRevision);
    const strategy = strategyConfigSchema.parse({ ...this.strategy, ...next });
    const revision = this.strategyRevision + 1;
    let committedError: AtomicWriteCommittedError | null = null;
    try {
      this.persist(this.envelope(strategy, revision));
    } catch (error) {
      if (!(error instanceof AtomicWriteCommittedError)) throw error;
      committedError = error;
    }
    this.strategy = strategy;
    this.strategyRevision = revision;
    this.emitStatus();
    if (committedError) throw committedError;
    return this.strategySnapshot();
  }

  saveJitCampaign(
    patch: Partial<Omit<JitCampaign, "revision">>,
    expectedRevision = this.jitCampaign.revision,
  ): JitCampaign {
    if (expectedRevision !== this.jitCampaign.revision) {
      throw new RevisionConflictError(this.jitCampaign.revision);
    }
    const candidate = jitCampaignSchema.parse({
      ...this.jitCampaign,
      ...patch,
      revision: this.jitCampaign.revision + 1,
    });
    if (candidate.state === "armed" && (candidate.targetEpoch === null || candidate.tokenIds.length === 0)) {
      throw new Error("An active JIT campaign requires a target epoch and explicit token IDs");
    }
    const normalized: JitCampaign = candidate.state === "armed"
      ? { ...candidate, tokenIds: [...new Set(candidate.tokenIds.map((id) => BigInt(id).toString()))] }
      : candidate;
    let committedError: AtomicWriteCommittedError | null = null;
    try {
      this.persist(this.envelope(this.strategy, this.strategyRevision, normalized));
    } catch (error) {
      if (!(error instanceof AtomicWriteCommittedError)) throw error;
      committedError = error;
    }
    this.jitCampaign = normalized;
    this.emitStatus();
    if (committedError) throw committedError;
    return { ...normalized, tokenIds: [...normalized.tokenIds] };
  }

  /** Track spend for the current epoch; resets automatically on epoch change. */
  recordSpend(wei: bigint): void {
    this.recordConfirmedSpend(wei);
  }

  recordConfirmedSpend(wei: bigint): void {
    if (this.spendEpoch !== this.currentEpoch) {
      this.spendEpoch = this.currentEpoch;
      this.spentThisEpoch = 0n;
    }
    this.spentThisEpoch += wei;
    this.emitStatus();
  }

  setPendingExposure(wei: bigint): void {
    this.pendingExposure = wei < 0n ? 0n : wei;
    this.emitStatus();
  }

  setJournalHealth(healthy: boolean, error: string | null = null): void {
    this.journalHealthy = healthy;
    this.journalError = healthy ? null : error;
    this.emitStatus();
  }

  resetWalletAccounting(): void {
    this.balanceWei = null;
    this.spentThisEpoch = 0n;
    this.spendEpoch = null;
    this.pendingExposure = 0n;
    this.emitStatus();
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
      confirmedSpendThisEpochWei: this.spentThisEpochWei().toString(),
      pendingExposureWei: this.pendingExposure.toString(),
      journalHealthy: this.journalHealthy,
      journalError: this.journalError,
      startTime: this.startTime?.toString() ?? null,
      jitEnabled: this.jitCampaign.state === "armed",
      jitState: this.jitCampaign.state,
      jitTargetEpoch: this.jitCampaign.targetEpoch,
      jitRevision: this.jitCampaign.revision,
      jitTokenIds: [...this.jitCampaign.tokenIds],
      jitMessage: this.jitCampaign.message ?? null,
      jitCompletedAt: this.jitCampaign.completedAt ?? null,
      strategyRevision: this.strategyRevision,
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
    this.balanceWei = null;
    this.spentThisEpoch = 0n;
    this.spendEpoch = null;
    this.pendingExposure = 0n;
    this.emitStatus();
  }
}

export const runtime = new Runtime();
