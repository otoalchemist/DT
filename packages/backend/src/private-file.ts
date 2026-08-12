import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function fsyncDirectory(directory: string): void {
  // Opening directories is supported on POSIX. Windows may reject it, but rename is
  // still atomic there and file modes are advisory, so treat this as best effort.
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

export function tightenPrivateFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Refusing non-regular private file: ${filePath}`);
  }
  fs.chmodSync(filePath, 0o600);
}

function replaceAtomically(filePath: string, contents: string | Buffer): void {
  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
    fsyncDirectory(directory);
  } catch (error) {
    if (fd !== null) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch { /* not created or already renamed */ }
    throw error;
  }
}

/**
 * Persist a secret-bearing file with restrictive modes and an atomic same-directory
 * rename. When requested, the previous complete file is first copied to `.bak` using
 * the same atomic process so interrupted keystore replacements remain recoverable.
 */
export function writePrivateFileAtomic(
  filePath: string,
  contents: string | Buffer,
  options: { backup?: boolean } = {},
): void {
  const directory = path.dirname(filePath);
  ensurePrivateDirectory(directory);

  if (fs.existsSync(filePath)) {
    tightenPrivateFile(filePath);
    if (options.backup) {
      replaceAtomically(`${filePath}.bak`, fs.readFileSync(filePath));
    }
  }
  replaceAtomically(filePath, contents);
}
