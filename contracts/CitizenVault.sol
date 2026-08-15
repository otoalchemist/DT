// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * CitizenVault — holds your citizens so the whole boundary can go out as ONE
 * transaction, with each action allowed to fail on its own.
 *
 * WHY THIS EXISTS
 * ---------------
 * payTaxes / audit / useBribe are owner-only on-chain, so a batch of them can only be
 * sent by whoever HOLDS the citizens. Sending one transaction per action — what the bot
 * does without a vault — makes failure expensive: a reverted audit burns a full ~81,000
 * gas transaction and a whole bundle slot. Inside a batch the same failure costs a few
 * thousand gas of internal call and nothing else, which is what lets an operator fire
 * speculative audits at all.
 *
 * It also removes a race the bot cannot otherwise win: with payments and audits in one
 * call they execute atomically in submitted order, so a rival audit landing one index
 * earlier can no longer invalidate a payment that was signed for the pre-audit price.
 *
 * WHAT IT DELIBERATELY IS NOT
 * ---------------------------
 * No upgrade path, no delegatecall, no generic external call, no owner-settable target.
 * `run` can only reach the ONE game contract fixed at deployment, through FOUR
 * allowlisted selectors. A vault that can call anything is a vault that can be talked
 * into transferring your citizens.
 *
 * KEY SPLIT — owner vs operator
 * -----------------------------
 * `operator` is the bot's hot wallet. It signs every boundary and its key sits on disk.
 * It can call `run` and NOTHING else — it can never move a citizen or take ETH out.
 * `owner` is a cold key you keep offline. It alone can withdraw citizens, sweep ETH, or
 * change the operator. So the worst case from a stolen bot key is wasted gas and audit
 * slots, never loss of the citizens themselves. Set them to the same address only if you
 * accept that trade.
 *
 * DEPLOY (Remix, compiler 0.8.20+), constructor args:
 *   _game      0xa448c7f618087dDa1a3B128cAd8A424fBae4B71F   (DeathAndTaxes)
 *   _citizens  read `citizens()` off the game contract
 *   _operator  the bot wallet address shown in the dashboard header
 * Deploy FROM the cold key — the deployer becomes `owner` permanently.
 *
 * Then put the deployed address in the bot's config (Vault address). Move citizens in
 * with `safeTransferFrom(you, vault, tokenId)`. Move one and run a full epoch before
 * moving the rest: everything after that is reversible only through `withdrawCitizens`.
 *
 * REENTRANCY: none possible. `run` is gated on owner/operator, and the game contract is
 * neither, so a callback from the game cannot re-enter it. `receive` and
 * `onERC721Received` change no state. No guard is used because there is nothing to guard
 * and an unused guard is one more thing a reviewer has to reason about.
 */

interface IERC721 {
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
}

