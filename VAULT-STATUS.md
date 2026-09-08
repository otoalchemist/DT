# Vault branch — where this got to

Working notes for the batched-boundary work. Delete this file before any merge to master.

**A vault IS deployed and IS holding a citizen on mainnet, as of 2026-09-08.**

| | |
|---|---|
| vault | `0xD00B158B8644B1FE387508Ceb2De021E87926D6E` |
| owner (cold) | `0xCAd15eA89395a66Fc781EFDc93063C9d3372D3DE` — a MetaMask key, NOT in the keystore |
| operator | `0xdE4b72239F6D6E2342CBC48Ca8FB04E05A25f1c7` — the bot's hot wallet |
| holding | citizen #2036, migrated by `npm run vault-move` |
| verify | `npm run vault-check` — wiring AND deployed-bytecode match |

`owner` is **immutable** and there is no `transferOwnership`: that MetaMask seed is the only exit
for every citizen inside. `withdrawCitizens` has no conditions on it and nothing in the contract
can block it, which is the property that makes depositing safe — but it is gated on a key that
cannot be replaced.

Three earlier deploys (`0x910570E6…`, `0xFdb06786…`, `0x624F0d31…`) are dead and hold nothing.
They carried the pre-audit bytecode: Remix served a cached compile three times running while the
wiring checks passed every time, which is exactly why `vault-check` now compares bytecode against
a local build and no longer prints PASS when it could not check the code.

With `vaultAddress` unset the bot still behaves exactly as before — that is what the pre-existing
tests passing unchanged are there to prove.

## What exists

| | |
|---|---|
| `contracts/CitizenVault.sol` | holds citizens, `run(Call[], bidWei)`, four-selector allowlist, per-call revert tolerance, inline coinbase bid, owner/operator split |
| `packages/backend/src/vault-preflight.ts` | reads owner/operator/game/citizens, refuses to act on positive evidence of bad wiring |
| `packages/backend/src/vault-receipt.ts` | decodes `CallResult` so the activity log keeps one row per action |
| `packages/shared/src/abi/citizenVault.ts` | minimal ABI — deliberately omits the owner-only functions so the hot key cannot encode them |
| tests | 26 across `citizen-vault` (compiles + executes the real contract), `vault-bundle`, `vault-mixed`, `vault-receipt` |

676 tests across 45 files pass, both typechecks clean, build clean — master (1.19.0) merged in
2026-09-08. That is master's 650 plus this branch's 26, so nothing was lost either side.

## Verified on a mainnet fork (block 25780106)

Real game, real Citizens contract, real citizen #2036, via `RPCStateManager`:

- vault deployed against the live addresses — 585,020 gas
- `safeTransferFrom(#2036 -> vault)` accepted — 67,847 gas
- `ownerOf(#2036)` returned the vault
- `run([payTaxes], bid=0.03)` succeeded, `TaxesPaid` emitted, `CallResult [{i:0, ok:true}]`
- 0.03 ETH reached `block.coinbase` from inside the call
- `lastEpochPaid` advanced 168 -> 169, i.e. **the citizen ended up current**
- tolerate path confirmed against a real doomed audit: outer tx ok, `CallResult [true,false]`,
  the payment survived

### Measured gas — the constants are wrong and should be corrected

Execution gas (excludes the 21,000 intrinsic + calldata every tx pays):

```
direct payTaxes (no vault)      44,531
vault: bid only, 0 calls        10,100   <- real wrapper overhead
vault: 1 payment                51,272
vault: 2 payments               90,748   <- marginal per call: 39,476
vault: 1 pay + 1 audit + bid    87,135
```

Against what the code currently assumes:

- `VAULT_CALL_OVERHEAD_GAS = 60_000` (strategy.ts) — real overhead is **10,100**
- `VAULT_PER_CALL_GAS = 145_000` (strategy.ts) — real marginal is **~39,476**
- `GAS_VAULT_OVERHEAD = 60_000` (shared/constants.ts) — feeds `bundleGas(.., batched)`
  and therefore every beat/lead figure, so it currently **overstates** batched bundle gas

Over-providing the signed gas limit is safe (unused gas refunds). Over-stating
`GAS_VAULT_OVERHEAD` is not harmful either — it inflates the quoted bid — but both should be
brought to the measured numbers, with the fork script as their provenance.

Going through the vault costs **+6,741 execution gas** over a direct payment for one call,
and saves a whole 21,000-gas intrinsic per additional action after the first.

## RESOLVED 2026-09-08 — the reverting audits were BURNED citizens, not insurance

Found while simulating, unfinished. Every audit the bot would currently queue reverts:

