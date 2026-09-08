# Vault branch — where this got to

Working notes for the batched-boundary work. Delete this file before any merge to master.

**Nothing is deployed. Nothing has touched mainnet.** `vaultAddress` defaults to `""`, so
with it unset the bot behaves exactly as before — that is what the 323 pre-existing tests
passing unchanged is there to prove.

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

## Remaining before mainnet

1. ~~Finish the insurance question~~ — CLOSED, see above. No production change needed.
2. Correct the three gas constants to the measured values. Still outstanding: after the merge
   `GAS_VAULT_OVERHEAD` is still 60_000 against a measured 10,100, and strategy.ts still carries
   `VAULT_CALL_OVERHEAD_GAS = 60_000` / `VAULT_PER_CALL_GAS = 145_000` against 10,100 and
   ~39,476. Over-providing is safe, but every beat/lead figure is quoted off the wrong number.
3. External review of the contract — my own adversarial pass found one real bug (a non-contract
   `game` address made every call silently "succeed" while sending the ETH to a dead address;
   fixed with constructor code checks, pinned as a test). Two other suspicions did not hold: a
   hostile `block.coinbase` cannot revert the batch, and short calldata reverts rather than
   zero-padding into a selector match.
4. Dry run: one citizen, one full epoch, then withdraw it back with the cold key.

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
