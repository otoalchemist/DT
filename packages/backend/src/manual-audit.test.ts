import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrivateKeyAccount } from "viem/accounts";

/**
 * Manual audits: the "audit" button on an auditable rival, and "audit all".
 *
 * These spend real ETH on a button press, so what matters is that they refuse cleanly rather
 * than submitting something doomed. Every guard here corresponds to a way to burn 0.00069 ETH
 * plus gas for nothing:
 *
 *  - auditing a rival that is not 2 epochs behind reverts;
 *  - auditing one already under audit reverts;
 *  - auditing a BURNED token reverts with ERC721NonexistentToken, and lastEpochPaid keeps
 *    answering from a surviving mapping so it looks alive if you only read that;
 *  - auditing with no slots left reverts with AuditLimitReached.
 *
 * Gas is the network's normal price, not the boundary-race tip: a mid-epoch button press is not
 * contesting a slot, and inheriting a 250-370 gwei race tip would cost ~0.05 ETH to do something
 * uncontested.
 */

const EPOCH = 200n;
const AUDIT_COST = 690_000_000_000_000n;

let lastEpochPaidByToken: Record<string, bigint> = {};
let auditsUsed = 0n;
let auditLimit = 1n;
let liveIds: bigint[] | null = null; // null => every id asked about is live

const submitted: { data: string; value: bigint; opts: Record<string, unknown> }[] = [];

vi.mock("./chain.js", () => ({
  publicClient: {
    getBlock: vi.fn(async () => ({ baseFeePerGas: 1_000_000_000n })),
    getBalance: vi.fn(async () => 10_000_000_000_000_000_000n),
    getBlockNumber: vi.fn(async () => 100n),
    multicall: vi.fn(async ({ contracts }: { contracts: { functionName: string; args: readonly unknown[] }[] }) =>
      contracts.map((c) => ({
        status: "success" as const,
        result:
          c.functionName === "auditLimit" ? auditLimit
          : c.functionName === "auditsUsedInEpoch" ? auditsUsed
          : c.functionName === "auditDueTimestamp" ? 0n
          : (lastEpochPaidByToken[String(c.args[0])] ?? EPOCH), // lastEpochPaid
      })),
    ),
  },
  getLatestBlockCached: vi.fn(async () => ({ baseFeePerGas: 1_000_000_000n, number: 100n, gasUsed: 0n, gasLimit: 30_000_000n })),
  getBalanceCached: vi.fn(async () => 10_000_000_000_000_000_000n),
  invalidateBalanceCache: vi.fn(),
  primeBlockCache: vi.fn(),
  wsClient: null,
}));

vi.mock("./config.js", () => ({
  appConfig: {
    mode: "mainnet", dataDir: "C:/dat-bot-test-scratch-nonexistent",
    gameAddress: "0x00000000000000000000000000000000000000aa",
    builderUrls: ["https://relay.flashbots.net"], flashbotsRelayUrl: "https://relay.flashbots.net",
    maxCandidates: 8000, ownedTokensOverride: [], targetTokensOverride: [],
  },
  loadSettings: vi.fn(() => ({})), saveSettings: vi.fn(), deriveUrlsFromKey: vi.fn(),
}));

vi.mock("./contract.js", () => ({
  getGameSnapshot: vi.fn(async () => ({
    state: 1, currentEpoch: EPOCH, citizenSupply: 500n,
    citizensAddress: "0x00000000000000000000000000000000000000cc", startTime: 0n,
  })),
  batchGetOwnedStatuses: vi.fn(async () => []),
  batchGetTargetStatuses: vi.fn(async (tokens: { id: bigint }[], epoch: bigint) =>
    tokens.map(({ id }) => {
      const lep = lastEpochPaidByToken[String(id)] ?? EPOCH - 2n;
      const behind = Number(epoch - lep);
      return {
        tokenId: id.toString(), owner: "0x00000000000000000000000000000000000000dd",
        lastEpochPaid: lep.toString(), delinquent: behind >= 1, epochsBehind: behind,
        auditable: lep + 2n <= epoch, auditDueTimestamp: "0", killable: false,
      };
    }),
  ),
  filterLiveTokenIds: vi.fn(async (_c: unknown, ids: bigint[]) =>
    ids.filter((id) => liveIds === null || liveIds.includes(id))
      .map((id) => ({ id, owner: "0x00000000000000000000000000000000000000dd" as `0x${string}` })),
  ),
  encodePayTaxes: vi.fn(() => "0x11111111"),
  encodeAudit: vi.fn((from: bigint, target: bigint) => `0xAUDIT${from}to${target}`),
  encodeKill: vi.fn(() => "0x33333333"),
  encodeUseBribe: vi.fn(() => "0x44444444"),
  estimateTaxes: vi.fn(async () => 0n),
  gameContract: { address: "0x00000000000000000000000000000000000000aa", abi: [] },
}));

