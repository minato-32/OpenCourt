// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {IEligibility} from "../interfaces/IEligibility.sol";
import {IZKPassportRegistry} from "../interfaces/IZKPassportRegistry.sol";

/// @title PopGatedEligibility — one credential, one slot.
/// @notice A juror holding a personhood credential fields exactly one slot no matter how much they
///         stake. That is the whole differentiator: capturing a panel costs people, not money.
///
/// @dev DEMO-GRADE PERSONHOOD — do not overclaim. The gate is only as strong as the registry
///      behind it, and a registry that records an off-chain issuer's say-so proves attestation
///      PRESENCE, not personhood. A compromised or lax issuer can mint unlimited verified wallets.
///      Treat a court gated on such a registry as demo-grade until an eligibility source that binds
///      one live human to one wallet on chain replaces it.
contract PopGatedEligibility is IEligibility {
    IZKPassportRegistry public immutable registry;

    error ZeroRegistry();

    constructor(address personhoodRegistry) {
        if (personhoodRegistry == address(0)) revert ZeroRegistry();
        registry = IZKPassportRegistry(personhoodRegistry);
    }

    /// @inheritdoc IEligibility
    function weightOf(address juror, uint96) external view returns (uint256) {
        return registry.isVerified(juror) ? 1 : 0;
    }

    /// @inheritdoc IEligibility
    function policyDescriptor() external pure returns (string memory) {
        return "personhood-gated: one credential, one slot (attestation presence, not a zk proof)";
    }
}