```
#1000 (3 behind)  #1417 (9)  #5651 (19)  #5984 (21)  #6028 (20)  #6403 (9)
=> all revert 0x7e273289 <target-id>
```

Confirmed **not** vault-related: the same calls revert straight from the owning EOA with no
vault involved. Also not a stale fee — chain `AUDIT_COST` matches the bot's constant, and
audits did succeed on-chain 6.3h earlier at the epoch-169 boundary. Game `state` is 1 (LIVE).

`0x7e273289` takes one uint256 (the target) and is **not among the 24 errors in our shipped
ABI**, so `packages/shared/src/abi/deathAndTaxes.ts` is missing at least one error the
deployed contract can throw.

The leading hypothesis was **life insurance blocks auditing**, flagged unproven because all
six rejected targets were insured and there was no counter-example.

**There are seven, and the hypothesis is wrong.** Every target audited SUCCESSFULLY on chain
the week of 2026-09-07 — #6953, #358, #6699, #4355, #5688, #4140, #382 — also carries
`hasLifeInsurance = 1`. Insurance does not separate the two groups.

**Liveness does.** All six that reverted are BURNED (`ownerOf` reverts); all seven that worked
are alive. And `0x7e273289` is `ERC721NonexistentToken(uint256)` — inherited from the ERC721
base and thrown by the Citizens contract, not declared by the game. `lastEpochPaid` is a
mapping that survives the burn, so a dead citizen still reads as N epochs behind while
`ownerOf` reverts. Same root cause as the earlier 3+-behind finding.

**No production change was needed, and the proposed fix would have been harmful.** Excluding
insured targets would have disabled essentially all offense, since apparently every citizen is
insured. `filterLiveTokenIds` already drops burned ids from the offense pipeline. The ABI entry
this note said was missing is present on master — true at 1.5.5, fixed since. What landed on
master is a regression pin only (`abi-errors.test.ts`), verified to fail if the inherited error
is ever dropped in a regeneration.

## Internal review, 2026-09-08

NOT the external review item 3 asks for — I wrote much of what I am reviewing, so this
narrows what an external reviewer has to find rather than replacing them.

**Nothing exploitable found.** Three claims that cannot be settled by reading are now executed
in `citizen-vault.test.ts` rather than argued:

- short calldata cannot zero-pad into an allowlisted selector (`bytes4(bytes)` pads, giving
  0x00000000, which matches nothing — but the failure mode would be silent, so it is run)
- `tolerate: true` cannot smuggle a disallowed selector past the check: the allowlist is
  evaluated BEFORE the call and is not tolerate-gated, so a hostile batch naming transferFrom
  reverts on the vault's own guard rather than swallowing the failure
- a compromised operator cannot reach a standing balance. `msg.value == sum(values) + bidWei`
  means it can only ever spend what it supplies itself. This is the property the entire
  owner/operator split rests on, and it was previously only asserted in prose.

**Selector allowlist re-verified against the shipped game ABI.** `kill` takes ONE uint256
(0xd29a0025) and the contract has it right. Worth recording because a wrong arity here is
invisible: it produces a selector that matches nothing, and every kill would revert
`SelectorNotAllowed` forever.

### Noted, not fixed — none are blocking

1. **Junk NFTs are permanently stuck.** `onERC721Received` accepts any collection, but
   `withdrawCitizens` only moves `citizens`. Anything dusted in is unrecoverable. Harmless
   unless someone cares about a stuck token; a generic rescue would widen the exit surface,
   which is the one thing this contract should not do.
2. **`sweep(address(0))` burns the balance.** Owner-only and the owner's own foot, but a
   zero-address check is one line.
3. **An operator that is a CONTRACT rejecting ETH would break tolerated batches.** The refund
   uses `msg.sender.call`, so `RefundFailed` would revert any batch containing a tolerated
   failure. The operator is meant to be the bot EOA; worth a line in the deploy notes.
4. **A compromised operator can still waste ETH**, not just gas. It supplies the value, but it
   can pay taxes nobody asked for or audit nothing. The header says "wasted gas and audit
   slots"; "and any ETH it is willing to fund" is more accurate.

## Scope, narrowed 2026-09-08 — payment and audit only

The vault exists for the boundary, and the boundary is payments and audits. Everything below
is verified and dry-run against those two; `kill` and `useBribe` are explicitly out of scope.

**No code change was needed, because the routing already draws this line.** `isOwnerOnlyKind`
covers pay-taxes / use-bribe / audit and deliberately excludes `kill`: the vault exists to be
the OWNER of a citizen you hold, and `kill(target)` names a citizen you do not own, so there
is nothing for an ownership check to test. Kills already go straight from the operator wallet
and never enter a batch. `audit(auditorId, target)` is the contrast — gated on the auditor you
hold, which is exactly why it must be wrapped.