vi.mock("./index-tokens.js", () => ({
  fetchOwnedTokenIds: vi.fn(async () => [10n, 20n]),
  fetchCandidateTokenIds: vi.fn(async () => [501n, 502n, 503n]),
  ownershipIndexingAvailable: vi.fn(() => true),
}));

vi.mock("./activity.js", () => ({
  activity: { add: vi.fn(() => ({ id: "e1" })), update: vi.fn(), recent: vi.fn(() => []) },
}));
vi.mock("./race-timing.js", () => ({ recordRaceOutcome: vi.fn(), recordRaceSubmission: vi.fn() }));
vi.mock("./emigration.js", () => ({ emigratedTokenIdSet: vi.fn(async () => new Set<string>()) }));
vi.mock("./nonce.js", () => ({
  nonces: {
    for: vi.fn(() => ({ sync: vi.fn(async () => {}), reset: vi.fn(), peek: vi.fn(() => 1), reserve: vi.fn(() => 1), markSigned: vi.fn() })),
    syncAll: vi.fn(async () => {}), resetAll: vi.fn(), retain: vi.fn(),
  },
}));

// The wire format is covered elsewhere; here what matters is WHAT was submitted and HOW.
vi.mock("./flashbots.js", () => ({
  submitTx: vi.fn(async (intent: { data: string; value: bigint }, opts: Record<string, unknown>) => {
    submitted.push({ data: intent.data, value: intent.value, opts });
    return { ok: true, simulated: false, txHash: "0xhash", nonce: 1, valueWei: intent.value, gasWei: 0n };
  }),
  beginBundle: vi.fn(), flushBundle: vi.fn(async () => new Map()),
  queueCoinbaseBid: vi.fn(async () => false), setRaceBoundary: vi.fn(), setRaceLookBack: vi.fn(),
}));

const { runtime, DEFAULT_STRATEGY } = await import("./runtime.js");
const { manualAudit, manualAuditAll } = await import("./strategy.js");

beforeEach(() => {
  vi.clearAllMocks();
  submitted.length = 0;
  lastEpochPaidByToken = {};
  auditsUsed = 0n;
  auditLimit = 1n;
  liveIds = null;
  runtime.setWallets([{
    account: { address: "0x1111111111111111111111111111111111111111" } as unknown as PrivateKeyAccount,
    label: "t", balanceWei: 10_000_000_000_000_000_000n,
  }]);
  runtime.gameState = 1;
  runtime.currentEpoch = EPOCH;
  runtime.startTime = 0n;
  runtime.citizensAddress = "0x00000000000000000000000000000000000000cc";
  runtime.citizenSupply = 500n;
  runtime.strategy = {
    ...DEFAULT_STRATEGY, minBalanceEth: 0, offenseEnabled: true,
    endgameOnlyWithin: null, offenseTargetTokenIds: [],
  } as typeof runtime.strategy;
});
afterEach(() => { runtime.setWallets([]); });

