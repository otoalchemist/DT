# Builder Incentives / Coinbase Payments

Status: implemented in 0.3.0 and disabled by default. The repository includes
unit/model coverage and a disposable-Anvil contract fixture; it does not include
live financial QA or evidence that a particular bid is economically effective.
Any mainnet deployment and enablement is a separate operator decision.

## What is implemented

Flashbots builders may count a smart-contract payment to `block.coinbase` as
bundle revenue alongside priority fees. A direct payment may make a bundle more
attractive, but it does **not** guarantee inclusion, top-of-block placement,
transaction ordering, or a successful payment/audit outcome. Builders optimize
the block they construct, and another builder may win the slot.

The game contract's owner checks prevent wrapping `payTaxes`, `audit`, or
`useBribe`: the Citizen owner must remain the immediate `msg.sender`. The bot
therefore prepares separate owner-signed transactions in one declared private
cohort, in nonce order:

1. one or more mandatory pre-boundary tax payments;
2. zero or more optional audits, each explicitly allowed to revert; and
3. exactly one final owner-signed
   `payCoinbase(notBeforeTimestamp, validThroughBlock)` call to the
   verified `CoinbasePayer`, also explicitly allowed to revert.

The feature never creates an audit-only or bid-only cohort. It is considered
only when a mandatory pre-boundary payment was prepared. The payer is a
stateless forwarder whose checked `payCoinbase(uint256,uint256)` call sends all
`msg.value` to `block.coinbase` only while
`block.timestamp >= notBeforeTimestamp` and
`block.number <= validThroughBlock`;
it has no owner, storage, withdrawal path, receive function, fallback, or
arbitrary-call surface. Legacy empty-calldata transfers therefore revert. If
audit or incentive preparation is skipped or fails, already prepared mandatory
work still follows its hardened delivery path; the bot does not manufacture a
standalone bid to complete the cohort.

The three roles deliberately have different delivery semantics:

- Mandatory payments are not allowlisted to revert. They retain the ordinary
  public-mempool fallback as well as private delivery.
- Optional audits are named in the private bundle's `revertingTxHashes`, so a
  stale or raced audit cannot invalidate the mandatory private payment. They
  retain the hardened public fallback when the offense/race policy authorizes
  it; that public attempt is independent of the private cohort.
- The final `builder-incentive` transaction is named in
  `revertingTxHashes`, is private-only, and is never publicly broadcast or
  independently replayed from the submission journal.

Whole-bundle simulation still fails closed for a mandatory transaction or a
bundle-wide error. Only the hashes explicitly marked as revertible are
tolerated. The full declared cohort must fit the private transaction-count,
encoded-byte, and aggregate-gas limits; if a limit would split it, no member of
that cohort is privately sent. Public-authorized payments and audits keep their
ordinary public delivery, while the private-only incentive is not sent.

That atomicity is a rule of the submitted bundle, not a cryptographic
postcondition enforced by the payer. Configured relays/builders receive each raw
signed cohort transaction. A malicious or compromised builder could ignore the
bundle rules and include the payer transaction during its signed window even if
a preceding game payment reverted or was omitted. The feature therefore requires
an operator-reviewed builder set and never represents the incentive as proof that
payment-first ordering occurred.

Private delivery targets the next two blocks. The signed payer calldata binds the
bid to both the payment boundary timestamp and that block horizon, and transport
never targets a block later than the signed `validThroughBlock`. If preparation
advances, transport narrows the target set or drops the bid instead of extending
its authorization. Prepared journal
entries carry that exact signed bound, a no-later private target horizon, and
durable cohort/purpose metadata. A restart may recover public-authorized payments
and audits, but cannot reinterpret the bid as public work; transport also rejects
builder-purpose recovery even if that policy metadata is corrupted. Flashbots
replacement UUIDs are scoped to each whole submitted bundle and target;
cancellation is relay-specific and best-effort, not a cross-builder guarantee.

## Capability and execution gates

Clean installs and migrations set `coinbaseBidEnabled` and
`combinedBoundaryBundle` to `false`; the default bid is `0` and no payer address
is assumed. The loopback capability endpoint reports `active: true` only when
the persistent configuration and backend environment satisfy all of the following:

