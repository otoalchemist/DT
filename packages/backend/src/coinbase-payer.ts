import {
  decodeFunctionData,
  encodeFunctionData,
  type Hex,
} from "viem";

/** The only callable surface of the reviewed stateless payer. Keeping this ABI
 * in a dependency-free module lets strategy, transport, and durable WAL
 * validation agree on the exact signed validity window. */
export const coinbasePayerAbi = [{
  type: "function",
  name: "payCoinbase",
  stateMutability: "payable",
  inputs: [
    { name: "notBeforeTimestamp", type: "uint256" },
    { name: "validThroughBlock", type: "uint256" },
  ],
  outputs: [],
}] as const;

export interface CoinbasePaymentWindow {
  notBeforeTimestamp: bigint;
  validThroughBlock: bigint;
}

export function encodeCoinbasePayment(
  notBeforeTimestamp: bigint,
  validThroughBlock: bigint,
): Hex {
  if (notBeforeTimestamp < 0n) throw new Error("CoinbasePayer not-before timestamp must be non-negative");
  if (validThroughBlock < 0n) throw new Error("CoinbasePayer block deadline must be non-negative");
  return encodeFunctionData({
    abi: coinbasePayerAbi,
    functionName: "payCoinbase",
    args: [notBeforeTimestamp, validThroughBlock],
  });
}

/** Decode only the canonical selector + two-word argument shape. Rejecting
 * trailing bytes keeps WAL metadata and the transaction's signed commitment
 * byte-for-byte unambiguous. */
export function decodeCoinbasePayment(data: Hex): CoinbasePaymentWindow | null {
  if (data.length !== 2 + 4 * 2 + 32 * 2 * 2) return null;
  try {
    const decoded = decodeFunctionData({ abi: coinbasePayerAbi, data });
    if (decoded.functionName !== "payCoinbase") return null;
    return {
      notBeforeTimestamp: decoded.args[0],
      validThroughBlock: decoded.args[1],
    };
  } catch {
    return null;
  }
}
