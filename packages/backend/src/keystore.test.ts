import { describe, it, expect } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { encryptPrivateKey, decryptPrivateKey } from "./keystore.js";

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
