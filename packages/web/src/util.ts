export function weiToEth(wei: string | null | undefined, digits = 4): string {
  if (wei == null) return "—";
  const v = Number(BigInt(wei)) / 1e18;
  return v.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function shortAddr(a: string | null | undefined): string {
  if (!a) return "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function countdown(seconds: number | null): string {
  if (seconds == null) return "—";
  const neg = seconds < 0;
  let s = Math.abs(seconds);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  const label = h > 0 ? `${h}h ${m}m` : `${m}m`;
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
