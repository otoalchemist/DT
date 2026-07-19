import fs from "node:fs";
import path from "node:path";

let atomicWriteSequence = 0;

/** The rename completed, so the visible file is the new version, but the final
 * directory fsync failed and crash persistence could not be confirmed. Callers
 * must treat the new state as committed in-process while failing closed. */
export class AtomicWriteCommittedError extends Error {
  readonly committed = true;

  constructor(readonly filePath: string, options: { cause: unknown }) {
    super(`Atomic write committed for ${filePath}, but directory durability could not be confirmed: ${
      options.cause instanceof Error ? options.cause.message : String(options.cause)
    }`, options);
    this.name = "AtomicWriteCommittedError";
  }
}

/**
 * Flush a containing directory after an atomic rename where the platform
 * supports opening directories as file descriptors. Windows does not expose
 * that operation through Node, so file contents are still fsynced and the
 * rename remains atomic, but the directory flush is skipped there.
 */
export function fsyncDirectorySync(directoryPath: string): void {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directoryPath, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Create a directory tree and durably link every newly created level into its
 * parent. Fsyncing only the final directory is insufficient when that directory
 * itself did not exist before the write.
 */
export function ensureDirectoryDurableSync(directoryPath: string): void {
  const resolved = path.resolve(directoryPath);
  const missing: string[] = [];
  let cursor = resolved;
  while (!fs.existsSync(cursor)) {
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;

  // Parents must be made durable before their children can be relied upon.
  for (const created of missing.reverse()) {
    fsyncDirectorySync(created);
    fsyncDirectorySync(path.dirname(created));
  }
}

/** Write, fsync, and atomically replace one file. Errors before rename leave the
 * old file intact; errors after rename are reported with an explicit committed
 * outcome so callers never roll their in-memory state back incorrectly. */
export function writeFileAtomicDurableSync(
  filePath: string,
  contents: string | NodeJS.ArrayBufferView,
  mode = 0o600,
): void {
  const directory = path.dirname(filePath);
  ensureDirectoryDurableSync(directory);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${++atomicWriteSequence}.tmp`,
  );
  let descriptor: number | null = null;
  let renamed = false;
  try {
    descriptor = fs.openSync(temporary, "wx", mode);
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, filePath);
    renamed = true;
    fsyncDirectorySync(directory);
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (!renamed) {
      try { fs.unlinkSync(temporary); } catch {}
      throw error;
    }
    if (error instanceof AtomicWriteCommittedError) throw error;
    throw new AtomicWriteCommittedError(filePath, { cause: error });
  }
}
