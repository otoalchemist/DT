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
  "racePublicMempool", "minBalanceEth", "maxPaymentEth", "autoDefendAudit",
  // NOTE: awayMode/awayLeadMinutes are deliberately absent. They live in the top bar as
  // an instant-apply control (like Start bot), so they persist the moment they're
  // pressed and must never light up this panel's unsaved-changes indicator.
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
  // The "big boys" roster (data/do-not-target.json). Offered as a template because the
  // roster is advice, not a block: pinning one is how you deliberately go after it.
  const [bigBoys, setBigBoys] = useState<string[]>([]);

  useEffect(() => {
    api.defaultRivalTargets().then((r) => setDefaultRivals(r.tokenIds)).catch(() => {});
    api.rivalSkippers().then((r) => setSkippers(r.tokenIds)).catch(() => {});
    api.doNotTarget().then((rows) => setBigBoys(rows.map((r) => r.tokenId))).catch(() => {});
  }, []);

  // True when the current target list already equals `list` (same ids, same order).
  const targetsEqual = (list: string[]) =>
    cfg.offenseTargetTokenIds.length === list.length &&
    cfg.offenseTargetTokenIds.every((id, i) => id === list[i]);

  // Non-skippers = the curated default list minus the skippers subset, derived here
  // rather than shipped as its own file: skippers is already a strict subset of the
  // defaults, so the complement is exact with no extra data to keep in sync. Preserves
  // the default list's order. Compared by canonical BigInt string so a formatting
  // difference between the two files can't leak a skipper back into this set.
  const skipperSet = new Set(skippers.map((x) => BigInt(x).toString()));
  const nonSkippers = defaultRivals.filter((id) => !skipperSet.has(BigInt(id).toString()));

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
        <button
          type="button"
          onClick={() => set("offenseTargetTokenIds", [...nonSkippers])}
          disabled={!cfg.offenseEnabled || nonSkippers.length === 0 || targetsEqual(nonSkippers)}
          style={{ padding: "3px 12px", borderRadius: 6, border: "1px solid #555", fontSize: 12 }}
          title="Target the curated rivals that are NOT ~2-epoch skippers (the default list minus Rival Skippers)"
        >
          Non-skippers
        </button>
        <button
          type="button"
          onClick={() => set("offenseTargetTokenIds", [...bigBoys])}
          disabled={!cfg.offenseEnabled || bigBoys.length === 0 || targetsEqual(bigBoys)}
          style={{ padding: "3px 12px", borderRadius: 6, border: "1px solid #555", fontSize: 12 }}
          title="Target the Do Not Target roster (data/do-not-target.json). These are normally excluded because they cure at the top of the boundary block — pinning them here is the deliberate override that makes the bot audit them anyway."
        >
          Big Boys
        </button>
        {defaultRivals.length > 0 && (
          <span className="muted" style={{ fontSize: 11 }}>
            {defaultRivals.length} default{skippers.length > 0 ? ` · ${skippers.length} skippers` : ""}
            {nonSkippers.length > 0 ? ` · ${nonSkippers.length} non-skippers` : ""}
            {bigBoys.length > 0 ? ` · ${bigBoys.length} big boys` : ""}
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

      {/* The rest of DEFENSE is intentionally not rendered — rarely touched, and arming a
          JIT payment enables it automatically. Those values stay editable in
          data/config.json (enabled, proactivePay, prepayEpochs) and cover PRE-AUDIT
          protection only. Per-citizen opt-out and the per-payment epoch cap live in the
          Just-in-time panel.

          autoDefendAudit IS rendered, because it is the one setting that spends an
          unbounded amount by itself — a thing a user must be able to see is on. It sits
          down here, after offense gas rather than up with the payment controls, because
          almost nobody should want it: letting an audited citizen go is usually correct,
          and this is the deliberate exception. */}
      <div className="spacer" />
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
