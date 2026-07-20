# Decision Log

## 2026-07-18 — Rebase PR #1

Rebase onto current upstream and update the PR head with `--force-with-lease`. Preserve upstream's audit-coupling reverts and keep survival bundles payment-only.

## 2026-07-18 — Automation scopes

Rename the persistent payment control to `defenseEnabled`. Persist JIT as an independent campaign with an explicit target epoch and explicit token IDs. Configuration saves do not start the engine; arming JIT may start it because that action is an execution command.

## 2026-07-18 — Transaction certainty

Release a nonce only on positive terminal evidence. Public and transport-ambiguous flights have no age-based expiry; private-only flights expire after their final target block. Persist enough signed-flight data to reconcile after restart.

Before replaying an authorized signed flight after a restart, reconcile at a coherent block and require the current balance to cover the configured floor plus maximum exposure across every live nonce. Keep blocked flights in the journal for a later funded retry.

Deduplicate pending game actions by their contract semantics, not only by transaction hash. A zero-value self-transfer replacement is permitted solely to retire a lower rejected nonce whose payment obligation is already covered while higher accepted work remains fenced.

## 2026-07-18 — Upgrade defaults

Version configuration independently from the application. Migrate legacy `enabled` to `defenseEnabled`. Treat exactly 10,800 seconds as the shipped legacy audit-buffer default and migrate it to 86,400 seconds; preserve every other customized value.

Default the advanced race-audit and race-kill controls off for clean installs.
Clamp the previously unbounded legacy automatic-payment cap to the contract's
seven-epoch maximum, and canonicalize decimal token IDs on every load/save.

## 2026-07-18 — RPC and local-mode authority

Never let viem select an undeclared default RPC. Environment-owned endpoint,
mode, and key settings remain authoritative; dashboard mutations cannot silently
override them. Local direct-broadcast mode rejects chain ID 1 and runtime Alchemy
key replacement. Owned-token pagination is independent of the offense candidate
cap. Because the wallet-control API has no client authentication, bind it only to
`127.0.0.1`, `localhost`, or `::1`; reject non-loopback hosts at configuration load.

## 2026-07-18 — Release version

Ship the safety and local API changes as 0.3.0. Do not perform live financial QA automatically.

Release archives are built only from a clean commit and must agree with every manifest and lockfile version. Support the Node 20, 22, and 24+ release lines accepted by the build toolchain; verify portable persistence on Windows without claiming POSIX permission bits there.

## 2026-07-20 — Direct builder incentives

Treat direct `block.coinbase` payments as a separate, disabled-by-default feature,
not a synonym for raising the ordinary gas tip. The game owner checks rule out a
wrapper for owner-scoped calls; the viable design is a trailing transaction to a
verified stateless payer inside a declared private cohort.

Implement that cohort only as an optional suffix to already prepared mandatory
boundary payments. Mandatory payments remain fail-closed in whole-bundle
simulation and retain public fallback. Optional audits may be explicitly
allowlisted to revert privately and retain their authorized public fallback. The
single final bid is also revertible so it cannot invalidate a payment, but is
strictly private, has finite target/journal lifetime, and is never independently
replayed. Private size limits include the complete cohort or none of it.

Capability verification requires both default-off switches, explicit
acknowledgement of any risk increase, private mainnet mode on verified chain ID 1,
a healthy journal, a positive fixed amount, and exact deployed-runtime equality
with the reproducibly compiled, pinned `CoinbasePayer` artifact. A public-to-mainnet
mode change that can reactivate persisted switches requires the same explicit
acknowledgement and revalidates the candidate chain and payer before saving.
Capability does not imply current execution: the engine must also be running and
unlocked, Dry Run must be off, pre-boundary payment must be enabled, and a mandatory
payment must be due. Migrations force the activation switches off even when
they preserve a staged legacy amount/address. Automated and disposable-Anvil QA
do not constitute live financial QA. No direct payment is represented as
guaranteeing inclusion, block position, transaction ordering, or audit success.
See `docs/builder-incentives.md`.
