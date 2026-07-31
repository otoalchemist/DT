import { useEffect, useState, useCallback } from "react";
import {
  VERSION,
  EMIGRATION_CONTRACT_ADDRESS,
  type BotStatus,
  type StrategyConfig,
  type ActivityEntry,
  type OwnedTokenStatus,
  type TargetTokenStatus,
  type EmigratedTokenStatus,
} from "@dat-bot/shared";
import { api } from "./api.js";
import { Config } from "./Config.js";
import { JitPanel } from "./JitPanel.js";
import { PostMortem } from "./PostMortem.js";
import { weiToEth, shortAddr, countdown, timeAgo, gameStateLabel } from "./util.js";

const riskBadge: Record<string, string> = {
  safe: "on",
  delinquent: "warn",
  audited: "warn",
  "at-risk": "danger",
  dead: "off",
};

function targetSortKey(t: TargetTokenStatus): number {
  if (t.killable) return 0;
  if (t.auditDueTimestamp !== "0") return 1;
  if (t.auditable) return 2;
  if (t.delinquent) return 3;
  return 4;
}

function TargetsTable({ rows, empty }: { rows: TargetTokenStatus[]; empty: string }) {
  if (rows.length === 0) return <p className="muted" style={{ fontSize: 12 }}>{empty}</p>;
  const sorted = [...rows].sort((a, b) => targetSortKey(a) - targetSortKey(b));
  return (
    <table>
      <thead><tr><th>Token</th><th>Behind</th><th>State</th><th>Kill in</th></tr></thead>
      <tbody>
        {sorted.map((t) => (
          <tr key={t.tokenId}>
            <td className="mono">#{t.tokenId}</td>
            <td>{t.epochsBehind > 0 ? `${t.epochsBehind}` : "—"}</td>
            <td>
              {t.killable
                ? <span className="badge danger">killable</span>
                : t.auditDueTimestamp !== "0"
                  ? <span className="badge warn">under audit</span>
                  : t.auditable
                    ? <span className="badge warn">auditable</span>
                    : t.delinquent
                      ? <span className="badge">delinquent</span>
                      : <span className="badge off">current</span>}
            </td>
            <td>{t.auditDueTimestamp === "0" ? "—" : t.killable ? "now" : countdown(Number(t.auditDueTimestamp) - Math.floor(Date.now() / 1000))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Citizens that emigrated: sent to the Emigration contract, swapped for a Governor NFT,
 * and held there permanently. They're out of the main game — we never pay, audit or kill
 * them — so this table deliberately carries no action affordance and mutes every badge.
 *
 * The roster is the full emigration history, so it includes emigrants that have ALREADY
 * been killed (rows go dim). Listing only the ones still held would shrink the count as
 * they die — the panel would have read 5 when 13 had emigrated. The live rows still show
 * a status because it's the only clue to when each remaining emigrant gets killed by
 * someone else and drops out of the supply that ends the game.
 */
function EmigratedTable({ rows }: { rows: EmigratedTokenStatus[] }) {
  if (rows.length === 0) {
    return <p className="muted" style={{ fontSize: 12 }}>No citizens have emigrated yet.</p>;
  }
  return (
    <table>
      <thead><tr><th>Token</th><th>Behind</th><th>Fate</th></tr></thead>
      <tbody>
        {rows.map((t) => (
          <tr key={t.tokenId} style={t.alive ? undefined : { opacity: 0.55 }}>
            <td className="mono">#{t.tokenId}</td>
            <td>{t.alive && t.epochsBehind > 0 ? `${t.epochsBehind}` : "—"}</td>
            <td>
              <span className="badge off">
                {!t.alive
                  ? "killed"
                  : t.killable
                    ? "awaiting kill"
                    : t.auditDueTimestamp !== "0"
                      ? `dies in ${countdown(Number(t.auditDueTimestamp) - Math.floor(Date.now() / 1000))}`
                      : "unaudited"}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  marginBottom: 6,
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
  const [targets, setTargets] = useState<TargetTokenStatus[]>([]);
  const [emigrated, setEmigrated] = useState<EmigratedTokenStatus[]>([]);
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

  const refresh = useCallback(async () => {
    try {
      const [t, g, e] = await Promise.all([
        api.tokens().catch(() => []),
        api.targets().catch(() => []),
        api.emigrated().catch(() => []),
      ]);
      setTokens(t);
      setTargets(g);
      setEmigrated(e);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  // Poll on-chain views only while the tab is actually being looked at. Each cycle
  // costs several RPC round-trips per endpoint, so a dashboard left open in a
  // background tab was burning provider quota around the clock for a page nobody was
  // reading (the single biggest source of idle RPC usage). Refresh immediately on
  // becoming visible so returning to the tab still shows current data.
  useEffect(() => {
    const tick = () => { if (!document.hidden) void refresh(); };
    tick();
    const id = setInterval(tick, 20000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);

  const running = status?.running ?? false;
  // Only link to Etherscan on mainnet (chainId 1) — a local/anvil fork's hashes
  // aren't there, so fall back to plain text in that case.
  const explorerBase = status?.chainId === 1 ? "https://etherscan.io" : null;

  // Emigrants still held by the contract. The rest of the roster is already dead — kept
  // on the list because emigrating is what put them there, and the count is the history.
  const emigratedAlive = emigrated.filter((e) => e.alive).length;

  const pinnedSet = new Set(config?.offenseTargetTokenIds ?? []);
  const myTargets = targets.filter((t) => pinnedSet.has(t.tokenId));
  const otherTargets = targets.filter((t) => !pinnedSet.has(t.tokenId));

  // Manual per-token actions. `tokenBusy` keys off `${tokenId}:${action}` so only the
  // pressed button shows a spinner, and both buttons on that row lock while it runs.
  const [tokenBusy, setTokenBusy] = useState<string | null>(null);
  const [tokenMsg, setTokenMsg] = useState<{ id: string; text: string; err: boolean } | null>(null);
  const runTokenAction = async (tokenId: string, action: "pay" | "bribe") => {
    // Both actions submit a REAL transaction with real ETH the moment they're
    // confirmed, so spell out the cost and the consequence before doing anything.
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
      await refresh(); // pull fresh on-chain status for the row
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
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>

      {/* ── Main column ── */}
      <div style={{ flex: "1 1 0", minWidth: 0 }}>

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
            <button
              className={`start-cta ${running ? "danger" : "primary attention"}`}
              onClick={toggleRun}
              disabled={toggling}
            >
              {toggling ? "…" : running ? "Pause bot" : "▶ Start bot"}
            </button>
            {toggleErr && <span className="err" style={{ fontSize: 12 }}>{toggleErr}</span>}
          </div>
          <div className="row" style={{ flex: "1 1 0", justifyContent: "flex-end" }}>
            <button className="ghost" onClick={() => api.lock().then(() => location.reload())}>Lock</button>
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
              <thead><tr><th>Token</th><th>Paid</th><th>Status</th><th>Audit expires</th><th>Bribes</th><th>Pay est.</th><th>Actions</th></tr></thead>
              <tbody>
                {tokens.map((t) => {
                  const current = BigInt(t.lastEpochPaid) >= BigInt(t.currentEpoch);
                  const underAudit = t.auditDueTimestamp !== "0";
                  const hasBribe = BigInt(t.bribeBalance) > 0n;
                  const rowBusy = tokenBusy?.startsWith(`${t.tokenId}:`) ?? false;
                  return (
                  <tr key={t.tokenId}>
                    <td className="mono">#{t.tokenId}</td>
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

          <div className="panel">
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

      {/* ── Right sidebar: Rival Targets + Emigrated ── */}
      <div style={{ width: 380, flexShrink: 0, position: "sticky", top: 20 }}>
        <div className="panel">
          <h2>Rival targets</h2>
          <div className="muted" style={{ ...sectionLabel, marginBottom: 4 }}>My rivals ({myTargets.length})</div>
          <TargetsTable rows={myTargets} empty="No pinned rivals — add token IDs in Config." />
          <p className="muted" style={{ fontSize: 11, margin: "4px 0 0 0", lineHeight: 1.5 }}>
            Pinned rivals always appear here, even while paid up. Everything below is
            shown only while it's delinquent, under audit, or killable.
          </p>
          <div className="spacer" />
          <div className="muted" style={{ ...sectionLabel, marginBottom: 4 }}>Others ({otherTargets.length})</div>
          <TargetsTable rows={otherTargets} empty="No other delinquent/killable rivals found." />
        </div>

        <div className="spacer" />

        <div className="panel">
          <h2>Emigrated citizens ({emigrated.length})</h2>
          <div className="muted" style={{ ...sectionLabel, marginBottom: 6 }}>
            {emigratedAlive} still held · {emigrated.length - emigratedAlive} killed · {36 - emigrated.length} slots left
          </div>
          <EmigratedTable rows={emigrated} />
          <p className="muted" style={{ fontSize: 11, margin: "8px 0 0 0", lineHeight: 1.5 }}>
            Traded to the{" "}
            {explorerBase
              ? <a href={`${explorerBase}/address/${EMIGRATION_CONTRACT_ADDRESS}`} target="_blank" rel="noreferrer">Emigration contract</a>
              : "Emigration contract"}{" "}
            for a Governor NFT (36 total, first come). They've left the main game: the bot
            never audits or kills them, and they're excluded from Rival targets. The
            contract can't pay taxes or spend a bribe, so each one falls further behind
            until someone else kills it — which still counts toward the{" "}
            {status?.citizenSupply ?? "—"} → 69 endgame, so killed emigrants stay listed.
          </p>
        </div>
      </div>

    </div>
  );
}
