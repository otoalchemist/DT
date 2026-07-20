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
3. exactly one final owner-signed transfer to the verified `CoinbasePayer`, also
   explicitly allowed to revert.

The feature never creates an audit-only or bid-only cohort. It is considered
only when a mandatory pre-boundary payment was prepared. The payer is a
stateless forwarder whose checked `receive()` call sends all `msg.value` to
`block.coinbase`; it has no owner, storage, withdrawal path, fallback, or
arbitrary-call surface. If audit or incentive preparation is skipped or fails,
already prepared mandatory work still follows its hardened delivery path; the
bot does not manufacture a standalone bid to complete the cohort.

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

Private delivery targets the next two blocks. Prepared journal entries carry a
finite private target horizon and durable cohort/purpose metadata. A restart may
recover public-authorized payments and audits, but cannot reinterpret the bid as
public work. Flashbots replacement UUIDs are scoped to each whole submitted
bundle and target; cancellation is relay-specific and best-effort, not a
cross-builder guarantee.

## Capability and execution gates

Clean installs and migrations set `coinbaseBidEnabled` and
`combinedBoundaryBundle` to `false`; the default bid is `0` and no payer address
is assumed. The loopback capability endpoint reports `active: true` only when
the persistent configuration and backend environment satisfy all of the following:

- `MODE=mainnet`, verified Ethereum chain ID 1, and a healthy submission journal;
- a positive canonical `coinbaseBidEth` value and a nonzero
  `coinbasePayerAddress`;
- deployed runtime bytecode exactly matching
  `contracts/CoinbasePayer.build.json`, whose pinned Keccak-256 hash is
  `0x8ca126cf92be3a9978ed8f20db5c0851bc006f0354b9e73a597ed94d80f851e9`;
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
generation, deadline, ownership, spend cap, pending exposure, and minimum-balance
floor before signing.

The bid amount plus its maximum gas is included in pending exposure. Dry-run
models the intents and authorization but does not reserve a nonce, sign, write
the submission journal, or send a transaction or bundle. The capability endpoint
may still report `active: true` during Dry Run because it verifies configuration,
mode, chain, journal, amount, address, and code—not current executability.

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
4. Compare the deployed runtime byte-for-byte and by hash before configuring it.
   One possible read-only check is:

   ```bash
   export RPC_HTTP_URL=<ETHEREUM_MAINNET_RPC>
   export COINBASE_PAYER=<DEPLOYED_ADDRESS>
   ONCHAIN_CODE=$(cast code --rpc-url "$RPC_HTTP_URL" "$COINBASE_PAYER")
   EXPECTED_CODE=$(jq -r .runtimeBytecode contracts/CoinbasePayer.build.json)
   test "$ONCHAIN_CODE" = "$EXPECTED_CODE"
   test "$(cast keccak "$ONCHAIN_CODE")" = \
     "0x8ca126cf92be3a9978ed8f20db5c0851bc006f0354b9e73a597ed94d80f851e9"
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

Disabling the feature does not retract a bundle already submitted to a relay.
Stop new work first, then atomically turn off both persistent switches and
reconcile any already journaled or pending transaction separately:

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
private limits, public fallback, finite journal expiry, and the payer's EOA,
accepting-contract, and rejecting-contract behavior on disposable Anvil.

That evidence does not constitute a contract audit, a live relay test, a funded
mainnet test, or proof of economic advantage. No release or owner-QA checklist
should claim otherwise.

References: [Flashbots coinbase payments](https://docs.flashbots.net/flashbots-auction/advanced/coinbase-payment),
[bundle pricing and ordering](https://docs.flashbots.net/flashbots-auction/advanced/bundle-pricing).
