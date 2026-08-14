# High-Level Security Review

- Date: 2026-08-11
- Repository: Death & Taxes Bot
- Review type: Read-only static review with remediation follow-up
- Reviewed snapshot: `ead9edf` (line references describe that snapshot)
- Remediation branch: `union69skipbot`
- Remediation verification: 2026-08-12

> The Priority findings and Additional hardening sections below are preserved as the
> historical record of what was observed in `ead9edf`; their line links describe that
> snapshot, not the current branch. The current remediation status is recorded separately
> below.

## Overall assessment

At the reviewed snapshot, this bot should not have been run with meaningful funds: its local wallet API was browser-reachable and transaction bookkeeping could suppress critical retries. The `union69skipbot` branch now contains code-level mitigations for every finding family in this report. That is a material improvement, but it does not turn hot-wallet automation into a zero-risk system or replace controlled mainnet validation and a formal audit.

## Remediation status on `union69skipbot`

| Finding | Current branch status |
| --- | --- |
| 1. Non-loopback wallet API | **Mitigated in code.** Startup now refuses any non-loopback `HOST`. Every API route except the session bootstrap requires a random per-process bearer token, destructive key operations require the existing passphrase, keystore replacement/removal creates an atomic owner-only backup, and replacing active keys stops and locks the engine. Remote service mode is deliberately unavailable rather than relying on unauthenticated plain HTTP. |
| 2. Localhost CSRF and WebSocket access | **Mitigated in code.** API requests enforce the expected Host; all reads and writes require the non-safelisted session header; mutations reject non-loopback Origin values and unsafe Fetch Metadata, and any supplied request body must be JSON. WebSocket upgrades require a loopback Origin and the session token and are connection-limited. API responses are marked `no-store`. |
| 3. Queued transactions marked complete | **Mitigated in code; operational validation remains important.** Transactions now have distinct planned/queued, relayed, included, reverted, and skipped outcomes. Bundle-flush failures and expiry feed lifecycle failure hooks; JIT, proactive-pay, defense, and offense markers become final only after canonically rechecked receipt or safe on-chain state. Ambiguous public-RPC responses remain reserved and tracked by their deterministic transaction hash instead of immediately permitting a duplicate. Reverted receipts account for gas without treating the intended action as successful. |
| 4. Private-bundle nonce reuse | **Mitigated in code; operational validation remains important.** Each private reservation records its last eligible block; unresolved sequences block later ticks from creating a nonce gap, and release requires the authoritative head to pass that block plus a reorg margin as well as a minimum time grace. Reservations are atomically journaled in an owner-only file; restart restores unresolved state and fails closed on a corrupt or legacy-ambiguous journal. Regression coverage includes idle-before-reservation, stalled heads, cross-tick expiry, restart, pending-only state, and corrupt journals. |
| 5. Spending guardrails | **Mitigated in code.** The final pre-sign authorization uses the actual signing wallet, exact value and encoded gas price, a fresh payer balance, committed pending spend, configured balance floor, base-fee limit, and payment cap. Multi-wallet owner actions use the token holder. Coinbase bids include bid value and gas, fail closed without an allowlisted deployed runtime-code hash, and the updated forwarder reverts if payment to `block.coinbase` fails. No shared payer is enabled by default. |
| 6. Mutable upstream updates | **Removed.** Automatic code replacement, curated-list synchronization, and background release checks were deleted. Updates are now an explicit operator-managed action. |
| 7. Stale example targets | **Mitigated in code and data.** The example is complete for the current defaults version, disables offense, has no pinned offense targets or Coinbase payer, and is checked by a regression test. Runtime and API strategy data are strictly validated, bounded, canonicalized, and reject unknown or missing fields instead of silently accepting misspelled or defaulted guardrails. Missing, unreadable, malformed, or invalid ally-roster data blocks automated offense. |

The branch also adds fail-closed RPC identity checks: live signing requires Ethereum chain ID 1, the mainnet genesis hash, the canonical game address, and its approved runtime-code hash; local mode requires Anvil chain ID 31337 and contract code. A separately configured WebSocket endpoint is identity-checked and is used only as a tick notification, not as the authoritative fee/block cache.

