# Migrating to 0.3.0

Use Node.js 20.19+, 22.12+, or 24+. Upgrade one installation in this order:

1. Pause the bot, then stop the old backend/dashboard processes and wait for them
   to exit. Confirm no other process is using this installation's `DATA_DIR`.
   Never run old and new backends concurrently against the same directory.
2. Back up the complete `DATA_DIR` while it is offline.
3. Install and build the selected release with `npm ci` and `npm run build`.
4. Start the backend and dashboard from that same release. The dashboard blocks
   before consuming release-coupled settings when the backend version or bootstrap
   status schema does not match; stop, rebuild, and restart both sides rather than
   bypassing that page.

Before enabling live fire, run the automated and owner gates documented in
[`qa/pr-1-reliability.md`](qa/pr-1-reliability.md). A previous release's test
results do not establish the gate for a changed checkout.

On first startup, the bot atomically migrates the old flat strategy file to the versioned 0.3.0 envelope:

- `enabled` becomes `defenseEnabled`.
- Legacy JIT state is kept only when it already names an explicit target epoch and explicit token IDs; an old empty-ID "all owned" campaign is disarmed rather than broadening authority.
- An audit buffer equal to the shipped legacy default, 10,800 seconds, becomes
  86,400 seconds. Other custom values are preserved except for normalization to
  current contract limits and canonical decimal token IDs.
- Replacement priority-fee caps are materialized from the previously effective static/dynamic settings.
- A legacy `maxAutoPayEpochs` above the contract-supported limit is clamped to 7,
  matching the prior effective `prepayEpochs` ceiling.
- Race-audit and race-kill remain enabled only when they were explicitly present
  in a legacy file; clean 0.3.0 installations default both advanced races off.

UI-saved settings now live at `<DATA_DIR>/settings.json`. When `DATA_DIR` differs from the repository default, the old settings file is copied once and retained as a migration backup.

`MODE` and `ALCHEMY_API_KEY` are dashboard-mutable only when they are not supplied
by the environment. Explicit RPC/WS/NFT endpoint overrides remain authoritative.
Local mode refuses Ethereum mainnet chain ID 1 and runtime Alchemy-key replacement.

The wallet-control API is loopback-only in 0.3.0. `HOST` must be `127.0.0.1`,
`localhost`, or `::1`; remove `API_ALLOWED_HOSTS` from existing environments.
Startup now fails clearly for LAN and wildcard binds instead of treating a Host
allowlist as client authentication. Any reverse proxy serving the dashboard must
also listen only on loopback. Remove LAN/public listeners, port forwarding, and
external tunnels, and do not rewrite a non-loopback `Host` or `Origin` as a
loopback value.

Keep a custom `DATA_DIR` outside the repository because only the default in-tree state paths are covered by `.gitignore`. Treat it as exclusive to one running backend; use a distinct directory, port, and keystore for every concurrent instance. The curated rival-target asset remains part of the application package and no longer needs to be copied into a custom state directory.

The local configuration API now uses revisioned, field-scoped writes. Integrations must read the current strategy or JIT revision before mutating it and handle HTTP 409 by refetching. JIT arm requests must send a future `targetEpoch` and a nonempty explicit `tokenIds` list.

If a versioned configuration or submission journal is corrupt or from an unsupported schema version, the bot stops automation and reports the recovery error. Restore the backup or repair the file before unlocking live execution; do not delete an unresolved transaction journal without first reconciling the wallet nonce and pending transactions.
