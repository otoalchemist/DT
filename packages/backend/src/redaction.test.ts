import { afterEach, describe, expect, it } from "vitest";
import {
  redactLogArgument,
  redactSensitiveText,
  sanitizeActivityEntry,
} from "./redaction.js";

const originalAlchemyKey = process.env.ALCHEMY_API_KEY;

afterEach(() => {
  if (originalAlchemyKey === undefined) delete process.env.ALCHEMY_API_KEY;
  else process.env.ALCHEMY_API_KEY = originalAlchemyKey;
});

describe("operational redaction", () => {
  it("removes URL credentials, hosts, paths, and queries", () => {
    const input = "request failed: https://user:pass@rpc.example/v2/secret?trace=yes";
    const output = redactSensitiveText(input);
    expect(output).toBe("request failed: https://[REDACTED_RPC_ENDPOINT]");
    expect(output).not.toContain("user");
    expect(output).not.toContain("rpc.example");
    expect(output).not.toContain("secret");
  });

  it("is idempotent when an RPC endpoint was already redacted", () => {
    const value = "request failed: https://[REDACTED_RPC_ENDPOINT]";

    expect(redactSensitiveText(redactSensitiveText(value))).toBe(value);
  });

  it("removes a configured provider key and serialized transaction material", () => {
    process.env.ALCHEMY_API_KEY = "operator-secret-key";
    const raw = `0x${"ab".repeat(100)}`;
    const output = redactSensitiveText(`key=operator-secret-key body=${raw}`);
    expect(output).toBe(
      "key=[REDACTED] body=[REDACTED_SERIALIZED_TRANSACTION]",
    );
  });

  it("redacts uppercase serialized transaction material and nested log values", () => {
    const raw = `0X${"AB".repeat(100)}`;
    expect(redactLogArgument({ nested: [raw, "https://secret.rpc.example/key"] }))
      .toEqual({
        nested: [
          "[REDACTED_SERIALIZED_TRANSACTION]",
          "https://[REDACTED_RPC_ENDPOINT]",
        ],
      });
  });

  it("strictly rebuilds legacy activity and drops unexpected fields", () => {
    const entry = sanitizeActivityEntry({
      id: "one",
      ts: 1,
      kind: "error",
      status: "skipped",
      message: "RPC https://tenant-secret.rpc.example/v2/key failed",
      txHash: `0x${"12".repeat(32)}`,
      bundleHash: "https://bundle-secret.example/result",
      providerDiagnostic: "do-not-publish",
    });
    expect(entry).toEqual({
      id: "one",
      ts: 1,
      kind: "error",
      status: "skipped",
      message: "RPC https://[REDACTED_RPC_ENDPOINT] failed",
      txHash: `0x${"12".repeat(32)}`,
      bundleHash: "https://[REDACTED_RPC_ENDPOINT]",
    });
    expect(sanitizeActivityEntry({ ...entry, kind: "unknown" })).toBeNull();
  });

  it("preserves ordinary diagnostics and transaction hashes", () => {
    const hash = `0x${"12".repeat(32)}`;
    expect(redactSensitiveText(`nonce too low for ${hash}`))
      .toBe(`nonce too low for ${hash}`);
  });

  it("redacts Error messages and stacks before logging", () => {
    const error = new Error("RPC https://rpc.example/v2/private-key failed");
    const safe = redactLogArgument(error) as Error;
    expect(safe.message).toBe("RPC https://[REDACTED_RPC_ENDPOINT] failed");
    expect(safe.stack).not.toContain("private-key");
  });
});
