// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {IArbitrator} from "../interfaces/IArbitrator.sol";
import {IArbitrable} from "../interfaces/IArbitrable.sol";
import {IZKPassportRegistry} from "../interfaces/IZKPassportRegistry.sol";

/// @dev Test-only. A settable attestation registry so PopGatedEligibility can be
///      exercised without the real (off-chain-issued) ZKPassportRegistry deployment.
///      Mirrors the deployed registry's PRESENCE-only semantics — it does NOT verify
///      any zk-proof (that is precisely the honesty caveat under test).
contract MockZKPassportRegistry is IZKPassportRegistry {
    mapping(address => bool) private _verified;

    function setVerified(address wallet, bool v) external {
        _verified[wallet] = v;
    }

    function isVerified(address wallet) external view returns (bool) {
        return _verified[wallet];
    }
}

/// @dev Test-only. An IArbitrable whose rule() ALWAYS reverts, to prove ruling
///      delivery can never brick settlement (the core low-level-calls rule() and
///      emits RulingDeliveryFailed instead of bubbling the revert).
contract RevertingApp is IArbitrable {
    IArbitrator public immutable arbitrator;

    constructor(address arbitratorAddress) {
        arbitrator = IArbitrator(arbitratorAddress);
    }

    function createDispute(uint8 choices) external payable returns (uint256 disputeId) {
        disputeId = arbitrator.createDispute{value: msg.value}(choices, "");
    }

    function rule(uint256, uint256, bool) external pure {
        revert("RevertingApp: nope");
    }

    receive() external payable {}
}

/// @dev Test-only. A benign IArbitrable that lets a test create a dispute with an
///      arbitrary number of choices (SimpleEscrow hardcodes 2) and records the
///      delivered ruling. Used for the split-vote and 1-1-1 tie cases.
contract MockArbitrable is IArbitrable {
    IArbitrator public immutable arbitrator;
    uint256 public lastDisputeId;
    uint256 public lastRuling;
    bool public ruled;
    bool public lastWasFinal;
    uint256 public provisionalCount;

    constructor(address arbitratorAddress) {
        arbitrator = IArbitrator(arbitratorAddress);
    }

    function createDispute(uint8 choices) external payable returns (uint256 disputeId) {
        disputeId = arbitrator.createDispute{value: msg.value}(choices, "");
    }

    function rule(uint256 disputeId, uint256 ruling, bool isFinal) external {
        require(msg.sender == address(arbitrator), "only arbitrator");
        lastDisputeId = disputeId;
        lastRuling = ruling;
        lastWasFinal = isFinal;
        ruled = isFinal;
        provisionalCount += isFinal ? 0 : 1;
        emit Ruling(arbitrator, disputeId, ruling, isFinal);
    }

    /// @dev Test-only escape hatch: forward a raw call so a test can hit the core with calldata a
    ///      well-behaved app would never build (an oversized party list, for instance).
    function forward(address target, bytes calldata data) external payable {
        (bool ok, bytes memory ret) = target.call{value: msg.value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    /// @notice Pull this app's fee refund out of the core.
    function claimFees() external {
        arbitrator.withdraw();
    }

    receive() external payable {}
}
