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
  /** Which unlocked wallet holds this citizen. Actions on it are owner-only on-chain, so
   *  this is the wallet that must sign — and the one that needs the gas. null if unknown
   *  (e.g. read while locked). */
  walletAddress?: string | null;
  walletLabel?: string | null;
}

export type ActivityKind =
  | "pay-taxes"
  | "use-bribe"
  | "audit"
  | "kill"
  | "info"
  | "error";

export type ActivityStatus =
  | "planned"
  | "simulated"
  | "submitted"
  | "included"
  | "reverted"
  | "skipped"
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
  /** Master switch: when false, the engine observes but never submits. */
  enabled: boolean;

  // --- Defense ---
  //
  // By default there is no automatic response to an audit: the bot never pays to clear
  // one and never spends a held bribe. Both are manual actions on the token row, and the
  // settings below govern keeping a citizen current BEFORE it can be audited. The single
  // exception is `autoDefendAudit`, which the user must opt in to.
  /**
   * "Benji (Defense) Mode" in the UI — the field keeps the descriptive name so its job is
   * readable from the config file alone.
   *
   * Pay off an audited citizen to clear the audit — the ONE automatic response to an
   * audit, and off by default.
   *
   * Only fires for a citizen holding NO bribes: a bribe clears an audit for free, which
   * is cheaper than paying the tax, so burning one stays a manual decision.
   *
   * Cost warning: an audited citizen is 2+ epochs behind by definition, and being
   * audited revokes the one-epoch skip — it must settle every delinquent epoch at once,
   * so this pays a multiple of one day's tax. (The same citizen unaudited would owe 1x.)
   * It deliberately ignores `maxAutoPayEpochs` — that cap sizes routine auto-pay,
   * and applying it here would block the feature in precisely the case it exists for.
   * `maxPaymentEth`, the base-fee cap and the per-wallet balance floor still apply, and
   * `excludedTokenIds` still wins.
   */
  autoDefendAudit: boolean;
  /** Proactively pay before becoming delinquent (don't wait to be audited). */
  proactivePay: boolean;
  /** Epochs to prepay per payTaxes call (1-7) to lock the current rate. */
  prepayEpochs: number;
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

  // --- Just-in-time single-epoch payment (one-shot) ---
  /** When armed, pay exactly one epoch for each selected token the moment the
   *  target epoch begins on-chain, then auto-disarm. */
  jitEnabled: boolean;
  /** The epoch to pay for. Set when arming (usually currentEpoch + 1). */
  jitTargetEpoch: number | null;
  /** Specific tokenIds to cover; empty = all owned citizens. */
  jitTokenIds: string[];
  /**
   * Citizens the bot must NEVER pay, on any path — defense, proactive-pay and JIT all
   * skip these. This is a persistent per-citizen opt-out (the unchecked boxes in the
   * JIT panel), not a one-off selection like `jitTokenIds`.
   *
   * An excluded citizen is left entirely to the user: it will go delinquent, can be
   * audited, and can eventually be killed. Nothing automatic will rescue it — use the
   * manual "Pay to current" button on the token row.
   */
  excludedTokenIds: string[];
  /** ADVANCED: pre-submit the JIT payment ~preBoundaryLeadMs *before* the target
   *  epoch boundary so it lands in the FIRST block of the epoch (ahead of a
   *  batch-auditor), instead of the block after. The value is computed off-chain
   *  for the upcoming epoch and validated by simulating AT the boundary timestamp,
   *  so a wrong value is caught before spending gas. Off by default. */
  preBoundaryPay: boolean;
  /** How many ms before the target boundary to fire the pre-submit in
   *  public/local mode (250–8000). Held tight because a public tx that lands in
   *  the pre-boundary block carries a next-epoch value and overpay-reverts. */
  preBoundaryLeadMs: number;
  /** Lead used in `mainnet` (bundle) mode (250–11000). Bundles target a specific
   *  blockNumber, so they can't land in the wrong block, and a bundle that would
   *  revert is dropped rather than mined — so pre-submitting earlier is free, and
   *  gives builders more time to weigh it. Keep under a 12s slot so the bundle's
   *  target block resolves to the boundary block. */
  preBoundaryLeadMainnetMs: number;

  // --- Away mode (RPC saver) ---
  /**
   * Keep the engine STOPPED between epochs, waking it only around the boundary.
   *
   * The engine costs ~22 provider requests/minute while running (one tick per block),
   * but proactive-pay and the JIT payment fire only AT the boundary — so running around
   * the clock buys very little. Away mode idles at ZERO requests: epoch boundaries are
   * deterministic (startTime + N * 86400), so the wake-up is a plain timer, not a poll.
   *
   * It wakes `awayLeadMinutes` before each boundary, but only when there's something to
   * do — a JIT payment armed for that epoch, or proactive pay — and stops again
   * AWAY_STOP_GRACE_MS after the boundary passes.
   *
   * Trade-off: mid-epoch work is missed. An audit expires 24h after it was cast rather
   * than on a boundary, so recovering one while away requires Benji mode or a manual pay.
   */
  awayMode: boolean;
  /** Minutes before the boundary to wake the engine in away mode. 15 is generous: the
   *  first tick is a second or two, so this is mostly slack for an RPC hiccup or timer
   *  drift. */
  awayLeadMinutes: number;

  // --- Guardrails ---
  /** Max base fee (gwei) the bot will transact at. */
  maxBaseFeeGwei: number;
  /** Priority fee (gwei) to include on bundles. */
  priorityFeeGwei: number;
  /** Never spend below this wallet balance (ether). */
  minBalanceEth: number;

  // --- Latency (mainnet mode only) ---
  /** Scale the priority-fee tip up as the latest block fills, so we stay
   *  competitive for inclusion in contested blocks. When off, the static
   *  priorityFeeGwei is always used. */
  dynamicTipEnabled: boolean;
  /** Upper bound (gwei) the dynamic tip may scale to at a 100%-full block.
   *  Ignored when dynamicTipEnabled is false. */
  dynamicTipMaxGwei: number;
  /** ADVANCED. Flat ETH paid directly to the block builder (a coinbase transfer)
   *  alongside the pre-boundary payment bundle, to bid for top-of-block placement
   *  independent of tip — the lever sophisticated batch-auditors use. `0` = off
   *  (default). Requires `coinbasePayerAddress` set to a deployed CoinbasePayer
   *  forwarder (see contracts/CoinbasePayer.sol). Only fires in mainnet mode when
   *  a pre-boundary payment is queued; the bid rides the bundle (allowed-to-revert,
   *  never mirrored), so it only spends when the bundle wins the slot. */
  coinbaseBidEth: number;
  /** Address of an operator-approved CoinbasePayer used for coinbaseBidEth. Its
   *  receive() forwards ETH to block.coinbase. The backend also requires its runtime
   *  hash in COINBASE_PAYER_CODE_HASHES. Empty = coinbase bidding disabled. */
  coinbasePayerAddress: string;

  /** Hard cap (ETH) on the value of any single transaction (payments in
   *  particular). A tx whose value exceeds this is skipped, not sent — a
   *  backstop against a bad estimate or many-epoch debt draining the wallet.
   *  0 disables the cap. */
  maxPaymentEth: number;
}

