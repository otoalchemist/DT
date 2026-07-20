import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiBindSchema,
  loadSettingsFromPaths,
  validateMainnetRpcCandidate,
  writeJsonAtomic,
} from "./config.js";
import { AtomicWriteCommittedError } from "./durability.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const candidate = {
  httpUrl: "https://rpc.test",
  nftUrl: "https://nft.test/v3/key",
  gameAddress: "0x0000000000000000000000000000000000000001" as const,
};

describe("API bind validation", () => {
  it.each(["127.0.0.1", "localhost", "::1", " LOCALHOST "])(
    "accepts the loopback bind %s",
    (host) => {
      expect(apiBindSchema.parse({ HOST: host }).HOST).toBe(host.trim().toLowerCase());
    },
  );

  it.each(["0.0.0.0", "192.168.1.20", "bot.internal.example", "[::1]"])(
    "rejects the non-loopback or invalid Fastify bind %s",
    (host) => {
      expect(() => apiBindSchema.parse({ HOST: host })).toThrow(/HOST must be loopback-only/);
    },
  );

  it("rejects the removed API_ALLOWED_HOSTS escape hatch", () => {
    expect(() => apiBindSchema.parse({
      HOST: "127.0.0.1",
      API_ALLOWED_HOSTS: "192.168.1.20",
    })).toThrow(/API_ALLOWED_HOSTS is no longer supported/);
    expect(apiBindSchema.parse({ HOST: "localhost", API_ALLOWED_HOSTS: "" }).HOST)
      .toBe("localhost");
  });
});

function validFetch(overrides: Record<string, unknown> = {}): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith(candidate.nftUrl)) {
      return new Response(JSON.stringify({ ownedNfts: [] }), {
        status: (overrides.nftStatus as number | undefined) ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    const body = JSON.parse(String(init?.body)) as { method: string; id: number };
    const defaultResult = body.method === "eth_chainId"
      ? "0x1"
      : body.method === "eth_blockNumber"
        ? "0x123"
        : `0x${"0".repeat(63)}1`;
    const result = overrides[body.method] ?? defaultResult;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("candidate endpoint validation", () => {
  it("checks chain, latest block, both game reads, and NFT availability without mutation", async () => {
    const fetchImpl = validFetch();
    await expect(validateMainnetRpcCandidate(candidate, fetchImpl)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    const rpcMethods = vi.mocked(fetchImpl).mock.calls.slice(0, 4).map(([, init]) =>
      (JSON.parse(String(init?.body)) as { method: string }).method,
    );
    expect(rpcMethods).toEqual(["eth_chainId", "eth_blockNumber", "eth_call", "eth_call"]);
  });

  it("rejects a wrong chain or unavailable NFT endpoint", async () => {
    await expect(validateMainnetRpcCandidate(candidate, validFetch({ eth_chainId: "0x5" })))
      .rejects.toThrow(/chainId 1/);
    await expect(validateMainnetRpcCandidate(candidate, validFetch({ nftStatus: 401 })))
      .rejects.toThrow(/NFT endpoint returned HTTP 401/);
  });
});

describe("atomic JSON persistence", () => {
  it.skipIf(process.platform === "win32")(
    "fsyncs each newly created directory into its parent",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "dat-directory-durability-"));
      dirs.push(root);
      const originalFsync = fs.fsyncSync.bind(fs);
      const fsync = vi.spyOn(fs, "fsyncSync").mockImplementation(originalFsync);

      writeJsonAtomic(path.join(root, "instance", "nested", "settings.json"), { mode: "public" });

      // Two created directories each flush themselves and their parent, then
      // the file and its final containing-directory entry are flushed.
      expect(fsync).toHaveBeenCalledTimes(6);
    },
  );

  it("replaces content durably and restricts secret-file modes where supported", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dat-atomic-"));
    dirs.push(dir);
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, "{}", { mode: 0o644 });
    writeJsonAtomic(file, { alchemyApiKey: "secret" });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ alchemyApiKey: "secret" });
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(fs.readdirSync(dir)).toEqual(["settings.json"]);
  });

  it("leaves the previous file intact and cleans the temp file when replacement fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dat-atomic-failure-"));
    dirs.push(dir);
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ alchemyApiKey: "old-key" }));
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("simulated rename failure");
    });

    expect(() => writeJsonAtomic(file, { alchemyApiKey: "new-key" }))
      .toThrow(/simulated rename failure/);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ alchemyApiKey: "old-key" });
    expect(fs.readdirSync(dir)).toEqual(["settings.json"]);
  });

  it.skipIf(process.platform === "win32")(
    "reports a post-rename durability failure as committed",
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dat-atomic-committed-"));
      dirs.push(dir);
      const file = path.join(dir, "settings.json");
      fs.writeFileSync(file, JSON.stringify({ mode: "mainnet" }));
      const originalFsync = fs.fsyncSync.bind(fs);
      vi.spyOn(fs, "fsyncSync")
        .mockImplementationOnce(originalFsync)
        .mockImplementationOnce(() => { throw new Error("simulated directory fsync failure"); });

      expect(() => writeJsonAtomic(file, { mode: "public" }))
        .toThrow(AtomicWriteCommittedError);
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ mode: "public" });
      expect(fs.readdirSync(dir)).toEqual(["settings.json"]);
    },
  );

  it("copies legacy settings into DATA_DIR and leaves an explicit backup", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dat-settings-"));
    dirs.push(root);
    const legacyPath = path.join(root, "legacy", "settings.json");
    const currentPath = path.join(root, "instance", "settings.json");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, JSON.stringify({ alchemyApiKey: "legacy-key", mode: "public" }));

    expect(loadSettingsFromPaths(currentPath, legacyPath)).toEqual({
      alchemyApiKey: "legacy-key",
      mode: "public",
    });
    expect(JSON.parse(fs.readFileSync(currentPath, "utf8"))).toEqual({
      alchemyApiKey: "legacy-key",
      mode: "public",
    });
    expect(JSON.parse(fs.readFileSync(path.join(root, "instance", "settings.legacy.json"), "utf8")))
      .toEqual({ alchemyApiKey: "legacy-key", mode: "public" });
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  it("fails closed without overwriting a present corrupt or invalid settings file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dat-settings-corrupt-"));
    dirs.push(root);
    const legacyPath = path.join(root, "legacy", "settings.json");
    const currentPath = path.join(root, "instance", "settings.json");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.mkdirSync(path.dirname(currentPath), { recursive: true });
    fs.writeFileSync(legacyPath, JSON.stringify({ mode: "public" }));
    fs.writeFileSync(currentPath, "{not-json");

    expect(() => loadSettingsFromPaths(currentPath, legacyPath)).toThrow(/Could not load settings/);
    expect(fs.readFileSync(currentPath, "utf8")).toBe("{not-json");

    fs.writeFileSync(currentPath, JSON.stringify({ mode: "local" }));
    expect(() => loadSettingsFromPaths(currentPath, legacyPath)).toThrow(/Could not load settings/);
    expect(JSON.parse(fs.readFileSync(currentPath, "utf8"))).toEqual({ mode: "local" });
  });
});
