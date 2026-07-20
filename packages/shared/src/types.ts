// Types shared between backend and web. Wire format uses strings for bigints.

/** Risk classification for an owned token. */
export type TokenRisk = "safe" | "delinquent" | "audited" | "at-risk" | "dead";

/** Status of a Citizen token the wallet owns. */
export interface OwnedTokenStatus {
  tokenId: string;
  lastEpochPaid: string;
  currentEpoch: string;
  /** 0 if not under audit; otherwise the unix timestamp after which it can be killed. */
  auditDueTimestamp: string;
  /** Seconds until the active audit expires (kill becomes possible). Null if not audited. */
  secondsUntilKillable: number | null;
  bribeBalance: string;
  hasLifeInsurance: boolean;
  risk: TokenRisk;
  /** Estimated wei to pay to become current / clear an audit (1 epoch). */
  estimatedPayWei: string;
}

/** A token owned by someone else that the bot could audit or kill. */
export interface TargetTokenStatus {
  tokenId: string;
  owner: string;
  lastEpochPaid: string;
  /** True if at least 1 epoch behind (includes auditable). */
  delinquent: boolean;
  /** How many epochs behind the current epoch. */
  epochsBehind: number;
  /** True if delinquent enough to be audited right now (2+ epochs behind). */
  auditable: boolean;
  /** 0 if not under audit; else unix ts after which kill() succeeds. */
  auditDueTimestamp: string;
  /** True if under audit and already expired -> kill() will succeed now. */
  killable: boolean;
}

export type ActivityKind =
  | "pay-taxes"
  | "use-bribe"
  | "audit"
  | "kill"
  | "builder-incentive"
  | "info"
  | "error";

export type ActivityStatus =
  | "planned"
  | "prepared"
  | "simulated"
  | "submitted"
  | "delivery-uncertain"
  | "rejected"
  | "included"
  | "reverted"
  | "skipped"
  | "dry-run"
  | "info";

export interface ActivityEntry {
  id: string;
  ts: number;
  kind: ActivityKind;
  status: ActivityStatus;
  tokenId?: string;
  targetTokenId?: string;
  txHash?: string;
  bundleHash?: string;
  targetBlock?: string;
  valueWei?: string;
  gasWei?: string;
  message: string;
}

export interface StrategyConfig {
  /** Enables continuous audit defense and proactive tax payments. JIT and offense
   *  are independently controlled and do not inherit this setting. */
  defenseEnabled: boolean;
  /** Simulate/plan only; never actually send. Defaults true on first run. */
  dryRun: boolean;

  // --- Defense ---
  /** Clear an audit when it will expire within this many seconds. */
  auditSafetyBufferSeconds: number;
  /** Proactively pay before becoming delinquent (don't wait to be audited). */
  proactivePay: boolean;
  /** Epochs to prepay per payTaxes call (1-7) to lock the current rate. */
  prepayEpochs: number;
  /** Spend a held bribe to clear an audit (free, but consumes the bribe and leaves
   *  the token still delinquent). OFF by default — the bot pays taxes to clear
   *  instead, so bribes are never auto-consumed unless you opt in. */
  autoUseBribe: boolean;
  /** Global cap on how many epochs a single AUTOMATIC payment may cover. On-chain,
   *  payTaxes(tokenId, n) costs n * currentEpoch * base and advances the token n
   *  epochs — so this caps the ETH spent per auto payment. Applies to proactive-pay
   *  and defense (which would otherwise pay `prepayEpochs`); JIT and the pre-boundary
   *  race always pay exactly one epoch and are never blocked, so the single-epoch
   *  payment for the upcoming epoch still fires even when a citizen is momentarily
   *  2 behind. Default 1 = auto-payments never spend more than one day's taxes at
   *  once; a lost/failed payment never balloons into a multi-day charge. Raise it to
   *  let proactive-pay / defense auto-catch-up multiple epochs in one payment. */
  maxAutoPayEpochs: number;

