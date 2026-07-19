# Migrating to 0.3.0

Back up `DATA_DIR` before upgrading, then run `npm ci` and `npm run build`.

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

Keep a custom `DATA_DIR` outside the repository because only the default in-tree state paths are covered by `.gitignore`. The curated rival-target asset remains part of the application package and no longer needs to be copied into a custom state directory.

The local configuration API now uses revisioned, field-scoped writes. Integrations must read the current strategy or JIT revision before mutating it and handle HTTP 409 by refetching. JIT arm requests must send a future `targetEpoch` and a nonempty explicit `tokenIds` list.

If a versioned configuration or submission journal is corrupt or from an unsupported schema version, the bot stops automation and reports the recovery error. Restore the backup or repair the file before unlocking live execution; do not delete an unresolved transaction journal without first reconciling the wallet nonce and pending transactions.
