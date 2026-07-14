import { useEffect, useState, useCallback } from "react";
import type {
  BotStatus,
  StrategyConfig,
  ActivityEntry,
  OwnedTokenStatus,
  TargetTokenStatus,
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
  const [tokens, setTokens] = useState<OwnedTokenStatus[]>([]);
  const [targets, setTargets] = useState<TargetTokenStatus[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.getConfig().then(setConfig).catch(() => {});
  }, []);

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
  const dryRun = status?.dryRun ?? true;

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

  return (
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>

      {/* ── Main column ── */}
      <div style={{ flex: "1 1 0", minWidth: 0 }}>

        <div className="topbar">
          <div className="brand">
            Death &amp; Taxes Bot
            <small>{connected ? "● live" : "○ reconnecting…"} · {shortAddr(status?.address)}</small>
          </div>
          <div className="row wrap">
            <span className={`badge ${dryRun ? "dry" : "danger"}`}>{dryRun ? "DRY-RUN" : "LIVE FIRE"}</span>
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
            <div className="stat"><span className="label">Spent this epoch</span><span className="value">{weiToEth(status?.spentThisEpochWei ?? "0")} ETH</span></div>
            <div className="stat"><span className="label">Block</span><span className="value mono">{status?.lastBlock ?? "—"}</span></div>
          </div>
        </div>

        <div className="spacer" />
        <JitPanel status={status} tokens={tokens} />

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
          {config && <Config initial={config} />}

          <div className="panel">
            <h2>Activity</h2>
            <div className="log">
              {activity.length === 0 && <p className="muted">No activity yet.</p>}
              {[...activity].reverse().map((e) => (
                <div className="log-row" key={e.id}>
                  <span className="time">{timeAgo(e.ts)} ago</span>
                  <span className={`pill ${e.status}`}>{e.status}</span>
                  <span>{e.message}</span>
                </div>
              ))}
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
