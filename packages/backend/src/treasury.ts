import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getAddress, isAddress, type Address } from "viem";
import { TREASURY_ADDRESS, type TreasuryLedger, type TreasuryMovement, type TreasuryParticipant } from "@dat-bot/shared";
import { appConfig } from "./config.js";
import { publicClient } from "./chain.js";
import { logger } from "./logger.js";
import { fetchLiveCitizens } from "./index-tokens.js";
import { fetchEmigrationRoster } from "./emigration.js";
import { getGameSnapshot } from "./contract.js";

/**
 * The emigration treasury ledger.
 *
 * ETH into the wallet is a contribution; ETH out is a departure subsidy. The bill for the
 * departures bought so far is split across the citizens held by everyone who has either
 * contributed or opted in, and each participant's position is what they have paid minus
 * their share of that bill.
 *
 * Two things here are deliberately NOT hand-maintained, because the chain already knows
 * them and a hand-kept copy would silently rot: citizen counts come from the ownership
 * index, and names come from ENS reverse resolution. What IS hand-kept is the part the
 * chain cannot know — who intends to contribute later, what to call them, and which
 * movements are not really contributions.
 */

const treasuryAddress = (): Address =>
  getAddress(process.env.TREASURY_ADDRESS ?? TREASURY_ADDRESS);

/**
 * How far back to re-scan on each pass.
 *
 * The cursor is a block height we have already covered, so a reorg that reshuffles the
 * last few blocks would otherwise strand transfers we recorded against a dropped block.
 * Re-covering a small window is idempotent — movements dedupe on Alchemy's uniqueId — so
 * the only cost is a slightly wider query.
 */
const REORG_OVERLAP_BLOCKS = 64;

/** Alchemy caps one page at 1000 transfers. */
const PAGE_SIZE = "0x3e8";

const ENS_TTL_MS = 30 * 60_000;

/* -------------------------------------------------------------------------- */
/* Alchemy transfer history                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Shape of one `alchemy_getAssetTransfers` entry, validated rather than trusted.
 *
 * `value` is a JSON number and therefore lossy — 0.11661 ETH does not survive a float
 * round-trip — so the wei amount is read from `rawContract.value`, which is exact hex.
 * The float is accepted only as a last-resort fallback, and says so in the log when used.
 */
const transferSchema = z.object({
  uniqueId: z.string().optional(),
  hash: z.string(),
  from: z.string(),
  to: z.string().nullable().optional(),
  value: z.number().nullable().optional(),
  category: z.string(),
  blockNum: z.string(),
  rawContract: z.object({ value: z.string().nullable().optional() }).nullable().optional(),
  metadata: z.object({ blockTimestamp: z.string().nullable().optional() }).nullable().optional(),
});

const rpcResultSchema = z.object({
  transfers: z.array(transferSchema),
  pageKey: z.string().optional(),
});

type RawTransfer = z.infer<typeof transferSchema>;

/** True when the RPC is Alchemy, whose proprietary transfer index the scan needs. */
export function syncAvailable(url: string = appConfig.httpUrl): boolean {
  return !!url && /alchemy\.com/i.test(url);
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  if (!appConfig.httpUrl) throw new Error("No RPC endpoint configured (set ALCHEMY_API_KEY)");
  const res = await fetch(appConfig.httpUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { result?: unknown; error?: { code?: number; message?: string } };
  if (body.error) {
    // -32601 is "method not found": a non-Alchemy endpoint. Name the cause, because the
    // fix is a config change and not a retry.
    if (body.error.code === -32601) {
      throw new Error(
        "This RPC does not support alchemy_getAssetTransfers. Auto-sync needs an Alchemy endpoint; record movements by hand otherwise.",
      );
    }
    throw new Error(`RPC ${method}: ${body.error.message ?? "unknown error"}`);
  }
  return body.result;
}

function weiOf(t: RawTransfer): bigint | null {
  const raw = t.rawContract?.value;
  if (raw) {
    try {
      return BigInt(raw);
    } catch {
      /* fall through to the float */
    }
  }
  if (typeof t.value === "number" && isFinite(t.value)) {
    logger.warn(`Treasury: transfer ${t.hash} had no rawContract.value; using the lossy float amount.`);
    // Round-trip through a fixed-precision string so the float never reaches a bigint
    // constructor as scientific notation.
    const [whole = "0", frac = ""] = t.value.toFixed(18).split(".");
    return BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, "0").slice(0, 18));
  }
  return null;
}

