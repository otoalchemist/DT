// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Minimal integration fixture for the production contract's exact
/// epoch-priced payment behavior. It intentionally rejects a transaction signed
/// with the previous epoch's value once the next epoch begins.
contract MockCitizens {
    address public immutable HOLDER;

    constructor(address initialHolder) {
        HOLDER = initialHolder;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        require(tokenId >= 1 && tokenId <= 3, "unknown token");
        return HOLDER;
    }

    function totalSupply() external pure returns (uint256) {
        return 3;
    }

    function balanceOf(address owner) external view returns (uint256) {
        return owner == HOLDER ? 3 : 0;
    }

    function supplyLocked() external pure returns (bool) {
        return true;
    }
}

contract EpochPricedTaxes {
    uint256 public constant EPOCH_DURATION = 1 days;
    uint256 public constant BASE_TAX = 0.00069 ether;

    uint256 public immutable START_TIME;
    MockCitizens private immutable CITIZENS;
    mapping(uint256 => uint256) public lastEpochPaid;

    constructor() {
        START_TIME = block.timestamp;
        CITIZENS = new MockCitizens(msg.sender);
    }

    function startTime() external view returns (uint256) {
        return START_TIME;
    }

    function citizens() external view returns (address) {
        return address(CITIZENS);
    }

    function currentEpoch() public view returns (uint256) {
        return 1 + ((block.timestamp - START_TIME) / EPOCH_DURATION);
    }

    function state() external pure returns (uint8) {
        return 1;
    }

    function requiredValue(uint8 epochs) public view returns (uint256) {
        return currentEpoch() * BASE_TAX * epochs;
    }

    function estimateTaxesToPay(uint256, uint8 epochs) external view returns (uint256) {
        return requiredValue(epochs);
    }

    function auditDueTimestamp(uint256) external pure returns (uint256) {
        return 0;
    }

    function bribeBalance(uint256) external pure returns (uint256) {
        return 0;
    }

    function hasLifeInsurance(uint256) external pure returns (bool) {
        return false;
    }

    function auditLimit(uint256) external pure returns (uint256) {
        return 1;
    }

    function auditsUsedInEpoch(uint256, uint256) external pure returns (uint256) {
        return 0;
    }

    function setLastEpochPaidForTest(uint256 tokenId, uint256 epoch) external {
        require(msg.sender == CITIZENS.HOLDER(), "not fixture holder");
        lastEpochPaid[tokenId] = epoch;
    }

    function payTaxes(uint256 tokenId, uint8 epochs) external payable {
        require(epochs > 0, "zero epochs");
        require(CITIZENS.ownerOf(tokenId) == msg.sender, "not token owner");
        require(msg.value == requiredValue(epochs), "wrong epoch price");
        lastEpochPaid[tokenId] += epochs;
    }
}

/// Minimal implementation of the canonical Multicall3 aggregate3 surface used
/// by viem. The test installs its runtime code at the mainnet Multicall3 address
/// so production clients can execute their normal coherent read batches on Anvil.
contract MockMulticall3 {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory results) {
        results = new Result[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            (bool success, bytes memory returnData) = calls[i].target.call(calls[i].callData);
            require(success || calls[i].allowFailure, "multicall failed");
            results[i] = Result({ success: success, returnData: returnData });
        }
    }
}
