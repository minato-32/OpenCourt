// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

/// @title IEligibility — pluggable juror-eligibility policy.
/// @notice A court fixes one eligibility policy at deploy. This is the seam that
///         makes a court PoP-gated (one-person-one-vote) vs open stake-weighted.
interface IEligibility {
    /// @notice Whether `juror` may be seated on a panel in this court.
    function isEligible(address juror) external view returns (bool);
}
