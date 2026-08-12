import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

// Same idiom as strategy.test.ts: mock config so the real env-schema
// parse (which rejects vitest's MODE=test) never runs. dataDir is repointed per test.
vi.mock("./config.js", () => ({
  appConfig: { dataDir: `/tmp/dat-bot-list-cache-tests-${process.pid}` },
  loadSettings: vi.fn(() => ({})),
  saveSettings: vi.fn(),
  deriveUrlsFromKey: vi.fn(),
}));

vi.mock("./activity.js", () => ({ activity: { add: vi.fn() } }));

const { appConfig } = await import("./config.js");
const {
  loadAllyTokens,
  loadAllyTokensResult,
  loadAllyTokensStrict,
  loadDoNotTarget,
  invalidateListCache,
} = await import("./runtime.js");

/**
 * The curated lists are cached in memory and invalidated on the file's mtime+size, because
 * they sit on the hot path: fetchOffenseCandidates reads the ally and do-not-target lists
 * on every offense sweep (once per block with a WebSocket) and readTargets reads them again
 * on every dashboard poll, each a synchronous readFileSync + JSON.parse.
 *
 * The risk the cache introduces is staleness: these files are meant to be user-editable, so
 * a cached parse that outlived its file would mean the bot auditing a token the user just
 * added to the ally list. These tests pin that it doesn't.
 */
describe("list cache: serves repeat reads without re-parsing, but never goes stale", () => {
  let tmpDir: string;
  let priorDataDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "dat-listcache-"));
    priorDataDir = (appConfig as { dataDir: string }).dataDir;
    (appConfig as { dataDir: string }).dataDir = tmpDir;
    invalidateListCache();
  });

  afterEach(() => {
    (appConfig as { dataDir: string }).dataDir = priorDataDir;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    invalidateListCache();
    vi.restoreAllMocks();
  });

  const writeAllies = (ids: string[]) =>
    fs.writeFileSync(nodePath.join(tmpDir, "ally-tokens.json"), JSON.stringify(ids));

  it("reads the file once for repeated calls with no change in between", () => {
    writeAllies(["84", "99"]);
    const spy = vi.spyOn(fs, "readFileSync");
    expect(loadAllyTokens()).toEqual(["84", "99"]);
    const afterFirst = spy.mock.calls.length;
    // Simulates the per-block offense sweep hitting the same list repeatedly.
    for (let i = 0; i < 25; i++) expect(loadAllyTokens()).toEqual(["84", "99"]);
    expect(spy.mock.calls.length).toBe(afterFirst); // no further reads
  });

  it("picks up an edit immediately — a new ally must never be audited", () => {
    writeAllies(["84"]);
    expect(loadAllyTokens()).toEqual(["84"]);
    // A hand edit. Size changes here, so the key moves even if the
    // filesystem's mtime resolution is coarse.
    writeAllies(["84", "99", "100"]);
    expect(loadAllyTokens()).toEqual(["84", "99", "100"]);
  });

  it("picks up a same-size edit, where only mtime moves", () => {
    // The dangerous case for an mtime+size key: swapping one id for another of equal
    // length. If this were missed, the bot would audit the newly-listed ally.
    writeAllies(["84", "99"]);
    expect(loadAllyTokens()).toEqual(["84", "99"]);
    const p = nodePath.join(tmpDir, "ally-tokens.json");
    const before = fs.statSync(p);
    writeAllies(["84", "77"]);
    // Force a distinct mtime so the test doesn't depend on sub-ms filesystem resolution;
    // in production a rewrite and a re-read are never in the same millisecond.
    fs.utimesSync(p, before.atime, new Date(before.mtimeMs + 1000));
    expect(loadAllyTokens()).toEqual(["84", "77"]);
  });

  it("returns empty for a missing file, then sees it once created", () => {
    expect(loadAllyTokens()).toEqual([]);
    expect(loadAllyTokensResult()).toMatchObject({ ok: false });
    expect(() => loadAllyTokensStrict()).toThrow(/refusing automated offense/);
    writeAllies(["84"]);
    expect(loadAllyTokens()).toEqual(["84"]);
    expect(loadAllyTokensStrict()).toEqual(["84"]);
  });

  it("keeps dashboard reads available but blocks offense on malformed JSON", () => {
    fs.writeFileSync(nodePath.join(tmpDir, "ally-tokens.json"), "{ not json");
    expect(loadAllyTokens()).toEqual([]);
    expect(loadAllyTokensResult()).toMatchObject({ ok: false });
    expect(() => loadAllyTokensStrict()).toThrow(/refusing automated offense/);
  });

  it("blocks offense when the roster path cannot be read as a file", () => {
    fs.mkdirSync(nodePath.join(tmpDir, "ally-tokens.json"));
    expect(loadAllyTokensResult()).toMatchObject({ ok: false });
    expect(() => loadAllyTokensStrict()).toThrow(/refusing automated offense/);
  });

  it("blocks offense when the roster has an invalid token id", () => {
    writeAllies(["84", "0084"]);
    expect(loadAllyTokens()).toEqual([]);
    expect(() => loadAllyTokensStrict()).toThrow(/invalid token list/);
  });

  it("canonicalizes and de-duplicates a valid hard-safety roster", () => {
    writeAllies(["84", " 99 ", "84"]);
    expect(loadAllyTokensStrict()).toEqual(["84", "99"]);
  });

  it("caches the DERIVED do-not-target shape, not just the parse", () => {
    fs.writeFileSync(
      nodePath.join(tmpDir, "do-not-target.json"),
      JSON.stringify({ owners: { Graveyard: ["4335", "909"], Hedo: ["1575"] } }),
    );
    const first = loadDoNotTarget();
    expect(first.tokenIds).toEqual(["4335", "909", "1575"]);
    // Same object identity => the normalize + dedupe was memoized, not redone.
    expect(loadDoNotTarget()).toBe(first);
  });

  it("de-duplicates a do-not-target id listed under two operators", () => {
    fs.writeFileSync(
      nodePath.join(tmpDir, "do-not-target.json"),
      JSON.stringify({ owners: { A: ["4335", "909"], B: ["4335"] } }),
    );
    expect(loadDoNotTarget().tokenIds).toEqual(["4335", "909"]);
  });

  it("re-derives do-not-target after the file changes", () => {
    const p = nodePath.join(tmpDir, "do-not-target.json");
    fs.writeFileSync(p, JSON.stringify({ owners: { A: ["4335"] } }));
    expect(loadDoNotTarget().tokenIds).toEqual(["4335"]);
    fs.writeFileSync(p, JSON.stringify({ owners: { A: ["4335"], B: ["711", "796"] } }));
    expect(loadDoNotTarget().tokenIds).toEqual(["4335", "711", "796"]);
  });

  it("survives a do-not-target file with no owners key", () => {
    fs.writeFileSync(nodePath.join(tmpDir, "do-not-target.json"), JSON.stringify({}));
    expect(loadDoNotTarget()).toEqual({ tokenIds: [], owners: {} });
  });
});
