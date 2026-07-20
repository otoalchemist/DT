import { useState } from "react";
import type { PostMortemResult, PostMortemVerdict } from "@dat-bot/shared";
import { api } from "./api.js";

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

const outcomeBadge: Record<PostMortemVerdict["outcome"], string> = {
  won: "on",
  "lost-timing": "danger",
  "lost-fee": "warn",
  unknown: "off",
};

const outcomeLabel: Record<PostMortemVerdict["outcome"], string> = {
  won: "WON",
  "lost-timing": "LOST · timing",
  "lost-fee": "LOST · ordering",
  unknown: "unknown",
};

function parseHashes(raw: string): string[] {
  return raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

function fmt(n: number | null, d = 2): string {
  return n === null || n === undefined ? "—" : n.toFixed(d);
}

export function PostMortem() {
  const [oursRaw, setOursRaw] = useState("");
  const [rivalsRaw, setRivalsRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<PostMortemResult | null>(null);

  const ours = parseHashes(oursRaw);
  const rivals = parseHashes(rivalsRaw);
  const invalid = [...ours, ...rivals].filter((h) => !HASH_RE.test(h));
  const canRun = ours.length > 0 && invalid.length === 0 && !busy;

  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      setResult(await api.postMortem(ours, rivals));
    } catch (e) {
      setErr((e as Error).message);
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>Race post-mortem</h2>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
        Compare your transaction(s) against rivals to see whether a loss was timing (later block) or
        same-block ordering/builder economics. Visible tips are evidence, not proof: direct coinbase
        transfers or other bundle revenue may decide ordering. Paste tx hashes — one per line or comma-separated.
      </p>

      <label className="field">
        Your tx hash(es)
        <textarea
          rows={2}
          value={oursRaw}
          onChange={(e) => setOursRaw(e.target.value)}
          placeholder="0x… (one or more)"
          style={{ fontFamily: "monospace", fontSize: 12, resize: "vertical" }}
        />
      </label>
      <label className="field">
        Rival tx hash(es) — optional
        <textarea
          rows={2}
          value={rivalsRaw}
          onChange={(e) => setRivalsRaw(e.target.value)}
          placeholder="0x… (compared against each of yours)"
          style={{ fontFamily: "monospace", fontSize: 12, resize: "vertical" }}
        />
      </label>

      {invalid.length > 0 && (
        <p className="err" style={{ fontSize: 12 }}>
          {invalid.length} entr{invalid.length === 1 ? "y is" : "ies are"} not a valid 32-byte tx hash.
        </p>
      )}

      <button className="primary" onClick={run} disabled={!canRun}>
        {busy ? "Analyzing…" : "Run post-mortem"}
      </button>
      {err && <p className="err" style={{ marginTop: 6 }}>{err}</p>}

      {result && (
        <div style={{ marginTop: 14 }}>
          <table>
            <thead>
              <tr><th>Role</th><th>Action</th><th>Block</th><th>Idx</th><th>Tip</th><th>Eff</th></tr>
            </thead>
            <tbody>
              {result.txs.map((t) => (
                <tr key={t.hash}>
                  <td><span className={`badge ${t.role === "ours" ? "on" : "off"}`}>{t.role}</span></td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {t.found ? `${t.action}(${t.args})` : "not found / pending"}
                    {t.found && !t.toGame && <span className="badge warn" style={{ marginLeft: 4 }}>off-game</span>}
                  </td>
                  <td className="mono">{t.blockNumber ?? "—"}</td>
                  <td>{t.txIndex ?? "—"}</td>
                  <td>{fmt(t.tipGwei)}</td>
                  <td>{fmt(t.effectiveGwei)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {result.verdicts.length > 0 && (
            <div style={{ marginTop: 12 }}>
              {result.verdicts.map((v, i) => (
                <div key={i} style={{ marginBottom: 10, paddingBottom: 8, borderBottom: "1px solid #333" }}>
                  <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span className={`badge ${outcomeBadge[v.outcome]}`}>{outcomeLabel[v.outcome]}</span>
                    <span className="mono" style={{ fontSize: 11 }}>{v.ourLabel} vs {v.rivalLabel}</span>
                    {!v.sameAction && <span className="muted" style={{ fontSize: 10 }}>different action</span>}
                  </div>
                  <p style={{ fontSize: 12, color: "#bbb", margin: "4px 0 0" }}>{v.detail}</p>
                </div>
              ))}
            </div>
          )}

          {result.summary && (
            <p style={{ fontSize: 12, fontWeight: 600, marginTop: 8 }}>{result.summary}</p>
          )}
        </div>
      )}
    </div>
  );
}