/** One unlocked hot wallet in the keystore. */
export interface WalletStatus {
  address: string;
  /** Human name, e.g. "cold-1". Never sensitive. */
  label: string;
  /** null until a balance has been read for it. */
  balanceWei: string | null;
}

export interface BotStatus {
  /** The bot's release version (see VERSION in constants). */
  version: string;
  running: boolean;
  unlocked: boolean;
  /** The PRIMARY wallet's address — the single headline identity, and the wallet that
   *  funds the coinbase bid. See `wallets` for the full roster. */
  address: string | null;
  /** Total across every unlocked wallet, not just the primary. */
  balanceWei: string | null;
  /**
   * Every unlocked wallet. Citizens can only be acted on by the wallet that owns them
   * (payTaxes is owner-only on-chain), so the bot holds one key per wallet
   * and each has its own balance and min-balance floor.
   */
  wallets: WalletStatus[];
  chainId: number | null;
  currentEpoch: string | null;
  gameState: number | null;
  citizenSupply: string | null;
  citizensAddress: string | null;
  lastBlock: string | null;
  /** Away mode: unix seconds of the next scheduled wake-up, or null when away mode is
   *  off / nothing is armed to wake for. Lets the dashboard count down without polling. */
  awayNextWakeSec: number | null;
  spentThisEpochWei: string;
  /** Game start time (unix seconds) — lets the UI compute epoch boundaries. */
  startTime: string | null;
  jitEnabled: boolean;
  jitTargetEpoch: number | null;
  /** True when the Alchemy NFT API (or token overrides) are configured. */
  nftConfigured: boolean;
}
