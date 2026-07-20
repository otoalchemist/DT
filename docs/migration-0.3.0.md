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
- Automatic killing remains disabled unless the legacy file explicitly enabled
  it; upgrading a partial offense configuration never grants new kill authority.
- Direct builder incentives never become active through migration. Clean and
  versioned upgrades initialize `coinbaseBidEnabled` and
  `combinedBoundaryBundle` to `false`. A valid amount/address found in a legacy
  flat configuration may be retained as staged data, but both authority bits are
  reset and require a new explicit risk acknowledgement.

Version 0.3.0 implements the optional combined boundary cohort, but it remains
disabled by default. When separately enabled, at least one mandatory boundary
payment leads the cohort and keeps public fallback; optional audits are
revertible privately and keep an authorized public fallback; the one final
builder incentive is revertible, private-only, on-chain bounded to its signed
`notBeforeTimestamp`/`validThroughBlock` window, and never recovered as an
independent public transaction. A
cohort that does not fit the private
count, byte, or gas limits is excluded from private delivery as a whole. This
mechanism does not guarantee inclusion, block position, ordering, or audit
success.

Do not enable it merely to complete an upgrade. First complete the no-funded-wallet
QA gate, run the exact compiler comparison, independently review and deploy the
recorded `CoinbasePayer` creation bytecode, wait for deployment finality, verify
its finalized on-chain runtime byte-for-byte and by the pinned hash, keep Dry Run on,
and require the loopback capability endpoint/dashboard to report the expected
mainnet payer, bid, and verified capability. The operator-specific deployment,
exact runtime verification, and switch-disable procedure are in
[`builder-incentives.md`](builder-incentives.md). Deployment and funded
mainnet validation are operator actions outside release/owner QA.

Any payer deployed from an earlier pre-release artifact that accepted an
empty-calldata value transfer is incompatible with this release. Do not enable it
or attempt to recover its old bid WAL as if it had an on-chain expiry. Deploy and
verify the currently pinned
`payCoinbase(notBeforeTimestamp, validThroughBlock)` artifact instead.

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

Keep a custom `DATA_DIR` outside the repository because only the default in-tree state paths are covered by `.gitignore`. Treat the whole directory as secret: it can contain a plaintext dashboard-saved provider key and replayable raw signed transactions as well as wallet/reputation-key material. Treat it as exclusive to one running backend; use a distinct directory, port, and keystore for every concurrent instance. Treat the wallet signer as exclusive too: while the bot is running or its journal contains unresolved flights, do not use MetaMask, another script, or another process to submit from that wallet. Stop and lock the bot and wait for every pending flight to finalize and clear before signing elsewhere. The curated rival-target asset remains part of the application package and no longer needs to be copied into a custom state directory.

The local configuration API now uses revisioned, field-scoped writes. Integrations must read the current strategy or JIT revision before mutating it and handle HTTP 409 by refetching. JIT arm requests must send a future `targetEpoch` and a nonempty explicit `tokenIds` list.

If a versioned configuration or submission journal is corrupt or from an unsupported schema version, the bot stops automation and reports the recovery error. Restore the backup or repair the file before unlocking live execution; do not delete an unresolved transaction journal without first reconciling the wallet nonce and pending transactions.
