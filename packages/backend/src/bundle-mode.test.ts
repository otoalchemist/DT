import { describe, it, expect, vi } from "vitest";
import { boundaryBundleMode, coinbaseBidFundedFor, boundaryDensitiesGwei, applyThorMode, thorModeSettled, thorOverridesFor, hasVault } from "@dat-bot/shared";
import type { StrategyConfig } from "@dat-bot/shared";

// combinedBundleActive is a pure predicate, but importing strategy.ts pulls in config.ts,
// which parses process.env and throws without an RPC key. These two stubs are the minimum
// needed to reach the function under test.
vi.mock("./config.js", () => ({
  appConfig: {
    mode: "mainnet", dataDir: "C:/dat-bot-test-scratch-nonexistent",
    gameAddress: "0x00000000000000000000000000000000000000aa",
    builderUrls: [], flashbotsRelayUrl: "https://relay.flashbots.net",
    maxCandidates: 8000, ownedTokensOverride: [], targetTokensOverride: [],
  },
  loadSettings: vi.fn(() => ({})), saveSettings: vi.fn(), deriveUrlsFromKey: vi.fn(),
}));
vi.mock("./chain.js", () => ({
  publicClient: {}, getLatestBlockCached: vi.fn(), getBalanceCached: vi.fn(),
  invalidateBalanceCache: vi.fn(), primeBlockCache: vi.fn(), wsClient: null,
}));

const { combinedBundleActive } = await import("./strategy.js");

/**
 * The fused/split predicate, and the guarantee that the dashboard badge matches the engine.
 *
 * This exists because the config's real behaviour surprised an operator twice. A "Payment
 * Coinbase Bid" field beside an "Audit Coinbase Bid" field reads as two bundles with two
 * bids — but with `combinedBoundaryBundle` on and a bid funded, the fires FUSE into one
 * bundle on one bid.
 *
 * That last clause used to read "and the audit bid never fires at all", which is wrong and was
 * repeated in the Config panel's own hint. Which bid fires is decided at fire time by what got
 * queued: a payment in the bundle spends the payment bid, an audit-only night spends the AUDIT
 * bid. The mistake mattered — it invited zeroing the audit bid, and a fused audit-only bundle
 * that selects an unfunded bid gets no bid and no mempool copy. See the fused-bid cases in
 * separate-bundles-multi.test.ts, and the fire-time warning in firePreBoundaryBundle.
 *
 * So the badge is only worth rendering if it cannot disagree with the engine, which is why
 * both read the same shared function. The last case here is the one that matters: it asserts
 * `combinedBundleActive` (what the engine acts on) and `boundaryBundleMode` (what the UI
 * shows) agree across every combination, so the two can never drift apart.
 */

// Not `as const`: the overrides below set 0 and "" on these fields, and literal types would
// reject them at compile time even though that is exactly what is being tested.
const base: {
  combinedBoundaryBundle: boolean;
  coinbaseBidEth: number;
  coinbaseBidAuditOnlyEth: number;
  coinbasePayerAddress: string;
  // Empty by default so every pre-existing case keeps its no-vault meaning; the vault block
  // below sets it explicitly.
  vaultAddress: string;
  thorMode: boolean;
  auditBundleAllOrNothing: boolean;
} = {
  combinedBoundaryBundle: true,
  coinbaseBidEth: 0.01,
  coinbaseBidAuditOnlyEth: 0.005,
  coinbasePayerAddress: "0xb69D1Bb4613722bdAb1aA77BA8F4409071f0a815",
  vaultAddress: "",
  thorMode: false,
  auditBundleAllOrNothing: false,
};

const cfg = (o: Partial<typeof base>) => ({ ...base, ...o }) as StrategyConfig;

