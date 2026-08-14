import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

// Same idiom as strategy.test.ts: mock config so the real env-schema parse (which
// rejects vitest's MODE=test) never runs. dataDir is repointed per test.
vi.mock("./config.js", () => ({
  appConfig: { dataDir: "C:/dat-bot-test-scratch-nonexistent" },
  loadSettings: vi.fn(() => ({})),
  saveSettings: vi.fn(),
  deriveUrlsFromKey: vi.fn(),
}));

vi.mock("./activity.js", () => ({ activity: { add: vi.fn() } }));

const { appConfig } = await import("./config.js");
const { syncDefaultLists } = await import("./list-sync.js");

// The sync writes into the user's data/ folder, so every test here is really about the
// same question: under what circumstances is it allowed to replace a file? The three
// guards (git checkout, local edit, empty payload) each protect against a different way
// of destroying curation the user cares about, so each gets its own coverage.

const ALLIES = "ally-tokens.json";
const SKIPPERS = "rival-skippers.json";
const TARGETS = "rival-targets.json";
const MANIFEST = ".list-sync.json";

/** Remote payloads keyed by filename; anything unset 404s. */
let remote: Record<string, string>;
let tmpDir: string;
let priorDataDir: string;

const read = (f: string) => fs.readFileSync(nodePath.join(tmpDir, f), "utf8");
const write = (f: string, body: string) => fs.writeFileSync(nodePath.join(tmpDir, f), body);
// The sync writes the fetched bytes verbatim (see list-sync.ts), so "the local copy
// already matches master" means byte-identical to what the mock serves — hence this
// mirrors the mock's own encoding rather than pretty-printing.
const ids = (arr: string[]) => JSON.stringify(arr);

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.LIST_AUTO_UPDATE;
  tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "dat-listsync-"));
  priorDataDir = (appConfig as { dataDir: string }).dataDir;
  (appConfig as { dataDir: string }).dataDir = tmpDir;

  // Sane remote: every list present and non-empty.
  remote = {
    [ALLIES]: JSON.stringify(["84", "99"]),
    [SKIPPERS]: JSON.stringify(["206", "388"]),
    [TARGETS]: JSON.stringify(["206", "388", "553"]),
  };

  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const file = new URL(url).pathname.split("/").pop()!;
    if (!(file in remote)) return { ok: false, status: 404, text: async () => "" };
    return { ok: true, status: 200, text: async () => remote[file] };
  }));
});

afterEach(() => {
  (appConfig as { dataDir: string }).dataDir = priorDataDir;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  vi.unstubAllGlobals();
});

describe("syncDefaultLists: refreshing shipped lists", () => {
  it("replaces the shipped copy with the master copy on a fresh extract", async () => {
    // A fresh extract has the lists but no manifest — nothing to protect, so sync wins.
    write(ALLIES, ids(["1"]));
    const out = await syncDefaultLists();

    expect(JSON.parse(read(ALLIES))).toEqual(["84", "99"]);
    expect(out.find((o) => o.file === ALLIES)).toMatchObject({ result: "updated", ids: 2 });
  });

  it("creates a list that the carried-over data/ folder never had", async () => {
    // A data/ folder from before a list existed: no local file at all.
    await syncDefaultLists();
    expect(JSON.parse(read(ALLIES))).toEqual(["84", "99"]);
  });

  it("reports 'unchanged' when the local copy already matches master", async () => {
    write(SKIPPERS, ids(["206", "388"]));
    const out = await syncDefaultLists();
    expect(out.find((o) => o.file === SKIPPERS)).toMatchObject({ result: "unchanged" });
  });

  it("records hashes so the next run can tell a local edit from its own write", async () => {
    await syncDefaultLists();
    const manifest = JSON.parse(read(MANIFEST));
    expect(Object.keys(manifest).sort()).toEqual([ALLIES, SKIPPERS, TARGETS].sort());
  });
});