function toMovement(t: RawTransfer, dir: "in" | "out"): TreasuryMovement | null {
  const wei = weiOf(t);
  if (wei === null || wei <= 0n) return null;
  const counterparty = (dir === "in" ? t.from : t.to) ?? "";
  if (!isAddress(counterparty)) return null;
  const ts = t.metadata?.blockTimestamp ?? null;
  return {
    hash: t.hash,
    dir,
    counterparty: counterparty.toLowerCase(),
    valueWei: wei.toString(),
    blockNumber: Number(BigInt(t.blockNum)),
    timestamp: ts ? new Date(ts).toISOString() : null,
    category: t.category === "internal" ? "internal" : "external",
    excluded: false,
    note: "",
  };
}

/** Alchemy's uniqueId, or a composed equivalent — one tx can carry several transfers. */
function keyOf(t: RawTransfer, dir: "in" | "out"): string {
  return t.uniqueId ?? `${t.hash}:${dir}:${t.category}:${t.rawContract?.value ?? t.value ?? ""}`;
}

async function fetchDirection(
  dir: "in" | "out",
  fromBlock: bigint,
): Promise<{ key: string; movement: TreasuryMovement }[]> {
  const wallet = treasuryAddress();
  const out: { key: string; movement: TreasuryMovement }[] = [];
  let pageKey: string | undefined;

  do {
    const params: Record<string, unknown> = {
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: "latest",
      category: ["external", "internal"],
      withMetadata: true,
      excludeZeroValue: true,
      maxCount: PAGE_SIZE,
      order: "asc",
      [dir === "in" ? "toAddress" : "fromAddress"]: wallet,
    };
    if (pageKey) params.pageKey = pageKey;

    const parsed = rpcResultSchema.safeParse(await rpc("alchemy_getAssetTransfers", [params]));
    if (!parsed.success) {
      throw new Error(`Unexpected alchemy_getAssetTransfers response: ${parsed.error.issues[0]?.message ?? "shape mismatch"}`);
    }

    for (const t of parsed.data.transfers) {
      const movement = toMovement(t, dir);
      if (movement) out.push({ key: keyOf(t, dir), movement });
    }
    pageKey = parsed.data.pageKey;
  } while (pageKey);

  return out;
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

interface RosterEntry {
  address: string;
  nickname: string | null;
  optIn: boolean;
}

interface TreasuryFile {
  lastScannedBlock: number | null;
  syncedAt: string | null;
  /** Keyed by Alchemy uniqueId so a re-scan of the overlap window is idempotent. */
  movements: Record<string, TreasuryMovement>;
  roster: Record<string, RosterEntry>;
}

const emptyFile = (): TreasuryFile => ({
  lastScannedBlock: null,
  syncedAt: null,
  movements: {},
  roster: {},
});

const filePath = (): string => path.join(appConfig.dataDir, "treasury.json");

let cache: TreasuryFile | null = null;

function load(): TreasuryFile {
  if (cache) return cache;
  try {
    if (fs.existsSync(filePath())) {
      const parsed = JSON.parse(fs.readFileSync(filePath(), "utf8")) as Partial<TreasuryFile>;
      // Guard the shape: a truncated file previously became the state verbatim, and every
      // later Object.values() on it would throw on a route that must not 500.
      cache = {
        lastScannedBlock: typeof parsed.lastScannedBlock === "number" ? parsed.lastScannedBlock : null,
        syncedAt: typeof parsed.syncedAt === "string" ? parsed.syncedAt : null,
        movements: parsed.movements && typeof parsed.movements === "object" ? parsed.movements : {},
        roster: parsed.roster && typeof parsed.roster === "object" ? parsed.roster : {},
      };
      return cache;
    }
  } catch (err) {
    logger.warn("Treasury ledger is unreadable; starting an empty one:", (err as Error).message);
  }
  cache = emptyFile();
  return cache;
}

function save(next: TreasuryFile): void {
  cache = next;
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(next, null, 2));
}

