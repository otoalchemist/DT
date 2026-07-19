import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  JournalCorruptionError,
  SubmissionFlightJournal,
  type JournalFlight,
} from "./submission-journal.js";

const ACCOUNT = privateKeyToAccount(`0x${"11".repeat(32)}`);
const WALLET = ACCOUNT.address;
const OTHER = "0x2222222222222222222222222222222222222222" as const;
async function signed(nonce: number) {
  return ACCOUNT.signTransaction({
    chainId: 1,
    type: "eip1559",
    nonce,
    to: OTHER,
    data: "0x0102",
    value: 7n,
    gas: 50_000n,
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 2_000_000_000n,
  });
}
const RAW_5 = await signed(5);
const RAW_6 = await signed(6);

function flight(overrides: Partial<JournalFlight> = {}): JournalFlight {
  return {
    wallet: WALLET,
    nonce: 5,
    rawSignedTx: RAW_5,
    txHash: keccak256(RAW_5),
    obligation: {
      to: OTHER,
      data: "0x0102",
      valueWei: "7",
      gasLimit: "50000",
      maxFeePerGas: "3000000000",
      maxPriorityFeePerGas: "2000000000",
    },
    lineage: { id: `${WALLET}:5` },
    recovery: { publicAuthorized: true },
    state: "prepared",
    publicExposure: false,
    nonceConflict: false,
    attempts: [],
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

describe("SubmissionFlightJournal", () => {
  let directory: string;
  let journal: SubmissionFlightJournal;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "dt-submission-journal-"));
    journal = new SubmissionFlightJournal(directory);
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("atomically restores a wallet-scoped prepared batch with full obligations", () => {
    const second = flight({
      nonce: 6,
      txHash: keccak256(RAW_6),
      rawSignedTx: RAW_6,
      lineage: { id: `${WALLET}:6`, replacesTxHash: `0x${"ef".repeat(32)}` },
    });
    journal.upsertMany(WALLET, [flight(), second]);

    const restarted = new SubmissionFlightJournal(directory);
    expect(restarted.load(WALLET)).toEqual([flight(), second]);
    expect(restarted.load(OTHER)).toEqual([]);
    if (process.platform !== "win32") {
      expect(fs.statSync(journal.pathFor(WALLET)).mode & 0o777).toBe(0o600);
    }
  });

  it("fails closed with a typed error on corrupt input", () => {
    fs.mkdirSync(path.dirname(journal.pathFor(WALLET)), { recursive: true });
    fs.writeFileSync(journal.pathFor(WALLET), "{not-json", { mode: 0o600 });

    expect(() => journal.load(WALLET)).toThrow(JournalCorruptionError);
    expect(() => journal.upsert(flight())).toThrow(JournalCorruptionError);
  });

  it("rejects syntactically valid but structurally invalid records", () => {
    fs.mkdirSync(path.dirname(journal.pathFor(WALLET)), { recursive: true });
    fs.writeFileSync(journal.pathFor(WALLET), JSON.stringify({
      version: 1,
      flights: [{ wallet: WALLET, nonce: 5 }],
    }), { mode: 0o600 });
    expect(() => journal.load(WALLET)).toThrow(JournalCorruptionError);
  });

  it("rejects a structurally valid record whose signed hash and obligation disagree", () => {
    fs.mkdirSync(path.dirname(journal.pathFor(WALLET)), { recursive: true });
    fs.writeFileSync(journal.pathFor(WALLET), JSON.stringify({
      version: 1,
      flights: [flight({ txHash: `0x${"aa".repeat(32)}`, obligation: {
        ...flight().obligation,
        valueWei: "8",
      } })],
    }), { mode: 0o600 });
    expect(() => journal.load(WALLET)).toThrow(JournalCorruptionError);
  });

  it("atomically updates retained outcomes and removes terminal rejects", () => {
    const rejected = flight({ nonce: 6, txHash: keccak256(RAW_6), rawSignedTx: RAW_6 });
    journal.upsertMany(WALLET, [flight(), rejected]);
    journal.mutate(WALLET, {
      updates: [{
        txHash: flight().txHash,
        update: {
          state: "accepted",
          publicExposure: true,
          attempts: [{ channel: "public", endpoint: "rpc", state: "accepted" }],
        },
      }],
      remove: [rejected.txHash],
    });

    const restarted = new SubmissionFlightJournal(directory);
    expect(restarted.load(WALLET)).toEqual([
      expect.objectContaining({ state: "accepted", publicExposure: true }),
    ]);
  });

  it("does not consume a txpool-visible flight until latest confirms the nonce", () => {
    journal.upsert(flight({
      state: "accepted",
      publicExposure: true,
      attempts: [{ channel: "public", endpoint: "rpc", state: "accepted" }],
    }));

    const pending = journal.reconcile(WALLET, 5, 6, 1_000n);
    expect(pending.confirmedNonce).toBe(5);
    expect(pending.pendingNonce).toBe(6);
    expect(pending.retained).toHaveLength(1);
    expect(pending.consumed).toEqual([]);

    const confirmed = journal.reconcile(WALLET, 6, 6, 1_001n);
    expect(confirmed.retained).toEqual([]);
    expect(confirmed.consumed).toHaveLength(1);
  });

  it("expires private-only delivery strictly after the final target block", () => {
    journal.upsert(flight({
      state: "accepted",
      maxPrivateTargetBlock: "101",
      attempts: [{
        channel: "private",
        endpoint: "builder",
        state: "accepted",
        targetBlock: "101",
      }],
    }));

    expect(journal.reconcile(WALLET, 5, 5, 101n).retained).toHaveLength(1);
    const expired = journal.reconcile(WALLET, 5, 5, 102n);
    expect(expired.retained).toEqual([]);
    expect(expired.expired).toEqual([expect.objectContaining({ state: "expired" })]);
  });

  it("retains expired private lower-nonce evidence while a higher flight remains live", () => {
    const lower = flight({
      state: "accepted",
      recovery: { publicAuthorized: false },
      maxPrivateTargetBlock: "101",
      attempts: [{
        channel: "private",
        endpoint: "builder",
        state: "accepted",
        targetBlock: "101",
      }],
    });
    const higher = flight({
      nonce: 6,
      rawSignedTx: RAW_6,
      txHash: keccak256(RAW_6),
      lineage: { id: `${WALLET}:6` },
      state: "accepted",
      publicExposure: true,
      attempts: [{ channel: "public", endpoint: "rpc", state: "accepted" }],
    });
    journal.upsertMany(WALLET, [lower, higher]);

    const reconciliation = journal.reconcile(WALLET, 5, 6, 102n);

    expect(reconciliation.expired).toEqual([]);
    expect(reconciliation.retained).toEqual([lower, higher]);
    expect(journal.load(WALLET)).toEqual([lower, higher]);
  });

  it("never target-expires crash-window prepared work authorized for public delivery", () => {
    journal.upsert(flight({
      state: "prepared",
      recovery: { publicAuthorized: true },
      maxPrivateTargetBlock: "101",
    }));
    expect(journal.reconcile(WALLET, 5, 5, 10_000n).retained).toHaveLength(1);
  });

  it("expires private-only prepared work after its provisional final target", () => {
    journal.upsert(flight({
      state: "prepared",
      recovery: { publicAuthorized: false },
      maxPrivateTargetBlock: "101",
    }));
    expect(journal.reconcile(WALLET, 5, 5, 101n).retained).toHaveLength(1);
    expect(journal.reconcile(WALLET, 5, 5, 102n).expired).toHaveLength(1);
  });

  it("terminalizes prepared work when every delivery route was disabled before WAL", () => {
    journal.upsert(flight({
      state: "prepared",
      recovery: { publicAuthorized: false },
      maxPrivateTargetBlock: undefined,
    }));
    const reconciliation = journal.reconcile(WALLET, 5, 5, 100n);
    expect(reconciliation.retained).toEqual([]);
    expect(reconciliation.expired).toHaveLength(1);
  });

  it("never block-expires public or ambiguous exposure", () => {
    fc.assert(fc.property(fc.bigInt({ min: 102n, max: 10_000_000n }), (block) => {
      const isolated = new SubmissionFlightJournal(directory, `flights-${block}`);
      isolated.upsert(flight({
        state: "ambiguous",
        publicExposure: true,
        maxPrivateTargetBlock: "101",
        attempts: [{ channel: "public", endpoint: "rpc", state: "ambiguous" }],
      }));
      expect(isolated.reconcile(WALLET, 5, 6, block).retained).toHaveLength(1);
    }), { numRuns: 30 });
  });

  it("expires private-only ambiguity but retains nonce-conflict evidence", () => {
    const privateAmbiguous = flight({
      state: "ambiguous",
      publicExposure: false,
      nonceConflict: false,
      maxPrivateTargetBlock: "101",
      attempts: [{
        channel: "private",
        endpoint: "builder",
        state: "ambiguous",
        targetBlock: "101",
      }],
    });
    journal.upsert(privateAmbiguous);
    expect(journal.reconcile(WALLET, 5, 5, 102n).expired).toHaveLength(1);

    journal.upsert({ ...privateAmbiguous, nonceConflict: true });
    expect(journal.reconcile(WALLET, 5, 5, 10_000n).retained).toHaveLength(1);
  });
});
