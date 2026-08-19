import { useEffect, useRef, useState } from "react";
import { bidToBeat, bundleGas, densityTrend, tipCostEth, tipOnlyBundleGas, type TargetScoreRow, type TargetScoresState } from "@dat-bot/shared";
import { api } from "./api.js";

/**
 * On-demand rival scoring. The scan is slow (~1-3 min of on-chain reads), so the button
 * kicks off a background run on the backend and this polls until it lands. Results are
 * cached backend-side, so the table survives a page reload without re-scanning.
 */
/**
 * Rows to dim. Big boys are NOT dimmed — they used to be, when the roster meant "do not
 * target", and dimming them now would misreport a strategy that attacks them. Only
 * `uncatchable` survives, the legacy flag from a scan cached by an older backend.
 */
const dimmed = (r: TargetScoreRow): boolean => r.uncatchable ?? false;

/** The bundle the user plans to send, and the tip they'll send it with. */
interface Plan { payments: number; audits: number; tipGwei: number }

/**
 * Price a beat-bid for THIS plan from the rival's raw defense density.
 *
 * A bid buys position for the whole bundle, so the cost scales with the gas you carry —
 * out-ranking a rival at 128 gwei/gas costs ~0.03 ETH on a 1-pay/1-audit bundle and
 * ~0.24 on a 9-pay/11-audit one. The stored beatBid* fields are the server's answer for
 * a fixed 1+1 bundle, so they can't be reused once the plan changes: recompute from
 * density, and show "·" when a cached row predates density being exposed.
 */
function beatFor(densityGwei: number | null | undefined, plan: Plan): number | null {
  if (densityGwei === null || densityGwei === undefined) return null;
  return bidToBeat(densityGwei, plan.tipGwei, plan.payments, plan.audits);
}

/**
 * The same bar as a PRIORITY FEE instead of a bid — the other lever, and the only one that
 * works everywhere.
 *
 * Density is tip + bid/gas, so a bundle with no bid has density equal to its tip: the bar in
 * gwei/gas IS the tip that clears it, and unlike a bid it does not scale with bundle size.
 * It also survives the ~1 boundary in 10 built by a solo validator on vanilla geth/reth,
 * which sort by priority fee and ignore coinbase transfers outright — a bid buys nothing
 * there. +1 because clearing a bar means passing it, not matching it.
 */
function tipFor(densityGwei: number | null | undefined): number | null {
  if (densityGwei === null || densityGwei === undefined) return null;
  return Math.ceil(densityGwei) + 1;
}

/** The tip lever, rendered under a bid cell so both ways past a rival sit together. */
function TipLine({ density, plan }: { density: number | null | undefined; plan: Plan }) {
  const tip = tipFor(density);
  if (tip === null) return null;
  const enough = plan.tipGwei >= tip;
  // The bid above is in ETH and the tip is in gwei/gas, so they cannot be compared as
  // printed. Quote the tip in ETH too. Converting shows the tip is the CHEAPER lever at
  // equal density — the bid route also sends and tips the CoinbasePayer tx.
  const costEth = tipCostEth(tip, plan.payments, plan.audits);
  return (
    <>
      <br />
      <span
        style={{ fontSize: 10, color: enough ? "var(--green)" : "var(--muted, #888)" }}
        title={
          enough
            ? `Your ${plan.tipGwei} gwei tip already exceeds the ${tip} gwei this bar needs, so no bid is required on any builder — including the ~1 boundary in 10 built by a solo validator that ignores coinbase bids entirely. At ${tip} gwei over ${tipOnlyBundleGas(plan.payments, plan.audits).toLocaleString()} gas that is ~${costEth.toFixed(4)} ETH of priority fee (the bid tx is not sent on this route, so its gas is excluded).`
            : `Or skip the bid: a ${tip} gwei priority fee clears this bar on its own, costing ~${costEth.toFixed(4)} ETH over ${tipOnlyBundleGas(plan.payments, plan.audits).toLocaleString()} gas. Compare that against the bid above PLUS the tip you would still be paying on the bid route — including its CoinbasePayer transaction — which makes the tip the cheaper lever at equal density, not the dearer one. It is also the ONLY lever on the ~1 boundary in 10 built by a solo validator on vanilla geth/reth, which ignores coinbase transfers.`
        }
      >
        {tip}gw ≈ {costEth.toFixed(4)}Ξ
      </span>
    </>
  );
}

/**
 * Defense density per epoch, as a sparkline plus a direction.
 *
 * A sparkline and not a full chart because the job is "which way is this moving", per row, for
 * forty rows — axes would cost more space than they buy, and the def/beat columns beside it
 * already carry the absolute numbers. Scaled to this rival's own min..max, so shape is the
 * encoding and magnitude deliberately is not: a flat 2 gwei defender and a flat 450 gwei one
 * look the same here, which is the point. The tooltip carries every value so the shape can
 * never be mistaken for a height.
 *
 * One series, so no legend. The line is de-emphasis ink with the latest point in the direction
 * colour, and the direction is carried by an ARROW GLYPH — never by colour alone. Rising is
 * amber rather than green because a rival's defense climbing is bad news for the reader.
 */
