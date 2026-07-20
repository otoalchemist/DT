// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/// @notice Stateless ETH forwarder for a private builder-incentive transaction.
/// @dev There is deliberately no owner, storage, withdrawal path, fallback, or
/// arbitrary-call surface. The caller signs the last block in which the bid may
/// transfer value, so a relay cannot retain a raw transaction and collect the bid
/// in a later slot. Ethereum transactions themselves do not expire: an expired
/// raw transaction can still be included as a revert and consume bounded gas and
/// the sender nonce. A failed fee-recipient call reverts the transaction, so value
/// can never remain available for a third party to recover.
contract CoinbasePayer {
    error CoinbasePaymentTooEarly(uint256 currentTimestamp, uint256 notBeforeTimestamp);
    error CoinbasePaymentExpired(uint256 currentBlock, uint256 validThroughBlock);
    error CoinbasePaymentFailed();

    function payCoinbase(uint256 notBeforeTimestamp, uint256 validThroughBlock) external payable {
        if (block.timestamp < notBeforeTimestamp) {
            revert CoinbasePaymentTooEarly(block.timestamp, notBeforeTimestamp);
        }
        if (block.number > validThroughBlock) {
            revert CoinbasePaymentExpired(block.number, validThroughBlock);
        }
        (bool paid, ) = payable(block.coinbase).call{value: msg.value}("");
        if (!paid) revert CoinbasePaymentFailed();
    }
}
