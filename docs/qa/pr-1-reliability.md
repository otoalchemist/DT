# Owner QA — PR #1 Reliability

This gate uses only dry-run mode and a disposable Anvil mainnet fork. It needs
Node.js 20.19+, 22.12+, or 24+, Foundry/Anvil, and a read-only mainnet RPC URL
that supports exact-block/archive state requests for the fork. Do not import or
fund a production wallet. Stop any older checkout first; the temporary `DATA_DIR`
below must be owned by exactly one running backend for the entire exercise.

1. From the exact commit under review, run `npm ci`, `npm test`,
   `npm run test:integration`, `npm run build`, and `npm run check:diff`; confirm
   all commands pass. Also run `npm test -w @dat-bot/web` and confirm the bootstrap
   compatibility tests reject both older and newer backend versions.
2. Start `anvil --fork-url <YOUR_READ_ONLY_MAINNET_RPC> --chain-id 31337 --host 127.0.0.1 --port 8545` in one terminal. The explicit non-mainnet chain ID is required because local mode deliberately refuses direct broadcast to chain ID 1, even when the endpoint is a fork. Use only Anvil's documented disposable accounts and keys below; never use a production key.
3. In another shell, transfer Citizens 272 and 382 on the fork to Anvil's first disposable account. The bot now verifies `ownerOf`, so `OWNED_TOKENS` alone intentionally cannot claim ownership:

   ```bash
   export RPC=http://127.0.0.1:8545
   export GAME=0xa448c7f618087dDa1a3B128cAd8A424fBae4B71F
   export TEST_ACCOUNT=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
   export CITIZENS=$(cast call --rpc-url "$RPC" "$GAME" "citizens()(address)")
   cast rpc --rpc-url "$RPC" anvil_setBalance "$TEST_ACCOUNT" 0x56BC75E2D63100000
   for TOKEN in 272 382; do
     OWNER=$(cast call --rpc-url "$RPC" "$CITIZENS" "ownerOf(uint256)(address)" "$TOKEN")
     cast rpc --rpc-url "$RPC" anvil_impersonateAccount "$OWNER"
     cast rpc --rpc-url "$RPC" anvil_setBalance "$OWNER" 0x56BC75E2D63100000
     cast send --rpc-url "$RPC" --unlocked --from "$OWNER" "$CITIZENS" \
       "transferFrom(address,address,uint256)" "$OWNER" "$TEST_ACCOUNT" "$TOKEN"
     cast rpc --rpc-url "$RPC" anvil_stopImpersonatingAccount "$OWNER"
   done
   ```

4. Create a new temporary state directory outside the checkout. Verify no process
   is using it, then run `MODE=local RPC_HTTP_URL=http://127.0.0.1:8545 OWNED_TOKENS=272,382 DATA_DIR=<TEMP_DIR> npm run dev` and open the dashboard. Do not
   start a second backend against `<TEMP_DIR>`.
5. Import Anvil's first disposable development key (shown in Anvil's startup output) into the temporary keystore. Keep Dry Run enabled.
6. Select only Citizen 272 and arm JIT for the displayed next epoch. Confirm the
   response and a page reload show the same epoch, an authoritative armed-ID list
   containing only Citizen 272, and exposure for one Citizen. Confirm the token
   checkboxes and **all/none** controls are disabled while armed.
7. Confirm Defense remains disabled and no payment is planned for Citizen 382.
8. Change a defense setting. Confirm the JIT campaign is unchanged; repeat from a stale browser tab and confirm the stale save is rejected rather than overwriting newer state.
9. Advance Anvil to the next epoch with `cast rpc --rpc-url "$RPC" evm_increaseTime 86400` followed by `cast rpc --rpc-url "$RPC" evm_mine`. Confirm Citizen 272 is simulated once using the new epoch's value and the dry-run campaign records `completed-dry-run`; Citizen 382 remains untouched.
10. Run the journal recovery suite again with `npm run test -w @dat-bot/backend -- submission-journal.test.ts nonce.test.ts`. Confirm it passes and reports no duplicate nonce allocation.
11. Run `npm run test -w @dat-bot/backend -- api.test.ts -t "queues a concurrent lock"`. Confirm the serialized lifecycle test completes without leaving the old wallet active.
12. Exercise an activity entry in each new submission state, especially
    `delivery-uncertain`. Confirm its status pill is distinguishable and long
    status/message/hash content wraps without widening or clipping the activity
    panel.
13. Stop `npm run dev` and wait for both child processes to exit before deleting
    the temporary state directory or using it with another build.

Report each command and manual step as pass/fail with observations on the PR.
Only evidence from the exact reviewed commit, followed by owner acceptance or an
explicitly recorded deferral, closes the milestone.
