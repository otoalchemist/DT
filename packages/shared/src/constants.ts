// The bot's release version. SINGLE SOURCE OF TRUTH — the backend logs it at
// startup and returns it in /api/status, the dashboard shows it in the header,
// and `npm run package` names the release zip after it
// (death-and-taxes-bot-v<VERSION>.zip). Bump this on every release so a user can
// tell at a glance whether they're running the current build. Keep the
// package.json `version` fields in sync (npm run package verifies they match).
export const VERSION = "1.3.0" as const;

// Game parameters from the verified DeathAndTaxes GameParams.sol.
// These are compile-time constants on-chain; the backend still reads the live
// values at startup (see contract.ts) and treats these only as documented defaults.

export const GAME_CONTRACT_ADDRESS = "0xa448c7f618087dDa1a3B128cAd8A424fBae4B71F" as const;

/**
 * The Emigration contract (verified `Emigration.sol`, deployed 2026-07-29).
 *
 * A citizen `safeTransferFrom`-ed here is swapped for a Governor NFT and held by the
 * contract forever — it has no `payTaxes`/`useBribe` code path and no generic executor,
 * so an emigrated citizen can never defend itself and never acts again. It has left the
 * main game: we don't pay for it (it isn't ours anymore).
 * `supply` is 36, which is exactly `citizenSupply - WINNERS` at deployment.
 */
export const EMIGRATION_CONTRACT_ADDRESS = "0xE56d011262d4738dC8307fb8a4Ae48B2bFc20E7C" as const;

/** Block the Emigration contract was deployed in (tx 0xb42bf57c…67a8, 2026-07-29
 *  20:30 UTC). Lower bound for the `Emigrated` log scan — there can be no event
 *  before it, so scanning from genesis would be wasted range. */
export const EMIGRATION_DEPLOY_BLOCK = 25_640_893n;

/**
 * ABBC — "anti bot bot club", the SECOND emigration destination (deployed 2026-08-10,
 * block 25727232).
 *
 * Mechanically identical to the Governor route: `safeTransferFrom` a citizen to this
 * vault and it mints you an ABBC token, holding the citizen indefinitely. It emits the
 * same `Emigrated(address indexed, uint256 indexed)` signature with the same argument
 * order, verified on-chain against tx 0x76b0389c…47a4 (citizen #4632).
 *
 * IMPORTANT — this is the VAULT that receives the citizens, not the ABBC token contract.
 * The ABBC collection lives at 0xFEc1DD883E0D17E5F6C40B146160240470e58453 (a 45-byte
 * EIP-1167 proxy) and never holds a citizen: it only mints the membership token. Watching
 * the token address finds zero emigrations, which is exactly the wrong-address mistake
 * this comment exists to prevent.
 */
export const ABBC_EMIGRATION_CONTRACT_ADDRESS = "0xbFFFc99Fa75A0FEA45b765d11d8e52F8E1114F8c" as const;

/** The ABBC membership token minted in exchange for a citizen. Holds no citizens itself —
 *  recorded so the two addresses are never confused (see the note above). */
export const ABBC_TOKEN_CONTRACT_ADDRESS = "0xFEc1DD883E0D17E5F6C40B146160240470e58453" as const;

/** Block the ABBC vault was deployed in (2026-08-10 21:17 UTC), found by binary-searching
 *  `eth_getCode`. Lower bound for its `Emigrated` log scan. */
export const ABBC_EMIGRATION_DEPLOY_BLOCK = 25_727_232n;

/**
 * Every contract a citizen can emigrate to, in deployment order.
 *
 * Emigration is no longer one destination, so anything that means "has this citizen left
 * the game" has to consult the whole set rather than a single address — a hard-coded
 * comparison silently treats ABBC emigrants as still in the game.
 *
 * `label` is what the dashboard calls each route; `deployBlock` bounds its log scan.
 */