describe("a bid only counts when it has both an amount and a payer", () => {
  it("needs a non-zero amount", () => {
    expect(coinbaseBidFundedFor(cfg({}), "payment")).toBe(true);
    expect(coinbaseBidFundedFor(cfg({ coinbaseBidEth: 0 }), "payment")).toBe(false);
  });

  it("needs a payer address — an amount with nowhere to send it is not a bid", () => {
    expect(coinbaseBidFundedFor(cfg({ coinbasePayerAddress: "" }), "payment")).toBe(false);
    expect(coinbaseBidFundedFor(cfg({ coinbasePayerAddress: "" }), "audit")).toBe(false);
  });

  it("reads the right amount per kind", () => {
    expect(coinbaseBidFundedFor(cfg({ coinbaseBidEth: 0, coinbaseBidAuditOnlyEth: 0.005 }), "payment")).toBe(false);
    expect(coinbaseBidFundedFor(cfg({ coinbaseBidEth: 0, coinbaseBidAuditOnlyEth: 0.005 }), "audit")).toBe(true);
  });
});

describe("boundaryBundleMode", () => {
  it("fuses when the toggle is on and any bid is funded", () => {
    expect(boundaryBundleMode(cfg({}))).toBe("fused");
    // Either bid is enough — which is the non-obvious part: an AUDIT-only bid still fuses a
    // boundary that carries a payment.
    expect(boundaryBundleMode(cfg({ coinbaseBidEth: 0 }))).toBe("fused");
    expect(boundaryBundleMode(cfg({ coinbaseBidAuditOnlyEth: 0 }))).toBe("fused");
  });

  it("splits when the toggle is off, whatever the bids are", () => {
    expect(boundaryBundleMode(cfg({ combinedBoundaryBundle: false }))).toBe("split");
  });

  it("splits when NO bid is funded, even with the toggle on", () => {
    // The toggle is inert without a bid: there is nothing to share, so fusing buys nothing
    // and the fires split regardless. This is the state most operators are actually in.
    expect(boundaryBundleMode(cfg({ coinbaseBidEth: 0, coinbaseBidAuditOnlyEth: 0 }))).toBe("split");
    expect(boundaryBundleMode(cfg({ coinbasePayerAddress: "" }))).toBe("split");
  });
});

describe("the badge cannot drift from the engine", () => {
  it("agrees with combinedBundleActive across every combination", () => {
    // Exhaustive rather than sampled: the whole point of the shared predicate is that these
    // two can never disagree, and a badge that lies is worse than no badge.
    for (const combined of [true, false]) {
      for (const payBid of [0, 0.01]) {
        for (const auditBid of [0, 0.005]) {
          for (const payer of ["", base.coinbasePayerAddress]) {
            const c = cfg({
              combinedBoundaryBundle: combined,
              coinbaseBidEth: payBid,
              coinbaseBidAuditOnlyEth: auditBid,
              coinbasePayerAddress: payer,
            });
            expect(boundaryBundleMode(c) === "fused").toBe(combinedBundleActive(c));
          }
        }
      }
    }
  });
});

/**
 * Bundle density, and the inversion the dashboard warns about.
 *
 * In split mode the audit bundle sits on nonces above the still-unmined payment, so it is only
 * includable after the payment bundle. Builders try candidates in value order, so the whole
 * arrangement rests on the PAYMENT bundle being the denser one — the builder is then pushed into
 * the only order that works by its own profit motive. Inverted, it reaches for the audit bundle
 * first, finds a nonce two above the account, and drops it.
 *
 * Nothing here can test builder behaviour. What it can test is that the condition is computed
 * correctly, which is what the warning keys off.
 */
const gasCfg = {
  priorityFeeGwei: 151,
  offensePriorityFeeGwei: 101.1,
  separateOffenseGas: true,
  coinbaseBidEth: 0.01,
  coinbaseBidAuditOnlyEth: 0.005,
  coinbasePayerAddress: "0xb69D1Bb4613722bdAb1aA77BA8F4409071f0a815",
};
const g = (o: Partial<typeof gasCfg>) => ({ ...gasCfg, ...o }) as StrategyConfig;

