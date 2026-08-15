import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeEventTopics, encodeAbiParameters, toFunctionSelector } from "viem";
import { citizenVaultAbi } from "@dat-bot/shared";

/**
 * Per-action reporting for a batched boundary.
 *
 * This is the piece that keeps the activity log diagnosable after batching. A call that
 * reverts INSIDE the batch emits no game event, so TaxesPaid/Audited alone cannot tell
 * "this audit was never attempted" from "it was attempted and lost the race" — the exact
 * distinction needed to work out why a boundary went wrong. CitizenVault emits CallResult
 * for every call either way, indexed by array position, and that is what is decoded here.
 */

const updates: { id: string; patch: Record<string, unknown> }[] = [];
vi.mock("./activity.js", () => ({
  activity: {
    add: vi.fn(() => ({ id: "container" })),
    update: vi.fn((id: string, patch: Record<string, unknown>) => { updates.push({ id, patch }); }),
    recent: vi.fn(() => []),
  },
}));

const waitForTransactionReceipt = vi.fn();
vi.mock("./chain.js", () => ({ publicClient: { waitForTransactionReceipt } }));
vi.mock("./race-timing.js", () => ({ recordRaceOutcome: vi.fn() }));
vi.mock("./logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

const { reconcileVaultReceipt } = await import("./vault-receipt.js");

const AUDIT_SEL = toFunctionSelector("function audit(uint256,uint256)");

/** A real CallResult log, encoded the way the contract will emit it. */
function callResult(index: number, ok: boolean) {
  return {
    address: "0x00000000000000000000000000000000000000fe" as const,
    topics: encodeEventTopics({
      abi: citizenVaultAbi,
      eventName: "CallResult",
      args: { index: BigInt(index), selector: AUDIT_SEL },
    }),
    data: encodeAbiParameters([{ type: "bool" }], [ok]),
  };
}

const ACTIONS = [
  { entryId: "a0", kind: "pay-taxes" as const, tokenId: "10" },
  { entryId: "a1", kind: "audit" as const, tokenId: "10", targetTokenId: "501" },
  { entryId: "a2", kind: "audit" as const, tokenId: "20", targetTokenId: "502" },
];

beforeEach(() => {
  updates.length = 0;
  waitForTransactionReceipt.mockReset();
});

const patchFor = (id: string) => updates.find((u) => u.id === id)?.patch;

describe("reconcileVaultReceipt", () => {
  it("reports each action separately — a reverted audit does not tar the ones that landed", async () => {
    waitForTransactionReceipt.mockResolvedValue({
      status: "success", blockNumber: 101n, transactionIndex: 3,
      logs: [callResult(0, true), callResult(1, false), callResult(2, true)],
    });

    await reconcileVaultReceipt("0xabc", ACTIONS, "container");

    expect(patchFor("a0")?.status).toBe("included");
    expect(patchFor("a2")?.status).toBe("included");
    // The one that lost its race is the only one marked reverted — this is the whole point.
    expect(patchFor("a1")?.status).toBe("reverted");
    expect(String(patchFor("a1")?.message)).toContain("#501");
  });

  it("summarises the batch as landed-of-total rather than pass/fail", async () => {
    waitForTransactionReceipt.mockResolvedValue({
      status: "success", blockNumber: 101n, transactionIndex: 3,
      logs: [callResult(0, true), callResult(1, false), callResult(2, true)],
    });

    await reconcileVaultReceipt("0xabc", ACTIONS, "container");

    const msg = String(patchFor("container")?.message);
    expect(patchFor("container")?.status).toBe("included");
    expect(msg).toContain("2 of 3");
    expect(msg).toContain("1 reverted");
  });

  it("marks every action reverted when the outer call failed, because none were applied", async () => {
    waitForTransactionReceipt.mockResolvedValue({
      status: "reverted", blockNumber: 101n, transactionIndex: 3, logs: [],
    });

    await reconcileVaultReceipt("0xabc", ACTIONS, "container");

    for (const a of ACTIONS) expect(patchFor(a.entryId)?.status).toBe("reverted");
    expect(String(patchFor("container")?.message)).toContain("must-land");
  });

  it("says unknown rather than guessing when an index has no result logged", async () => {
    waitForTransactionReceipt.mockResolvedValue({
      status: "success", blockNumber: 101n, transactionIndex: 3,
      logs: [callResult(0, true)], // indices 1 and 2 missing
    });

    await reconcileVaultReceipt("0xabc", ACTIONS, "container");

    expect(patchFor("a0")?.status).toBe("included");
    // Left as submitted — inventing "included" would hide a real problem, and inventing
    // "reverted" would report a failure that may not have happened.
    expect(patchFor("a1")?.status).toBe("submitted");
    expect(String(patchFor("a1")?.message)).toContain("no result logged");
  });

  it("leaves the rows alone when the receipt never arrives", async () => {
    waitForTransactionReceipt.mockRejectedValue(new Error("timed out"));

    await reconcileVaultReceipt("0xabc", ACTIONS, "container");

    // A bundle that lost its slot is not a reverted bundle; forcing a verdict here would
    // be the same mistake trackReceipt deliberately avoids.
    expect(updates).toHaveLength(0);
  });
});