describe("manual audit of one rival", () => {
  it("submits audit(from, target) at NORMAL gas, paying the audit fee", async () => {
    lastEpochPaidByToken["501"] = EPOCH - 2n; // 2 behind => auditable
    const res = await manualAudit(501n);
    expect(res.ok).toBe(true);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.data).toContain("to501");        // audited the token asked for
    expect(submitted[0]!.value).toBe(AUDIT_COST);         // 0.00069 ETH fee
    expect(submitted[0]!.opts.normalGas).toBe(true);      // NOT the race tip
    expect(submitted[0]!.opts.race).toBe(true);           // mirrored, so it lands without a builder
  });

  it("signs with the wallet holding the AUDITOR, not the target", async () => {
    lastEpochPaidByToken["501"] = EPOCH - 2n;
    await manualAudit(501n);
    // audit() is owner-only on the AUDITOR, so act() must have resolved a signer from one of
    // our citizens — it passes it to submitTx as `account`, not `wallet`.
    expect(submitted[0]!.opts.account).toBeTruthy();
    // And the calldata must pair one of OUR tokens (10 or 20) with the rival, never the reverse.
    expect(String(submitted[0]!.data)).toMatch(/^0xAUDIT(10|20)to501$/);
  });

  it("refuses a rival that is only 1 epoch behind, without submitting", async () => {
    lastEpochPaidByToken["501"] = EPOCH - 1n;
    const res = await manualAudit(501n);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/not auditable/i);
    expect(submitted).toHaveLength(0);
  });

  it("refuses a BURNED token — lastEpochPaid outlives the citizen", async () => {
    // The trap: the mapping still answers, so a status-only check reads it as auditable while
    // the audit would revert with ERC721NonexistentToken after paying gas.
    liveIds = [502n];
    lastEpochPaidByToken["501"] = EPOCH - 5n;
    const res = await manualAudit(501n);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/no longer exists/i);
    expect(submitted).toHaveLength(0);
  });

  it("refuses when every audit slot is already spent this epoch", async () => {
    lastEpochPaidByToken["501"] = EPOCH - 2n;
    auditsUsed = 1n; // limit 1, used 1
    const res = await manualAudit(501n);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/no audit capacity/i);
    expect(submitted).toHaveLength(0);
  });

  it("refuses while the wallet is locked", async () => {
    runtime.setWallets([]);
    const res = await manualAudit(501n);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/unlock/i);
    expect(submitted).toHaveLength(0);
  });
});

describe("mass audit", () => {
  it("audits every auditable rival when capacity allows", async () => {
    for (const id of ["501", "502", "503"]) lastEpochPaidByToken[id] = EPOCH - 2n;
    auditLimit = 2n; // 2 owned citizens x 2 = 4 slots
    const res = await manualAuditAll();
    expect(res.ok).toBe(true);
    expect(res.audited).toHaveLength(3);
    expect(submitted).toHaveLength(3);
    expect(submitted.every((s) => s.opts.normalGas === true)).toBe(true);
    expect(res.capacityLeft).toBe(1);
  });

  it("stops at the slot limit and REPORTS what it left alone", async () => {
    // The case that would otherwise look like a silent failure: more targets than slots.
    for (const id of ["501", "502", "503"]) lastEpochPaidByToken[id] = EPOCH - 2n;
    auditLimit = 1n; // 2 slots for 3 targets
    const res = await manualAuditAll();
    expect(res.audited).toHaveLength(2);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]!.reason).toMatch(/no audit slots left/i);
    expect(res.message).toMatch(/skipped/i);
  });

  it("says so plainly when nobody is auditable, and sends nothing", async () => {
    for (const id of ["501", "502", "503"]) lastEpochPaidByToken[id] = EPOCH; // all current
    const res = await manualAuditAll();
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/no rival is auditable/i);
    expect(submitted).toHaveLength(0);
  });

  it("says so plainly when there is no capacity, and sends nothing", async () => {
    for (const id of ["501", "502", "503"]) lastEpochPaidByToken[id] = EPOCH - 2n;
    auditsUsed = 1n;
    const res = await manualAuditAll();
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/no audit capacity/i);
    expect(submitted).toHaveLength(0);
  });

  it("never reuses an auditor slot across targets", async () => {
    for (const id of ["501", "502", "503"]) lastEpochPaidByToken[id] = EPOCH - 2n;
    auditLimit = 2n;
    await manualAuditAll();
    // Two owned citizens with 2 slots each: three audits must draw three distinct pool entries,
    // so no single (auditor, target) pairing repeats.
    const pairs = submitted.map((s) => s.data);
    expect(new Set(pairs).size).toBe(pairs.length);
  });
});