describe("boundaryDensitiesGwei", () => {
  it("puts the payment ahead on a healthy live config", () => {
    const d = boundaryDensitiesGwei(g({}));
    expect(d.paymentDenser).toBe(true);
    expect(d.payment).toBeGreaterThan(d.audit);
  });

  it("flags the inversion when the audit bid is raised far enough", () => {
    // The bid is the sharper lever than the tip: the audit bundle is bigger in gas, so a given
    // bid buys it less density — but enough bid still overtakes.
    expect(boundaryDensitiesGwei(g({ coinbaseBidAuditOnlyEth: 0.05 })).paymentDenser).toBe(false);
  });

  it("flags the inversion when the audit TIP exceeds the payment side", () => {
    expect(boundaryDensitiesGwei(g({ offensePriorityFeeGwei: 400 })).paymentDenser).toBe(false);
  });

  it("counts the shape: extra payments thin the payment bid and can invert it", () => {
    // Each payment adds 82,875 gas to the payment bundle while the audit side is untouched, so a
    // config that is safe for one citizen inverts for three. This is exactly why the warning is
    // sized on the operator's real holdings rather than a 1:1 assumption — a 1:1 check would call
    // this config healthy for a holder it is actively broken for.
    const cfg = g({
      priorityFeeGwei: 40, coinbaseBidEth: 0.005,
      offensePriorityFeeGwei: 60, coinbaseBidAuditOnlyEth: 0,
    });
    expect(boundaryDensitiesGwei(cfg, { payments: 1, audits: 1 }).paymentDenser).toBe(true);  // 84 vs 60
    expect(boundaryDensitiesGwei(cfg, { payments: 2, audits: 1 }).paymentDenser).toBe(true);  // 66 vs 60
    expect(boundaryDensitiesGwei(cfg, { payments: 3, audits: 1 }).paymentDenser).toBe(false); // 58 vs 60
    expect(boundaryDensitiesGwei(cfg, { payments: 8, audits: 1 }).paymentDenser).toBe(false); // 47 vs 60
  });

  it("uses the payment tip for audits when offense is not priced apart", () => {
    // separateOffenseGas off means audits inherit the payment tip, so with no bids the two
    // densities are equal and NOT payment-denser — the warning fires, correctly, because a tie
    // gives the builder no reason to prefer the payment bundle.
    const d = boundaryDensitiesGwei(
      g({ separateOffenseGas: false, coinbaseBidEth: 0, coinbaseBidAuditOnlyEth: 0 }),
    );
    expect(d.payment).toBeCloseTo(d.audit, 6);
    expect(d.paymentDenser).toBe(false);
  });

  it("ignores bid amounts with no payer configured", () => {
    // An amount with nowhere to send it is not a bid, so density is tips alone.
    const d = boundaryDensitiesGwei(g({ coinbasePayerAddress: "" }));
    expect(d.payment).toBeCloseTo(151, 6);
    expect(d.audit).toBeCloseTo(101.1, 6);
  });
});

/**
 * A vault changes what "fused" means, so it gets its own block.
 *
 * The split/fused toggle exists to stop a cheap audit tip diluting an expensive payment tip, by
 * giving each half its own bundle and its own bid. A vault removes that premise entirely: the
 * boundary becomes ONE run() call with one tip, one bid, and ordering guaranteed by the contract
 * rather than by nonce sequencing. Split, the same boundary costs two transactions, two bids,
 * and puts the audit call on a nonce above an unmined payment.
 *
 * So with a vault, fused is a derivation rather than a preference — and Thor Mode must stop
 * forcing the toggle off, or it silently degrades the vault it is running alongside.
 */
const VAULT = "0xD00B158B8644B1FE387508Ceb2De021E87926D6E";

