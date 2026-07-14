import fs from "node:fs";
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
  private listeners = new Set<Listener>();
  private dirty = false;
  private file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "activity.json");
    this.load();
    setInterval(() => this.flush(), FLUSH_MS).unref();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.file)) {
        this.entries = JSON.parse(fs.readFileSync(this.file, "utf8"));
      }
    } catch (err) {
      logger.warn("Could not load activity log:", (err as Error).message);
    }
  }

  private flush(): void {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.entries.slice(-MAX_ENTRIES)));
      this.dirty = false;
    } catch (err) {
      logger.warn("Could not flush activity log:", (err as Error).message);
    }
  }

  add(entry: Omit<ActivityEntry, "id" | "ts">): ActivityEntry {
    const full: ActivityEntry = { id: randomUUID(), ts: Date.now(), ...entry };
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
    logger.info(`activity ${label}: ${entry.message}`);
    return full;
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
