// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Minimal integration fixture for the production contract's exact
/// epoch-priced payment behavior. It intentionally rejects a transaction signed
/// with the previous epoch's value once the next epoch begins.
contract EpochPricedTaxes {
    uint256 public constant EPOCH_DURATION = 1 days;
    uint256 public constant BASE_TAX = 0.00069 ether;

    uint256 public immutable START_TIME;
    mapping(uint256 => uint256) public lastEpochPaid;

    constructor() {
        START_TIME = block.timestamp;
    }

    function startTime() external view returns (uint256) {
        return START_TIME;
    }

    function currentEpoch() public view returns (uint256) {
        return 1 + ((block.timestamp - START_TIME) / EPOCH_DURATION);
    }

    function requiredValue(uint256 epochs) public view returns (uint256) {
        return currentEpoch() * BASE_TAX * epochs;
    }

    function payTaxes(uint256 tokenId, uint256 epochs) external payable {
        require(epochs > 0, "zero epochs");
        require(msg.value == requiredValue(epochs), "wrong epoch price");
        lastEpochPaid[tokenId] += epochs;
    }
}
