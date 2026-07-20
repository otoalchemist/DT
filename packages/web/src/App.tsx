import { useCallback, useEffect, useState } from "react";
import { VERSION, type BotStatus } from "@dat-bot/shared";
import { api, inspectBackendCompatibility, type AppSettingsStatus } from "./api.js";
import { useSocket } from "./useSocket.js";
import { AlchemySetup } from "./AlchemySetup.js";
import { Setup } from "./Setup.js";
import { Dashboard } from "./Dashboard.js";

export function App() {
  const [bootstrapStatus, setBootstrapStatus] = useState<BotStatus | null>(null);
  const [compatibilityError, setCompatibilityError] = useState<{
    backendVersion: string | null;
    reason: string;
  } | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [keystore, setKeystore] = useState<{ exists: boolean; address: string | null } | null>(null);
  const [settings, setSettings] = useState<AppSettingsStatus | null>(null);
  const [checked, setChecked] = useState(false);
  const compatible = bootstrapStatus !== null && compatibilityError === null;
  const { status: socketStatus, activity, connected, pushStatus } = useSocket(compatible);

  useEffect(() => {
    let cancelled = false;
    setChecked(false);
    setBootstrapStatus(null);
    setCompatibilityError(null);
    setBootstrapError(null);
    setSettings(null);
    setKeystore(null);

    void api.compatibility()
      .then(async (result) => {
        if (cancelled) return;
        if (!result.compatible) {
          setCompatibilityError({
            backendVersion: result.backendVersion,
            reason: result.reason,
          });
          setChecked(true);
          return;
        }

        // Version/schema compatibility is established before either endpoint is
        // consumed; their payloads are release-coupled to the checked status.
        const [nextSettings, nextKeystore] = await Promise.all([
          api.getSettings(),
          api.keystore(),
        ]);
        if (cancelled) return;
        setBootstrapStatus(result.status);
        setSettings(nextSettings);
        setKeystore(nextKeystore);
        setChecked(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setBootstrapError(error instanceof Error ? error.message : String(error));
        setChecked(true);
      });
    return () => { cancelled = true; };
  }, [bootstrapAttempt]);

  const retryBootstrap = useCallback(() => {
    setBootstrapAttempt((attempt) => attempt + 1);
  }, []);

  const liveCompatibility = socketStatus === null
    ? null
    : inspectBackendCompatibility(socketStatus);
  const liveMismatch = liveCompatibility && !liveCompatibility.compatible
    ? liveCompatibility
    : null;
  const status = liveCompatibility?.compatible
    ? liveCompatibility.status
    : bootstrapStatus;

  const unlocked = status?.unlocked ?? false;

  if (!checked) {
    return (
      <div className="app">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  const mismatch = liveMismatch ?? compatibilityError;
  if (mismatch) {
    return (
      <div className="app">
        <div className="panel center compatibility-block" role="alert">
          <h1>Dashboard/backend mismatch</h1>
          <p>{mismatch.reason}</p>
          <p className="muted">
            Dashboard: v{VERSION} · Backend: {mismatch.backendVersion ? `v${mismatch.backendVersion}` : "legacy/unknown"}
          </p>
          <p>Stop the old process, rebuild, and restart the backend and dashboard from the same release.</p>
          <button className="primary" onClick={retryBootstrap}>Check again</button>
        </div>
      </div>
    );
  }

  if (bootstrapError) {
    return (
      <div className="app">
        <div className="panel center compatibility-block" role="alert">
          <h1>Cannot verify backend compatibility</h1>
          <p>The dashboard is blocked until it can verify the backend release and status schema.</p>
          <p className="err">{bootstrapError}</p>
          <button className="primary" onClick={retryBootstrap}>Try again</button>
        </div>
      </div>
    );
  }

  // Step 1: Alchemy RPC key must be configured first.
  if (!settings?.setupReady) {
    return (
      <div className="app">
        <AlchemySetup
          localMode={settings?.mode === "local"}
          onSaved={() => { void api.getSettings().then(setSettings); }}
        />
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
          onUnlocked={() => { void api.status().then(pushStatus).catch(() => {}); }}
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
