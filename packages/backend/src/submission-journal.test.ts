import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  JournalCorruptionError,
  JournalChainUnavailableError,
  JOURNAL_CONFIRMATION_DEPTH,
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

function blockHash(lineage: string, number: bigint): Hex {
  return keccak256(toHex(`${lineage}:${number}`));
}

function blockEvidence(number: bigint, lineage = "canonical") {
  const canonicalHashes: Hex[] = [];
  for (let offset = 0n; offset < JOURNAL_CONFIRMATION_DEPTH && offset <= number; offset++) {
    canonicalHashes.push(blockHash(lineage, number - offset));
  }
  return { number, canonicalHashes };
}

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

  it("retains tip inclusion through confirmation depth and survives a nonce regression", () => {
    journal.upsert(flight({
      state: "accepted",
      publicExposure: true,
      attempts: [{ channel: "public", endpoint: "rpc", state: "accepted" }],
    }));

    const pending = journal.reconcile(WALLET, 5, 6, blockEvidence(1_000n));
    expect(pending.confirmedNonce).toBe(5);
    expect(pending.pendingNonce).toBe(6);
    expect(pending.retained).toHaveLength(1);
    expect(pending.consumed).toEqual([]);

    const tip = journal.reconcile(WALLET, 6, 6, blockEvidence(1_001n));
    expect(tip.retained).toEqual([
      expect.objectContaining({
        observedConsumedAtBlock: "1001",
        observedConsumedAtBlockHash: blockHash("canonical", 1_001n),
      }),
    ]);
    expect(tip.provisional).toHaveLength(1);
    expect(tip.consumed).toEqual([]);

    const reorged = journal.reconcile(WALLET, 5, 5, blockEvidence(1_002n, "reorg"));
    expect(reorged.retained).toHaveLength(1);
    expect(reorged.retained[0]?.observedConsumedAtBlock).toBeUndefined();
    expect(reorged.consumed).toEqual([]);

    const reincluded = journal.reconcile(WALLET, 6, 6, blockEvidence(1_003n, "reorg"));
    expect(reincluded.provisional).toHaveLength(1);
    const almostFinal = journal.reconcile(
      WALLET,
      6,
      6,
      blockEvidence(1_003n + JOURNAL_CONFIRMATION_DEPTH - 2n, "reorg"),
    );
    expect(almostFinal.retained).toHaveLength(1);
    const finalized = journal.reconcile(
      WALLET,
      6,
      6,
      blockEvidence(1_003n + JOURNAL_CONFIRMATION_DEPTH - 1n, "reorg"),
    );
    expect(finalized.retained).toEqual([]);
    expect(finalized.consumed).toHaveLength(1);
  });

  it("restarts confirmation after a lateral reorg even when the nonce stays advanced", () => {
    journal.upsert(flight({ state: "accepted", publicExposure: true }));

    const oldTip = journal.reconcile(WALLET, 6, 6, blockEvidence(100n, "old"));
    expect(oldTip.provisional).toHaveLength(1);

    // The replacement chain also consumed nonce 5, but only at its current tip.
    // Reusing height 100 would incorrectly declare this one-confirmation view
    // terminal; the replaced ancestor hash must restart observation at 102.
    const lateral = journal.reconcile(WALLET, 6, 6, blockEvidence(102n, "replacement"));
    expect(lateral.consumed).toEqual([]);
    expect(lateral.retained).toEqual([
      expect.objectContaining({
        observedConsumedAtBlock: "102",
        observedConsumedAtBlockHash: blockHash("replacement", 102n),
      }),
    ]);

    const finalized = journal.reconcile(WALLET, 6, 6, blockEvidence(104n, "replacement"));
    expect(finalized.consumed).toHaveLength(1);
  });

  it("restarts legacy height-only observations before allowing finality", () => {
    journal.upsert(flight({
      state: "accepted",
      publicExposure: true,
      observedConsumedAtBlock: "1",
    }));

    const reconciliation = journal.reconcile(WALLET, 6, 6, blockEvidence(100n));

    expect(reconciliation.consumed).toEqual([]);
    expect(reconciliation.retained[0]).toMatchObject({
      observedConsumedAtBlock: "100",
      observedConsumedAtBlockHash: blockHash("canonical", 100n),
    });
  });

  it("keeps nonce-conflict evidence monotonic across later updates", () => {
    journal.upsert(flight({ nonceConflict: true }));

    journal.update(WALLET, flight().txHash, {
      state: "ambiguous",
      nonceConflict: false,
    });
    journal.upsert(flight({ nonceConflict: false, state: "prepared" }));

    expect(journal.load(WALLET)[0]).toMatchObject({
      state: "ambiguous",
      nonceConflict: true,
    });
  });

  it("chain-scopes new journals and rejects signed transactions from another chain", async () => {
    journal.upsert(flight());
    expect(journal.pathFor(WALLET)).toContain(`${path.sep}chain-1${path.sep}`);
    expect(JSON.parse(fs.readFileSync(journal.pathFor(WALLET), "utf8"))).toMatchObject({
      version: 2,
      chainId: 1,
    });

    const localRaw = await ACCOUNT.signTransaction({
      chainId: 31_337,
      type: "eip1559",
      nonce: 5,
      to: OTHER,
      data: "0x0102",
      value: 7n,
      gas: 50_000n,
      maxFeePerGas: 3_000_000_000n,
      maxPriorityFeePerGas: 2_000_000_000n,
    });
    expect(() => journal.upsert(flight({
      rawSignedTx: localRaw,
      txHash: keccak256(localRaw),
    }))).toThrow(/outside chain 1/);
  });

  it("migrates a verified legacy journal only on its signed chain", () => {
    const legacyPath = journal.legacyPathFor(WALLET);
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, JSON.stringify({ version: 1, flights: [flight()] }), {
      mode: 0o600,
    });

    const wrongChain = new SubmissionFlightJournal(directory, "submission-flights", 31_337);
    expect(wrongChain.load(WALLET)).toEqual([]);
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(wrongChain.pathFor(WALLET))).toBe(false);
    expect(fs.existsSync(journal.pathFor(WALLET))).toBe(true);

    expect(journal.load(WALLET)).toEqual([flight()]);
    expect(fs.existsSync(journal.pathFor(WALLET))).toBe(true);
    expect(fs.existsSync(`${legacyPath}.migrated-chain-1`)).toBe(true);
  });

  it("fails closed while chain identity is unavailable", () => {
    const unresolved = new SubmissionFlightJournal(directory, "unresolved", () => null);
    expect(() => unresolved.load(WALLET)).toThrow(JournalChainUnavailableError);
    expect(() => unresolved.upsert(flight())).toThrow(JournalChainUnavailableError);
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

    expect(journal.reconcile(WALLET, 5, 5, blockEvidence(101n)).retained).toHaveLength(1);
    const expired = journal.reconcile(WALLET, 5, 5, blockEvidence(102n));
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

    const reconciliation = journal.reconcile(WALLET, 5, 6, blockEvidence(102n));

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
    expect(journal.reconcile(WALLET, 5, 5, blockEvidence(10_000n)).retained).toHaveLength(1);
  });

  it("expires private-only prepared work after its provisional final target", () => {
    journal.upsert(flight({
      state: "prepared",
      recovery: { publicAuthorized: false },
      maxPrivateTargetBlock: "101",
    }));
    expect(journal.reconcile(WALLET, 5, 5, blockEvidence(101n)).retained).toHaveLength(1);
    expect(journal.reconcile(WALLET, 5, 5, blockEvidence(102n)).expired).toHaveLength(1);
  });

  it("terminalizes prepared work when every delivery route was disabled before WAL", () => {
    journal.upsert(flight({
      state: "prepared",
      recovery: { publicAuthorized: false },
      maxPrivateTargetBlock: undefined,
    }));
    const reconciliation = journal.reconcile(WALLET, 5, 5, blockEvidence(100n));
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
      expect(isolated.reconcile(WALLET, 5, 6, blockEvidence(block)).retained).toHaveLength(1);
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
    expect(journal.reconcile(WALLET, 5, 5, blockEvidence(102n)).expired).toHaveLength(1);

    journal.upsert({ ...privateAmbiguous, nonceConflict: true });
    expect(journal.reconcile(WALLET, 5, 5, blockEvidence(10_000n)).retained).toHaveLength(1);
  });
});
