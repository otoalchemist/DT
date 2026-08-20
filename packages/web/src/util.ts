export function weiToEth(wei: string | null | undefined, digits = 4): string {
  if (wei == null) return "—";
  const v = Number(BigInt(wei)) / 1e18;
  return v.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function shortAddr(a: string | null | undefined): string {
  if (!a) return "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function countdown(seconds: number | null, withSeconds = false): string {
  if (seconds == null) return "—";
  const neg = seconds < 0;
  let s = Math.abs(seconds);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const label = withSeconds
    ? h > 0
      ? `${h}h ${m}m ${s}s`
      : m > 0
        ? `${m}m ${s}s`
        : `${s}s`
    : h > 0
      ? `${h}h ${m}m`
      : `${m}m`;
  return neg ? `expired ${label} ago` : label;
}

export function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export const gameStateLabel = (n: number | null): string =>
  n === 0 ? "Configuring" : n === 1 ? "Live" : n === 2 ? "Ended" : "—";

/**
 * Exact wei → ETH decimal string.
 *
 * `weiToEth` above routes through a float, which is fine for a balance readout but not
 * for a ledger that has to reconcile to the wei — 0.11661 ETH does not survive the trip.
 * This one stays in bigint the whole way.
 */
export function weiToEthExact(wei: string | null | undefined, maxDigits = 5): string {
  if (wei == null) return "—";
  let v: bigint;
  try {
    v = BigInt(wei);
  } catch {
    return "—";
  }
  const neg = v < 0n;
  if (neg) v = -v;
  const whole = (v / 10n ** 18n).toString();
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").slice(0, maxDigits).replace(/0+$/, "");
  return `${neg ? "−" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Same, with an explicit sign — for a delta where "ahead" and "behind" both matter. */
export function weiToEthSigned(wei: string | null | undefined, maxDigits = 5): string {
  if (wei == null) return "—";
  const v = BigInt(wei);
  if (v === 0n) return "0";
  return `${v > 0n ? "+" : ""}${weiToEthExact(wei, maxDigits)}`;
}
