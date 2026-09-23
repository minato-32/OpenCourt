// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

/// @title IZKPassportRegistry — the subset of the deployed ZKPassportRegistry the
///        jury protocol reads for its personhood gate (same-chain).
/// @dev   HONEST GUARANTEE (audit CRITICAL). Despite the "ZK" name, the deployed
///        ZKPassportRegistry v1.0.0 performs NO on-chain zero-knowledge proof
///        verification. `isVerified(wallet)` returns true iff an attestation hash is
///        PRESENT for that wallet — i.e. an off-chain issuer once wrote a record. It
///        is an attestation-presence / uniqueness gate, NOT cryptographic
///        proof-of-personhood: the chain never checks a zk-proof and cannot tell a
///        real human from an issuer that rubber-stamped an address.
///
///        Trust assumptions this places on the OFF-CHAIN issuer:
///          - the issuer, not the contract, decides who is "a unique human";
///          - a compromised or lax issuer can mint unlimited "verified" wallets;
///          - REVOKE-REBIND: there is NO cooldown. A passport can be revoked from
///            wallet A and immediately re-bound to wallet B, so one passport can walk
///            its personhood across many addresses over time.
///
///        Courts gated on this registry are therefore DEMO-GRADE for personhood.
///        Do NOT market them as sybil-proof or as proof-of-personhood until a
///        registry that actually verifies zk-proofs on-chain replaces this one.
interface IZKPassportRegistry {
    /// @notice True iff an attestation hash is currently present for `wallet`.
    /// @dev    Presence only — this is NOT a zk-proof verification. See the contract
    ///         NatSpec above for the real (weaker) guarantee.
    function isVerified(address wallet) external view returns (bool);
}
