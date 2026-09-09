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

/** A block.coinbase that burns all the gas it is handed, rather than reverting cheaply.
 *  Reverting was already covered; exhaustion is the case that can take the payments with it. */
const GAS_BURNER = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract GasBurner {
    uint256 public burned;
    receive() external payable { while (true) { burned++; } }
}`;

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
/** A second ERC721, unrelated to `citizens` — the junk a vault should refuse. */
let junkNft: Address;
let gasBurner: Address;

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
          "GasBurner.sol": { content: GAS_BURNER },
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
  // Same code as `nft`, different address — which is the only thing that makes it "junk".
  junkNft = await deploy(out.contracts["MiniNFT.sol"].MiniNFT.evm.bytecode.object);
  gasBurner = await deploy(out.contracts["GasBurner.sol"].GasBurner.evm.bytecode.object);

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

describe("CitizenVault: a hostile block.coinbase cannot cost us a payment", () => {
  /** `run`, with block.coinbase pointed at whichever address the case wants. */
  const runWithCoinbase = async (coinbase: Address, calls: Call[], bidWei: bigint) => {
    const data = encodeFunctionData({ abi: vaultAbi, functionName: "run", args: [calls, bidWei] });
    const value = calls.reduce((s, c) => s + c.value, bidWei);
    const r = await evm.runCall({
      // PRODUCTION-REALISTIC, and load-bearing. strategy.ts signs
      // VAULT_CALL_OVERHEAD_GAS + n*VAULT_PER_CALL_GAS = 60,000 + 2*145,000 = 350,000 for this
      // batch. An unbounded coinbase forward only starves the epilogue when 1/64 of the gas
      // remaining at that point is under the refund cost (~9,700), i.e. under ~620,000 — so a
      // roomy 3,000,000 here made the case pass against the very bug it exists to catch.
      caller: OPERATOR, to: vault, data: hexToBytes(data), value, gasLimit: 350_000n,
      block: { header: { coinbase, number: 1n, timestamp: 1n, difficulty: 0n, prevRandao: new Uint8Array(32), gasLimit: 30_000_000n, baseFeePerGas: 0n } } as never,
    });
    return {
      reverted: !!r.execResult.exceptionError,
      error: r.execResult.exceptionError?.error,
      logs: (r.execResult.logs ?? []).map((l, i) => ({
        address: bytesToHex(l[0]) as `0x${string}`,
        topics: l[1].map((t) => bytesToHex(t)) as [`0x${string}`, ...`0x${string}`[]],
        data: bytesToHex(l[2]) as `0x${string}`,
        blockHash: `0x${"00".repeat(32)}` as `0x${string}`,
        blockNumber: 0n, logIndex: i,
        transactionHash: `0x${"00".repeat(32)}` as `0x${string}`,
        transactionIndex: 0, removed: false as const,
      })),
    };
  };

  /** A payment that MUST land, plus a tolerated audit that reverts (target 999) so a refund
   *  is genuinely owed after the bid — the refund is what runs out of gas. */
  const batch = (): Call[] => [
    { data: payData(77n), value: 1000n, tolerate: false },
    { data: auditData(77n, 999n), value: 690_000_000_000_000n, tolerate: true },
  ];

  it("still pays the bid to an ordinary recipient", async () => {
    // Control: the bound must not have broken the normal path.
    const before = await balanceOf(COINBASE);
    const r = await runWithCoinbase(COINBASE, batch(), 12_345n);
    expect(r.reverted).toBe(false);
    expect((await balanceOf(COINBASE)) - before).toBe(12_345n);
    expect(okFlags(r.logs)).toEqual([true, false]);
  });

  it("survives a fee recipient that burns every gas unit it is given", async () => {
    /**
     * The finding this pins. `call(gas(), coinbase(), …)` forwards 63/64 of the remaining gas,
     * so a recipient that never returns leaves 1/64 — and `msg.sender.call` for the refund
     * still needs ~9,700. Running out THERE is an out-of-gas in our own frame, which reverts
     * the entire transaction: the payment that already succeeded is undone.
     *
     * Ignoring the call's result does not help. A revert is cheap and was already covered;
     * exhaustion is a different mechanism and needs a gas bound, which is why the call is
     * `call(50000, …)`. Mutating that back to `gas()` fails this case.
     */
    const before = await balanceOf(gasBurner);
    const r = await runWithCoinbase(gasBurner, batch(), 12_345n);
    expect(r.reverted).toBe(false);
    // The payment landed and the audit was tolerated — the batch was NOT rolled back.
    expect(okFlags(r.logs)).toEqual([true, false]);
    // The burner consumed its gas and never took the money, so the bid stayed with us.
    expect(await balanceOf(gasBurner)).toBe(before);
  });

  it("refunds the tolerated audit's fee even when the recipient burns gas", async () => {
    // The specific step that would have run out. Measured on the operator's balance rather
    // than asserted from the log, so a silently swallowed refund cannot pass.
    const AUDIT = 690_000_000_000_000n;
    const before = await balanceOf(OPERATOR);
    const r = await runWithCoinbase(gasBurner, batch(), 0n);
    expect(r.reverted).toBe(false);
    // Paid 1000 for the payment, sent AUDIT for the audit, got AUDIT back. Gas is free in
    // this EVM harness, so the net movement is exactly the payment.
    expect(before - (await balanceOf(OPERATOR))).toBe(1000n);
  });
});

describe("CitizenVault: what it refuses to hold", () => {
  it("rejects an ERC721 that is not the citizen collection", async () => {
    /**
     * withdrawCitizens can only move `citizens`, so anything else that got in would be stuck
     * here permanently and a generic rescue would widen the exit surface this contract keeps
     * deliberately narrow. Refusing on the way in is the cheap end of that trade.
     */
    const mint = encodeFunctionData({ abi: gameFn("mint", ["address", "uint256"], "nonpayable"), functionName: "mint", args: [bytesToHex(OWNER.bytes), 4242n] });
    await rawCall(OWNER, junkNft, mint);
    const xfer = encodeFunctionData({ abi: gameFn("safeTransferFrom", ["address", "address", "uint256"], "nonpayable"), functionName: "safeTransferFrom", args: [bytesToHex(OWNER.bytes), bytesToHex(vault.bytes), 4242n] });
    expect((await rawCall(OWNER, junkNft, xfer)).reverted).toBe(true);

    // Non-vacuity: the SAME transfer of the SAME id succeeds from the real collection, so the
    // rejection is about which collection asked and not about the token or the transfer shape.
    await rawCall(OWNER, nft, mint);
    const realXfer = encodeFunctionData({ abi: gameFn("safeTransferFrom", ["address", "address", "uint256"], "nonpayable"), functionName: "safeTransferFrom", args: [bytesToHex(OWNER.bytes), bytesToHex(vault.bytes), 4242n] });
    expect((await rawCall(OWNER, nft, realXfer)).reverted).toBe(false);

    // And it is recoverable, which is the whole reason the restriction is worth having.
    const wd = encodeFunctionData({ abi: vaultAbi, functionName: "withdrawCitizens", args: [[4242n], bytesToHex(OWNER.bytes)] });
    expect((await rawCall(OWNER, vault, wd)).reverted).toBe(false);
  });

  it("refuses to sweep to address(0) rather than burning the balance", async () => {
    const zero = new Address(hexToBytes("0x" + "00".repeat(20)));
    const data = encodeFunctionData({ abi: vaultAbi, functionName: "sweep", args: [bytesToHex(zero.bytes)] });
    expect((await rawCall(OWNER, vault, data)).reverted).toBe(true);
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

/**
 * What the wrapper actually costs, measured rather than assumed.
 *
 * The branch note recorded fork numbers and concluded "both should be brought to the measured
 * numbers". That is right for ONE of the three constants and wrong for the other two, which is
 * why this block exists instead of a straight edit:
 *
 *   GAS_VAULT_OVERHEAD (shared)      prices a bundle for the DENSITY math. Wants real gas.
 *   VAULT_CALL_OVERHEAD_GAS (bot)    sets the SIGNED GAS LIMIT.
 *   VAULT_PER_CALL_GAS (bot)         same.
 *
 * A signed gas limit must cover intrinsic (21,000) + calldata + execution. Setting it to the
 * measured EXECUTION figures would put the limit BELOW actual usage and every vault transaction
 * would run out of gas — a boundary lost every night, from a change that reads like a tidy-up.
 *
 * Note these numbers are execution only: evm.runCall charges no intrinsic and no calldata.
 */
describe("CitizenVault: measured gas", () => {
  const gasOf = async (calls: Call[], bidWei = 0n): Promise<bigint> => {
    const data = encodeFunctionData({ abi: vaultAbi, functionName: "run", args: [calls, bidWei] });
    const value = calls.reduce((s, c) => s + c.value, bidWei);
    const r = await evm.runCall({
      caller: OPERATOR, to: vault, data: hexToBytes(data), value, gasLimit: 5_000_000n,
    });
    if (r.execResult.exceptionError) throw new Error(String(r.execResult.exceptionError.error));
    return r.execResult.executionGasUsed;
  };
  // Reuses the file’s own encoders, so these measure the exact calldata the other cases send.
  const pay = (id: number): Call => ({ data: payData(BigInt(id)), value: 0n, tolerate: false });
  const audit = (from: number, target: number): Call =>
    ({ data: auditData(BigInt(from), BigInt(target)), value: 0n, tolerate: true });

  it("reports the shape the constants have to cover", async () => {
    const wrapper = await gasOf([], 10n ** 15n);
    const p1 = await gasOf([pay(1)]);
    const p2 = await gasOf([pay(1), pay(2)]);
    const p5 = await gasOf([pay(1), pay(2), pay(3), pay(4), pay(5)]);
    const a1 = await gasOf([audit(1, 100)]);
    const a2 = await gasOf([audit(1, 100), audit(2, 101)]);
    const marginalPay = p2 - p1;
    const marginalAudit = a2 - a1;

    // eslint-disable-next-line no-console
    console.log(`
  wrapper only (bid, 0 calls) : ${wrapper}
  1 payment                   : ${p1}
  2 payments                  : ${p2}   marginal ${marginalPay}
  5 payments                  : ${p5}
  1 audit                     : ${a1}
  2 audits                    : ${a2}   marginal ${marginalAudit}
  + intrinsic per TX          : 21000  (charged on chain, not by runCall)`);

    /**
     * The wrapper is cheap — the whole basis for batching — but read this number carefully.
     *
     * It includes ~25,000 of COLD-ACCOUNT creation for block.coinbase, which this EVM has
     * never seen and mainnet always has. Subtract that and it lands on ~10,100, which is
     * exactly what the mainnet fork measured independently (VAULT-STATUS). Two different
     * methods agreeing on the wrapper cost is worth more than either alone.
     */
    const COLD_COINBASE = 25_000;
    expect(Number(wrapper) - COLD_COINBASE).toBeLessThan(15_000);
    // And the per-call figures here are the WRAPPER cost only: MockGame.payTaxes is an empty
    // function, so the real game action is not in these numbers.
    expect(Number(marginalPay)).toBeLessThan(10_000);
    expect(Number(marginalAudit)).toBeLessThan(10_000);
  });

  it("the SIGNED limit the bot uses covers real usage with margin, for a big holder", async () => {
    // The property that matters: 9 payments + 11 audits — the shape a nine-citizen holder
    // actually sends — must fit inside what strategy.ts signs, with the on-chain intrinsic and
    // a calldata allowance added on top of what runCall charges.
    const calls = [
      ...Array.from({ length: 9 }, (_, i) => pay(i + 1)),
      ...Array.from({ length: 11 }, (_, i) => audit(i + 1, 200 + i)),
    ];
    const execution = await gasOf(calls, 10n ** 16n);
    const CALLDATA_ALLOWANCE = 20n * 320n; // ~320 gas per 100-byte Call struct, generous
    const realistic = execution + 21_000n + CALLDATA_ALLOWANCE;

    const VAULT_CALL_OVERHEAD_GAS = 60_000n; // mirrored from strategy.ts
    const VAULT_PER_CALL_GAS = 145_000n;
    const signed = VAULT_CALL_OVERHEAD_GAS + BigInt(calls.length) * VAULT_PER_CALL_GAS;

    // eslint-disable-next-line no-console
    console.log(`  20-action batch: execution ${execution}, realistic ${realistic}, signed ${signed}`);
    expect(signed).toBeGreaterThan(realistic);
  });
});

/**
 * Adversarial pass, 2026-09-08. Things that cannot be settled by reading the source.
 */
describe("CitizenVault: adversarial", () => {
  it("short calldata cannot zero-pad its way into an allowlisted selector", async () => {
    // bytes4(bytes) truncates or PADS. If a 1-byte payload padded to a selector that
    // happened to match, the allowlist would be bypassable. It pads with zeros, so the
    // result is 0x00000000 — which matches nothing — but that is worth executing rather
    // than reasoning about, because the failure mode is silent.
    for (const data of ["0x", "0x58", "0x586700"] as `0x${string}`[]) {
      const r = await run(OPERATOR, [{ data, value: 0n, tolerate: true }]);
      expect(r.reverted, `payload ${data} must be rejected`).toBe(true);
    }
  });

  it("tolerate: true cannot smuggle a disallowed selector past the check", async () => {
    // The selector check precedes the call and is NOT tolerate-gated. If tolerance were
    // applied first, a hostile batch could name transferFrom and simply swallow the failure
    // — except the failure would be the vault's own revert, not the call's.
    const transferData = ("0x23b872dd" + "00".repeat(96)) as `0x${string}`;
    const r = await run(OPERATOR, [{ data: transferData, value: 0n, tolerate: true }]);
    expect(r.reverted).toBe(true);
  });

  it("the operator cannot spend a standing balance the vault happens to hold", async () => {
    // The property the owner/operator split rests on. msg.value must equal sum(values) + bid,
    // so a compromised bot key can never reach ETH already sitting here — it can only spend
    // what it supplies itself. Fund the vault, then try to pay taxes from that balance.
    const acct = await evm.stateManager.getAccount(vault);
    await evm.stateManager.putAccount(vault, Object.assign(acct!, { balance: 10n ** 18n }));
    const before = await balanceOf(vault);

    const r = await run(OPERATOR, [{ data: payData(1n), value: 10n ** 17n, tolerate: false }], 0n, 0n);
    expect(r.reverted, "value mismatch must reject it").toBe(true);
    expect(await balanceOf(vault)).toBe(before);
  });
});
