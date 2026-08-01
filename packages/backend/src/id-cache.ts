// Stale-while-revalidate cache for a list keyed by a string. Serves the cached
// value instantly and refreshes it in the background once it's older than
// `ttlMs`; only a cold lookup (empty cache or a changed key) awaits the fetcher.
// Pure — no I/O or globals of its own — so it can be unit-tested directly and
// kept off the hot path of the engine tick (the Alchemy NFT API is slow).

export interface IdCacheOptions {
  onError?: (err: unknown) => void;
  /** Injectable clock (ms) for testing; defaults to Date.now. */
  clock?: () => number;
}

/**
 * Returns a lookup function `(key, ttlMs, fetcher) => Promise<T>`:
 *  - cache hit, fresh  → resolves the cached value immediately.
 *  - cache hit, stale  → resolves the cached value immediately AND kicks off a
 *                        background refresh (never blocks the caller).
 *  - cache miss / new key → awaits the fetcher once (concurrent callers share it).
 * On a background refresh error the previous value is kept; a cold-miss error
 * rejects (the caller decides how to degrade).
 */
export function makeIdCache<T>(opts: IdCacheOptions = {}) {
  const clock = opts.clock ?? (() => Date.now());
  const onError = opts.onError;
  let entry: { key: string; value: T; at: number } | null = null;
  let inflight: { key: string; p: Promise<T> } | null = null;

  const refresh = (key: string, fetcher: () => Promise<T>): Promise<T> => {
    if (inflight && inflight.key === key) return inflight.p; // dedupe concurrent fetches
    const p = fetcher()
      .then((value) => {
        entry = { key, value, at: clock() };
        return value;
      })
      .catch((err) => {
        onError?.(err);
        if (entry && entry.key === key) return entry.value; // keep the last good value
        throw err;
      })
      .finally(() => {
        if (inflight && inflight.key === key) inflight = null;
      });
    inflight = { key, p };
    return p;
  };

  const read = (key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> => {
    if (entry && entry.key === key) {
      if (clock() - entry.at >= ttlMs) void refresh(key, fetcher).catch(() => {}); // background
      return Promise.resolve(entry.value);
    }
    return refresh(key, fetcher);
  };

  // Drop the cached value so the next read fetches synchronously instead of serving
  // stale-while-revalidate. Needed by the dashboard's manual "Refresh data": a zero TTL
  // is NOT enough — SWR still returns the old value and only refreshes in the background,
  // so the user would see the same data they just asked to have re-read.
  read.invalidate = (): void => { entry = null; };
  return read;
}
