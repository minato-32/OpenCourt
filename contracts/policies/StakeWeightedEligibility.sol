// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {IEligibility} from "../interfaces/IEligibility.sol";

/// @title StakeWeightedEligibility — open court, stake-only.
/// @notice Everyone with stake is eligible; Sybil-splitting is harmless under
///         stake weight (splitting one stake into many wallets buys no extra
///         weight). Use this court when personhood gating is not required.
contract StakeWeightedEligibility is IEligibility {
    /// @inheritdoc IEligibility
    function isEligible(address) external pure returns (bool) {
        return true;
    }
}