Secret-bearing files and the data directory are tightened to owner-only permissions, writes are atomic where safety state is involved, passphrase KDF work is asynchronous and rate-limited, and API/activity/log errors are redacted before disclosure or persistence. Focused regression tests were added for these controls. These mitigations cannot guarantee builder inclusion, RPC availability or honesty after startup, correct external contract behavior, or protection from malware already running as the same OS user. Public-transaction lifecycle reservations remain process-local: restart quarantines a pending-nonce gap once the provider exposes it, but a crash before that observation can lose logical context. Receipt canonicality is rechecked after one subsequent block; this reduces one-block reorg risk but is not economic finality.

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

Running the bot locally materially reduces remote network and multi-user exposure. It was never, by itself, a correction for transaction-lifecycle, nonce, spending, configuration, or upstream trust defects. The current branch addresses those defects in code, so locality is now an additional containment layer rather than the primary mitigation.

In this section, "running locally" means that the process runs on a personal computer while transacting on Ethereum mainnet. It does not mean the bot's `MODE=local`, which targets an Anvil fork and has a different risk profile.

| Finding or control | Current code mitigation | What local personal-machine operation still changes |
| --- | --- | --- |
| 1. Wallet-control API exposure | The server refuses non-loopback binding, validates Host, requires a per-process token, reauthenticates destructive key changes, and preserves an encrypted backup. | A non-forwarded loopback port blocks ordinary remote clients. It does **not** authenticate local OS accounts or processes: anything already running on the host can reach the session bootstrap and API. Do not proxy, tunnel, or port-forward 8787, and avoid running the bot on a shared-login machine. |
| 2. Browser CSRF and WebSocket reads | Mutations require the session header, reject cross-site Origin/Fetch Metadata, and constrain request content type; reads require the session header; sockets require session plus loopback Origin and have a connection cap. | A dedicated machine with little or no unrelated browsing remains useful defense in depth, but browser isolation is no longer the only barrier. Same-user malware or a compromised local browser/profile remains in the trust boundary. |
| 3. Transaction lifecycle | Queueing, relay acceptance, receipt confirmation, reversion, failure, and uncertainty are now distinct. Critical logical markers are confirmation-gated and uncertain public transactions remain reserved and tracked. | Locality provides essentially no additional protection from relay rejection, provider outages, reorgs, or bookkeeping defects. These controls still need realistic operational validation; a minimally funded wallet limits consequences. |
| 4. Private nonce lifecycle | Per-wallet reservations persist their final eligible block, require a reorg and time margin, quarantine restart uncertainty, and block higher-nonce work until authoritative reconciliation. | Running on a personal machine does not make private bundles visible to the public pending nonce. Reliable storage reduces loss of the journal, but backups or restores must not roll this safety file backward. |
| 5. Spending guardrails | Exact payer-specific authorization runs immediately before signing with a fresh balance and pending commitments. Coinbase payer code must match an operator allowlist and failed forwarding reverts. | A dedicated, minimally funded wallet is still the strongest loss cap. One-wallet use reduces complexity but is no longer required to avoid the former secondary-wallet accounting bug. Locality does not make a remote builder or deployed payer trustworthy. |
| 6. Upstream updates | Automatic code, list, and release-update paths were removed. | Locality did not supply this fix. Manual Git/release updates still require provenance checking, but the operator can pin and review the exact commit or artifact before installation. |
| 7. Example and runtime configuration | The example is non-targeting and opt-in; strict schemas reject missing, unknown, malformed, duplicate, oversized, and out-of-range data. Automated offense also fails closed unless the hard ally roster is readable and valid. | Locality adds no configuration correctness. Review every setting that enables automatic spending or offense before starting the engine. |
| Secret files | The data directory is tightened to `0700`; secret and safety files use `0600`, with atomic writes and owner-only backups where appropriate. | A single-user account and full-disk encryption improve at-rest protection. They do not protect an unlocked session from same-user malware, permissive backup/cloud-sync access, or a stolen machine while unlocked. |
| Unlock guessing and event-loop denial of service | Scrypt runs asynchronously; expensive password attempts are serialized and use escalating cooldowns. | Loopback-only access removes remote guessing. A hostile same-user process can still cause local contention, although the API limiter now bounds the KDF path. |
| Chain and RPC identity | HTTP and configured WebSocket endpoints are checked against the expected chain; live mode also pins genesis, game address, and runtime code. Signing asserts the expected chain mode. | Local operation does not eliminate remote-provider or builder availability and censorship risks. The WebSocket is only a latency signal, so it cannot directly poison the authoritative block/fee cache. |

