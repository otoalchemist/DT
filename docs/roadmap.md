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

Excluded: merging the PR, sending live transactions, and reintroducing payment-plus-audit bundle coupling.

## Future milestone — Capped builder incentives

Status: design/research only. Validate the reported competing transaction, then
implement the private-only, cohort-journaled `CoinbasePayer` design and safety
gates in `docs/builder-incentives.md`. Direct payments improve bundle economics;
they are not represented as guaranteeing top-of-block ordering.
