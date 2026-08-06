import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards in the self-updater (scripts/update.mjs).
 *
 * The updater writes over the user's install, so its failure mode is destroying a working
 * bot or executing a hostile tree. These tests cover the checks that stand between a
 * malformed/hostile archive and the install; the happy path is exercised by actually
 * running the script against a stale copy, which a unit test can't meaningfully fake.
 *
 * Imported by path because the script lives outside the backend package (it must run
 * before `npm install`, so it can't sit anywhere that implies a build step).
 */
const updaterPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/update.mjs",
);
const { parseTar, normalizeEntries, verifyTree, compareVersions, isPreserved, parseVersion, PRESERVE, LAUNCHERS } =
  await import(/* @vite-ignore */ updaterPath);

/** Build a single tar entry. `type` follows the tar spec: 0=file, 1=hardlink, 2=symlink,
 *  5=directory, L=GNU longname. */
function tarEntry(name: string, body: string, type = "0"): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100, 8);
  h.write(body.length.toString(8).padStart(11, "0") + "\0", 124, 12);
  h.write(type, 156, 1);
  const pad = Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length);
  return Buffer.concat([h, Buffer.from(body), pad]);
}

/** A minimally-valid tree, as normalizeEntries would produce it. */
function validTree(version = "9.9.9", pkgName = "death-and-taxes-bot") {
  return [
    { path: "package.json", body: Buffer.from(JSON.stringify({ name: pkgName, version })), mode: 0o644 },
    {
      path: "packages/shared/src/constants.ts",
      body: Buffer.from(`export const VERSION = "${version}" as const;`),
      mode: 0o644,
    },
    { path: "packages/backend/src/main.ts", body: Buffer.from("// main"), mode: 0o644 },
    { path: "packages/web/package.json", body: Buffer.from("{}"), mode: 0o644 },
  ];
}

// An archive is untrusted input: it arrives over the network and is written straight into
// the install directory. A path that escapes that directory is the classic way an extract
// turns into arbitrary file write, so these must throw rather than clamp-and-continue.
describe("normalizeEntries: refuses paths that escape the install root", () => {
  it("rejects a ../ traversal", () => {
    expect(() => normalizeEntries(parseTar(tarEntry("DT-master/../../evil.txt", "x")))).toThrow(/suspicious/i);
  });

  it("rejects an absolute path", () => {
    expect(() => normalizeEntries(parseTar(tarEntry("DT-master//etc/passwd", "x")))).toThrow(/suspicious/i);
  });

  it("rejects a Windows drive letter", () => {
    expect(() => normalizeEntries(parseTar(tarEntry("DT-master/C:/windows/evil", "x")))).toThrow(/suspicious/i);
  });

  it("strips the archive's top-level directory from ordinary paths", () => {
    const out = normalizeEntries(parseTar(tarEntry("DT-master/packages/backend/src/main.ts", "x")));
    expect(out.map((e: { path: string }) => e.path)).toEqual(["packages/backend/src/main.ts"]);
  });
});

// Only regular files are installed. A symlink in the archive is the OTHER way an extract
// escapes its target (write through the link), and the bot's tree contains none — so
// dropping them costs nothing and closes the hole.
describe("parseTar: only regular files are extracted", () => {
  it("drops symlinks", () => {
    expect(parseTar(tarEntry("DT-master/link", "/etc/passwd", "2"))).toHaveLength(0);
  });

  it("drops hardlinks", () => {
    expect(parseTar(tarEntry("DT-master/hl", "target", "1"))).toHaveLength(0);
  });

  it("drops directory entries", () => {
    expect(parseTar(tarEntry("DT-master/sub/", "", "5"))).toHaveLength(0);
  });

  it("keeps a regular file with its body intact", () => {
    const out = parseTar(tarEntry("DT-master/a.txt", "hello"));
    expect(out).toHaveLength(1);
    expect(out[0].body.toString()).toBe("hello");
  });

  it("stops at the end-of-archive zero blocks rather than reading padding as entries", () => {
    const archive = Buffer.concat([tarEntry("DT-master/a.txt", "hi"), Buffer.alloc(1024)]);
    expect(parseTar(archive)).toHaveLength(1);
  });

  it("reads a GNU longname header as the following entry's path", () => {
    const long = `DT-master/${"nested/".repeat(20)}deep.ts`;
    const archive = Buffer.concat([tarEntry("././@LongLink", long + "\0", "L"), tarEntry("DT-master/ignored", "body")]);
    const out = parseTar(archive);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe(long);
  });
});

