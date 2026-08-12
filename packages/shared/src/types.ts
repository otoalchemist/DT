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
  /**
   * How many DISTINCT rivals this citizen may audit per epoch. Most are 1; auditor-role
   * citizens carry more. Summed across owned citizens it is the wallet's audit capacity
   * for a boundary, which is what sizes an offense bundle. Optional: absent from rows
   * produced before it was fetched.
   */
  auditLimit?: number;
  /** Which unlocked wallet holds this citizen. Actions on it are owner-only on-chain, so
   *  this is the wallet that must sign — and the one that needs the gas. null if unknown
   *  (e.g. read while locked). */
  walletAddress?: string | null;
  walletLabel?: string | null;
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

/**
 * A "do not target" rival (data/do-not-target.json) — one of the big-boy operators we
 * deliberately never audit — carrying the name of whoever runs it, so the panel can group
 * and tag them instead of showing bare ids.
 */
export interface DoNotTargetStatus extends TargetTokenStatus {
  /** Operator name the token is listed under, e.g. "Graveyard". */
  operator: string;
}

/**
 * A citizen that emigrated — traded to the Emigration contract for a Governor NFT.
 *
 * Sourced from the contract's `Emigrated` event log, NOT from current ownership, so the
 * roster is permanent: an emigrant that has since been killed (ERC-721 burned, so it
 * vanishes from every ownership index) still appears, marked `alive: false`. Ownership
 * alone would silently shrink the list as emigrants die, which reads as a bug.
 */
export interface EmigratedTokenStatus {
  tokenId: string;
  /** Address the Governor NFT was minted to — the wallet that emigrated this citizen. */
  emigratedBy: string;
  /** Emigration order, 0-based. Also the Governor's metadata index at mint time. */
  index: number;
  /** Which emigration route it took: the receiving contract's address. */
  destination: string;
  /** Human label for that route — "Governor" or "ABBC". Lets the panel group by route
   *  without the UI needing to know any addresses. */
  destinationLabel: string;
  /** False once the citizen has been killed and burned. Its tax/audit fields are
   *  then frozen at "—": there is no live token left to read a status from. */
  alive: boolean;
  /** How many epochs behind on taxes. 0 when not alive. */
  epochsBehind: number;
  /** 0 if not under audit; else the unix ts after which kill() succeeds. */
  auditDueTimestamp: string;
  /** True if under audit and already expired -> anyone can kill it now. */
  killable: boolean;
}

/**
 * One rival's audit-attractiveness scoring, produced by scripts/target-scores.mjs and
 * surfaced in the dashboard's "Analyze targets" panel. Field meanings are documented in
 * that script's header — keep the two in sync.
 */
