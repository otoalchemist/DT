# Reliability Roadmap

## Milestone 0.3.0 — PR #1 reliability refactor

Status: awaiting owner QA

User-visible outcome: reliable first-boundary payment automation with explicit spending scope, durable recovery, accurate status, and safe configuration updates.

Dependencies: current `upstream/master`, Node 20.19+/22.12+/24+, and Foundry/Anvil for the contract integration fixture.

Risks: provider ambiguity, nonce gaps in large campaigns, corrupt or concurrently
opened local state, epoch rollover during delayed callbacks, stale dashboard
writes, and mixed dashboard/backend releases.

Automated gate: backend model/unit/integration tests (including journal recovery
and exclusive `DATA_DIR` ownership), web component tests (including both
mixed-version directions, armed-JIT authority, and uncertain activity), Anvil
boundary tests, production builds, and `git diff --check` pass on Node 20, Node
22, and Node 24, with persistence/build coverage on Windows.

Historical local gate (2026-07-19, before subsequent working-tree changes): dependency audit/tree, 297 backend tests, 7 web tests,
3 Anvil integration tests, 10 consecutive Anvil integration reruns, typecheck,
production build, and diff checks passed. Exact-head Node/Windows CI must be
rerun after these working-tree changes are committed and pushed.

Owner gate: complete `docs/qa/pr-1-reliability.md` from the exact reviewed commit,
including exclusive `DATA_DIR` operation, armed-JIT authority display, and the
mixed-release bootstrap checks, without a funded wallet; otherwise explicitly
record a deferral. This milestone remains awaiting that evidence.

Excluded from the owner gate: merging the PR, deploying a mainnet payer, enabling
the direct incentive, or sending live/funded transactions. Combined boundary
cohorts are tested with models and disposable Anvil only.

## Milestone 0.3.0 — Opt-in builder incentives

Status: implemented, disabled by default, and awaiting the exact-head automated
and owner QA gates. No mainnet deployment or live financial QA is claimed.

The implemented combined path starts only from one or more mandatory boundary
payments. Payments keep their ordinary public fallback. Optional audits follow,
are explicitly revertible in the private bundle, and keep public fallback when
the offense/race policy authorizes it. A single final `builder-incentive` is
private-only, on-chain bounded to its signed timestamp/block window, cohort-journaled, and
never independently replayed.
If the complete cohort would exceed private count, byte, or gas limits, none of
that cohort is sent privately; public-authorized work retains its normal route
and the bid is omitted.

Release gates cover exact compiler comparison of the pinned stateless
`CoinbasePayer` creation/runtime bytecode, mainnet chain and deployed-runtime
verification, healthy journal, explicit risk acknowledgement,
balance/spend accounting, dry-run side-effect freedom, simulation allowlisting,
replacement/retirement behavior, signed-window calldata/WAL consistency, and
Foundry/disposable-Anvil deadline behavior. An operator
may consider a separately reviewed deployment only after following
`docs/builder-incentives.md`. A bid can affect builder economics but never
guarantees inclusion, placement, or ordering.
