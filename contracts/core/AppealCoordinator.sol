// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {IArbitrator} from "../interfaces/IArbitrator.sol";
import {IArbitrable} from "../interfaces/IArbitrable.sol";

/// @title AppealCoordinator — multi-round appeals as a composition layer.
/// @notice Sits between an app and an ORDERED list of courts (ArbitratorCore
///         instances with increasing panel size). It is both:
///           - IArbitrator to the app (the app talks only to this contract), and
///           - IArbitrable to each court (each court delivers its ruling here).
///         Round r runs in `courts[r]`. When a round resolves, an appeal window
///         opens; anyone may `appeal()` by funding the next (bigger) court, or the
///         result finalizes to the app after the window. This keeps ArbitratorCore
///         itself single-round and unchanged — appeals live entirely here.
///
/// @dev Design mirrors the spec's "settle per round independently, no retroactive
///      slash": each court round settles its own jurors internally; this layer only
///      chains rulings. The FINAL ruling (last un-appealed round) is delivered to
///      the app exactly once, via a revert-proof low-level call so a hostile app
///      can never freeze the chain.
contract AppealCoordinator is IArbitrator, IArbitrable {
    IArbitrator[] public courts; // round r -> courts[r]; panel sizes must increase
    uint64 public immutable appealWindowBlocks; // 0 => no appeals (single round)

    enum CoordState { None, Pending, Appealable, Resolved }

    struct CoordDispute {
        address app; // the real IArbitrable that opened the dispute
        uint8 choices;
        uint8 ruling;
        bool tied;
        bool ruled; // final ruling delivered to the app
        uint32 round; // current court index
        uint64 appealDeadline;
        CoordState state;
        uint256 childId; // dispute id inside courts[round]
    }

    uint256 public coordCount;
    mapping(uint256 => CoordDispute) private _disputes;
    // (court, childDisputeId) -> coordId, to route a court's rule() callback.
    mapping(address => mapping(uint256 => uint256)) private _link;
    mapping(address => uint256) public withdrawable; // pull-payment (fee residue)

    uint256 private _lock = 1;
    modifier noReentrant() {
        require(_lock == 1, "reentrant");
        _lock = 2;
        _;
        _lock = 1;
    }

    event CoordDisputeCreated(uint256 indexed coordId, address indexed app, uint256 childId);
    event RoundRuled(uint256 indexed coordId, uint32 round, uint8 ruling, uint64 appealDeadline);
    event Appealed(uint256 indexed coordId, uint32 newRound, uint256 childId);
    event FinalRuling(uint256 indexed coordId, uint8 ruling);
    event RulingDeliveryFailed(uint256 indexed coordId);
    event Withdrawn(address indexed account, uint256 amount);

    error NoCourts();
    error AppNotContract();
    error WrongFee(uint256 required);
    error WrongState();
    error UnknownDispute();
    error NotCurrentCourt();
    error AppealClosed();
    error NoHigherCourt();
    error TooEarly();
    error NothingToWithdraw();
    error TransferFailed();

    constructor(IArbitrator[] memory _courts, uint64 _appealWindowBlocks) {
        if (_courts.length == 0) revert NoCourts();
        for (uint256 i = 0; i < _courts.length; i++) courts.push(_courts[i]);
        appealWindowBlocks = _appealWindowBlocks;
    }

    function courtCount() external view returns (uint256) {
        return courts.length;
    }

    // ------------------------------------------------------------ IArbitrator
    /// @inheritdoc IArbitrator
    function arbitrationCost(bytes calldata extraData) public view returns (uint256) {
        return courts[0].arbitrationCost(extraData);
    }

    /// @notice Cost to appeal `coordId` to the next court (0 if none higher).
    function appealCost(uint256 coordId) public view returns (uint256) {
        CoordDispute storage cd = _disputes[coordId];
        uint256 next = uint256(cd.round) + 1;
        if (next >= courts.length) return 0;
        return courts[next].arbitrationCost("");
    }

    /// @inheritdoc IArbitrator
    function createDispute(uint8 choices, bytes calldata extraData)
        external
        payable
        noReentrant
        returns (uint256 coordId)
    {
        if (msg.sender.code.length == 0) revert AppNotContract(); // mirror court guard
        IArbitrator c0 = courts[0];
        uint256 cost = c0.arbitrationCost(extraData);
        if (msg.value != cost) revert WrongFee(cost);

        uint256 childId = c0.createDispute{value: msg.value}(choices, extraData);

        coordId = ++coordCount;
        CoordDispute storage cd = _disputes[coordId];
        cd.app = msg.sender;
        cd.choices = choices;
        cd.round = 0;
        cd.childId = childId;
        cd.state = CoordState.Pending;
        _link[address(c0)][childId] = coordId;

        emit CoordDisputeCreated(coordId, msg.sender, childId);
    }

    /// @inheritdoc IArbitrator
    function currentRuling(uint256 coordId) external view returns (uint256 ruling, bool tied, bool finalized) {
        CoordDispute storage cd = _disputes[coordId];
        return (cd.ruling, cd.tied, cd.state == CoordState.Resolved);
    }

    /// @inheritdoc IArbitrator
    function disputeState(uint256 coordId) external view returns (uint8) {
        return uint8(_disputes[coordId].state);
    }

    // ------------------------------------------------------------ IArbitrable
    /// @notice A court delivers its round ruling here. Opens the appeal window (or
    ///         finalizes immediately when no higher court / no window).
    function rule(uint256 childId, uint256 ruling) external noReentrant {
        uint256 coordId = _link[msg.sender][childId];
        if (coordId == 0) revert UnknownDispute();
        CoordDispute storage cd = _disputes[coordId];
        if (msg.sender != address(courts[cd.round])) revert NotCurrentCourt();
        if (cd.state != CoordState.Pending) revert WrongState();

        cd.ruling = uint8(ruling);
        cd.state = CoordState.Appealable;
        cd.appealDeadline = uint64(block.number) + appealWindowBlocks;
        emit Ruling(IArbitrator(msg.sender), childId, ruling);
        emit RoundRuled(coordId, cd.round, cd.ruling, cd.appealDeadline);

        // No appeals possible (window disabled or highest court) -> deliver now.
        if (appealWindowBlocks == 0 || uint256(cd.round) + 1 >= courts.length) {
            _finalize(coordId, cd);
        }
    }

    /// @notice Appeal a round to the next (bigger) court within the appeal window.
    function appeal(uint256 coordId) external payable noReentrant {
        CoordDispute storage cd = _disputes[coordId];
        if (cd.state != CoordState.Appealable) revert WrongState();
        if (block.number > cd.appealDeadline) revert AppealClosed();
        uint256 next = uint256(cd.round) + 1;
        if (next >= courts.length) revert NoHigherCourt();

        IArbitrator nc = courts[next];
        uint256 cost = nc.arbitrationCost("");
        if (msg.value != cost) revert WrongFee(cost);

        uint256 childId = nc.createDispute{value: msg.value}(cd.choices, "");
        cd.round = uint32(next);
        cd.childId = childId;
        cd.state = CoordState.Pending;
        _link[address(nc)][childId] = coordId;
        emit Appealed(coordId, cd.round, childId);
    }

    /// @notice Finalize an un-appealed round after its window; delivers to the app.
    function finalizeAppeal(uint256 coordId) external noReentrant {
        CoordDispute storage cd = _disputes[coordId];
        if (cd.state != CoordState.Appealable) revert WrongState();
        if (block.number <= cd.appealDeadline) revert TooEarly();
        _finalize(coordId, cd);
    }

    /// @notice Re-attempt final delivery if the app's callback previously failed.
    function redeliverRuling(uint256 coordId) external noReentrant {
        CoordDispute storage cd = _disputes[coordId];
        if (cd.state != CoordState.Resolved || cd.ruled) revert WrongState();
        _deliver(coordId, cd);
    }

    /// @notice Pull any fee residue this contract accumulated (see reclaimFees).
    function withdraw() external noReentrant {
        uint256 amount = withdrawable[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        withdrawable[msg.sender] = 0;
        _pay(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Pull this coordinator's fee-refund balance out of a round's court and
    ///         credit it to that dispute's app (courts refund the "app" — here, us).
    function reclaimFees(uint256 coordId, uint256 courtIndex) external noReentrant {
        CoordDispute storage cd = _disputes[coordId];
        if (cd.app == address(0)) revert UnknownDispute();
        uint256 before = address(this).balance;
        courts[courtIndex].withdraw(); // reverts if nothing credited
        uint256 received = address(this).balance - before;
        if (received > 0) withdrawable[cd.app] += received;
    }

    function getDispute(uint256 coordId) external view returns (CoordDispute memory) {
        return _disputes[coordId];
    }

    // ------------------------------------------------------------ internals
    function _finalize(uint256 coordId, CoordDispute storage cd) private {
        cd.state = CoordState.Resolved;
        emit FinalRuling(coordId, cd.ruling);
        _deliver(coordId, cd);
    }

    /// @dev Revert-proof: a hostile/codeless app can never freeze the chain.
    function _deliver(uint256 coordId, CoordDispute storage cd) private {
        (bool ok, ) = cd.app.call(abi.encodeCall(IArbitrable.rule, (coordId, cd.ruling)));
        if (ok) {
            cd.ruled = true;
        } else {
            emit RulingDeliveryFailed(coordId);
        }
    }

    function _pay(address to, uint256 amount) private {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @dev Accept court fee-refund pushes (from reclaimFees -> court.withdraw()).
    receive() external payable {}
}
