import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Same idiom as list-sync.test.ts: mock config so the real env-schema parse (which
// rejects vitest's MODE=test) never runs.
vi.mock("./config.js", () => ({
  appConfig: { dataDir: "C:/dat-bot-test-scratch-nonexistent" },
  loadSettings: vi.fn(() => ({})),
  saveSettings: vi.fn(),
  deriveUrlsFromKey: vi.fn(),
}));
vi.mock("./activity.js", () => ({ activity: { add: vi.fn() } }));

const { VERSION } = await import("@dat-bot/shared");
const { activity } = await import("./activity.js");
const { checkLatestVersion, compareVersions, parseVersion, versionState, resetVersionState } =
  await import("./version-check.js");

/** A constants.ts payload announcing `v`, shaped like the real file. */
const constantsSrc = (v: string) =>
  `// header\nexport const VERSION = "${v}" as const;\nexport const OTHER = 1;\n`;

const serve = (body: string, ok = true, status = 200) =>
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok,
    status,
    text: async () => body,
  } as unknown as Response);

// The check exists so a long-running bot can say "you are behind" — the launcher's
// updater only runs at startup and skips git checkouts entirely. It moves no money and
// installs nothing, so the whole contract is: report accurately, and never let a bad
// network turn into a wrong claim or a thrown error.
describe("version check", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    resetVersionState();
  });
  afterEach(() => vi.restoreAllMocks());

  it("orders releases numerically, not lexically", () => {
    // "1.2.10" vs "1.2.9" is the case a string compare gets backwards, and it is exactly
    // the one that would tell a current bot it is stale forever.
    expect(compareVersions("1.2.10", "1.2.9")).toBeGreaterThan(0);
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3", "1.3.0")).toBeLessThan(0);
    // Equal numeric prefix with a pre-release suffix: treated as equal rather than
    // guessed at, so a "-rc1" never nags a user who is effectively current.
    expect(compareVersions("1.2.3-rc1", "1.2.3")).toBe(0);
  });

  it("reads VERSION out of a constants.ts payload", () => {
    expect(parseVersion(constantsSrc("9.9.9"))).toBe("9.9.9");
    expect(parseVersion("nothing here")).toBeNull();
  });

  it("flags behind when master is newer, and names the version", async () => {
    serve(constantsSrc("99.0.0"));
    const s = await checkLatestVersion();
    expect(s.latest).toBe("99.0.0");
    expect(s.behind).toBe(true);
    expect(s.checkedAt).not.toBeNull();
  });

  it("stays quiet when running the released version", async () => {
    serve(constantsSrc(VERSION));
    const s = await checkLatestVersion();
    expect(s.behind).toBe(false);
    expect(vi.mocked(activity.add)).not.toHaveBeenCalled();
  });

  it("never reports behind when master is OLDER than us", async () => {
    // A local dev build ahead of master must not be told to downgrade.
    serve(constantsSrc("0.0.1"));
    expect((await checkLatestVersion()).behind).toBe(false);
  });

  it("announces a release once, not once per check", async () => {
    // Re-checks run every 6h for the life of the process; one activity line per release
    // is information, one every 6h is noise that buries real entries.
    serve(constantsSrc("99.0.0"));
    await checkLatestVersion();
    await checkLatestVersion();
    await checkLatestVersion();
    expect(vi.mocked(activity.add)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(activity.add).mock.calls[0]?.[0]).toMatchObject({ kind: "info" });
  });

  it("announces again when a NEWER release lands", async () => {
    serve(constantsSrc("99.0.0"));
    await checkLatestVersion();
    // NB: no restoreAllMocks here — it would also wipe activity.add's call history and
    // hide the very thing under test. Re-serving overrides the existing fetch spy.
    serve(constantsSrc("99.1.0"));
    await checkLatestVersion();
    expect(vi.mocked(activity.add)).toHaveBeenCalledTimes(2);
  });

  it("keeps the last known answer when the network fails", async () => {
    // Clearing on failure would make a known-stale bot look current — the opposite of
    // what this exists for. One flaky fetch must not retract a true warning.
    serve(constantsSrc("99.0.0"));
    await checkLatestVersion();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const s = await checkLatestVersion();
    expect(s.behind).toBe(true);
    expect(s.latest).toBe("99.0.0");
  });

  it("does not throw on a failed fetch, an HTTP error, or garbage", async () => {
    // Called from startup and from a timer; a throw here would be an unhandled rejection.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    await expect(checkLatestVersion()).resolves.toBeDefined();
    vi.restoreAllMocks();
    serve("", false, 500);
    await expect(checkLatestVersion()).resolves.toBeDefined();
    vi.restoreAllMocks();
    serve("this is not constants.ts");
    await expect(checkLatestVersion()).resolves.toBeDefined();
    // Never had a successful read, so it reports "no information" rather than "current".
    expect(versionState().latest).toBeNull();
    expect(versionState().behind).toBe(false);
  });
});
