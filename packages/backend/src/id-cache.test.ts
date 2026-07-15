import { describe, it, expect, vi } from "vitest";
import { makeIdCache } from "./id-cache.js";

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe("makeIdCache (stale-while-revalidate)", () => {
  it("fetches on a cold miss, then serves the cached value within the TTL", async () => {
    let t = 0;
    const fetcher = vi.fn(async () => [1n, 2n]);
    const cache = makeIdCache<bigint[]>({ clock: () => t });

    expect(await cache("k", 1000, fetcher)).toEqual([1n, 2n]);
    expect(fetcher).toHaveBeenCalledTimes(1);

    t = 500; // still fresh
    expect(await cache("k", 1000, fetcher)).toEqual([1n, 2n]);
    expect(fetcher).toHaveBeenCalledTimes(1); // served from cache, no extra fetch
  });

  it("serves stale immediately and refreshes in the background once past the TTL", async () => {
    let t = 0;
    let n = 0;
    const fetcher = vi.fn(async () => [BigInt(++n)]);
    const cache = makeIdCache<bigint[]>({ clock: () => t });

    expect(await cache("k", 1000, fetcher)).toEqual([1n]);

    t = 1000; // now stale
    expect(await cache("k", 1000, fetcher)).toEqual([1n]); // stale value returned instantly
    await flush(); // background refresh completes
    expect(fetcher).toHaveBeenCalledTimes(2);

    // fresh again (refresh stamped at=clock()=1000) -> serves the refreshed value
    expect(await cache("k", 1000, fetcher)).toEqual([2n]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent cold fetches into a single call", async () => {
    let resolve!: (v: bigint[]) => void;
    const fetcher = vi.fn(() => new Promise<bigint[]>((r) => { resolve = r; }));
    const cache = makeIdCache<bigint[]>();

    const a = cache("k", 1000, fetcher);
    const b = cache("k", 1000, fetcher);
    resolve([9n]);
    expect(await a).toEqual([9n]);
    expect(await b).toEqual([9n]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps the last good value when a background refresh fails", async () => {
    let t = 0;
    let fail = false;
    const fetcher = vi.fn(async () => { if (fail) throw new Error("nope"); return [7n]; });
    const onError = vi.fn();
    const cache = makeIdCache<bigint[]>({ clock: () => t, onError });

    expect(await cache("k", 1000, fetcher)).toEqual([7n]);
    t = 2000; fail = true;
    expect(await cache("k", 1000, fetcher)).toEqual([7n]); // stale still served
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("rejects on a cold-miss error (caller decides how to degrade)", async () => {
    const fetcher = vi.fn(async () => { throw new Error("cold fail"); });
    const cache = makeIdCache<bigint[]>({ onError: () => {} });
    await expect(cache("k", 1000, fetcher)).rejects.toThrow("cold fail");
  });

  it("treats a changed key as a cold miss", async () => {
    const fetcher = vi.fn(async (k: string) => [BigInt(k.length)]);
    const cache = makeIdCache<bigint[]>();
    expect(await cache("aa", 1000, () => fetcher("aa"))).toEqual([2n]);
    expect(await cache("bbb", 1000, () => fetcher("bbb"))).toEqual([3n]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
