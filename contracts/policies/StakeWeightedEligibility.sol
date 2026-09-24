// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {IEligibility} from "../interfaces/IEligibility.sol";

/// @title StakeWeightedEligibility — open court, stake only.
/// @notice Everyone who staked is eligible, with no cap: the court's own stake accounting decides
///         how many slots a juror fields. Sybil-splitting buys nothing here, because splitting one
///         stake across many wallets does not create extra stake.
/// @dev Plutocratic by design. Use PopGatedEligibility when jury capture must cost people rather
///      than money.
contract StakeWeightedEligibility is IEligibility {
    /// @inheritdoc IEligibility
    function weightOf(address, uint96) external pure returns (uint256) {
        return type(uint256).max; // no cap; the core still bounds this by staked slots
    }

    /// @inheritdoc IEligibility
    function policyDescriptor() external pure returns (string memory) {
        return "stake-weighted: any staker, one slot per minStake";
    }
}
