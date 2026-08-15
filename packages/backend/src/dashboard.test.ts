import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DASHBOARD_SECURITY_HEADERS,
  dashboardIndexExists,
  resolveDashboardAsset,
} from "./dashboard.js";

const temps: string[] = [];

function makeDist(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dt-dashboard-"));
  temps.push(root);
  for (const [relative, body] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveDashboardAsset", () => {
  it("serves index.html for / and hashed assets by exact path", () => {
    const root = makeDist({
      "index.html": "<!doctype html>",
      "assets/app.js": "console.log(1)",
    });
    expect(resolveDashboardAsset(root, "/")).toBe(path.join(root, "index.html"));
    expect(resolveDashboardAsset(root, "/assets/app.js")).toBe(path.join(root, "assets/app.js"));
  });

  it("rejects traversal, missing files, directories, and unknown types", () => {
    const root = makeDist({
      "index.html": "<!doctype html>",
      "secret.env": "nope",
      "assets/app.js": "ok",
    });
    fs.mkdirSync(path.join(root, "assets", "nested"));

    expect(resolveDashboardAsset(root, "/../index.html")).toBeNull();
    expect(resolveDashboardAsset(root, "/%2e%2e/index.html")).toBeNull();
    expect(resolveDashboardAsset(root, "/assets/../index.html")).toBeNull();
    expect(resolveDashboardAsset(root, "/secret.env")).toBeNull();
    expect(resolveDashboardAsset(root, "/assets")).toBeNull();
    expect(resolveDashboardAsset(root, "/assets/nested")).toBeNull();
    expect(resolveDashboardAsset(root, "/missing.js")).toBeNull();
    expect(resolveDashboardAsset(root, "/assets/app.js/")).toBeNull();
  });

  it("reports whether the built index is present", () => {
    const root = makeDist({ "index.html": "<!doctype html>" });
    expect(dashboardIndexExists(root)).toBe(true);
    expect(dashboardIndexExists(path.join(root, "missing"))).toBe(false);
  });

  it("keeps the same anti-framing headers as the Vite dashboard", () => {
    expect(DASHBOARD_SECURITY_HEADERS["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(DASHBOARD_SECURITY_HEADERS["X-Frame-Options"]).toBe("DENY");
  });
});
