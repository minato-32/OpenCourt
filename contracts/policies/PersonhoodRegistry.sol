// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {IZKPassportRegistry} from "../interfaces/IZKPassportRegistry.sol";

/// @title PersonhoodRegistry — attestation registry behind the PoP-gated courts.
/// @notice One credential binds to one wallet at a time. An off-chain issuer decides who is a
///         unique human; this contract only records and enforces the binding.
///
/// @dev HONEST GUARANTEE. No zero-knowledge proof is verified on chain. `isVerified` is true iff a
///      credential hash is currently bound to the wallet, so the gate is exactly as strong as the
///      issuer. A compromised issuer can mint unlimited verified wallets. Do not market a court
///      gated on this as sybil-proof.
///
///      What this DOES enforce, and what the deployed reference registry did not:
///       - one credential cannot be bound to two wallets at once;
///       - one wallet cannot hold two credentials;
///       - after a revoke, the credential cannot rebind to any wallet until a cooldown elapses,
///         so a single passport cannot walk itself across addresses to pack a panel.
contract PersonhoodRegistry is IZKPassportRegistry {
    /// @notice Blocks a credential must wait after revocation before it may bind again.
    uint64 public immutable rebindCooldownBlocks;

    address public issuer;

    /// @notice Credential hash currently bound to a wallet; zero means unverified.
    mapping(address => bytes32) public credentialOf;
    /// @notice Wallet a credential is currently bound to; zero means free.
    mapping(bytes32 => address) public walletOf;
    /// @notice Block a credential was last revoked at; the cooldown runs from here.
    mapping(bytes32 => uint64) public revokedAt;

    event Attested(address indexed wallet, bytes32 indexed credential);
    event Revoked(address indexed wallet, bytes32 indexed credential, uint64 rebindableAt);
    event IssuerTransferred(address indexed from, address indexed to);

    error NotIssuer();
    error ZeroAddress();
    error ZeroCredential();
    error WalletAlreadyBound();
    error CredentialAlreadyBound();
    error RebindTooSoon(uint64 rebindableAt);
    error NotBound();

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert NotIssuer();
        _;
    }

    constructor(address initialIssuer, uint64 cooldownBlocks) {
        if (initialIssuer == address(0)) revert ZeroAddress();
        issuer = initialIssuer;
        rebindCooldownBlocks = cooldownBlocks;
        emit IssuerTransferred(address(0), initialIssuer);
    }

    /// @inheritdoc IZKPassportRegistry
    /// @dev Presence of a binding, not proof of personhood. See the contract NatSpec.
    function isVerified(address wallet) external view returns (bool) {
        return credentialOf[wallet] != bytes32(0);
    }

    /// @notice Bind a credential to a wallet.
    function attest(address wallet, bytes32 credential) external onlyIssuer {
        if (wallet == address(0)) revert ZeroAddress();
        if (credential == bytes32(0)) revert ZeroCredential();
        if (credentialOf[wallet] != bytes32(0)) revert WalletAlreadyBound();
        if (walletOf[credential] != address(0)) revert CredentialAlreadyBound();

        // Anti revoke-rebind: a freed credential is parked for the cooldown.
        uint64 freedAt = revokedAt[credential];
        if (freedAt != 0) {
            uint64 rebindableAt = freedAt + rebindCooldownBlocks;
            if (uint64(block.number) < rebindableAt) revert RebindTooSoon(rebindableAt);
        }

        credentialOf[wallet] = credential;
        walletOf[credential] = wallet;
        emit Attested(wallet, credential);
    }

    /// @notice Release a wallet's credential and start its rebind cooldown.
    function revoke(address wallet) external onlyIssuer {
        bytes32 credential = credentialOf[wallet];
        if (credential == bytes32(0)) revert NotBound();

        delete credentialOf[wallet];
        delete walletOf[credential];
        revokedAt[credential] = uint64(block.number);

        emit Revoked(wallet, credential, uint64(block.number) + rebindCooldownBlocks);
    }

    function transferIssuer(address newIssuer) external onlyIssuer {
        if (newIssuer == address(0)) revert ZeroAddress();
        emit IssuerTransferred(issuer, newIssuer);
        issuer = newIssuer;
    }

    /// @notice Block from which a credential may bind again; zero when it never was revoked.
    function rebindableAt(bytes32 credential) external view returns (uint64) {
        uint64 freedAt = revokedAt[credential];
        return freedAt == 0 ? 0 : freedAt + rebindCooldownBlocks;
    }
}
