# Reliability Roadmap

## Milestone 0.3.0 — PR #1 reliability refactor

Status: awaiting owner QA

User-visible outcome: reliable first-boundary payment automation with explicit spending scope, durable recovery, accurate status, and safe configuration updates.

Dependencies: current `upstream/master`, Node 20.19+/22.12+/24+, and Foundry/Anvil for the contract integration fixture.

Risks: provider ambiguity, nonce gaps in large campaigns, corrupt local state, epoch rollover during delayed callbacks, and stale dashboard writes.

Automated gate: backend model/unit/integration tests, web component tests, Anvil boundary tests, production builds, and `git diff --check` pass on Node 20, Node 22, and Node 24, with persistence/build coverage on Windows.

Local gate (2026-07-19): dependency audit/tree, 297 backend tests, 7 web tests,
3 Anvil integration tests, 10 consecutive Anvil integration reruns, typecheck,
production build, and diff checks passed. Exact-head Node/Windows CI must be
rerun after these working-tree changes are committed and pushed.

Owner gate: complete `docs/qa/pr-1-reliability.md` without a funded wallet or explicitly defer the gate.

Excluded: merging the PR, sending live transactions, and reintroducing payment-plus-audit bundle coupling.
