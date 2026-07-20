# Decision Log

## 2026-07-18 — Rebase PR #1

Rebase onto current upstream and update the PR head with `--force-with-lease`. Preserve upstream's audit-coupling reverts and keep survival bundles payment-only.

## 2026-07-18 — Automation scopes

Rename the persistent payment control to `defenseEnabled`. Persist JIT as an independent campaign with an explicit target epoch and explicit token IDs. Configuration saves do not start the engine; arming JIT may start it because that action is an execution command.

## 2026-07-18 — Transaction certainty

Release a nonce only on positive terminal evidence. Any signed raw disclosed to a
public RPC, relay, or builder has no age-based expiry, even after a private target
or on-chain value window ends. Only a preparation proven never to have crossed an
external-dispatch boundary may expire. Persist enough signed-flight data and
same-nonce lineage to reconcile after restart.

Before replaying an authorized signed flight after a restart, reconcile at a coherent block and require the current balance to cover the configured floor plus maximum exposure across every live nonce. Keep blocked flights in the journal for a later funded retry.

Deduplicate pending game actions by their contract semantics, not only by
transaction hash. A zero-value self-transfer replacement is permitted only for a
durable cleanup purpose: retiring a covered lower game-action gap ahead of accepted
work, or consuming an expired builder-incentive nonce before reuse. It is WAL-first,
floor/fee-capped, and never private builder work.

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
strictly private, has a finite value/target window, and is never independently
replayed. Its signed `payCoinbase(notBeforeTimestamp, validThroughBlock)` calldata
enforces the payment boundary and last target on-chain; transport narrows or
omits a stale bid rather than extending the authorization. Private size limits
include the complete cohort or none of it.

Capability verification requires both default-off switches, explicit
acknowledgement of any risk increase, private mainnet mode on verified chain ID 1,
a healthy journal, a positive fixed amount, and exact deployed-runtime equality
at the finalized chain tag with the reproducibly compiled, pinned `CoinbasePayer`
artifact. A public-to-mainnet
mode change that can reactivate persisted switches requires the same explicit
acknowledgement and revalidates the candidate chain and payer before saving.
Capability does not imply current execution: the engine must also be running and
unlocked, Dry Run must be off, pre-boundary payment must be enabled, and a mandatory
payment must be due. Migrations force the activation switches off even when
they preserve a staged legacy amount/address. Automated and disposable-Anvil QA
do not constitute live financial QA. No direct payment is represented as
guaranteeing inclusion, block position, transaction ordering, or audit success.
The block check expires value transfer, not the Ethereum transaction itself: a
retained expired raw transaction can still revert later and consume its nonce and
bounded gas. The bot keeps that lineage and its maximum same-nonce exposure fenced,
then publicly retires it with a WAL-first zero-value same-nonce transaction before
reuse. The payer cannot enforce success of preceding game calls against a builder
that ignores bundle semantics; configured builders are therefore an explicit trust
boundary.
See `docs/builder-incentives.md`.

## 2026-07-20 — Durable confirmed-spend attribution

Price a finalized transaction from its actual receipt and resolve the game epoch
at the receipt's block. Write one immutable `{epoch, spendWei}` annotation into
the confirmed WAL tombstone before changing runtime/UI accounting. Retain those
annotations through their mined epoch, rebuild the exact deduplicated total after
Lock/restart, and remove them only after a coherent chain view advances past that
epoch. A delayed receipt is never attributed to the epoch in which it was
discovered.
