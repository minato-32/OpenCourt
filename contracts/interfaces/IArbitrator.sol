// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

/// @title IArbitrator — the stable seam an app calls to get a dispute resolved.
/// @notice The protocol resolves disputes; it never knows what a dispute is about.
///         Kleros-style: `choices` is the number of ruling options; ruling 0 is
///         "refuse to arbitrate / tie", 1..choices are the concrete options.
interface IArbitrator {
    /// @notice Raise a dispute. The caller (an IArbitrable app) must send
    ///         `arbitrationCost()` as msg.value to prepay juror fees.
    /// @param choices number of ruling options (1..K, K<=8).
    /// @param extraData opaque, reserved for future court selection.
    /// @return disputeId the new dispute id.
    function createDispute(uint8 choices, bytes calldata extraData)
        external
        payable
        returns (uint256 disputeId);

    /// @notice Fee the app must prepay to raise a dispute in this court.
    function arbitrationCost(bytes calldata extraData) external view returns (uint256);

    /// @notice Current (or final) ruling for a dispute.
    function currentRuling(uint256 disputeId)
        external
        view
        returns (uint256 ruling, bool tied, bool finalized);

    /// @notice Raw lifecycle state of a dispute (see DisputeState).
    function disputeState(uint256 disputeId) external view returns (uint8 state);

    /// @notice Target panel size for a round in this arbitrator. Used to check that an appeal
    ///         ladder actually escalates (FR-AP-01).
    function panelSize() external view returns (uint32);

    /// @notice Pull exactly what settlement left the app for ONE dispute, paid to that dispute's
    ///         app. Unlike withdraw(), which hands over an unattributable lump, this is tagged —
    ///         an app holding several disputes can credit each refund to the right case.
    function claimRefund(uint256 disputeId) external returns (uint256 amount);

    /// @notice Pull a caller's credited balance (juror payouts, app fee refunds, and
    ///         any arbitration-fee residue the core credits back to the app). Payouts
    ///         are pull-only so a reverting recipient can never brick settlement.
    function withdraw() external;
}