- `MODE=mainnet`, verified Ethereum chain ID 1, and a healthy submission journal;
- a positive canonical `coinbaseBidEth` value and a nonzero
  `coinbasePayerAddress`;
- finalized deployed runtime bytecode exactly matching
  `contracts/CoinbasePayer.build.json`, whose pinned Keccak-256 hash is
  `0x00ead4184eaf62003aa381e9902e3c33b6a7b455e455c94c86f9a4f916f8f44f`;
- both the direct-incentive and combined-cohort switches enabled.

Risk-increasing configuration mutations require explicit acknowledgement before
they can establish that state. Switching from public to mainnet also requires
explicit acknowledgement and fresh candidate-chain/payer validation when the
persisted switches could reactivate the bid; acknowledgement is not itself a
persisted capability flag.

That capability result is not an executable-now signal. Actual preparation and
submission additionally require pre-boundary payments to be enabled, a running
engine, an unlocked wallet, Dry Run to be off, a due mandatory boundary payment,
and final immediate re-authorization of the configured amount, payer, engine
generation, deadline, ownership, spend cap, pending exposure, minimum-balance
floor, and exact payer code at the finalized chain tag before signing. A payer
deployment is unusable until it is finalized.

The bid amount plus its maximum gas remains in pending exposure while its nonce
lineage is unresolved. Dry-run models the intents and authorization but does not
reserve a nonce, sign, write the submission journal, or send a transaction or
bundle. The capability endpoint may still report `active: true` during Dry Run
because it verifies configuration, mode, chain, journal, amount, address, and
code—not current executability.

### Expiry and residual raw-transaction risk

The on-chain block check makes the bid value unavailable after the signed bound,
even to a builder that retained the raw transaction. It does not give the
Ethereum transaction itself protocol-level expiry. A builder can still include
that raw transaction later; it will revert before forwarding value, but can
consume the sender nonce and actual revert gas. The fixed 100,000 gas limit and
signed maximum fee cap bound that gas loss, while the bid value remains safe.

The bot never releases a disclosed signed raw merely because its relay target or
value window ended. Once the signed deadline is canonically deep enough, an
operator-authorized running live engine signs and publicly submits a zero-value,
21,000-gas self-transfer at the same nonce. That retirement is journaled before
dispatch, remains public-only, and is fee-bumped within the configured caps when
an accepted/ambiguous attempt appears dropped. The original payer raw and every
retirement alternative stay fenced and counted as one maximum same-nonce
liability until account-nonce consumption is canonically confirmed.

If Dry Run is on, the wallet is locked, an unknown pending nonce exists, the
balance floor cannot be met, the fee ceiling cannot produce a valid replacement,
or the public RPC cannot make progress, retirement fails closed and the nonce is
not reused. Stop/Lock revokes active recovery delivery; a later explicit Start is
required to resume it. Do not use another signer to repair the nonce: manual
same-wallet traffic can invalidate the journal's semantic recovery assumptions.

## Operator deployment and verification

Do not treat these steps as live-QA approval. Use the exact reviewed commit and
obtain an independent review of the payer source, artifact, transport changes,
and chosen financial limits before any mainnet use.

1. Run the exact-head automated and owner gates in
   [`qa/pr-1-reliability.md`](qa/pr-1-reliability.md). Keep the feature disabled
   while doing so.
2. Run `npm run test:integration`. Its exact compiler gate builds
   `contracts/CoinbasePayer.sol` with Solidity 0.8.20, the Shanghai EVM target,
   optimizer runs 200, and no metadata, then compares both creation and runtime
   bytecode (and the runtime hash) with `contracts/CoinbasePayer.build.json`.
   This is a reproducibility check, not a contract audit or deployment approval.
3. After independent review, deploy the exact `creationBytecode` recorded in
   `contracts/CoinbasePayer.build.json` using the operator's chosen, reviewed
   deployment process. The project does not prescribe a universal deployment
   mechanism or address. Record the deployment transaction, chain ID, creation
   bytecode, and resulting address.
