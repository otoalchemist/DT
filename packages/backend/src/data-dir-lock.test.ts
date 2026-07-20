import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireDataDirLock,
  DataDirLockedError,
  type DataDirLock,
} from "./data-dir-lock.js";

describe("DATA_DIR process lock", () => {
  let dataDir: string;
  let held: DataDirLock | null;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-data-lock-"));
    held = null;
  });

  afterEach(() => {
    try { held?.release(); } catch {}
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("fails closed while another live process owner holds the DATA_DIR", () => {
    held = acquireDataDirLock(dataDir);

    expect(() => acquireDataDirLock(dataDir)).toThrow(DataDirLockedError);
    expect(() => acquireDataDirLock(dataDir)).toThrow(/one bot process per DATA_DIR/);
  });

  it("releases only its owned token and permits a subsequent process", () => {
    held = acquireDataDirLock(dataDir);
    const lockPath = held.path;
    expect(fs.existsSync(lockPath)).toBe(true);

    held.release();
    held = null;
    expect(fs.existsSync(lockPath)).toBe(false);

    const next = acquireDataDirLock(dataDir);
    next.release();
  });

  it("atomically quarantines a dead same-host owner before acquiring", () => {
    const stalePath = path.join(dataDir, ".dt-process.lock");
    fs.mkdirSync(stalePath);
    fs.writeFileSync(path.join(stalePath, "owner.json"), JSON.stringify({
      pid: 2_147_483_647,
      hostname: os.hostname(),
      token: "dead-owner",
      acquiredAtMs: 1,
    }));

    held = acquireDataDirLock(dataDir);

    expect(fs.existsSync(held.path)).toBe(true);
    expect(fs.readdirSync(dataDir).some((entry) =>
      entry.startsWith(".dt-process.lock.stale-"),
    )).toBe(true);
  });

  it("does not reclaim an owner from another host", () => {
    const lockPath = path.join(dataDir, ".dt-process.lock");
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: 2_147_483_647,
      hostname: "another-host.invalid",
      token: "remote-owner",
      acquiredAtMs: 1,
    }));

    expect(() => acquireDataDirLock(dataDir)).toThrow(DataDirLockedError);
  });

  it("never reclaims an ownerless lock even when its directory is ancient", () => {
    const lockPath = path.join(dataDir, ".dt-process.lock");
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, "creator-in-progress"), "still initializing");
    fs.utimesSync(lockPath, new Date(0), new Date(0));

    expect(() => acquireDataDirLock(dataDir)).toThrow(DataDirLockedError);
    expect(fs.readFileSync(path.join(lockPath, "creator-in-progress"), "utf8"))
      .toBe("still initializing");
    expect(fs.readdirSync(dataDir).some((entry) =>
      entry.startsWith(".dt-process.lock.stale-"),
    )).toBe(false);
  });

  it("fails closed on malformed owner metadata without replacing the lock", () => {
    const lockPath = path.join(dataDir, ".dt-process.lock");
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, "owner.json"), "{not-json");
    fs.utimesSync(lockPath, new Date(0), new Date(0));

    expect(() => acquireDataDirLock(dataDir)).toThrow(DataDirLockedError);
    expect(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")).toBe("{not-json");
    expect(fs.readdirSync(dataDir).some((entry) =>
      entry.startsWith(".dt-process.lock.stale-"),
    )).toBe(false);
  });
});
