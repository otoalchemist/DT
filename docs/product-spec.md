# DeathAndTaxes Automation Reliability Specification

## Outcome

Version 0.3.0 must protect an unlocked wallet's selected citizens at epoch boundaries without broadening spending authority, reusing an uncertain nonce, or losing pending liabilities across ticks and restarts.

## Required behavior

- Persistent defense, optional offense, and one-shot JIT campaigns are independent controls.
- A JIT campaign applies only to its explicit token IDs and explicit future epoch.
- Required payments are prepared as one nonce-ordered campaign and delivered at the boundary without per-token waiting.
- A payment priced for an old epoch is replaced immediately at the same nonce.
- Public or ambiguous delivery remains reserved until positive terminal evidence exists.
- Private-only delivery expires only after every target block is past.
- Pending value and worst-case gas remain reserved against the balance floor across ticks and restarts.
- Crash recovery rechecks the current balance and configured floor against all live nonce liabilities before any signed transaction is replayed.
- Unresolved bribe, audit, and kill actions are semantically deduplicated across ticks and restarts; pending audits continue to reserve their auditor's capacity.
- If an externally covered payment leaves a rejected lower nonce ahead of accepted work, a floor-checked same-nonce filler may retire only that gap.
- Survival payments never depend on optional audit or kill work.
- Future-timestamp and offense transactions are never submitted without successful semantic simulation.
- Direct builder incentives and combined boundary cohorts are implemented but
  disabled by default. Migration cannot enable either authority bit.
- An enabled combined cohort begins with at least one mandatory boundary payment.
  Mandatory payments fail closed in private simulation and keep public fallback;
  optional audits are explicitly revertible privately and keep public fallback
  when authorized; the single final builder incentive is revertible,
  private-only, finite-target, and never independently replayed.
- A declared cohort is privately delivered only when every member fits the
  private transaction-count, encoded-byte, and aggregate-gas limits. Otherwise
  no cohort member is privately sent, public-authorized work keeps its ordinary
  route, and the incentive is omitted.
- Builder-incentive activation requires private mainnet mode, verified chain ID
  1, a healthy journal, explicit risk acknowledgement, positive fixed amount,
  balance/spend authorization, and exact equality with the pinned stateless
  `CoinbasePayer` runtime.
- Configuration, campaign state, and transaction flights are versioned and written atomically under `DATA_DIR`.
- No implicit public RPC is permitted. Local direct-broadcast mode refuses chain
  ID 1, and environment-owned endpoints/mode/key cannot be replaced at runtime.
- Owned-Citizen enumeration is complete and independent of the bounded offense
  candidate sweep; every indexed ID is re-authorized with current `ownerOf`.

## Exclusions

- No live-wallet or mainnet transaction is part of automated or owner QA.
- Automated and owner QA do not deploy or enable a mainnet builder incentive and
  do not establish bid competitiveness, relay acceptance, inclusion, placement,
  transaction ordering, or financial performance.
- The bot remains a single-wallet, single-process application.

## Acceptance criteria

The unit, integration, web, Anvil, build, package, Windows persistence, and
committed-range whitespace checks pass; restart recovery cannot allocate or replay
over an unresolved unaffordable flight or a withdrawn payment cap; JIT cannot
activate defense or unselected payments; the reproducible builder-incentive bytecode,
default-off migration, capability gates, spend accounting, cohort/revert routing,
private-limit atomicity, and no-public-bid recovery policy pass their automated
and disposable-Anvil checks; and owner QA passes or is explicitly deferred.
