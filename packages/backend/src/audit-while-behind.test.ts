import { describe, it, expect } from "vitest";
import { isEligibleAuditor, isAuditable } from "./logic.js";

/**
 * `auditWhileBehind`: letting a citizen that is itself behind be used as an audit "from".
 *
 * The contract places NO delinquency condition on the from-token. Verified twice over:
 * by simulation against mainnet state (see the note on isEligibleAuditor), and in production
 * at the epoch-176 boundary, where #2036 audited #1612 successfully at block 25828481 index
 * 66 while sitting at lastEpochPaid 174 against currentEpoch 176 — two behind, itself
 * auditable, and with its own payment killed by a nonce collision so it never landed.
 *
 * So refusing a behind auditor is a STRATEGY choice, and this file pins both sides of it.
 *
 * The one thing that must hold under BOTH settings is the under-audit exclusion. That is the
 * genuinely dying asset — roughly a day from killable — and before this setting existed it
 * was kept out of the pool only by accident, because being under audit almost always means
 * 2+ behind, which the delinquency clause caught. Relaxing that clause without an explicit
 * under-audit check would have started spending exactly the wrong slots.
 */

const EPOCH = 200n;
/** 1 behind: the ordinary boundary case, eligible under either setting. */
const ONE_BEHIND = EPOCH - 1n;
/** 2 behind: itself auditable. The case the setting is about. */
const TWO_BEHIND = EPOCH - 2n;
const CURRENT = EPOCH;

describe("auditWhileBehind off — the historical policy", () => {
  const off = { auditWhileBehind: false };

  it("allows a current or 1-behind citizen to audit", () => {
    expect(isEligibleAuditor(CURRENT, EPOCH, 0n, 1n, off)).toBe(true);
    expect(isEligibleAuditor(ONE_BEHIND, EPOCH, 0n, 1n, off)).toBe(true);
  });

  it("refuses a citizen that is 2+ behind", () => {
    expect(isAuditable(TWO_BEHIND, EPOCH)).toBe(true); // precondition of the case
    expect(isEligibleAuditor(TWO_BEHIND, EPOCH, 0n, 1n, off)).toBe(false);
    expect(isEligibleAuditor(EPOCH - 5n, EPOCH, 0n, 1n, off)).toBe(false);
  });
});

describe("auditWhileBehind on — the contract's actual rule", () => {
  const on = { auditWhileBehind: true };

  it("allows a 2-behind citizen to audit, which the contract permits", () => {
    expect(isEligibleAuditor(TWO_BEHIND, EPOCH, 0n, 1n, on)).toBe(true);
  });

  it("allows the epoch-176 case exactly: lastEpochPaid 174 at epoch 176", () => {
    // Not a hypothetical — this audit landed on mainnet.
    expect(isEligibleAuditor(174n, 176n, 0n, 1n, on)).toBe(true);
  });

  it("still refuses a citizen with no capacity left — that IS a contract rule", () => {
    expect(isEligibleAuditor(CURRENT, EPOCH, 1n, 1n, on)).toBe(false);
    expect(isEligibleAuditor(TWO_BEHIND, EPOCH, 3n, 3n, on)).toBe(false);
    // And still counts remaining capacity correctly for auditor-role tokens.
    expect(isEligibleAuditor(TWO_BEHIND, EPOCH, 2n, 3n, on)).toBe(true);
  });
});

describe("under audit is excluded under BOTH settings", () => {
  it("refuses an under-audit citizen even with auditWhileBehind on", () => {
    // The load-bearing case: with the delinquency clause relaxed, this check is the ONLY
    // thing keeping a citizen that is ~a day from killable out of the auditor pool.
    expect(isEligibleAuditor(TWO_BEHIND, EPOCH, 0n, 1n, { auditWhileBehind: true, underAudit: true }))
      .toBe(false);
  });

  it("refuses an under-audit citizen that is otherwise perfectly current", () => {
    // Being current does not make it safe to commit: the audit clock, not the tax clock,
    // is what is about to kill it.
    expect(isEligibleAuditor(CURRENT, EPOCH, 0n, 1n, { auditWhileBehind: true, underAudit: true }))
      .toBe(false);
    expect(isEligibleAuditor(CURRENT, EPOCH, 0n, 1n, { auditWhileBehind: false, underAudit: true }))
      .toBe(false);
  });

  it("capacity is checked before anything else, so a spent under-audit token is still refused", () => {
    expect(isEligibleAuditor(CURRENT, EPOCH, 1n, 1n, { auditWhileBehind: true, underAudit: true }))
      .toBe(false);
  });
});

describe("defaults and back-compat", () => {
  it("defaults to the historical policy when no options are passed", () => {
    // Callers that predate the options bag must keep the old meaning, so an accidental
    // omission cannot silently widen who audits.
    expect(isEligibleAuditor(TWO_BEHIND, EPOCH, 0n, 1n)).toBe(false);
    expect(isEligibleAuditor(ONE_BEHIND, EPOCH, 0n, 1n)).toBe(true);
  });

  it("never depends on lastEpochPaid at all once auditWhileBehind is on", () => {
    // Sweeps a wide range so the relaxation cannot be accidentally re-narrowed to
    // "exactly 2 behind" — the failure mode the isAuditable comment warns about.
    for (let behind = 0n; behind <= 10n; behind++) {
      expect(isEligibleAuditor(EPOCH - behind, EPOCH, 0n, 1n, { auditWhileBehind: true })).toBe(true);
    }
  });
});
