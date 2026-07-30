// The bot's release version. SINGLE SOURCE OF TRUTH — the backend logs it at
// startup and returns it in /api/status, the dashboard shows it in the header,
// and `npm run package` names the release zip after it
// (death-and-taxes-bot-v<VERSION>.zip). Bump this on every release so a user can
// tell at a glance whether they're running the current build. Keep the
// package.json `version` fields in sync (npm run package verifies they match).
export const VERSION = "0.5.0" as const;

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
 * main game: we don't pay for it (it isn't ours anymore), and we don't audit or kill it.
 * `supply` is 36, which is exactly `citizenSupply - WINNERS` at deployment.
 */
export const EMIGRATION_CONTRACT_ADDRESS = "0xE56d011262d4738dC8307fb8a4Ae48B2bFc20E7C" as const;

/** True when `owner` is the Emigration contract, i.e. the citizen has emigrated.
 *  Case-insensitive: indexers return owners in varying casings (Alchemy's owner
 *  index is lowercase, `ownerOf` returns checksummed), so never compare raw. */
export function isEmigrated(owner: string | null | undefined): boolean {
  return !!owner && owner.toLowerCase() === EMIGRATION_CONTRACT_ADDRESS.toLowerCase();
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
