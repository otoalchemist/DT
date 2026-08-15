import { useEffect, useState, useCallback } from "react";
import {
  VERSION,
  type BotStatus,
  type StrategyConfig,
  type ActivityEntry,
  type OwnedTokenStatus,
} from "@dat-bot/shared";
import { api } from "./api.js";
import { Config } from "./Config.js";
import { JitPanel } from "./JitPanel.js";
import { PostMortem } from "./PostMortem.js";
import { Wallets } from "./Wallets.js";
import { weiToEth, shortAddr, countdown, timeAgo, gameStateLabel } from "./util.js";

const riskBadge: Record<string, string> = {
  safe: "on",
  delinquent: "warn",
  audited: "warn",
  "at-risk": "danger",
  dead: "off",
};

export function Dashboard({
  status,
  activity,
  connected,
  pushStatus,
}: {
  status: BotStatus | null;
  activity: ActivityEntry[];
  connected: boolean;
  pushStatus: (s: BotStatus) => void;
}) {
  const [config, setConfig] = useState<StrategyConfig | null>(null);
  // The last config known to be persisted on the backend. Panels compare their own
  // fields against this to tell whether they hold unsaved edits.
  const [savedConfig, setSavedConfig] = useState<StrategyConfig | null>(null);
  const [tokens, setTokens] = useState<OwnedTokenStatus[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.getConfig().then((c) => { setConfig(c); setSavedConfig(c); }).catch(() => {});
  }, []);

  // A panel finished persisting. `next` is the backend's authoritative full config, so
  // it becomes the new saved baseline. For the working copy we keep any edits still
  // pending in the OTHER panel — a field whose working value diverged from the old
  // baseline is an unsaved edit this save didn't cover, so it must survive (and keep
  // that panel's dirty indicator lit) rather than be clobbered by the round-trip.
  const onConfigSaved = useCallback((next: StrategyConfig) => {
    const merged: StrategyConfig = { ...next };
    if (config && savedConfig) {
      for (const key of Object.keys(next) as (keyof StrategyConfig)[]) {
        if (JSON.stringify(config[key]) !== JSON.stringify(savedConfig[key])) {
          merged[key] = config[key] as never;
        }
      }
    }
    setConfig(merged);
    setSavedConfig(next);
  }, [config, savedConfig]);

  // `force` is the manual "Refresh data" press: re-read chain state into runtime and drop
  // the ownership caches BEFORE the GETs, so what comes back is genuinely fresh rather
  // than stale-while-revalidate. The background 20s poll passes force=false.
  const refresh = useCallback(async (force = false) => {
    try {
      if (force) {
        const s = await api.refreshChain().catch(() => null);
        if (s) pushStatus(s);
      }
      // A failed read must NOT blank the panel. Keep the last good rows and report
      // the failure instead of replacing the citizen list with "none".
      try {
        setTokens(await api.tokens());
        setErr(null);
      } catch {
        setErr("Could not read owned tokens — showing the last good data. Press \"Refresh data\" to retry.");
      }
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [pushStatus]);

  // Poll on-chain views only while the tab is actually being looked at. In away mode it
  // stops polling entirely — that's the point of the mode. One read on mount so the page
  // isn't blank, then nothing until "Refresh data" is pressed.
  const awayMode = config?.awayMode ?? false;
  useEffect(() => {
    const tick = () => { if (!document.hidden) void refresh(); };
    tick();
    if (awayMode) return;
    const id = setInterval(tick, 20000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh, awayMode]);

  const running = status?.running ?? false;

  // 1s clock so the "Bot starting in …" countdown actually counts. Purely local — it
  // re-renders from the already-known wake timestamp and costs no RPC. Only runs while a
  // countdown is on screen.
  const [, setNowTick] = useState(0);
  const awayWakeSec = status?.awayNextWakeSec ?? null;
  const countingDown = awayMode && !running && awayWakeSec !== null;
  useEffect(() => {
    if (!countingDown) return;
    const id = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [countingDown]);

  const awaySecsToWake = awayWakeSec === null ? 0 : awayWakeSec - Math.floor(Date.now() / 1000);
  // A wake is actually scheduled: away mode owns starting the bot, so Start is disabled.
  const awayScheduled = countingDown;
  // Away mode on but nothing armed to wake for — no schedule exists, so leave Start
  // clickable rather than locking the user out of running the bot at all.
  const awayIdleNoWork = awayMode && !running && awayWakeSec === null;

  // The only state where every view updates on its own: the 20s dashboard poll (which
  // runs whenever away mode is off) covers the lists, and the engine tick covers the
  // header stats. Manual refresh adds nothing, so the button is disabled.
  const selfRefreshing = running && !awayMode;

  // Away mode is an INSTANT-APPLY control, like Start bot — pressing it persists straight
  // away rather than staging an edit for "Save strategy".
  const [awayBusy, setAwayBusy] = useState(false);
  const [awayErr, setAwayErr] = useState<string | null>(null);
  const persistAway = async (patch: Partial<StrategyConfig>) => {
    setAwayBusy(true);
    setAwayErr(null);
    try {
      onConfigSaved(await api.setConfig(patch));
    } catch (e) {
      setAwayErr((e as Error).message);
    } finally {
      setAwayBusy(false);
    }
  };

  const [leadDraft, setLeadDraft] = useState<string | null>(null);
  const leadMinutes = config?.awayLeadMinutes ?? 15;
  const commitLead = () => {
    const draft = leadDraft;
    setLeadDraft(null);
    if (draft === null) return;
    const n = Math.min(720, Math.max(1, Math.floor(Number(draft) || leadMinutes)));
    if (n !== leadMinutes) void persistAway({ awayLeadMinutes: n });
  };

  const explorerBase = status?.chainId === 1 ? "https://etherscan.io" : null;

  const [tokenBusy, setTokenBusy] = useState<string | null>(null);
  const [tokenMsg, setTokenMsg] = useState<{ id: string; text: string; err: boolean } | null>(null);
  const runTokenAction = async (tokenId: string, action: "pay" | "bribe") => {
    const t = tokens.find((x) => x.tokenId === tokenId);
    const behind = t ? Number(BigInt(t.currentEpoch) - BigInt(t.lastEpochPaid)) : 0;
    const warning =
      action === "pay"
        ? `Pay ${weiToEth(t?.estimatedPayWei ?? "0")} ETH to make Citizen #${tokenId} current?\n\n` +
          `This sends a REAL transaction with real ETH, at normal network gas.\n` +
          `#${tokenId} is ${behind} epoch(s) behind — the contract settles every ` +
          `delinquent epoch at once, so the full amount above is charged.` +
          (t?.auditDueTimestamp !== "0" ? `\n\nIts active audit will also be cleared.` : "")
        : `Spend 1 bribe to clear the audit on Citizen #${tokenId}?\n\n` +
          `This sends a REAL transaction (gas only) at normal network gas.\n\n` +
          `WARNING: a bribe clears the AUDIT but pays NO tax. #${tokenId} stays ` +
          `${behind} epoch(s) behind and can be audited again immediately. ` +
          `The bribe is consumed and cannot be recovered.\n\n` +
          `To actually make it current, use "Pay to current" instead.`;
    if (!confirm(warning)) return;

    setTokenBusy(`${tokenId}:${action}`);
    setTokenMsg(null);
    try {
      const res = action === "pay" ? await api.payToken(tokenId) : await api.bribeToken(tokenId);
      setTokenMsg({ id: tokenId, text: res.message, err: false });
      await refresh();
    } catch (e) {
      setTokenMsg({ id: tokenId, text: (e as Error).message, err: true });
    } finally {
      setTokenBusy(null);
    }
  };

  const [toggling, setToggling] = useState(false);
  const [toggleErr, setToggleErr] = useState<string | null>(null);
  const toggleRun = async () => {
    setToggling(true);
    setToggleErr(null);
    try {
      const next = running ? await api.stop() : await api.start();
      pushStatus(next);
    } catch (e) {
      setToggleErr((e as Error).message);
    } finally {
      setToggling(false);
    }
  };

  return (
    <div>

      <div className="topbar">
        <div className="brand" style={{ flex: "1 1 0", minWidth: 0 }}>
          Death &amp; Taxes Bot <span className="version">v{VERSION}</span>
          <small>
            {connected ? "● live" : "○ reconnecting…"} · {shortAddr(status?.address)}
            {status?.version && status.version !== VERSION && (
              <span className="version-warn" title="The running backend is a different version than this dashboard — re-run the current build.">
                {" "}· ⚠ backend v{status.version}
              </span>
            )}
          </small>
        </div>
        <div className="row" style={{ flex: "0 0 auto", gap: 12 }}>
          <span className={`badge status-lg ${running ? "on" : "off"}`}>{running ? "● RUNNING" : "PAUSED"}</span>
          {awayMode && (
            <span
              className="badge warn"
              title={
                awayScheduled
                  ? `Away mode: engine idle, no RPC polling. Starts itself ${config?.awayLeadMinutes ?? 15} min before the boundary, runs through it, then idles again 5 min after.`
                  : awayIdleNoWork
                    ? "Away mode on, but nothing is armed to wake for — arm a JIT payment or enable proactive pay."
                    : "Away mode: this is the boundary window, so the engine is running. It will idle again shortly after the boundary."
              }
            >
              AWAY · AUTO{awayIdleNoWork ? " · nothing armed" : ""}
            </span>
          )}
          <button
            className="ghost"
            onClick={() => void refresh(true)}
            disabled={selfRefreshing}
            title={
              selfRefreshing
                ? "Already refreshing: the dashboard polls every 20s and the running engine updates epoch/balance each block."
                : "Read on-chain data once, now — the header stats only update while the engine runs."
            }
          >
            Refresh data
          </button>
          <button
            className={`start-cta ${running ? "danger" : awayScheduled ? "" : "primary attention"}`}
            onClick={toggleRun}
            disabled={toggling || awayScheduled}
            title={
              awayScheduled
                ? `Away mode is managing the bot. It starts itself ${config?.awayLeadMinutes ?? 15} min before the epoch boundary, runs through it, then idles again 5 min after.`
                : awayIdleNoWork
                  ? "Away mode is on but nothing is armed to wake for — arm a JIT payment. You can still start manually."
                  : undefined
            }
          >
            {toggling
              ? "…"
              : running
                ? "Pause bot"
                : awayScheduled
                  ? `Bot starting in ${countdown(awaySecsToWake)}`
                  : "▶ Start bot"}
          </button>
          {toggleErr && <span className="err" style={{ fontSize: 12 }}>{toggleErr}</span>}
        </div>
        <div className="topbar-right" style={{ flex: "1 1 0" }}>
          <button className="ghost" onClick={() => api.lock().then(() => location.reload())}>Lock</button>
          <div className="row" style={{ gap: 6 }}>
            <button
              className={`away-cta${awayMode ? " on" : ""}`}
              onClick={() => void persistAway({ awayMode: !awayMode })}
              disabled={awayBusy || config === null}
              title={
                awayMode
                  ? `Away/Autonomous ON — the engine idles at zero RPC between epochs, starts itself ${leadMinutes} min before the boundary, runs through it, then stops 5 min after. The dashboard also stops its 20s polling; use Refresh data to read on demand.

Autonomous: it arms JIT payments itself when a citizen falls behind. The coinbase bid under Just-in-time epoch payment is spent without a keypress while this is on.

Mid-epoch work is still missed: an audit expires 24h after it was cast, not on a boundary. Click to turn off.`
                  : "Away/Autonomous OFF — the engine runs continuously (~22 provider requests/minute) and the dashboard polls every 20s. Click to idle between epochs and wake only for the boundary. Applies immediately; no save needed."
              }
            >
              {awayBusy ? "…" : awayMode ? "◐ Away/Autonomous ON" : "Away/Autonomous off"}
            </button>
            <input
              className="away-lead"
              type="number"
              min={1}
              max={720}
              step={1}
              value={leadDraft ?? String(leadMinutes)}
              disabled={awayBusy || config === null}
              onChange={(e) => setLeadDraft(e.target.value)}
              onBlur={commitLead}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              title="Wake this many minutes before the epoch boundary. Saves when you press Enter or click away."
            />
            <span className="muted" style={{ fontSize: 11 }}>min lead</span>
          </div>
          {awayErr && <span className="err" style={{ fontSize: 12 }}>{awayErr}</span>}
        </div>
      </div>

      <div className="panel">
        <div className="row wrap" style={{ gap: 28 }}>
          <div className="stat"><span className="label">Balance</span><span className="value">{weiToEth(status?.balanceWei ?? null)} ETH</span></div>
          <div className="stat"><span className="label">Game</span><span className="value">{gameStateLabel(status?.gameState ?? null)}</span></div>
          <div className="stat"><span className="label">Epoch</span><span className="value">{status?.currentEpoch ?? "—"}</span></div>
          <div className="stat"><span className="label">Citizens left</span><span className="value">{status?.citizenSupply ?? "—"}</span></div>
          <div className="stat"><span className="label">Spent this epoch</span><span className="value">{weiToEth(status?.spentThisEpochWei ?? "0")} ETH</span></div>
          <div className="stat"><span className="label">Block</span><span className="value mono">{status?.lastBlock ?? "—"}</span></div>
        </div>
      </div>

      <div className="spacer" />
      <JitPanel status={status} tokens={tokens} config={config} savedConfig={savedConfig} onConfigChange={setConfig} onConfigSaved={onConfigSaved} />

      <div className="spacer" />
      <Wallets status={status} />

      <div className="spacer" />
      <div className="panel">
        <h2>Your tokens</h2>
        {tokens.length === 0 ? (
          <p className="muted">
            {status?.nftConfigured
              ? "No owned Citizen tokens found for this wallet."
              : "No owned Citizen tokens detected (needs the Alchemy NFT API for enumeration)."}
          </p>
        ) : (
          <table>
            <thead><tr><th>Token</th><th>Wallet</th><th>Paid</th><th>Status</th><th>Audit expires</th><th>Bribes</th><th>Pay est.</th><th>Actions</th></tr></thead>
            <tbody>
              {tokens.map((t) => {
                const current = BigInt(t.lastEpochPaid) >= BigInt(t.currentEpoch);
                const underAudit = t.auditDueTimestamp !== "0";
                const hasBribe = BigInt(t.bribeBalance) > 0n;
                const rowBusy = tokenBusy?.startsWith(`${t.tokenId}:`) ?? false;
                return (
                <tr key={t.tokenId}>
                  <td className="mono">#{t.tokenId}</td>
                  <td
                    className="muted"
                    style={{ fontSize: 11 }}
                    title={
                      t.walletAddress
                        ? `Held by ${t.walletLabel} (${t.walletAddress}). Paying this citizen is owner-only on-chain, so it is signed by — and spends gas from — this wallet.`
                        : undefined
                    }
                  >
                    {t.walletLabel ?? "—"}
                  </td>
                  <td>{current
                    ? <span className="badge on">current</span>
                    : <span className="badge warn">behind</span>}
                  </td>
                  <td><span className={`badge ${riskBadge[t.risk] ?? "off"}`}>{t.risk}</span></td>
                  <td>{t.auditDueTimestamp === "0" ? "—" : countdown(t.secondsUntilKillable)}</td>
                  <td>{t.bribeBalance}</td>
                  <td>{weiToEth(t.estimatedPayWei)} ETH</td>
                  <td>
                    <div className="row wrap" style={{ gap: 6 }}>
                      <button
                        style={{ fontSize: 11, padding: "3px 10px" }}
                        disabled={rowBusy || current}
                        onClick={() => runTokenAction(t.tokenId, "pay")}
                        title={current
                          ? "Already current — nothing to pay"
                          : `Pay ${weiToEth(t.estimatedPayWei)} ETH to make #${t.tokenId} current${underAudit ? " and clear its audit" : ""}. Uses normal network gas.`}
                      >
                        {tokenBusy === `${t.tokenId}:pay` ? "…" : "Pay to current"}
                      </button>
                      {hasBribe && (
                        <button
                          style={{ fontSize: 11, padding: "3px 10px" }}
                          disabled={rowBusy || !underAudit}
                          onClick={() => runTokenAction(t.tokenId, "bribe")}
                          title={underAudit
                            ? `Spend 1 bribe to clear the audit on #${t.tokenId}. Does NOT pay tax — the token stays behind and can be audited again. Uses normal network gas.`
                            : "Only usable while under audit"}
                        >
                          {tokenBusy === `${t.tokenId}:bribe` ? "…" : "Clear audit (bribe)"}
                        </button>
                      )}
                    </div>
                    {tokenMsg?.id === t.tokenId && (
                      <div className={tokenMsg.err ? "err" : "hint"} style={{ fontSize: 11, marginTop: 4 }}>
                        {tokenMsg.text}
                      </div>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {err && <p className="err">{err}</p>}
      </div>

      <div className="spacer" />
      <div className="grid cols-2">
        {config && <Config cfg={config} savedCfg={savedConfig} onChange={setConfig} onSaved={onConfigSaved} />}

        <div className="panel fill">
          <h2>Activity</h2>
          <div className="log">
            {activity.length === 0 && <p className="muted">No activity yet.</p>}
            {[...activity].reverse().map((e) => {
              const when = new Date(e.ts);
              return (
              <div className="log-row" key={e.id}>
                <span className="time" title={`${when.toLocaleString()} · ${timeAgo(e.ts)} ago`}>
                  {when.toLocaleTimeString(undefined, { hour12: false })}
                </span>
                <span className={`pill ${e.status}`}>{e.status}</span>
                <span>
                  {e.message}
                  {e.txHash && (explorerBase
                    ? <> · <a href={`${explorerBase}/tx/${e.txHash}`} target="_blank" rel="noreferrer">tx ↗</a></>
                    : <> · <span className="mono">{e.txHash.slice(0, 10)}…</span></>)}
                  {!e.txHash && e.bundleHash && (
                    <> · <span className="muted">bundle {e.bundleHash.slice(0, 8)}…</span>
                      {e.targetBlock && explorerBase && (
                        <> · <a href={`${explorerBase}/block/${e.targetBlock}`} target="_blank" rel="noreferrer">blk {e.targetBlock} ↗</a></>
                      )}
                    </>
                  )}
                </span>
              </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="spacer" />
      <PostMortem />

    </div>
  );
}
