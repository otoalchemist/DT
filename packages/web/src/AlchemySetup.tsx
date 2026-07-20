import { useState } from "react";
import { api } from "./api.js";

interface Props {
  onSaved: () => void;
  localMode?: boolean;
  rpcConfigured?: boolean;
  ownershipConfigured?: boolean;
}

export function AlchemySetup({
  onSaved,
  localMode = false,
  rpcConfigured = false,
  ownershipConfigured = false,
}: Props) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.saveAlchemyKey(key.trim());
      onSaved();
    } catch (e) {
      try {
        if ((await api.getSettings()).setupReady) {
          onSaved();
          return;
        }
      } catch {
        // Preserve the original mutation error when the refetch also fails.
      }
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (localMode) {
    return (
      <div className="center panel">
        <h2>Complete local setup</h2>
        <div className="warnbox">
          {!rpcConfigured && (
            <p>
              No local RPC endpoint is configured. Set <span className="mono">RPC_HTTP_URL</span>
              {" "}to your Anvil or other non-mainnet RPC.
            </p>
          )}
          {!ownershipConfigured && (
            <p>
              Citizen ownership enumeration is not configured. Set <span className="mono">OWNED_TOKENS</span>
              {" "}(recommended for an Anvil fork) or <span className="mono">ALCHEMY_NFT_URL</span>.
            </p>
          )}
          <p>
            Restart the bot after updating the environment. Runtime Alchemy-key changes are disabled in
            local mode so they cannot swap the local client to mainnet.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="center panel">
      <h2>Connect to Alchemy</h2>

      <div className="warnbox">
        This bot needs an RPC endpoint plus a way to enumerate your Citizens.
        An <b>Alchemy API key</b> configures both for the normal mainnet setup.
        Create a free key at{" "}
        <span className="mono">alchemy.com</span>, then paste it below.
        Your key is stored locally and is sent only as part of requests to the
        configured Alchemy endpoints. Local/custom installations that set
        RPC_HTTP_URL and OWNED_TOKENS in the environment bypass this step.
      </div>
      <div className="spacer" />

      <label className="field">
        Alchemy API key
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="paste your key here"
          autoFocus
        />
      </label>

      {error && <p className="err">{error}</p>}

      <div className="row" style={{ marginTop: 8 }}>
        <button
          className="primary"
          disabled={busy || key.trim().length < 10}
          onClick={save}
        >
          {busy ? "Saving…" : "Save & continue"}
        </button>
      </div>

      <p className="hint" style={{ marginTop: 12 }}>
        You can change this key later in the Config tab.
      </p>
    </div>
  );
}
