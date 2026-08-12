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
 * path. `withdraw()` recovers ETH forced into the contract by another contract;
 * only the deployer can call it.
 *
 * SAFETY: a failed forward REVERTS, returning the bid to its sender rather than
 * trapping it for the deployer to withdraw. The bot marks this bid transaction as
 * allowed-to-revert, so a rejecting builder cannot invalidate mandatory payments
 * earlier in the bundle.
 */
contract CoinbasePayer {
    address public immutable owner;

    constructor() {
        owner = msg.sender;
    }

    /// Forward all received ETH to the block builder or return it to the sender.
    receive() external payable {
        _forward();
    }

    /// Same as receive(), for callers that send calldata.
    fallback() external payable {
        _forward();
    }

    /// Send this call's ETH to `block.coinbase`. A failed transfer must revert:
    /// otherwise the bid remains in this contract and becomes withdrawable by the
    /// deployer, while the sender receives neither builder priority nor its ETH back.
    function _forward() private {
        (bool ok, ) = block.coinbase.call{value: msg.value}("");
        require(ok, "coinbase transfer failed");
    }

    /// Recover ETH forced into this contract by another contract. Deployer only.
    function withdraw() external {
        require(msg.sender == owner, "not owner");
        (bool ok, ) = owner.call{value: address(this).balance}("");
        require(ok, "withdraw failed");
    }
}
