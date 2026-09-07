import { useEffect, useState } from "react";
import { mempoolPrivacySummary, type StrategyConfig } from "@dat-bot/shared";
import { api } from "./api.js";

/** Token ids out of free text: newline OR comma separated, blanks dropped. Kept apart
 *  from the textarea's own value so a half-typed separator survives (see targetsDraft). */
function parseTokenIds(raw: string): string[] {
  return raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * One additive target group. Lit when every id it carries is already selected, so the
 * button reflects the actual list rather than a click it remembers — hand-editing the
 * textarea keeps the lights honest.
 */
function GroupToggle({
  label, ids, on, onClick, disabled, title,
}: {
  label: string;
  ids: string[];
  on: boolean;
  onClick: (ids: string[]) => void;
  disabled: boolean;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(ids)}
      disabled={disabled || ids.length === 0}
      title={`${title}\n\n${on ? "Selected — click to remove these from the list." : "Click to ADD these to the list (combines with anything already selected)."}`}
      style={{
        padding: "3px 12px",
        borderRadius: 6,
        fontSize: 12,
        border: `1px solid ${on ? "var(--accent)" : "#555"}`,
        background: on ? "var(--accent)" : "transparent",
        color: on ? "#06121f" : undefined,
        fontWeight: on ? 600 : undefined,
      }}
    >
      {on ? "✓ " : ""}{label} <span style={{ opacity: 0.7 }}>({ids.length})</span>
    </button>
  );
}

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
  "sweepUnpinned", "sweepNormalGas", "auditWhileBehind",
  "racePublicMempool", "minBalanceEth", "maxPaymentEth", "autoDefendAudit",
  // Thor Mode and the flags it forces. combinedBoundaryBundle is listed because Thor Mode
  // changes it, so an unsaved-changes indicator that ignored it would under-report.
  "thorMode", "mirrorAudits", "auditBundleAllOrNothing", "combinedBoundaryBundle",
  "mirrorPayments", "paymentBundleAllOrNothing",
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
  const [privacyOpen, setPrivacyOpen] = useState(false);

  // `cfg` is the EFFECTIVE config — applyThorMode folds its overrides in on load and on save
  // — so this summary can never disagree with the engine the way one built from raw toggles
  // could. Shown whether or not the section is expanded (see mempoolPrivacySummary).
  const privacySummary = mempoolPrivacySummary(cfg);

  // True when any strategy-owned field differs from what's persisted on the backend.
  const dirty =
    !!savedCfg && STRATEGY_FIELDS.some((k) => JSON.stringify(cfg[k]) !== JSON.stringify(savedCfg[k]));
  // The curated rival list shipped in git, fetched so "reset to default" can
  // restore it after the user edits their offense targets.
  const [defaultRivals, setDefaultRivals] = useState<string[]>([]);
  // The "skippers" subset — rivals that pay on a ~2-epoch cadence — offered as a
  // one-click focused target list.
  const [skippers, setSkippers] = useState<string[]>([]);
  // The big-boy roster (data/big-boys.json), kept GROUPED by operator rather than
  // flattened. Each operator is a different proposition — one is actively hunting, two have
  // not audited in months — so "target the big boys" was never one decision. Offered as
  // per-operator templates so a coordinated push can name exactly who it is going after.
  const [bigBoysByOperator, setBigBoysByOperator] = useState<Record<string, string[]>>({});
  const bigBoys = Object.values(bigBoysByOperator).flat();

  // The raw text of the targets box, kept separately from the parsed id list.
  //
  // It cannot render `cfg.offenseTargetTokenIds.join("\n")` directly: parsing drops empty
  // segments, so the moment you typed the "," or Enter that starts a second id, the value
  // round-tripped back without it and the separator vanished as you typed. There was no
  // way to reach a second line by hand. Editing the text and deriving the ids from it —
  // the same split the postmortem CLI uses for tx hashes — keeps separators alive while typing.
  const [targetsDraft, setTargetsDraft] = useState<string>(cfg.offenseTargetTokenIds.join("\n"));
  const targetsKey = cfg.offenseTargetTokenIds.join(",");
  // Re-seed only when the list changed from OUTSIDE this box — a template button, a reset,
  // or a save elsewhere. If the parsed draft already matches, the change was our own
  // typing and the raw text must be left exactly as the user left it.
  useEffect(() => {
    setTargetsDraft((prev) => (parseTokenIds(prev).join(",") === targetsKey ? prev : targetsKey.split(",").filter(Boolean).join("\n")));
  }, [targetsKey]);

  useEffect(() => {
    api.defaultRivalTargets().then((r) => setDefaultRivals(r.tokenIds)).catch(() => {});
    api.rivalSkippers().then((r) => setSkippers(r.tokenIds)).catch(() => {});
    api
      .bigBoys()
      .then((rows) => {
        const byOp: Record<string, string[]> = {};
        for (const r of rows) (byOp[r.operator] ??= []).push(r.tokenId);
        setBigBoysByOperator(byOp);
      })
      .catch(() => {});
  }, []);

  // True when the current target list already equals `list` (same ids, same order).
  const targetsEqual = (list: string[]) =>
    cfg.offenseTargetTokenIds.length === list.length &&
    cfg.offenseTargetTokenIds.every((id, i) => id === list[i]);

  // Compare by canonical numeric form, so "0206" typed by hand still matches "206" from
  // a list. Non-numeric text mid-edit falls back to itself rather than throwing.
  const canon = (id: string) => {
    try {
      return BigInt(id.trim()).toString();
    } catch {
      return id.trim();
    }
  };
  const selected = new Set(cfg.offenseTargetTokenIds.map(canon));
  /** A group counts as ON only when every one of its ids is already selected. */
  const groupOn = (group: string[]) => group.length > 0 && group.every((id) => selected.has(canon(id)));
  /**
   * Toggle a whole group in or out of the selection, so groups COMBINE rather than
   * replace: skippers + non-skippers is a legitimate ask, and re-typing one of them by
   * hand to get both was the only way before. Union on the way in (no duplicates),
   * set-difference on the way out. Order is preserved so the textarea doesn't reshuffle
   * under the cursor.
   */
  const toggleGroup = (group: string[]) => {
    const current = cfg.offenseTargetTokenIds;
    if (groupOn(group)) {
      const drop = new Set(group.map(canon));
      set("offenseTargetTokenIds", current.filter((id) => !drop.has(canon(id))));
    } else {
      const have = new Set(current.map(canon));
      set("offenseTargetTokenIds", [...current, ...group.filter((id) => !have.has(canon(id)))]);
    }
  };

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
      <label className="check">
        <input
          type="checkbox"
          checked={cfg.auditWhileBehind}
          onChange={chk("auditWhileBehind")}
          disabled={!cfg.offenseEnabled || !cfg.autoAudit}
        />
        Let a citizen that is behind still audit
        <span className="hint" style={{ display: "block" }}>
          The contract allows it — verified on chain, where a citizen two epochs behind with its
          own payment dead still audited successfully. Off, a single-citizen holder loses its
          audit on every epoch it owes a payment. A citizen already <b>under audit</b> is
          excluded either way.
        </span>
      </label>
      {/* The two mid-epoch sweep settings. Both are about spending audit capacity that
          would otherwise expire unused at the next boundary — capacity resets per epoch,
          and a rival can only become LESS auditable as an epoch runs, so a slot held back
          is a slot spent on nobody. Boundary audits and kills are unaffected by either. */}
      <label className="check">
        <input
          type="checkbox"
          checked={cfg.sweepUnpinned}
          onChange={chk("sweepUnpinned")}
          disabled={!cfg.offenseEnabled || !cfg.autoAudit}
        />
        Sweep beyond the target list — audit any auditable rival
        <span className="hint" style={{ display: "block" }}>
          Mid-epoch only, and only after every pinned target has been served. Allies and
          emigrants are still excluded, and kills stay limited to the list below.
        </span>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={cfg.sweepNormalGas}
          onChange={chk("sweepNormalGas")}
          disabled={!cfg.offenseEnabled || !cfg.autoAudit}
        />
        Mid-epoch audits at normal gas (~17x cheaper)
        <span className="hint" style={{ display: "block" }}>
          A mid-epoch audit races nobody, and if a rival does cure first the revert refunds
          both the fee and the audit slot — so a lost one costs only gas. Boundary audits keep
          the offense tip, as does the last few minutes before a boundary.
        </span>
      </label>
      {/* Thor Mode and the two flags it subsumes.
          Rendered together because they answer one question — how much of your offense the
          public mempool gets to see before the boundary block is built — and because Thor
          Mode WRITES the others. The three it forces are shown ticked-off and disabled, so
          the panel never displays a value the engine is not using (the same rule the
          fused/split badge follows). */}
      <div className="muted" style={{ fontSize: 11, marginTop: 10, marginBottom: 6 }}>
        MEMPOOL PRIVACY
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={cfg.thorMode}
          onChange={chk("thorMode")}
          disabled={!cfg.offenseEnabled}
        />
        <b>Thor Mode</b> — a fully private, fully split boundary
        <span className="hint" style={{ display: "block" }}>
          One switch for the case where a defender is watching: it forces the five settings
          below, plus the mid-epoch offense mempool race (which has no switch of its own), so
          nothing at all is broadcast before a block is built.
          <b>This now includes payments.</b> That is the part with teeth: a payment that only
          exists in a bundle does not land on the ~9% of boundaries built by a solo validator,
          and an unpaid citizen is auditable for a day. Every other flag here risks an
          opportunity; this one risks a citizen. Against an undefended board it is a straight
          loss. Turning it back off leaves the six settings where it put them.
        </span>
      </label>
      {/* Collapsed by default — five switches with five paragraphs of hint buried the rest of
          the panel, and on an ordinary night none of them is touched.

          The one rule this must not break is the panel's own: never hide a value the engine is
          using. So the summary line below reports the live state of all five whether or not the
          section is open, and it reads them from `cfg` — which is already the EFFECTIVE config,
          since applyThorMode folds the overrides in on load and save. Collapsing changes what
          you have to scroll past, never what you can find out. */}
      <button
        type="button"
        onClick={() => setPrivacyOpen((v) => !v)}
        className="hint"
        style={{
          display: "block", width: "100%", textAlign: "left", background: "none",
          border: "none", padding: "2px 0 2px 18px", cursor: "pointer", font: "inherit",
        }}
        aria-expanded={privacyOpen}
      >
        <span style={{ opacity: 0.7 }}>{privacyOpen ? "▾" : "▸"}</span>{" "}
        {cfg.thorMode ? "Forced by Thor Mode" : "Individual switches"} —{" "}
        <span style={{ opacity: 0.7 }}>{privacySummary}</span>
      </button>
      {/* Deliberately still rendered while forced, rather than hidden: an operator needs to
          see WHAT Thor Mode did, and needs the individual switches back when it is off. */}
      <div hidden={!privacyOpen} style={{ paddingLeft: 18, opacity: cfg.thorMode ? 0.65 : 1 }}>
        <label className="check">
          <input
            type="checkbox"
            checked={cfg.mirrorAudits}
            onChange={chk("mirrorAudits")}
            disabled={!cfg.offenseEnabled || !cfg.autoAudit || cfg.thorMode}
          />
          Also send pre-boundary audits to the public mempool
          <span className="hint" style={{ display: "block" }}>
            On, the mempool copy is the only thing that can land in a boundary block built by a
            solo validator (~1 in 10). It also announces which rivals you are about to audit,
            seconds before the block is built — four boundaries running, the contested target
            cured inside the block, once at tx index 0 on a 10 gwei tip.
          </span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={cfg.auditBundleAllOrNothing}
            onChange={chk("auditBundleAllOrNothing")}
            disabled={!cfg.offenseEnabled || !cfg.autoAudit || cfg.thorMode}
          />
          Drop the audit bundle rather than pay for a reverting audit
          <span className="hint" style={{ display: "block" }}>
            A reverted audit costs gas <i>and</i> makes the block more profitable for the
            builder that ordered you last. On, a doomed audit is free. The cost is coarseness:
            one target curing inside the boundary block takes the audits that would have
            succeeded with it, and a cure inside the block cannot be simulated in advance.
            Only ever applies to a <b>split</b> boundary, where audits have their own bundle —
            fused with a payment they stay revert-tolerant so they can never drop it.
          </span>
        </label>
        {/* The payment pair. Deliberately last and deliberately labelled as the dangerous
            half: every switch above trades an audit, these two trade a citizen. */}
        <label className="check">
          <input
            type="checkbox"
            checked={cfg.mirrorPayments}
            onChange={chk("mirrorPayments")}
            disabled={cfg.thorMode}
          />
          Also send pre-boundary payments to the public mempool
          <span className="hint" style={{ display: "block" }}>
            <b>Leave this on unless you know why you are turning it off.</b> The mempool copy
            is the only thing that can land a payment in a boundary block built by a solo
            validator (~1 in 10), and a payment that does not land leaves that citizen
            auditable for a day. Unlike an audit, a pending payment gives nothing away — the
            delinquency it answers is already on-chain. Only the boundary race is affected;
            manual, JIT and proactive payments mirror either way.
          </span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={cfg.paymentBundleAllOrNothing}
            onChange={chk("paymentBundleAllOrNothing")}
            disabled={cfg.thorMode || cfg.mirrorPayments}
          />
          Drop the payment bundle rather than pay for a reverting payment
          <span className="hint" style={{ display: "block" }}>
            Same economics as the audit version, worse failure mode: the thing dropped is
            mandatory, so one citizen reverting — already current, or audited earlier in the
            same block — takes every healthy sibling payment down with it.
            {cfg.mirrorPayments
              ? " Unavailable while payments mirror: the dropped bundle's transactions still reach the chain and still revert, so the gas is spent anyway."
              : " Active, because payments are no longer mirrored."}
          </span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={cfg.combinedBoundaryBundle}
            onChange={chk("combinedBoundaryBundle")}
            disabled={!cfg.offenseEnabled || cfg.thorMode}
          />
          Fuse the payment and audit bundles onto one coinbase bid
          <span className="hint" style={{ display: "block" }}>
            Off is two bundles with two independent bids, which is what the two bid fields in
            the JIT panel imply. On, and with any bid funded, they become one bundle on one bid
            and the audit bid never fires. The JIT panel's fused/split badge shows which you
            are actually running.
          </span>
        </label>
      </div>
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
        {/* Groups TOGGLE and combine — lit when every id in the group is selected.
            Each is additive, so "skippers + non-skippers" is two clicks instead of
            re-typing a list by hand. The roster is split per operator because they are
            not one decision: they defend differently and only one of them attacks. */}
        <GroupToggle label="Rival Skippers" ids={skippers} on={groupOn(skippers)} onClick={toggleGroup} disabled={!cfg.offenseEnabled}
          title="Rivals that pay on a ~2-epoch cadence, so they are delinquent at every second boundary." />
        <GroupToggle label="Non-skippers" ids={nonSkippers} on={groupOn(nonSkippers)} onClick={toggleGroup} disabled={!cfg.offenseEnabled}
          title="The curated rivals that are NOT ~2-epoch skippers (the default list minus Rival Skippers)." />
        {Object.keys(bigBoysByOperator).sort().map((op) => (
          <GroupToggle
            key={op}
            label={op}
            ids={bigBoysByOperator[op]!}
            on={groupOn(bigBoysByOperator[op]!)}
            onClick={toggleGroup}
            disabled={!cfg.offenseEnabled}
            title={`Big-boy operator "${op}" (data/big-boys.json). Pins every citizen they run, for a coordinated push against that operator specifically. Several defend at the top of the boundary block — check Analyze targets for what beating them costs.`}
          />
        ))}
        <button
          type="button"
          onClick={() => set("offenseTargetTokenIds", [])}
          disabled={!cfg.offenseEnabled || cfg.offenseTargetTokenIds.length === 0}
          style={{ padding: "3px 12px", borderRadius: 6, border: "1px solid #555", fontSize: 12 }}
          title="Clear the list. Blank = target every delinquent rival the bot discovers."
        >
          Clear
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
          value={targetsDraft}
          onChange={(e) => {
            setTargetsDraft(e.target.value);
            set("offenseTargetTokenIds", parseTokenIds(e.target.value));
          }}
          disabled={!cfg.offenseEnabled}
          placeholder={"42\n137\n501"}
        />
        <span className="muted" style={{ fontSize: 11 }}>
          {cfg.offenseTargetTokenIds.length} token{cfg.offenseTargetTokenIds.length !== 1 ? "s" : ""}
        </span>
      </label>

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
