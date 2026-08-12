import { describe, expect, it } from "vitest";
import {
  hostnameOf,
  isAllowedDashboardOrigin,
  isLoopbackHostname,
  PasswordAttemptLimiter,
  sessionTokenMatches,
} from "./api-security.js";

describe("local API boundary helpers", () => {
  it("recognizes only explicit loopback hosts", () => {
    expect(hostnameOf("LOCALHOST:8787")).toBe("localhost");
    expect(hostnameOf("[::1]:8787")).toBe("::1");
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("0.0.0.0")).toBe(false);
    expect(isLoopbackHostname("localhost.evil.example")).toBe(false);
    expect(isLoopbackHostname("127.0.0.1.evil.example")).toBe(false);
  });

  it("accepts loopback dashboard origins on arbitrary local ports only", () => {
    expect(isAllowedDashboardOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedDashboardOrigin("https://127.0.0.1:9443")).toBe(true);
    expect(isAllowedDashboardOrigin("http://[::1]:5173")).toBe(true);
    expect(isAllowedDashboardOrigin("https://evil.example")).toBe(false);
    expect(isAllowedDashboardOrigin("http://localhost.evil.example:5173")).toBe(false);
    expect(isAllowedDashboardOrigin("null")).toBe(false);
    expect(isAllowedDashboardOrigin(undefined)).toBe(false);
  });

  it("compares session tokens without accepting missing or different lengths", () => {
    expect(sessionTokenMatches("secret-token", "secret-token")).toBe(true);
    expect(sessionTokenMatches("secret-token", "secret-toke")).toBe(false);
    expect(sessionTokenMatches("secret-token", undefined)).toBe(false);
  });
});

describe("password attempt limiting", () => {
  it("serializes KDF work and applies escalating cooldowns", () => {
    let now = 1_000;
    const limiter = new PasswordAttemptLimiter(() => now, 100, 1_000, 3, 5_000);

    expect(limiter.begin()).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(limiter.begin()).toEqual({ allowed: false, retryAfterMs: 100 });
    limiter.finish(false);
    expect(limiter.begin()).toEqual({ allowed: false, retryAfterMs: 100 });

    now += 100;
    expect(limiter.begin().allowed).toBe(true);
    limiter.finish(false);
    now += 200;
    expect(limiter.begin().allowed).toBe(true);
    limiter.finish(false);
    expect(limiter.begin()).toEqual({ allowed: false, retryAfterMs: 5_000 });

    now += 5_000;
    expect(limiter.begin().allowed).toBe(true);
    limiter.finish(true);
    expect(limiter.begin()).toEqual({ allowed: true, retryAfterMs: 0 });
  });
});