Two consequences worth stating rather than discovering:

- **`SEL_KILL` in the contract allowlist is dead weight.** Nothing routes a kill through the
  vault, so it is never exercised. Left in place: removing it is irreversible after deploy for
  no gain, and a compromised operator making the vault call `kill` achieves nothing it could
  not already do from its own wallet, since kill is permissionless.
- **`useBribe` stays allowlisted and stays untested.** It is owner-only, so a vaulted citizen
  can only bribe through the vault — dropping it would permanently remove that capability from
  every migrated citizen. It is a manual dashboard action rather than a boundary one, so it is
  out of scope for the dry run, not out of the contract.

## Remaining before mainnet

1. ~~Finish the insurance question~~ — CLOSED, see above. No production change needed.
2. Correct the three gas constants to the measured values. **Partly done**: `GAS_VAULT_OVERHEAD`
   is now 31,100 (21,000 intrinsic + 10,100 measured wrapper). Still outstanding in strategy.ts:
   `VAULT_CALL_OVERHEAD_GAS = 60_000` against 10,100 and `VAULT_PER_CALL_GAS = 145_000` against
   ~39,476.

   **Do not "fix" these by lowering them to the measured numbers.** They set the signed gas
   LIMIT. At measured values a pay+audit batch would be provisioned 89,052 against a measured
   87,135 — under 2,000 gas of headroom. Over-providing refunds; under-providing reverts a real
   payment. If they are tightened it should be to a measured value plus a deliberate margin, and
   the affordability check (limit × maxFee) is the only thing the current slack actually costs.
3. External review of the contract. My own adversarial pass found one real bug (a non-contract
   `game` address made every call silently "succeed" while sending the ETH to a dead address;
   fixed with constructor code checks, pinned as a test). A second pass against Hedo's deployed
   TaxManager found three more — see the comparison section below.
4. ~~Dry run: one citizen, one full epoch~~ — IN PROGRESS. #2036 is in the vault; the epoch-191
   boundary is the first live batch. Withdraw back with the cold key afterwards to close it.

## Compared against Hedo's deployed vault, 2026-09-08

Their `TaxManagerAuditable` is verified on Sourcify (exact match, solc 0.8.32) at
`0x08458A47aD56Ff42D2d3eCA8D67ee887A3F9dBAf`. Worth reading: it is a different architecture, not
a bigger version of ours, and it is running live behind two more layers.

