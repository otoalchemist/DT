import {
  formatEther,
  getAddress,
  keccak256,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { StrategyConfig } from "@dat-bot/shared";
import { publicClient } from "./chain.js";
import { appConfig } from "./config.js";

/** Covers the stateless forwarder's checked call when block.coinbase is itself
 * a contract. The signed maximum is also reserved by spend accounting. */
export const COINBASE_PAYER_GAS: bigint = 100_000n;

/** Runtime bytecode hash of contracts/CoinbasePayer.sol, compiled with Solidity
 * 0.8.20. Updated only together with an independently reviewed payer runtime. */
export const COINBASE_PAYER_RUNTIME_CODE_HASH: Hex =
  "0x8ca126cf92be3a9978ed8f20db5c0851bc006f0354b9e73a597ed94d80f851e9";

export type BuilderIncentiveResolution =
  | {
      active: true;
      payer: Address;
      bidWei: bigint;
      runtimeCodeHash: Hex;
    }
  | {
      active: false;
      reason: string;
    };

/** Resolve the financial configuration against the live chain. No caller may
 * infer activation from a positive amount or syntactically valid address alone. */
export async function resolveBuilderIncentive(
  config: StrategyConfig,
  chainId: number | null,
): Promise<BuilderIncentiveResolution> {
  return resolveBuilderIncentiveForMode(config, chainId, appConfig.mode);
}

/** Validate a settings candidate without temporarily mutating the process-wide
 * submission mode. A candidate RPC client may be supplied when settings also
 * replace the active endpoint. */
export async function resolveBuilderIncentiveForMode(
  config: StrategyConfig,
  chainId: number | null,
  mode: "mainnet" | "public" | "local",
  client: Pick<PublicClient, "getBytecode"> = publicClient,
): Promise<BuilderIncentiveResolution> {
  if (!config.coinbaseBidEnabled) {
    return { active: false, reason: "Direct builder incentive is disabled" };
  }
  if (mode !== "mainnet") {
    return { active: false, reason: "Direct builder incentives require mainnet private-bundle mode" };
  }
  if (chainId !== 1) {
    return {
      active: false,
      reason: chainId === null
        ? "Ethereum chain ID has not been verified"
        : `Direct builder incentives require Ethereum mainnet (chain ID 1), received ${chainId}`,
    };
  }

  let bidWei: bigint;
  try {
    bidWei = parseEther(config.coinbaseBidEth);
  } catch {
    return { active: false, reason: "Builder incentive amount is not a canonical ETH value" };
  }
  if (formatEther(bidWei) !== config.coinbaseBidEth) {
    return { active: false, reason: "Builder incentive amount is not in canonical ETH form" };
  }
  if (bidWei <= 0n) {
    return { active: false, reason: "Builder incentive amount must be greater than zero" };
  }
  if (!config.coinbasePayerAddress) {
    return { active: false, reason: "CoinbasePayer address is not configured" };
  }

  let payer: Address;
  try {
    payer = getAddress(config.coinbasePayerAddress);
  } catch {
    return { active: false, reason: "CoinbasePayer address is invalid" };
  }

  let code: Hex | undefined;
  try {
    code = await client.getBytecode({ address: payer });
  } catch (error) {
    return {
      active: false,
      reason: `Could not verify CoinbasePayer bytecode: ${(error as Error).message}`,
    };
  }
  if (!code || code === "0x") {
    return { active: false, reason: "CoinbasePayer address has no deployed bytecode" };
  }
  const runtimeCodeHash = keccak256(code);
  if (runtimeCodeHash !== COINBASE_PAYER_RUNTIME_CODE_HASH) {
    return { active: false, reason: "CoinbasePayer bytecode does not match the approved stateless runtime" };
  }
  return { active: true, payer, bidWei, runtimeCodeHash };
}
