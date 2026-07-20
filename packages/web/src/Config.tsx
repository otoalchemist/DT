import { useEffect, useState } from "react";
import type { StrategyConfig, StrategySnapshot } from "@dat-bot/shared";
import { ApiError, api } from "./api.js";

type SubmissionMode = "public" | "mainnet" | "local";

const MODE_TIPS: Record<SubmissionMode, string> = {
  public:
    "Public mempool only. Every connected builder can see the transaction, but there is no private bundle path.",
  mainnet:
    "Fans out private bundles to configured builders. Survival payments also use a concurrent public fallback for broader coverage.",
  local: "Local/anvil mode is selected by the MODE environment variable and is read-only in this dashboard.",
};

function AlchemyKeySection({
  initialMode,
  modeConfiguredByEnvironment,
  keyConfiguredByEnvironment,
  builderIncentiveMayReactivate,
  onSettingsChange,
}: {
  initialMode: SubmissionMode;
  modeConfiguredByEnvironment: boolean;
  keyConfiguredByEnvironment: boolean;
  builderIncentiveMayReactivate: boolean;
  onSettingsChange: () => void;
}) {
  const [key, setKey] = useState("");
  const [mode, setMode] = useState<SubmissionMode>(initialMode);
  const [busyKey, setBusyKey] = useState(false);
  const [busyMode, setBusyMode] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // useState's initial value is only read on mount, so when the parent loads the
  // real mode from the backend (GET /api/settings) after this component has already
  // mounted, reflect it here — otherwise the buttons stay stuck on the seed value.
  useEffect(() => setMode(initialMode), [initialMode]);

  const saveKey = async () => {
    if (!key.trim() || mode === "local" || keyConfiguredByEnvironment) return;
    setBusyKey(true);
    setMsg(null);
    try {
      await api.saveAlchemyKey(key.trim());
      setMsg("Saved — RPC clients updated.");
      setKey("");
      onSettingsChange();
    } catch (e) {
      try {
        setMode((await api.getSettings()).mode);
      } catch {
        // Preserve the mutation error below.
      }
      setMsg(`Error: ${(e as Error).message}`);
    } finally {
      setBusyKey(false);
    }
  };

  const switchMode = async (next: "mainnet" | "public") => {
    const acknowledgesRisk = mode === "public"
      && next === "mainnet"
      && builderIncentiveMayReactivate;
    if (acknowledgesRisk && !window.confirm(
      "Confirm direct builder-incentive reactivation risk\n\n"
      + "The persisted direct-incentive and combined-cohort switches are enabled. "
      + "Switching to mainnet will revalidate the configured CoinbasePayer and can reactivate "
      + "a non-refundable payment of the configured bid plus gas when a mandatory boundary payment is due. "
      + "It does not guarantee inclusion, placement, or transaction ordering.",
    )) return;
    setBusyMode(true);
    setMsg(null);
    try {
      const saved = await api.saveMode(next, acknowledgesRisk);
      setMode(saved.mode);
      setMsg(`Mode switched to ${saved.mode}.`);
      onSettingsChange();
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
      try {
        setMode((await api.getSettings()).mode);
      } catch {
        setMode(mode); // last known authoritative value
      }
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
        {mode === "local" && <span className="badge warn" style={{ marginBottom: 8 }}>local (environment)</span>}
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          {(["public", "mainnet"] as const).map((m) => (
            <button
              key={m}
              onClick={() => switchMode(m)}
              disabled={busyMode || mode === m || mode === "local" || modeConfiguredByEnvironment}
              style={{
                padding: "4px 14px",
                borderRadius: 6,
                border: mode === m ? "2px solid var(--accent, #6c7)" : "1px solid #555",
                fontWeight: mode === m ? 700 : 400,
                opacity: busyMode ? 0.6 : 1,
                cursor: mode === m || mode === "local" ? "default" : "pointer",
              }}
            >
              {m}
            </button>
          ))}
        </div>
        <p style={{ fontSize: 12, color: "#aaa", margin: 0, lineHeight: 1.5 }}>
          {MODE_TIPS[mode]}
        </p>
        {modeConfiguredByEnvironment && (
          <p className="hint">Mode is fixed by the MODE environment variable; edit it and restart to change modes.</p>
        )}
        {!modeConfiguredByEnvironment && mode === "public" && builderIncentiveMayReactivate && (
          <p className="err" role="note">
            Switching to mainnet can reactivate the persisted direct builder incentive after the backend
            revalidates chain 1 and the pinned payer runtime. The bid plus gas is non-refundable if included.
          </p>
        )}
      </div>

      <label className="field">
        Update Alchemy API key
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="paste new key to replace"
          disabled={mode === "local" || keyConfiguredByEnvironment}
        />
      </label>
      {mode === "local" && (
        <p className="hint">Local RPC endpoints are environment-controlled. Change them there and restart.</p>
      )}
      {keyConfiguredByEnvironment && (
        <p className="hint">The Alchemy key is fixed by ALCHEMY_API_KEY; edit the environment and restart to replace it.</p>
      )}
      {msg && <p className={msg.startsWith("Error") ? "err" : "hint"}>{msg}</p>}
      <button onClick={saveKey} disabled={busyKey || mode === "local" || keyConfiguredByEnvironment || key.trim().length < 10} style={{ marginBottom: 8 }}>
        {busyKey ? "Saving…" : "Update key"}
      </button>
    </>
  );
}

// Strategy configuration form. Persists via revisioned PATCH /api/config.
export function Config({
  initial,
  onChange,
  onSettingsChange = () => {},
}: {
  initial: StrategySnapshot;
  onChange: (snapshot: StrategySnapshot) => void;
  onSettingsChange?: () => void;
}) {
  const [cfg, setCfg] = useState<StrategyConfig>(initial.config);
  const [revision, setRevision] = useState(initial.revision);
  const [dirty, setDirty] = useState<Partial<StrategyConfig>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  // Seed with the actual shipped default (mainnet) so the panel doesn't briefly
  // misreport before GET /api/settings resolves; corrected on load if it differs.
  const [currentMode, setCurrentMode] = useState<SubmissionMode>("mainnet");
  const [modeConfiguredByEnvironment, setModeConfiguredByEnvironment] = useState(false);
  const [keyConfiguredByEnvironment, setKeyConfiguredByEnvironment] = useState(false);

  useEffect(() => {
    if (initial.revision === revision) return;
    setCfg(initial.config);
    setRevision(initial.revision);
    setDirty({});
  }, [initial, revision]);

  useEffect(() => {
    api.getSettings().then((s) => {
      setCurrentMode(s.mode);
      setModeConfiguredByEnvironment(s.modeConfiguredByEnvironment);
      setKeyConfiguredByEnvironment(s.keyConfiguredByEnvironment);
    }).catch(() => {});
  }, []);

  const set = <K extends keyof StrategyConfig>(k: K, v: StrategyConfig[K]) => {
    setCfg((c) => ({ ...c, [k]: v }));
    setDirty((patch) => ({ ...patch, [k]: v }));
    setSaved(false);
  };

  const save = async () => {
    setBusy(true);
    setSaveErr(null);
    try {
      if (Object.keys(dirty).length === 0) return;
      const snapshot = await api.setConfig(revision, dirty);
      setCfg(snapshot.config);
      setRevision(snapshot.revision);
      setDirty({});
      onChange(snapshot);
      setSaved(true);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 409 || e.status === 503)) {
        try {
          const authoritative = await api.getConfig();
          setCfg(authoritative.config);
          setRevision(authoritative.revision);
          setDirty({});
          onChange(authoritative);
          setSaveErr(e.status === 409
            ? "Configuration changed elsewhere; refreshed the authoritative values. Review and try again."
            : "The save may have committed but durability was not confirmed; refreshed authoritative values. The engine remains paused.");
          return;
        } catch {
          // Fall through to the original mutation error.
        }
      }
      setSaveErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const num = (k: keyof StrategyConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
    set(k, Number(e.target.value) as never);
  const chk = (k: keyof StrategyConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
    set(k, e.target.checked as never);

  return (
    <div className="panel">
      <h2>Strategy</h2>
      <p className="muted" style={{ fontSize: 11, margin: "0 0 4px 0" }}>
        Dry-run / live-fire is toggled from the badge in the top bar.
      </p>

      <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>DEFENSE</div>
      <label className="check">
        <input type="checkbox" checked={cfg.defenseEnabled} onChange={chk("defenseEnabled")} />
        Enable continuous defense
      </label>
      <label className="check">
        <input type="checkbox" checked={cfg.proactivePay} onChange={chk("proactivePay")} disabled={!cfg.defenseEnabled} />
        Proactively pay delinquent Citizens
      </label>
      <label className="field">
        Clear audits with this many seconds remaining
        <input type="number" min={0} step={60} value={cfg.auditSafetyBufferSeconds} onChange={num("auditSafetyBufferSeconds")} disabled={!cfg.defenseEnabled} />
      </label>
      <label className="field">
        Epochs requested per defense payment (1–7)
        <input type="number" min={1} max={7} step={1} value={cfg.prepayEpochs} onChange={num("prepayEpochs")} disabled={!cfg.defenseEnabled} />
      </label>
      <label className="check">
        <input type="checkbox" checked={cfg.autoUseBribe} onChange={chk("autoUseBribe")} disabled={!cfg.defenseEnabled} />
        Allow automatic bribe use
      </label>
      <p className="muted" style={{ fontSize: 11 }}>
        Continuous defense is independent from the one-shot JIT campaign. Enabling or saving either one never enables the other.
      </p>

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
        JIT boundary race. Note: builders choose block position from profitability, fees, and competing
        orderflow — a defender who pre-pays can still beat your audit.
      </p>
      <label className="field">
        Only run offense when supply is within N of 69 winners (blank = always)
        <input
          type="number" min={0}
          value={cfg.endgameOnlyWithin ?? ""}
          onChange={(e) => set("endgameOnlyWithin", e.target.value === "" ? null : Number(e.target.value))}
        />
      </label>
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
      <label className="field">
        Replacement priority-fee ceiling — offense (gwei)
        <input
          type="number"
          min={0.1}
          step={0.1}
          value={cfg.offenseReplacementPriorityFeeCapGwei}
          onChange={num("offenseReplacementPriorityFeeCapGwei")}
          disabled={!cfg.separateOffenseGas}
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
        so any builder can include them next block. Trades bundle privacy for speed. While defense/JIT is
        active this fallback is always used, so a private offense nonce cannot block an emergency payment.
        No effect in public mode.
      </p>

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

      <button className="primary" onClick={save} disabled={busy || Object.keys(dirty).length === 0}>
        {busy ? "Saving…" : saved ? "Saved ✓" : "Save strategy"}
      </button>
      {saveErr && <p className="err" style={{ marginTop: 6 }}>{saveErr}</p>}

      <AlchemyKeySection
        initialMode={currentMode}
        modeConfiguredByEnvironment={modeConfiguredByEnvironment}
        keyConfiguredByEnvironment={keyConfiguredByEnvironment}
        builderIncentiveMayReactivate={
          cfg.coinbaseBidEnabled && cfg.combinedBoundaryBundle
        }
        onSettingsChange={onSettingsChange}
      />
    </div>
  );
}
