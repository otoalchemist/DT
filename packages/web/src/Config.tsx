import { useEffect, useState } from "react";
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

      {/* Submission mode (public / mainnet) is intentionally not rendered — mainnet
          (private Flashbots bundles) is the default and the one we want, and switching it
          by accident would change how every tx is submitted. Still switchable via the
          MODE env var / data settings. */}

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
//
// Controlled component: `cfg` is owned by Dashboard and shared with JitPanel, so
// there is a SINGLE source of truth for the config. Previously this panel kept its
// own local copy seeded from an `initial` prop and re-synced via useEffect; edits
// made here (e.g. "Enable offense") lived only in that copy, so an edit in JitPanel
// (which writes the shared config) would re-flow through the prop and silently clobber
// them. Reading/writing the shared object directly removes that stale-copy race.
// Fields this panel owns. Used to detect unsaved edits by comparing against the
// last-persisted config (savedCfg) — independent of the payment fields the JIT panel
// owns, so each Save button lights up only for its own section's changes.
const STRATEGY_FIELDS: (keyof StrategyConfig)[] = [
  "offenseEnabled", "autoAudit", "autoKill", "preBoundaryAudit", "preBoundaryKill",
  "endgameOnlyWithin", "offenseTargetTokenIds",
  "separateOffenseGas", "offenseMaxBaseFeeGwei", "offensePriorityFeeGwei",
  "offenseDynamicTipEnabled", "offenseDynamicTipMaxGwei",
  "racePublicMempool", "minBalanceEth", "maxPaymentEth",
  "awayMode", "awayLeadMinutes",
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

  // True when any strategy-owned field differs from what's persisted on the backend.
  const dirty =
    !!savedCfg && STRATEGY_FIELDS.some((k) => JSON.stringify(cfg[k]) !== JSON.stringify(savedCfg[k]));
  // The curated rival list shipped in git, fetched so "reset to default" can
  // restore it after the user edits their offense targets.
  const [defaultRivals, setDefaultRivals] = useState<string[]>([]);
  // The "skippers" subset — rivals that pay on a ~2-epoch cadence — offered as a
  // one-click focused target list.
  const [skippers, setSkippers] = useState<string[]>([]);

  useEffect(() => {
    api.defaultRivalTargets().then((r) => setDefaultRivals(r.tokenIds)).catch(() => {});
    api.rivalSkippers().then((r) => setSkippers(r.tokenIds)).catch(() => {});
  }, []);

  // True when the current target list already equals `list` (same ids, same order).
  const targetsEqual = (list: string[]) =>
    cfg.offenseTargetTokenIds.length === list.length &&
    cfg.offenseTargetTokenIds.every((id, i) => id === list[i]);

  const set = <K extends keyof StrategyConfig>(k: K, v: StrategyConfig[K]) => {
    onChange({ ...cfg, [k]: v });
  };

  const save = async () => {
    setBusy(true);
    setSaveErr(null);
    try {
      // Persist, then adopt the server-normalized config as the new saved baseline so
      // the shared state stays in lockstep with the backend and dirty clears.
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

      <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>AWAY MODE (RPC saver)</div>
      <label className="check">
        <input type="checkbox" checked={cfg.awayMode} onChange={chk("awayMode")} />
        Away mode — keep the engine idle between epochs
      </label>
      <p style={{ fontSize: 11, color: "var(--muted)", margin: "0 0 8px 24px", lineHeight: 1.5 }}>
        The engine costs ~22 provider requests/minute while running, but every automatic
        action fires <b>at the epoch boundary</b>. Away mode idles at <b>zero requests</b>
        (boundaries are arithmetic, not a poll), wakes the lead time below, runs through the
        boundary, and stops 5 minutes after. The dashboard also stops its 20s polling — use
        <b> Refresh data</b> in the top bar to read on demand.
        <br />
        It only wakes when there is something to do: a JIT payment armed, or offense enabled.
        <b> Mid-epoch work is missed</b> — kill deadlines fall 24h after an audit, not on a
        boundary, and a rival that becomes auditable mid-epoch won&apos;t be caught.
      </p>
      <label className="field" style={{ maxWidth: 260 }}>
        Wake this many minutes before the boundary
        <input type="number" min={1} max={720} step={1} value={cfg.awayLeadMinutes}
          onChange={(e) => set("awayLeadMinutes", Math.max(1, Math.floor(Number(e.target.value) || 1)))}
          disabled={!cfg.awayMode} />
      </label>

      <div className="spacer" />
      <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>OFFENSE (optional)</div>
      <label className="check">
        <input type="checkbox" checked={cfg.offenseEnabled} onChange={chk("offenseEnabled")} />
        Enable offense
      </label>
      <label className="check">
        <input type="checkbox" checked={cfg.autoAudit} onChange={chk("autoAudit")} disabled={!cfg.offenseEnabled} />
        Auto-audit delinquent rivals ({(0.00069).toString()} ETH each)
      </label>
      <label className="check">
        <input type="checkbox" checked={cfg.autoKill} onChange={chk("autoKill")} disabled={!cfg.offenseEnabled} />
        Auto-kill expired-audit tokens (free, gas only)
      </label>
      {/* Race audits/kills into the boundary block (preBoundaryAudit / preBoundaryKill)
          are intentionally not rendered — we always want them ON so offense competes in
          the first eligible block instead of the block after. They stay on and remain
          editable in data/config.json. preBoundaryKill is a no-op unless Auto-kill above
          is enabled. The "Only run offense when supply is within N of 69" gate
          (endgameOnlyWithin) is likewise hidden so its "always run" default can't be
          changed by accident. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, marginBottom: 4, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => set("offenseTargetTokenIds", [...defaultRivals])}
          disabled={!cfg.offenseEnabled || defaultRivals.length === 0 || targetsEqual(defaultRivals)}
          style={{ padding: "3px 12px", borderRadius: 6, border: "1px solid #555", fontSize: 12 }}
          title="Restore the curated rival list that ships with the bot"
        >
          Reset to default list
        </button>
        <button
          type="button"
          onClick={() => set("offenseTargetTokenIds", [...skippers])}
          disabled={!cfg.offenseEnabled || skippers.length === 0 || targetsEqual(skippers)}
          style={{ padding: "3px 12px", borderRadius: 6, border: "1px solid #555", fontSize: 12 }}
          title="Target only rivals that pay on a ~2-epoch cadence (delinquent at every second boundary)"
        >
          Rival Skippers
        </button>
        {defaultRivals.length > 0 && (
          <span className="muted" style={{ fontSize: 11 }}>
            {defaultRivals.length} default{skippers.length > 0 ? ` · ${skippers.length} skippers` : ""}
          </span>
        )}
      </div>
      <label className="field">
        Rival token IDs to target (one per line or comma-separated — blank = all delinquent rivals)
        <textarea
          rows={5}
          style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, resize: "vertical" }}
          value={cfg.offenseTargetTokenIds.join("\n")}
          onChange={(e) => {
            const ids = e.target.value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
            set("offenseTargetTokenIds", ids);
          }}
          disabled={!cfg.offenseEnabled}
          placeholder={"42\n137\n501"}
        />
        <span className="muted" style={{ fontSize: 11 }}>
          {cfg.offenseTargetTokenIds.length} token{cfg.offenseTargetTokenIds.length !== 1 ? "s" : ""}
        </span>
      </label>

      <div className="spacer" />
      <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>OFFENSE GAS (audit / kill)</div>
      <label className="check">
        <input
          type="checkbox"
          checked={cfg.separateOffenseGas}
          onChange={chk("separateOffenseGas")}
        />
        Separate gas for audit / kill
      </label>
      <p style={{ fontSize: 11, color: "var(--muted)", margin: "0 0 8px 24px", lineHeight: 1.5 }}>
        Audit and kill are races; tax payments are not. Turn this on to bid gas independently for
        offense. When off, audit/kill use the same payment gas (set in the JIT payment panel).
      </p>
      <label className="field">
        Max base fee — offense (gwei)
        <input
          type="number"
          min={0}
          value={cfg.offenseMaxBaseFeeGwei}
          onChange={num("offenseMaxBaseFeeGwei")}
          disabled={!cfg.separateOffenseGas}
        />
      </label>
      <label className="field">
        Priority fee / bundle tip — offense (gwei)
        <input
          type="number"
          min={0}
          step={0.1}
          value={cfg.offensePriorityFeeGwei}
          onChange={num("offensePriorityFeeGwei")}
          disabled={!cfg.separateOffenseGas}
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={cfg.offenseDynamicTipEnabled}
          onChange={chk("offenseDynamicTipEnabled")}
          disabled={!cfg.separateOffenseGas}
        />
        Dynamic priority tip — offense
      </label>
      <label className="field" style={{ marginLeft: 24 }}>
        Max dynamic tip — offense (gwei)
        <input
          type="number"
          min={0}
          step={1}
          value={cfg.offenseDynamicTipMaxGwei}
          onChange={num("offenseDynamicTipMaxGwei")}
          disabled={!cfg.separateOffenseGas || !cfg.offenseDynamicTipEnabled}
        />
      </label>

      {/* LATENCY (offense) — racePublicMempool — is intentionally not rendered. It's ON
          by default (mirror time-critical offense txs to the public mempool alongside the
          bundle so any builder can include them next block) and stays that way; still
          editable in data/config.json. */}

      {/* DEFENSE is intentionally not rendered — it's rarely touched, and arming a
          JIT payment enables it automatically. The remaining values stay editable in
          data/config.json (enabled, proactivePay, prepayEpochs), and cover PRE-AUDIT
          protection only: there is no automatic response to an audit at all, so there
          is no safety-buffer or auto-bribe setting to expose. Per-citizen opt-out and
          the per-payment epoch cap live in the Just-in-time panel. */}

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
