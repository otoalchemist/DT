import { useEffect, useState } from "react";
import type { StrategyConfig } from "@dat-bot/shared";
import { api } from "./api.js";

const MODE_TIPS: Record<"public" | "mainnet", string> = {
  public:
    "Fastest path — transaction goes directly to the public mempool and every block builder sees it immediately. " +
    "Recommended for this game since you're racing a clock, not a MEV searcher. " +
    "Anyone can see the tx before it lands, but frontrunning tax payments isn't a meaningful risk here.",
  mainnet:
    "Sends your transaction privately to the Flashbots relay as a bundle. " +
    "Nobody sees it until it lands in a block, so it can't be frontrun. " +
    "Adds ~100–200 ms relay round-trip overhead and submits to the next two blocks for inclusion odds. " +
    "Only useful if you have a specific reason to hide the transaction.",
};

function AlchemyKeySection({ initialMode }: { initialMode: "mainnet" | "public" }) {
  const [key, setKey] = useState("");
  const [mode, setMode] = useState<"mainnet" | "public">(initialMode);
  const [busyKey, setBusyKey] = useState(false);
  const [busyMode, setBusyMode] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // useState's initial value is only read on mount, so when the parent loads the
  // real mode from the backend (GET /api/settings) after this component has already
  // mounted, reflect it here — otherwise the buttons stay stuck on the seed value.
  useEffect(() => setMode(initialMode), [initialMode]);

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

  const switchMode = async (next: "mainnet" | "public") => {
    setMode(next);
    setBusyMode(true);
    setMsg(null);
    try {
      await api.saveMode(next);
      setMsg(`Mode switched to ${next}.`);
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
      setMode(mode); // revert on failure
    } finally {
      setBusyMode(false);
    }
  };

  return (
    <>
      <div className="spacer" />
      <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>RPC / ALCHEMY</div>

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Submission mode</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          {(["public", "mainnet"] as const).map((m) => (
            <button
              key={m}
              onClick={() => switchMode(m)}
              disabled={busyMode || mode === m}
              style={{
                padding: "4px 14px",
                borderRadius: 6,
                border: mode === m ? "2px solid var(--accent, #6c7)" : "1px solid #555",
                fontWeight: mode === m ? 700 : 400,
                opacity: busyMode ? 0.6 : 1,
                cursor: mode === m ? "default" : "pointer",
              }}
            >
              {m}
            </button>
          ))}
        </div>
        <p style={{ fontSize: 12, color: "#aaa", margin: 0, lineHeight: 1.5 }}>
          {MODE_TIPS[mode]}
        </p>
      </div>

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
  // Seed with the actual shipped default (mainnet) so the panel doesn't briefly
  // misreport before GET /api/settings resolves; corrected on load if it differs.
  const [currentMode, setCurrentMode] = useState<"mainnet" | "public">("mainnet");
  // The curated rival list shipped in git, fetched so "reset to default" can
  // restore it after the user edits their offense targets.
  const [defaultRivals, setDefaultRivals] = useState<string[]>([]);
  // The "skippers" subset — rivals that pay on a ~2-epoch cadence — offered as a
  // one-click focused target list.
  const [skippers, setSkippers] = useState<string[]>([]);

  useEffect(() => {
    api.getSettings().then((s) => setCurrentMode(s.mode)).catch(() => {});
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
      <label className="check">
        <input type="checkbox" checked={cfg.preBoundaryAudit} onChange={chk("preBoundaryAudit")} disabled={!cfg.offenseEnabled || !cfg.autoAudit} />
        ⚠ Race audits into the boundary block (advanced)
      </label>
      <label className="check">
        <input type="checkbox" checked={cfg.preBoundaryKill} onChange={chk("preBoundaryKill")} disabled={!cfg.offenseEnabled || !cfg.autoKill} />
        ⚠ Race kills into the first block after expiry (advanced)
      </label>
      <p style={{ fontSize: 11, color: "var(--muted)", margin: "0 0 8px 24px", lineHeight: 1.5 }}>
        Pre-submit audits/kills ~{cfg.preBoundaryLeadMs}ms before the deadline so they land in the first
        eligible block ahead of rivals, instead of the block after. Each is validated by simulating at the
        boundary/expiry instant, so an invalid one is skipped before spending gas. Lead is shared with the
        JIT boundary race. Note: at the boundary, block position is decided by builder orderflow more than
        tip — a defender who pre-pays can still beat your audit.
      </p>
      <label className="field">
        Only run offense when supply is within N of 69 winners (blank = always)
        <input
          type="number" min={0}
          value={cfg.endgameOnlyWithin ?? ""}
          onChange={(e) => set("endgameOnlyWithin", e.target.value === "" ? null : Number(e.target.value))}
        />
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
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

      <div className="spacer" />
      <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>LATENCY (offense)</div>
      <label className="check">
        <input
          type="checkbox"
          checked={cfg.racePublicMempool}
          onChange={chk("racePublicMempool")}
          disabled={!cfg.offenseEnabled}
        />
        Race public mempool (mainnet mode)
      </label>
      <p style={{ fontSize: 11, color: "var(--muted)", margin: "0 0 8px 24px", lineHeight: 1.5 }}>
        Also broadcasts time-critical offense txs to the public mempool alongside the Flashbots bundle,
        so any builder can include them next block. Trades bundle privacy for speed. No effect in public mode.
      </p>

      {/* DEFENSE is intentionally not rendered — it's rarely touched, and arming a
          JIT payment enables it automatically. The values still apply and remain
          editable in data/config.json (enabled, proactivePay,
          auditSafetyBufferSeconds, prepayEpochs, autoUseBribe). autoUseBribe is OFF
          by default (pay taxes to clear audits, never auto-spend a bribe). The
          per-payment epoch cap (maxAutoPayEpochs) is edited in the Just-in-time
          panel. */}

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

      <AlchemyKeySection initialMode={currentMode} />
    </div>
  );
}