describe("a vault is always fused", () => {
  it("fuses even with the toggle explicitly OFF", () => {
    // The exact configuration this fix is for: Thor Mode had written combinedBoundaryBundle
    // false, which would have sent two transactions and paid two bids.
    expect(boundaryBundleMode(cfg({ combinedBoundaryBundle: false, vaultAddress: VAULT }))).toBe("fused");
  });

  it("fuses with NO bid funded, unlike the no-vault case", () => {
    /**
     * Without a vault, fusing only buys something when there is a bid to share, so no bid means
     * split however the toggle is set. With one, fusing buys a single transaction regardless —
     * hence the bid requirement is dropped rather than merely satisfied.
     */
    const noBid = { coinbaseBidEth: 0, coinbaseBidAuditOnlyEth: 0 };
    expect(boundaryBundleMode(cfg({ ...noBid }))).toBe("split");
    expect(boundaryBundleMode(cfg({ ...noBid, vaultAddress: VAULT }))).toBe("fused");
  });

  it("fuses with no coinbase payer, because the bid rides inside the call", () => {
    expect(boundaryBundleMode(cfg({ coinbasePayerAddress: "", vaultAddress: VAULT }))).toBe("fused");
  });

  it("ignores a malformed vault address rather than fusing on it", () => {
    // Non-vacuity for every case above: it is the ADDRESS being usable that fuses, not merely
    // the field being non-empty.
    expect(boundaryBundleMode(cfg({ combinedBoundaryBundle: false, vaultAddress: "0xnope" }))).toBe("split");
    expect(boundaryBundleMode(cfg({ combinedBoundaryBundle: false, vaultAddress: "" }))).toBe("split");
  });

  it("agrees with the engine predicate, vault or not", () => {
    // Same guarantee as the exhaustive case above: a badge that disagrees with the engine is
    // worse than no badge, and this fix added a whole new reason for them to diverge.
    for (const vaultAddress of ["", VAULT]) {
      for (const combined of [true, false]) {
        for (const payBid of [0, 0.01]) {
          const c = cfg({ vaultAddress, combinedBoundaryBundle: combined, coinbaseBidEth: payBid });
          expect(boundaryBundleMode(c) === "fused").toBe(combinedBundleActive(c));
        }
      }
    }
  });
});

describe("Thor Mode does not degrade a vault", () => {
  const thor = (vaultAddress: string) =>
    applyThorMode(cfg({
      thorMode: true, vaultAddress,
      combinedBoundaryBundle: true, auditBundleAllOrNothing: false,
    }) as never) as unknown as Record<string, unknown>;

  it("withholds combinedBoundaryBundle when a vault is configured", () => {
    // The whole point: Thor Mode may not split a vault boundary in two.
    expect(thor(VAULT).combinedBoundaryBundle).toBe(true);
    // Without a vault it still forces it off, which is correct there.
    expect(thor("").combinedBoundaryBundle).toBe(false);
  });

  it("withholds auditBundleAllOrNothing when a vault is configured", () => {
    /**
     * Inert once fused — the combined path deliberately ignores it, so a cured target can never
     * drop a payment sharing the batch — but still withheld. A flag left set that has no effect
     * is how an operator ends up reasoning about behaviour they do not have.
     */
    expect(thor(VAULT).auditBundleAllOrNothing).toBe(false);
    expect(thor("").auditBundleAllOrNothing).toBe(true);
  });

  it("still applies the four that DO reach the vault path", () => {
    // mirrorAudits and racePublicMempool never reach it (flushVaultBatch calls submitTx
    // directly with race: hasPayment), but the two payment flags decide per-call tolerance
    // inside the batch, so none of the four is dropped.
    const t = thor(VAULT);
    expect(t.mirrorAudits).toBe(false);
    expect(t.racePublicMempool).toBe(false);
    expect(t.mirrorPayments).toBe(false);
    expect(t.paymentBundleAllOrNothing).toBe(true);
  });

  it("reports a vault operator as settled without the withheld flags", () => {
    /**
     * thorModeSettled judged against the FULL table would report a vault operator as never
     * settled, because the two withheld flags are exactly the ones left at their own values —
     * and the dashboard uses that to decide whether the switch took effect.
     */
    const settled = applyThorMode(cfg({
      thorMode: true, vaultAddress: VAULT,
      combinedBoundaryBundle: true, auditBundleAllOrNothing: false,
    }) as never);
    expect(thorModeSettled(settled as never)).toBe(true);
  });

  it("is idempotent with a vault, so repeated saves cannot drift", () => {
    // applyThorMode runs on EVERY saveStrategy, so a non-idempotent version would walk the
    // config somewhere else one save at a time.
    const once = applyThorMode(cfg({ thorMode: true, vaultAddress: VAULT, combinedBoundaryBundle: true }) as never);
    const twice = applyThorMode(once);
    expect(twice).toEqual(once);
  });
});
