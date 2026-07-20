import { useEffect, useState } from "react";
import type { BotStatus, OwnedTokenStatus, StrategyConfig, StrategySnapshot } from "@dat-bot/shared";
import { EPOCH_DURATION_SECONDS, BASE_TAX_RATE_WEI } from "@dat-bot/shared";
import { ApiError, api, type BuilderIncentiveCapability } from "./api.js";
import { countdown, weiToEth } from "./util.js";

const CANONICAL_ETH = /^(0|[1-9]\d*)(\.\d{1,18})?$/;
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

function ethWei(value: string): bigint | null {
  if (!CANONICAL_ETH.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt((fraction + "0".repeat(18)).slice(0, 18));
}

type BuilderSettings = Pick<
  StrategyConfig,
  "coinbaseBidEnabled" | "coinbaseBidEth" | "coinbasePayerAddress" | "combinedBoundaryBundle"
>;

function builderSettings(config: StrategyConfig): BuilderSettings {
  return {
    coinbaseBidEnabled: config.coinbaseBidEnabled,
    coinbaseBidEth: config.coinbaseBidEth,
    coinbasePayerAddress: config.coinbasePayerAddress,
    combinedBoundaryBundle: config.combinedBoundaryBundle,
  };
}

function builderRiskIncreases(current: BuilderSettings, candidate: BuilderSettings): boolean {
  if (!current.coinbaseBidEnabled && candidate.coinbaseBidEnabled) return true;
  if (!candidate.coinbaseBidEnabled) return false;
  const oldBid = ethWei(current.coinbaseBidEth) ?? 0n;
  const newBid = ethWei(candidate.coinbaseBidEth) ?? 0n;
  return newBid > oldBid
    || candidate.coinbasePayerAddress !== current.coinbasePayerAddress
    || (!current.combinedBoundaryBundle && candidate.combinedBoundaryBundle);
}

export function JitPanel({
  status,
  tokens,
  strategy,
  onStrategyChange,
  onStatusChange,
  capabilityRefreshToken = 0,
}: {
  status: BotStatus | null;
  tokens: OwnedTokenStatus[];
  strategy: StrategySnapshot | null;
  onStrategyChange: (snapshot: StrategySnapshot) => void;
  onStatusChange: (status: BotStatus) => void;
  capabilityRefreshToken?: number;
}) {
  const config = strategy?.config ?? null;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, setNowTick] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [requestedTargetEpoch, setRequestedTargetEpoch] = useState<number | null>(null);
  const armed = status?.jitEnabled ?? false;
  const armedTokenIds = armed ? [...new Set(status?.jitTokenIds ?? [])] : [];
  const displayedSelection = armed ? new Set(armedTokenIds) : selected;

  // Local selection is only an unarmed draft. While armed, every display and
  // exposure calculation reads the authoritative campaign IDs directly.
  useEffect(() => {
    if (!armed) setSelected(new Set(tokens.map((t) => t.tokenId)));
  }, [tokens.map((t) => t.tokenId).join(","), armed, status?.jitRevision]);

  // 1s clock so the countdown updates.
  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const currentEpoch = status?.currentEpoch ? Number(status.currentEpoch) : null;
  const startTime = status?.startTime ? Number(status.startTime) : null;
  const armedEpoch = status?.jitTargetEpoch ?? null;

  // The server requires an explicit epoch. Seed the form with the next epoch,
  // but keep it editable so the operator can intentionally schedule farther
  // ahead. An armed campaign always renders its authoritative persisted target.
  useEffect(() => {
    setRequestedTargetEpoch(
      armed && armedEpoch !== null
        ? armedEpoch
        : currentEpoch !== null
          ? currentEpoch + 1
          : null,
    );
  }, [armed, armedEpoch, currentEpoch, status?.jitRevision]);

  const targetEpoch = armed ? armedEpoch : requestedTargetEpoch;

  const epochDur = Number(EPOCH_DURATION_SECONDS);
  const targetStart =
    startTime !== null && targetEpoch !== null ? startTime + (targetEpoch - 1) * epochDur : null;
  const secondsToTarget = targetStart !== null ? targetStart - Math.floor(Date.now() / 1000) : null;

  const nSelected = displayedSelection.size;
  const refreshAuthoritative = async () => {
    const [freshStatus, freshStrategy] = await Promise.all([api.status(), api.getConfig()]);
    onStatusChange(freshStatus);
    onStrategyChange(freshStrategy);
  };
  const perTokenWei =
    targetEpoch !== null ? (BigInt(targetEpoch) * BASE_TAX_RATE_WEI).toString() : "0";
  const totalWei =
    targetEpoch !== null ? (BigInt(targetEpoch) * BASE_TAX_RATE_WEI * BigInt(nSelected)).toString() : "0";

  const toggleToken = (id: string) => {
    if (armed) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const arm = async () => {
    setErr(null);
    setBusy(true);
    try {
      if (targetEpoch === null || !status) throw new Error("Target epoch is not available");
      const nextStatus = await api.jit({
        enable: true,
        expectedRevision: status.jitRevision,
        targetEpoch,
        tokenIds: [...selected],
      });
      onStatusChange(nextStatus);
      onStrategyChange(await api.getConfig());
    } catch (e) {
      if (e instanceof ApiError && (e.status === 409 || e.status === 503)) {
        try {
          await refreshAuthoritative();
          setErr(e.status === 409
            ? "Campaign changed elsewhere; refreshed its authoritative state."
            : "The campaign may have committed but durability was not confirmed; refreshed authoritative state. The engine remains paused.");
          return;
        } catch {
          // Fall through to the mutation error.
        }
      }
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disarm = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (!status) throw new Error("Campaign status is not available");
      const nextStatus = await api.jit({ enable: false, expectedRevision: status.jitRevision });
      onStatusChange(nextStatus);
      onStrategyChange(await api.getConfig());
    } catch (e) {
      if (e instanceof ApiError && (e.status === 409 || e.status === 503)) {
        try {
          await refreshAuthoritative();
          setErr(e.status === 409
            ? "Campaign changed elsewhere; refreshed its authoritative state."
            : "The campaign may have committed but durability was not confirmed; refreshed authoritative state. The engine remains paused.");
          return;
        } catch {
          // Fall through to the mutation error.
        }
      }
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // --- Payment gas (used by every tax payment, incl. the boundary-timed JIT pay) ---
  const [gasBusy, setGasBusy] = useState(false);
  const [gasSaved, setGasSaved] = useState(false);
  const [gasErr, setGasErr] = useState<string | null>(null);
  const [savedBuilder, setSavedBuilder] = useState<BuilderSettings | null>(
    () => config ? builderSettings(config) : null,
  );
  const [builderCapability, setBuilderCapability] = useState<BuilderIncentiveCapability | null>(null);
  const [builderCapabilityLoading, setBuilderCapabilityLoading] = useState(false);

  useEffect(() => {
    if (config) setSavedBuilder(builderSettings(config));
  }, [strategy?.revision]);

  useEffect(() => {
    if (!config) return;
    let cancelled = false;
    setBuilderCapabilityLoading(true);
    api.builderIncentive()
      .then((capability) => {
        if (!cancelled) setBuilderCapability(capability);
      })
      .catch((error) => {
        if (!cancelled) {
          setBuilderCapability({
            active: false,
            reason: `Backend capability check failed: ${(error as Error).message}`,
          });
        }
      })
      .finally(() => {
        if (!cancelled) setBuilderCapabilityLoading(false);
      });
    return () => { cancelled = true; };
  }, [
    strategy?.revision,
    status?.mode,
    status?.chainId,
    status?.journalHealthy,
    capabilityRefreshToken,
  ]);

  const gasField = (k: keyof StrategyConfig, v: number | boolean | string) => {
    if (!config) return;
    onStrategyChange({ ...strategy!, config: { ...config, [k]: v } });
    setGasSaved(false);
  };
  const saveGas = async () => {
    if (!config) return;
    const bidWei = ethWei(config.coinbaseBidEth);
    if (config.coinbaseBidEnabled && (bidWei === null || bidWei === 0n)) {
      setGasErr("Enter a positive canonical ETH amount with at most 18 decimal places.");
      return;
    }
    if (config.coinbaseBidEnabled && !ADDRESS.test(config.coinbasePayerAddress)) {
      setGasErr("Enter the deployed CoinbasePayer address before enabling the incentive.");
      return;
    }
    const nextBuilder = builderSettings(config);
    const acknowledgesRisk = savedBuilder === null
      ? nextBuilder.coinbaseBidEnabled
      : builderRiskIncreases(savedBuilder, nextBuilder);
    if (acknowledgesRisk && !window.confirm(
      "Confirm direct builder-incentive risk\n\n"
      + "An included incentive irreversibly sends ETH to the block fee recipient, plus gas. "
      + "It does not guarantee inclusion, top-of-block placement, transaction order, or audit success. Continue?",
    )) {
      setGasErr("Builder-incentive changes were not saved because risk acknowledgement was cancelled.");
      return;
    }
    setGasBusy(true);
    setGasErr(null);
    try {
      const patch = {
        maxBaseFeeGwei: config.maxBaseFeeGwei,
        priorityFeeGwei: config.priorityFeeGwei,
        dynamicTipEnabled: config.dynamicTipEnabled,
        dynamicTipMaxGwei: config.dynamicTipMaxGwei,
        replacementPriorityFeeCapGwei: config.replacementPriorityFeeCapGwei,
        preBoundaryPay: config.preBoundaryPay,
        preBoundaryLeadMs: config.preBoundaryLeadMs,
        preBoundaryLeadMainnetMs: config.preBoundaryLeadMainnetMs,
        maxAutoPayEpochs: config.maxAutoPayEpochs,
        coinbaseBidEnabled: config.coinbaseBidEnabled,
        coinbaseBidEth: config.coinbaseBidEth,
        coinbasePayerAddress: config.coinbasePayerAddress,
        combinedBoundaryBundle: config.combinedBoundaryBundle,
      };
      const next = acknowledgesRisk
        ? await api.setConfig(strategy!.revision, patch, true)
        : await api.setConfig(strategy!.revision, patch);
      onStrategyChange(next);
      setSavedBuilder(builderSettings(next.config));
      setGasSaved(true);
      try {
        setBuilderCapability(await api.builderIncentive());
      } catch (error) {
        setBuilderCapability({
          active: false,
          reason: `Saved, but the backend capability refresh failed: ${(error as Error).message}`,
        });
      }
    } catch (e) {
      if (e instanceof ApiError && (e.status === 409 || e.status === 503)) {
        try {
          await refreshAuthoritative();
          setGasErr(e.status === 409
            ? "Payment settings changed elsewhere; refreshed authoritative values."
            : "Payment settings may have committed but durability was not confirmed; refreshed authoritative values. The engine remains paused.");
          return;
        } catch {
          // Fall through to the mutation error.
        }
      }
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
        <div className="stat">
          <span className="label">Target epoch</span>
          {armed ? (
            <span className="value">{targetEpoch ?? "—"}</span>
          ) : (
            <input
              aria-label="JIT target epoch"
              type="number"
              min={currentEpoch !== null ? currentEpoch + 1 : 1}
              step={1}
              value={targetEpoch ?? ""}
              onChange={(e) => {
                const value = e.target.valueAsNumber;
                setRequestedTargetEpoch(Number.isFinite(value) ? Math.max(1, Math.floor(value)) : null);
              }}
              style={{ width: 110 }}
            />
          )}
        </div>
        <div className="stat"><span className="label">Begins in</span><span className="value">{countdown(secondsToTarget, true)}</span></div>
        <div className="stat"><span className="label">Selected</span><span className="value">{armed ? `${nSelected} armed` : `${nSelected} / ${tokens.length}`}</span></div>
        <div className="stat"><span className="label">Est. per token</span><span className="value">{weiToEth(perTokenWei, 5)} ETH</span></div>
        <div className="stat"><span className="label">Est. total</span><span className="value">{weiToEth(totalWei, 5)} ETH</span></div>
      </div>

      {tokens.length > 1 && (
        <div style={{ marginBottom: 12 }}>
          <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
            SELECT CITIZENS TO ARM
            <button
              className="ghost"
              style={{ fontSize: 11, padding: "1px 8px", marginLeft: 8 }}
              onClick={() => setSelected(new Set(tokens.map((t) => t.tokenId)))}
              disabled={armed || busy}
            >all</button>
            <button
              className="ghost"
              style={{ fontSize: 11, padding: "1px 8px", marginLeft: 4 }}
              onClick={() => setSelected(new Set())}
              disabled={armed || busy}
            >none</button>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {tokens.map((t) => (
              <label
                key={t.tokenId}
                style={{
                  display: "flex", alignItems: "center", gap: 5,
                  padding: "3px 10px", borderRadius: 6, cursor: armed ? "default" : "pointer",
                  border: `1px solid ${displayedSelection.has(t.tokenId) ? "var(--accent)" : "var(--border)"}`,
                  background: displayedSelection.has(t.tokenId) ? "rgba(91,157,255,0.1)" : "transparent",
                  fontSize: 12, fontFamily: "monospace",
                }}
              >
                <input
                  type="checkbox"
                  style={{ width: "auto" }}
                  checked={displayedSelection.has(t.tokenId)}
                  onChange={() => toggleToken(t.tokenId)}
                  disabled={armed}
                />
                #{t.tokenId}
              </label>
            ))}
          </div>
        </div>
      )}

      {armed ? (
        <>
          <div className="row wrap" style={{ gap: 10 }}>
            <span className="badge warn">ARMED · epoch {armedEpoch}</span>
            <button className="danger" onClick={disarm} disabled={busy}>Disarm</button>
          </div>
          <p className="hint" aria-label="Armed Citizen IDs">
            Armed Citizen IDs: {armedTokenIds.length > 0
              ? armedTokenIds.map((tokenId) => `#${tokenId}`).join(", ")
              : "none"}
          </p>
        </>
      ) : (
        <button
          className="primary"
          onClick={arm}
          disabled={busy || targetEpoch === null || nSelected === 0}
        >
          {busy ? "Arming…" : `Arm payment for epoch ${targetEpoch ?? "…"}`}
        </button>
      )}

      {!armed && status && status.jitState !== "cancelled" && (
        <p className={status.jitState === "failed" ? "err" : "hint"}>
          Last campaign: {status.jitState.replaceAll("-", " ")}
          {status.jitMessage ? ` — ${status.jitMessage}` : ""}
        </p>
      )}

      {config && (
        <div style={{ marginTop: 16, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>AUTO-PAY LIMIT</div>
          <p className="muted" style={{ fontSize: 11, margin: "0 0 8px 0", lineHeight: 1.5 }}>
            Most epochs a single <b>automatic</b> payment may cover — a cap on ETH spent per auto payment.
            <b> Default 1</b>: auto-payments never spend more than one day's taxes at once, so a lost/failed
            payment never balloons into a multi-day charge. <b>The JIT single-epoch payment always fires</b>
            (even when a citizen is momentarily 2 behind at the boundary); this only caps the multi-epoch
            proactive-pay / defense paths. Raise it to let those auto-catch-up several epochs in one payment.
          </p>
          <label className="field" style={{ maxWidth: 220 }}>
            Max epochs per auto payment
            <input
              type="number" min={1} step={1}
              value={config.maxAutoPayEpochs}
              onChange={(e) => gasField("maxAutoPayEpochs", Math.max(1, Math.floor(Number(e.target.value) || 1)))}
            />
          </label>

          <div className="muted" style={{ fontSize: 11, margin: "12px 0 4px 0", borderTop: "1px solid var(--border)", paddingTop: 12 }}>PAYMENT GAS</div>
          <p className="muted" style={{ fontSize: 11, margin: "0 0 10px 0", lineHeight: 1.5 }}>
            Applied to every tax payment, including the boundary-timed pay above. Raise the priority tip
            (or enable the dynamic tip) so your payment out-orders a batch-audit tx landing in the same
            first-of-epoch block.
          </p>
          <div className="row wrap" style={{ gap: 12, alignItems: "flex-end" }}>
            <label className="field" style={{ flex: "1 1 120px" }}>
              Priority fee / tip (gwei)
              <input
                type="number" min={0} step={0.1}
                value={config.priorityFeeGwei}
                onChange={(e) => gasField("priorityFeeGwei", Number(e.target.value))}
              />
            </label>
            <label className="field" style={{ flex: "1 1 120px" }}>
              Max base fee (gwei)
              <input
                type="number" min={0}
                value={config.maxBaseFeeGwei}
                onChange={(e) => gasField("maxBaseFeeGwei", Number(e.target.value))}
              />
            </label>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={config.dynamicTipEnabled}
              onChange={(e) => gasField("dynamicTipEnabled", e.target.checked)}
            />
            Dynamic priority tip (scale up as the block fills)
          </label>
          <label className="field" style={{ marginLeft: 24 }}>
            Max dynamic tip (gwei)
            <input
              type="number" min={0} step={1}
              value={config.dynamicTipMaxGwei}
              onChange={(e) => gasField("dynamicTipMaxGwei", Number(e.target.value))}
              disabled={!config.dynamicTipEnabled}
            />
          </label>
          <label className="field" style={{ marginLeft: 24 }}>
            Replacement priority-fee ceiling (gwei)
            <input
              type="number" min={0.1} step={0.1}
              value={config.replacementPriorityFeeCapGwei}
              onChange={(e) => gasField("replacementPriorityFeeCapGwei", Number(e.target.value))}
            />
          </label>
          <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
            <label className="check">
              <input
                type="checkbox"
                checked={config.preBoundaryPay}
                onChange={(e) => gasField("preBoundaryPay", e.target.checked)}
              />
              ⚠ Pre-submit defensive payments at the boundary (advanced)
            </label>
            <p className="muted" style={{ fontSize: 11, margin: "0 0 8px 24px", lineHeight: 1.5 }}>
              Pre-submits one epoch for each owned Citizen that would become auditable at the next
              boundary, plus any armed JIT payment, so it can compete in the <b>first eligible block</b>.
              The upcoming amount is <b>validated by simulating at the boundary instant</b>. If it is
              missed or rejected, the next normal block/poll tick retries from fresh on-chain data.
            </p>
            <div className="row wrap" style={{ gap: 12, alignItems: "flex-end", marginLeft: 24 }}>
              <label className="field" style={{ flex: "1 1 140px" }}>
                Lead — public mode (ms)
                <input
                  type="number" min={250} max={8000} step={250}
                  value={config.preBoundaryLeadMs}
                  onChange={(e) => gasField("preBoundaryLeadMs", Number(e.target.value))}
                  disabled={!config.preBoundaryPay}
                />
              </label>
              <label className="field" style={{ flex: "1 1 140px" }}>
                Lead — mainnet bundles (ms)
                <input
                  type="number" min={250} max={11000} step={250}
                  value={config.preBoundaryLeadMainnetMs}
                  onChange={(e) => gasField("preBoundaryLeadMainnetMs", Number(e.target.value))}
                  disabled={!config.preBoundaryPay}
                />
              </label>
            </div>
            <p className="muted" style={{ fontSize: 11, margin: "0 0 8px 24px", lineHeight: 1.5 }}>
              The bot uses whichever lead matches your submission mode. Future-valid public transactions wait
              for the boundary timestamp; mainnet bundles also carry that timestamp as an inclusion floor. Keep
              both leads under one 12-second slot. The larger mainnet default gives builders more time.
            </p>
          </div>

          <div
            style={{
              marginTop: 12,
              paddingTop: 10,
              borderTop: "1px solid var(--border)",
              ...(config.coinbaseBidEnabled
                ? {
                    borderLeft: "3px solid var(--accent)",
                    background: "rgba(91,157,255,0.08)",
                    paddingLeft: 10,
                    marginLeft: -10,
                    borderRadius: 6,
                  }
                : {}),
            }}
          >
            <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
              ⚠ DIRECT BUILDER INCENTIVE (advanced, private mainnet)
              {builderCapabilityLoading && (
                <span className="badge" style={{ marginLeft: 8, fontSize: 10 }}>VERIFYING…</span>
              )}
              {!builderCapabilityLoading && builderCapability?.active && (
                <span
                  className="badge"
                  style={{ marginLeft: 8, background: "var(--accent)", color: "#fff", fontSize: 10 }}
                >
                  CONFIG / CHAIN / CODE VERIFIED
                </span>
              )}
              {!builderCapabilityLoading && builderCapability && !builderCapability.active && (
                <span className="badge warn" style={{ marginLeft: 8, fontSize: 10 }}>INACTIVE</span>
              )}
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={config.coinbaseBidEnabled}
                onChange={(e) => gasField("coinbaseBidEnabled", e.target.checked)}
              />
              Enable a direct builder incentive for eligible combined boundary cohorts
            </label>
            <div
              role="note"
              aria-label="Builder incentive risk warning"
              style={{ fontSize: 11, margin: "6px 0 10px 24px", lineHeight: 1.5 }}
            >
              <p className="err" style={{ margin: "0 0 4px 0" }}>
                <b>Non-refundable ETH:</b> if included, this sends the configured amount to the block fee
                recipient, plus transaction gas. The stateless payer has no owner or withdrawal path.
              </p>
              <p className="muted" style={{ margin: "0 0 4px 0" }}>
                <b>No guarantee:</b> paying a builder does not guarantee bundle inclusion, top-of-block
                position, transaction order, or a successful payment/audit outcome.
              </p>
              <p className="muted" style={{ margin: "0 0 4px 0" }}>
                <b>Private mainnet only:</b> the backend requires Ethereum mainnet, a healthy submission
                journal, and the exact pinned CoinbasePayer runtime at the configured address.
              </p>
              <p className="muted" style={{ margin: 0 }}>
                <b>No bid-only submission:</b> the incentive is never sent on its own; it is only an
                allowed-to-revert tail transaction behind an eligible mandatory boundary payment.
              </p>
            </div>
            <div className="row wrap" style={{ gap: 12, alignItems: "flex-end" }}>
              <label className="field" style={{ flex: "1 1 170px" }}>
                Builder incentive (ETH)
                <input
                  aria-label="Builder incentive amount (ETH)"
                  type="text"
                  inputMode="decimal"
                  placeholder="0.01"
                  value={config.coinbaseBidEth}
                  onChange={(e) => gasField("coinbaseBidEth", e.target.value)}
                  disabled={!config.coinbaseBidEnabled}
                />
              </label>
              <label className="field" style={{ flex: "2 1 280px" }}>
                Approved CoinbasePayer address
                <input
                  aria-label="CoinbasePayer address"
                  type="text"
                  placeholder="0x…"
                  value={config.coinbasePayerAddress}
                  onChange={(e) => gasField("coinbasePayerAddress", e.target.value)}
                  disabled={!config.coinbaseBidEnabled}
                />
              </label>
            </div>
            {config.coinbaseBidEnabled
              && (ethWei(config.coinbaseBidEth) ?? 0n) === 0n && (
              <p className="err" style={{ fontSize: 11, margin: "4px 0 0 0" }}>
                Enter a positive canonical ETH amount with at most 18 decimal places.
              </p>
            )}
            {config.coinbaseBidEnabled && !ADDRESS.test(config.coinbasePayerAddress) && (
              <p className="err" style={{ fontSize: 11, margin: "4px 0 0 0" }}>
                Enter the deployed 0x CoinbasePayer address. The backend will verify its runtime bytecode.
              </p>
            )}
            {!builderCapabilityLoading && builderCapability && !builderCapability.active && (
              <p className="hint" aria-label="Builder incentive backend state" style={{ marginTop: 6 }}>
                Backend state: {builderCapability.reason}
              </p>
            )}
            {!builderCapabilityLoading && builderCapability?.active && (
              <p className="hint" aria-label="Builder incentive backend state" style={{ marginTop: 6 }}>
                Capability only: persisted switches, mainnet chain, healthy journal, payer/bid, and the
                pinned runtime are verified. This is not an executable-now signal. Payer {builderCapability.payer}.
              </p>
            )}
            <div
              className="hint"
              role="note"
              aria-label="Builder incentive execution requirements"
              style={{ marginTop: 6, lineHeight: 1.5 }}
            >
              Execution still requires mainnet mode (currently {status?.mode ?? "unknown"}), pre-boundary
              payments ({config.preBoundaryPay ? "enabled" : "disabled"}), a running engine
              ({status?.running ? "running" : "stopped"}), an unlocked wallet
              ({status?.unlocked ? "unlocked" : "locked"}), and a healthy journal
              ({status?.journalHealthy ? "healthy" : "unhealthy"}). {status?.dryRun
                ? "Dry Run is on, so no transaction will be signed or sent. "
                : "Dry Run is off. "}
              A due mandatory boundary payment and the final financial authorization must also pass at
              execution time; capability verification alone never sends a bid.
            </div>

            <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={config.combinedBoundaryBundle}
                  onChange={(e) => gasField("combinedBoundaryBundle", e.target.checked)}
                />
                Allow a combined boundary payment / audit private cohort
              </label>
              <p className="muted" style={{ fontSize: 11, margin: "4px 0 0 24px", lineHeight: 1.5 }}>
                Combined mode adds eligible audits behind an already prepared mandatory payment in the same
                private cohort. Each audit is explicitly <b>allowed to revert</b>, so a stale or raced audit
                cannot invalidate the mandatory payment prefix. A public audit race may still occur under the
                offense settings; this is not atomic and does not guarantee inclusion or ordering.
              </p>
              {!config.combinedBoundaryBundle && config.coinbaseBidEnabled && (
                <p className="hint" style={{ fontSize: 11, margin: "4px 0 0 24px" }}>
                  The direct incentive remains inactive until combined boundary cohorts are also enabled.
                </p>
              )}
            </div>
          </div>

          <button
            className="primary"
            onClick={saveGas}
            disabled={
              gasBusy
              || (config.coinbaseBidEnabled && (
                (ethWei(config.coinbaseBidEth) ?? 0n) === 0n
                || !ADDRESS.test(config.coinbasePayerAddress)
              ))
            }
            style={{ marginTop: 8 }}
          >
            {gasBusy ? "Saving…" : gasSaved ? "Saved ✓" : "Save payment settings"}
          </button>
          {gasErr && <p className="err" style={{ marginTop: 6 }}>{gasErr}</p>}
        </div>
      )}

      {tokens.length === 0 && (
        <p className="hint">
          {status?.nftConfigured
            ? "No owned citizens found for this wallet."
            : "No owned citizens detected yet — set your Alchemy key so the bot can find them."}
        </p>
      )}
      {status?.dryRun && <p className="hint">Dry-run is ON — arming will simulate the payment, not send it.</p>}
      {err && <p className="err">{err}</p>}
    </div>
  );
}
