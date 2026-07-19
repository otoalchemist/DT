# Reliability Roadmap

## Milestone 0.3.0 — PR #1 reliability refactor

Status: awaiting owner QA

User-visible outcome: reliable first-boundary payment automation with explicit spending scope, durable recovery, accurate status, and safe configuration updates.

Dependencies: current `upstream/master`, Node 20.19+/22.12+/24+, and Foundry/Anvil for the contract integration fixture.

Risks: provider ambiguity, nonce gaps in large campaigns, corrupt local state, epoch rollover during delayed callbacks, and stale dashboard writes.

Automated gate: backend model/unit/integration tests, web component tests, Anvil boundary tests, production builds, and `git diff --check` pass on Node 20, Node 22, and Node 24, with persistence/build coverage on Windows.

Local gate (2026-07-18): clean lockfile install, dependency audit/tree, 263
backend tests, 7 web tests, 2 Anvil integration tests, typecheck, and production
build passed. The pushed PR CI remains authoritative for the Node/Windows matrix.

Owner gate: complete `docs/qa/pr-1-reliability.md` without a funded wallet or explicitly defer the gate.

Excluded: merging the PR, sending live transactions, and reintroducing payment-plus-audit bundle coupling.
