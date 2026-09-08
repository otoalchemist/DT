import {
  createPublicClient,
  http,
  webSocket,
  type Address,
  type Block,
  type PublicClient,
  type Transport,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { appConfig } from "./config.js";
import { logger } from "./logger.js";

function makeHttpTransport(url: string): Transport {
  return http(url, { batch: true });
}

// `let` exports are live bindings in ES modules — importers always see the current value.
export let publicClient: PublicClient = createPublicClient({
  chain: mainnet,
  transport: appConfig.httpUrl ? makeHttpTransport(appConfig.httpUrl) : http(),
});

export let wsClient: PublicClient | null = appConfig.wsUrl
  ? createPublicClient({ chain: mainnet, transport: webSocket(appConfig.wsUrl) })
  : null;

/** Re-create viem clients after an API key is configured at runtime. */
export function reinitClients(httpUrl: string, wsUrl?: string | null): void {
  publicClient = createPublicClient({ chain: mainnet, transport: makeHttpTransport(httpUrl) });
  wsClient = wsUrl ? createPublicClient({ chain: mainnet, transport: webSocket(wsUrl) }) : null;
  cachedBlock = null; // drop any block cached against the old client
  cachedBalances.clear(); // ...and any balances read through it
  logger.info(`RPC clients reinitialized (${httpUrl.slice(0, 40)}…)`);
}

// Short-lived cache of the latest block. Within one engine tick the base fee is
// read many times — once per candidate in the guardrail (canSpend) and again per
// submitted tx (computeFees). Blocks are ~12s apart, so reusing the same block for
// a few seconds can't skip a fee change, and it makes the guardrail and the fee
// builder agree on one block instead of racing separate reads. TTL is well under
// a slot so cross-tick staleness stays within one block (base fee moves ≤12.5%,
// inside the 2× maxFee buffer).
let cachedBlock: { at: number; block: Block } | null = null;
const BLOCK_CACHE_MS = 3_000;

export async function getLatestBlockCached(maxAgeMs = BLOCK_CACHE_MS): Promise<Block> {
  const now = Date.now();
  if (cachedBlock && now - cachedBlock.at <= maxAgeMs) return cachedBlock.block;
  const block = await publicClient.getBlock({ blockTag: "latest" });
  cachedBlock = { at: now, block };
  return block;
}

/**
 * Seed the block cache from a caller that ALREADY has the latest block — the
 * WebSocket block subscription hands us a full header on every block, and the tick it
 * triggers then only needs the base fee / number / gas from it. Without this the tick
 * threw that block away and re-read the identical data over HTTP: one wasted
 * eth_getBlockByNumber per block (~7.2k/day at 12s blocks).
 *
 * VALIDATED, because the header is whatever the socket delivered rather than something we
 * asked for. A reconnect (or a provider mid-maintenance) can hand `onBlock` an undefined or
 * partial frame, and caching one poisons every reader for the whole TTL: `getLatestBlockCached`
 * hands back the bad value, and `runtime.lastBlock = latest.number` in refreshSnapshot throws
 * "Cannot read properties of undefined (reading 'number')" on every tick until it ages out.
 *
 * That is not hypothetical. At the epoch-180 boundary an ally's engine threw exactly that,
 * which is why they paused and restarted 38s before the boundary — and the restart is what
 * lost them the race (see the cold-start guard in startEngine). The crash itself was cheap;
 * what it cost was the operator's confidence at the worst possible moment.
 *
 * Dropping a bad frame is strictly safer than storing it: the previous block stays cached and
 * ages out on its own, and any reader past the TTL re-reads over HTTP. A `null` number is the
 * marker of a PENDING block, which is equally unusable as "latest" here.
 */
export function primeBlockCache(block: Block | null | undefined): void {
  if (block == null || block.number == null || block.timestamp == null) {
    logger.warn("ignored a block-subscription frame with no number/timestamp");
    return;
  }
  cachedBlock = { at: Date.now(), block };
}

// The wallet balance only moves when we spend (or someone funds us), so a short cache
// is safe for the min-balance floor check — and any successful submission invalidates
// it (see invalidateBalanceCache) so the floor is never evaluated against a balance
// that predates our own spend. Previously re-read every tick (~7.2k/day).
// Keyed by address: the bot can hold several wallets, and a single-slot cache thrashed
// to a 0% hit rate once there was more than one — every read for wallet B evicted
// wallet A's entry, so each tick paid a fresh getBalance per wallet and the cache did
// nothing but add a lookup.
const cachedBalances = new Map<string, { at: number; wei: bigint }>();
const BALANCE_CACHE_MS = 30_000;

export async function getBalanceCached(address: Address, maxAgeMs = BALANCE_CACHE_MS): Promise<bigint> {
  const key = address.toLowerCase();
  const now = Date.now();
  const hit = cachedBalances.get(key);
  if (hit && now - hit.at <= maxAgeMs) return hit.wei;
  const wei = await publicClient.getBalance({ address });
  cachedBalances.set(key, { at: now, wei });
  return wei;
}

/** Drop cached balances — call after anything that spends, so the next guardrail check
 *  reads the real post-spend balance instead of a stale pre-spend one. Clears every
 *  wallet by default: one bundle can spend from several, so invalidating only the payer
 *  would leave the others' floors evaluated against pre-spend numbers. */
export function invalidateBalanceCache(address?: Address): void {
  if (address) cachedBalances.delete(address.toLowerCase());
  else cachedBalances.clear();
}

export function accountFromPrivateKey(pk: `0x${string}`): PrivateKeyAccount {
  return privateKeyToAccount(pk);
}

export async function getChainId(): Promise<number> {
  try {
    return await publicClient.getChainId();
  } catch (err) {
    logger.warn("getChainId failed:", (err as Error).message);
    return mainnet.id;
  }
}
