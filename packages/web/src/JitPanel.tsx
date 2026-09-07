import { useEffect, useState } from "react";
import type { BotStatus, OwnedTokenStatus, StrategyConfig } from "@dat-bot/shared";
import { EPOCH_DURATION_SECONDS, BASE_TAX_RATE_WEI, boundaryBundleMode, boundaryDensitiesGwei } from "@dat-bot/shared";
import { api } from "./api.js";
import { countdown, weiToEth } from "./util.js";

// Payment fields this panel owns — used to light up "Save payment settings" only
// when one of these has unsaved edits (independent of the Strategy panel's fields).
const PAYMENT_FIELDS: (keyof StrategyConfig)[] = [
  "maxBaseFeeGwei", "priorityFeeGwei", "dynamicTipEnabled", "dynamicTipMaxGwei",
  "separateOffenseGas", "offenseMaxBaseFeeGwei", "offensePriorityFeeGwei",
  "offenseDynamicTipEnabled", "offenseDynamicTipMaxGwei",
  "preBoundaryPay", "preBoundaryLeadMs", "preBoundaryLeadMainnetMs",
  "maxAutoPayEpochs", "coinbaseBidEth", "coinbaseBidAuditOnlyEth",
  "coinbasePayerAddress", "combinedBoundaryBundle",
  // Mirrored from the Strategy panel (see the Offense Gas column). Listed here so this
  // Save lights up for it; the Strategy panel lists it too, so either Save persists it.
  "offenseEnabled",
];