function DensitySpark({ series }: { series?: { epoch: number; density: number }[] }) {
  if (!series || series.length === 0) {
    return <span className="muted" title="No payment observed in the window — nothing to trend.">·</span>;
  }
  const t = densityTrend(series);
  const vals = series.map((p) => p.density);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const W = 54, H = 14, PAD = 2;
  const x = (i: number) => (series.length === 1 ? W / 2 : PAD + (i * (W - PAD * 2)) / (series.length - 1));
  const y = (v: number) => (hi === lo ? H / 2 : H - PAD - ((v - lo) / (hi - lo)) * (H - PAD * 2));
  const colour =
    t === null || t.direction === "flat"
      ? "var(--muted)"
      : t.direction === "rising" ? "var(--amber)" : "var(--green)";
  const arrow = t === null ? "" : t.direction === "rising" ? "↑" : t.direction === "falling" ? "↓" : "→";
  const title =
    "Defense density by epoch (gwei/gas), oldest first:\n" +
    series.map((p) => `  epoch ${p.epoch}: ${p.density}`).join("\n") +
    (t === null
      ? "\nOnly one epoch observed — not enough for a trend."
      : `\n\n${t.direction.toUpperCase()} — ${t.slopePerEpoch >= 0 ? "+" : ""}${t.slopePerEpoch.toFixed(1)} gwei/gas per epoch` +
        " (median of pairwise slopes, so one cheap mid-epoch payment cannot swing it)." +
        ` First to last: ${t.first} → ${t.last} (${t.changePct >= 0 ? "+" : ""}${t.changePct.toFixed(0)}%), ${t.points} epoch(s) observed.` +
        (t.direction === "rising"
          ? " Escalating, so price the next boundary off Beat max rather than off what they did last."
          : t.direction === "falling"
            ? " Retreating, so Beat max is likely dearer than you need — check Beat -1."
            : " Steady, so the Beat figures are reliable.")) +
    "\nScaled to this rival's own range: the shape is the signal, not the height.";
  return (
    <span title={title} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`density trend ${t?.direction ?? "single observation"}`}>
        <polyline
          points={series.map((p, i) => `${x(i)},${y(p.density)}`).join(" ")}
          fill="none"
          stroke="var(--muted)"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx={x(series.length - 1)} cy={y(vals[vals.length - 1]!)} r={2} fill={colour} />
      </svg>
      <span style={{ color: colour, fontSize: 11 }}>{arrow}</span>
    </span>
  );
}

/**
 * Make a small numeric field behave like one you can just retype: focus or click it and
 * the value is selected, so the next keystroke replaces it instead of appending.
 *
 * onFocus alone only covers tab-focus — clicking places a caret on mouseup, which
 * collapses that selection — so mouseup re-asserts it. Unconditionally, deliberately: a
 * number input reports selectionStart/selectionEnd as null and throws on
 * setSelectionRange, so a partial drag-selection cannot be detected and preserved. On a
 * two-digit count that trade is free; on a longer field it would not be.
 *
 * onWheel blurs because a focused number input consumes wheel events and silently
 * increments — on a scrollable dashboard that would re-price every row mid-scroll.
 */
const selectOnFocus = {
  onFocus: (e: React.FocusEvent<HTMLInputElement>) => e.currentTarget.select(),
  onMouseUp: (e: React.MouseEvent<HTMLInputElement>) => {
    e.preventDefault();
    e.currentTarget.select();
  },
  onWheel: (e: React.WheelEvent<HTMLInputElement>) => e.currentTarget.blur(),
};