  // --- Boundary payment scheduling ---
  /** ADVANCED: pre-submit needed proactive-defense payments, plus any armed JIT
   *  payment, ~preBoundaryLeadMs before the target epoch boundary. The value is
   *  computed off-chain for the upcoming epoch and validated by simulating at the
   *  boundary timestamp. A normal on-chain-estimate tick remains the fallback. */
  preBoundaryPay: boolean;
  /** How many ms before the target boundary to build and simulate the transaction
   *  in public/local mode (250–8000). Broadcast waits for the boundary timestamp.
   *  Optional audit/kill preparation has a 2000ms effective safety floor. */
  preBoundaryLeadMs: number;
  /** Lead used in `mainnet` (bundle) mode (250–11000). The bundle carries a
   *  boundary minTimestamp and its public fallback waits for that timestamp.
   *  Combined/audit/kill preparation has a 2000ms effective safety floor. Keep
   *  the configured lead under one 12s slot. */
  preBoundaryLeadMainnetMs: number;

  // --- Offense (optional) ---
  offenseEnabled: boolean;
  /** Automatically audit delinquent rival tokens. */
  autoAudit: boolean;
  /** Automatically kill tokens whose audit has expired. */
  autoKill: boolean;
  /** Only run offense once citizen supply is within this many of WINNERS. */
  endgameOnlyWithin: number | null;
  /** Specific rival token IDs to target. Empty array = target any delinquent rival. */
  offenseTargetTokenIds: string[];
  /** ADVANCED: pre-submit audits before the epoch boundary using the configured
   *  lead with a 2000ms effective minimum, so
   *  they land in the FIRST block of the epoch (auditing rivals the instant they
   *  become delinquent, like a batch-auditor) instead of the block after. The
   *  future-timestamp semantic simulation must succeed before submission. */
  preBoundaryAudit: boolean;
  /** ADVANCED: pre-submit kills before a target's audit-expiry using the configured
   *  lead with a 2000ms effective minimum,
   *  so the kill lands in the first eligible block. The future-timestamp semantic
   *  simulation must succeed before submission. */
  preBoundaryKill: boolean;
  /** ADVANCED: allow an explicitly prepared boundary payment and audit cohort to
   *  share one private bundle. This is separately opt-in because sharing changes
   *  audit fallback behavior; it never guarantees inclusion or block position. */
  combinedBoundaryBundle: boolean;

  // --- Guardrails ---
  /** Max base fee (gwei) the bot will transact at. Applies to tax payments
   *  (defense) and, unless `separateOffenseGas` is on, to audit/kill too. */
  maxBaseFeeGwei: number;
  /** Priority fee (gwei) to include on bundles. Applies to tax payments
   *  (defense) and, unless `separateOffenseGas` is on, to audit/kill too. */
  priorityFeeGwei: number;
  /** Never spend below this wallet balance (ether). */
  minBalanceEth: number;
  /** Absolute priority-fee ceiling for same-nonce payment replacements. */
  replacementPriorityFeeCapGwei: number;

  // --- Offense gas override (audit / kill) ---
  /** When true, audit/kill use the `offense*` gas fields below instead of the
   *  shared `maxBaseFeeGwei`/`priorityFeeGwei`/`dynamicTip*` settings. Lets you
   *  bid more aggressively to win offense races without overpaying on the
   *  (non-competitive) tax payments. When false, audit/kill inherit the base
   *  settings — identical to the pre-split behavior. */
  separateOffenseGas: boolean;
  /** Max base fee (gwei) for audit/kill. Used only when separateOffenseGas. */
  offenseMaxBaseFeeGwei: number;
  /** Priority fee (gwei) for audit/kill. Used only when separateOffenseGas. */
  offensePriorityFeeGwei: number;
  /** Dynamic-tip toggle for audit/kill. Used only when separateOffenseGas. */
  offenseDynamicTipEnabled: boolean;
  /** Dynamic-tip ceiling (gwei) for audit/kill. Used only when separateOffenseGas. */
  offenseDynamicTipMaxGwei: number;
  /** Absolute priority-fee ceiling for same-nonce offense replacements. */
  offenseReplacementPriorityFeeCapGwei: number;

  // --- Latency (mainnet mode only) ---
  /** Also broadcast time-critical offense txs to the public mempool alongside
   *  the Flashbots bundle, so any builder can include them in the next block.
   *  Trades bundle privacy for lower inclusion latency. Defense/JIT overrides
   *  this to true so a private offense nonce cannot fence a survival payment. */
  racePublicMempool: boolean;
  /** Scale the priority-fee tip up as the latest block fills, so we stay
   *  competitive for inclusion in contested blocks. When off, the static
   *  priorityFeeGwei is always used. */
  dynamicTipEnabled: boolean;
  /** Upper bound (gwei) the dynamic tip may scale to at a 100%-full block.
   *  Ignored when dynamicTipEnabled is false. */
  dynamicTipMaxGwei: number;
  /** Explicit authority for a private, trailing payment to the winning block's
   *  fee recipient. Inert unless the amount, chain, journal, and payer bytecode
   *  all pass backend validation. */
  coinbaseBidEnabled: boolean;
  /** Exact ETH amount for at most one direct builder-incentive transaction in an
   *  eligible cohort. Canonical base-10 string with at most 18 decimal places. */
  coinbaseBidEth: string;
  /** Deployed address of the approved stateless CoinbasePayer runtime. Empty when
   *  unconfigured; an address alone never enables the feature. */
  coinbasePayerAddress: string;

