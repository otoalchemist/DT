import { useEffect, useState } from "react";
import { api } from "./api.js";
import { useSocket } from "./useSocket.js";
import { AlchemySetup } from "./AlchemySetup.js";
import { Setup } from "./Setup.js";
import { Dashboard } from "./Dashboard.js";

export function App() {
  const { status, activity, connected, pushStatus } = useSocket();
  const [keystore, setKeystore] = useState<{ exists: boolean; address: string | null } | null>(null);
  const [alchemyKeySet, setAlchemyKeySet] = useState<boolean | null>(null);
  const [checked, setChecked] = useState(false);

  const refreshKeystore = () => api.keystore().then(setKeystore);

  useEffect(() => {
    Promise.all([
      api.getSettings().then((s) => setAlchemyKeySet(s.alchemyKeySet)),
      refreshKeystore(),
    ]).finally(() => setChecked(true));
  }, []);

  const unlocked = status?.unlocked ?? false;

  if (!checked) {
    return (
      <div className="app">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  // Step 1: Alchemy RPC key must be configured first.
  if (!alchemyKeySet) {
    return (
      <div className="app">
        <AlchemySetup onSaved={() => setAlchemyKeySet(true)} />
      </div>
    );
  }

  // Step 2: Wallet setup / unlock.
  if (!unlocked) {
    return (
      <div className="app">
        <Setup
          hasKeystore={keystore?.exists ?? false}
          keystoreAddress={keystore?.address ?? null}
          onUnlocked={() => api.status().catch(() => {})}
        />
      </div>
    );
  }

  // Step 3: Main dashboard.
  return (
    <div className="app">
      <Dashboard status={status} activity={activity} connected={connected} pushStatus={pushStatus} />
    </div>
  );
}
