import { useState } from "react";
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
      await api.unlock(passphrase);
      onUnlocked();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const existing = hasKeystore || createdAddr;

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
              Private key (0x…)
              <input
                type="password"
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                placeholder="0x…"
              />
            </label>
          )}
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

      {error && <p className="err">{error}</p>}

      <div className="row" style={{ marginTop: 8 }}>
        {!existing ? (
          <button className="primary" disabled={busy || passphrase.length < 8} onClick={create}>
            {busy ? "Creating…" : "Create keystore"}
          </button>
        ) : (
          <button className="primary" disabled={busy || !passphrase} onClick={unlock}>
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
