import { describe, it, expect } from "vitest";
import { normalizeAlchemyKey } from "@dat-bot/shared";

/**
 * The key is interpolated into three URLs, so anything unexpected in it yields a malformed URL
 * and viem's transport throws — which reached a user as a bare HTTP 500 the moment they saved
 * their key, with the cause only in a server log they were never told to read.
 *
 * Every case below is a paste artefact rather than user error, which is the point: Alchemy's
 * dashboard presents the whole https endpoint with a copy button, and copying from a terminal or
 * a notes app drags in whitespace and quotes.
 */
describe("normalizeAlchemyKey", () => {
  const KEY = "abc123XYZ_-def456";

  it("passes a bare key through untouched", () => {
    expect(normalizeAlchemyKey(KEY)).toBe(KEY);
  });

  it("extracts the key from a pasted https endpoint — the likeliest mistake", () => {
    // Without this the derived URL becomes .../v2/https://eth-mainnet.g.alchemy.com/v2/KEY
    expect(normalizeAlchemyKey(`https://eth-mainnet.g.alchemy.com/v2/${KEY}`)).toBe(KEY);
  });

  it("extracts it from the websocket and NFT forms too", () => {
    expect(normalizeAlchemyKey(`wss://eth-mainnet.g.alchemy.com/v2/${KEY}`)).toBe(KEY);
    expect(normalizeAlchemyKey(`https://eth-mainnet.g.alchemy.com/nft/v3/${KEY}`)).toBe(KEY);
  });

  it("survives a trailing slash, whitespace and a newline", () => {
    expect(normalizeAlchemyKey(`  ${KEY}  `)).toBe(KEY);
    expect(normalizeAlchemyKey(`${KEY}\n`)).toBe(KEY);
    expect(normalizeAlchemyKey(`https://eth-mainnet.g.alchemy.com/v2/${KEY}/`)).toBe(KEY);
  });

  it("strips quotes a shell or editor added", () => {
    expect(normalizeAlchemyKey(`"${KEY}"`)).toBe(KEY);
    expect(normalizeAlchemyKey(`'${KEY}'`)).toBe(KEY);
  });

  it("rejects anything that would corrupt a URL, so the caller can answer 400", () => {
    // Each of these previously sailed through and broke a URL somewhere downstream.
    expect(normalizeAlchemyKey("")).toBeNull();
    expect(normalizeAlchemyKey("   ")).toBeNull();
    expect(normalizeAlchemyKey("key with spaces")).toBeNull();
    expect(normalizeAlchemyKey("key/with/slashes")).toBeNull();
    expect(normalizeAlchemyKey("key?query=1")).toBeNull();
    expect(normalizeAlchemyKey("https://example.com/not-alchemy")).toBeNull();
  });

  it("does not invent a key from a bare endpoint with nothing after /v2/", () => {
    expect(normalizeAlchemyKey("https://eth-mainnet.g.alchemy.com/v2/")).toBeNull();
  });
});
