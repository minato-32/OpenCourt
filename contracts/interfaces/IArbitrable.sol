// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {IArbitrator} from "./IArbitrator.sol";

/// @title IArbitrable — implemented by any app/DAO that outsources a decision.
/// @notice The arbitrator calls `rule` exactly once per dispute when it resolves.
///         Implementations MUST NOT revert in a way that can brick the protocol;
///         the arbitrator wraps this call in try/catch and offers pull re-delivery.
interface IArbitrable {
    event Ruling(IArbitrator indexed arbitrator, uint256 indexed disputeId, uint256 ruling);

    /// @notice Deliver the final ruling. Only callable by the arbitrator.
    function rule(uint256 disputeId, uint256 ruling) external;
}
