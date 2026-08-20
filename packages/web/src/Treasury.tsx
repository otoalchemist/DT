import { useCallback, useEffect, useState } from "react";
import type { TreasuryLedger, TreasuryParticipant, TreasuryMovement } from "@dat-bot/shared";
import { api } from "./api.js";
import { shortAddr, weiToEthExact, weiToEthSigned } from "./util.js";

/**
 * The emigration treasury panel.
 *
 * Reads are cheap and local — the stored ledger — so the panel loads instantly. Touching
 * the chain for transfer history is an explicit Refresh, because a scan walks the whole
 * wallet history and there is no reason to pay for it on every dashboard mount.
 */

const sectionLabel = { fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase" as const };

function positionLabel(p: TreasuryParticipant): { text: string; color: string } {
  if (p.position === "uncounted") return { text: "not counted", color: "var(--muted, #888)" };
  if (p.position === "square") return { text: "square", color: "var(--muted, #888)" };
  if (p.position === "credit") return { text: `credit ${weiToEthExact(p.deltaWei)}`, color: "#4caf50" };
  return { text: `owes ${weiToEthExact(p.deltaWei?.replace("-", ""))}`, color: "#e05548" };
}

function holderName(p: TreasuryParticipant): string {
  return p.nickname ?? p.ens ?? shortAddr(p.address);
}

export function Treasury({ explorerBase }: { explorerBase?: string | null }) {
  const [ledger, setLedger] = useState<TreasuryLedger | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [newAddress, setNewAddress] = useState("");

  const loadKeys = useCallback(() => {
    api.treasuryKeys().then(setKeys).catch(() => setKeys({}));
  }, []);

  useEffect(() => {
    api.treasury().then(setLedger).catch((e: Error) => setError(e.message));
    loadKeys();
  }, [loadKeys]);

  const run = async (fn: () => Promise<TreasuryLedger>, done?: string) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      setLedger(await fn());
      if (done) setNote(done);
      loadKeys();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const { added, ledger: next } = await api.treasuryRefresh();
      setLedger(next);
      setNote(added === 0 ? "Already up to date." : `${added} new movement${added === 1 ? "" : "s"}.`);
      loadKeys();
    } catch (e) {
      // The stored ledger is untouched by a failed scan, so the figures on screen stay
      // valid — say why they are stale rather than blanking them.
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addOptIn = () => {
    const address = newAddress.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      setError("Enter a wallet address — 40 hex characters after 0x.");
      return;
    }
    setNewAddress("");
    void run(() => api.treasuryParticipant({ address, optIn: true }), "Pledge recorded.");
  };

  if (error && !ledger) {
    return (
      <div className="panel">
        <h2>Emigration treasury</h2>
        <p className="muted">{error}</p>
      </div>
    );
  }
  if (!ledger) {
    return (
      <div className="panel">
        <h2>Emigration treasury</h2>
        <p className="muted">Loading the ledger…</p>
      </div>
    );
  }

  const movementKey = (m: TreasuryMovement): string | undefined =>
    keys[`${m.hash}:${m.dir}:${m.valueWei}`];

  return (
    <div className="panel">
      <h2>Emigration treasury</h2>

      <div className="muted" style={{ ...sectionLabel, marginBottom: 6 }}>
        {weiToEthExact(ledger.raisedWei)} raised · {weiToEthExact(ledger.deployedWei)} deployed ·{" "}
        {weiToEthExact(ledger.onHandWei)} on hand ·{" "}
        {ledger.perCitizenWei === null
          ? "no split yet"
          : `${weiToEthExact(ledger.perCitizenWei)} per citizen across ${ledger.totalCitizens}`}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "8px 0" }}>
        <button onClick={() => void refresh()} disabled={busy || !ledger.syncAvailable}>
          {busy ? "Working…" : "Refresh from chain"}
        </button>
        <span className="muted" style={{ fontSize: 11 }}>
          {ledger.syncedAt ? `Synced ${new Date(ledger.syncedAt).toLocaleString()}` : "Never synced"}
        </span>
      </div>

      {!ledger.syncAvailable && (
        <p className="muted" style={{ fontSize: 11, margin: "0 0 8px 0", lineHeight: 1.5 }}>
          Auto-sync needs an Alchemy endpoint — the transfer history comes from
          <code> alchemy_getAssetTransfers</code>, which other RPCs don't serve. Set
          ALCHEMY_API_KEY to turn this on.
        </p>
      )}
      {!ledger.citizensAvailable && (
        <p className="muted" style={{ fontSize: 11, margin: "0 0 8px 0", lineHeight: 1.5 }}>
          Citizen counts are unavailable, so shares can't be split. Every holder reads zero
          until the ownership index is reachable.
        </p>
      )}
      {error && <p style={{ color: "#e05548", fontSize: 12, margin: "0 0 8px 0" }}>{error}</p>}
      {note && <p className="muted" style={{ fontSize: 12, margin: "0 0 8px 0" }}>{note}</p>}

      <table>
        <thead>
          <tr>
            <th>Holder</th>
            <th style={{ textAlign: "right" }}>Citizens</th>
            <th style={{ textAlign: "right" }}>Contributed</th>
            <th style={{ textAlign: "right" }}>Fair share</th>
            <th style={{ textAlign: "right" }}>Delta</th>
            <th>Position</th>
            <th>Pledged</th>
          </tr>
        </thead>
        <tbody>
          {ledger.participants.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                Nobody has contributed or pledged yet.
              </td>
            </tr>
          )}
          {ledger.participants.map((p) => {
            const pos = positionLabel(p);
            return (
              <tr key={p.address}>
                <td>
                  {explorerBase ? (
                    <a href={`${explorerBase}/address/${p.address}`} target="_blank" rel="noreferrer">
                      {holderName(p)}
                    </a>
                  ) : (
                    holderName(p)
                  )}
                  {p.departuresConfirmed > 0 && (
                    <span className="muted" style={{ fontSize: 10, marginLeft: 6 }}>
                      {p.departuresConfirmed} departure{p.departuresConfirmed === 1 ? "" : "s"} confirmed
                    </span>
                  )}
                </td>
                <td style={{ textAlign: "right" }}>{p.citizens}</td>
                <td style={{ textAlign: "right" }}>{weiToEthExact(p.contributedWei)}</td>
                <td style={{ textAlign: "right" }}>{weiToEthExact(p.fairShareWei)}</td>
                <td style={{ textAlign: "right" }}>{weiToEthSigned(p.deltaWei)}</td>
                <td style={{ color: pos.color }}>{pos.text}</td>
                <td>
                  <input
                    type="checkbox"
                    checked={p.optIn}
                    disabled={busy}
                    onChange={(e) =>
                      void run(() =>
                        api.treasuryParticipant({ address: p.address, optIn: e.target.checked }),
                      )
                    }
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ display: "flex", gap: 8, margin: "10px 0", flexWrap: "wrap" }}>
        <input
          type="text"
          placeholder="0x… pledge to contribute later"
          value={newAddress}
          onChange={(e) => setNewAddress(e.target.value)}
          style={{ flex: "1 1 320px" }}
        />
        <button onClick={addOptIn} disabled={busy}>
          Add pledge
        </button>
      </div>

      <h2 style={{ marginTop: 14 }}>Movements ({ledger.movements.length})</h2>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Flow</th>
            <th>Counterparty</th>
            <th style={{ textAlign: "right" }}>ETH</th>
            <th>Counted</th>
          </tr>
        </thead>
        <tbody>
          {ledger.movements.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                Nothing recorded yet — refresh to pull the wallet's history.
              </td>
            </tr>
          )}
          {ledger.movements.map((m) => {
            const key = movementKey(m);
            return (
              <tr key={`${m.hash}:${m.dir}:${m.valueWei}`} style={{ opacity: m.excluded ? 0.5 : 1 }}>
                <td className="muted">{m.timestamp ? m.timestamp.slice(0, 10) : "—"}</td>
                <td style={{ color: m.dir === "in" ? "#4caf50" : "#e05548" }}>
                  {m.dir === "in" ? "in" : "out"}
                  {m.category === "internal" && (
                    <span className="muted" style={{ fontSize: 10, marginLeft: 4 }}>internal</span>
                  )}
                </td>
                <td>
                  {explorerBase ? (
                    <a href={`${explorerBase}/tx/${m.hash}`} target="_blank" rel="noreferrer">
                      {shortAddr(m.counterparty)}
                    </a>
                  ) : (
                    shortAddr(m.counterparty)
                  )}
                  {m.note && (
                    <span className="muted" style={{ fontSize: 10, marginLeft: 6 }}>{m.note}</span>
                  )}
                </td>
                <td style={{ textAlign: "right" }}>{weiToEthExact(m.valueWei)}</td>
                <td>
                  <input
                    type="checkbox"
                    checked={!m.excluded}
                    disabled={busy || !key}
                    title={
                      key
                        ? "Uncheck a deposit that isn't a contribution, or a payout that didn't buy a departure"
                        : "This movement predates the current ledger index — refresh to annotate it"
                    }
                    onChange={(e) =>
                      key && void run(() => api.treasuryMovement({ key, excluded: !e.target.checked }))
                    }
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="muted" style={{ fontSize: 11, margin: "8px 0 0 0", lineHeight: 1.5 }}>
        ETH into{" "}
        {explorerBase ? (
          <a href={`${explorerBase}/address/${ledger.wallet}`} target="_blank" rel="noreferrer">
            the treasury
          </a>
        ) : (
          "the treasury"
        )}{" "}
        is a contribution; ETH out buys a departure. The bill for the departures bought so
        far is split across the citizens held by everyone who has contributed or pledged, so
        a holder's position is what they paid minus their share. Citizen counts and names
        come from the chain, not from this panel — what you set here is who intends to pay,
        what to call them, and which movements shouldn't count.
      </p>
    </div>
  );
}
