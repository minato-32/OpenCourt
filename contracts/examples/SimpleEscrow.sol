// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {IArbitrator} from "../interfaces/IArbitrator.sol";
import {IArbitrable} from "../interfaces/IArbitrable.sol";
import {IEvidence, IEvidenceGroups} from "../interfaces/IEvidence.sol";

/// @title SimpleEscrow — the Phase-1 example app that drives a full dispute.
/// @notice A payer funds an escrow to a payee. If they disagree, either party
///         raises a jury dispute (choice 1 = release to payee, 2 = refund payer)
///         by prepaying the arbitration cost. The jury's ruling settles it.
///         Demonstrates the IArbitrable seam end-to-end; the protocol never
///         learns what the escrow is for.
///
/// @dev PULL-PAYMENT (audit HIGH). Every payout — a settled winner, a released
///      payee, and the arbitration-fee refund the core credits back to this app —
///      is credited to `pendingWithdrawals` and pulled by the recipient via
///      withdraw(). This guarantees `rule()` can NEVER revert on a hostile or
///      contract recipient: a reverting payee must not be able to freeze the
///      dispute (and, via the core, freeze every juror's stake). The core itself
///      is pull-based for the SAME reason, so the escrow must actively pull its fee
///      refund out of the core (claimFees) rather than receive it by push.
///      ERC-1497: each escrow is its own meta-evidence id AND its own evidence group, so the
///      agreement the parties signed and every argument filed about it share one key — including
///      anything filed before the dispute was raised.
contract SimpleEscrow is IArbitrable, IEvidence {
    IArbitrator public immutable arbitrator;

    enum State { None, Funded, Disputed, Resolved }

    struct Escrow {
        address payer;
        address payee;
        uint256 amount;
        State state;
    }

    uint256 public escrowCount;
    mapping(uint256 => Escrow) public escrows;
    mapping(uint256 => uint256) public disputeToEscrow; // arbitrator disputeId => escrowId
    mapping(uint256 => address) public feePayer; // escrowId => who prepaid the arbitration cost

    /// @notice Pull-payment balances: winners, released payees, and reclaimed fees.
    mapping(address => uint256) public pendingWithdrawals;

    /// @notice Last non-final ruling seen for an escrow, for display only. Zero means none.
    mapping(uint256 => uint8) public provisionalRuling;

    uint8 internal constant RELEASE = 1; // pay the payee
    uint8 internal constant REFUND = 2; // refund the payer

    uint256 private _lock = 1;
    modifier noReentrant() {
        require(_lock == 1, "reentrant");
        _lock = 2;
        _;
        _lock = 1;
    }

    event EscrowFunded(uint256 indexed escrowId, address indexed payer, address indexed payee, uint256 amount);
    event EscrowReleased(uint256 indexed escrowId);
    event EscrowDisputed(uint256 indexed escrowId, uint256 indexed disputeId);
    event EscrowResolved(uint256 indexed escrowId, uint256 ruling);
    event ProvisionalRuling(uint256 indexed escrowId, uint256 ruling);
    event Credited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event FeesClaimed(uint256 indexed escrowId, address indexed payer, uint256 amount);

    error NotParty();
    error WrongState();
    error WrongFee(uint256 required);
    error OnlyArbitrator();
    error TransferFailed();
    error NothingToWithdraw();
    error NoFeePayer();

    constructor(address arbitratorAddress) {
        arbitrator = IArbitrator(arbitratorAddress);
    }

    /// @notice Fund a new escrow to `payee` with msg.value.
    /// @param agreement pointer to the agreement document (ERC-1497 meta-evidence). May be empty:
    ///        the escrow still works, a juror just has less to read.
    function fund(address payee, string calldata agreement) external payable returns (uint256 escrowId) {
        require(msg.value > 0 && payee != address(0), "bad escrow");
        escrowId = ++escrowCount;
        escrows[escrowId] = Escrow({payer: msg.sender, payee: payee, amount: msg.value, state: State.Funded});
        emit EscrowFunded(escrowId, msg.sender, payee, msg.value);
        // Emitted at FUNDING, not at dispute time: the terms a panel judges must predate the
        // disagreement about them.
        emit MetaEvidence(escrowId, agreement);
    }

    /// @notice Happy path: the payer releases the funds to the payee (pull-credited).
    function release(uint256 escrowId) external noReentrant {
        Escrow storage e = escrows[escrowId];
        if (e.state != State.Funded) revert WrongState();
        if (msg.sender != e.payer) revert NotParty();
        e.state = State.Resolved;
        _credit(e.payee, e.amount);
        emit EscrowReleased(escrowId);
    }

    /// @notice Raise a jury dispute. Caller prepays the arbitration cost.
    function dispute(uint256 escrowId) external payable noReentrant returns (uint256 disputeId) {
        Escrow storage e = escrows[escrowId];
        if (e.state != State.Funded) revert WrongState();
        if (msg.sender != e.payer && msg.sender != e.payee) revert NotParty();
        uint256 cost = arbitrator.arbitrationCost("");
        if (msg.value != cost) revert WrongFee(cost);

        // Declare both parties so neither can sit on the panel judging their own escrow.
        address[] memory parties = new address[](2);
        parties[0] = e.payer;
        parties[1] = e.payee;
        disputeId = arbitrator.createDispute{value: msg.value}(2, abi.encode(parties));
        disputeToEscrow[disputeId] = escrowId;
        // Log the join before anything else can read it: dispute id -> the agreement, and -> the
        // group every filing about this escrow lands in.
        IEvidenceGroups(address(arbitrator)).linkEvidenceGroup(disputeId, escrowId);
        emit Dispute(arbitrator, disputeId, escrowId, escrowId);
        feePayer[escrowId] = msg.sender; // reclaim any fee refund back to whoever paid
        e.state = State.Disputed;
        emit EscrowDisputed(escrowId, disputeId);
    }

    /// @inheritdoc IArbitrable
    /// @dev Pull-payment: credits the winner instead of pushing, so this call can never revert on
    ///      the recipient and freeze the dispute. `noReentrant` still guards the state machine even
    ///      though no external value transfer happens.
    ///
    ///      A ruling that is NOT final is recorded and shown, never acted on: moving the escrow on a
    ///      provisional result would pay out money a later appeal round could reverse.
    function rule(uint256 disputeId, uint256 ruling, bool isFinal) external noReentrant {
        if (msg.sender != address(arbitrator)) revert OnlyArbitrator();
        uint256 escrowId = disputeToEscrow[disputeId];
        Escrow storage e = escrows[escrowId];
        if (e.state != State.Disputed) revert WrongState();

        emit Ruling(arbitrator, disputeId, ruling, isFinal);

        if (!isFinal) {
            provisionalRuling[escrowId] = uint8(ruling);
            emit ProvisionalRuling(escrowId, ruling);
            return;
        }

        e.state = State.Resolved;
        // ruling 1 = release to payee; 2 or 0 (refuse/tie) = refund the payer.
        address winner = ruling == RELEASE ? e.payee : e.payer;
        _credit(winner, e.amount);

        emit EscrowResolved(escrowId, ruling);
    }

    /// @notice Pull a credited balance (escrowed principal won or released).
    function withdraw() external noReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pendingWithdrawals[msg.sender] = 0;
        _pay(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Reclaim the arbitration-fee refund the core credited to THIS app's
    ///         pull-balance and forward it to the original fee-payer.
    /// @dev The core refunds unspent arbitration fees (app take + forfeited juror
    ///      fees) to `withdrawable[address(this)]`. Because the core is pull-based
    ///      the escrow must actively pull them out; otherwise they are stranded here
    ///      forever. Pulls the core balance, measures the delta received, and credits
    ///      it to the escrow's fee-payer to withdraw().
    function claimFees(uint256 escrowId) external noReentrant {
        address payer = feePayer[escrowId];
        if (payer == address(0)) revert NoFeePayer();
        uint256 before = address(this).balance;
        arbitrator.withdraw(); // reverts if nothing is credited to this app
        uint256 received = address(this).balance - before;
        if (received > 0) {
            pendingWithdrawals[payer] += received;
            emit Credited(payer, received);
        }
        emit FeesClaimed(escrowId, payer, received);
    }

    function _credit(address to, uint256 amount) private {
        pendingWithdrawals[to] += amount;
        emit Credited(to, amount);
    }

    function _pay(address to, uint256 amount) private {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Accept ONLY the core's pull-payment (claimFees -> arbitrator.withdraw
    ///         -> the core pushes value here). Any other sender is rejected so stray
    ///         ETH cannot be mistaken for reclaimed fees.
    receive() external payable {
        if (msg.sender != address(arbitrator)) revert OnlyArbitrator();
    }
}
