import { describe, it, expect } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { encryptPrivateKey, decryptPrivateKey, normalizePrivateKey } from "./keystore.js";

describe("keystore encryption", () => {
  it("round-trips a private key with the correct passphrase", () => {
    const pk = generatePrivateKey();
    const address = privateKeyToAccount(pk).address;
    const file = encryptPrivateKey(pk, "correct horse battery staple", address);

    expect(file.ciphertext).not.toContain(pk.replace(/^0x/, ""));
    const recovered = decryptPrivateKey(file, "correct horse battery staple");
    expect(recovered.toLowerCase()).toBe(pk.toLowerCase());
    expect(privateKeyToAccount(recovered).address).toBe(address);
  });

  it("throws on an incorrect passphrase (GCM auth tag mismatch)", () => {
    const pk = generatePrivateKey();
    const address = privateKeyToAccount(pk).address;
    const file = encryptPrivateKey(pk, "right-pass-123", address);
    expect(() => decryptPrivateKey(file, "wrong-pass-123")).toThrow();
  });

  it("uses a fresh salt + iv each time", () => {
    const pk = generatePrivateKey();
    const address = privateKeyToAccount(pk).address;
    const a = encryptPrivateKey(pk, "pass", address);
    const b = encryptPrivateKey(pk, "pass", address);
    expect(a.kdfParams.salt).not.toBe(b.kdfParams.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
});

describe("normalizePrivateKey", () => {
  const bare = "a".repeat(64);

  it("accepts a bare 64-hex key and adds the 0x prefix", () => {
    expect(normalizePrivateKey(bare)).toBe(`0x${bare}`);
  });

  it("accepts an already-0x-prefixed key unchanged", () => {
    expect(normalizePrivateKey(`0x${bare}`)).toBe(`0x${bare}`);
  });

  it("trims whitespace, lowercases, and tolerates a 0X prefix", () => {
    expect(normalizePrivateKey(`  0X${"A".repeat(64)}\n`)).toBe(`0x${bare}`);
  });

  it("produces the same account whether or not the 0x prefix is supplied", () => {
    const pk = generatePrivateKey(); // 0x + 64 hex
    const withoutPrefix = pk.slice(2);
    expect(normalizePrivateKey(withoutPrefix)).toBe(pk.toLowerCase());
    expect(privateKeyToAccount(normalizePrivateKey(withoutPrefix)!).address).toBe(
      privateKeyToAccount(pk).address,
    );
  });

  it("rejects wrong length or non-hex input", () => {
    expect(normalizePrivateKey("0x1234")).toBeNull(); // too short
    expect(normalizePrivateKey("z".repeat(64))).toBeNull(); // not hex
    expect(normalizePrivateKey(`0x${bare}ff`)).toBeNull(); // too long
    expect(normalizePrivateKey("")).toBeNull();
  });
});