function ScoreTable({ rows, empty, plan }: { rows: TargetScoreRow[]; empty: string; plan: Plan }) {
  if (rows.length === 0) return <p className="muted" style={{ fontSize: 12 }}>{empty}</p>;
  const cell: React.CSSProperties = { padding: "5px 10px", fontSize: 12, whiteSpace: "nowrap" };
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ fontSize: 12 }}>
        <thead>
          <tr>
            <th style={cell} title="Token ID">Token</th>
            <th style={cell} title="Epochs behind: 1 = auditable next boundary, 2+ = auditable now">Beh</th>
            <th style={cell} title="Outcome of its skips. A skip is a boundary entered 2+ behind, which leaves the token auditable until it cures — so it either slips through (clean, green) or draws an audit that epoch (caught, amber), out of skips attempted. All-clean = a proven-safe cadence and a hard target; often caught = a soft one, cheap to punish again. — = never crossed delinquent in the window.">Skip clean/caught</th>
            <th style={cell} title="Owner ETH balance">Owner</th>
            <th style={cell} title="Epochs the owner's balance covers across all their citizens">Runway</th>
            <th style={cell} title="Can the owner afford the next-boundary catch-up?">Afford</th>
            <th style={cell} title="THEIR priority tip in gwei as -2/-1/max, where -1 is the LATEST boundary (the current epoch, since epoch N's boundary is when N begins) and -2 the one before it, then their peak. Three fields because a lone peak cannot tell a rival still defending at that level from one that defended once and has coasted since. · = no payment observed in that epoch, which is missing data rather than a cheap defense.">Def<br/><span style={{fontWeight:400,fontSize:9,opacity:0.7}}>-2/-1/max</span></th>
            <th style={cell} title="Lowest tx index this rival ever reached. Its own column because position is a different axis from price: index 0 on tip alone is expensive but beatable, whereas a bid-backed index 0 is genuinely out of reach.">Idx</th>
            <th style={cell} title="Defense density per epoch, oldest to newest, scaled to this rival's own range — the shape is the signal, not the height (hover for every value). The arrow is the direction over the whole window, from a median-of-pairwise-slopes fit so one cheap mid-epoch payment cannot swing it: up = escalating, so price off Beat max; down = retreating, so Beat max is dearer than you need; right = steady. Costs no extra provider calls — the scan already reads these blocks.">Trend</th>
            <th style={cell} title="Blocks after the boundary they paid: fastest / median. 0 = pays in the boundary block">PayBlk</th>
            <th style={cell} title="THEIR own coinbase bid, in ETH — not what you would pay, which is the Beat columns. Counted whether it backed a PAYMENT or an AUDIT, since a bid buys position either way: Hedo bid 0.03 behind ten audits at epoch 170 while paying no tax, and a payment-only column called that no bid. Shown as -2/-1/max, where -1 is the LATEST boundary (the current epoch) and -2 the one before it, then the biggest seen over the whole window — so you can tell a steady bidder from one that has stopped. A rival that pays every OTHER epoch always leaves one slot empty; that is its cadence, not a missing measurement. Read it next to Beat max, because it is usually the explanation: a bid over a small bundle dominates density, so a rival can tip only 90 gwei and still cost 448 gwei/gas to out-rank. Shared when one operator co-pays several citizens in a block. ? = RPC has no tracing">ATK/DEF bid<br/><span style={{fontWeight:400,fontSize:9,opacity:0.7}}>-2/-1/max</span></th>
            <th style={cell} title="What it takes to out-rank this rival's defense over the LAST 2 EPOCHS — the likely cost at the next boundary. Read it next to Beat/max: equal means a steady defender and the figure is reliable; a gap means it escalates. — = nothing needed. · = no payment in the last 2 epochs. Each cell shows BOTH ways past this rival: the top figure is the flat coinbase bid at your configured tip; the small figure under it is the priority fee that clears the same bar with no bid at all. Green means your current tip already clears it. The tip route works on every builder — including the ~1 boundary in 10 built by a solo validator on vanilla geth/reth, which sorts by priority fee and ignores coinbase transfers outright, where a bid buys nothing. And at equal density the tip is the CHEAPER lever, not the dearer one: the bid route must also send and tip the CoinbasePayer transaction (~30,550 gas), which costs it ~0.011-0.014 ETH more at any bundle size. The bid figure looks smaller only because it is quoted on top of a tip you are still paying. What the bid actually buys is scope: it is a per-boundary lever, while the configured tip re-prices every transaction the bot sends.">Beat -2<br/><span style={{fontWeight:400,fontSize:9,opacity:0.7}}>bid / tip</span></th>
            <th style={cell} title="What it takes to out-rank this rival's PEAK defense density over the whole window — (coinbase bid + priority tips) / gas, the value-per-gas a builder sorts on. Peak, not recent: what you must clear is the strongest defense it has actually mounted. A ceiling, not a forecast — off-chain builder deals stay invisible. Each cell shows BOTH levers: the top figure is the flat coinbase bid at your configured tip; the small figure under it is the priority fee that clears the same bar with no bid. Green = your current tip already clears it. Tip works on every builder including solo-built blocks that ignore coinbase bids, and at equal density it is the cheaper lever — the bid route also sends and tips the CoinbasePayer tx (~30,550 gas), so it costs ~0.011-0.014 ETH more. The bid figure only looks smaller because it sits on top of a tip you already pay; what it really buys is scope, being per-boundary rather than a global tip change.">Beat -1<br/><span style={{fontWeight:400,fontSize:9,opacity:0.7}}>bid / tip</span></th>
            <th style={cell} title="THE COLUMN FOR A BOUNDARY RACE: what it takes to out-rank this rival in a boundary block specifically — its defense measured only on payments that landed at offset 0, rather than peaking across quiet mid-epoch payments where nobody is contesting position. 'free' means it was never seen paying in a boundary block at all: it stays auditable until it notices, so you can take it without winning any race and without spending anything. · = re-run the scan to populate this. Each cell shows BOTH levers: the top figure is the flat coinbase bid at your configured tip; the small figure under it is the priority fee that clears the same bar with no bid. Green = your current tip already clears it. Tip works on every builder including solo-built blocks that ignore coinbase bids, and at equal density it is the cheaper lever — the bid route also sends and tips the CoinbasePayer tx (~30,550 gas), so it costs ~0.011-0.014 ETH more. The bid figure only looks smaller because it sits on top of a tip you already pay; what it really buys is scope, being per-boundary rather than a global tip change.">Beat max<br/><span style={{fontWeight:400,fontSize:9,opacity:0.7}}>bid / tip</span></th>
            <th style={cell} title="Bribes held — each is one free audit escape">Br</th>
            <th style={cell} title="Times anyone successfully audited it in the window">Aud</th>
            <th style={cell} title="Weak-link score, higher is a better target. 0 = under audit, or not a weak link">Score</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.token} style={dimmed(r) || r.under ? { opacity: 0.45 } : undefined}>
              <td style={{ ...cell, fontFamily: "monospace" }}>
                #{r.token}
                {r.bigBoyOwner ? (
                  <span
                    className="badge"
                    style={{ fontSize: 9, marginLeft: 6, fontFamily: "inherit" }}
                    title={`Big boy — run by ${r.bigBoyOwner}. A full target like any other rival; the tag is attribution.`}
                  >
                    {r.bigBoyOwner}
                  </span>
                ) : null}
              </td>
              <td style={cell}>
                {r.under
                  ? <span className="badge warn" style={{ fontSize: 10 }}>audit</span>
                  : <span style={{ color: r.behind >= 2 ? "var(--amber)" : undefined }}>{r.behind}</span>}
              </td>
              <td style={cell}>
                {r.crossings === 0 ? (
                  <span className="muted">—</span>
                ) : r.skipClean === undefined || r.skipCaught === undefined ? (
                  // Rows cached from a scan that predates this column — show the plain
                  // cadence rather than a half-empty outcome. Re-run to populate it.
                  <span className="muted" title="Re-run Analyze targets to see skip outcomes">
                    {r.crossings}/{r.sampled}
                  </span>
                ) : (
                  <>
                    <span style={{ color: "var(--green)" }}>{r.skipClean}</span>
                    <span className="muted">/</span>
                    <span style={{ color: r.skipCaught > 0 ? "var(--amber)" : undefined }}>{r.skipCaught}</span>
                    <span className="muted"> of {r.crossings}</span>
                  </>
                )}
              </td>
              <td style={cell}>{r.ownerBalEth.toFixed(3)}{r.cits > 1 ? <span className="muted"> ×{r.cits}</span> : null}</td>
              <td style={cell}>{r.runwayEpochs === null ? "∞" : r.runwayEpochs.toFixed(1)}</td>
              <td style={{ ...cell, color: r.affordNext ? undefined : "var(--red)", fontWeight: r.affordNext ? 400 : 600 }}>
                {r.affordNext ? "yes" : "NO"}
              </td>
              <td style={cell} title={`Their tip: ${r.tipE2 ?? "none observed"} gwei at the -2 boundary${r.epochE2 ? ` (epoch ${r.epochE2})` : ""}, ${r.tipE1 ?? "none observed"} at the -1 boundary${r.epochE1 ? ` (epoch ${r.epochE1})` : ""}, ${r.maxTip} at peak. -1 is the latest boundary, which is the current epoch.`}>
                {/* Sub-gwei tips keep a decimal, so 0.3 gwei does not print as "0" beside a
                    "·" that means no payment at all. */}
                {(r.tipE2 ?? null) === null ? "·" : r.tipE2! >= 10 ? r.tipE2!.toFixed(0) : r.tipE2!.toFixed(1)}/
                {(r.tipE1 ?? null) === null ? "·" : r.tipE1! >= 10 ? r.tipE1!.toFixed(0) : r.tipE1!.toFixed(1)}/
                {r.maxTip >= 10 ? r.maxTip.toFixed(0) : r.maxTip.toFixed(1)}
              </td>
              <td style={cell}>{r.bestIdx ?? "—"}</td>
              <td style={cell}><DensitySpark series={r.densitySeries} /></td>
              <td style={cell} title={r.payBlkMin === null ? "no payment seen in window" : undefined}>
                {r.payBlkMin === null ? "—" : `${r.payBlkMin}/${r.payBlkMed}`}
              </td>
              {/* THEIR bid as now/-1/max. Three fields because one number could not tell a
                  steady bidder from one that has stopped, and the peak must always be visible:
                  a recent-only figure read "—" on #2711 while Beat max quoted 448 gwei that its
                  0.042 ETH bid is 85% of. "now" is the current epoch, since the boundary for
                  epoch N happens when N begins. */}
              {(() => {
                const peak = r.bidPeakEth ?? r.bidEth;
                const e2 = r.bidE2Eth ?? 0;
                const e1 = r.bidE1Eth ?? 0;
                const stale = (peak ?? 0) > 0 && e2 === 0 && e1 === 0;
                const f = (x: number) => (x > 0 ? x.toFixed(3).replace(/^0/, "") : "—");
                const title =
                  peak == null
                    ? "RPC has no tracing — unknown"
                    : peak > 0
                      ? `Their own coinbase bid: ${f(e2)} at the -2 boundary${r.epochE2 ? ` (epoch ${r.epochE2})` : ""}${r.bidKindE2 ? ` (backing a ${r.bidKindE2})` : ""}, ${f(e1)} at the -1 boundary${r.epochE1 ? ` (epoch ${r.epochE1})` : ""}${r.bidKindE1 ? ` (backing a ${r.bidKindE1})` : ""}, peak over the window ${peak} ETH.` +
                        " Counted whether the bid backed a PAYMENT or an AUDIT, because it buys position either way — a payment-only column reported Hedo's 0.03 ETH behind ten audits as no bid at all." +
                        (r.atkMaxGwei != null
                          ? ` This operator DOES run offense: audit bundles measured ${r.atkE1Gwei != null ? `${r.atkE1Gwei.toFixed(1)} gwei/gas at the -1 boundary` : "nothing at the -1 boundary"}, peak ${r.atkMaxGwei.toFixed(1)}, across ${r.atkAudits ?? 0} boundary block(s).` +
                            (r.beatTipAtkE1Gwei ? ` To out-rank that latest audit bundle: ${r.beatTipAtkE1Gwei} gwei tip, or ${r.beatBidAtkE1Eth?.toFixed(4)} ETH of bid at your ${plan.tipGwei} gwei tip — the bar on a boundary where they owe nothing and audit instead.` : "")
                          : "") +
                        (stale
                          ? " Nothing in either recent epoch — they have defended this hard before and can again, but are not doing it now."
                          : " Still bidding, so price for it every boundary.") +
                        " A bid over a small bundle dominates density, which is how a rival can tip only 90 gwei and still cost 448 gwei/gas to out-rank."
                      : "no coinbase bid seen in this window — its defense is priority fee only";
                return (
                  <td
                    style={{ ...cell, color: peak ? (stale ? "var(--amber)" : "var(--red)") : undefined, fontWeight: peak ? 600 : 400 }}
                    title={title}
                  >
                    {peak == null ? "?" : peak > 0 ? `${f(e2)}/${f(e1)}/${f(peak)}` : "—"}
                  </td>
                );
              })()}
              {/* Beat -2 / Beat -1 / Beat max. The first two are priced against what the rival
                  actually mounted in that specific epoch, so reading across shows whether they
                  are escalating (only Max is safe to trust) or have gone quiet (a big Max beside
                  two dashes). This replaced a recent-2-epoch / peak / boundary-only trio, where
                  the first column blurred two epochs together and could not show a trend.
                  `defenseBoundaryGwei` is still measured and still in the payload — it just has
                  no column of its own now. */}
              {([
                { d: r.defenseE2Gwei, when: r.epochE2 ? `at the -2 boundary (epoch ${r.epochE2})` : "at the -2 boundary" },
                { d: r.defenseE1Gwei, when: r.epochE1 ? `at the -1 boundary (epoch ${r.epochE1})` : "at the -1 boundary" },
              ] as const).map(({ d, when }) => (
                <td style={cell} key={when}>
                  {(() => {
                    if (d === null || d === undefined) {
                      return <span className="muted" title={`No payment observed ${when}, so there is nothing to price against. Missing data, not a cheap defense — check Beat max for what it can mount.`}>·</span>;
                    }
                    const bid = beatFor(d, plan);
                    if (bid !== null && bid > 0) {
                      return (
                        <span title={`Defended at ~${d} gwei/gas ${when}. Priced for ${plan.payments} payment(s) + ${plan.audits} audit(s) at a ${plan.tipGwei} gwei tip.`}>
                          {bid.toFixed(4)}
                        </span>
                      );
                    }
                    return <span className="muted" title={`Defended at ~${d} gwei/gas ${when} — your ${plan.tipGwei} gwei tip already out-ranks that.`}>—</span>;
                  })()}
                  <TipLine density={d} plan={plan} />
                </td>
              ))}
              <td style={cell}>
                {(() => {
                  const bid = beatFor(r.defenseGwei, plan);
                  if (bid === null) {
                    // Cached from a scan before density was exposed. The stored figure is
                    // for a 1+1 bundle, so reusing it under a different plan would lie.
                    return <span className="muted" title="Re-run Analyze targets to price this for your bundle">·</span>;
                  }
                  if (bid > 0) {
                    return (
                      <span title={`Defends at ~${r.defenseGwei} gwei/gas at its peak. Set coinbaseBidEth to at least this to out-rank it with ${plan.payments} payment(s) + ${plan.audits} audit(s) at a ${plan.tipGwei} gwei tip.`}>
                        {bid.toFixed(4)}
                      </span>
                    );
                  }
                  return r.defenseUnexplained ? (
                    // Two causes, opposite responses — so two glyphs, not one shared "?".
                    // "outranked-denser" means the density ordering itself failed here and
                    // no bid can be quoted honestly; "reached-top" only means nothing
                    // denser happened to be in the block, which is far weaker evidence.
                    r.unexplainedReason === "outranked-denser" ? (
                      <span
                        style={{ color: "var(--amber)" }}
                        title={`Density model falsified here. It measures only ~${r.defenseGwei} gwei/gas — below your ${plan.tipGwei} gwei tip — yet a block was seen placing its bundle AHEAD of a materially denser one. Out-bidding may not be the lever against this rival at all, so treat any bid figure as unproven. A bundle router reads weak here for exactly this reason: batching many actions into one large tx divides its bid across far more gas while still taking the slot. Note density predicts ordering ~99% of the time on BuilderNet but only ~80% on Titan/Builder+, so where this rival races matters.`}
                      >!</span>
                    ) : (
                      <span
                        title={`Price unknown, model intact. It measures only ~${r.defenseGwei} gwei/gas — below your ${plan.tipGwei} gwei tip — but still reached tx index ${r.bestIdx}. Nothing denser was present to out-rank, so this is consistent with it simply being the only bidder that block rather than with it out-ranking you. Weaker signal than "!": no bid is quoted because none was tested, not because bidding fails.`}
                      >?</span>
                    )
                  ) : (
                    <span className="muted" title={`Defends at ~${r.defenseGwei} gwei/gas — your ${plan.tipGwei} gwei tip already out-ranks that, so no bid is needed.`}>—</span>
                  );
                })()}
                <TipLine density={r.defenseGwei} plan={plan} />
              </td>
              <td style={cell}>{r.bribes || ""}</td>
              <td style={cell}>{r.audited || ""}</td>
              <td style={{ ...cell, fontWeight: 600, color: r.score >= 5 ? "var(--green)" : r.score > 0 ? undefined : "var(--muted)" }}>
                {r.score.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TargetScores({
  currentEpoch,
  tipGwei,
  ownedCitizens,
  auditCapacity,
}: {
  currentEpoch: string | null;
  tipGwei: number;
  /** Citizens this wallet set holds — the natural payment count for a boundary. */
  ownedCitizens: number;
  /** Sum of auditLimit across them — how many audits a boundary can actually carry. */
  auditCapacity: number;
}) {
  const [state, setState] = useState<TargetScoresState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [onlyAuditableNext, setOnlyAuditableNext] = useState(true);
  // What the user plans to send this boundary. The bid buys position for the WHOLE
  // bundle, so both beat columns are priced against this rather than a fixed 1+1.
  //
  // null means "follow my wallet" — the defaults are the citizens held and their summed
  // audit capacity, which is what a full boundary actually looks like. They can't be
  // plain useState initial values: tokens load asynchronously, so at first render both
  // would be 0 and stick there. Holding null until the user types keeps the numbers
  // tracking the wallet (adding a wallet or a citizen updates them) without ever
  // overwriting a figure someone entered deliberately.
  const [paymentsEdit, setPaymentsEdit] = useState<number | null>(null);
  const [auditsEdit, setAuditsEdit] = useState<number | null>(null);
  // The tip is editable too, so the panel answers "if I set 200 gwei, what bid do I still
  // need?" rather than only pricing against whatever is saved in config. null = follow config,
  // so changing the saved tip keeps flowing through until the field is touched.
  const [tipEdit, setTipEdit] = useState<number | null>(null);
  const payments = paymentsEdit ?? ownedCitizens;
  const audits = auditsEdit ?? auditCapacity;
  const tip = tipEdit ?? tipGwei;
  const pollRef = useRef<number | null>(null);

  const load = async () => {
    try { setState(await api.targetScores()); setErr(null); }
    catch (e) { setErr((e as Error).message); }
  };

  useEffect(() => { void load(); }, []);

  // Poll only while a scan is in flight, then stop — no idle polling.
  useEffect(() => {
    if (!state?.running) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    if (pollRef.current) return;
    pollRef.current = window.setInterval(() => void load(), 3000);
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [state?.running]);

  const analyze = async () => {
    setErr(null);
    try { setState(await api.runTargetScores()); }
    catch (e) { setErr((e as Error).message); }
  };

  const plan = { payments, audits, tipGwei: tip };
  const planGas = bundleGas(payments, audits);
  const running = state?.running ?? false;
  const rows = state?.rows ?? null;
  const pool = rows
    ? (onlyAuditableNext ? rows.filter((r) => r.behind >= 1 && !r.under) : rows)
    : null;
  // Big boys also get their OWN reference section below, listing every one of them —
  // Big boys are kept OUT of the two ranked sections and shown only in their own, below.
  // They are still full offense targets — this is presentation: mixing a multi-citizen
  // operator defending at ~100 gwei/gas into a list sorted by weak-link score buries the
  // genuinely weak rivals that score exists to surface.
  const targetable = pool ? pool.filter((r) => !r.bigBoyOwner) : null;
  // Follows the same auditable-next filter as the two sections above. It used to be built
  // from the full row set on the reasoning that the roster is reference material, but that
  // put paid-up big boys beside delinquent ones under a filter that claims to show only
  // what is auditable. The header reports how many are hidden instead.
  const listedAll = rows
    ? rows.filter((r) => !!r.bigBoyOwner)
        .sort((a, b) => a.bigBoyOwner!.localeCompare(b.bigBoyOwner!) || Number(a.token) - Number(b.token))
    : [];
  const listed = pool ? listedAll.filter((r) => pool.includes(r)) : listedAll;
  const skippers = targetable ? targetable.filter((r) => r.skipper).sort((a, b) => b.score - a.score) : [];
  const others = targetable ? targetable.filter((r) => !r.skipper).sort((a, b) => b.score - a.score) : [];
  // Reachable, not "score > 0": a 0.00 can now mean catchable-but-not-weak (rich, defends
  // hard, never yet audited), which belongs at the bottom of the list rather than off it.
  const pasteIds = (list: TargetScoreRow[]) =>
    list.filter((r) => !r.under && !dimmed(r)).map((r) => r.token).join(",");

  return (
    <div className="panel">
      <h2>Target analysis</h2>

      <div className="row wrap" style={{ gap: 10, marginBottom: 8 }}>
        <button className="primary" onClick={analyze} disabled={running}>
          {running ? "Analyzing…" : rows ? "Re-analyze targets" : "Analyze targets"}
        </button>
        {state?.computedAtEpoch !== null && state?.computedAtEpoch !== undefined && (
          state.stale
            ? <span className="badge warn" title={`Scored at epoch ${state.computedAtEpoch}; the game is now at epoch ${currentEpoch ?? "?"}. Every "behind" count has shifted — re-analyze.`}>
                ⚠ STALE · epoch {state.computedAtEpoch} → now {currentEpoch ?? "?"}
              </span>
            : <span className="badge on" title="Scored against the current epoch">epoch {state.computedAtEpoch}</span>
        )}
      </div>

      {running && (
        <p className="hint" style={{ fontSize: 11 }}>
          Scanning on-chain history — takes a minute or two. Safe to leave this page; the
          result is cached on the backend.
        </p>
      )}
      {state?.error && <p className="err" style={{ fontSize: 11 }}>{state.error}</p>}
      {err && <p className="err" style={{ fontSize: 11 }}>{err}</p>}

      {!rows && !running && !state?.error && (
        <p className="muted" style={{ fontSize: 12 }}>
          Scores every rival on owner funding, skip cadence, defense strength and payment
          timing to rank weak-link audit targets. Click Analyze to run it.
        </p>
      )}

      {rows && (
        <>
          <label className="check" style={{ fontSize: 12, marginBottom: 6 }}>
            <input type="checkbox" checked={onlyAuditableNext} onChange={(e) => setOnlyAuditableNext(e.target.checked)} />
            Only those auditable at the next boundary
          </label>

          <div
            className="row wrap"
            style={{ gap: 10, alignItems: "flex-end", marginBottom: 10, paddingBottom: 8, borderBottom: "1px solid var(--border)" }}
          >
            <label className="field" style={{ marginBottom: 0, width: 92 }}>
              Payments
              <input
                type="number" min={0} max={99} step={1} value={payments}
                {...selectOnFocus}
                onChange={(e) => setPaymentsEdit(Math.max(0, Math.min(99, Math.floor(Number(e.target.value) || 0))))}
              />
            </label>
            <label className="field" style={{ marginBottom: 0, width: 92 }}>
              Audits
              <input
                type="number" min={0} max={99} step={1} value={audits}
                {...selectOnFocus}
                onChange={(e) => setAuditsEdit(Math.max(0, Math.min(99, Math.floor(Number(e.target.value) || 0))))}
              />
            </label>
            <label className="field" style={{ marginBottom: 0, width: 92 }}>
              Tip (gwei)
              <input
                type="number" min={0} max={2000} step={1} value={tip}
                {...selectOnFocus}
                title="The priority fee to price against. Defaults to your configured offense tip; change it to ask 'if I bid this tip instead, what bid do I still need?'. Every Beat column and the lead figures below re-price live."
                onChange={(e) => setTipEdit(Math.max(0, Math.min(2000, Math.floor(Number(e.target.value) || 0))))}
              />
            </label>
            <span
              className="muted"
              style={{ fontSize: 11, lineHeight: 1.5 }}
              title="Measured on-chain: 82,875 gas per payment, 130,409 per audit, plus 30,550 for the CoinbasePayer transaction that carries the bid. That last figure is gas USED, not the 60,000 limit the payer tx is signed with — builders simulate and order on what a bundle actually burns, so pricing against the limit overstated every bundle by ~30,000 gas."
            >
              bundle {planGas.toLocaleString()} gas @ {tip} gwei tip ≈{" "}
              {tipCostEth(tip, payments, audits).toFixed(4)} ETH in tips
              {paymentsEdit === null && auditsEdit === null && tipEdit === null ? (
                <> · from your wallet: {ownedCitizens} citizen{ownedCitizens === 1 ? "" : "s"},{" "}
                  {auditCapacity} audit slot{auditCapacity === 1 ? "" : "s"}</>
              ) : (
                <>
                  {" "}·{" "}
                  <button
                    type="button"
                    onClick={() => { setPaymentsEdit(null); setAuditsEdit(null); setTipEdit(null); }}
                    style={{ padding: "1px 8px", fontSize: 11, borderRadius: 5, border: "1px solid #555" }}
                    title={`Back to what this wallet set actually holds: ${ownedCitizens} citizen(s) and ${auditCapacity} audit slot(s).`}
                  >
                    reset to my wallet + configured tip
                  </button>
                </>
              )}
              <br />
              Beat2ep / BeatMax / BeatBnd below are priced for this bundle — a bid buys
              position for all of it, so they scale with what you carry.
            </span>
          </div>

          {/*
            The bar to LEAD a boundary block, as distinct from out-ranking any one rival.
            Kept next to the bundle controls because it re-prices with them, and stated with
            its calibration: the densest bundle took index 0 only about half the time, so a
            figure presented as "the winning bid" would repeat the mistake this whole panel
            exists to correct.
          */}
          {state?.leadBar ? (
            <div
              className="row wrap"
              style={{ gap: 8, alignItems: "baseline", marginBottom: 10, fontSize: 11 }}
            >
              <span className="muted">To LEAD a boundary block:</span>
              {([["typical", "p50"], ["most blocks", "p90"], ["strongest seen", "max"]] as const).map(
                ([label, k]) => {
                  const bar = state.leadBar![k];
                  const bid = bidToBeat(bar, tip, payments, audits);
                  return (
                    <span
                      key={k}
                      title={`The strongest bundle present was ${bar} gwei/gas at this percentile of ${state.leadBar!.blocks} observed boundary race(s). Two ways to clear it, priced like for like: a ${tipFor(bar)} gwei priority fee on its own costs ~${tipCostEth(tipFor(bar)!, payments, audits).toFixed(4)} ETH, or keep your ${tip} gwei tip and add ${bid.toFixed(4)} ETH of bid — but that route also tips the CoinbasePayer tx, so its true total is ~${(bid + tipCostEth(tip, payments, audits) + (tip * 30550) / 1e9).toFixed(4)} ETH. The tip is therefore the CHEAPER lever here, as well as the only one that works on the ~1 boundary in 10 built by a solo validator. A bid's advantage is scope, not price: it applies to this boundary only, while the tip re-prices every transaction the bot sends.`}
                    >
                      {label}{" "}
                      <strong style={{ color: bid > 0 ? "var(--amber)" : "var(--green)" }}>
                        {bid > 0 ? `${bid.toFixed(4)} ETH` : "your tip already leads"}
                      </strong>
                      {bid > 0 ? (
                        <span className="muted" style={{ fontSize: 10 }}>
                          {" "}
                          {/* Totals, not the bare bid: the bid route keeps paying its tip
                              (payer tx included), so the raw bid understates it. */}
                          (+{tipCostEth(tip, payments, audits).toFixed(4)} tip ={" "}
                          {(bid + (tip * bundleGas(payments, audits)) / 1e9).toFixed(4)}Ξ) or{" "}
                          {tipFor(bar)}gw tip alone ={" "}
                          {tipCostEth(tipFor(bar)!, payments, audits).toFixed(4)}Ξ
                        </span>
                      ) : null}
                    </span>
                  );
                },
              )}
              <span
                className="muted"
                title="Leading on density is the bar to clear, not a guarantee of the slot: across the same races the densest bundle took index 0 only about half the time. Treat the p90 figure as buying margin against that, and note that a rival can win while measuring below your tip — the ? markers below are where that was actually observed."
              >
                · a bar to clear, not a guaranteed slot ({state.leadBar.blocks} races)
              </span>
            </div>
          ) : null}

          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
            RIVAL SKIPPERS ({skippers.length})
          </div>
          <ScoreTable rows={skippers} empty="No skippers match." plan={plan} />

          <div className="spacer" />
          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
            NON-SKIPPERS ({others.length})
          </div>
          <ScoreTable rows={others} empty="No non-skippers match." plan={plan} />

          {listed.length > 0 && (
            <>
              <div className="spacer" />
              <div
                className="muted"
                style={{ fontSize: 11, marginBottom: 4 }}
                title="Curated in data/big-boys.json, grouped by operator. These are FULL TARGETS — the engine audits them like any other rival. They are listed here rather than in the ranked sections above because their weak-link scores sit low (deep reserves, hard defense) and would pad the lists that exist to surface weak rivals. Read the Beat boundary column here to price a coordinated push. Follows the same auditable filter as the lists above; the count shows how much of the roster that filter hides."
              >
                BIG BOYS ({listed.length}
                {listed.length !== listedAll.length ? ` of ${listedAll.length}` : ""}) ·
                full targets — kept separate from the ranked sections above
              </div>
              <ScoreTable rows={listed} empty="None listed." plan={plan} />
            </>
          )}

          <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
            <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>PASTE (ranked, reachable only)</div>
            <label className="field" style={{ marginBottom: 6 }}>
              skippers
              <input readOnly value={pasteIds(skippers)} onFocus={(e) => e.currentTarget.select()}
                style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }} />
            </label>
            <label className="field" style={{ marginBottom: listed.length > 0 ? 6 : 0 }}>
              non-skippers
              <input readOnly value={pasteIds(others)} onFocus={(e) => e.currentTarget.select()}
                style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }} />
            </label>
            {listed.length > 0 && (
              <label className="field">
                big boys
                {/* Deliberately NOT filtered by score — every big boy scores 0 by
                    definition, so the catchable-only rule would empty this. It isn't a
                    ranked target list; it's the roster, ready to paste when you mean to
                    override it. */}
                <input readOnly value={listed.map((r) => r.token).join(",")} onFocus={(e) => e.currentTarget.select()}
                  style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }} />
              </label>
            )}
          </div>

          <p className="muted" style={{ fontSize: 11, margin: "8px 0 0 0", lineHeight: 1.6 }}>
            <b>The three Beat columns each show two levers</b>: the top figure is the flat
            coinbase <b>bid</b> at your configured tip, the small figure under it is the
            <b> priority fee</b> that clears the same bar with no bid at all (green = your
            current tip already clears it). The tip works on <i>every</i> builder — including
            the ~1 boundary in 10 built by a solo validator, which sorts on priority fee and
            ignores coinbase transfers outright, so a bid buys nothing there. The tip is also the
            <b> cheaper</b> lever at equal density, which is the opposite of what this panel
            used to say: the bid route must additionally send and tip the CoinbasePayer
            transaction (~30,550 gas), leaving it ~0.011–0.014 ETH dearer at any bundle size.
            The bid figure only looks smaller because it is quoted on top of a tip you still
            pay. A bid buys <i>scope</i>, not a discount — it applies to one boundary, while
            the configured tip re-prices every transaction the bot sends. Each tip figure now
            carries its ETH cost so the two are directly comparable.
            <b> The three Beat columns are three windows on the same rival</b>: what it mounted
            at the -1 (latest) boundary, at the -2 boundary before it, and at its peak. Read
            across them — rising means it is
            escalating and only Max is safe to trust, while a large Max beside two dashes means it
            CAN defend hard but did not lately. A <b>·</b> is no payment observed in that epoch,
            which is missing data rather than a cheap defense. In a Beat cell, <b>!</b> and
            <b> ?</b> both mean no price can be quoted, but for opposite reasons: <b>!</b> = a
            block was seen ordering that rival's bundle <i>ahead of a denser one</i>, so
            out-bidding may not be the lever at all; <b>?</b> = it reached top-of-block with
            nothing denser present to out-rank, so the price is merely untested. Density
            predicts ordering ~87% of the time overall, but ~99% on BuilderNet versus ~80% on
            Titan and Builder+, so a <b>!</b> says as much about where a rival races as about
            the rival. · Beh 1 = auditable next boundary · Skip =
            skips survived / skips that drew an audit, out of attempted (a skip = a boundary
            entered 2+ behind) ·
            Def = their tip as -2/-1/max gwei · Idx = lowest tx index they reached · PayBlk = blocks after boundary they paid
            (fastest / median; 0 = pays in the boundary block) · ATK/DEF bid = the rival's own coinbase bid as
            -2/-1/max in ETH (the -2 boundary / the -1 latest boundary / biggest seen), counted whether
            it backed a payment or an audit — read it next to Beat max,
            because a bid over a small bundle is usually what makes that number large, and the
            three fields separate a bidder still doing it from one that merely could · greyed rows are already under audit. Big boys are full targets but
            are listed in their own section rather than mixed into the ranked lists, because
            their scores sit low and would crowd out the weak rivals the score exists to find.
          </p>
        </>
      )}
    </div>
  );
}
