import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { encodeFunctionData, parseEventLogs, toFunctionSelector, type Abi } from "viem";
import { EVM } from "@ethereumjs/evm";
import { Account, Address, hexToBytes, bytesToHex } from "@ethereumjs/util";

/**
 * contracts/CitizenVault.sol — compiled and EXECUTED, not inspected.
 *
 * The contract holds every citizen once an operator migrates, so "it looks right" is not a
 * standard worth shipping on. Two things in particular cannot be established by reading:
 *
 *  1. The selector allowlist. The four constants are keccak-of-signature, and under the
 *     optimiser `audit`'s value does not appear as a literal in the deployed bytecode at
 *     all — a hex search says "missing", which would mean every audit reverts. Only running
 *     it settles that, and it is why this file exists.
 *  2. `receive()` fitting inside a 2300-gas stipend. A payout using `.transfer()` forwards
 *     only that much; an event or a state write in `receive` would make such a payment
 *     bounce and the ETH unclaimable. That is invisible in review and obvious in execution.
 *
 * Deliberately compiled from source each run rather than checked-in bytecode: the point is
 * to test the contract that is in the repo right now, not one someone remembered to rebuild.
 */

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS = path.resolve(HERE, "../../../contracts");

/** A stand-in for the game. `audit(_, 999)` reverts so per-call tolerance is exercised for
 *  real rather than mocked. */
const MOCK_GAME = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract MockGame {
    function payTaxes(uint256, uint8) external payable {}
    function audit(uint256, uint256 target) external payable { require(target != 999, "cured first"); }
    function useBribe(uint256) external {}
    function kill(uint256) external {}
}`;

/** Minimal ERC721 so a citizen can genuinely be transferred in and withdrawn out. */
const MINI_NFT = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface IERC721Receiver { function onERC721Received(address,address,uint256,bytes calldata) external returns (bytes4); }
contract MiniNFT {
    mapping(uint256 => address) public ownerOf;
    function mint(address to, uint256 id) external { ownerOf[id] = to; }
    function safeTransferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from, "not owner");
        ownerOf[id] = to;
        if (to.code.length > 0) {
            require(IERC721Receiver(to).onERC721Received(msg.sender, from, id, "") == 0x150b7a02, "bad receiver");
        }
    }
}`;