4. Wait for the deployment to reach Ethereum's `finalized` tag, then compare the
   finalized runtime byte-for-byte and by hash before configuring it.
   One possible read-only check is:

   ```bash
   export RPC_HTTP_URL=<ETHEREUM_MAINNET_RPC>
   export COINBASE_PAYER=<DEPLOYED_ADDRESS>
   ONCHAIN_CODE=$(cast code --rpc-url "$RPC_HTTP_URL" --block finalized "$COINBASE_PAYER")
   EXPECTED_CODE=$(jq -r .runtimeBytecode contracts/CoinbasePayer.build.json)
   test "$ONCHAIN_CODE" = "$EXPECTED_CODE"
   test "$(cast keccak "$ONCHAIN_CODE")" = \
     "0x00ead4184eaf62003aa381e9902e3c33b6a7b455e455c94c86f9a4f916f8f44f"
   ```

5. With Dry Run still enabled, enter the reviewed fixed bid and verified payer
   address, enable both advanced switches, and accept the explicit risk prompt.
   Confirm the dashboard reports `CONFIG / CHAIN / CODE VERIFIED`, or query the
   loopback-only `GET /api/builder-incentive` endpoint and require
   `active: true` with the expected payer, bid in wei, and runtime hash. This is
   capability evidence only; it does not mean the engine can or will submit a bid.
   An inactive reason is a stop condition, not a warning to bypass.
6. Verify the payment cap, balance floor, relay/builder URLs, journal health,
   boundary lead time, and public-race policy. A dry run validates local control
   flow only; it does not validate relay acceptance, inclusion probability,
   placement, ordering, or bid competitiveness.
7. If the operator later authorizes live use, start with a separately reviewed
   amount and monitor receipts, actual fee-recipient transfers, total gas cost,
   and transaction indices independently. Do not infer success from a relay
   acknowledgement alone. Disable both switches if capability status changes,
   journal health degrades, or observed cost exceeds the operator's limit.

## Disable / rollback

Disabling the feature does not retract a bundle or raw transaction already
submitted to a relay. The signed deadline prevents a later value transfer, but
does not prevent a later reverted inclusion and its nonce/gas cost. Stop new work
first, then atomically turn off both persistent switches. Previously disclosed
lineages remain in the journal; explicitly Start again when prepared to let the
bot complete any required public nonce retirement, and keep the wallet exclusive
until the lineage clears:

```bash
export BOT_API=http://127.0.0.1:8787
curl -fsS -X POST "$BOT_API/api/stop"

SNAPSHOT=$(curl -fsS "$BOT_API/api/config")
REVISION=$(printf '%s' "$SNAPSHOT" | jq -r .revision)
BODY=$(jq -n --argjson revision "$REVISION" '{
  expectedRevision: $revision,
  patch: {
    coinbaseBidEnabled: false,
    combinedBoundaryBundle: false
  }
}')
curl -fsS -X PATCH "$BOT_API/api/config" \
  -H 'content-type: application/json' \
  --data "$BODY"

VERIFY=$(curl -fsS "$BOT_API/api/config")
test "$(printf '%s' "$VERIFY" | jq -r .config.coinbaseBidEnabled)" = false
test "$(printf '%s' "$VERIFY" | jq -r .config.combinedBoundaryBundle)" = false
curl -fsS "$BOT_API/api/builder-incentive" | jq -e '.active == false'
```

If the PATCH reports a revision conflict, fetch the new revision, review the
current configuration, and retry. Keep the engine stopped until both switch
checks pass and any previously submitted cohort has been reconciled from the
journal and chain receipts.

## QA evidence and limits

The automated gate covers exact compiler comparison of the pinned payer creation
and runtime bytecode, default-off migration, explicit risk acknowledgement,
chain/mode/journal/runtime-hash capability checks, spend accounting, dry-run
side-effect freedom, role ordering, exact revert-hash allowlisting, cohort-atomic
private limits, public fallback, signed-window enforcement, indefinite raw
retention, confirmed same-nonce retirement, and the payer's success-at-deadline,
revert-before/after-window, legacy
empty-calldata rejection, EOA, accepting-contract, and rejecting-contract
behavior on disposable Anvil and Foundry.

That evidence does not constitute a contract audit, a live relay test, a funded
mainnet test, or proof of economic advantage. No release or owner-QA checklist
should claim otherwise.

References: [Flashbots coinbase payments](https://docs.flashbots.net/flashbots-auction/advanced/coinbase-payment),
[bundle pricing and ordering](https://docs.flashbots.net/flashbots-auction/advanced/bundle-pricing).
