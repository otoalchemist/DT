# Builder Incentives / Coinbase Payments

Status: design approved for investigation; not yet safe for live use.

## What the mechanism does

Flashbots builders count a smart-contract payment to `block.coinbase` as bundle
revenue, alongside priority fees. A larger payment can make a bundle more
attractive to a builder, but it does **not** guarantee transaction position zero
or inclusion: modern builders optimize total block profit and may place bundles
anywhere in the block.

The live game contract cannot be called through a wrapper for `payTaxes`,
`audit`, or `useBribe`, because those functions require the Citizen owner to be
the immediate `msg.sender`. The compatible architecture is therefore an atomic
private bundle with two or more transactions:

1. the existing owner-signed game transaction(s); then
2. a final owner-signed transaction to a minimal, verified `CoinbasePayer`
   contract that forwards its entire `msg.value` to `block.coinbase`.

The trailing payment is conditional in practice because the private bundle is
atomic: if a protected game transaction reverts, the bundle and payment are not
included.

## Safety requirements

Do not enable this feature until all of the following are implemented and
tested:

- disabled by default, mainnet private-bundle only, with an explicit per-bundle
  ETH cap and a separate operator confirmation;
- the payer address and deployed bytecode hash are pinned and verified at
  startup; the contract has no owner, storage, arbitrary-call surface, or
  withdrawal path;
- the payer uses a checked low-level call so contract-valued coinbase addresses
  work, with a gas limit that covers that case;
- the incentive value and maximum gas are included in pending exposure and the
  minimum-balance floor before anything is signed;
- every protected game transaction plus the payment is prepared, simulated, and
  delivered as one all-or-nothing cohort; prefix truncation must never send the
  payment without every protected transaction;
- the payment is journaled as `builder-incentive`, is never publicly broadcast or
  independently replayed, and shares finite target blocks and bundle replacement
  lineage with its protected cohort;
- cancellation/replacement operates on the entire cohort and never leaves a
  higher payment nonce stranded behind a replaced game transaction;
- post-mortem reporting records priority fees, direct coinbase value, total
  bundle profit, gas used, and actual transaction index. The operator should
  calibrate from observed competing transactions rather than hard-code a quoted
  `0.015 ETH` payment.

## Delivery plan

1. Capture the cited winning transaction hash and compare its transaction index,
   priority fee, internal coinbase transfer, gas used, and total `coinbaseDiff`.
2. Add and independently review the minimal payer contract, including EOA and
   contract coinbase tests on Anvil.
3. Extend the journal/nonce model with durable bundle-cohort metadata and add
   crash, replacement, expiry, reorg, and balance-floor tests.
4. Add the capped configuration and an explicit dashboard warning/confirmation.
5. Run private-bundle simulations and disposable-fork QA before considering a
   mainnet deployment.

References: [Flashbots coinbase payments](https://docs.flashbots.net/flashbots-auction/advanced/coinbase-payment),
[bundle pricing and ordering](https://docs.flashbots.net/flashbots-auction/advanced/bundle-pricing).
