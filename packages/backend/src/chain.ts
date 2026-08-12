import {
  createPublicClient,
  http,
  keccak256,
  webSocket,
  type Address,
  type Block,
  type PublicClient,
  type Transport,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { GAME_CONTRACT_ADDRESS } from "@dat-bot/shared";
import { appConfig } from "./config.js";
import { logger } from "./logger.js";

function makeHttpTransport(url: string): Transport {
  return http(url, { batch: true });
}

function makePublicClient(httpUrl = appConfig.httpUrl): PublicClient {
  return createPublicClient({
    chain: mainnet,
    transport: httpUrl ? makeHttpTransport(httpUrl) : http(),
  });
}

function makeWsPublicClient(wsUrl: string) {
  return createPublicClient({ chain: mainnet, transport: webSocket(wsUrl) });
}

// `let` exports are live bindings in ES modules — importers always see the current value.
export let publicClient: PublicClient = makePublicClient();

export let wsClient: PublicClient | null = appConfig.wsUrl
  ? makeWsPublicClient(appConfig.wsUrl)
  : null;

/** Re-create viem clients after an API key is configured at runtime. */
export function reinitClients(httpUrl: string, wsUrl?: string | null): void {
  publicClient = makePublicClient(httpUrl);
  wsClient = wsUrl ? makeWsPublicClient(wsUrl) : null;
  cachedBlock = null; // drop any block cached against the old client
  cachedBalances.clear(); // ...and any balances read through it
  // RPC URLs commonly contain API keys in their path. Never put even a prefix of the
  // configured endpoint into logs or dashboard activity.
  logger.info("RPC clients reinitialized");
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

/** Ethereum mainnet identity, pinned independently of the configured RPC. */
export const ETHEREUM_MAINNET_GENESIS_HASH =
  "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3" as const;

/** keccak256 of the canonical game's deployed runtime bytecode at v1.3.0 review time. */
export const GAME_RUNTIME_CODE_HASH =
  "0x239e00dfff09b8332b46b68081300c083b230416034bff98d29798bc0b1c3469" as const;

/** Anvil's default chain ID. Pinning local mode prevents a missing or misdirected
 *  local RPC URL from turning its direct-broadcast path into a mainnet send. */
export const ANVIL_CHAIN_ID = 31_337;

/**
 * Verify the RPC before returning a chain id used for transaction signing.
 *
 * Live modes are deliberately strict: a provider that lies, points at another network,
 * or serves different code at the configured address must stop the bot before a wallet
 * can sign. Local mode requires Anvil's chain id and executable code at GAME_ADDRESS, so
 * a missing local URL cannot silently become a direct mainnet broadcast.
 */
async function validateClientIdentity(
  client: PublicClient,
  mode: typeof appConfig.mode,
  gameAddress: Address,
): Promise<number> {
  const chainId = await client.getChainId();
  const liveMode = mode === "mainnet" || mode === "public";

  if (mode === "local" && chainId !== ANVIL_CHAIN_ID) {
    throw new Error(`Refusing local mode on chain ${chainId}; expected Anvil (${ANVIL_CHAIN_ID})`);
  }

  if (liveMode) {
    if (chainId !== mainnet.id) {
      throw new Error(`Refusing live mode on chain ${chainId}; expected Ethereum mainnet (1)`);
    }
    if (gameAddress.toLowerCase() !== GAME_CONTRACT_ADDRESS.toLowerCase()) {
      throw new Error(
        `Refusing non-canonical GAME_ADDRESS in live mode (${gameAddress})`,
      );
    }

    const genesis = await client.getBlock({ blockNumber: 0n });
    if (genesis.hash?.toLowerCase() !== ETHEREUM_MAINNET_GENESIS_HASH) {
      throw new Error("RPC genesis does not match Ethereum mainnet");
    }
  }

  const code = await client.getCode({ address: gameAddress });
  if (!code || code === "0x") {
    throw new Error(`No contract code at GAME_ADDRESS ${gameAddress}`);
  }
  if (liveMode && keccak256(code) !== GAME_RUNTIME_CODE_HASH) {
    throw new Error("GAME_ADDRESS runtime bytecode does not match the approved deployment");
  }

  return chainId;
}

async function validateWsIdentity(
  client: PublicClient,
  mode: typeof appConfig.mode,
  expectedChainId: number,
): Promise<void> {
  const chainId = await client.getChainId();
  if (chainId !== expectedChainId) {
    throw new Error("HTTP and WebSocket RPC endpoints disagree on chain identity");
  }
  if (mode === "mainnet" || mode === "public") {
    const genesis = await client.getBlock({ blockNumber: 0n });
    if (genesis.hash?.toLowerCase() !== ETHEREUM_MAINNET_GENESIS_HASH) {
      throw new Error("WebSocket RPC genesis does not match Ethereum mainnet");
    }
  }
}

/** Validate a candidate RPC without replacing the process-wide clients. */
export async function validateRpcConfiguration(
  httpUrl: string,
  mode: typeof appConfig.mode = appConfig.mode,
  wsUrl?: string | null,
): Promise<number> {
  const chainId = await validateClientIdentity(makePublicClient(httpUrl), mode, appConfig.gameAddress);
  if (wsUrl) {
    const candidate = makeWsPublicClient(wsUrl);
    try {
      await validateWsIdentity(candidate, mode, chainId);
    } finally {
      // Candidate validation may establish a socket. Do not leave rejected settings
      // connected; the configured long-lived client opens its own socket when watched.
      try {
        const transport = candidate.transport as typeof candidate.transport & {
          getRpcClient?: () => Promise<{ close: () => void }>;
        };
        (await transport.getRpcClient?.())?.close();
      } catch { /* best-effort cleanup */ }
    }
  }
  return chainId;
}

export async function getChainId(): Promise<number> {
  const chainId = await validateClientIdentity(publicClient, appConfig.mode, appConfig.gameAddress);
  if (wsClient) {
    await validateWsIdentity(wsClient, appConfig.mode, chainId);
  }
  return chainId;
}