export interface TargetScoreRow {
  token: string;
  /** On the curated rival-skippers list (vs a plain rival). */
  skipper: boolean;
  /** Epochs behind now: 1 = becomes auditable next boundary, 2+ = auditable already. */
  behind: number;
  under: boolean;
  killable: boolean;
  /** Boundaries entered 2+ behind / boundaries sampled — how consistently it skips. */
  crossings: number;
  sampled: number;
  /**
   * Outcome of those crossings. A skip leaves the token auditable until it cures, so it
   * either slips through (`skipClean`) or draws an audit that epoch (`skipCaught`).
   * `skipClean + skipCaught === crossings`. All-clean = a proven-safe cadence and a hard
   * target; frequently caught = a soft one that is cheap to punish again.
   *
   * Optional because the scan result is cached in memory: a backend still holding rows
   * from a scan that ran before this column existed will not have them, and the UI falls
   * back to the plain crossings/sampled cadence for those.
   */
  skipCaught?: number;
  skipClean?: number;
  bribes: number;
  ins: boolean;
  ownerBalEth: number;
  cits: number;
  runwayEpochs: number | null;
  owesNextEth: number;
  affordNext: boolean;
  maxTip: number;
  bestIdx: number | null;
  /** Blocks after the boundary it paid: fastest / median. 0 = pays in the boundary block. */
  payBlkMin: number | null;
  payBlkMed: number | null;
  /**
   * Coinbase bid over the LAST 2 EPOCHS: total ETH, and how many of its payments were
   * bid-backed. The "are they bidding right now" signal, deliberately narrower than the
   * window `beatBidEth` is priced against. Shared when one operator co-pays several
   * citizens in one block. null = the RPC has no tracing, so it's unknown.
   */
  bidEth: number | null;
  bidPays: number | null;
  /** Same, over the WHOLE window — the bidding `beatBidEth` is actually priced against. */
  bidWindowEth?: number | null;
  bidWindowPays?: number | null;
  audited: number;
  /**
   * Coinbase bid (ETH) needed to out-rank this rival's PEAK defense density over the whole
   * window, for a one-payment + one-audit bundle at our default 20.1 gwei tip.
   *
   * Density — (coinbase bid + priority tips) / gas — is what a builder sorts on, so it,
   * not the tip, is the bar. A bidder's tip can be near zero while the bid puts it
   * hundreds of gwei/gas ahead. Peak rather than recent, because what you must clear is
   * the strongest defense it has actually mounted: #5347 bid its way to 192 gwei/gas six
   * epochs ago while reading "no bid needed" off a 2-epoch window, and sat 6th in the
   * recommended targets. A ceiling, not a forecast. 0 = peak defense already at or below
   * our tip. Optional: absent on rows cached before this was added.
   */
  beatBidEth?: number;
  /** The density beatBidEth is priced against, gwei/gas: max(maxTip, observed bid density). */
  defenseGwei?: number;
  /**
   * The same price, but against only the LAST 2 EPOCHS — the likely cost at the next
   * boundary, where beatBidEth is the ceiling it could escalate to. Read together: equal
   * means a steady defender, a gap means it escalates. null when it made no payment in
   * that span, which is a different statement from "it defends weakly".
   */
  beatBidRecentEth?: number | null;
  defenseRecentGwei?: number | null;
  /**
   * True when beatBidEth is 0 but the rival still reached tx index <= 1 — it topped the
   * block while measuring below our own tip, which cannot happen on merit. Something is
   * buying that position outside what we can observe (a bid older than the 2-epoch trace
   * window, or an off-chain builder deal), so "no bid needed" would be wrong and the UI
   * shows unknown instead.
   */
  defenseUnexplained?: boolean;
  /**
   * Which section the scan put it in. "observed" = it attempted a skip during the window
   * but is not yet in data/rival-skippers.json, so the saved list is behind the data.
   */
  skipperSource?: "listed" | "observed" | "both";
  /**
   * Do not target: an audit slot spent here is wasted, so the row is greyed and scored 0.
   * Two independent reasons, distinguished by `dntReason`:
   *  - "listed"   — on the curated big-boy roster (data/do-not-target.json). A standing
   *                 instruction; `dntOwner` names the operator.
   *  - "evidence" — the history shows it reaches top-of-block (best tx index <= 1) and
   *                 nobody has ever audited it in the window. A judgement the next scan
   *                 may revise, not an instruction.
   * Neither is a veto: pinning one in the Strategy targets box still audits it.
   */
  doNotTarget?: boolean;
  dntReason?: "listed" | "evidence" | null;
  dntOwner?: string | null;
  /**
   * @deprecated Superseded by `doNotTarget` (which also covers the curated roster). Kept
   * so rows cached by a backend from before the rename still grey correctly.
   */
  uncatchable: boolean;
  score: number;
}

