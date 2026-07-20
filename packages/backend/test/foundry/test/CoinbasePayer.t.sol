// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {CoinbasePayer} from "repo-contracts/CoinbasePayer.sol";

interface Vm {
    function coinbase(address newCoinbase) external;
    function deal(address account, uint256 balance) external;
    function roll(uint256 newHeight) external;
    function warp(uint256 newTimestamp) external;
}

contract CoinbasePayerTest {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    CoinbasePayer private payer;
    uint256 private received;

    receive() external payable {
        received += msg.value;
    }

    function setUp() public {
        payer = new CoinbasePayer();
        VM.deal(address(this), 10 ether);
        VM.coinbase(address(this));
    }

    function testPaysAtSignedDeadlineAndNotBeforeTimestamp() public {
        VM.roll(100);
        VM.warp(1_000);
        payer.payCoinbase{value: 1 ether}(1_000, 100);
        require(received == 1 ether, "deadline payment not forwarded");
        require(address(payer).balance == 0, "payer retained value");
    }

    function testRevertsBeforeSignedNotBeforeTimestamp() public {
        VM.roll(100);
        VM.warp(999);
        (bool success, ) = address(payer).call{value: 1 ether}(
            abi.encodeCall(CoinbasePayer.payCoinbase, (1_000, 100))
        );
        require(!success, "early payment executed");
        require(received == 0, "early payment reached coinbase");
        require(address(payer).balance == 0, "early value was stranded");
    }

    function testRevertsAfterSignedDeadlineWithoutTransferringValue() public {
        VM.roll(101);
        VM.warp(1_000);
        (bool success, ) = address(payer).call{value: 1 ether}(
            abi.encodeCall(CoinbasePayer.payCoinbase, (1_000, 100))
        );
        require(!success, "expired payment executed");
        require(received == 0, "expired payment reached coinbase");
        require(address(payer).balance == 0, "expired value was stranded");
    }

    function testRejectsLegacyEmptyCalldataTransfer() public {
        VM.roll(100);
        (bool success, ) = address(payer).call{value: 1 ether}("");
        require(!success, "empty-calldata transfer bypassed deadline");
        require(received == 0, "legacy transfer reached coinbase");
    }
}
