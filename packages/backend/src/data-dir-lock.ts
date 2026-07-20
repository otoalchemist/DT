import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDirectoryDurableSync, fsyncDirectorySync } from "./durability.js";

interface LockOwner {
  pid: number;
  hostname: string;
  token: string;
  acquiredAtMs: number;
}

export interface DataDirLock {
  readonly path: string;
  release(): void;
}

export class DataDirLockedError extends Error {
  constructor(readonly lockPath: string, owner?: Partial<LockOwner>) {
    const identity = owner?.pid === undefined
      ? "an unreadable owner"
      : `pid ${owner.pid}${owner.hostname ? ` on ${owner.hostname}` : ""}`;
    super(
      `DATA_DIR is already locked by ${identity}: ${lockPath}. `
      + "Run only one bot process per DATA_DIR; remove the lock only after verifying that owner is stopped.",
    );
    this.name = "DataDirLockedError";
  }
}

const LOCK_DIRECTORY = ".dt-process.lock";
const OWNER_FILE = "owner.json";

function isLockOwner(value: unknown): value is LockOwner {
  if (!value || typeof value !== "object") return false;
  const owner = value as Partial<LockOwner>;
  return Number.isSafeInteger(owner.pid)
    && (owner.pid ?? 0) > 0
    && typeof owner.hostname === "string"
    && owner.hostname.length > 0
    && typeof owner.token === "string"
    && owner.token.length > 0
    && typeof owner.acquiredAtMs === "number"
    && Number.isFinite(owner.acquiredAtMs);
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(lockPath, OWNER_FILE), "utf8"));
    return isLockOwner(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function localProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Permission denial proves the process exists even if it is owned by
    // another user. Unknown failures fail closed as live.
    return code !== "ESRCH";
  }
}

function lockCanBeReclaimed(owner: LockOwner | null): boolean {
  // An absent/unreadable owner can be a live process paused between the atomic
  // mkdir and its owner-file fsync. Reclaiming that pathname would let the
  // original creator resume into a successor's lock, so malformed locks always
  // require explicit operator intervention.
  if (!owner) return false;
  // A lock created on another host cannot be safely probed with a local PID.
  if (owner.hostname !== os.hostname()) return false;
  return !localProcessAlive(owner.pid);
}

function quarantineStaleLock(dataDir: string, lockPath: string): boolean {
  const quarantinePath = path.join(
    dataDir,
    `${LOCK_DIRECTORY}.stale-${Date.now()}-${randomUUID()}`,
  );
  try {
    fs.renameSync(lockPath, quarantinePath);
    fsyncDirectorySync(dataDir);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Acquire exclusive ownership of every mutable artifact under DATA_DIR. The
 * atomic directory creation is cross-platform and stale same-host locks are
 * quarantined rather than deleted, preserving crash evidence for operators. */
export function acquireDataDirLock(dataDir: string): DataDirLock {
  const resolvedDataDir = path.resolve(dataDir);
  ensureDirectoryDurableSync(resolvedDataDir);
  const lockPath = path.join(resolvedDataDir, LOCK_DIRECTORY);
  const token = randomUUID();
  const owner: LockOwner = {
    pid: process.pid,
    hostname: os.hostname(),
    token,
    acquiredAtMs: Date.now(),
  };

  for (;;) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readOwner(lockPath);
      if (!lockCanBeReclaimed(existing)) {
        throw new DataDirLockedError(lockPath, existing ?? undefined);
      }
      // Atomic rename prevents two contenders from deleting or replacing one
      // another's newly acquired lock during stale-owner recovery.
      if (!quarantineStaleLock(resolvedDataDir, lockPath)) continue;
    }
  }

  const ownerPath = path.join(lockPath, OWNER_FILE);
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(ownerPath, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(owner, null, 2));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fsyncDirectorySync(lockPath);
    fsyncDirectorySync(resolvedDataDir);
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    // We exclusively created this exact directory and have not returned the
    // token, so rolling it back cannot remove another process's lock.
    try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch {}
    throw error;
  }

  let released = false;
  return {
    path: lockPath,
    release(): void {
      if (released) return;
      const current = readOwner(lockPath);
      if (!current || current.token !== token) {
        throw new DataDirLockedError(lockPath, current ?? undefined);
      }
      const releasePath = path.join(
        resolvedDataDir,
        `${LOCK_DIRECTORY}.released-${token}`,
      );
      fs.renameSync(lockPath, releasePath);
      released = true;
      fs.rmSync(releasePath, { recursive: true, force: true });
      fsyncDirectorySync(resolvedDataDir);
    },
  };
}
