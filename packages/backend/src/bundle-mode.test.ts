import { describe, it, expect, vi } from "vitest";
import { boundaryBundleMode, coinbaseBidFundedFor, boundaryDensitiesGwei } from "@dat-bot/shared";
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
} = {
  combinedBoundaryBundle: true,
  coinbaseBidEth: 0.01,
  coinbaseBidAuditOnlyEth: 0.005,
  coinbasePayerAddress: "0xb69D1Bb4613722bdAb1aA77BA8F4409071f0a815",
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
