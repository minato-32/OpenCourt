// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {IEligibility} from "../interfaces/IEligibility.sol";
import {IZKPassportRegistry} from "../interfaces/IZKPassportRegistry.sol";

/// @title HybridEligibility — stake weight, but only for verified people, and capped.
/// @notice Between the two extremes: an unverified account fields nothing, and a verified one
///         fields up to `maxSlotsPerPerson` slots. Stake still decides how many slots inside that
///         ceiling, so a large stake buys influence but never an unbounded share of a panel.
/// @dev Inherits the registry's honesty caveat: presence of an attestation is not proof of
///      personhood. The cap is what keeps a compromised issuer from handing one wallet the panel.
contract HybridEligibility is IEligibility {
    IZKPassportRegistry public immutable registry;
    uint256 public immutable maxSlotsPerPerson;

    error ZeroRegistry();
    error ZeroCap();

    constructor(address personhoodRegistry, uint256 cap) {
        if (personhoodRegistry == address(0)) revert ZeroRegistry();
        if (cap == 0) revert ZeroCap();
        registry = IZKPassportRegistry(personhoodRegistry);
        maxSlotsPerPerson = cap;
    }

    /// @inheritdoc IEligibility
    function weightOf(address juror, uint96) external view returns (uint256) {
        return registry.isVerified(juror) ? maxSlotsPerPerson : 0;
    }

    /// @inheritdoc IEligibility
    function policyDescriptor() external view returns (string memory) {
        return string.concat(
            "hybrid: verified people only, at most ",
            _toString(maxSlotsPerPerson),
            " slots each"
        );
    }

    function _toString(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 digits;
        for (uint256 t = v; t != 0; t /= 10) digits++;
        bytes memory buf = new bytes(digits);
        for (uint256 i = digits; i > 0; i--) {
            buf[i - 1] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(buf);
    }
}
