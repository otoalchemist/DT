import { describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * The team access gate.
 *
 * Worth being explicit about what is being tested and what is not: this is a "members only"
 * sign, not a lock. The repository is public and the check runs on the user's machine, so
 * anyone can delete the call site and rebuild. These tests pin the behaviour of the gate —
 * that it accepts the right code, rejects everything else, tolerates paste whitespace, and can
 * be switched off by a fork — not any security property, because it has none.
 */

const ORIGINAL = { ...process.env };

// The module reads the environment per call, so one static import serves every case.
const { accessCodeMatches, accessCodeRequired } = await import("./access-code.js");

describe("team access gate", () => {
  beforeEach(() => {
    delete process.env.BOT_ACCESS_CODE_OFF;
    delete process.env.BOT_ACCESS_CODE_SHA256;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("accepts the shipped code and rejects anything else", async () => {
    // The plaintext lives with the team, not in the repo — the shipped constant is its hash —
    // so this test states the code explicitly and nothing else has to.
    expect(accessCodeMatches("69union69")).toBe(true);
    expect(accessCodeMatches("")).toBe(false);
    expect(accessCodeMatches("69union")).toBe(false);
    expect(accessCodeMatches("69UNION69")).toBe(false); // case-sensitive
    expect(accessCodeMatches("wrong")).toBe(false);
  });

  it("tolerates whitespace, because the code arrives by copy-paste", async () => {
    expect(accessCodeMatches("  69union69  ")).toBe(true);
    expect(accessCodeMatches("69union69\n")).toBe(true);
  });

  it("does not treat an inner space as whitespace to strip", async () => {
    expect(accessCodeMatches("69 union 69")).toBe(false);
  });

  it("a fork can switch the gate off entirely", async () => {
    process.env.BOT_ACCESS_CODE_OFF = "1";
    expect(accessCodeRequired()).toBe(false);
    // Off means off: an empty string passes, so an existing user is not locked out of their
    // own fork by a field they were never given.
    expect(accessCodeMatches("")).toBe(true);
    expect(accessCodeMatches("anything")).toBe(true);
  });

  it("honours a private build's own code", async () => {
    const crypto = await import("node:crypto");
    process.env.BOT_ACCESS_CODE_SHA256 = crypto.createHash("sha256").update("other-code").digest("hex");
    expect(accessCodeMatches("other-code")).toBe(true);
    expect(accessCodeMatches("69union69")).toBe(false);
  });

  it("reports the gate as required by default", async () => {
    expect(accessCodeRequired()).toBe(true);
  });
});
