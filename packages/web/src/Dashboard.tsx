import { useEffect, useState, useCallback } from "react";
import {
  VERSION,
  EMIGRATION_CONTRACT_ADDRESS,
  ABBC_EMIGRATION_CONTRACT_ADDRESS,
  type BotStatus,
  type StrategyConfig,
  type ActivityEntry,
  type OwnedTokenStatus,
  type TargetTokenStatus,
  type EmigratedTokenStatus,
  type BigBoyStatus,
} from "@dat-bot/shared";
import { api } from "./api.js";
import { Config } from "./Config.js";
import { JitPanel } from "./JitPanel.js";
import { PostMortem } from "./PostMortem.js";
import { TargetScores } from "./TargetScores.js";
import { Wallets } from "./Wallets.js";
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

/**
 * `onAudit` makes the "auditable" badge itself the button, rather than adding a column of
 * buttons that would be empty on almost every row — most rivals are current or already under
 * audit, and only the auditable ones can be acted on at all. The badge already marks exactly
 * that set, so it is the natural affordance.
 *
 * Absent when the wallet is locked or the game is not live, in which case the badge renders as
 * a plain label: a button that always answers "unlock first" is worse than no button.
 */
function TargetsTable({
  rows,
  empty,
  onAudit,
  busy,
}: {
  rows: TargetTokenStatus[];
  empty: string;
  onAudit?: (tokenId: string) => void;
  busy?: string | null;
}) {
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
                    ? onAudit
                      ? (
                        <button
                          className="badge warn"
                          style={{ cursor: "pointer", font: "inherit", padding: "1px 6px" }}
                          disabled={busy === t.tokenId}
                          onClick={() => onAudit(t.tokenId)}
                          title={`Audit #${t.tokenId} now, at the network's normal gas price — no coinbase bid and not the boundary-race tip, because nothing is contesting this. Costs 0.00069 ETH plus gas, uses one audit slot, and starts its 24h kill clock. An auditor is chosen from your citizens automatically.`}
                        >
                          {busy === t.tokenId ? "auditing…" : "auditable ▸ audit"}
                        </button>
                      )
                      : <span className="badge warn">auditable</span>
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
 * Citizens that emigrated: sent to an Emigration contract, swapped for a membership NFT,
 * and held there permanently. They're out of the main game — we never pay, audit or kill
 * them — so this table deliberately carries no action affordance and mutes every badge.
 *
 * The roster is the full emigration history, so it includes emigrants that have ALREADY
 * been killed (rows go dim). Listing only the ones still held would shrink the count as
 * they die — the panel would have read 5 when 13 had emigrated. The live rows still show
 * a status because it's the only clue to when each remaining emigrant gets killed by
 * someone else and drops out of the supply that ends the game.
 *
 * Grouped by ROUTE (Governor, ABBC, …) rather than listed flat: there is now more than one
 * destination, they have separate capacities, and "which club did it join" is the thing you
 * actually want to read off the panel. Grouping also means a third route needs no UI work.
 */
function EmigratedTable({ rows }: { rows: EmigratedTokenStatus[] }) {
  if (rows.length === 0) {
    return <p className="muted" style={{ fontSize: 12 }}>No citizens have emigrated yet.</p>;
  }
  // Preserve first-seen (chronological) route order, so the original Governor route stays
  // on top and later ones append below it.
  const byRoute = new Map<string, EmigratedTokenStatus[]>();
  for (const r of rows) {
    const list = byRoute.get(r.destinationLabel) ?? [];
    list.push(r);
    byRoute.set(r.destinationLabel, list);
  }
  const fate = (t: EmigratedTokenStatus) =>
    !t.alive
      ? "killed"
      : t.killable
        ? "awaiting kill"
        : t.auditDueTimestamp !== "0"
          ? `dies in ${countdown(Number(t.auditDueTimestamp) - Math.floor(Date.now() / 1000))}`
          : "unaudited";
  return (
    <>
      {[...byRoute.entries()].map(([label, list]) => {
        const aliveCount = list.filter((t) => t.alive).length;
        return (
          <div key={label} style={{ marginBottom: 8 }}>
            <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>
              {label} ({list.length}) · {aliveCount} held · {list.length - aliveCount} killed
            </div>
            <table>
              <thead><tr><th>Token</th><th>Behind</th><th>Fate</th></tr></thead>
              <tbody>
                {list.map((t) => (
                  <tr key={t.tokenId} style={t.alive ? undefined : { opacity: 0.55 }}>
                    <td className="mono">#{t.tokenId}</td>
                    <td>{t.alive && t.epochsBehind > 0 ? `${t.epochsBehind}` : "—"}</td>
                    <td><span className="badge off">{fate(t)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}

/**
 * The big boys, grouped under the operator who runs each citizen. Same status columns as the
 * rivals table — they ARE rivals and full targets — and the operator tag is the point: it
 * turns a list of bare ids into "that one is Graveyard's" when reading the board.
 *
 * Deliberately NOT greyed. This roster used to be do-not-target and every row was dimmed to
 * say "don't bother"; the team attacks them now, so dimming would misreport the strategy.
 */
function BigBoysTable({ rows }: { rows: BigBoyStatus[] }) {
  if (rows.length === 0) {
    return <p className="muted" style={{ fontSize: 12 }}>None listed (see data/big-boys.json).</p>;
  }
  const byOperator = new Map<string, BigBoyStatus[]>();
  for (const r of rows) {
    const list = byOperator.get(r.operator) ?? [];
    list.push(r);
    byOperator.set(r.operator, list);
  }
  return (
    <>
      {[...byOperator.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([operator, list]) => (
          <div key={operator} style={{ marginBottom: 8 }}>
            <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>
              <span className="badge" style={{ fontSize: 9 }}>{operator}</span>{" "}
              {list.length} citizen{list.length === 1 ? "" : "s"}
            </div>
            <TargetsTable rows={list} empty="" />
          </div>
        ))}
    </>
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
  const [allies, setAllies] = useState<TargetTokenStatus[]>([]);
  const [bigBoys, setBigBoys] = useState<BigBoyStatus[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // Result of a manual default-list re-pull, shown until the next press. Separate from
  // `err` because an update is good news, not a failure.
  const [listNote, setListNote] = useState<string | null>(null);

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
        // A manual press also re-pulls the curated lists from master, so a user who
        // notices a roster is out of date has a way to fix it without restarting. Not
        // done on the 20s poll — that would hit GitHub every 20 seconds to re-fetch
        // files that change a few times a week.
        const lists = await api.refreshLists().catch(() => null);
        if (lists?.outcomes.some((o) => o.result === "updated")) {
          const files = lists.outcomes.filter((o) => o.result === "updated").map((o) => o.file);
          setListNote(
            `Default lists updated from master: ${files.join(", ")}` +
              (lists.repointed ? " — offense targets re-pointed at the new skippers list." : "."),
          );
        } else {
          setListNote(null);
        }
        const s = await api.refreshChain().catch(() => null);
        if (s) pushStatus(s);
        // Pins may have moved, so the Config view's saved baseline is now stale.
        if (lists?.repointed) await api.getConfig().then(onConfigSaved).catch(() => {});
      }
      // A failed read must NOT blank the panel. These used to catch to [], which was then
      // written to state — so one dropped request (a laptop suspending, a brief RPC
      // hiccup) replaced the citizen and rival lists with "none". In away mode there is
      // no 20s poll behind it to repair that, so it stayed empty until Refresh data was
      // pressed, which reads as "the bot lost my citizens". Keep the last good rows and
      // report the failure instead.
      const keep = <T,>(p: Promise<T>): Promise<T | null> => p.then((v) => v, () => null);
      const [t, g, e, a, bb] = await Promise.all([
        keep(api.tokens()),
        keep(api.targets()),
        keep(api.emigrated()),
        keep(api.allies()),
        keep(api.bigBoys()),
      ]);
      if (t) setTokens(t);
      if (g) setTargets(g);
      if (e) setEmigrated(e);
      if (a) setAllies(a);
      if (bb) setBigBoys(bb);
      const failed = [t, g, e, a, bb].filter((v) => v === null).length;
      setErr(
        failed === 0
          ? null
          : `${failed} of 5 reads failed — showing the last good data. Press "Refresh data" to retry.`,
      );
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [pushStatus, onConfigSaved]);

  // Poll on-chain views only while the tab is actually being looked at. Each cycle costs
  // several RPC round-trips per endpoint, so a dashboard left open in a background tab
  // was burning provider quota around the clock for a page nobody was reading.
  //
  // In away mode it stops polling entirely — that's the point of the mode. One read on
  // mount so the page isn't blank, then nothing until "Refresh data" is pressed.
  // Away mode IS the autonomous mode: it arms payments itself, since nobody is at the
  // keyboard to do it. One switch, so there is no state where it wakes to do nothing.
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
  // away rather than staging an edit for "Save strategy". It changes whether the engine
  // runs at all, so a state that looked armed but wasn't saved would silently miss a
  // boundary. The backend re-arms/cancels the wake timer on every config POST.
  const [awayBusy, setAwayBusy] = useState(false);
  const [awayErr, setAwayErr] = useState<string | null>(null);
  const persistAway = async (patch: Partial<StrategyConfig>) => {
    setAwayBusy(true);
    setAwayErr(null);
    try {
      // onConfigSaved keeps any edits still pending in the Strategy/Payment panels, so
      // toggling away mode never clobbers (or silently commits) their unsaved work.
      onConfigSaved(await api.setConfig(patch));
    } catch (e) {
      setAwayErr((e as Error).message);
    } finally {
      setAwayBusy(false);
    }
  };

  // The lead-minutes box is typed into, so it can't persist per keystroke. Hold a draft
  // while focused and commit on blur/Enter; `null` means "no draft, show the live value".
  const [leadDraft, setLeadDraft] = useState<string | null>(null);
  const leadMinutes = config?.awayLeadMinutes ?? 15;
  const commitLead = () => {
    const draft = leadDraft;
    setLeadDraft(null);
    if (draft === null) return;
    const n = Math.min(720, Math.max(1, Math.floor(Number(draft) || leadMinutes)));
    if (n !== leadMinutes) void persistAway({ awayLeadMinutes: n });
  };

  // Only link to Etherscan on mainnet (chainId 1) — a local/anvil fork's hashes
  // aren't there, so fall back to plain text in that case.
  const explorerBase = status?.chainId === 1 ? "https://etherscan.io" : null;

  // Emigrants still held by a contract. The rest of the roster is already dead — kept
  // on the list because emigrating is what put them there, and the count is the history.
  const emigratedAlive = emigrated.filter((e) => e.alive).length;
  // "Slots left" is a GOVERNOR-only idea: that contract has a fixed supply of 36. Counting
  // it against the whole roster would let ABBC emigrations eat Governor slots that are
  // still open. ABBC has no published cap, so it gets no slot count rather than a guess.
  const governorSlotsLeft = 36 - emigrated.filter((e) => e.destinationLabel === "Governor").length;
  // "At risk" = anything an opponent could act on: already under audit, killable, or
  // auditable right now. Merely 1 behind is still in the grace epoch.
  const alliesAtRisk = allies.filter((a) => a.killable || a.auditDueTimestamp !== "0" || a.auditable).length;

  const pinnedSet = new Set(config?.offenseTargetTokenIds ?? []);
  const myTargets = targets.filter((t) => pinnedSet.has(t.tokenId));
  // "Others" is the actionable tail only. Fully paid-up rivals now come back from
  // readTargets too (they used to be dropped, which made the pane impossible to reconcile
  // against citizens-left), but they get a count rather than a row each: there is nothing
  // to do about a current rival, so listing them would be noise.
  const otherAll = targets.filter((t) => !pinnedSet.has(t.tokenId));
  const otherTargets = otherAll.filter(
    (t) => t.delinquent || t.killable || t.auditDueTimestamp !== "0",
  );
  const currentRivals = otherAll.length - otherTargets.length;
  // How much offense the coming boundary actually offers.
  //
  // A citizen already under audit cannot be audited again, so it never counts however far
  // behind it is. "Next boundary" is everything 1+ epoch behind: each rolls one deeper
  // when the epoch turns, so that set includes the ones auditable right now — and it is
  // what the bot can actually queue into the boundary bundle.
  const auditableNextIn = (rows: TargetTokenStatus[]) =>
    rows.filter((t) => t.auditDueTimestamp === "0" && t.epochsBehind >= 1).length;

  // Big boys are routed to their own section by readTargets, so add them back for the
  // board-wide count — but a PINNED one is already in `targets` (readTargets checks the pin
  // first, so it lands under My rivals). Concatenating blindly counted those twice, so
  // dedupe by tokenId.
  const board = new Map<string, TargetTokenStatus>();
  for (const t of [...targets, ...bigBoys]) board.set(t.tokenId, t);
  const totalAuditableNext = auditableNextIn([...board.values()]);

  // What the bot will actually go after. With pins, that is exactly the My rivals
  // table — pinned big boys are already in it, so no second list to merge. Blank means
  // "audit every delinquent rival discovered", which excludes the roster: it stays out
  // of auto-discovery, and a pin is the only override.
  const myAuditableNext = pinnedSet.size > 0 ? auditableNextIn(myTargets) : auditableNextIn(targets);
  // Slots are the scarce resource, not targets: an owned citizen audits at most
  // `auditLimit` times per epoch, and auditor-role citizens carry more than one.
  const auditCapacity = tokens.reduce((n, t) => n + (t.auditLimit ?? 1), 0);
  // Auditable RIGHT NOW and not already under audit — the set the buttons can act on. Distinct
  // from totalAuditableNext, which counts what becomes auditable when the epoch turns.
  const auditableNow = [...board.values()].filter((t) => t.auditable && t.auditDueTimestamp === "0").length;

  /**
   * Manual audits. Same confirm-then-submit shape as the token actions below, because this also
   * spends real ETH the moment it is confirmed: 0.00069 ETH per audit plus gas, and it burns an
   * audit slot that cannot be recovered this epoch.
   */
  const [auditBusy, setAuditBusy] = useState<string | null>(null);
  const [auditMsg, setAuditMsg] = useState<{ text: string; err: boolean } | null>(null);
  const runAudit = async (tokenId: string) => {
    if (!confirm(
      `Audit rival #${tokenId} now?

` +
      `Sends a REAL transaction at the network's normal gas price — no coinbase bid and not the ` +
      `boundary-race tip, since nothing is contesting this block.

` +
      `Costs 0.00069 ETH plus gas, uses one of your audit slots for this epoch, and starts a 24h ` +
      `clock after which anyone can kill #${tokenId} unless it pays or spends a bribe.`,
    )) return;
    setAuditBusy(tokenId);
    setAuditMsg(null);
    try {
      const res = await api.auditRival(tokenId);
      setAuditMsg({ text: res.message, err: false });
      await refresh();
    } catch (e) {
      setAuditMsg({ text: (e as Error).message, err: true });
    } finally {
      setAuditBusy(null);
    }
  };
  const runAuditAll = async () => {
    if (!confirm(
      `Audit every auditable rival, up to your ${auditCapacity} audit slot(s)?

` +
      `Sends one REAL transaction per rival at normal network gas — 0.00069 ETH each plus gas.

` +
      `Stops when the slots run out, so with more auditable rivals than slots the rest are left ` +
      `alone and reported.`,
    )) return;
    setAuditBusy("all");
    setAuditMsg(null);
    try {
      const res = await api.auditAll();
      setAuditMsg({ text: res.message, err: !res.ok });
      await refresh();
    } catch (e) {
      setAuditMsg({ text: (e as Error).message, err: true });
    } finally {
      setAuditBusy(null);
    }
  };

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
              {/* Distinct from the badge above: that one means backend and dashboard
                  disagree with each OTHER, this one means both are behind the release.
                  Worth its own line — a stale bot silently misses fixes it already has
                  waiting, and the launcher's updater cannot say so while running. */}
              {status?.updateAvailable && status.latestVersion && (
                <span
                  className="version-warn"
                  title={`You are running v${status.version}; v${status.latestVersion} has been released. Restart the bot to pick it up — the launcher installs it automatically. (If you run from a git clone, use "git pull" instead; the auto-updater deliberately skips checkouts.)`}
                >
                  {" "}· ⚠ update available: v{status.latestVersion}
                </span>
              )}
            </small>
          </div>
          <div className="row" style={{ flex: "0 0 auto", gap: 12 }}>
            <span className={`badge status-lg ${running ? "on" : "off"}`}>{running ? "● RUNNING" : "PAUSED"}</span>
            {awayMode && (
              // The countdown itself lives on the Start button, so this badge just states
              // the mode — two countdowns side by side would be noise.
              <span
                className="badge warn"
                title={
                  awayScheduled
                    ? `Away mode: engine idle, no RPC polling. Starts itself ${config?.awayLeadMinutes ?? 15} min before the boundary, runs through it, then idles again 5 min after.`
                    : awayIdleNoWork
                      ? "Away mode on, but nothing is armed to wake for — arm a JIT payment or enable offense."
                      : "Away mode: this is the boundary window, so the engine is running. It will idle again shortly after the boundary."
                }
              >
                AWAY · AUTO{awayIdleNoWork ? " · nothing armed" : ""}
              </span>
            )}
            <button
              className="ghost"
              onClick={() => void refresh(true)}
              // Redundant ONLY when both halves are already self-updating: the dashboard
              // polls every 20s whenever away mode is off, and the engine tick rewrites
              // the header stats (epoch, balance, block) every block while running. With
              // the engine stopped those stats go stale even though the lists keep
              // polling, so the button stays live there.
              disabled={selfRefreshing}
              title={
                selfRefreshing
                  ? "Already refreshing: the dashboard polls every 20s and the running engine updates epoch/balance each block."
                  : "Read on-chain data once, now — the header stats only update while the engine runs. Also re-pulls the curated default lists (rivals, skippers, allies, big boys) from master."
              }
            >
              Refresh data
            </button>
            <button
              className={`start-cta ${running ? "danger" : awayScheduled ? "" : "primary attention"}`}
              onClick={toggleRun}
              // With a wake scheduled the bot starts itself, so Start is not the user's
              // job — showing it live would invite a press that fights the schedule.
              // Pause stays live: stopping a running bot is always the user's call.
              disabled={toggling || awayScheduled}
              title={
                awayScheduled
                  ? `Away mode is managing the bot. It starts itself ${config?.awayLeadMinutes ?? 15} min before the epoch boundary, runs through it, then idles again 5 min after.`
                  : awayIdleNoWork
                    ? "Away mode is on but nothing is armed to wake for — arm a JIT payment or enable offense. You can still start manually."
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

` +
                      `Autonomous: it arms payments itself when a citizen falls behind, paying on the "Payment + Audit Epoch" bid and dropping back to the "Audit Only Epoch" bid on quiet epochs. Both are set under Coinbase bid — while this is on, they are spent without a keypress.` +
                      `

Mid-epoch work is still missed: kill deadlines fall 24h after an audit, not on a boundary. Click to turn off.`
                    : "Away/Autonomous OFF — the engine runs continuously (~22 provider requests/minute) and the dashboard polls every 20s. Click to idle between epochs and wake only for the boundary, which is also what makes unattended operation possible. Applies immediately; no save needed."
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
                          ? `Held by ${t.walletLabel} (${t.walletAddress}). Paying or auditing this citizen is owner-only on-chain, so it is signed by — and spends gas from — this wallet.`
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
          {listNote && <p className="muted" style={{ fontSize: 12 }}>{listNote}</p>}
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
        <TargetScores
          currentEpoch={status?.currentEpoch ?? null}
          // Must mirror resolveGas(): the offense tip only applies when separateOffenseGas
          // is on. With it off, audits ride the PAYMENT tip — reading offensePriorityFeeGwei
          // unconditionally priced the bundle at a tip the bot wasn't going to bid, which
          // overstated every beat figure (the gap is charged across the whole bundle gas).
          tipGwei={
            (config?.separateOffenseGas ? config?.offensePriorityFeeGwei : config?.priorityFeeGwei) ?? 20.1
          }
          ownedCitizens={tokens.length}
          // Sum of auditLimit, not tokens.length: auditor-role citizens carry more than
          // one slot, so a wallet's real capacity is usually above its citizen count.
          // Falls back to 1 per citizen for rows read before auditLimit was fetched.
          auditCapacity={auditCapacity}
        />

        <div className="spacer" />
        <PostMortem />

      </div>

      {/* ── Right sidebar: Rival Targets + Emigrated ── */}
      <div style={{ width: 380, flexShrink: 0, position: "sticky", top: 20 }}>
        <div className="panel">
          <h2>Rival targets</h2>
          <div
            style={{ display: "flex", gap: 14, alignItems: "baseline", margin: "0 0 10px 0", fontSize: 12, flexWrap: "wrap" }}
            title={
              `My target audits: what the bot will actually go after at the coming boundary. Big boys count like any other rival — the roster only groups them in their own panel.` +
              (pinnedSet.size === 0
                ? ` Your target list is blank, which means "audit every delinquent rival discovered" — big boys included.`
                : ``) +
              `\n\nTotal: every delinquent rival on the board, pinned or not, big boys included.` +
              `\n\nBoth count citizens 1+ epoch behind (they roll one deeper when the epoch turns) and exclude any already under audit, which cannot be audited again until it resolves.` +
              `\n\nYou hold ${auditCapacity} audit slot(s) this epoch, so that is the most you can act on.`
            }
          >
            <span>
              <b style={{ fontSize: 18, color: "var(--amber)" }}>{myAuditableNext}</b>{" "}
              <span className="muted">my target audits next boundary</span>
            </span>
            {/* A blank target list means "audit every delinquent rival", not "audit
                nobody" — pinnedTargetSet() returns null and every offense filter treats
                null as unfiltered. A bare number here reads as a selection, so say
                outright that there is no selection and this is the whole field. */}
            {pinnedSet.size === 0 && (
              <span
                className="badge warn"
                style={{ fontSize: 10, padding: "1px 6px" }}
                title="Your target list is empty, which the engine reads as “audit every delinquent rival discovered” — not “audit none”. Big boys stay excluded (a pin is the only way to include one). Pin token IDs in Strategy to narrow it."
              >
                no pins · all rivals
              </span>
            )}
            <span className="muted">{totalAuditableNext} total auditable</span>
            <span className="muted">· {auditCapacity} slot{auditCapacity === 1 ? "" : "s"}</span>
            {/* Only shown when there is something to audit AND a wallet to audit with — a
                button that can only fail is worse than no button. */}
            {auditableNow > 0 && status?.unlocked && (
              <button
                className="badge warn"
                style={{ cursor: "pointer", font: "inherit", padding: "1px 6px" }}
                disabled={auditBusy !== null}
                onClick={runAuditAll}
                title={`Audit all ${auditableNow} auditable rival(s) now, at normal network gas, bounded by your ${auditCapacity} audit slot(s) this epoch. 0.00069 ETH each plus gas.`}
              >
                {auditBusy === "all" ? "auditing…" : `audit all ${auditableNow}`}
              </button>
            )}
          </div>
          {auditMsg && (
            <div className={auditMsg.err ? "err" : "hint"} style={{ fontSize: 11, margin: "2px 0 6px 0" }}>
              {auditMsg.text}
            </div>
          )}
          <div className="muted" style={{ ...sectionLabel, marginBottom: 4 }}>My rivals ({myTargets.length})</div>
          <TargetsTable rows={myTargets} empty="No pinned rivals — add token IDs in Config." onAudit={status?.unlocked ? runAudit : undefined} busy={auditBusy} />
          <p className="muted" style={{ fontSize: 11, margin: "4px 0 0 0", lineHeight: 1.5 }}>
            Pinned rivals always appear here, even while paid up. Everything below is
            shown only while it's delinquent, under audit, or killable.
          </p>
          <div className="spacer" />
          <div className="muted" style={{ ...sectionLabel, marginBottom: 4 }}>Others ({otherTargets.length})</div>
          <TargetsTable rows={otherTargets} empty="No other delinquent/killable rivals found." onAudit={status?.unlocked ? runAudit : undefined} busy={auditBusy} />
          {currentRivals > 0 && (
            <p
              className="muted"
              style={{ fontSize: 11, margin: "4px 0 0 0", lineHeight: 1.5 }}
              title="Live rivals that are fully paid up — nothing to audit, so they get no row. Counted here so the panel adds up to the citizens still in the game."
            >
              + {currentRivals} rival{currentRivals === 1 ? "" : "s"} fully paid up (no row — nothing to act on)
            </p>
          )}

          <div className="spacer" />
          <div className="muted" style={{ ...sectionLabel, marginBottom: 4 }}>
            Big Boys ({bigBoys.length})
          </div>
          <BigBoysTable rows={bigBoys} />
          <p className="muted" style={{ fontSize: 11, margin: "6px 0 0 0", lineHeight: 1.5 }}>
            From <code>data/big-boys.json</code>, tagged with the operator who runs them.
            The heavyweight operators, attacked as a coordinated team — they are <b>full
            targets</b>, scored and ranked like any other rival. The roster only gives them
            their own section here so they aren't listed twice. Several defend at the top of
            the boundary block, so check <b>Analyze targets</b> for what beating one costs.
          </p>
        </div>

        <div className="spacer" />

        <div className="panel">
          <h2>Allied citizens ({allies.length})</h2>
          <div className="muted" style={{ ...sectionLabel, marginBottom: 4 }}>
            {alliesAtRisk > 0
              ? `${alliesAtRisk} at risk · ${allies.length - alliesAtRisk} safe`
              : "all safe"}
          </div>
          <TargetsTable rows={allies} empty="No allied citizens found (see data/ally-tokens.json)." />
          <p className="muted" style={{ fontSize: 11, margin: "8px 0 0 0", lineHeight: 1.5 }}>
            Teammates' citizens, from <code>data/ally-tokens.json</code>. They are <b>never</b>{" "}
            audited or killed by the bot and are excluded from Rival targets — a delinquent
            ally there would read as a kill candidate. Listed whatever their state, most at
            risk first, so you can spot an ally in trouble.
          </p>
        </div>

        <div className="spacer" />

        <div className="panel">
          <h2>Emigrated citizens ({emigrated.length})</h2>
          <div className="muted" style={{ ...sectionLabel, marginBottom: 6 }}>
            {emigratedAlive} still held · {emigrated.length - emigratedAlive} killed · {governorSlotsLeft} Governor slots left
          </div>
          <EmigratedTable rows={emigrated} />
          <p className="muted" style={{ fontSize: 11, margin: "8px 0 0 0", lineHeight: 1.5 }}>
            Traded away for a membership NFT — the{" "}
            {explorerBase
              ? <a href={`${explorerBase}/address/${EMIGRATION_CONTRACT_ADDRESS}`} target="_blank" rel="noreferrer">Governor</a>
              : "Governor"}{" "}
            route (36 total, first come) or{" "}
            {explorerBase
              ? <a href={`${explorerBase}/address/${ABBC_EMIGRATION_CONTRACT_ADDRESS}`} target="_blank" rel="noreferrer">ABBC</a>
              : "ABBC"}{" "}
            (anti bot bot club). Either way they've left the main game: the bot never audits
            or kills them, and they're excluded from Rival targets. Neither contract can pay
            taxes or spend a bribe, so each one falls further behind until someone else kills
            it — which still counts toward the{" "}
            {status?.citizenSupply ?? "—"} → 69 endgame, so killed emigrants stay listed.
          </p>
        </div>
      </div>

    </div>
  );
}
