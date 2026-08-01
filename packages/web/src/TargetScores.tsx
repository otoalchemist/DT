import { useEffect, useRef, useState } from "react";
import type { TargetScoreRow, TargetScoresState } from "@dat-bot/shared";
import { api } from "./api.js";

/**
 * On-demand rival scoring. The scan is slow (~1-3 min of on-chain reads), so the button
 * kicks off a background run on the backend and this polls until it lands. Results are
 * cached backend-side, so the table survives a page reload without re-scanning.
 */
function ScoreTable({ rows, empty }: { rows: TargetScoreRow[]; empty: string }) {
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
            <th style={cell} title="Coinbase bid over the last 2 epochs (ETH × bid-backed payments). A bid buys top-of-block, so a bidder is near-unauditable however strapped it looks. Shared when one operator co-pays several citizens in a block. ? = RPC has no tracing">Bid 2ep</th>
            <th style={cell} title="Bribes held — each is one free audit escape">Br</th>
            <th style={cell} title="Times anyone successfully audited it in the window">Aud</th>
            <th style={cell} title="Weak-link score, higher is a better target. 0 = uncatchable or under audit">Score</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.token} style={r.uncatchable || r.under ? { opacity: 0.45 } : undefined}>
              <td style={{ ...cell, fontFamily: "monospace" }}>#{r.token}</td>
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

export function TargetScores({ currentEpoch }: { currentEpoch: string | null }) {
  const [state, setState] = useState<TargetScoresState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [onlyAuditableNext, setOnlyAuditableNext] = useState(true);
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

  const running = state?.running ?? false;
  const rows = state?.rows ?? null;
  const pool = rows
    ? (onlyAuditableNext ? rows.filter((r) => r.behind >= 1 && !r.under) : rows)
    : null;
  const skippers = pool ? pool.filter((r) => r.skipper).sort((a, b) => b.score - a.score) : [];
  const others = pool ? pool.filter((r) => !r.skipper).sort((a, b) => b.score - a.score) : [];
  const pasteIds = (list: TargetScoreRow[]) => list.filter((r) => r.score > 0).map((r) => r.token).join(",");

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

          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
            RIVAL SKIPPERS ({skippers.length})
          </div>
          <ScoreTable rows={skippers} empty="No skippers match." />

          <div className="spacer" />
          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
            NON-SKIPPERS ({others.length})
          </div>
          <ScoreTable rows={others} empty="No non-skippers match." />

          <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
            <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>PASTE (ranked, catchable only)</div>
            <label className="field" style={{ marginBottom: 6 }}>
              skippers
              <input readOnly value={pasteIds(skippers)} onFocus={(e) => e.currentTarget.select()}
                style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }} />
            </label>
            <label className="field">
              non-skippers
              <input readOnly value={pasteIds(others)} onFocus={(e) => e.currentTarget.select()}
                style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }} />
            </label>
          </div>

          <p className="muted" style={{ fontSize: 11, margin: "8px 0 0 0", lineHeight: 1.6 }}>
            Beh 1 = auditable next boundary · Skip = skips survived / skips that drew an audit,
            out of attempted (a skip = a boundary entered 2+ behind) ·
            Def = max tip gwei / best tx index · PayBlk = blocks after boundary they paid
            (fastest / median; 0 = pays in the boundary block) · Bid 2ep = coinbase bid over
            the last 2 epochs, ETH × payments (a bidder buys top-of-block and is near-
            unauditable) · greyed rows are uncatchable or already under audit.
          </p>
        </>
      )}
    </div>
  );
}
