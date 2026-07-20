import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ActivityEntry } from "@dat-bot/shared";
import { appConfig } from "./config.js";
import { logger } from "./logger.js";
import { redactSensitiveText, sanitizeActivityEntry } from "./redaction.js";
import { writeFileAtomicDurableSync } from "./durability.js";

// Append-only activity log with an in-memory ring buffer, periodically flushed
// to a JSON file. Avoids a native DB dependency. Emits to subscribers (WS).

const MAX_ENTRIES = 2000;
const FLUSH_MS = 2000;

type Listener = (entry: ActivityEntry) => void;

class ActivityLog {
  private entries: ActivityEntry[] = [];
  private listeners = new Set<Listener>();
  private dirty = false;
  private file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "activity.json");
    this.load();
    setInterval(() => this.flush(), FLUSH_MS).unref();
  }

  private load(): void {
    let descriptor: number | null = null;
    let contents: string | null = null;
    try {
      const noFollow = process.platform === "win32"
        ? 0
        : (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
      descriptor = fs.openSync(this.file, fs.constants.O_RDONLY | noFollow);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) throw new Error("activity log path is not a regular file");
      // Historic releases could leave provider credentials in 0644 error
      // messages. Restrict the already-open file before reading any content.
      if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
        fs.fchmodSync(descriptor, 0o600);
      }
      contents = fs.readFileSync(descriptor, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`Could not securely load activity log: ${(err as Error).message}`, {
        cause: err,
      });
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
    }

    try {
      const parsed = JSON.parse(contents!) as unknown;
      if (!Array.isArray(parsed)) throw new Error("activity log root must be an array");
      this.entries = parsed.slice(-MAX_ENTRIES).flatMap((value) => {
        const entry = sanitizeActivityEntry(value);
        return entry === null ? [] : [entry];
      });
      // Rewrite legacy content synchronously. A short-lived process must not
      // leave the old credential-bearing payload waiting for the periodic timer.
      this.dirty = true;
      this.flush();
    } catch (err) {
      logger.warn("Could not sanitize activity log:", (err as Error).message);
    }
  }

  private flush(): void {
    if (!this.dirty) return;
    try {
      writeFileAtomicDurableSync(
        this.file,
        JSON.stringify(this.entries.slice(-MAX_ENTRIES)),
      );
      this.dirty = false;
    } catch (err) {
      logger.warn("Could not flush activity log:", (err as Error).message);
    }
  }

  add(entry: Omit<ActivityEntry, "id" | "ts">): ActivityEntry {
    const full: ActivityEntry = {
      id: randomUUID(),
      ts: Date.now(),
      ...entry,
      message: redactSensitiveText(entry.message),
    };
    this.entries.push(full);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    this.dirty = true;
    for (const l of this.listeners) {
      try {
        l(full);
      } catch {
        /* ignore listener errors */
      }
    }
    const label = `${entry.kind}/${entry.status}`;
    logger.info(`activity ${label}: ${full.message}`);
    return full;
  }

  /** Patch an existing entry (e.g. flip a submitted tx to included/reverted once
   *  its receipt lands) and re-emit it so subscribers upsert by id. */
  update(id: string, patch: Partial<Omit<ActivityEntry, "id" | "ts">>): ActivityEntry | null {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return null;
    Object.assign(entry, patch, patch.message === undefined
      ? {}
      : { message: redactSensitiveText(patch.message) });
    this.dirty = true;
    for (const l of this.listeners) {
      try {
        l(entry);
      } catch {
        /* ignore listener errors */
      }
    }
    logger.info(`activity update ${entry.kind}/${entry.status}: ${entry.message}`);
    return entry;
  }

  recent(limit = 200): ActivityEntry[] {
    return this.entries.slice(-limit);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export const activity = new ActivityLog(appConfig.dataDir);