describe("syncDefaultLists: never overwrites the user's own curation", () => {
  it("keeps a file the user edited after we wrote it", async () => {
    await syncDefaultLists();               // establishes the manifest hash
    write(ALLIES, ids(["4242"]));           // user hand-edits their ally list
    remote[ALLIES] = JSON.stringify(["84", "99", "100"]); // master moves on

    const out = await syncDefaultLists();
    // Their edit stands: an ally list is a promise not to attack a teammate, and the
    // user's own roster outranks the shared default.
    expect(JSON.parse(read(ALLIES))).toEqual(["4242"]);
    expect(out.find((o) => o.file === ALLIES)).toMatchObject({ result: "local-edit" });
  });

  it("resumes syncing a file once the user's edit is reverted", async () => {
    await syncDefaultLists();
    write(ALLIES, ids(["4242"]));
    await syncDefaultLists();                       // skipped, manifest hash unchanged
    write(ALLIES, ids(["84", "99"]));               // reverted to what we last wrote
    remote[ALLIES] = JSON.stringify(["84", "99", "100"]);

    const out = await syncDefaultLists();
    expect(JSON.parse(read(ALLIES))).toEqual(["84", "99", "100"]);
    expect(out.find((o) => o.file === ALLIES)).toMatchObject({ result: "updated" });
  });

  it("skips everything in a git checkout, where lists are managed by git", async () => {
    // dataDir's parent holds .git in the repo layout.
    fs.mkdirSync(nodePath.join(nodePath.dirname(tmpDir), ".git"), { recursive: true });
    const gitParent = nodePath.join(nodePath.dirname(tmpDir), ".git");
    try {
      write(ALLIES, ids(["1"]));
      const out = await syncDefaultLists();
      expect(out).toEqual([]);
      expect(JSON.parse(read(ALLIES))).toEqual(["1"]); // untouched
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(gitParent, { recursive: true, force: true });
    }
  });

  it("syncs a git checkout anyway under LIST_AUTO_UPDATE=force", async () => {
    const gitParent = nodePath.join(nodePath.dirname(tmpDir), ".git");
    fs.mkdirSync(gitParent, { recursive: true });
    process.env.LIST_AUTO_UPDATE = "force";
    try {
      write(ALLIES, ids(["1"]));
      await syncDefaultLists();
      expect(JSON.parse(read(ALLIES))).toEqual(["84", "99"]);
    } finally {
      fs.rmSync(gitParent, { recursive: true, force: true });
    }
  });

  it("does nothing at all under LIST_AUTO_UPDATE=off", async () => {
    process.env.LIST_AUTO_UPDATE = "off";
    write(ALLIES, ids(["1"]));
    expect(await syncDefaultLists()).toEqual([]);
    expect(JSON.parse(read(ALLIES))).toEqual(["1"]);
  });
});

describe("syncDefaultLists: a bad payload never disarms a safety list", () => {
  // The failure that matters: an ally list that arrives empty would let the offense
  // engine audit teammates. So an
  // empty list is treated as a broken fetch, not as an instruction.
  it("rejects an empty ally list and keeps the local one", async () => {
    write(ALLIES, ids(["84", "99"]));
    remote[ALLIES] = "[]";
    const out = await syncDefaultLists();
    expect(JSON.parse(read(ALLIES))).toEqual(["84", "99"]);
    expect(out.find((o) => o.file === ALLIES)).toMatchObject({ result: "failed" });
  });


  it("rejects malformed JSON", async () => {
    write(SKIPPERS, ids(["206"]));
    remote[SKIPPERS] = "{not json";
    const out = await syncDefaultLists();
    expect(JSON.parse(read(SKIPPERS))).toEqual(["206"]);
    expect(out.find((o) => o.file === SKIPPERS)).toMatchObject({ result: "failed" });
  });

  it("rejects a list holding non-numeric ids", async () => {
    write(SKIPPERS, ids(["206"]));
    remote[SKIPPERS] = JSON.stringify(["206", "0xdeadbeef"]);
    await syncDefaultLists();
    expect(JSON.parse(read(SKIPPERS))).toEqual(["206"]);
  });


  it("keeps every local list when the network is down", async () => {
    write(ALLIES, ids(["84"]));
    write(SKIPPERS, ids(["206"]));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ENOTFOUND"); }));

    const out = await syncDefaultLists();
    expect(JSON.parse(read(ALLIES))).toEqual(["84"]);
    expect(JSON.parse(read(SKIPPERS))).toEqual(["206"]);
    expect(out.every((o) => o.result === "failed")).toBe(true);
  });

  it("one list failing does not stop the others updating", async () => {
    remote[ALLIES] = "[]"; // rejected
    const out = await syncDefaultLists();
    expect(out.find((o) => o.file === ALLIES)).toMatchObject({ result: "failed" });
    expect(out.find((o) => o.file === SKIPPERS)).toMatchObject({ result: "updated" });
    expect(JSON.parse(read(SKIPPERS))).toEqual(["206", "388"]);
  });

  it("survives an unwritable data dir without throwing", async () => {
    // Sync must never take startup down; a read-only data/ is a plausible cause.
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("EACCES"); });
    try {
      const out = await syncDefaultLists();
      expect(out.every((o) => o.result === "failed")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
