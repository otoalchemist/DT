import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";

let appConfig: AppConfig;
let buildServer: typeof import("./api.js").buildServer;

const openApps: FastifyInstance[] = [];
const localHeaders = {
  host: "localhost:8787",
  origin: "http://localhost:5173",
  "sec-fetch-site": "same-origin",
};

beforeAll(async () => {
  // Vitest sets MODE=test, while the runtime intentionally accepts deployment modes
  // only. Import the integration target after establishing a safe local test mode.
  vi.stubEnv("MODE", "local");
  ({ appConfig } = await import("./config.js"));
  ({ buildServer } = await import("./api.js"));
});

afterAll(() => vi.unstubAllEnvs());

async function makeApp(): Promise<FastifyInstance> {
  const app = await buildServer();
  openApps.push(app);
  return app;
}

async function getSession(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "GET",
    url: "/api/session",
    headers: localHeaders,
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ token: string }>().token;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("API browser security", () => {
  it("refuses a non-loopback bind", async () => {
    const previous = appConfig.host;
    appConfig.host = "0.0.0.0";
    try {
      await expect(buildServer()).rejects.toThrow(/non-loopback/);
    } finally {
      appConfig.host = previous;
    }
  });

  it("rejects DNS-rebinding Host headers", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { host: "wallet-api.evil.example" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("requires the per-process token on every API mutation", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/stop",
      headers: localHeaders,
    });
    expect(response.statusCode).toBe(403);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("requires the session token on wallet-state reads too", async () => {
    const app = await makeApp();
    const denied = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: localHeaders,
    });
    expect(denied.statusCode).toBe(403);

    const token = await getSession(app);
    const allowed = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { ...localHeaders, "x-dat-bot-session": token },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("requires JSON for API mutations that carry a request body", async () => {
    const app = await makeApp();
    const token = await getSession(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/config",
      headers: {
        ...localHeaders,
        "x-dat-bot-session": token,
        "content-type": "text/plain",
      },
      payload: "{}",
    });
    expect(response.statusCode).toBe(415);
  });

  it("rejects a cross-origin mutation even when its token is valid", async () => {
    const app = await makeApp();
    const token = await getSession(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/stop",
      headers: {
        ...localHeaders,
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
        "x-dat-bot-session": token,
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it("does not disclose the session token to browser requests without an Origin", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/session",
      headers: {
        host: "localhost:8787",
        "sec-fetch-mode": "no-cors",
        "sec-fetch-site": "cross-site",
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it("allows the Vite same-origin proxy and token-aware local CLI clients", async () => {
    const app = await makeApp();
    const token = await getSession(app);

    const browser = await app.inject({
      method: "POST",
      url: "/api/stop",
      headers: { ...localHeaders, "x-dat-bot-session": token },
    });
    expect(browser.statusCode).toBe(200);

    const cli = await app.inject({
      method: "POST",
      url: "/api/stop",
      headers: { host: "127.0.0.1:8787", "x-dat-bot-session": token },
    });
    expect(cli.statusCode).toBe(200);
  });

  it("denies WebSocket upgrades from an untrusted browser origin", async () => {
    const app = await makeApp();
    const token = await getSession(app);
    await app.ready();

    await expect(app.injectWS(`/ws?session=${encodeURIComponent(token)}`, {
      headers: {
        host: "localhost:8787",
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
    })).rejects.toThrow();
  });

  it("accepts an authenticated WebSocket from the local Vite origin", async () => {
    const app = await makeApp();
    const token = await getSession(app);
    await app.ready();
    const socket = await app.injectWS(`/ws?session=${encodeURIComponent(token)}`, {
      headers: localHeaders,
    });
    expect(socket.readyState).toBe(1);
    socket.close();
  });
});

describe("built dashboard", () => {
  it("serves the Vite bundle at GET / with anti-framing headers", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dt-api-dash-"));
    try {
      fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><title>dash</title>");
      fs.mkdirSync(path.join(root, "assets"));
      fs.writeFileSync(path.join(root, "assets", "app.js"), "console.log(1)");

      const app = await buildServer({ dashboardRoot: root });
      openApps.push(app);

      const page = await app.inject({ method: "GET", url: "/", headers: { host: "localhost:8787" } });
      expect(page.statusCode).toBe(200);
      expect(page.headers["content-type"]).toMatch(/text\/html/);
      expect(page.headers["x-frame-options"]).toBe("DENY");
      expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(page.body).toContain("<title>dash</title>");

      const asset = await app.inject({
        method: "GET",
        url: "/assets/app.js",
        headers: { host: "localhost:8787" },
      });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["content-type"]).toMatch(/javascript/);
      expect(asset.body).toBe("console.log(1)");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("explains how to open the dashboard when the bundle is missing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dt-api-dash-empty-"));
    try {
      const app = await buildServer({ dashboardRoot: root });
      openApps.push(app);
      const page = await app.inject({ method: "GET", url: "/", headers: { host: "localhost:8787" } });
      expect(page.statusCode).toBe(200);
      expect(page.headers["x-frame-options"]).toBe("DENY");
      expect(page.body).toContain("localhost:5173");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not let the dashboard handler swallow API 404s", async () => {
    const app = await makeApp();
    const token = await getSession(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/does-not-exist",
      headers: { ...localHeaders, "x-dat-bot-session": token },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "Not Found", statusCode: 404 });
  });
});
