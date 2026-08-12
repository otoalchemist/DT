import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  decryptPrivateKey,
  decryptPrivateKeyAsync,
  encryptPrivateKey,
  encryptPrivateKeyAsync,
  keystorePath,
  loadWallets,
  normalizePrivateKey,
  saveWallets,
} from "./keystore.js";

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

  it("round-trips through the non-blocking scrypt variants", async () => {
    const pk = generatePrivateKey();
    const address = privateKeyToAccount(pk).address;
    const file = await encryptPrivateKeyAsync(pk, "worker-pool-passphrase", address);
    await expect(decryptPrivateKeyAsync(file, "worker-pool-passphrase")).resolves.toBe(pk);
  });

  it("atomically writes mode-0600 files in a mode-0700 directory with a backup", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-keystore-test-"));
    try {
      const firstKey = generatePrivateKey();
      const first = encryptPrivateKey(
        firstKey,
        "backup-passphrase",
        privateKeyToAccount(firstKey).address,
      );
      saveWallets(dir, [first]);
      const firstContents = fs.readFileSync(keystorePath(dir), "utf8");

      // Simulate a permissive pre-existing file; the next operation must tighten it.
      fs.chmodSync(keystorePath(dir), 0o644);
      expect(loadWallets(dir)).toHaveLength(1);
      expect(fs.statSync(keystorePath(dir)).mode & 0o777).toBe(0o600);

      const secondKey = generatePrivateKey();
      const second = encryptPrivateKey(
        secondKey,
        "backup-passphrase",
        privateKeyToAccount(secondKey).address,
      );
      saveWallets(dir, [first, second]);

      expect(fs.readFileSync(`${keystorePath(dir)}.bak`, "utf8")).toBe(firstContents);
      expect(fs.statSync(keystorePath(dir)).mode & 0o777).toBe(0o600);
      expect(fs.statSync(`${keystorePath(dir)}.bak`).mode & 0o777).toBe(0o600);
      if (process.platform !== "win32") {
        expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      }
      expect(fs.readdirSync(dir).some((name) => name.endsWith(".tmp"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
