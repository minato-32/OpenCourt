// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {IEligibility} from "../interfaces/IEligibility.sol";
import {IZKPassportRegistry} from "../interfaces/IZKPassportRegistry.sol";

/// @title PopGatedEligibility — the personhood-gated eligibility policy.
/// @notice A juror is eligible only if the same-chain ZKPassportRegistry reports an
///         attestation for their wallet. The INTENT is to turn jury capture from a
///         purchasing decision (buy more stake) into a coordination problem (acquire
///         more people).
///
/// @dev    DEMO-GRADE PERSONHOOD (audit CRITICAL — do NOT overclaim). The gate is
///         only as strong as `IZKPassportRegistry.isVerified`, and the DEPLOYED
///         ZKPassportRegistry v1.0.0 does NO on-chain zk-proof verification — it just
///         checks that an attestation hash is PRESENT (see IZKPassportRegistry). So
///         this policy provides:
///           - an attestation-PRESENCE / uniqueness gate keyed on an off-chain
///             issuer's say-so; NOT cryptographic proof-of-personhood.
///         It does NOT provide, and MUST NOT be marketed as providing:
///           - sybil resistance against a compromised/lax issuer (which can mint
///             unlimited "verified" wallets), or
///           - resistance to REVOKE-REBIND: the registry has no cooldown, so one
///             passport can be revoked from wallet A and immediately re-bound to
///             wallet B, walking its personhood across addresses.
///         Treat PoP-gated courts as DEMO-GRADE until an eligibility source that
///         verifies zk-proofs (or otherwise binds one live human to one wallet
///         on-chain) replaces this registry.
contract PopGatedEligibility is IEligibility {
    /// @notice The attestation registry this court reads. NOTE: presence-only; this
    ///         is not an on-chain proof-of-personhood verifier (see contract NatSpec).
    IZKPassportRegistry public immutable registry;

    error ZeroRegistry();

    constructor(address zkPassportRegistry) {
        if (zkPassportRegistry == address(0)) revert ZeroRegistry();
        registry = IZKPassportRegistry(zkPassportRegistry);
    }

    /// @inheritdoc IEligibility
    /// @dev Returns the registry's attestation-presence flag verbatim. This is a
    ///      uniqueness/presence gate, NOT proof-of-personhood — see contract NatSpec.
    function isEligible(address juror) external view returns (bool) {
        return registry.isVerified(juror);
    }
}
