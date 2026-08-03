import { useState } from "react";
import type { BotStatus } from "@dat-bot/shared";
import { api } from "./api.js";
import { weiToEth, shortAddr } from "./util.js";

/**
 * Hot wallets holding the bot's citizens.
 *
 * payTaxes / audit / useBribe are owner-only on-chain, so a citizen can only be acted on
 * by the wallet that holds it — there is no delegation path. That is why every wallet's
 * key lives here rather than one wallet acting for the rest, and why each needs its own
 * gas: the min-balance floor is enforced per wallet.
 *
 * All wallets share one passphrase, so a single unlock opens them all.
 */
export function Wallets({ status }: { status: BotStatus | null }) {
  const wallets = status?.wallets ?? [];
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"import" | "generate">("import");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const reset = () => {
    setPrivateKey("");
    setPassphrase("");
    setLabel("");
    setErr(null);
  };

  const add = async () => {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const r = await api.addWallet({
        mode,
        privateKey: mode === "import" ? privateKey.trim() : undefined,
        passphrase,
        label: label.trim() || undefined,
      });
      setNote(
        r.generated
          ? `Generated ${r.label} (${shortAddr(r.address)}). Fund it before it can pay or audit.`
          : `Added ${r.label} (${shortAddr(r.address)}).`,
      );
      reset();
      setOpen(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (address: string, walletLabel: string) => {
    // Removing discards the key permanently — anything only that wallet can sign for
    // becomes unmanageable, so make the consequence explicit rather than just "are you sure".
    const ok = window.confirm(
      `Remove ${walletLabel} (${address})?\n\n` +
        `Its encrypted key is DELETED from the keystore. The bot will stop paying and ` +
        `auditing with every citizen this wallet holds, and you will need the private key ` +
        `again to re-add it. Any ETH in the wallet is untouched but no longer reachable ` +
        `from the bot.`,
    );
    if (!ok) return;
    setBusy(true);
    setErr(null);
    try {
      await api.removeWallet(address);
      setNote(`Removed ${walletLabel}.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>Wallets ({wallets.length})</h2>

      {wallets.length === 0 ? (
        <p className="muted" style={{ fontSize: 12 }}>Unlock to see the wallets in the keystore.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Wallet</th><th>Address</th><th>Balance</th><th /></tr>
          </thead>
          <tbody>
            {wallets.map((w, i) => (
              <tr key={w.address}>
                <td>
                  {w.label}
                  {i === 0 && (
                    <span
                      className="badge"
                      style={{ fontSize: 9, marginLeft: 6 }}
                      title="The primary wallet funds the coinbase bid — one bid buys position for the whole bundle, however many wallets contributed transactions to it."
                    >
                      primary
                    </span>
                  )}
                </td>
                <td className="mono" style={{ fontSize: 11 }}>{shortAddr(w.address)}</td>
                <td
                  style={{ color: w.balanceWei !== null && BigInt(w.balanceWei) === 0n ? "var(--red)" : undefined }}
                  title="Each wallet pays its own gas, so the min-balance floor is checked per wallet — an empty one cannot pay or audit even if another is full."
                >
                  {weiToEth(w.balanceWei)} ETH
                </td>
                <td>
                  {wallets.length > 1 && (
                    <button
                      className="ghost"
                      style={{ fontSize: 11, padding: "2px 8px" }}
                      disabled={busy}
                      onClick={() => void remove(w.address, w.label)}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {note && <p style={{ fontSize: 11, color: "var(--green)", margin: "8px 0 0 0" }}>{note}</p>}
      {err && <p className="err" style={{ fontSize: 11, margin: "8px 0 0 0" }}>{err}</p>}

      {!open ? (
        <button className="ghost" style={{ marginTop: 10 }} onClick={() => setOpen(true)} disabled={!status?.unlocked}>
          + Add wallet
        </button>
      ) : (
        <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          <div className="row" style={{ gap: 14, marginBottom: 8 }}>
            <label className="check" style={{ fontSize: 12 }}>
              <input type="radio" checked={mode === "import"} onChange={() => setMode("import")} />
              Import an existing key
            </label>
            <label className="check" style={{ fontSize: 12 }}>
              <input type="radio" checked={mode === "generate"} onChange={() => setMode("generate")} />
              Generate a new one
            </label>
          </div>

          {mode === "import" && (
            <label className="field">
              Private key
              <input
                type="password"
                autoComplete="off"
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                placeholder="0x… (64 hex characters)"
                style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}
              />
            </label>
          )}

          <label className="field">
            Label (optional)
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="cold-1" />
          </label>

          <label className="field">
            Keystore passphrase
            <input
              type="password"
              autoComplete="off"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="the passphrase you unlock with"
            />
          </label>

          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="primary" onClick={() => void add()} disabled={busy || passphrase.length < 8}>
              {busy ? "Adding…" : mode === "generate" ? "Generate & add" : "Add wallet"}
            </button>
            <button className="ghost" onClick={() => { setOpen(false); reset(); }} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <p className="muted" style={{ fontSize: 11, margin: "10px 0 0 0", lineHeight: 1.5 }}>
        A citizen can only be paid or audited by the wallet that holds it — that is enforced
        on-chain, so every wallet needs its own key here and its own ETH for gas. All wallets
        share one passphrase, so one unlock opens them all, and their transactions go out in a
        single bundle with one coinbase bid rather than competing with each other.
      </p>
    </div>
  );
}