/** A prize payout that pushes with the stingiest realistic gas budget. */
const STINGY_PAYER = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Payer { function payOut(address payable to) external payable { to.transfer(msg.value); } }`;

const OWNER = new Address(hexToBytes("0x" + "11".repeat(20))); // cold key
const OPERATOR = new Address(hexToBytes("0x" + "22".repeat(20))); // bot hot key
const STRANGER = new Address(hexToBytes("0x" + "33".repeat(20)));
const COINBASE = new Address(hexToBytes("0x" + "44".repeat(20)));

let vaultAbi: Abi;
let vaultBytecode: string;
let evm: EVM;
let vault: Address;
let nft: Address;
let payer: Address;

const gameFn = (name: string, inputs: string[], mut: "payable" | "nonpayable" = "payable") =>
  [{ type: "function", name, inputs: inputs.map((t) => ({ type: t })), outputs: [], stateMutability: mut }] as Abi;

const payData = (id: bigint) =>
  encodeFunctionData({ abi: gameFn("payTaxes", ["uint256", "uint8"]), functionName: "payTaxes", args: [id, 1] });
const auditData = (from: bigint, target: bigint) =>
  encodeFunctionData({ abi: gameFn("audit", ["uint256", "uint256"]), functionName: "audit", args: [from, target] });

interface Call { data: `0x${string}`; value: bigint; tolerate: boolean }

async function deploy(bytecodeHex: string, caller = OWNER): Promise<Address> {
  const r = await evm.runCall({ caller, to: undefined, data: hexToBytes(`0x${bytecodeHex}`), gasLimit: 10_000_000n });
  if (r.execResult.exceptionError) throw new Error(`deploy failed: ${r.execResult.exceptionError.error}`);
  return r.createdAddress!;
}

async function rawCall(caller: Address, to: Address, data: `0x${string}`, value = 0n) {
  const r = await evm.runCall({ caller, to, data: hexToBytes(data), value, gasLimit: 5_000_000n });
  return {
    reverted: !!r.execResult.exceptionError,
    ret: bytesToHex(r.execResult.returnValue ?? new Uint8Array()),
    // Padded out to viem's Log shape. The EVM hands back only (address, topics, data); the
    // block/tx fields are placeholders because nothing here is mined, and parseEventLogs
    // reads none of them — but filling them keeps the type honest rather than casting it
    // away and losing the decode's own type-checking with it.
    logs: (r.execResult.logs ?? []).map((l, i) => ({
      address: bytesToHex(l[0]) as `0x${string}`,
      topics: l[1].map((t) => bytesToHex(t)) as [`0x${string}`, ...`0x${string}`[]],
      data: bytesToHex(l[2]) as `0x${string}`,
      blockHash: `0x${"00".repeat(32)}` as `0x${string}`,
      blockNumber: 0n,
      logIndex: i,
      transactionHash: `0x${"00".repeat(32)}` as `0x${string}`,
      transactionIndex: 0,
      removed: false as const,
    })),
  };
}

/** Call `run`, sending exactly what the vault requires unless overridden. */
async function run(caller: Address, calls: Call[], bidWei = 0n, valueOverride?: bigint) {
  const data = encodeFunctionData({ abi: vaultAbi, functionName: "run", args: [calls, bidWei] });
  const value = valueOverride ?? calls.reduce((s, c) => s + c.value, bidWei);
  return rawCall(caller, vault, data, value);
}

const balanceOf = async (a: Address) => (await evm.stateManager.getAccount(a))?.balance ?? 0n;
const okFlags = (logs: Awaited<ReturnType<typeof rawCall>>["logs"]) =>
  parseEventLogs({ abi: vaultAbi, eventName: "CallResult", logs }).map((l) => (l as unknown as { args: { ok: boolean } }).args.ok);

beforeAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const solc = require("solc") as { compile: (i: string) => string };
  const out = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: {
          "CitizenVault.sol": { content: fs.readFileSync(path.join(CONTRACTS, "CitizenVault.sol"), "utf8") },
          "MockGame.sol": { content: MOCK_GAME },
          "MiniNFT.sol": { content: MINI_NFT },
          "Payer.sol": { content: STINGY_PAYER },
        },
        settings: {
          // Optimiser ON deliberately: it is the configuration that would be deployed, and
          // the one under which the audit selector stops appearing as a literal.
          optimizer: { enabled: true, runs: 200 },
          outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
        },
      }),
    ),
  );
  const fatal = (out.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  expect(fatal.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n")).toBe("");

  const art = out.contracts["CitizenVault.sol"].CitizenVault;
  vaultAbi = art.abi as Abi;
  vaultBytecode = art.evm.bytecode.object;

  evm = await EVM.create();
  for (const a of [OWNER, OPERATOR, STRANGER]) {
    await evm.stateManager.putAccount(a, new Account(0n, 10n ** 20n));
  }
  const game = await deploy(out.contracts["MockGame.sol"].MockGame.evm.bytecode.object);
  nft = await deploy(out.contracts["MiniNFT.sol"].MiniNFT.evm.bytecode.object);
  payer = await deploy(out.contracts["Payer.sol"].Payer.evm.bytecode.object);

  const ctorArgs = encodeFunctionData({
    abi: gameFn("c", ["address", "address", "address"], "nonpayable"),
    functionName: "c",
    args: [bytesToHex(game.bytes), bytesToHex(nft.bytes), bytesToHex(OPERATOR.bytes)],
  }).slice(10);
  vault = await deploy(art.evm.bytecode.object + ctorArgs);
}, 120_000);

describe("CitizenVault: the selector allowlist", () => {
  it("accepts audit(uint256,uint256) — the constant the optimiser hides", async () => {
    const r = await run(OPERATOR, [{ data: auditData(1n, 501n), value: 690_000_000_000_000n, tolerate: true }]);
    expect(r.reverted).toBe(false);
  });

  it("accepts all four game selectors in one batch, one CallResult each", async () => {
    const calls: Call[] = [
      { data: payData(10n), value: 1000n, tolerate: false },
      { data: auditData(10n, 501n), value: 690_000_000_000_000n, tolerate: true },
      { data: encodeFunctionData({ abi: gameFn("useBribe", ["uint256"], "nonpayable"), functionName: "useBribe", args: [1n] }), value: 0n, tolerate: false },
      { data: encodeFunctionData({ abi: gameFn("kill", ["uint256"], "nonpayable"), functionName: "kill", args: [1n] }), value: 0n, tolerate: false },
    ];
    const r = await run(OPERATOR, calls);
    expect(r.reverted).toBe(false);
    expect(okFlags(r.logs)).toEqual([true, true, true, true]);
  });

  it("rejects transferFrom even when marked tolerate — the property that makes custody safe", async () => {
    const data = (toFunctionSelector("function transferFrom(address,address,uint256)") + "00".repeat(96)) as `0x${string}`;
    const r = await run(OPERATOR, [{ data, value: 0n, tolerate: true }]);
    expect(r.reverted).toBe(true);
  });
});

describe("CitizenVault: per-call revert tolerance", () => {
  it("a tolerated failure does not drop the payment beside it", async () => {
    const r = await run(OPERATOR, [
      { data: payData(10n), value: 1000n, tolerate: false },
      { data: auditData(10n, 999n), value: 690_000_000_000_000n, tolerate: true }, // reverts in the mock
    ]);
    expect(r.reverted).toBe(false);
    // Exactly which one failed, which is what the activity log reads back.
    expect(okFlags(r.logs)).toEqual([true, false]);
  });

  it("an intolerant failure reverts the whole batch, so a must-land payment fails loudly", async () => {
    const r = await run(OPERATOR, [{ data: auditData(10n, 999n), value: 690_000_000_000_000n, tolerate: false }]);
    expect(r.reverted).toBe(true);
  });

  it("refunds a failed call's value instead of parking it in the vault", async () => {
    const before = await balanceOf(vault);
    await run(OPERATOR, [{ data: auditData(10n, 999n), value: 690_000_000_000_000n, tolerate: true }]);
    expect(await balanceOf(vault)).toBe(before);
  });
});

describe("CitizenVault: value and authorisation", () => {
  it("reverts when msg.value is not exactly sum(values) + bid", async () => {
    const r = await run(OPERATOR, [{ data: payData(10n), value: 1000n, tolerate: false }], 500n, 999n);
    expect(r.reverted).toBe(true);
  });

  it("pays the bid inline to block.coinbase", async () => {
    const before = await balanceOf(COINBASE);
    const data = encodeFunctionData({ abi: vaultAbi, functionName: "run", args: [[], 12_345n] });
    await evm.runCall({
      caller: OPERATOR, to: vault, data: hexToBytes(data), value: 12_345n, gasLimit: 3_000_000n,
      block: { header: { coinbase: COINBASE, number: 1n, timestamp: 1n, difficulty: 0n, prevRandao: new Uint8Array(32), gasLimit: 30_000_000n, baseFeePerGas: 0n } } as never,
    });
    expect((await balanceOf(COINBASE)) - before).toBe(12_345n);
  });

  it("lets owner and operator call run, and nobody else", async () => {
    const call: Call[] = [{ data: payData(10n), value: 1000n, tolerate: false }];
    expect((await run(OPERATOR, call)).reverted).toBe(false);
    expect((await run(OWNER, call)).reverted).toBe(false);
    expect((await run(STRANGER, call)).reverted).toBe(true);
  });
});

describe("CitizenVault: getting things back out", () => {
  it("accepts ETH pushed with only a 2300-gas stipend", async () => {
    // A prize paid with `.transfer()` forwards 2300 gas. An event or state write in
    // receive() would make this bounce and the ETH unclaimable — hence an empty receive().
    const before = await balanceOf(vault);
    const data = encodeFunctionData({ abi: gameFn("payOut", ["address"]), functionName: "payOut", args: [bytesToHex(vault.bytes)] });
    const r = await rawCall(OWNER, payer, data, 3n * 10n ** 18n);
    expect(r.reverted).toBe(false);
    expect(await balanceOf(vault)).toBe(before + 3n * 10n ** 18n);
  });

  it("sweeps to the cold key only — the bot key cannot take ETH", async () => {
    const dest = new Address(hexToBytes("0x" + "99".repeat(20)));
    const data = encodeFunctionData({ abi: vaultAbi, functionName: "sweep", args: [bytesToHex(dest.bytes)] });
    expect((await rawCall(OPERATOR, vault, data)).reverted).toBe(true);
    const amount = await balanceOf(vault);
    expect(amount).toBeGreaterThan(0n);
    expect((await rawCall(OWNER, vault, data)).reverted).toBe(false);
    expect(await balanceOf(vault)).toBe(0n);
    expect(await balanceOf(dest)).toBe(amount);
  });

  it("takes a citizen in by safeTransferFrom and gives it back to the cold key only", async () => {
    const mint = encodeFunctionData({ abi: gameFn("mint", ["address", "uint256"], "nonpayable"), functionName: "mint", args: [bytesToHex(OWNER.bytes), 357n] });
    await rawCall(OWNER, nft, mint);
    const xfer = encodeFunctionData({ abi: gameFn("safeTransferFrom", ["address", "address", "uint256"], "nonpayable"), functionName: "safeTransferFrom", args: [bytesToHex(OWNER.bytes), bytesToHex(vault.bytes), 357n] });
    expect((await rawCall(OWNER, nft, xfer)).reverted).toBe(false);

    const ownerOf = encodeFunctionData({ abi: gameFn("ownerOf", ["uint256"], "nonpayable"), functionName: "ownerOf", args: [357n] });
    expect((await rawCall(OWNER, nft, ownerOf)).ret.endsWith(bytesToHex(vault.bytes).slice(2))).toBe(true);

    const wd = encodeFunctionData({ abi: vaultAbi, functionName: "withdrawCitizens", args: [[357n], bytesToHex(OWNER.bytes)] });
    expect((await rawCall(OPERATOR, vault, wd)).reverted).toBe(true);
    expect((await rawCall(OWNER, vault, wd)).reverted).toBe(false);
    expect((await rawCall(OWNER, nft, ownerOf)).ret.endsWith(bytesToHex(OWNER.bytes).slice(2))).toBe(true);
  });

  it("CANNOT call an arbitrary claim() — so withdraw citizens before any pull-style payout", async () => {
    // The documented limitation, pinned as a test. If the endgame ever pays by making the
    // owner call something, a vault-held citizen cannot claim it; withdraw first.
    const r = await run(OPERATOR, [{ data: toFunctionSelector("function claim()"), value: 0n, tolerate: false }]);
    expect(r.reverted).toBe(true);
  });
});

describe("CitizenVault: deployment guards", () => {
  it("refuses to deploy against a game address with no code", async () => {
    // The failure this prevents is silent and permanent. A low-level call to an address
    // with no code SUCCEEDS and returns true, so a mistyped game address would make every
    // payTaxes report ok while sending the tax to a dead address: the activity log reads
    // "included", the citizen goes unpaid, and it is killed on schedule with nothing
    // anywhere explaining why. Measured before the guard existed: 0.5 ETH gone, run()
    // returned success. Deploy time is the only cheap place to catch it.
    const notAContract = "0x00000000000000000000000000000000deadbeef";
    const ctorArgs = encodeFunctionData({
      abi: gameFn("c", ["address", "address", "address"], "nonpayable"),
      functionName: "c",
      args: [notAContract, notAContract, bytesToHex(OPERATOR.bytes)],
    }).slice(10);
    await expect(deploy(vaultBytecode + ctorArgs)).rejects.toThrow();
  });
});
