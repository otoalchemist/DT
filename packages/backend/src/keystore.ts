import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicDurableSync } from "./durability.js";

// Encrypted keystore for the bot's hot-wallet private key.
// Format v1: scrypt(passphrase) -> 32-byte AES key; AES-256-GCM.
// The plaintext private key NEVER touches disk.

export interface KeystoreFileV1 {
  version: 1;
  kdf: "scrypt";
  kdfParams: { N: number; r: number; p: number; keyLen: number; salt: string };
  cipher: "aes-256-gcm";
  iv: string;
  authTag: string;
  ciphertext: string;
  address: string; // convenience only; not sensitive
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keyLen: 32 };

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, SCRYPT.keyLen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 256 * 1024 * 1024,
  });
}

/**
 * Normalize an imported private key. Accepts 64 hex chars **with or without** a
 * `0x` prefix (and surrounding whitespace), returning a `0x`-prefixed lowercase
 * key — or `null` if it isn't a valid 32-byte hex key.
 */
export function normalizePrivateKey(raw: string): `0x${string}` | null {
  const hex = raw.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return `0x${hex.toLowerCase()}` as `0x${string}`;
}

/** Encrypts a 0x-prefixed private key with a passphrase. */
export function encryptPrivateKey(
  privateKey: string,
  passphrase: string,
  address: string,
): KeystoreFileV1 {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(privateKey.replace(/^0x/, ""), "hex")),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    version: 1,
    kdf: "scrypt",
    kdfParams: { ...SCRYPT, salt: salt.toString("hex") },
    cipher: "aes-256-gcm",
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
    address,
  };
}

/** Decrypts a keystore file; throws on wrong passphrase (auth tag mismatch). */
export function decryptPrivateKey(
  file: KeystoreFileV1,
  passphrase: string,
): `0x${string}` {
  const salt = Buffer.from(file.kdfParams.salt, "hex");
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(file.iv, "hex"),
  );
  decipher.setAuthTag(Buffer.from(file.authTag, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(file.ciphertext, "hex")),
    decipher.final(),
  ]);
  return ("0x" + plaintext.toString("hex")) as `0x${string}`;
}

export function keystorePath(dataDir: string): string {
  return path.join(dataDir, "wallet.keystore.json");
}

export function keystoreExists(dataDir: string): boolean {
  return fs.existsSync(keystorePath(dataDir));
}

export function saveKeystore(dataDir: string, file: KeystoreFileV1): void {
  writeFileAtomicDurableSync(
    keystorePath(dataDir),
    `${JSON.stringify(file, null, 2)}\n`,
  );
}

export function loadKeystore(dataDir: string): KeystoreFileV1 | null {
  const p = keystorePath(dataDir);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as KeystoreFileV1;
}

/** Constant-time compare helper for confirmation checks. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
