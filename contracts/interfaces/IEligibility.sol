// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

/// @title IEligibility — pluggable juror-eligibility policy.
/// @notice This is the seam that makes a court personhood-gated (one person, one vote) rather than
///         open and stake-weighted. A court fixes one policy at deploy.
///
/// @dev The core calls `weightOf` through a gas-capped staticcall and treats ANY failure — revert,
///      out of gas, a return value that is not one word — as weight zero. Eligibility fails CLOSED:
///      a broken or hostile policy can lock jurors out of a court, never let an ineligible one in,
///      and can never brick the court for everyone.
///
///      The returned weight is a CAP, not an allocation. The core always locks real stake per seat
///      and never grants more slots than the juror has staked for, so a policy cannot mint jury
///      power out of nothing. Return `type(uint256).max` to impose no cap at all.
interface IEligibility {
    /// @param juror the account claiming seats.
    /// @param courtId the court asking; 0 when the court was deployed standalone.
    /// @return weight maximum slots this juror may hold, in slot units. Zero means not eligible.
    ///         MUST be a view and O(1) — it runs under a gas cap.
    function weightOf(address juror, uint96 courtId) external view returns (uint256 weight);

    /// @notice Human-readable statement of the rule this policy enforces, for disclosure in a UI.
    function policyDescriptor() external view returns (string memory);
}