/** Test seam — drops the in-memory copy so the next read comes off disk. */
export function resetTreasuryCache(): void {
  cache = null;
  ensCache.clear();
}

/* -------------------------------------------------------------------------- */
/* Chain enrichment                                                           */
/* -------------------------------------------------------------------------- */

const ensCache = new Map<string, { at: number; name: string | null }>();

async function resolveEns(addresses: string[]): Promise<Map<string, string | null>> {
  const now = Date.now();
  const out = new Map<string, string | null>();
  const stale: string[] = [];

  for (const a of addresses) {
    const hit = ensCache.get(a);
    if (hit && now - hit.at <= ENS_TTL_MS) out.set(a, hit.name);
    else stale.push(a);
  }

  // Sequential rather than Promise.all: the http transport batches concurrent requests,
  // and a wide reverse-resolution batch is the oversized-batch shape RPCs reject whole.
  for (const a of stale) {
    let name: string | null = null;
    try {
      name = await publicClient.getEnsName({ address: getAddress(a) });
    } catch (err) {
      logger.warn(`ENS lookup failed for ${a}:`, (err as Error).message);
    }
    ensCache.set(a, { at: now, name });
    out.set(a, name);
  }
  return out;
}

/** Live citizen count per owner, lowercased. Empty when ownership indexing is unavailable. */
async function citizensByOwner(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  try {
    const snap = await getGameSnapshot();
    for (const { owner } of await fetchLiveCitizens(snap.citizensAddress)) {
      const k = owner.toLowerCase();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  } catch (err) {
    logger.warn("Treasury: citizen counts unavailable:", (err as Error).message);
  }
  return counts;
}

/** Addresses that have actually emigrated a citizen, so a subsidy can be shown to have worked. */
async function emigratedAddresses(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  try {
    for (const record of await fetchEmigrationRoster()) {
      const k = record.emigratedBy.toLowerCase();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  } catch (err) {
    logger.warn("Treasury: emigration roster unavailable:", (err as Error).message);
  }
  return counts;
}

/* -------------------------------------------------------------------------- */
/* Sync + ledger                                                              */
/* -------------------------------------------------------------------------- */

/** Pull new movements off the chain and fold them into the stored ledger. */
export async function syncTreasury(): Promise<{ added: number; scannedTo: number }> {
  const state = load();
  const latest = await publicClient.getBlockNumber();
  const cursor = state.lastScannedBlock === null ? 0n : BigInt(state.lastScannedBlock);
  const from = cursor > BigInt(REORG_OVERLAP_BLOCKS) ? cursor - BigInt(REORG_OVERLAP_BLOCKS) : 0n;

  // Sequential for the same batching reason as the ENS pass above.
  const inbound = await fetchDirection("in", from);
  const outbound = await fetchDirection("out", from);

  const movements = { ...state.movements };
  let added = 0;
  for (const { key, movement } of [...inbound, ...outbound]) {
    const existing = movements[key];
    if (existing) {
      // Re-scanning the overlap window must never clobber an operator's annotation.
      movements[key] = { ...movement, excluded: existing.excluded, note: existing.note };
    } else {
      movements[key] = movement;
      added++;
    }
  }

  save({
    ...state,
    movements,
    lastScannedBlock: Number(latest),
    syncedAt: new Date().toISOString(),
  });
  return { added, scannedTo: Number(latest) };
}

/** Compose the ledger the dashboard and the published page both read. */
export async function buildTreasuryLedger(): Promise<TreasuryLedger> {
  const state = load();
  const movements = Object.values(state.movements).sort(
    (a, b) => b.blockNumber - a.blockNumber || a.hash.localeCompare(b.hash),
  );

  let raised = 0n;
  let deployed = 0n;
  const contributed = new Map<string, bigint>();
  const paidTo = new Map<string, number>();

  for (const m of movements) {
    if (m.excluded) continue;
    const wei = BigInt(m.valueWei);
    if (m.dir === "in") {
      raised += wei;
      contributed.set(m.counterparty, (contributed.get(m.counterparty) ?? 0n) + wei);
    } else {
      deployed += wei;
      paidTo.set(m.counterparty, (paidTo.get(m.counterparty) ?? 0) + 1);
    }
  }

  const [citizens, emigrations] = await Promise.all([citizensByOwner(), emigratedAddresses()]);

  // A participant has either paid in or pledged to. Anyone else — including a wallet we
  // merely paid a subsidy to — is not splitting the bill and must not dilute the divisor.
  const addresses = new Set<string>([
    ...contributed.keys(),
    ...Object.values(state.roster).filter((r) => r.optIn).map((r) => r.address),
  ]);

  const totalCitizens = [...addresses].reduce((sum, a) => sum + (citizens.get(a) ?? 0), 0);
  const perCitizen = totalCitizens > 0 ? deployed / BigInt(totalCitizens) : null;

  const participants: TreasuryParticipant[] = [...addresses].map((address) => {
    const held = citizens.get(address) ?? 0;
    const paid = contributed.get(address) ?? 0n;
    // Multiply before dividing so the split is exact to the wei rather than compounding
    // a rounded per-citizen rate across every holder.
    const fair = totalCitizens > 0 ? (deployed * BigInt(held)) / BigInt(totalCitizens) : null;
    const delta = fair === null ? null : paid - fair;
    const roster = state.roster[address];

    return {
      address,
      ens: null,
      nickname: roster?.nickname ?? null,
      citizens: held,
      optIn: roster?.optIn ?? false,
      contributedWei: paid.toString(),
      fairShareWei: fair === null ? null : fair.toString(),
      deltaWei: delta === null ? null : delta.toString(),
      position:
        delta === null ? "uncounted" : delta === 0n ? "square" : delta > 0n ? "credit" : "owes",
      departuresConfirmed: Math.min(paidTo.get(address) ?? 0, emigrations.get(address) ?? 0),
    };
  });

  const ens = await resolveEns(participants.map((p) => p.address));
  for (const p of participants) p.ens = ens.get(p.address) ?? null;

  participants.sort((a, b) => {
    const d = BigInt(b.contributedWei) - BigInt(a.contributedWei);
    if (d !== 0n) return d > 0n ? 1 : -1;
    return b.citizens - a.citizens || a.address.localeCompare(b.address);
  });

  return {
    wallet: treasuryAddress().toLowerCase(),
    raisedWei: raised.toString(),
    deployedWei: deployed.toString(),
    onHandWei: (raised - deployed).toString(),
    totalCitizens,
    perCitizenWei: perCitizen === null ? null : perCitizen.toString(),
    participants,
    movements,
    syncedAt: state.syncedAt,
    lastScannedBlock: state.lastScannedBlock,
    syncAvailable: syncAvailable(),
    syncError: null,
    citizensAvailable: citizens.size > 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Operator edits                                                             */
/* -------------------------------------------------------------------------- */

/** Set the nickname and/or opt-in pledge for an address. */
export function upsertParticipant(input: {
  address: string;
  nickname?: string | null;
  optIn?: boolean;
}): void {
  const state = load();
  const address = input.address.toLowerCase();
  const existing = state.roster[address];
  save({
    ...state,
    roster: {
      ...state.roster,
      [address]: {
        address,
        nickname: input.nickname === undefined ? (existing?.nickname ?? null) : input.nickname,
        optIn: input.optIn === undefined ? (existing?.optIn ?? false) : input.optIn,
      },
    },
  });
}

export function removeParticipant(address: string): void {
  const state = load();
  const roster = { ...state.roster };
  delete roster[address.toLowerCase()];
  save({ ...state, roster });
}

/** Annotate a movement — exclude it from the maths, and/or attach a note. */
export function annotateMovement(key: string, patch: { excluded?: boolean; note?: string }): boolean {
  const state = load();
  const movement = state.movements[key];
  if (!movement) return false;
  save({
    ...state,
    movements: {
      ...state.movements,
      [key]: {
        ...movement,
        excluded: patch.excluded ?? movement.excluded,
        note: patch.note ?? movement.note,
      },
    },
  });
  return true;
}

/** Movement keys, in the order buildTreasuryLedger returns them — the UI needs the pairing. */
export function movementKeys(): Record<string, string> {
  const state = load();
  const out: Record<string, string> = {};
  for (const [key, m] of Object.entries(state.movements)) {
    out[`${m.hash}:${m.dir}:${m.valueWei}`] = key;
  }
  return out;
}
