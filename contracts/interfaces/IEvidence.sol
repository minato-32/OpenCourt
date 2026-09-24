// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {IArbitrator} from "./IArbitrator.sol";

/// @title IEvidence — the ERC-1497 evidence standard, as an arbitrable implements it.
/// @notice Three log shapes let any indexer read a dispute it knows nothing about:
///         MetaEvidence says what the agreement was and how to render the choices,
///         Evidence attaches one argument to a group, and Dispute joins an arbitrator's
///         dispute id to those two ids.
///
/// @dev The signatures are the standard's, verbatim, so an existing ERC-1497 indexer
///      picks GetCourt up with no adapter. Leading-underscore parameter names are the
///      standard's too — kept rather than tidied, because the ABI names are part of it.
///
///      The evidence GROUP is the useful half. A dispute id only exists once a dispute
///      is raised, but parties argue before that; the group id is chosen by the app up
///      front, so pre-dispute filings and the eventual panel's record share one key.
interface IEvidence {
    /// @notice The agreement under dispute, as a pointer to a JSON document off chain.
    event MetaEvidence(uint256 indexed _metaEvidenceID, string _evidence);

    /// @notice One piece of evidence attached to a group.
    event Evidence(
        IArbitrator indexed _arbitrator,
        uint256 indexed _evidenceGroupID,
        address indexed _party,
        string _evidence
    );

    /// @notice Joins an arbitrator's dispute to its meta-evidence and evidence group.
    event Dispute(
        IArbitrator indexed _arbitrator,
        uint256 indexed _disputeID,
        uint256 _metaEvidenceID,
        uint256 _evidenceGroupID
    );
}

/// @title IEvidenceGroups — the arbitrator side of ERC-1497 grouping.
/// @notice Optional. An arbitrator that stores evidence itself needs to know which group to log a
///         filing under; one that only rules does not.
interface IEvidenceGroups {
    /// @notice Point a dispute at an evidence group the app opened before raising it.
    /// @dev App-only, and only while the dispute's evidence window is open, so the key a juror's
    ///      client indexes on cannot move once the panel exists.
    function linkEvidenceGroup(uint256 disputeId, uint256 appGroupId) external;

    /// @notice The group a dispute's filings are logged under.
    function evidenceGroupOf(uint256 disputeId) external view returns (uint256);
}
