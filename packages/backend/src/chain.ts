import {
  createPublicClient,
  createWalletClient,
  http,
  webSocket,
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
  logger.info(`RPC clients reinitialized (${httpUrl.slice(0, 40)}…)`);
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