The per-process token is a browser-request barrier, not an operating-system credential. Any process or local account able to connect to the host's loopback interface can bootstrap an API session; code executing as the bot's user can additionally read process-owned files and steal keys after unlock. Host firewalls also commonly allow loopback traffic, so avoid shared-login hosts and keep strong OS account hygiene, malware prevention, and software provenance controls.

`MODE=local` is different: it is a dry-run path that now refuses any chain other than Anvil's chain ID 31337 and requires game-contract code at the configured address. When it points to a genuine local fork it does not spend mainnet funds, but it also cannot fully reproduce live builder, relay, mempool, latency, or reorg behavior.

## Immediate operating precautions

Even with the code mitigations above:

1. Keep the API unproxied and untunneled on loopback; the server intentionally refuses remote binding.
2. Use a dedicated wallet funded only with the amount at risk, and keep the configured balance floor meaningful.
3. Lock the wallet when idle and keep the bot's OS account free of unreviewed software. Separate browsing remains worthwhile defense in depth.
4. Leave Coinbase bidding disabled unless the deployed payer is independently verified and its exact runtime-code hash is allowlisted.
5. Start from the current non-targeting example or runtime defaults, then explicitly review every feature that enables automatic payment, defense, or offense.
6. Apply reviewed, pinned updates manually; automatic code and list updates have been removed.
7. Keep `.env`, the data directory, safety journal, backups, and keystore out of shared or cloud-synchronized locations; use full-disk encryption and protected backups.
8. Test configuration in `MODE=local` before mainnet use, while recognizing that local mode cannot reproduce builder and relay behavior.

## Scope and limitations

The original snapshot review was a read-only static review of the TypeScript backend, React frontend, Solidity forwarder, updater and launcher scripts, configuration and data files, and dependency-lock structure. No files were changed during that review. This follow-up records the subsequent branch remediation based on code inspection and an independent re-review. On 2026-08-12, the workspace build completed and all 311 backend tests passed, including focused coverage for the added security controls.

This remains a high-level review, not a formal audit or proof of correctness. Current dependency-advisory status was not verified against an online advisory service. The review does not audit the external Death & Taxes contracts, deployed `CoinbasePayer` bytecode, RPC providers, builders, the host operating system, backup infrastructure, or upstream GitHub account security. Mainnet behavior under relay failure, delayed receipts, provider inconsistency, reorgs, and process interruption should still be validated conservatively before increasing wallet funding.


gm gm. 
my two cents. I think any bot for the dao should be isolated and hosted independantly. This is my main recommendation.

having 2 different bots running on the same infra is higher risk. 
I've used a model to patch some items raised in a general security scan and can submit a PR for you to review. 
Any changes come with risk and need to be monitored closely as things get setup.

in general:
1. The owner of the AWS account would be the highest risk access
2. access to the server should be locked down tightly 
3. we should generate a new wallet on the server so the key never gets transmitted. 
4. that wallet should be funded periodically.  
5. there should be no single point of failure for access (AWS account is an exception here, thus the higher risk)
6. this could be setup on linux and would only need to run for a few mins a day around the UTC boundary. but even if it weas 24x7 It would cost next to nothing. Now issues with windows, just more expensive and harder to access (from my perspective but I live on the the CLI)

I've got a version of the app that addresses some of the security concerns my scan flagged. 
That would need to be test carefully - but should hopefully work without issue. 
Otherwise the latest stable is good - but I do think we should turn off the auto update stuff (my version removed this). 

Not trying to be a pain in the ass or make work. 
my suggestions are just to  mitigate risk and avoid a work case scenario Fuck I hate being responsible for other peoples bags. personal opsec is stressfull enoough




