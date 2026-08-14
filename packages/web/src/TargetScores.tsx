import { useEffect, useRef, useState } from "react";
import { bidToBeat, bundleGas, type TargetScoreRow, type TargetScoresState } from "@dat-bot/shared";
import { api } from "./api.js";

/**
 * On-demand rival scoring. The scan is slow (~1-3 min of on-chain reads), so the button
 * kicks off a background run on the backend and this polls until it lands. Results are
 * cached backend-side, so the table survives a page reload without re-scanning.
 */
/**
 * Do Not Target: either the curated big-boy roster or the evidence heuristic (tops the
 * block, never audited). Falls back to `uncatchable`, the pre-rename field, so rows still
 * cached by an older backend keep greying correctly instead of silently going live.
 */
const dnt = (r: TargetScoreRow): boolean => r.doNotTarget ?? r.uncatchable ?? false;

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
            <th style={cell} title="Best (max) priority tip in gwei, and best (lowest) tx index reached">Def</th>
            <th style={cell} title="Blocks after the boundary they paid: fastest / median. 0 = pays in the boundary block">PayBlk</th>
            <th style={cell} title="Coinbase bid over the last 2 epochs (ETH × bid-backed payments) — the 'are they bidding right now' signal, deliberately narrower than the window BeatBid is priced against. Shared when one operator co-pays several citizens in a block. ? = RPC has no tracing">Bid 2ep</th>
            <th style={cell} title="Coinbase bid (ETH) to out-rank this rival's defense over the LAST 2 EPOCHS — the likely cost at the next boundary. Read it next to BeatMax: equal means a steady defender and this number is reliable; a gap means it escalates. — = nothing needed, your tip already out-ranks it. · = it made no payment in the last 2 epochs. Priced for the bundle set above.">Beat2ep</th>
            <th style={cell} title="Coinbase bid (ETH) needed to out-rank this rival's PEAK defense density over the whole window — (coinbase bid + priority tips) / gas, the value-per-gas a builder actually sorts on — for the bundle you set above, at your configured offense tip. Peak, not recent: what you must clear is the strongest defense it has actually mounted. Density, not tip: a bidder's tip can be near zero while its bid puts it hundreds of gwei/gas ahead. A ceiling, not a forecast — off-chain builder deals stay invisible. — = peak defense already at or below your tip. Both columns scale with bundle gas: a bid buys position for everything you carry, so adding uncontested payments raises what the contested audits cost.">BeatMax</th>
            <th style={cell} title="Coinbase bid (ETH) to out-rank this rival in a BOUNDARY BLOCK specifically — its defense measured only on payments that landed at offset 0, rather than peaking across quiet mid-epoch payments where nobody is contesting position. 'free' means it was never seen paying in a boundary block at all: it stays auditable until it notices, so you can take it without winning any race and without bidding. — = your tip already out-ranks its boundary defense. · = re-run the scan to populate this.">BeatBnd</th>
            <th style={cell} title="Bribes held — each is one free audit escape">Br</th>
            <th style={cell} title="Times anyone successfully audited it in the window">Aud</th>
            <th style={cell} title="Weak-link score, higher is a better target. 0 = do-not-target or under audit">Score</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.token} style={dnt(r) || r.under ? { opacity: 0.45 } : undefined}>
              <td style={{ ...cell, fontFamily: "monospace" }}>
                #{r.token}
                {r.dntOwner ? (
                  <span
                    className="badge"
                    style={{ fontSize: 9, marginLeft: 6, fontFamily: "inherit" }}
                    title={`Do Not Target — run by ${r.dntOwner}. Excluded from auto-discovery; pin it in the Strategy targets box to audit it anyway.`}
                  >
                    {r.dntOwner}
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
              <td style={cell}>{r.maxTip.toFixed(1)}gw/{r.bestIdx ?? "—"}</td>
              <td style={cell} title={r.payBlkMin === null ? "no payment seen in window" : undefined}>
                {r.payBlkMin === null ? "—" : `${r.payBlkMin}/${r.payBlkMed}`}
              </td>
              <td style={{ ...cell, color: r.bidEth ? "var(--red)" : undefined, fontWeight: r.bidEth ? 600 : 400 }}
                  title={r.bidEth == null ? "RPC has no tracing — unknown" : r.bidEth > 0 ? `${r.bidEth} ETH across ${r.bidPays} bid-backed payment(s) in the last 2 epochs` : "no coinbase bid in the last 2 epochs"}>
                {r.bidEth == null ? "?" : r.bidEth > 0 ? `${r.bidEth.toFixed(4)}×${r.bidPays}` : "—"}
              </td>
              <td style={cell}>
                {(() => {
                  const bid = beatFor(r.defenseRecentGwei, plan);
                  if (bid === null) {
                    return <span className="muted" title="No payment observed in the last 2 epochs — nothing recent to price against.">·</span>;
                  }
                  if (bid > 0) {
                    return (
                      <span title={`Defended at ~${r.defenseRecentGwei} gwei/gas in the last 2 epochs. Priced for ${plan.payments} payment(s) + ${plan.audits} audit(s) at a ${plan.tipGwei} gwei tip.`}>
                        {bid.toFixed(4)}
                      </span>
                    );
                  }
                  return <span className="muted" title={`Defended at ~${r.defenseRecentGwei} gwei/gas lately — your ${plan.tipGwei} gwei tip already out-ranks that.`}>—</span>;
                })()}
              </td>
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
                    <span
                      style={{ color: "var(--amber)" }}
                      title={`Measures only ~${r.defenseGwei} gwei/gas — below your tip — yet the blocks contradict that. Either it reached tx index ${r.bestIdx} anyway, or a block was seen placing its bundle ahead of a materially denser one. A bundle router reads weak here for exactly this reason: batching many actions into one large tx divides its bid across far more gas while still taking the slot. Treat "no bid needed" as unproven, and note that out-bidding may not be the lever.`}
                    >?</span>
                  ) : (
                    <span className="muted" title={`Defends at ~${r.defenseGwei} gwei/gas — your ${plan.tipGwei} gwei tip already out-ranks that, so no bid is needed.`}>—</span>
                  );
                })()}
              </td>
              <td style={cell}>
                {(() => {
                  // undefined = row cached before this field existed; null = measured, and
                  // it never paid in a boundary block at all. Those are opposite meanings,
                  // so they must not collapse into one placeholder.
                  if (r.defenseBoundaryGwei === undefined) {
                    return <span className="muted" title="Re-run Analyze targets to measure boundary-block defense">·</span>;
                  }
                  if (r.defenseBoundaryGwei === null) {
                    return (
                      <span
                        className="badge"
                        style={{ fontSize: 9, color: "var(--green)", borderColor: "var(--green)" }}
                        title={`Never seen paying in a boundary block${r.payBlkMin === null ? "" : ` — earliest was ${r.payBlkMin} blocks in`}. It stays auditable until the owner notices, so you can take it mid-epoch without winning a race and without bidding anything.`}
                      >free</span>
                    );
                  }
                  const bid = beatFor(r.defenseBoundaryGwei, plan);
                  return bid !== null && bid > 0 ? (
                    <span title={`Defends at ~${r.defenseBoundaryGwei} gwei/gas in boundary blocks. Priced for ${plan.payments} payment(s) + ${plan.audits} audit(s) at a ${plan.tipGwei} gwei tip.`}>
                      {bid.toFixed(4)}
                    </span>
                  ) : (
                    <span className="muted" title={`Defends at ~${r.defenseBoundaryGwei} gwei/gas in boundary blocks — your ${plan.tipGwei} gwei tip already out-ranks that.`}>—</span>
                  );
                })()}
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
  const payments = paymentsEdit ?? ownedCitizens;
  const audits = auditsEdit ?? auditCapacity;
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

  const plan = { payments, audits, tipGwei };
  const planGas = bundleGas(payments, audits);
  const running = state?.running ?? false;
  const rows = state?.rows ?? null;
  const pool = rows
    ? (onlyAuditableNext ? rows.filter((r) => r.behind >= 1 && !r.under) : rows)
    : null;
  // Listed do-not-target rivals are pulled out of the two candidate sections entirely —
  // ranking a non-candidate among candidates only invites a misread. Their own section is
  // built from the FULL row set, not the auditable-next pool, because it's a reference
  // roster: a big boy that isn't delinquent today should still be listed.
  const targetable = pool ? pool.filter((r) => !r.dntOwner) : null;
  // Follows the same auditable-next filter as the two sections above. It used to be built
  // from the full row set on the reasoning that the roster is reference material, but that
  // put paid-up big boys beside delinquent ones under a filter that claims to show only
  // what is auditable. The header reports how many are hidden instead.
  const listedAll = rows
    ? rows.filter((r) => !!r.dntOwner)
        .sort((a, b) => a.dntOwner!.localeCompare(b.dntOwner!) || Number(a.token) - Number(b.token))
    : [];
  const listed = pool ? listedAll.filter((r) => pool.includes(r)) : listedAll;
  const skippers = targetable ? targetable.filter((r) => r.skipper).sort((a, b) => b.score - a.score) : [];
  const others = targetable ? targetable.filter((r) => !r.skipper).sort((a, b) => b.score - a.score) : [];
  // Reachable, not "score > 0": a 0.00 can now mean catchable-but-not-weak (rich, defends
  // hard, never yet audited), which belongs at the bottom of the list rather than off it.
  const pasteIds = (list: TargetScoreRow[]) =>
    list.filter((r) => !r.under && !dnt(r)).map((r) => r.token).join(",");

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
            <span
              className="muted"
              style={{ fontSize: 11, lineHeight: 1.5 }}
              title="Measured on-chain: 82,875 gas per payment, 130,409 per audit, plus 30,550 for the CoinbasePayer transaction that carries the bid. That last figure is gas USED, not the 60,000 limit the payer tx is signed with — builders simulate and order on what a bundle actually burns, so pricing against the limit overstated every bundle by ~30,000 gas."
            >
              bundle {planGas.toLocaleString()} gas @ {tipGwei} gwei tip
              {paymentsEdit === null && auditsEdit === null ? (
                <> · from your wallet: {ownedCitizens} citizen{ownedCitizens === 1 ? "" : "s"},{" "}
                  {auditCapacity} audit slot{auditCapacity === 1 ? "" : "s"}</>
              ) : (
                <>
                  {" "}·{" "}
                  <button
                    type="button"
                    onClick={() => { setPaymentsEdit(null); setAuditsEdit(null); }}
                    style={{ padding: "1px 8px", fontSize: 11, borderRadius: 5, border: "1px solid #555" }}
                    title={`Back to what this wallet set actually holds: ${ownedCitizens} citizen(s) and ${auditCapacity} audit slot(s).`}
                  >
                    reset to my wallet
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
              <span className="muted">Bid to LEAD a boundary block:</span>
              {([["typical", "p50"], ["most blocks", "p90"], ["strongest seen", "max"]] as const).map(
                ([label, k]) => {
                  const bar = state.leadBar![k];
                  const bid = bidToBeat(bar, tipGwei, payments, audits);
                  return (
                    <span
                      key={k}
                      title={`The strongest bundle present was ${bar} gwei/gas at this percentile of ${state.leadBar!.blocks} observed boundary race(s). Matching it with ${payments} payment(s) + ${audits} audit(s) at a ${tipGwei} gwei tip costs ${bid.toFixed(4)} ETH.`}
                    >
                      {label}{" "}
                      <strong style={{ color: bid > 0 ? "var(--amber)" : "var(--green)" }}>
                        {bid > 0 ? `${bid.toFixed(4)} ETH` : "your tip already leads"}
                      </strong>
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
                title="Curated in data/do-not-target.json. Kept out of auto-discovery because these operators cure at the top of the boundary block, so an audit slot spent here is normally wasted. Follows the same auditable filter as the lists above; the count shows how much of the roster is hidden by it."
              >
                DO NOT TARGET ({listed.length}
                {listed.length !== listedAll.length ? ` of ${listedAll.length}` : ""}) · big boys
                — excluded from the lists above
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
            Beat2ep / BeatMax = bid needed to out-rank its defense recently vs at its peak
            (a gap means it escalates), priced for the payments/audits you set above · Beh 1 = auditable next boundary · Skip = skips survived / skips that drew an audit,
            out of attempted (a skip = a boundary entered 2+ behind) ·
            Def = max tip gwei / best tx index · PayBlk = blocks after boundary they paid
            (fastest / median; 0 = pays in the boundary block) · Bid 2ep = coinbase bid over
            the last 2 epochs, ETH × payments (a bidder buys top-of-block and is near-
            unauditable) · greyed rows are Do Not Target or already under audit. DNT is
            advice, not a veto: pin one in the Strategy targets box and it still gets audited.
          </p>
        </>
      )}
    </div>
  );
}
