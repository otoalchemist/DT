import {
  createPublicClient,
  createWalletClient,
  http,
  webSocket,
  type Address,
  type Block,
  type PublicClient,
  type WalletClient,
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
  cachedBalance = null; // ...and any balance read through it
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
 */
export function primeBlockCache(block: Block): void {
  cachedBlock = { at: Date.now(), block };
}

// The wallet balance only moves when we spend (or someone funds us), so a short cache
// is safe for the min-balance floor check — and any successful submission invalidates
// it (see invalidateBalanceCache) so the floor is never evaluated against a balance
// that predates our own spend. Previously re-read every tick (~7.2k/day).
let cachedBalance: { at: number; address: string; wei: bigint } | null = null;
const BALANCE_CACHE_MS = 30_000;

export async function getBalanceCached(address: Address, maxAgeMs = BALANCE_CACHE_MS): Promise<bigint> {
  const key = address.toLowerCase();
  const now = Date.now();
  if (cachedBalance && cachedBalance.address === key && now - cachedBalance.at <= maxAgeMs) {
    return cachedBalance.wei;
  }
  const wei = await publicClient.getBalance({ address });
  cachedBalance = { at: now, address: key, wei };
  return wei;
}

/** Drop the cached balance — call after anything that spends, so the next guardrail
 *  check reads the real post-spend balance instead of a stale pre-spend one. */
export function invalidateBalanceCache(): void {
  cachedBalance = null;
}

/** Build a wallet client bound to an unlocked account for signing. */
export function makeWalletClient(account: PrivateKeyAccount): WalletClient {
  return createWalletClient({
    account,
    chain: mainnet,
    transport: makeHttpTransport(appConfig.httpUrl),
  });
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
