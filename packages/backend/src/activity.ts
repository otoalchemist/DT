import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ActivityEntry } from "@dat-bot/shared";
import { appConfig } from "./config.js";
import { logger } from "./logger.js";

// Append-only activity log with an in-memory ring buffer, periodically flushed
// to a JSON file. Avoids a native DB dependency. Emits to subscribers (WS).

const MAX_ENTRIES = 2000;
const FLUSH_MS = 2000;

type Listener = (entry: ActivityEntry) => void;

class ActivityLog {
  private entries: ActivityEntry[] = [];
  /** id -> entry, so update() is O(1) instead of a linear scan of all 2000 entries.
   *  Receipt tracking calls update() twice per submitted tx, and a boundary bundle can
   *  hold a dozen, so the scan ran in exactly the window a race can least afford it. */
  private byId = new Map<string, ActivityEntry>();
  private listeners = new Set<Listener>();
  private dirty = false;
  /** A flush is in flight. Writes are async now, so without this a slow disk could
   *  overlap two writes onto the same file and interleave their bytes. */
  private writing = false;
  private file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "activity.json");
    this.load();
    setInterval(() => void this.flush(), FLUSH_MS).unref();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      // Guard the shape: a truncated/corrupt file previously became `entries` verbatim,
      // so a non-array would make every later .push/.slice throw on the hot path.
      if (!Array.isArray(parsed)) {
        logger.warn("Activity log is not an array; starting a fresh one.");
        return;
      }
      // Trim on load as well as on add — a file written by an older build with a larger
      // cap would otherwise stay oversized until enough new entries pushed it down.
      this.entries = parsed.slice(-MAX_ENTRIES);
      for (const e of this.entries) if (e && typeof e.id === "string") this.byId.set(e.id, e);
    } catch (err) {
      logger.warn("Could not load activity log:", (err as Error).message);
    }
  }

  /**
   * Persist the log. ASYNC on purpose.
   *
   * This used to be a synchronous ~838 KB `writeFileSync` of the whole 2000-entry log
   * every 2 seconds while the bot was active (measured: 1.4 ms just to serialize, plus the
   * write). That blocked the event loop in a process whose entire job is winning
   * sub-second boundary races — and since `add()` is called while queueing a race bundle,
   * the flush could land inside the exact window it needed to be submitting in.
   *
   * Still a whole-file rewrite: the log is a ring buffer, so an append-only format would
   * need its own compaction, and 838 KB off the hot path is cheap. What matters is that it
   * no longer stalls the loop.
   */
  private async flush(): Promise<void> {
    if (!this.dirty || this.writing) return;
    this.writing = true;
    // Cleared BEFORE the await: an entry added while the write is in flight must mark the
    // log dirty again rather than being swallowed by a clear that happens afterwards.
    this.dirty = false;
    const payload = JSON.stringify(this.entries.slice(-MAX_ENTRIES));
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      await fsp.writeFile(this.file, payload);
    } catch (err) {
      this.dirty = true; // failed — retry on the next interval rather than losing the log
      logger.warn("Could not flush activity log:", (err as Error).message);
    } finally {
      this.writing = false;
    }
  }

  /** Flush synchronously, for shutdown — the async interval flush may not get a turn
   *  before the process exits, which would drop the last few seconds of activity. */
  flushSync(): void {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.entries.slice(-MAX_ENTRIES)));
      this.dirty = false;
    } catch (err) {
      logger.warn("Could not flush activity log on shutdown:", (err as Error).message);
    }
  }

  add(entry: Omit<ActivityEntry, "id" | "ts">): ActivityEntry {
    const full: ActivityEntry = { id: randomUUID(), ts: Date.now(), ...entry };
    this.entries.push(full);
    this.byId.set(full.id, full);
    if (this.entries.length > MAX_ENTRIES) {
      // Drop the evicted entries from the index too, or it grows without bound for the
      // lifetime of the process (a long run evicts far more than it keeps).
      const evicted = this.entries.splice(0, this.entries.length - MAX_ENTRIES);
      for (const e of evicted) this.byId.delete(e.id);
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
    logger.info(`activity ${label}: ${entry.message}`);
    return full;
  }

  /** Patch an existing entry (e.g. flip a submitted tx to included/reverted once
   *  its receipt lands) and re-emit it so subscribers upsert by id. */
  update(id: string, patch: Partial<Omit<ActivityEntry, "id" | "ts">>): ActivityEntry | null {
    const entry = this.byId.get(id);
    if (!entry) return null;
    Object.assign(entry, patch);
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