export const EMIGRATION_DESTINATIONS = [
  {
    address: EMIGRATION_CONTRACT_ADDRESS,
    label: "Governor",
    deployBlock: EMIGRATION_DEPLOY_BLOCK,
  },
  {
    address: ABBC_EMIGRATION_CONTRACT_ADDRESS,
    label: "ABBC",
    deployBlock: ABBC_EMIGRATION_DEPLOY_BLOCK,
  },
] as const;

/** Which emigration route `owner` belongs to, or null if it isn't an emigration contract. */
export function emigrationDestinationOf(
  owner: string | null | undefined,
): (typeof EMIGRATION_DESTINATIONS)[number] | null {
  if (!owner) return null;
  const want = owner.toLowerCase();
  return EMIGRATION_DESTINATIONS.find((d) => d.address.toLowerCase() === want) ?? null;
}

/** True when `owner` is ANY emigration contract, i.e. the citizen has left the main game.
 *  Case-insensitive: indexers return owners in varying casings (Alchemy's owner index is
 *  lowercase, `ownerOf` returns checksummed), so never compare raw. */
export function isEmigrated(owner: string | null | undefined): boolean {
  return emigrationDestinationOf(owner) !== null;
}

/** Duration of one game epoch, in seconds (24 hours). */
export const EPOCH_DURATION_SECONDS = 24n * 60n * 60n;

/** Last-N-standing survivor target; game ends when citizen totalSupply <= WINNERS. */
export const WINNERS = 69n;

/** Base tax unit (wei); per-epoch rate = epoch * BASE_TAX_RATE. 0.00069 ETH. */
export const BASE_TAX_RATE_WEI = 690_000_000_000_000n;

/** Flat ETH cost to initiate an audit (wei). 0.00069 ETH. */
export const AUDIT_COST_WEI = 690_000_000_000_000n;

/** Flat ETH cost to buy (cosmetic) life insurance (wei). 0.00969 ETH. */
export const LIFE_INSURANCE_COST_WEI = 9_690_000_000_000_000n;

/** Default audits allowed per token per epoch. */
export const DAILY_AUDIT_LIMIT = 1n;

/** Max epochs that can be prepaid in a single payTaxes call. */
export const EPOCHS_CAN_PAY_AT_ONE_TIME = 7;

/** Protocol fee (basis points) taken on payments. */
export const FEE_BPS = 690n;
export const BASIS = 10_000n;

export const GameState = {
  CONFIGURING: 0,
  LIVE: 1,
  ENDED: 2,
} as const;
export type GameStateValue = (typeof GameState)[keyof typeof GameState];

/**
 * Measured gas per game action, from real on-chain transactions over a 10-epoch window.
 * Used to price what a coinbase bid must cover: a bid buys position for the WHOLE bundle,
 * so the cost of out-ranking a rival payment scales linearly with how much gas you are carrying.
 */
export const GAS_PER_PAYMENT = 82_875;
export const GAS_PER_AUDIT = 130_409;
/** The CoinbasePayer forwarder tx that carries the bid. Fixed overhead per bundle. */
export const GAS_COINBASE_BID_TX = 60_000;

/**
 * Coinbase bid (ETH) needed to out-rank a rival defending at `defenseGwei` gwei/gas.
 *
 * Builders order by value per gas, so the bar is the rival's DENSITY — (their bid + their
 * priority tips) / their gas — and what we bring to clear it is our own tip plus the bid
 * spread across our bundle. Returns 0 when our tip already out-ranks them.
 */
export function bidToBeat(
  defenseGwei: number,
  ourTipGwei: number,
  payments: number,
  audits: number,
): number {
  const gas = payments * GAS_PER_PAYMENT + audits * GAS_PER_AUDIT + GAS_COINBASE_BID_TX;
  if (defenseGwei <= ourTipGwei) return 0;
  return ((defenseGwei - ourTipGwei) * gas) / 1e9;
}

/** Total gas of a bundle carrying `payments` payments, `audits` audits and the bid tx. */
export function bundleGas(payments: number, audits: number): number {
  return payments * GAS_PER_PAYMENT + audits * GAS_PER_AUDIT + GAS_COINBASE_BID_TX;
}