/** State of the on-demand rival scan behind the dashboard's "Analyze targets" button. */
export interface TargetScoresState {
  running: boolean;
  /** Epoch the scan was computed against; null until one completes. */
  computedAtEpoch: number | null;
  computedAt: number | null;
  hoursToNextBoundary: number | null;
  epochTaxEth: number | null;
  rows: TargetScoreRow[] | null;
  error: string | null;
  /** True once the epoch rolled since the scan — every "behind" count has shifted. */
  stale: boolean;
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
   *
   * This is a PAYMENT opt-out only — it is NOT an offense opt-out. An excluded citizen
   * is still used as an audit "from" token and still spends its full `auditLimit` on
   * rivals. Note its auditor eligibility lapses on its own once it drifts 2+ epochs
   * behind, since the contract forbids an auditable token from auditing.
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
   * but proactive-pay, the JIT payment and the pre-boundary audit all fire only AT the
   * boundary — so running around the clock buys very little. Away mode idles at ZERO
   * requests: epoch boundaries are deterministic (startTime + N * 86400), so the wake-up
   * is a plain timer, not a poll.
   *
   * It wakes `awayLeadMinutes` before each boundary, but only when there's something to
   * do — a JIT payment armed for that epoch, or offense enabled — and stops again
   * AWAY_STOP_GRACE_MS after the boundary passes.
   *
   * Trade-off: mid-epoch work is missed. Kill deadlines fall 24h after an audit rather
   * than on a boundary, and a rival that becomes auditable mid-epoch won't be caught.
   */
  awayMode: boolean;
  /** Minutes before the boundary to wake the engine in away mode. 15 is generous: the
   *  cold candidate enumeration is ~15s and the first tick a second or two, so this is
   *  mostly slack for an RPC hiccup or timer drift. */
  awayLeadMinutes: number;

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
  /** ADVANCED: pre-submit audits ~preBoundaryLeadMs before the epoch boundary so
   *  they land in the FIRST block of the epoch (auditing rivals the instant they
   *  become delinquent, like a batch-auditor) instead of the block after.
   *  Unsimulated; a mis-timed audit reverts (gas only — the fee is refunded). */
  preBoundaryAudit: boolean;
  /** ADVANCED: pre-submit kills ~preBoundaryLeadMs before a target's audit-expiry
   *  so the kill lands in the first eligible block. Unsimulated; a too-early kill
   *  reverts (gas only). */
  preBoundaryKill: boolean;
  /** ADVANCED: at a boundary, emit the pre-boundary payment AND audit as ONE atomic
   *  bundle (from your wallet, sequential nonces) instead of two separate bundles,
   *  so they land consecutively top-of-block and can't demote each other. Payment is
   *  mandatory; audits ride allowed-to-revert (never drop the payment) and aren't
   *  mempool-mirrored. Includes whichever of preBoundaryPay / preBoundaryAudit are
   *  enabled (payment-only, audit-only, or both). Most effective WITH a coinbase bid
   *  (which wins the slot so the bundle-only audits actually land). OFF by default. */
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

  // --- Latency (mainnet mode only) ---
  /** Also broadcast time-critical offense txs to the public mempool alongside
   *  the Flashbots bundle, so any builder can include them in the next block.
   *  Trades bundle privacy for lower inclusion latency. */
  racePublicMempool: boolean;
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
  /**
   * The bid used for an AUDIT-ONLY boundary — offense running with no payment armed.
   *
   * Separate from coinbaseBidEth because the two boundaries are not the same purchase.
   * A payment bundle is defensive and must land: missing it can cost a citizen, and the
   * bundle is bigger (every payment adds ~82,875 gas), so the same position costs more.
   * An audit-only bundle is speculative: losing it costs the audit fee and nothing else,
   * and it is far smaller, so a given density is cheaper to buy. Being forced to use one
   * number for both means overpaying on every audit-only night or underpaying on the one
   * boundary that actually matters.
   *
   * 0 = no bid on audit-only boundaries (audits then keep their mempool mirror; see
   * firePreBoundaryAudit).
   */
  coinbaseBidAuditOnlyEth: number;
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
  /** "won" | "lost-timing" | "lost-fee" | "unknown". */
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
   * (payTaxes/audit/kill are owner-only on-chain), so the bot holds one key per wallet
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
