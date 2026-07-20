import { parseEther } from "viem";

/** Keep number-backed configuration inside a range whose gwei→wei conversion
 * remains an exact, finite JavaScript integer before it becomes bigint. */
export const MAX_CONFIG_GWEI = 9_000_000;
export const MAX_CONFIG_ETH = 1_000_000;

/** Expand JavaScript's canonical scientific notation without changing its
 * represented decimal value. viem intentionally rejects exponent notation. */
export function numberToPlainDecimal(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("amount must be a finite non-negative number");
  }
  const text = value.toString();
  if (!/[eE]/.test(text)) return text;
  const [mantissa, exponentText] = text.toLowerCase().split("e");
  const exponent = Number(exponentText);
  if (mantissa === undefined || !Number.isInteger(exponent)) {
    throw new Error("amount has invalid exponent notation");
  }
  const [whole, fraction = ""] = mantissa.split(".");
  if (whole === undefined || !/^\d+$/.test(whole) || !/^\d*$/.test(fraction)) {
    throw new Error("amount has invalid decimal notation");
  }
  const digits = `${whole}${fraction}`;
  const decimalIndex = whole.length + exponent;
  if (decimalIndex <= 0) return `0.${"0".repeat(-decimalIndex)}${digits}`;
  if (decimalIndex >= digits.length) {
    return `${digits}${"0".repeat(decimalIndex - digits.length)}`;
  }
  return `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

/** Convert validated number-backed ETH settings, including values such as
 * 1e-7, without passing exponent notation to parseEther. */
export function configuredEthToWei(value: number): bigint {
  const wei = parseEther(numberToPlainDecimal(value));
  if (value > 0 && wei === 0n) {
    throw new Error("nonzero ETH amount is smaller than one wei");
  }
  return wei;
}

/** Preserve the existing nearest-wei behavior for gwei knobs, after schema
 * bounds guarantee the scaled value is finite and safely integral. */
export function configuredGweiToWei(value: number): bigint {
  if (!Number.isFinite(value) || value < 0 || value > MAX_CONFIG_GWEI) {
    throw new Error(`gwei amount must be between 0 and ${MAX_CONFIG_GWEI}`);
  }
  return BigInt(Math.round(value * 1e9));
}