contract CitizenVault {
    /// Cold key. Sole authority to withdraw citizens, sweep ETH, or change the operator.
    address public immutable owner;
    /// The DeathAndTaxes game. Fixed at deployment — `run` can reach nothing else.
    address public immutable game;
    /// The Citizen NFT collection, for withdrawals.
    address public immutable citizens;
    /// The bot's hot wallet. May call `run` and nothing else.
    address public operator;

    /**
     * One game action.
     *
     * `tolerate` is the whole point of the contract: true for speculative work (an audit
     * whose target a rival may cure first), false for anything that must land or you want
     * to know immediately (a tax payment). A tolerated failure is recorded and skipped; an
     * untolerated one reverts the entire batch.
     */
    struct Call {
        bytes data;
        uint256 value;
        bool tolerate;
    }

    /**
     * Per-action outcome, emitted whether the call succeeded or not.
     *
     * A reverted audit emits no `Audited` event, so the game's own logs cannot tell you
     * which of ten queued actions failed. This can: `index` is the position in the array
     * the caller submitted, so the bot maps results straight back onto its activity log.
     */
    event CallResult(uint256 indexed index, bytes4 indexed selector, bool ok);
    event OperatorChanged(address indexed previous, address indexed next);

    error NotOwner();
    error NotAuthorised();
    error ValueMismatch(uint256 sent, uint256 required);
    error SelectorNotAllowed(uint256 index, bytes4 selector);
    error CallFailed(uint256 index);
    error RefundFailed();

    // Computed from the signatures rather than pasted as hex, so they are checkable by
    // reading. Verified against mainnet calldata: payTaxes 0x58670017, audit 0x5daba7c0.
    // payTaxes takes a uint8 epoch count, NOT uint256 — the wrong type here silently
    // produces a selector that matches nothing and every payment reverts.
    bytes4 private constant SEL_PAY_TAXES = bytes4(keccak256("payTaxes(uint256,uint8)"));
    bytes4 private constant SEL_AUDIT = bytes4(keccak256("audit(uint256,uint256)"));
    bytes4 private constant SEL_USE_BRIBE = bytes4(keccak256("useBribe(uint256)"));
    bytes4 private constant SEL_KILL = bytes4(keccak256("kill(uint256)"));

    constructor(address _game, address _citizens, address _operator) {
        owner = msg.sender;
        game = _game;
        citizens = _citizens;
        operator = _operator;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /**
     * Execute a batch of game actions, then optionally pay the block builder.
     *
     * `msg.value` must be exactly the sum of the call values plus `bidWei`, so the vault
     * never needs a standing balance and a miscounted batch fails loudly instead of
     * quietly spending whatever happened to be sitting here.
     *
     * The value of any tolerated call that reverts is refunded to the caller at the end —
     * a failed audit's fee is never consumed, and leaving it here would slowly accumulate
     * ETH in a contract whose whole design is to hold none.
     */
    function run(Call[] calldata calls, uint256 bidWei) external payable {
        if (msg.sender != owner && msg.sender != operator) revert NotAuthorised();

        uint256 n = calls.length;
        uint256 required = bidWei;
        for (uint256 i; i < n; ) {
            required += calls[i].value;
            unchecked { ++i; }
        }
        if (msg.value != required) revert ValueMismatch(msg.value, required);

        uint256 refund;
        for (uint256 i; i < n; ) {
            Call calldata c = calls[i];
            bytes4 sel = bytes4(c.data);
            if (sel != SEL_PAY_TAXES && sel != SEL_AUDIT && sel != SEL_USE_BRIBE && sel != SEL_KILL) {
                revert SelectorNotAllowed(i, sel);
            }
            (bool ok, ) = game.call{ value: c.value }(c.data);
            if (!ok) {
                if (!c.tolerate) revert CallFailed(i);
                refund += c.value;
            }
            emit CallResult(i, sel, ok);
            unchecked { ++i; }
        }

        // The bid, paid inline rather than from a separate forwarder tx — one fewer
        // transaction in the bundle, so the same bid buys a higher value-per-gas.
        // Result deliberately ignored, exactly as CoinbasePayer._forward does: a builder
        // whose fee recipient rejects the transfer must never drag the batch down.
        if (bidWei > 0) {
            assembly {
                pop(call(gas(), coinbase(), bidWei, 0, 0, 0, 0))
            }
        }

        if (refund > 0) {
            (bool sent, ) = msg.sender.call{ value: refund }("");
            if (!sent) revert RefundFailed();
        }
    }

    /// Move citizens back out. Owner only, always available, no conditions — this is the
    /// exit, and nothing in this contract may ever be able to block it.
    function withdrawCitizens(uint256[] calldata tokenIds, address to) external onlyOwner {
        uint256 n = tokenIds.length;
        for (uint256 i; i < n; ) {
            IERC721(citizens).safeTransferFrom(address(this), to, tokenIds[i]);
            unchecked { ++i; }
        }
    }

    /// Recover ETH that ended up here (a game refund, or a stray transfer). Owner only.
    function sweep(address to) external onlyOwner {
        (bool ok, ) = to.call{ value: address(this).balance }("");
        if (!ok) revert RefundFailed();
    }

    /// Rotate the bot wallet — after a key rotation, or to disable batching entirely by
    /// setting it to the zero address. Owner only.
    function setOperator(address next) external onlyOwner {
        emit OperatorChanged(operator, next);
        operator = next;
    }

    /// Required for `safeTransferFrom` to accept a citizen into the vault.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    /// Accept refunds from the game without reverting. `sweep` recovers anything left.
    receive() external payable {}
}