export function JitPanel({
  status,
  tokens,
  config,
  savedConfig,
  onConfigChange,
  onConfigSaved,
}: {
  status: BotStatus | null;
  tokens: OwnedTokenStatus[];
  config: StrategyConfig | null;
  savedConfig: StrategyConfig | null;
  onConfigChange: (c: StrategyConfig) => void;
  onConfigSaved: (c: StrategyConfig) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, setNowTick] = useState(0);
  const [excludeBusy, setExcludeBusy] = useState<string | null>(null);

  // A citizen is "selected" (the bot may pay it) unless it's on the persisted exclusion
  // list. Derived from config rather than held in local state: the old local-only
  // Set defaulted to all-checked and silently reset to all whenever the owned-token
  // list changed or the page reloaded, so an unchecked citizen could quietly become
  // checked again.
  const excluded = new Set(config?.excludedTokenIds ?? []);
  const selected = new Set(tokens.map((t) => t.tokenId).filter((id) => !excluded.has(id)));

  // 1s clock so the countdown updates.
  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const currentEpoch = status?.currentEpoch ? Number(status.currentEpoch) : null;
  const startTime = status?.startTime ? Number(status.startTime) : null;
  const armed = status?.jitEnabled ?? false;
  const armedEpoch = status?.jitTargetEpoch ?? null;

  const targetEpoch = armed && armedEpoch !== null ? armedEpoch : currentEpoch !== null ? currentEpoch + 1 : null;

  const epochDur = Number(EPOCH_DURATION_SECONDS);
  const targetStart =
    startTime !== null && targetEpoch !== null ? startTime + (targetEpoch - 1) * epochDur : null;
  const secondsToTarget = targetStart !== null ? targetStart - Math.floor(Date.now() / 1000) : null;

  const nSelected = selected.size;
  const perTokenWei =
    targetEpoch !== null ? (BigInt(targetEpoch) * BASE_TAX_RATE_WEI).toString() : "0";
  const totalWei =
    targetEpoch !== null ? (BigInt(targetEpoch) * BASE_TAX_RATE_WEI * BigInt(nSelected)).toString() : "0";

  // Persist immediately. This is a standing instruction about real money, so it must
  // not depend on the user remembering to press a save button, and must survive reloads.
  const toggleToken = async (id: string) => {
    if (!config) return;
    const next = new Set(config.excludedTokenIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExcludeBusy(id);
    setErr(null);
    try {
      const saved = await api.setConfig({ excludedTokenIds: [...next] });
      onConfigSaved(saved);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setExcludeBusy(null);
    }
  };

  const arm = async () => {
    setErr(null);
    setBusy(true);
    try {
      const tokenIds = nSelected === tokens.length ? [] : [...selected];
      await api.jit({ enable: true, tokenIds });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disarm = async () => {
    setBusy(true);
    try {
      await api.jit({ enable: false });
    } finally {
      setBusy(false);
    }
  };

  // --- Payment gas (used by every tax payment, incl. the boundary-timed JIT pay) ---
  const [gasBusy, setGasBusy] = useState(false);
  const [gasErr, setGasErr] = useState<string | null>(null);
  const gasField = (k: keyof StrategyConfig, v: number | boolean | string) => {
    if (!config) return;
    onConfigChange({ ...config, [k]: v });
  };
  // True when any payment-owned field differs from what's persisted on the backend.
  const gasDirty =
    !!(config && savedConfig) &&
    PAYMENT_FIELDS.some((k) => JSON.stringify(config[k]) !== JSON.stringify(savedConfig[k]));
  const saveGas = async () => {
    if (!config) return;
    setGasBusy(true);
    setGasErr(null);
    try {
      const next = await api.setConfig({
        maxBaseFeeGwei: config.maxBaseFeeGwei,
        priorityFeeGwei: config.priorityFeeGwei,
        dynamicTipEnabled: config.dynamicTipEnabled,
        dynamicTipMaxGwei: config.dynamicTipMaxGwei,
        separateOffenseGas: config.separateOffenseGas,
        offenseMaxBaseFeeGwei: config.offenseMaxBaseFeeGwei,
        offensePriorityFeeGwei: config.offensePriorityFeeGwei,
        offenseDynamicTipEnabled: config.offenseDynamicTipEnabled,
        offenseDynamicTipMaxGwei: config.offenseDynamicTipMaxGwei,
        preBoundaryPay: config.preBoundaryPay,
        preBoundaryLeadMs: config.preBoundaryLeadMs,
        preBoundaryLeadMainnetMs: config.preBoundaryLeadMainnetMs,
        maxAutoPayEpochs: config.maxAutoPayEpochs,
        coinbaseBidEth: config.coinbaseBidEth,
        coinbaseBidAuditOnlyEth: config.coinbaseBidAuditOnlyEth,
        coinbasePayerAddress: config.coinbasePayerAddress,
        combinedBoundaryBundle: config.combinedBoundaryBundle,
        offenseEnabled: config.offenseEnabled,
      });
      onConfigSaved(next);
    } catch (e) {
      setGasErr((e as Error).message);
    } finally {
      setGasBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>Just-in-time epoch payment</h2>
      <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
        Pay a <b>single</b> upcoming epoch for selected citizens the instant it
        begins on-chain — before they can be audited — then auto-disarm.
      </p>

      <div className="row wrap" style={{ gap: 24, marginBottom: 12 }}>
        <div className="stat"><span className="label">Target epoch</span><span className="value">{targetEpoch ?? "—"}</span></div>
        <div className="stat"><span className="label">Begins in</span><span className="value">{countdown(secondsToTarget, true)}</span></div>
        <div className="stat"><span className="label">Selected</span><span className="value">{nSelected} / {tokens.length}</span></div>
        <div className="stat"><span className="label">Est. per token</span><span className="value">{weiToEth(perTokenWei, 5)} ETH</span></div>
        <div className="stat"><span className="label">Est. total</span><span className="value">{weiToEth(totalWei, 5)} ETH</span></div>
      </div>

      {tokens.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
            CITIZENS THE BOT MAY PAY
          </div>
          <p className="muted" style={{ fontSize: 11, margin: "0 0 6px 0", lineHeight: 1.5 }}>
            Unchecking a citizen stops <b>every</b> automatic payment for it — JIT and
            proactive. Saved immediately; survives reloads. An unchecked citizen will go
            delinquent, can be audited, and can eventually be <b>killed</b>: nothing automatic
            will rescue it (there is no auto-pay after an audit for <i>any</i> citizen). Pay it
            yourself from the token row when you choose to.
          </p>
          <p className="muted" style={{ fontSize: 11, margin: "0 0 6px 0", lineHeight: 1.5 }}>
            This is a <b>payment</b> opt-out only — an unchecked citizen <b>still audits rivals</b>
            up to its full audit capacity. It stops being a usable auditor on its own once it
            falls 2+ epochs behind, since the game forbids an auditable token from auditing.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {tokens.map((t) => {
              const on = selected.has(t.tokenId);
              // State from the same on-chain fields the token table uses.
              const behind = Number(BigInt(t.currentEpoch) - BigInt(t.lastEpochPaid));
              const underAudit = t.auditDueTimestamp !== "0";
              const killable = underAudit && (t.secondsUntilKillable ?? 1) <= 0;
              // Matches classifyRisk: only 2+ behind is "delinquent" (auditable); 1 behind
              // is still in the grace epoch and not yet auditable.
              const state = killable
                ? { label: "killable", color: "var(--red)" }
                : underAudit
                  ? { label: "under audit", color: "var(--red)" }
                  : behind <= 0
                    ? { label: "current", color: "var(--green)" }
                    : behind === 1
                      ? { label: "1 behind (grace)", color: "var(--amber)" }
                      : { label: `delinquent · ${behind} behind`, color: "var(--amber)" };
              return (
              <label
                key={t.tokenId}
                title={on
                  ? `#${t.tokenId} — ${state.label}. Covered by automatic payments.`
                  : `#${t.tokenId} — ${state.label}. EXCLUDED — the bot will never pay it.`}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "4px 10px", borderRadius: 6,
                  cursor: excludeBusy ? "wait" : "pointer",
                  opacity: excludeBusy === t.tokenId ? 0.5 : 1,
                  border: `1px solid ${on ? "var(--accent)" : "var(--red)"}`,
                  background: on ? "rgba(91,157,255,0.1)" : "rgba(255,92,92,0.08)",
                  fontSize: 12, fontFamily: "monospace",
                }}
              >
                <input
                  type="checkbox"
                  style={{ width: "auto" }}
                  checked={on}
                  onChange={() => void toggleToken(t.tokenId)}
                  disabled={excludeBusy !== null}
                />
                <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.25 }}>
                  <span>#{t.tokenId}</span>
                  <span style={{ fontSize: 10, color: state.color, fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
                    {state.label}
                  </span>
                </span>
              </label>
              );
            })}
          </div>
        </div>
      )}

      {armed ? (
        <div className="row wrap" style={{ gap: 10 }}>
          <span className="badge warn">ARMED · epoch {armedEpoch}</span>
          <button className="danger" onClick={disarm} disabled={busy}>Disarm</button>
        </div>
      ) : (
        <button
          className="primary"
          onClick={arm}
          disabled={busy || targetEpoch === null || nSelected === 0}
        >
          {busy ? "Arming…" : `Arm payment for epoch ${targetEpoch ?? "…"}`}
        </button>
      )}

      {config && (
        <div style={{ marginTop: 16, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          {/* AUTO-PAY LIMIT (maxAutoPayEpochs) is intentionally not rendered — the
              default of 1 is the value you want and there's little reason to change it:
              it caps a single automatic payment at one day's tax, and a payment that
              would cost more is skipped rather than trimmed (the contract force-settles
              every delinquent epoch, so a citizen 2 behind is quoted 2x even for a
              1-epoch request). It still applies and stays editable in data/config.json. */}

          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>GAS</div>
          <p className="muted" style={{ fontSize: 11, margin: "0 0 10px 0", lineHeight: 1.5 }}>
            Payment and offense priced side by side, for the same reason the coinbase bids are:
            they compete for the same boundary block but are not the same decision. A payment
            <b> must land</b> — missing it can cost a citizen. An audit is speculative, and
            losing one costs gas only, since a revert refunds both the fee and the audit slot.
          </p>
          {/* Two columns, colour-matched to the bid split below, so each side reads as one
              decision rather than a list of four numbers. Worth keeping visually adjacent:
              when both halves ride ONE bundle (a coinbase bid is set), builders rank it on the
              BLENDED density, so a far-lower audit tip drags the payment's placement down with
              it — measured at the epoch-182 boundary, where a 10 gwei audit cut a 201 gwei
              payment's bundle from 263 to 160 gwei/gas. */}
          <div className="row wrap" style={{ gap: 12, alignItems: "stretch", marginBottom: 6 }}>
            <div style={{ flex: "1 1 220px", borderLeft: "3px solid var(--accent)", paddingLeft: 10 }}>
              <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 12, marginBottom: 4 }}>
                Payment Gas
              </div>
              <label className="field" style={{ marginBottom: 4 }}>
                Priority fee / tip (gwei)
                <input
                  type="number" min={0} step={0.1}
                  value={config.priorityFeeGwei}
                  onChange={(e) => gasField("priorityFeeGwei", Number(e.target.value))}
                  style={{ borderColor: "var(--accent)", fontWeight: 600 }}
                />
              </label>
              {/* Dynamic tip sits directly under the static tip it modifies, and above the base
                  fee cap. The two tip fields are one decision — the static tip is a floor and
                  the dynamic max is its ceiling — so reading them apart invited setting the max
                  below the floor, which does nothing (the warning below exists for exactly that
                  mistake). The base-fee cap is a separate guardrail and now reads as one. */}
              <label className="check" style={{ marginBottom: 2 }}>
                <input
                  type="checkbox"
                  checked={config.dynamicTipEnabled}
                  onChange={(e) => gasField("dynamicTipEnabled", e.target.checked)}
                />
                Dynamic tip (scale with block fullness)
              </label>
              <label className="field" style={{ marginLeft: 24, marginBottom: 4 }}>
                Max dynamic tip (gwei)
                <input
                  type="number" min={0} step={1}
                  value={config.dynamicTipMaxGwei}
                  onChange={(e) => gasField("dynamicTipMaxGwei", Number(e.target.value))}
                  disabled={!config.dynamicTipEnabled}
                />
                {config.dynamicTipEnabled && config.dynamicTipMaxGwei < config.priorityFeeGwei && (
                  <span className="hint">
                    Below the static tip, so it does nothing — the static tip is a floor and is
                    never lowered. Set it above {config.priorityFeeGwei} to have any effect.
                  </span>
                )}
              </label>
              <label className="field" style={{ marginBottom: 0 }}>
                Max base fee (gwei)
                <input
                  type="number" min={0}
                  value={config.maxBaseFeeGwei}
                  onChange={(e) => gasField("maxBaseFeeGwei", Number(e.target.value))}
                />
              </label>
            </div>
            <div style={{ flex: "1 1 220px", borderLeft: "3px solid var(--green)", paddingLeft: 10 }}>
              <div style={{ color: "var(--green)", fontWeight: 600, fontSize: 12, marginBottom: 4 }}>
                Offense Gas (audit / kill)
              </div>
              {/* The SAME `offenseEnabled` field the Strategy panel owns, mirrored here rather
                  than moved. It is the master switch for everything in this column, and tuning
                  an audit tip that offense will never spend is the kind of mistake that only
                  shows up as a boundary where nothing happened.

                  Deliberately OUTSIDE the dimmed wrapper below: it is the one control that has
                  to stay live when offense is off, or the column would have no way back on.

                  Both panels write the same key, so toggling either updates both, and whichever
                  Save is pressed persists it — offenseEnabled is in this panel's PAYMENT_FIELDS
                  and payload as well as the Strategy panel's. */}
              <label className="check" style={{ marginBottom: 2 }}>
                <input
                  type="checkbox"
                  checked={config.offenseEnabled}
                  onChange={(e) => gasField("offenseEnabled", e.target.checked)}
                />
                <b>Enable offense</b>
              </label>
              <div style={{ opacity: config.offenseEnabled ? 1 : 0.45 }}>
              {!config.offenseEnabled && (
                <p className="hint" style={{ margin: "0 0 4px 0" }}>
                  Offense is off, so none of this is spent — no audits or kills are sent at all.
                </p>
              )}
              <label className="check" style={{ marginBottom: 2 }}>
                <input
                  type="checkbox"
                  checked={config.separateOffenseGas}
                  onChange={(e) => gasField("separateOffenseGas", e.target.checked)}
                  disabled={!config.offenseEnabled}
                />
                Price offense separately
              </label>
              {/* Nested inside the offence dim: these four are exactly what resolveGas swaps
                  when the split is on, so with it off they are the payment column's numbers
                  and nothing here is read. They were already disabled; dimming them says the
                  same thing at a glance instead of only on click.

                  The Audit Coinbase Bid is deliberately NOT dimmed with this. separateOffenseGas
                  selects tip and base-fee only — the audit bundle still carries
                  coinbaseBidAuditOnlyEth either way, so greying it here would claim it is inert
                  when it is still being spent. */}
              {/* Defers when the offence dim above is already applied: CSS opacity nests
                  multiplicatively, so 0.45 x 0.5 would put these at ~22% and make "off" read
                  as "broken". Only one dim is ever in effect. */}
              <div style={{
                opacity: !config.offenseEnabled || config.separateOffenseGas ? 1 : 0.5,
              }}>
              <label className="field" style={{ marginBottom: 4 }}>
                Priority fee / tip (gwei)
                <input
                  type="number" min={0} step={0.1}
                  value={config.offensePriorityFeeGwei}
                  onChange={(e) => gasField("offensePriorityFeeGwei", Number(e.target.value))}
                  disabled={!config.separateOffenseGas || !config.offenseEnabled}
                  style={config.separateOffenseGas ? { borderColor: "var(--green)", fontWeight: 600 } : undefined}
                />
                {!config.separateOffenseGas && (
                  <span className="hint">Off: audits and kills use the payment tip on the left.</span>
                )}
              </label>
              {/* Same order as the payment column — the two are read side by side, so a field
                  in a different row on each side is worse than either arrangement. */}
              <label className="check" style={{ marginBottom: 2 }}>
                <input
                  type="checkbox"
                  checked={config.offenseDynamicTipEnabled}
                  onChange={(e) => gasField("offenseDynamicTipEnabled", e.target.checked)}
                  disabled={!config.separateOffenseGas || !config.offenseEnabled}
                />
                Dynamic tip (scale with block fullness)
              </label>
              <label className="field" style={{ marginLeft: 24, marginBottom: 4 }}>
                Max dynamic tip (gwei)
                <input
                  type="number" min={0} step={1}
                  value={config.offenseDynamicTipMaxGwei}
                  onChange={(e) => gasField("offenseDynamicTipMaxGwei", Number(e.target.value))}
                  disabled={!config.separateOffenseGas || !config.offenseDynamicTipEnabled || !config.offenseEnabled}
                />
                {config.separateOffenseGas && config.offenseDynamicTipEnabled
                  && config.offenseDynamicTipMaxGwei < config.offensePriorityFeeGwei && (
                  <span className="hint">
                    Below the static tip, so it does nothing. Set it above{" "}
                    {config.offensePriorityFeeGwei} to have any effect.
                  </span>
                )}
              </label>
              <label className="field" style={{ marginBottom: 0 }}>
                Max base fee (gwei)
                <input
                  type="number" min={0}
                  value={config.offenseMaxBaseFeeGwei}
                  onChange={(e) => gasField("offenseMaxBaseFeeGwei", Number(e.target.value))}
                  disabled={!config.separateOffenseGas || !config.offenseEnabled}
                />
              </label>
              </div>
              </div>
            </div>
          </div>
          {/* "Race into the boundary block" (preBoundaryPay + lead times) is
              intentionally not rendered — it's ON by default so the armed JIT payment can
              land in the first block of the epoch ahead of a batch-auditor, and we don't
              want it toggled off by accident. Still editable in data/config.json. */}

          <div
            style={{
              marginTop: 12, paddingTop: 10,
              borderTop: "1px solid var(--border)",
              ...(config.coinbaseBidEth > 0 || config.coinbaseBidAuditOnlyEth > 0
                ? {
                    borderLeft: "3px solid var(--accent)",
                    background: "rgba(91,157,255,0.08)",
                    paddingLeft: 10, marginLeft: -10, borderRadius: 6,
                  }
                : {}),
            }}
          >
            <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
              ⚠ COINBASE BID (advanced, mainnet)
              {config.coinbaseBidEth > 0 && (
                <span className="badge" style={{ marginLeft: 8, background: "var(--accent)", color: "#fff", fontSize: 10 }}>
                  PAYMENT · {config.coinbaseBidEth} ETH
                </span>
              )}
              {config.coinbaseBidAuditOnlyEth > 0 && (
                <span className="badge" style={{ marginLeft: 6, background: "var(--green)", color: "#04231a", fontSize: 10 }}>
                  AUDIT · {config.coinbaseBidAuditOnlyEth} ETH
                </span>
              )}
              {/* Which shape the boundary fire will ACTUALLY take.
                  Rendered because the two settings that decide it — combinedBoundaryBundle and
                  a funded bid — are not adjacent, and reading the mode off them has caught
                  operators out twice. A "Payment" bid field beside an "Audit" bid field implies
                  two bundles; with fusion on there is ONE bundle and the audit bid never fires.
                  Derived from the SHARED predicate the engine itself uses, so the badge cannot
                  drift from the behaviour. */}
              <span
                className="badge"
                title={
                  boundaryBundleMode(config) === "fused"
                    ? "One atomic bundle: payments, audits and a single Payment bid go out together. The audit is valid immediately because its nonces sit inside the same bundle. Cost: builders rank a bundle on BLENDED density, so a cheaper audit tip — and the audit's ~130k gas — drag the payment's placement down with them."
                    : "Two independent bundles, each with its own tip and its own bid. No dilution. The audit bundle holds nonces above the still-unmined payment, so it lands only if the builder also took the payment bundle and placed it first — which is what a value-sorting builder does anyway, since the payment bundle is the denser one."
                }
                style={{
                  marginLeft: 8,
                  background: "transparent",
                  border: "1px solid",
                  borderColor: boundaryBundleMode(config) === "fused" ? "var(--accent)" : "var(--green)",
                  color: boundaryBundleMode(config) === "fused" ? "var(--accent)" : "var(--green)",
                  fontSize: 10,
                  cursor: "help",
                }}
              >
                {boundaryBundleMode(config) === "fused"
                  ? "FUSED · 1 bundle, 1 bid"
                  : "SPLIT · 2 bundles, 2 bids"}
              </span>
            </div>
            {/* Density inversion warning — SPLIT mode only.
                In split mode the audit bundle holds nonces above the still-unmined payment, so a
                builder can only include it after the payment bundle. Builders try candidates in
                value order, so the arrangement works while the PAYMENT bundle is the denser one.
                Inverted, the builder reaches for the audit first, finds its nonce two above the
                account and discards it as unexecutable.

                Sized on the operator's ACTUAL shape: each extra payment adds 82,875 gas to the
                payment bundle and thins its bid, so a five-citizen holder can be inverted where a
                one-citizen holder is not. */}
            {(() => {
              if (boundaryBundleMode(config) !== "split") return null;
              const behind = tokens.filter(
                (t) => BigInt(t.lastEpochPaid) < BigInt(t.currentEpoch),
              ).length;
              const capacity = tokens.reduce((n, t) => n + (t.auditLimit ?? 1), 0);
              const d = boundaryDensitiesGwei(config, {
                payments: Math.max(1, behind),
                audits: Math.max(1, capacity),
              });
              if (d.paymentDenser) return null;
              return (
                <p
                  className="err"
                  style={{ fontSize: 11, margin: "0 0 8px 0", lineHeight: 1.5, fontWeight: 600 }}
                >
                  Audit bundle is denser than the payment bundle ({d.audit.toFixed(0)} vs{" "}
                  {d.payment.toFixed(0)} gwei/gas). In split mode the audit sits on nonces above
                  the unmined payment, so builders must take the payment bundle first — and they
                  order by value. Inverted like this, a builder reaches for the audit bundle,
                  finds a nonce gap and drops it. Lower the Audit Coinbase Bid or the audit tip,
                  or raise the payment side, until the payment is denser.
                </p>
              );
            })()}
            <p className="muted" style={{ fontSize: 11, margin: "0 0 8px 0", lineHeight: 1.5 }}>
              A <b>flat payment straight to the block builder</b> added to the pre-boundary payment bundle,
              to bid it to the <b>top of the boundary block</b> — independent of tip. This is the lever
              sophisticated batch-auditors use to guarantee position. <b>Default 0 (off).</b> It only spends
              if the bundle wins the slot (it rides the bundle, allowed-to-revert), and never mirrors to the
              mempool. It forwards through the shared, on-chain-verified <code>CoinbasePayer</code> contract.
            </p>
            {/* Two bids, because the two boundaries are not the same purchase. Shown
                side by side with their own colours so the split is legible at a glance
                rather than reading as one setting duplicated. */}
            <div className="row wrap" style={{ gap: 12, alignItems: "stretch", marginBottom: 10 }}>
              <div style={{ flex: "1 1 220px", borderLeft: "3px solid var(--accent)", paddingLeft: 10 }}>
                <label className="field" style={{ marginBottom: 4 }}>
                  <span style={{ color: "var(--accent)", fontWeight: 600 }}>Payment Coinbase Bid</span>{" "}
                  (ETH)
                  <input
                    type="number" min={0} step={0.001}
                    value={config.coinbaseBidEth}
                    onChange={(e) => gasField("coinbaseBidEth", Math.max(0, Number(e.target.value) || 0))}
                    style={config.coinbaseBidEth > 0 ? { borderColor: "var(--accent)", fontWeight: 600 } : undefined}
                  />
                </label>
                <p className="muted" style={{ fontSize: 10, margin: 0, lineHeight: 1.45 }}>
                  Any boundary where a payment is armed — <b>your audits ride the same bundle
                  on this bid</b>, not the one on the right. <b>Defensive: it must land</b>,
                  missing it can cost a citizen. It is also the bigger bundle (each payment
                  adds ~82,875 gas on top of the audits), so the same position costs more.
                  Bid high here.
                </p>
              </div>
              {/* Dimmed with offense, because every path that could spend this bid is gated on
                  offenseEnabled: firePreBoundaryAudit and firePreBoundaryKill both return early
                  without it, and the fused fire only selects the audit bid when no payment was
                  queued — which then requires an audit to have been queued, and none is. So
                  with offense off this is unspendable, and a funded field that cannot be spent
                  reads as money at risk. */}
              <div style={{
                flex: "1 1 220px", borderLeft: "3px solid var(--green)", paddingLeft: 10,
                opacity: config.offenseEnabled ? 1 : 0.45,
              }}>
                <label className="field" style={{ marginBottom: 4 }}>
                  <span style={{ color: "var(--green)", fontWeight: 600 }}>Audit Coinbase Bid</span> (ETH)
                  <input
                    type="number" min={0} step={0.001}
                    value={config.coinbaseBidAuditOnlyEth}
                    onChange={(e) => gasField("coinbaseBidAuditOnlyEth", Math.max(0, Number(e.target.value) || 0))}
                    disabled={!config.offenseEnabled}
                    style={config.coinbaseBidAuditOnlyEth > 0 && config.offenseEnabled
                      ? { borderColor: "var(--green)", fontWeight: 600 } : undefined}
                  />
                </label>
                <p className="muted" style={{ fontSize: 10, margin: 0, lineHeight: 1.45 }}>
                  {!config.offenseEnabled ? (
                    <>
                      Offense is off, so this can never be spent — no audit or kill bundle is
                      built to carry it. Enable offense to use it.
                    </>
                  ) : (
                    <>
                      Only when <em>nothing is owed</em> and the bundle is audits alone.{" "}
                      <b>Speculative — losing costs the audit fee only</b>, and the bundle is far
                      smaller, so a given position is cheaper. Most epochs are these.
                      0 = don&apos;t bid on them.
                    </>
                  )}
                </p>
              </div>
            </div>
            <div className="row wrap" style={{ gap: 12, alignItems: "flex-end" }}>
              <label className="field" style={{ flex: "2 1 260px" }}>
                CoinbasePayer address (fixed)
                <input
                  type="text"
                  value={config.coinbasePayerAddress}
                  readOnly
                  title="Shared CoinbasePayer forwarder, verified on-chain to forward 100% to block.coinbase. Editable only via data/config.json."
                  style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, opacity: 0.7, cursor: "not-allowed" }}
                />
              </label>
            </div>
            {(config.coinbaseBidEth > 0 || config.coinbaseBidAuditOnlyEth > 0) && !/^0x[a-fA-F0-9]{40}$/.test(config.coinbasePayerAddress) && (
              <p className="err" style={{ fontSize: 11, margin: "4px 0 0 0" }}>
                No CoinbasePayer address configured, so the bid won't fire. Set it in data/config.json.
              </p>
            )}

            {/* No switch of its own: arming automatically IS what away mode means, so the
                away button is the single place it is turned on. Still described here,
                because this is the panel that decides what it will spend when it does. */}
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
              <div style={{ fontSize: 12 }}>
                <b>Away/Autonomous mode arms payments itself.</b>
              </div>
              <p className="muted" style={{ fontSize: 10, margin: "4px 0 0 0", lineHeight: 1.5 }}>
                While away mode is on, the engine notices a citizen would be auditable at the
                coming boundary, arms itself, and the bundle pays and audits together on the{" "}
                <span style={{ color: "var(--accent)" }}>Payment Coinbase Bid</span>. JIT then
                disarms itself as it always has, so quiet epochs fall back to offense on the{" "}
                <span style={{ color: "var(--green)" }}>Audit Coinbase Bid</span>.
                <br />
                <b>That spends ETH with no keypress</b>, so the bids above are the ceiling you
                are agreeing to each time you go away. It never arms for a citizen that is
                under audit — recovering an audited citizen stays a manual decision — nor for
                one you unchecked above. Running attended, arming stays a keypress.
              </p>
            </div>
          </div>

          {/* COMBINED BOUNDARY BUNDLE (combinedBoundaryBundle) is intentionally not
              rendered — it's ON by default and should stay on. It fuses the pre-boundary
              payment and audit into one bundle (sequential nonces) so they land
              consecutively top-of-block, share a single coinbase bid, and can't demote
              each other. It is self-guarding: it only fuses when a coinbase bid is set,
              and without one it's a no-op (separate bundles, so audits keep their mempool
              fallback). Payment is mempool-mirrored either way and is never dropped.
              Still editable in data/config.json. The status line below reports whether it
              is actually fusing, since that depends on the bid above. */}
          {config.combinedBoundaryBundle && config.coinbaseBidEth > 0 && (
            <p className="hint" style={{ fontSize: 11, margin: "8px 0 0 0", color: "var(--accent)" }}>
              Payment + audit will fuse into one atomic bundle, sharing this single {config.coinbaseBidEth} ETH bid.
            </p>
          )}

          <div className="save-bar" style={{ marginTop: 12 }}>
            <button
              className={`primary save-cta${gasDirty ? " unsaved" : ""}`}
              onClick={saveGas}
              disabled={gasBusy || !gasDirty}
            >
              {gasBusy ? "Saving…" : gasDirty ? "● Save payment settings" : "Save payment settings"}
            </button>
            {!gasBusy && (gasDirty
              ? <span className="unsaved-note">Unsaved changes — the bot pays with the last saved values until you save.</span>
              : <span className="saved-note">Saved ✓</span>)}
            {gasErr && <span className="err" style={{ fontSize: 12 }}>{gasErr}</span>}
          </div>
        </div>
      )}

      {tokens.length === 0 && (
        <p className="hint">
          {status?.nftConfigured
            ? "No owned citizens found for this wallet."
            : "No owned citizens detected yet — set your Alchemy key so the bot can find them."}
        </p>
      )}
      {err && <p className="err">{err}</p>}
    </div>
  );
}
