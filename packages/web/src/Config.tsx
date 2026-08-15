import { useState } from "react";
import type { StrategyConfig } from "@dat-bot/shared";
import { api } from "./api.js";

function AlchemyKeySection() {
  const [key, setKey] = useState("");
  const [busyKey, setBusyKey] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const saveKey = async () => {
    if (!key.trim()) return;
    setBusyKey(true);
    setMsg(null);
    try {
      await api.saveAlchemyKey(key.trim());
      setMsg("Saved — RPC clients updated.");
      setKey("");
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
    } finally {
      setBusyKey(false);
    }
  };

  return (
    <>
      <div className="spacer" />
      <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>RPC / ALCHEMY</div>

      <label className="field">
        Update Alchemy API key
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="paste new key to replace"
        />
      </label>
      {msg && <p className={msg.startsWith("Error") ? "err" : "hint"}>{msg}</p>}
      <button onClick={saveKey} disabled={busyKey || key.trim().length < 10} style={{ marginBottom: 8 }}>
        {busyKey ? "Saving…" : "Update key"}
      </button>
    </>
  );
}

// Strategy configuration form. Persists via POST /api/config.
const STRATEGY_FIELDS: (keyof StrategyConfig)[] = [
  "minBalanceEth", "maxPaymentEth", "autoDefendAudit",
];

export function Config({
  cfg,
  savedCfg,
  onChange,
  onSaved,
}: {
  cfg: StrategyConfig;
  savedCfg: StrategyConfig | null;
  onChange: (next: StrategyConfig) => void;
  onSaved: (next: StrategyConfig) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const dirty =
    !!savedCfg && STRATEGY_FIELDS.some((k) => JSON.stringify(cfg[k]) !== JSON.stringify(savedCfg[k]));

  const set = <K extends keyof StrategyConfig>(k: K, v: StrategyConfig[K]) => {
    onChange({ ...cfg, [k]: v });
  };

  const save = async () => {
    setBusy(true);
    setSaveErr(null);
    try {
      const next = await api.setConfig(cfg);
      onSaved(next);
    } catch (e) {
      setSaveErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveBar = (
    <div className="save-bar">
      <button
        className={`primary save-cta${dirty ? " unsaved" : ""}`}
        onClick={save}
        disabled={busy || !dirty}
      >
        {busy ? "Saving…" : dirty ? "● Save strategy" : "Save strategy"}
      </button>
      {!busy && (dirty
        ? <span className="unsaved-note">Unsaved changes — the bot runs the last saved values until you save.</span>
        : <span className="saved-note">Saved ✓</span>)}
      {saveErr && <span className="err" style={{ fontSize: 12 }}>{saveErr}</span>}
    </div>
  );

  const num = (k: keyof StrategyConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
    set(k, Number(e.target.value) as never);
  const chk = (k: keyof StrategyConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
    set(k, e.target.checked as never);

  return (
    <div className="panel">
      <h2>Strategy</h2>
      <div style={{ marginBottom: 16 }}>{saveBar}</div>

      <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>BENJI (DEFENSE) MODE — POST-AUDIT</div>
      <label className="check">
        <input
          type="checkbox"
          checked={cfg.autoDefendAudit}
          onChange={chk("autoDefendAudit")}
        />
        Benji (Defense) Mode — auto-pay an audited citizen
      </label>
      {cfg.autoDefendAudit ? (
        <p
          style={{
            fontSize: 11,
            color: "var(--red)",
            border: "1px solid var(--red)",
            borderRadius: 4,
            padding: "8px 10px",
            margin: "6px 0 8px 24px",
            lineHeight: 1.55,
          }}
        >
          <b>⚠ BENJI (DEFENSE) MODE IS ON — this spends without asking.</b>
          <br />
          When one of your citizens is audited and holds <b>no bribes</b>, the bot pays off its
          whole debt to clear the audit. An audited citizen is at least 2 epochs behind, and
          paying force-settles <em>every</em> delinquent epoch at once, so the bill is a
          multiple of a normal day's tax and grows the further behind it is.
          <br />
          <b>This ignores your Auto-Pay Limit</b> — that cap would block it in exactly the case
          it exists for. Max single payment, the base-fee cap and the min-balance floor still
          apply, and a citizen you unchecked in the JIT panel is still never paid.
        </p>
      ) : (
        <p style={{ fontSize: 11, color: "var(--muted)", margin: "0 0 8px 24px", lineHeight: 1.5 }}>
          Off: an audited citizen gets no automatic response and will be killable when its 24h
          audit expires. Recovering one is manual — "Pay to current" or "Clear audit (bribe)" on
          the token row. Turn this on only if you want the bot to buy a citizen back unattended,
          at whatever the catch-up costs.
        </p>
      )}

      <div className="spacer" />
      <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>GUARDRAILS</div>
      <p style={{ fontSize: 11, color: "var(--muted)", margin: "0 0 8px 0", lineHeight: 1.5 }}>
        Payment gas (base fee cap, priority tip, dynamic tip) now lives under <b>Just-in-time epoch
        payment → Payment gas</b>, next to the arm button.
      </p>
      <label className="field">
        Min wallet balance floor (ETH)
        <input type="number" min={0} step={0.01} value={cfg.minBalanceEth} onChange={num("minBalanceEth")} />
      </label>
      <label className="field">
        Max single payment (ETH) — 0 disables
        <input type="number" min={0} step={0.01} value={cfg.maxPaymentEth} onChange={num("maxPaymentEth")} />
      </label>
      <p style={{ fontSize: 11, color: "var(--muted)", margin: "0 0 8px 0", lineHeight: 1.5 }}>
        Hard cap on any one transaction's value. A payment above this is skipped, not sent — a backstop
        against a bad estimate or a badly-delinquent token draining the wallet in one shot.
      </p>

      {saveBar}

      <AlchemyKeySection />
    </div>
  );
}