  /** Hard cap (ETH) on the value of any single transaction (payments in
   *  particular). A tx whose value exceeds this is skipped, not sent — a
   *  backstop against a bad estimate or many-epoch debt draining the wallet.
   *  0 disables the cap. */
  maxPaymentEth: number;
}

/** Independently revisioned, one-shot JIT campaign. Token IDs are always explicit
 * so arming a subset can never broaden into payments for every owned Citizen. */
export type JitCampaignState =
  | "armed"
  | "completed"
  | "completed-dry-run"
  | "cancelled"
  | "failed";

export interface JitCampaign {
  revision: number;
  state: JitCampaignState;
  targetEpoch: number | null;
  tokenIds: string[];
  /** Stop an engine that this campaign auto-started once the one-shot work is
   * terminal, unless another enabled strategy still needs it. */
  autoStopOnCompletion: boolean;
  message?: string;
  completedAt?: number;
}

/** Authoritative strategy API representation. */
export interface StrategySnapshot {
  revision: number;
  config: StrategyConfig;
}

/** One transaction resolved on-chain for a race post-mortem. */
export interface PostMortemTx {
  hash: string;
  role: "ours" | "rival";
  found: boolean;
  action: string;
  args: string;
  from: string;
  blockNumber: string | null;
  txIndex: number | null;
  blockTs: number | null;
  baseFeeGwei: number | null;
  /** Effective priority tip actually paid. */
  tipGwei: number | null;
  /** Total effective gas price paid. */
  effectiveGwei: number | null;
  /** True if the tx targeted the game contract. */
  toGame: boolean;
}

/** Win/loss verdict for one of our txs vs one rival tx. */
export interface PostMortemVerdict {
  ourHash: string;
  rivalHash: string;
  ourLabel: string;
  rivalLabel: string;
  sameAction: boolean;
  /** `lost-fee` is the legacy wire name for a same-block ordering/builder-
   * economics loss; priority fee alone is not treated as causal evidence. */
  outcome: "won" | "lost-timing" | "lost-fee" | "unknown";
  detail: string;
}

export interface PostMortemResult {
  txs: PostMortemTx[];
  verdicts: PostMortemVerdict[];
  summary: string;
  gameAddress: string;
  mode: string;
}

export interface BotStatus {
  /** The bot's release version (see VERSION in constants). */
  version: string;
  /** Authoritative submission mode currently used by the backend. */
  mode: "mainnet" | "public" | "local";
  running: boolean;
  unlocked: boolean;
  dryRun: boolean;
  address: string | null;
  balanceWei: string | null;
  chainId: number | null;
  currentEpoch: string | null;
  gameState: number | null;
  citizenSupply: string | null;
  citizensAddress: string | null;
  lastBlock: string | null;
  spentThisEpochWei: string;
  /** Confirmed on-chain spend for the current epoch. */
  confirmedSpendThisEpochWei: string;
  /** Value + maximum gas currently exposed in pending submissions. */
  pendingExposureWei: string;
  /** Whether the durable transaction journal is healthy. */
  journalHealthy: boolean;
  journalError: string | null;
  /** Game start time (unix seconds) — lets the UI compute epoch boundaries. */
  startTime: string | null;
  jitEnabled: boolean;
  jitState: JitCampaignState;
  jitTargetEpoch: number | null;
  /** Independently incremented whenever a JIT campaign is armed, cancelled, or completed. */
  jitRevision: number;
  /** Exact Citizen IDs covered by the active campaign. */
  jitTokenIds: string[];
  jitMessage: string | null;
  jitCompletedAt: number | null;
  /** Revision of the persistent strategy configuration. */
  strategyRevision: number;
  /** True when the Alchemy NFT API (or token overrides) are configured. */
  nftConfigured: boolean;
}
