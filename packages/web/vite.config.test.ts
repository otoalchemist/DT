import { describe, expect, it } from "vitest";
import { defaultBackendUrl, normalizeProxyHost } from "./vite.config.js";

describe("development backend proxy defaults", () => {
  it.each([
    ["127.0.0.1", "127.0.0.1"],
    ["localhost", "localhost"],
    ["::1", "[::1]"],
    ["[::1]", "[::1]"],
  ])("normalizes %s as %s", (host, expected) => {
    expect(normalizeProxyHost(host)).toBe(expected);
  });

  it("forms a valid IPv6 loopback proxy URL from HOST and PORT", () => {
    expect(defaultBackendUrl("::1", "9000")).toBe("http://[::1]:9000");
  });
});