- Three layers, not one: hot EOAs -> an UNVERIFIED keeper contract (`0xf8ef…EECd7`, which is the
  vault's `keeper`) -> the vault -> the game. The strategy lives in the unverified layer.
- **They pay 0.102 ETH to `block.coinbase` inline**, from the keeper, in the same transaction —
  measured on tx `0x77c9b438…`, which landed at **tx index 2 on a 1.5 gwei tip**. Their other
  three txs that week sat at index 33, 56 and 62. The bid buys the position, not the tip. Our
  inline-bid design matches theirs; the amount does not.
- **Their vault holds a standing balance (3.4157 ETH) and ours never does.** Every pay/audit
  there spends `address(this).balance`, and `payAll`/`batchAudit` are `onlyAuthorized`, so a
  compromised keeper can burn the lot. Ours requires `msg.value == sum(values) + bidWei`, so a
  stolen operator key can only spend what it already controls. This is the single biggest
  difference and the main thing NOT to copy.
- **Their payments are unconditionally revert-tolerant** (`_tryPayTaxes` catches and emits
  `TaxPaySkipped`), so the tx succeeds while the citizen goes unpaid. Ours lets the bot choose
  per call, and a lone must-land payment stays intolerant.
- Two bugs in theirs, recorded so they are not copied: `endgame`'s
  `require(balance >= payoutPerCitizen * len)` counts dead tokens in `len`, so it bricks once any
  tracked citizen is burned; and `withdrawNFT(id, safe=false)` transfers the NFT out but leaves
  `isTracked` true, so `payAll` wastes gas on it every epoch.

### What that review changed in ours

- **Bounded the coinbase call.** `call(gas(), coinbase(), …)` forwarded 63/64 of the remaining
  gas, so a fee-recipient CONTRACT that burns everything left 1/64 — and the refund after it
  needs ~9,700. Running out there is an out-of-gas in our own frame, which reverts the WHOLE
  transaction including payments that already succeeded. Now `call(50000, …)`.

  Not the low-likelihood hardening item it first looked like: the bug only bites when gas
  remaining at that point is under ~620,000, and strategy.ts signs `60,000 + n*145,000` —
  350,000 for a two-call batch, squarely inside the range. The first version of the test used a
  3,000,000 limit and PASSED against the bug; mutation testing is what caught that.
- **`onERC721Received` restricted to the citizen collection** (as Hedo's is). `withdrawCitizens`
  can only move `citizens`, so anything else was stuck forever. Not airtight — a plain
  `transferFrom` skips the hook — but it stops the realistic accidental case.
- **`sweep(address(0))` reverts** instead of burning the balance.

Still true of ours and NOT fixed: no `rescueERC20`/`rescueERC721`, so an ERC20 or an unrelated
NFT forced in with `transferFrom` is unrecoverable. A generic rescue would widen the one surface
this contract keeps deliberately narrow.

## A vault is always fused, and that is a derivation

`boundaryBundleMode` returns `"fused"` whenever a valid `vaultAddress` is set, before it looks at
the toggle or at whether a bid is funded.

Splitting exists to stop a cheap audit tip diluting an expensive payment tip, by giving each half
its own bundle and its own bid. A vault removes the premise: the boundary is ONE `run()` call with
one tip, one bid, and ordering guaranteed by the contract rather than by nonce sequencing. Split,
the same boundary costs two transactions, two bids, and puts the audit call on a nonce above an
unmined payment — worse on every axis the split was meant to improve.

So `thorOverridesFor(s)` replaces the static `THOR_OVERRIDES` table: with a vault it **withholds**
`combinedBoundaryBundle` (harmful — it would split) and `auditBundleAllOrNothing` (inert once
fused, because the combined path ignores it, but a flag left set that has nothing to do is how an
operator ends up reasoning about behaviour they do not have). The other four still apply.

Which bid a fused batch spends is decided by what got QUEUED, not by what was configured:
`paidInBundle.size > 0 ? "payment" : "audit"`. One bundle, one bid.

## "Do I hold this citizen" had three answers, and two were wrong

A vault-held citizen is owned on-chain by the CONTRACT, so every place that answered ownership
from `runtime.wallets` alone stopped recognising it. Found one failure at a time, which is the
wrong way to find them:

- `fetchOwnedAcrossWallets` (the engine) — already correct, vault listed LAST so a stale NFT index
  mid-transfer lets the wallet copy win.
- `readOwnedStatuses` (the dashboard) — **was wrong.** Showed zero citizens, which disables the
  JIT Arm button (`nSelected === 0`). The engine would have paid #2036; the UI offered no way to
  ask it to.
- The **ally gate** on unlock — **was wrong, and locked the operator out of their own bot.** The
  gate requires a rostered citizen in the unlocked wallet; migrating the last one emptied the
  wallet and the next unlock was denied, minutes before a boundary. Escape hatch is
  `BOT_ALLY_GATE_OFF=1`.
- `readTargets`' `selfSet` — **was wrong.** A vaulted citizen read as not-ours and appeared under
  RIVAL targets. Offense itself was safe either way, because it excludes by ally-roster token id
  rather than by owner.

Both dangerous cases were already sound: `walletForToken` returns the OPERATOR for a vaulted
citizen, so `canSpend` checks the wallet that actually pays; and offense never targeted #2036.

## Tooling

| | |
|---|---|
| `npm run vault-check [addr]` | wiring + deployed-bytecode match. Reads only. Names the created contracts when handed a WALLET by mistake (derives them from the deployer's nonce). Does not print PASS when it could not verify the code. |
| `npm run vault-move -- --token N --to-vault` | the deposit. Refuses on bad wiring, `eth_call`s first, confirms, then prompts for the keystore passphrase in raw mode (muted readline breaks paste). Refuses the outbound direction — withdrawal is owner-only and that key is deliberately not in the keystore. |
| `npm run dry-run-boundary` | now finds vault-held citizens, simulates the REAL `vault.run(...)` from the operator rather than a direct call from a contract holding no ETH, and unmasks `CallFailed` by re-simulating with a balance override to recover the game's own revert reason. |


Accepted limitations: `buyLifeInsurance`/`bailout` are unreachable from the vault (the bot
never calls them); emigrating a vaulted citizen is withdraw-then-transfer; a pull-style
endgame payout would need citizens withdrawn first (pinned as a failing-by-design test).

## Picking this up elsewhere

```bash
git fetch origin && git checkout vault && npm install && npm test   # 676 tests
```

The branch is invisible to other operators by construction: `version-check.ts`, `update.mjs`
and `list-sync.ts` all hardcode `master`.

**The "do not bump VERSION on master" rule is now moot and should not be reinstated.** Master
has shipped up to 1.19.0 while this branch sat still, and nothing broke, because the isolation
comes from the three hardcoded `master` refs rather than from the version number. The branch
carries master's 1.19.0 after the merge.
