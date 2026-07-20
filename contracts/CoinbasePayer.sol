// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/// @notice Stateless ETH forwarder for a private builder-incentive transaction.
/// @dev There is deliberately no owner, storage, withdrawal path, fallback, or
/// arbitrary-call surface. A failed fee-recipient call reverts the transaction,
/// so value can never remain available for a third party to recover.
contract CoinbasePayer {
    error CoinbasePaymentFailed();

    receive() external payable {
        (bool paid, ) = payable(block.coinbase).call{value: msg.value}("");
        if (!paid) revert CoinbasePaymentFailed();
    }
}
