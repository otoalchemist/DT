import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const directories: string[] = [];

afterEach(() => {
  vi.doUnmock("./config.js");
  vi.doUnmock("./logger.js");
  vi.resetModules();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("legacy activity persistence", () => {
  it.skipIf(process.platform === "win32")(
    "immediately restricts and redacts a legacy credential-bearing log",
    async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dat-activity-"));
      directories.push(directory);
      const file = path.join(directory, "activity.json");
      fs.writeFileSync(file, JSON.stringify([{
        id: "legacy",
        ts: 1,
        kind: "error",
        status: "skipped",
        message: "RPC https://tenant.rpc.example/v2/operator-secret failed",
        providerDiagnostic: "must-not-survive",
      }]), { mode: 0o644 });

      vi.resetModules();
      vi.doMock("./config.js", () => ({ appConfig: { dataDir: directory } }));
      vi.doMock("./logger.js", () => ({
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      }));
      const { activity } = await import("./activity.js");

      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const persisted = fs.readFileSync(file, "utf8");
      expect(persisted).not.toContain("operator-secret");
      expect(persisted).not.toContain("tenant.rpc.example");
      expect(persisted).not.toContain("providerDiagnostic");
      expect(activity.recent()).toEqual([
        expect.objectContaining({
          id: "legacy",
          message: "RPC https://[REDACTED_RPC_ENDPOINT] failed",
        }),
      ]);
    },
  );
});
