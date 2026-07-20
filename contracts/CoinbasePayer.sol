// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * CoinbasePayer — a minimal forwarder used to bid for top-of-block bundle
 * placement with a FLAT payment to the block builder (a "coinbase transfer"),
 * independent of gas/tip. The Death & Taxes bot sends ETH to this contract inside
 * its pre-boundary payment bundle (config: coinbaseBidEth + coinbasePayerAddress);
 * receive() forwards it to `block.coinbase`, i.e. whichever builder wins the slot.
 *
 * Deploy this ONCE (e.g. in Remix: paste, compile with 0.8.20+, Deploy), then put
 * the deployed address in the bot's config (Just-in-time panel → Coinbase bid).
 * No constructor args. Costs nothing to hold — it never keeps funds in the normal
 * path. `withdraw()` recovers any ETH that got stuck (e.g. a builder whose coinbase
 * rejected the transfer); only the deployer can call it.
 *
 * SAFETY: the forward uses a low-level call and IGNORES failure, so the bid tx can
 * never revert and drag your payment down. In the bot the bid is additionally
 * marked allowed-to-revert in the bundle as a second layer of protection.
 */
contract CoinbasePayer {
    address public immutable owner;

    constructor() {
        owner = msg.sender;
    }

    /// Forward all received ETH to the block builder. Never reverts.
    receive() external payable {
        _forward();
    }

    /// Same as receive(), for callers that send calldata.
    fallback() external payable {
        _forward();
    }

    /// Send this call's ETH to `block.coinbase`, discarding the result so it can
    /// NEVER revert (a failed forward must not drag down the payment bundle).
    /// Inline assembly is used purely to drop the call's success flag without a
    /// compiler warning — the high-level `.call` leaves the return value unused,
    /// which is intentional but warns. Equivalent to:
    ///   (bool ok, ) = block.coinbase.call{value: msg.value}("");  // ok ignored
    function _forward() private {
        assembly {
            // call(gas, addr, value, inOffset, inSize, outOffset, outSize)
            pop(call(gas(), coinbase(), callvalue(), 0, 0, 0, 0))
        }
    }

    /// Recover ETH stuck here (only if a forward ever failed). Deployer only.
    function withdraw() external {
        require(msg.sender == owner, "not owner");
        (bool ok, ) = owner.call{value: address(this).balance}("");
        require(ok, "withdraw failed");
    }
}
