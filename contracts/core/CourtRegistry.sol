// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {ArbitratorCore} from "./ArbitratorCore.sol";

/// @title CourtRegistry — a validating registry + factory for jury courts.
/// @notice Phase-2 multi-court seam. ArbitratorCore is a SINGLE hardcoded court
///         whose config is frozen at deploy; this registry lets apps discover and
///         mint courts by a stable `courtId`, and re-checks the economic guards at
///         registration so a mis-parameterised court can never enter the registry.
///
/// INTEGRATION BOUNDARY (documented): ArbitratorCore itself is registry-agnostic —
///         it does not read this contract and needs no changes to keep working
///         standalone. The registry is the coordinator: `createCourt` deploys a
///         fresh ArbitratorCore (the factory), and `registerCourt` admits an
///         already-deployed core after re-validating the config it reports. Wiring
///         courtId INTO the core (per-court routing inside one ArbitratorCore) was
///         judged too invasive for Phase 2 and is left to the pallet era.
contract CourtRegistry {
    // Mirror the core's economic invariants so validation is self-contained.
    uint16 internal constant BPS = 10_000;
    uint16 internal constant MAX_SLASH_BPS = 5_000;
    uint16 internal constant MAX_TAKE_BPS = 2_000;
    uint16 internal constant MAX_QSTAR_RATIO = 6_000; // FR-CR-02: q* <= 0.60 (spec §7 band 0.5-0.6)
    uint32 internal constant MAX_PANEL = 15;

    struct Court {
        address arbitrator; // deployed ArbitratorCore
        address eligibility; // its eligibility policy
        address registrant; // who registered it
        bytes32 configHash; // snapshot of the court's config
        bool active;
        // PROVENANCE (audit HIGH). true  => this registry deployed the core itself via
        // createCourt (the factory), so its bytecode IS a known-good ArbitratorCore.
        // false => registerCourt admitted a caller-supplied core address. The registry
        // only checks that the SELF-REPORTED config hashes to the core's snapshot — it
        // canNOT prove the bytecode at that address is an honest ArbitratorCore. An
        // unverified court may be fee-stealing, non-terminal, or otherwise malicious;
        // apps MUST treat verified==false as "self-attested, trust at your own risk".
        bool verified;
    }

    uint256 public courtCount;
    mapping(uint256 => Court) public courts;

    event CourtRegistered(
        uint256 indexed courtId,
        address indexed arbitrator,
        address indexed registrant,
        bytes32 configHash,
        bool verified
    );

    error BadConfig(string what);
    error NotACourt();
    error ConfigMismatch();

    /// @notice Re-check the economic + structural guards on a court config.
    /// @dev Pure and standalone: an app can dry-run this before committing gas.
    ///      These are exactly the guards ArbitratorCore enforces in its constructor,
    ///      surfaced here so registration fails loudly with the specific reason.
    ///      MUST mirror the ArbitratorCore constructor guards EXACTLY — a config that
    ///      passes here but fails there (or vice-versa) is a validation-parity bug.
    function validateConfig(ArbitratorCore.CourtConfig calldata cfg, address eligibility) public pure {
        if (eligibility == address(0)) revert BadConfig("eligibility");
        if (cfg.panelSize == 0 || cfg.panelSize > MAX_PANEL || cfg.panelSize % 2 == 0) revert BadConfig("panelSize");
        if (cfg.minStake == 0) revert BadConfig("minStake");
        if (cfg.jurorFee == 0) revert BadConfig("jurorFee");
        if (cfg.drawThreshold == 0) revert BadConfig("drawThreshold");
        // Draw timing: a real gap before the seed's blockhash, window <= 255 so every
        // claimable block has a live blockhash. (Previously omitted here — parity bug.)
        if (cfg.drawDelayBlocks == 0) revert BadConfig("drawDelay");
        if (cfg.drawWindowBlocks == 0 || cfg.drawWindowBlocks > 255) revert BadConfig("drawWindow");
        // A zero commit / reveal window closes the phase in the block it opens and
        // freezes or slashes every seated juror. (Previously omitted here.)
        if (cfg.commitBlocks == 0) revert BadConfig("commitBlocks");
        if (cfg.revealBlocks == 0) revert BadConfig("revealBlocks");
        // Slash caps: neither penalty may exceed the protocol slash ceiling; gamma
        // must be non-zero (a zero non-reveal penalty makes silence free). (gamma==0
        // was previously omitted here — parity bug.)
        if (cfg.betaBps > MAX_SLASH_BPS) revert BadConfig("betaBps");
        if (cfg.gammaBps == 0 || cfg.gammaBps > MAX_SLASH_BPS) revert BadConfig("gammaBps");
        // Silence must cost at least as much as being wrong.
        if (cfg.gammaBps < cfg.betaBps) revert BadConfig("gamma<beta");
        if (cfg.thetaBps >= BPS) revert BadConfig("thetaBps");
        if (cfg.quorumBps == 0 || cfg.quorumBps > BPS) revert BadConfig("quorumBps");
        // App + protocol take is bounded (jurors paid first out of the gross-up).
        if (uint256(cfg.appFeeBps) + cfg.protocolFeeBps > MAX_TAKE_BPS) revert BadConfig("take");
        if (cfg.treasury == address(0)) revert BadConfig("treasury");
        // FR-CR-02 — jurors must not be underpaid for what they are made to risk.
        // q* is the probability a rational juror would have to assign to "my vote
        // ends up the incoherent one" before voting honestly stops paying:
        //     q*       = atRisk / (atRisk + jurorFee + expectedPotShare)   <= 0.60
        //     atRisk   = betaBps * minStake / BPS
        //     potShare = (BPS - thetaBps) * betaBps * minStake * incoherent
        //                / (BPS * BPS * coherent)
        // with the spec's one-third-dissent panel model (incoherent = panelSize/3).
        // Above the ceiling the court is buying security with the PENALTY instead of
        // the FEE, which is exactly the parameterisation spec §7 forbids.
        // Every term is carried SCALED BY BPS so a sub-unit pot share cannot truncate
        // to zero, and the ratio is compared cross-multiplied (no division by the sum).
        // MUST stay byte-identical to the ArbitratorCore constructor (validation parity).
        {
            uint256 incoherent = uint256(cfg.panelSize) / 3; // modelled dissenting seats
            uint256 coherent = uint256(cfg.panelSize) - incoherent; // >= 1 for panelSize >= 1
            uint256 atRiskScaled = uint256(cfg.betaBps) * cfg.minStake; // atRisk * BPS
            uint256 feeScaled = cfg.jurorFee * BPS; // jurorFee * BPS
            // coherent == 0 is unreachable (panelSize >= 1 is checked above); guarded
            // anyway so the expression can never divide by zero.
            uint256 potScaled = coherent == 0
                ? 0
                : ((uint256(BPS) - cfg.thetaBps) * cfg.betaBps * cfg.minStake * incoherent)
                    / (uint256(BPS) * coherent); // expectedPotShare * BPS
            if (atRiskScaled * BPS > (atRiskScaled + feeScaled + potScaled) * MAX_QSTAR_RATIO) {
                revert BadConfig("jurorsUnderpaid");
            }
        }
    }

    /// @notice Factory: validate a config, deploy a fresh ArbitratorCore, register it.
    /// @return courtId a stable id an app can select this court by.
    /// @return arbitrator the deployed core.
    function createCourt(ArbitratorCore.CourtConfig calldata cfg, address eligibility)
        external
        returns (uint256 courtId, address arbitrator)
    {
        validateConfig(cfg, eligibility);
        ArbitratorCore core = new ArbitratorCore(cfg, eligibility);
        arbitrator = address(core);
        // Factory-deployed => the registry KNOWS the bytecode is a genuine
        // ArbitratorCore => verified.
        courtId = _record(arbitrator, eligibility, core.configHash(), true);
    }

    /// @notice Admit an already-deployed ArbitratorCore after re-validating the
    ///         config it reports. The caller passes the config it expects; the
    ///         registry checks the guards AND that it hashes to the core's snapshot,
    ///         so a court cannot be registered under a config it does not actually run.
    /// @dev    SELF-ATTESTED provenance: this only proves the reported CONFIG matches
    ///         the core's stored configHash. It does NOT prove the bytecode at
    ///         `arbitrator` is an honest ArbitratorCore — a malicious look-alike can
    ///         expose the same configHash getter yet steal fees or never terminate.
    ///         Such a court is recorded with verified=false; apps must gate on it.
    function registerCourt(address arbitrator, ArbitratorCore.CourtConfig calldata cfg)
        external
        returns (uint256 courtId)
    {
        ArbitratorCore core = ArbitratorCore(payable(arbitrator));
        address eligibility = address(core.eligibility());
        validateConfig(cfg, eligibility);
        if (core.configHash() != keccak256(abi.encode(cfg))) revert ConfigMismatch();
        // Caller-supplied core => self-reported => NOT verified.
        courtId = _record(arbitrator, eligibility, core.configHash(), false);
    }

    function _record(address arbitrator, address eligibility, bytes32 cfgHash, bool verified)
        private
        returns (uint256 courtId)
    {
        courtId = ++courtCount;
        courts[courtId] = Court({
            arbitrator: arbitrator,
            eligibility: eligibility,
            registrant: msg.sender,
            configHash: cfgHash,
            active: true,
            verified: verified
        });
        emit CourtRegistered(courtId, arbitrator, msg.sender, cfgHash, verified);
    }

    /// @notice Resolve a courtId to its arbitrator (address(0) if unknown).
    function courtArbitrator(uint256 courtId) external view returns (address) {
        return courts[courtId].arbitrator;
    }

    /// @notice Whether a court's bytecode provenance is registry-verified.
    /// @return known  true if the courtId exists.
    /// @return verified true only if this registry DEPLOYED the core (createCourt).
    ///         false means the core was self-reported via registerCourt — treat as
    ///         untrusted (possibly fee-stealing or non-terminal).
    function courtVerified(uint256 courtId) external view returns (bool known, bool verified) {
        Court storage c = courts[courtId];
        return (c.arbitrator != address(0), c.verified);
    }
}
