import { useEffect, useState, useCallback } from "react";
import {
  VERSION,
  type BotStatus,
  type StrategySnapshot,
  type ActivityEntry,
  type OwnedTokenStatus,
  type TargetTokenStatus,
} from "@dat-bot/shared";
import { ApiError, api } from "./api.js";
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
  const [strategy, setStrategy] = useState<StrategySnapshot | null>(null);
  const [tokens, setTokens] = useState<OwnedTokenStatus[]>([]);
  const [targets, setTargets] = useState<TargetTokenStatus[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.getConfig().then(setStrategy).catch(() => {});
  }, []);

  // A strategy mutation from another client is announced on the status socket.
  // Refresh the matching config before trusting an older local snapshot.
  useEffect(() => {
    if (
      status?.strategyRevision === undefined
      || strategy === null
      || status.strategyRevision <= strategy.revision
    ) return;
    api.getConfig().then((fresh) => {
      setStrategy((current) => current === null || fresh.revision >= current.revision ? fresh : current);
    }).catch(() => {});
  }, [status?.strategyRevision, strategy?.revision]);

  const refresh = useCallback(async () => {
    try {
      const [t, g] = await Promise.all([api.tokens().catch(() => []), api.targets().catch(() => [])]);
      setTokens(t);
      setTargets(g);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 20000);
    return () => clearInterval(id);
  }, [refresh]);

  const running = status?.running ?? false;
  // Prefer whichever authoritative channel carries the newer strategy revision.
  // This keeps an own mutation accurate while WS is stale/disconnected and also
  // prevents an old config snapshot from masking a newer live-fire WS update.
  const strategyIsNewest = strategy !== null
    && (status === null || strategy.revision >= status.strategyRevision);
  const dryRun = strategyIsNewest ? strategy.config.dryRun : status?.dryRun ?? true;
  // Only link to Etherscan on mainnet (chainId 1) — a local/anvil fork's hashes
  // aren't there, so fall back to plain text in that case.
  const explorerBase = status?.chainId === 1 ? "https://etherscan.io" : null;

  const config = strategy?.config ?? null;
  const pinnedSet = new Set(config?.offenseTargetTokenIds ?? []);
  const myTargets = targets.filter((t) => pinnedSet.has(t.tokenId));
  const otherTargets = targets.filter((t) => !pinnedSet.has(t.tokenId));

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

  const [dryToggling, setDryToggling] = useState(false);
  const toggleDryRun = async () => {
    const next = !dryRun;
    // Guard the risky direction only: going live submits real transactions.
    if (!next && !confirm("Switch to LIVE FIRE? Real transactions will be submitted with real ETH.")) return;
    setDryToggling(true);
    setToggleErr(null);
    try {
      if (!strategy) throw new Error("Strategy configuration is still loading");
      const snapshot = await api.setConfig(strategy.revision, { dryRun: next });
      setStrategy(snapshot);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 409 || e.status === 503)) {
        try {
          const authoritative = await api.getConfig();
          setStrategy(authoritative);
          setToggleErr(e.status === 409
            ? "Configuration changed elsewhere; refreshed it. Review the current mode and try again."
            : "The configuration may have been applied but durability was not confirmed; refreshed authoritative state. The engine remains paused.");
          return;
        } catch {
          // Fall through to the original mutation error when refetch also fails.
        }
      }
      setToggleErr((e as Error).message);
    } finally {
      setDryToggling(false);
    }
  };

  return (
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>

      {/* ── Main column ── */}
      <div style={{ flex: "1 1 0", minWidth: 0 }}>

        <div className="topbar">
          <div className="brand">
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
          <div className="row wrap">
            <span
              className={`badge ${dryRun ? "dry" : "danger"}`}
              role="button"
              tabIndex={0}
              onClick={dryToggling ? undefined : toggleDryRun}
              onKeyDown={(e) => { if (!dryToggling && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); void toggleDryRun(); } }}
              title={dryRun ? "Dry-run: simulating only. Click to go LIVE FIRE." : "LIVE FIRE: real transactions. Click to return to dry-run."}
              style={{
                cursor: dryToggling ? "wait" : "pointer",
                userSelect: "none",
                opacity: dryToggling ? 0.6 : 1,
                fontSize: 15,
                fontWeight: 700,
                letterSpacing: "0.04em",
                padding: "8px 18px",
                borderWidth: 2,
              }}
            >
              {dryRun ? "DRY-RUN" : "⚠ LIVE FIRE"}
            </span>
            <span className={`badge ${running ? "on" : "off"}`}>{running ? "RUNNING" : "PAUSED"}</span>
            <button className={running ? "danger" : "primary"} onClick={toggleRun} disabled={toggling}>
              {toggling ? "…" : running ? "Pause bot" : "Start bot"}
            </button>
            {toggleErr && <span className="err" style={{ fontSize: 12 }}>{toggleErr}</span>}
            <button className="ghost" onClick={() => api.lock().then(() => location.reload())}>Lock</button>
          </div>
        </div>

        <div className="panel">
          <div className="row wrap" style={{ gap: 28 }}>
            <div className="stat"><span className="label">Balance</span><span className="value">{weiToEth(status?.balanceWei ?? null)} ETH</span></div>
            <div className="stat"><span className="label">Game</span><span className="value">{gameStateLabel(status?.gameState ?? null)}</span></div>
            <div className="stat"><span className="label">Epoch</span><span className="value">{status?.currentEpoch ?? "—"}</span></div>
            <div className="stat"><span className="label">Citizens left</span><span className="value">{status?.citizenSupply ?? "—"}</span></div>
            <div className="stat"><span className="label">Confirmed this epoch</span><span className="value">{weiToEth(status?.confirmedSpendThisEpochWei ?? status?.spentThisEpochWei ?? "0")} ETH</span></div>
            <div className="stat"><span className="label">Pending exposure</span><span className="value">{weiToEth(status?.pendingExposureWei ?? "0")} ETH</span></div>
            <div className="stat"><span className="label">Journal</span><span className="value">{status?.journalHealthy === false ? "⚠ error" : "healthy"}</span></div>
            <div className="stat"><span className="label">Block</span><span className="value mono">{status?.lastBlock ?? "—"}</span></div>
          </div>
        </div>
        {status?.journalHealthy === false && (
          <p className="err">Transaction journal error: {status.journalError ?? "unknown error"}. New live submissions are unsafe until this is resolved.</p>
        )}

        <div className="spacer" />
        <JitPanel
          status={status}
          tokens={tokens}
          strategy={strategy}
          onStrategyChange={setStrategy}
          onStatusChange={pushStatus}
        />

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
              <thead><tr><th>Token</th><th>Paid</th><th>Status</th><th>Audit expires</th><th>Bribes</th><th>Pay est.</th></tr></thead>
              <tbody>
                {tokens.map((t) => {
                  const current = BigInt(t.lastEpochPaid) >= BigInt(t.currentEpoch);
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
          {strategy && <Config initial={strategy} onChange={setStrategy} />}

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

      {/* ── Right sidebar: Rival Targets ── */}
      <div className="panel" style={{ width: 380, flexShrink: 0, position: "sticky", top: 20 }}>
        <h2>Rival targets</h2>
        <div className="muted" style={{ ...sectionLabel, marginBottom: 4 }}>My rivals ({myTargets.length})</div>
        <TargetsTable rows={myTargets} empty="No pinned rivals — add token IDs in Config." />
        <div className="spacer" />
        <div className="muted" style={{ ...sectionLabel, marginBottom: 4 }}>Others ({otherTargets.length})</div>
        <TargetsTable rows={otherTargets} empty="No other delinquent/killable rivals found." />
      </div>

    </div>
  );
}
