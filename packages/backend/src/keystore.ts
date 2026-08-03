import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Encrypted keystore for the bot's hot-wallet private keys.
//
// Format v1: a single key, the whole file. Format v2: `{ version: 2, wallets: [...] }`,
// each entry the same v1 blob shape with its own salt and IV. Every entry is encrypted
// under the SAME passphrase — the keys all live on this machine anyway, so per-wallet
// passphrases would buy little and make unlocking N wallets painful — but each is
// encrypted independently, so a single blob leak exposes one key, not all of them.
//
// v1 files are read as a one-wallet v2 and only rewritten when a wallet is added or
// removed, so an existing install keeps working untouched.
//
// The plaintext private keys NEVER touch disk.

export interface KeystoreFileV1 {
  version: 1;
  kdf: "scrypt";
  kdfParams: { N: number; r: number; p: number; keyLen: number; salt: string };
  cipher: "aes-256-gcm";
  iv: string;
  authTag: string;
  ciphertext: string;
  address: string; // convenience only; not sensitive
  /** Human name for the wallet, e.g. "cold-1". Never sensitive. */
  label?: string;
}

/** Multi-wallet keystore. Each entry is an independently-encrypted v1 blob. */
export interface KeystoreFileV2 {
  version: 2;
  wallets: KeystoreFileV1[];
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
  saveWallets(dataDir, [file]);
}

/** Every wallet in the keystore, in order. A v1 file reads as a single wallet. */
export function loadWallets(dataDir: string): KeystoreFileV1[] {
  const p = keystorePath(dataDir);
  if (!fs.existsSync(p)) return [];
  const raw = JSON.parse(fs.readFileSync(p, "utf8")) as KeystoreFileV1 | KeystoreFileV2;
  if ((raw as KeystoreFileV2).version === 2) {
    return (raw as KeystoreFileV2).wallets ?? [];
  }
  return [raw as KeystoreFileV1];
}

export function saveWallets(dataDir: string, wallets: KeystoreFileV1[]): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file: KeystoreFileV2 = { version: 2, wallets };
  fs.writeFileSync(keystorePath(dataDir), JSON.stringify(file, null, 2), {
    mode: 0o600,
  });
}

/**
 * The first wallet — the "primary". It funds the coinbase bid (one bid buys position for
 * the whole bundle, so it comes from one wallet) and is the address shown when the app
 * needs a single identity. Kept for the call sites that legitimately want just one.
 */
export function loadKeystore(dataDir: string): KeystoreFileV1 | null {
  return loadWallets(dataDir)[0] ?? null;
}

/**
 * Check a passphrase against the existing keystore by actually decrypting the first
 * wallet. Adding a wallet has to verify this: entries are independently encrypted, so a
 * mismatched passphrase would silently produce a keystore that no single passphrase can
 * fully unlock — discovered only at the next unlock, with a wallet stranded.
 */
export function passphraseMatches(dataDir: string, passphrase: string): boolean {
  const first = loadWallets(dataDir)[0];
  if (!first) return true; // nothing to match yet
  try {
    decryptPrivateKey(first, passphrase);
    return true;
  } catch {
    return false;
  }
}

/** Constant-time compare helper for confirmation checks. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
