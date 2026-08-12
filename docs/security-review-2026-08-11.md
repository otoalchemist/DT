# High-Level Security Review

- Date: 2026-08-11
- Repository: Death & Taxes Bot
- Review type: Read-only static review
- Reviewed snapshot: `ead9edf` (line references describe that snapshot)

> Post-review status: the automatic code updater, curated-list synchronizer, and
> background release check described in finding 6 were subsequently removed on the
> `union69skipbot` branch. The other findings remain open unless addressed separately.

## Overall assessment

This bot should not be run with meaningful funds until the API-control and transaction-lifecycle issues below are fixed. The default loopback binding helps, and key encryption is generally sensible, but the local wallet API is browser-reachable and several bookkeeping bugs can suppress critical retries.

## Priority findings

### 1. Critical when `HOST` is non-loopback: unauthenticated wallet-control API

Authentication is absent, and the Host guard is disabled entirely for non-loopback bindings ([api.ts:83](../packages/backend/src/api.ts#L83), [api.ts:92](../packages/backend/src/api.ts#L92)). The plain-HTTP API can change strategy, unlock or start the engine, submit transactions, replace settings, and overwrite or delete keystores.

Recommended remediation:

- Require authentication and TLS for any remote exposure.
- Refuse non-loopback startup unless authenticated transport is configured.
- Require current-passphrase reauthentication for destructive key operations.
- Create recoverable, atomic backups before replacing keystore data.

### 2. High: default localhost deployment is vulnerable to CSRF

The server checks `Host` but not `Origin`, Fetch Metadata, or a CSRF token. Bodyless `/api/start`, `/api/stop`, and `/api/lock` requests are cross-origin-sendable ([api.ts:377](../packages/backend/src/api.ts#L377)). When unlocked, `/api/start` immediately ticks; offense and automatic audits are enabled by default ([runtime.ts:176](../packages/backend/src/runtime.ts#L176), [strategy.ts:234](../packages/backend/src/strategy.ts#L234)). A malicious website could therefore trigger spending or repeatedly stop protection.

The WebSocket also accepts every Origin and exposes wallet balances and activity ([api.ts:671](../packages/backend/src/api.ts#L671)).

Recommended remediation:

- Add a per-launch session and CSRF token.
- Enforce strict `Origin` and `Sec-Fetch-Site` checks.
- Authenticate WebSocket upgrades and cap connections.
- Require a non-safelisted authenticated header on every mutation.

### 3. High: queued transactions are treated as successfully submitted

Mainnet batching returns `ok: true` before the bundle is flushed ([flashbots.ts:547](../packages/backend/src/flashbots.ts#L547)). JIT can then disarm immediately, while audit defense records a suppression marker ([strategy.ts:1788](../packages/backend/src/strategy.ts#L1788), [strategy.ts:1999](../packages/backend/src/strategy.ts#L1999)). Flush failure only changes activity records; it does not restore retry state ([strategy.ts:131](../packages/backend/src/strategy.ts#L131)).

A relay or public-RPC failure can therefore leave a citizen unpaid while the bot believes the action is complete.

Recommended remediation:

- Track distinct `queued`, `broadcast/relayed`, and `confirmed` states.
- Roll back suppression state following flush failure or bundle expiry.
- Re-read on-chain state and retry or reprice unconfirmed actions.
- Disarm JIT only after receipt or on-chain state confirms payment.

### 4. High: private-bundle nonces can be reused while still live

Reservation age is measured from the last on-chain nonce change, not reservation creation ([nonce.ts:18](../packages/backend/src/nonce.ts#L18), [nonce.ts:55](../packages/backend/src/nonce.ts#L55)). After 90 seconds of inactivity, a new private-only reservation is effectively stale immediately. The next block tick can sign another transaction with the same nonce while the first bundle remains valid for its second target block.

Recommended remediation:

- Track reservation creation or update timestamps directly.
- Prefer tracking each bundle's last eligible block plus a reorg margin.
- Add an idle-before-reservation regression test.
- Persist or conservatively quarantine unresolved reservations across restarts.

### 5. Medium-High: spending guardrails are not authoritative

Coinbase bids bypass `canSpend`, omit bid gas from accounting, and accept any syntactically valid payer address ([strategy.ts:763](../packages/backend/src/strategy.ts#L763), [flashbots.ts:382](../packages/backend/src/flashbots.ts#L382)). An unaffordable bid can invalidate the entire defensive bundle; an EOA or malicious payer simply keeps the ETH.

Multi-wallet proactive and JIT payments also check the primary wallet's balance but sign with the token's actual holder ([strategy.ts:1470](../packages/backend/src/strategy.ts#L1470), [strategy.ts:1918](../packages/backend/src/strategy.ts#L1918)). Gas-floor calculations differ from the dynamically priced transaction ultimately signed.

Recommended remediation:

- Perform one exact, payer-specific affordability check immediately before signing.
- Include transaction value, precise gas, current committed spend, and the configured balance floor.
- Pass the actual token-holder wallet to every owner-specific guard.
- Validate the Coinbase payer's deployed bytecode or approved code hash.

### 6. High-impact supply-chain trust gap — remediated on this branch

At review time, the launchers automatically replaced executable code from mutable `master`; verification checked only project shape and a self-declared version, not a signature or trusted digest. A repository or maintainer compromise could therefore become code execution in a process that later held decrypted keys.

Safety and target lists were independently replaced from mutable `master`, allowing targeting behavior to change without a release.

Remediation applied after the review:

- Deleted the executable updater and removed it from both launchers and npm scripts.
- Deleted startup and dashboard-triggered curated-list synchronization.
- Deleted the background release check and update-available dashboard state.
- Kept the bundled list files as local inputs; changing code or lists now requires an explicit operator-managed Git or release update.

This removes the automatic mutable-branch execution and targeting path. Manual updates still depend on the provenance of the selected Git commit or release, so immutable, signed release artifacts remain the stronger long-term distribution model.

Post-review verification completed successfully with a full workspace build and all 223 backend tests passing.

Recommended remediation:

- Distribute immutable release artifacts.
- Verify an offline-signed manifest containing the release commit and artifact hashes.
- Stage and atomically activate a complete verified tree.
- Sign and version list updates separately.
- Require approval for ally removals or other safety-reducing list changes.

### 7. Medium: documented example configuration targets do-not-target citizens

The README recommends copying `config.example.json` ([README.md:303](../README.md#L303)). That example is stamped with the current defaults version but pins `272`, `711`, `909`, and `4335`, all currently in `do-not-target.json`. Explicit pins intentionally override that roster ([strategy.ts:901](../packages/backend/src/strategy.ts#L901)), causing unwanted audits and gas spending.

The example also contains five ally IDs, which are currently stopped by the hard ally check, and omits several current skippers.

Recommended remediation:

- Generate the example from canonical current defaults and lists.
- Add CI invariants covering ally, rival, skipper, and do-not-target intersections.
- Avoid duplicating mutable target lists in a hand-copied configuration template.
- Consider a one-time migration for the exact stale-template fingerprint.

## Additional hardening

- Chain identification fails open to mainnet ID, while every transaction is signed for chain 1 without enforcing the RPC's identity ([chain.ts:101](../packages/backend/src/chain.ts#L101), [flashbots.ts:150](../packages/backend/src/flashbots.ts#L150)). Fail closed and verify the expected genesis and game-contract bytecode.
- `CoinbasePayer` ignores forwarding failure, leaving ETH withdrawable only by its deployer ([CoinbasePayer.sol:44](../contracts/CoinbasePayer.sol#L44)). Since the bid transaction is already allowed to revert, reverting on failed forwarding would protect the bidder.
- `.env` and plaintext `data/settings.json` can commonly be created as mode `0644`; use `0600` files and a `0700` data directory ([config.ts:29](../packages/backend/src/config.ts#L29)).
- Unlock uses synchronous scrypt without rate limiting, enabling online guessing and event-loop denial of service if the API is reachable.
- Validate complete on-disk strategy configuration rather than casting it to the expected type. Canonicalize and bound token-ID arrays before persistence.
- Add `Cache-Control: no-store`, stable redacted API errors, and structured security events for unlock failures, key changes, engine control, and strategy changes.

## Positive observations

- No obvious DOM-XSS, shell-injection, or token-approval abuse path was found.
- No live `.env`, settings, keystore, or Flashbots signer secret is tracked in the current tree.
- Keystore encryption uses random salts and IVs, scrypt, and AES-256-GCM.
- Keystore and Flashbots signer files request mode `0600` when first created.
- React-rendered backend strings are escaped, and external explorer links use fixed origins with `rel="noreferrer"`.
- The dependency lock uses integrity-protected HTTPS registry artifacts and has no external Git dependencies.

## Effect of running locally on a personal machine

Running the bot locally materially reduces some network and multi-user risks, but it does not correct transaction-lifecycle, nonce, guardrail, configuration, or upstream trust defects.

In this section, "running locally" means that the process runs on a personal computer while transacting on Ethereum mainnet. It does not mean the bot's `MODE=local`, which targets an Anvil fork and has a different risk profile.

| Finding | Effect of local operation |
| --- | --- |
| 1. Unauthenticated non-loopback API | **Largely mitigated** when `HOST=127.0.0.1`, ports 8787 and 5173 are not forwarded, proxied, or tunneled, and inbound access is blocked. Other processes running as the user can still reach the API. |
| 2. Localhost CSRF and WebSocket access | **Not mitigated by ordinary local use.** A malicious website opened on the same computer can contact localhost. A dedicated machine used for no general web browsing materially reduces this risk. |
| 3. Queued transactions marked complete | **Not mitigated.** This is internal transaction bookkeeping and can be triggered by ordinary relay or RPC failures. |
| 4. Private-bundle nonce reuse | **Not mitigated in mainnet mode.** Public submission mode avoids this particular private-bundle path, but introduces separate inclusion, privacy, and front-running tradeoffs. |
| 5. Spending guardrail gaps | **Partially mitigated at most.** Using only one wallet removes the wrong-secondary-wallet case, but Coinbase bid, payer-validation, gas-budget, and balance-floor issues remain. |
| 6. Mutable upstream updates | **Mitigated by the post-review code change, not by locality.** The `union69skipbot` branch no longer performs automatic code, list, or release checks. A manual `git pull` or replacement release still trusts its source, but gives the operator an opportunity to pin and review the exact change. |
| 7. Stale example configuration | **Not mitigated.** Avoid copying `data/config.example.json`; allowing the runtime to use its current defaults avoids this specific stale template. |
| Plaintext secret-file permissions | **Substantially reduced** on a single-user system with a private home directory and full-disk encryption, but not against malware, another OS account, permissive backups, or cloud synchronization. |
| Unlock guessing and event-loop denial of service | **Reduced** by loopback-only access and the absence of untrusted local processes, but not eliminated. |
| Chain, RPC, builder, and `CoinbasePayer` trust | **Not mitigated.** These risks involve remote services, signed transaction behavior, or on-chain code. |

The main distinction is that a personal machine blocks ordinary remote network clients, but the browser itself is a local client. The unauthenticated WebSocket can reveal whether the wallet is unlocked, after which a malicious page can send bodyless `/api/start`, `/api/stop`, or `/api/lock` requests. Host firewalls also commonly permit loopback traffic, so they should not be treated as CSRF protection.

Even with strict loopback binding, no unrelated browsing, one minimally funded wallet, disabled Coinbase bids, restrictive file permissions, and reviewed manual updates, findings 3 and 4 remain significant. They can cause missed defensive payments without any attacker and require code changes rather than deployment hardening.

## Immediate operating precautions

Until fixes are available:

1. Keep `HOST=127.0.0.1`; never expose port 8787 directly.
2. Use a dedicated burner funded only with the amount at risk.
3. Avoid leaving the wallet unlocked while browsing untrusted sites.
4. Leave Coinbase bidding disabled unless its balance handling and payer are independently verified.
5. Do not seed configuration from the current `data/config.example.json`; let the runtime create current defaults.
6. Apply reviewed, pinned updates manually; automatic code and list updates have been removed on this branch.
7. Restrict `.env`, the data directory, and all secret files to the current OS account.

## Scope and limitations

This was a read-only static review of the TypeScript backend, React frontend, Solidity forwarder, updater and launcher scripts, configuration and data files, and dependency-lock structure. No files were changed during the review itself.

Tests and builds were not run because dependencies were not installed. Current dependency-advisory status was not verified against an online advisory service. This review does not constitute a formal audit of the external Death & Taxes contracts, deployed `CoinbasePayer` bytecode, RPC providers, builders, or upstream GitHub account security.
