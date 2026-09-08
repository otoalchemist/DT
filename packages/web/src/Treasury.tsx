import { useEffect, useState } from "react";
import type { TreasuryState } from "@dat-bot/shared";
import { api } from "./api.js";

/**
 * Prize-pool growth, per epoch.
 *
 * The headline this exists for is the per-winner column: the treasury is split between the
 * surviving citizens at the end, so a raw "+6.7 ETH this epoch" is only meaningful once it is
 * divided by that. It is the number that says what a day of everyone else's tax is worth to a
 * seat, and therefore what a seat is worth defending at.
 *
 * The pool number to read is the TOTAL at the top, not the sum of the rows: it predates this
 * window by ~160 epochs, so the rows show the rate, and the total shows the prize.
 */
const eth = (wei: string): number => Number(BigInt(wei)) / 1e18;

const cell: React.CSSProperties = {
  padding: "3px 8px",
  borderBottom: "1px solid var(--border)",
  fontSize: 12,
  whiteSpace: "nowrap",
  textAlign: "right",
};
const left: React.CSSProperties = { ...cell, textAlign: "left" };

export function Treasury() {
  const [state, setState] = useState<TreasuryState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (refresh = false) => {
    setBusy(true);
    try {
      setState(refresh ? await api.refreshTreasury() : await api.treasury());
    } catch {
      /* the endpoint reports its own errors in `error`; a transport failure just leaves
         the last good figures on screen rather than blanking the panel */
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const rows = state?.rows ?? [];
  const winners = state?.winners ?? 69;
  const done = rows.filter((r) => !r.live);
  const totalAdded = done.reduce((a, r) => a + eth(r.treasuryWei), 0);
  const mean = done.length > 0 ? totalAdded / done.length : 0;
  const poolEth = state ? eth(state.treasuryTotalWei) : 0;
  const projectEth = state ? eth(state.projectTotalWei) : 0;

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Prize pool</h3>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={busy}
          style={{ padding: "2px 10px", fontSize: 11, borderRadius: 5, border: "1px solid #555" }}
          title="Re-read the balances from chain. Cached for a minute otherwise, since it only moves as blocks land."
        >
          {busy ? "reading…" : "refresh"}
        </button>
      </div>

      {state?.error ? (
        <p className="err" style={{ fontSize: 12 }}>Could not read the treasury: {state.error}</p>
      ) : null}

      {/* Totals first: the pool is what people are playing for, and it long predates the
          window below — the rows are the rate of growth, not the prize. */}
      <div className="row wrap" style={{ gap: 18, marginBottom: 10 }}>
        <div title={`The contract's treasury (${state?.treasuryAddress || "…"}). This is the pot the surviving citizens split.`}>
          <div className="muted" style={{ fontSize: 11 }}>Treasury</div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>{poolEth.toFixed(2)} Ξ</div>
        </div>
        <div title={`The whole pool divided by the ${winners} citizens that survive to split it. What one seat is worth if the game ended now — and the number every row below is measured against.`}>
          <div className="muted" style={{ fontSize: 11 }}>Per winner (÷{winners})</div>
          <div style={{ fontSize: 20, fontWeight: 600, color: "var(--green)" }}>
            {(poolEth / winners).toFixed(4)} Ξ
          </div>
        </div>
        <div title={`The project address (${state?.projectAddress || "…"}). It takes a fixed cut of every tax payment and is NOT part of the prize pool.`}>
          <div className="muted" style={{ fontSize: 11 }}>Project</div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>{projectEth.toFixed(2)} Ξ</div>
        </div>
        {done.length > 0 ? (
          <div title={`Mean over the ${done.length} completed epochs listed below. The epoch in progress is excluded — a partial figure would drag the average down for no reason.`}>
            <div className="muted" style={{ fontSize: 11 }}>Added / epoch (avg)</div>
            <div style={{ fontSize: 20, fontWeight: 600 }}>{mean.toFixed(3)} Ξ</div>
          </div>
        ) : null}
      </div>

      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={left} title="Game epoch. Its tax is collected from its own boundary block onward.">Epoch</th>
            <th style={left} title="First block of the epoch. Most of an epoch's tax lands in exactly this block — that is what the boundary race is.">Boundary</th>
            <th style={cell} title="ETH the treasury gained during this epoch. Measured as the balance change from the block BEFORE this boundary to the block before the next, so tax paid in the boundary block counts toward the epoch it actually pays for.">Treasury +Ξ</th>
            <th style={cell} title={`That epoch's treasury gain divided by the ${winners} winners — what this single day added to one surviving seat. This is the number to hold against what you spend defending a citizen: an epoch that adds less per winner than your gas cost is an epoch you paid to stay in.`}>
              Per winner +Ξ
            </th>
            <th style={cell} title="ETH the project address took that epoch. A fixed cut of every payment, and NOT part of the prize pool.">Project +Ξ</th>
            <th style={cell} title="Project's share of everything collected that epoch. Steady across epochs because it is a contract-level split, not a discretionary one.">Cut</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && !state?.error ? (
            <tr><td style={left} colSpan={6} className="muted">reading chain…</td></tr>
          ) : null}
          {rows.map((r) => {
            const t = eth(r.treasuryWei);
            const p = eth(r.projectWei);
            const total = t + p;
            return (
              <tr key={r.epoch} style={r.live ? { opacity: 0.65 } : undefined}>
                <td style={{ ...left, fontWeight: r.live ? 400 : 600 }}>
                  {r.epoch}
                  {r.live ? <span className="muted" style={{ fontSize: 10 }}> in progress</span> : null}
                </td>
                <td style={{ ...left, fontFamily: "monospace", fontSize: 11 }} className="muted">{r.boundaryBlock}</td>
                <td style={cell}>{t.toFixed(4)}</td>
                <td style={{ ...cell, fontWeight: 600, color: "var(--green)" }}>{(t / winners).toFixed(5)}</td>
                <td style={cell} className="muted">{p.toFixed(4)}</td>
                <td style={cell} className="muted">{total > 0 ? `${((p / total) * 100).toFixed(1)}%` : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="muted" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>
        Balances are read one block before each boundary, so tax paid in the boundary block
        counts toward the epoch it buys rather than the one that just ended. The treasury total
        above is the whole pool, which predates this window — the rows show how fast it grows.
      </p>
    </div>
  );
}
