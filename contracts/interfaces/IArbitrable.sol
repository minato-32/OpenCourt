// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {IArbitrator} from "./IArbitrator.sol";

/// @title IArbitrable — implemented by any app/DAO that outsources a decision.
/// @notice The arbitrator calls `rule` when a dispute resolves. Implementations MUST NOT revert in
///         a way that can brick the protocol; the arbitrator calls this without letting a revert
///         bubble, and offers pull re-delivery.
interface IArbitrable {
    /// @param isFinal false while the ruling can still be overturned on appeal.
    event Ruling(IArbitrator indexed arbitrator, uint256 indexed disputeId, uint256 ruling, bool isFinal);

    /// @notice Deliver a ruling. Only callable by the arbitrator.
    /// @param isFinal true when no further round can change this ruling. An app MUST NOT take an
    ///        irreversible action — paying out, shipping, banning — on a ruling that is not final;
    ///        a later round can reverse it. Show it, do not act on it.
    function rule(uint256 disputeId, uint256 ruling, bool isFinal) external;
}
