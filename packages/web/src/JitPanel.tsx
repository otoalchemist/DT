import { useEffect, useState } from "react";
import type { BotStatus, OwnedTokenStatus, StrategyConfig } from "@dat-bot/shared";
import { EPOCH_DURATION_SECONDS, BASE_TAX_RATE_WEI } from "@dat-bot/shared";
import { api } from "./api.js";
import { countdown, weiToEth } from "./util.js";

export function JitPanel({
  status,
  tokens,
  config,
  onConfigChange,
}: {
  status: BotStatus | null;
  tokens: OwnedTokenStatus[];
  config: StrategyConfig | null;
  onConfigChange: (c: StrategyConfig) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, setNowTick] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Default: all tokens selected.
  useEffect(() => {
    setSelected(new Set(tokens.map((t) => t.tokenId)));
  }, [tokens.map((t) => t.tokenId).join(",")]);

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

  const toggleToken = (id: string) => {
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
  const [gasSaved, setGasSaved] = useState(false);
  const [gasErr, setGasErr] = useState<string | null>(null);
  const gasField = (k: keyof StrategyConfig, v: number | boolean | string) => {
    if (!config) return;
    onConfigChange({ ...config, [k]: v });
    setGasSaved(false);
  };
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
        preBoundaryPay: config.preBoundaryPay,
        preBoundaryLeadMs: config.preBoundaryLeadMs,
        preBoundaryLeadMainnetMs: config.preBoundaryLeadMainnetMs,
        maxAutoPayEpochs: config.maxAutoPayEpochs,
        coinbaseBidEth: config.coinbaseBidEth,
        coinbasePayerAddress: config.coinbasePayerAddress,
        combinedBoundaryBundle: config.combinedBoundaryBundle,
      });
      onConfigChange(next);
      setGasSaved(true);
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

      {tokens.length > 1 && (
        <div style={{ marginBottom: 12 }}>
          <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
            SELECT CITIZENS TO ARM
            <button
              className="ghost"
              style={{ fontSize: 11, padding: "1px 8px", marginLeft: 8 }}
              onClick={() => setSelected(new Set(tokens.map((t) => t.tokenId)))}
            >all</button>
            <button
              className="ghost"
              style={{ fontSize: 11, padding: "1px 8px", marginLeft: 4 }}
              onClick={() => setSelected(new Set())}
            >none</button>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {tokens.map((t) => (
              <label
                key={t.tokenId}
                style={{
                  display: "flex", alignItems: "center", gap: 5,
                  padding: "3px 10px", borderRadius: 6, cursor: "pointer",
                  border: `1px solid ${selected.has(t.tokenId) ? "var(--accent)" : "var(--border)"}`,
                  background: selected.has(t.tokenId) ? "rgba(91,157,255,0.1)" : "transparent",
                  fontSize: 12, fontFamily: "monospace",
                }}
              >
                <input
                  type="checkbox"
                  style={{ width: "auto" }}
                  checked={selected.has(t.tokenId)}
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
          <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
            <label className="check">
              <input
                type="checkbox"
                checked={config.preBoundaryPay}
                onChange={(e) => gasField("preBoundaryPay", e.target.checked)}
              />
              ⚠ Race into the boundary block (advanced)
            </label>
            <p className="muted" style={{ fontSize: 11, margin: "0 0 8px 24px", lineHeight: 1.5 }}>
              Pre-submits the armed JIT payment just before the epoch boundary so it can land in the
              <b> first block of the epoch</b>, ahead of a batch-auditor — matching the fastest rivals.
              The amount is computed off-chain for the next epoch and <b>validated by simulating at the
              boundary instant</b>, so a wrong value is caught before spending gas. Pair with a high tip
              above. The normal boundary-timed pay still runs as a fallback.
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
              The bot uses whichever matches your submission mode. Bundles name their target block, so
              they can't land early and are dropped (not mined) if they'd revert — pre-submitting earlier
              is free and gives builders more time, hence the larger mainnet default. Keep it under 12s.
            </p>
          </div>

          <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
            <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>⚠ COINBASE BID (advanced, mainnet)</div>
            <p className="muted" style={{ fontSize: 11, margin: "0 0 8px 0", lineHeight: 1.5 }}>
              A <b>flat payment straight to the block builder</b> added to the pre-boundary payment bundle,
              to bid it to the <b>top of the boundary block</b> — independent of tip. This is the lever
              sophisticated batch-auditors use to guarantee position. <b>Default 0 (off).</b> It only spends
              if the bundle wins the slot (it rides the bundle, allowed-to-revert), and never mirrors to the
              mempool. Requires a one-time deploy of <code>contracts/CoinbasePayer.sol</code> — paste its
              address below.
            </p>
            <div className="row wrap" style={{ gap: 12, alignItems: "flex-end" }}>
              <label className="field" style={{ flex: "1 1 130px" }}>
                Coinbase bid (ETH, 0 = off)
                <input
                  type="number" min={0} step={0.001}
                  value={config.coinbaseBidEth}
                  onChange={(e) => gasField("coinbaseBidEth", Math.max(0, Number(e.target.value) || 0))}
                />
              </label>
              <label className="field" style={{ flex: "2 1 260px" }}>
                CoinbasePayer address
                <input
                  type="text" placeholder="0x… (deploy CoinbasePayer.sol)"
                  value={config.coinbasePayerAddress}
                  onChange={(e) => gasField("coinbasePayerAddress", e.target.value.trim() as never)}
                />
              </label>
            </div>
            {config.coinbaseBidEth > 0 && !/^0x[a-fA-F0-9]{40}$/.test(config.coinbasePayerAddress) && (
              <p className="err" style={{ fontSize: 11, margin: "4px 0 0 0" }}>
                Set a valid CoinbasePayer address, or the bid won't fire.
              </p>
            )}
          </div>

          <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
            <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>⚠ COMBINED BOUNDARY BUNDLE (advanced, mainnet)</div>
            <label className="check">
              <input
                type="checkbox"
                checked={config.combinedBoundaryBundle}
                onChange={(e) => gasField("combinedBoundaryBundle", e.target.checked)}
              />
              Combine payment + audit into one atomic bundle
            </label>
            <p className="muted" style={{ fontSize: 11, margin: "4px 0 0 24px", lineHeight: 1.5 }}>
              At a boundary, sends your pre-boundary <b>payment and audit as one bundle</b> (sequential nonces)
              instead of two — so they land consecutively top-of-block and can't demote each other. Payment is
              mandatory; audits ride allowed-to-revert (never drop the payment) and aren't mempool-mirrored.
              Includes whichever of pre-boundary pay / audit are on (payment-only, audit-only, or both). <b>Most
              effective with a coinbase bid</b> above — the bid wins the slot so the bundle-only audits actually
              land. Without a bid, the bundle may lose and the audits won't fall back to the mempool.
            </p>
            {config.combinedBoundaryBundle && config.coinbaseBidEth <= 0 && (
              <p className="hint" style={{ fontSize: 11, margin: "4px 0 0 24px" }}>
                Tip: set a coinbase bid so this bundle reliably wins the slot (else audits may not land).
              </p>
            )}
          </div>

          <button className="primary" onClick={saveGas} disabled={gasBusy} style={{ marginTop: 8 }}>
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
