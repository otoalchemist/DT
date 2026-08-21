import { useEffect, useState } from "react";
import { api } from "./api.js";
import { shortAddr } from "./util.js";

interface Props {
  hasKeystore: boolean;
  keystoreAddress: string | null;
  onUnlocked: () => void;
}

// First-run: create an encrypted keystore (import or generate a burner), then unlock.
export function Setup({ hasKeystore, keystoreAddress, onUnlocked }: Props) {
  const [mode, setMode] = useState<"generate" | "import">("generate");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdAddr, setCreatedAddr] = useState<string | null>(null);

  const create = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await api.createKeystore({
        mode,
        privateKey: mode === "import" ? privateKey.trim() : undefined,
        passphrase,
      });
      setCreatedAddr(r.address);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const unlock = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.unlock(passphrase, accessCode);
      onUnlocked();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const existing = hasKeystore || createdAddr;
  // Only prompt for the team code on a build that gates it — a fork running with
  // BOT_ACCESS_CODE_OFF=1 should not ask for something it will never check.
  const [gated, setGated] = useState(false);
  // The roster gate needs no input from the user, so it is surfaced only as an
  // expectation to set BEFORE they try — the server does the actual checking, and its
  // rejection lands in `error` below.
  const [allyGated, setAllyGated] = useState(false);
  const [accessCode, setAccessCode] = useState("");
  useEffect(() => {
    void api
      .accessGate()
      .then((g) => {
        setGated(g.required);
        setAllyGated(g.allyGate);
      })
      .catch(() => {
        setGated(false);
        setAllyGated(false);
      });
  }, []);

  return (
    <div className="center panel">
      <h2>{existing ? "Unlock wallet" : "Create hot wallet"}</h2>

      <div className="warnbox">
        This bot holds a hot-wallet key on <b>this machine</b>. Use a dedicated
        burner funded only with what you're willing to spend. Life insurance in
        this game is cosmetic — only paying taxes / clearing audits keeps a token alive.
      </div>
      <div className="spacer" />

      {!existing && (
        <>
          <label className="field">
            Key source
            <select value={mode} onChange={(e) => setMode(e.target.value as "generate" | "import")}>
              <option value="generate">Generate a new burner</option>
              <option value="import">Import existing private key</option>
            </select>
          </label>
          {mode === "import" && (
            <label className="field">
              Private key (64 hex chars — 0x prefix optional)
              <input
                type="password"
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                placeholder="0x… or bare hex"
              />
            </label>
          )}
          <div className="warnbox">
            <b>This wallet must hold your Citizen tokens.</b> The bot can only pay
            taxes for and defend Citizens owned by the wallet it unlocks.
            {mode === "import"
              ? " Import the private key of the wallet that actually holds your Citizens."
              : " A freshly generated burner owns no Citizens — you'd have to transfer your Citizens into its address first. To protect Citizens you already hold, choose “Import existing private key” instead."}
          </div>
        </>
      )}

      {existing && (
        <p className="muted">
          Keystore for <span className="mono">{shortAddr(keystoreAddress ?? createdAddr)}</span>
        </p>
      )}

      <label className="field">
        Passphrase {existing ? "" : "(min 8 chars, encrypts the key at rest)"}
        <input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder="passphrase"
        />
      </label>

      {gated && existing && (
        <label>
          Team access code
          <input
            type="password"
            value={accessCode}
            onChange={(e) => setAccessCode(e.target.value)}
            placeholder="the code you were given"
          />
          <span className="hint">
            This build is gated to the team. The code is separate from your wallet passphrase —
            it does not unlock your key, it just gates this build.
          </span>
        </label>
      )}

      {allyGated && existing && (
        <p className="hint">
          This build also checks the chain on unlock: the wallet must hold at least one
          Citizen on the team roster. Nothing to enter — if your token is not on the list
          yet, ask for it to be added, then restart the bot.
        </p>
      )}

      {error && <p className="err">{error}</p>}

      <div className="row" style={{ marginTop: 8 }}>
        {!existing ? (
          <button className="primary" disabled={busy || passphrase.length < 8} onClick={create}>
            {busy ? "Creating…" : "Create keystore"}
          </button>
        ) : (
          <button className="primary" disabled={busy || !passphrase || (gated && !accessCode)} onClick={unlock}>
            {busy ? "Unlocking…" : "Unlock"}
          </button>
        )}
      </div>

      {createdAddr && !hasKeystore && (
        <p className="hint">Keystore created. Enter the same passphrase and unlock.</p>
      )}
    </div>
  );
}
