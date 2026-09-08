import { describe, it, expect } from "vitest";
import { decodeErrorResult, toFunctionSelector } from "viem";
import { deathAndTaxesAbi } from "@dat-bot/shared";

/**
 * The game can revert with errors it does not DECLARE.
 *
 * `audit()` on a burned citizen reverts with `ERC721NonexistentToken(tokenId)` — inherited
 * from the ERC721 base, thrown by the Citizens contract, and absent from the game's own ABI.
 * That cost real time: the selector 0x7e273289 showed up opaque in a fork simulation, and the
 * leading hypothesis became "life insurance blocks auditing", which is false. Every one of the
 * six rejected targets was simply DEAD — `lastEpochPaid` is a mapping that survives the burn,
 * so a burned citizen still reads as N epochs behind while `ownerOf` reverts.
 *
 * Checked against chain 2026-09-07: those six are burned; seven targets audited successfully
 * that same week are alive; and ALL THIRTEEN carry hasLifeInsurance = 1, which is what refutes
 * the insurance theory outright.
 *
 * The ABI on master already carries this entry, so nothing needed adding — I added a duplicate
 * before a mutation caught it. This is a REGRESSION PIN, not a fix: the ABI is copied from the
 * deployed contract, and a regeneration that dropped an inherited error would put the next
 * person straight back on the insurance trail with nothing to stop them.
 */
describe("revert decoding for errors the game does not declare", () => {
  it("decodes ERC721NonexistentToken — an audit against a burned citizen", () => {
    const data = `0x7e273289${(6403).toString(16).padStart(64, "0")}` as `0x${string}`;
    const decoded = decodeErrorResult({ abi: deathAndTaxesAbi, data });
    expect(decoded.errorName).toBe("ERC721NonexistentToken");
    expect(decoded.args?.[0]).toBe(6403n);
  });

  it("still decodes the game's own errors, so the addition did not disturb them", () => {
    // IncorrectPayment is the one the boundary races actually hit — a payment priced for an
    // un-audited citizen that a rival audited earlier in the same block. If inserting an entry
    // ahead of it broke decoding, every post-mortem of a lost boundary would go unreadable.
    const sel = toFunctionSelector("IncorrectPayment()");
    const decoded = decodeErrorResult({ abi: deathAndTaxesAbi, data: sel });
    expect(decoded.errorName).toBe("IncorrectPayment");
  });
});
