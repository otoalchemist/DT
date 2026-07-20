import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  webSocket,
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
  if (!url) {
    return custom({
      request: async () => {
        throw new Error("RPC HTTP URL is not configured");
      },
    });
  }
  return http(url, {
    batch: true,
    timeout: 10_000,
    retryCount: 1,
  });
}

// `let` exports are live bindings in ES modules — importers always see the current value.
export let publicClient: PublicClient = createPublicClient({
  chain: mainnet,
  transport: makeHttpTransport(appConfig.httpUrl),
});

export let wsClient: PublicClient | null = appConfig.wsUrl
  ? createPublicClient({ chain: mainnet, transport: webSocket(appConfig.wsUrl) })
  : null;

/** Re-create viem clients after an API key is configured at runtime. */
export function reinitClients(httpUrl: string, wsUrl?: string | null): void {
  if (!httpUrl) throw new Error("RPC HTTP URL is not configured");
  publicClient = createPublicClient({ chain: mainnet, transport: makeHttpTransport(httpUrl) });
  wsClient = wsUrl ? createPublicClient({ chain: mainnet, transport: webSocket(wsUrl) }) : null;
  cachedBlock = null; // drop any block cached against the old client
  // Do not log any part of the configured endpoint. Private gateways can carry
  // credentials in userinfo, paths, queries, or generated subdomains.
  logger.info("RPC clients reinitialized (configured endpoint)");
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
  // Never infer mainnet from an unavailable/misconfigured RPC. Unlock and all
  // signing paths must fail closed until the connected chain is verified.
  if (!appConfig.httpUrl) throw new Error("RPC HTTP URL is not configured");
  return publicClient.getChainId();
}