// A truncated download, an HTML error page, or the wrong repo must not be written over a
// working install — at which point the user has no bot and no obvious way back.
describe("verifyTree: refuses anything that isn't this project", () => {
  it("accepts a well-formed tree and reports its version", () => {
    expect(verifyTree(validTree("1.2.3"))).toMatchObject({ version: "1.2.3" });
  });

  it("rejects a different project", () => {
    expect(() => verifyTree(validTree("1.0.0", "some-other-bot"))).toThrow(/different project/i);
  });

  it("rejects a truncated archive missing required files", () => {
    const partial = validTree().slice(0, 2);
    expect(() => verifyTree(partial)).toThrow(/missing/i);
  });

  it("rejects a tree whose VERSION can't be read", () => {
    // Rebuild the constants entry rather than mutating tree[1] — under noUncheckedIndexedAccess
    // an index read is possibly-undefined, and this states the intent more directly anyway.
    const tree = validTree().map((e) =>
      e.path === "packages/shared/src/constants.ts"
        ? { ...e, body: Buffer.from("// constants file with no version export") }
        : e,
    );
    expect(() => verifyTree(tree)).toThrow(/no readable VERSION/i);
  });
});

// The preserve list is the difference between an update and data loss: data/ holds the
// encrypted keystore and the API key, .env the RPC config. Both are unrecoverable.
describe("isPreserved: the user's own files are never overwritten", () => {
  it.each([
    "data",
    "data/main.keystore.json",
    "data/config.json",
    "data/deeply/nested/file.json",
    ".env",
    "node_modules/foo/index.js",
  ])("preserves %s", (p) => {
    expect(isPreserved(p)).toBe(true);
  });

  it.each([
    "packages/backend/src/main.ts",
    "package.json",
    ".env.example", // the TEMPLATE is ours to update; only the real .env is theirs
    "README.md",
    "scripts/update.mjs",
  ])("replaces %s", (p) => {
    expect(isPreserved(p)).toBe(false);
  });
});

describe("compareVersions", () => {
  it("orders releases numerically, not as strings", () => {
    // The string comparison trap: "0.9.0" > "0.10.0" lexically, which would strand
    // everyone on 0.9.x forever.
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("0.9.1", "0.3.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
  });

  it("treats equal versions as equal", () => {
    expect(compareVersions("0.9.1", "0.9.1")).toBe(0);
  });

  it("reports a local build that's ahead of the published one", () => {
    // A developer's local version being newer must not trigger a "downgrade".
    expect(compareVersions("0.9.0", "0.9.1")).toBeLessThan(0);
  });

  it("compares a shorter version against a longer one by the missing parts being zero", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.1", "1.0")).toBeGreaterThan(0);
  });
});

describe("parseVersion", () => {
  it("reads the VERSION constant from constants.ts source", () => {
    expect(parseVersion('export const VERSION = "0.9.1" as const;')).toBe("0.9.1");
  });

  it("returns null when there's no version to read", () => {
    expect(parseVersion("const x = 1;")).toBeNull();
  });
});

// Both cmd.exe and bash read a script incrementally from disk by byte offset rather than
// buffering it, so overwriting a launcher while it is executing makes the shell resume at a
// stale offset in new bytes. Verified by experiment: a bash script that rewrote itself
// mid-run silently SKIPPED its remaining lines — on the real launcher that means the
// dashboard never opens and the bot never starts, with no error shown. Windows offers no
// escape either: it permits the overwrite and refuses rename-over-an-open-file (EPERM), so
// there is no atomic swap. Hence staging, and hence these names being exact.
describe("LAUNCHERS: the files that must never be rewritten while running", () => {
  it("covers both platform launchers", () => {
    expect(LAUNCHERS).toEqual(["start.bat", "start.command"]);
  });

  it("names them so they are still ordinary updatable files, not preserved ones", () => {
    // A launcher is OURS to update (unlike data/ or .env) — it just has to be staged.
    // If it were in PRESERVE it would never update at all, silently.
    for (const l of LAUNCHERS) expect(isPreserved(l)).toBe(false);
  });

  it("keeps the staging and backup directories out of the installed tree", () => {
    // Both are local bookkeeping; installing over them would clobber the very copies
    // kept for recovery.
    expect(PRESERVE).toContain(".update-staged");
    expect(PRESERVE).toContain(".update-backup");
    expect(isPreserved(".update-staged/start.bat")).toBe(true);
    expect(isPreserved(".update-backup/package.json")).toBe(true);
  });
});
