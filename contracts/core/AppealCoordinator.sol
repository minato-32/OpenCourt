// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {IArbitrator} from "../interfaces/IArbitrator.sol";
import {IArbitrable} from "../interfaces/IArbitrable.sol";
import {IEvidenceGroups} from "../interfaces/IEvidence.sol";

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
///
///      FR-AP-01 / FR-AP-02 — an appeal is not a button, it is a payment, and it is made PER
///      OUTCOME. Backers fund the choice they want the next panel to reach; a choice is live once
///      its bucket covers the next court's full cost. When the window shuts:
///        - two or more choices funded  -> the next (bigger) court hears the case
///        - exactly one choice funded   -> that choice WINS, with no new round. A side that will
///                                         not pay to defend a ruling does not get to keep it,
///                                         which is the whole reason appeals are not free
///        - nothing funded              -> the round's own ruling stands
///      Losing backers' money pays for the round the winners asked for; anything left over is
///      theirs to pull. Nobody is paid out of thin air — see claimAppealReward.
contract AppealCoordinator is IArbitrator, IArbitrable, IEvidenceGroups {
    IArbitrator[] public courts; // round r -> courts[r]; panel sizes must increase
    uint64 public immutable appealWindowBlocks; // 0 => no appeals (single round)
    uint8 public immutable maxRounds; // FR-AP-01: rounds are capped, however long the ladder is
    /// @dev ArbitratorCore.DisputeState.Resolved. A court only knows what a round paid back once
    ///      it has settled, so nothing may be swept before this.
    uint8 internal constant CHILD_RESOLVED = 5;

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
        uint256 evidenceGroupId; // ERC-1497 group, carried onto every appeal round
        bool groupLinked; // whether the app chose a group, or we are on the default
    }

    /// @dev One appeal's funding, keyed by the round it was raised AGAINST.
    struct AppealPot {
        uint256 total; // everything contributed, across every choice
        uint256 spent; // what actually went to the next court (0 if no round ran)
        /// @dev Whatever the round this pot paid for handed back — an undersubscribed panel
        ///      refunds the entire fee, and even a normal round returns forfeited juror fees.
        ///      That money belongs to the backers who bought the round, not to the app: the app
        ///      paid for round 0 and nothing else.
        uint256 extra;
        uint8 winningChoice; // set when the outcome is known; 0 means refund everyone pro-rata
        bool settled;
        /// @dev Whether the round's refund has been pulled in. Rewards wait for it, so the share
        ///      each backer is owed is computed once against a pot that can no longer grow.
        bool swept;
    }

    uint256 public coordCount;
    mapping(uint256 => CoordDispute) private _disputes;
    // (court, childDisputeId) -> coordId, to route a court's rule() callback.
    mapping(address => mapping(uint256 => uint256)) private _link;
    mapping(address => uint256) public withdrawable; // pull-payment (fee residue)
    /// @notice coordId => round => the child dispute id that round ran under.
    /// @dev Kept per round, not just for the current one: a court refunds fees long after the
    ///      coordinator has moved on to a higher round, and the refund has to be attributable.
    mapping(uint256 => mapping(uint32 => uint256)) public roundChild;
    /// @notice The app's original extraData — its declared parties — replayed on every round.
    /// @dev Round 0 got it and the appeals did not, which quietly undid FR-SL-07 exactly where it
    ///      matters most: a disputant could sit on the panel rehearing their own case. It also
    ///      dropped their free-filing exemption, so a party was charged the third-party evidence
    ///      bond on appeal.
    mapping(uint256 => bytes) public coordExtraData;
    /// @notice What settlement left this coordinator for one coordId, awaiting the app's pull.
    /// @dev An accumulator, not a one-shot: reclaimFees credits it once per ROUND, and a case can
    ///      run several. Zeroing on payout is the whole guard — a latched "claimed" flag would
    ///      strand every round after the first, and since claimRefund is permissionless anyone
    ///      could have latched it at round 0.
    mapping(uint256 => uint256) public coordRefund;

    mapping(uint256 => mapping(uint32 => AppealPot)) public appealPot; // coordId => round => pot
    mapping(uint256 => mapping(uint32 => mapping(uint8 => uint256))) public choiceFunding;
    mapping(uint256 => mapping(uint32 => mapping(uint8 => uint256))) public fundedChoices; // 1 = fully funded
    mapping(uint256 => mapping(uint32 => uint8)) public fundedCount;
    mapping(uint256 => mapping(uint32 => uint8)) public soleFundedChoice;
    mapping(uint256 => mapping(uint32 => mapping(uint8 => mapping(address => uint256)))) public contributionOf;
    mapping(uint256 => mapping(uint32 => mapping(uint8 => mapping(address => bool)))) public rewardClaimed;

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
    event EvidenceGroupLinked(uint256 indexed coordId, uint256 indexed evidenceGroupId);
    event AppealFunded(uint256 indexed coordId, uint32 round, uint8 choice, address backer, uint256 amount);
    event AppealChoiceCovered(uint256 indexed coordId, uint32 round, uint8 choice);
    /// @notice Only one side paid to argue the next round, so that side takes the case.
    event WonByDefault(uint256 indexed coordId, uint32 round, uint8 choice);
    /// @notice The next court would not take the case, so the appeal ends instead of wedging.
    event AppealCourtRefused(uint256 indexed coordId, uint32 round);
    event AppealPotSettled(uint256 indexed coordId, uint32 round, uint8 winningChoice, uint256 payable_);
    /// @notice The round an appeal pot bought has handed its unspent fees back to that pot.
    event AppealRefundSwept(uint256 indexed coordId, uint32 round, uint256 amount);
    event AppealRewardClaimed(uint256 indexed coordId, uint32 round, uint8 choice, address backer, uint256 amount);
    event RefundClaimed(uint256 indexed coordId, address indexed app, uint256 amount);
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
    error OnlyApp();
    error BadChoice();
    error BadCourtLadder();
    error BadRoundCap();
    error NothingFunded();
    error TransferFailed();

    /// @param maxRounds_ hard cap on rounds, 1..courts.length. A ladder can be longer than the
    ///        number of rounds an app is willing to pay through, and an uncapped chain of appeals
    ///        is a way to outspend the other side rather than out-argue them.
    constructor(IArbitrator[] memory _courts, uint64 _appealWindowBlocks, uint8 maxRounds_) {
        if (_courts.length == 0) revert NoCourts();
        for (uint256 i = 0; i < _courts.length; i++) {
            // FR-AP-01: each round must be heard by a panel of at least 2n+1. A ladder that does
            // not grow is not an appeal, it is a re-roll of the same dice at the same price.
            if (i > 0 && _courts[i].panelSize() < 2 * _courts[i - 1].panelSize() + 1) {
                revert BadCourtLadder();
            }
            courts.push(_courts[i]);
        }
        if (maxRounds_ == 0 || maxRounds_ > _courts.length) revert BadRoundCap();
        appealWindowBlocks = _appealWindowBlocks;
        maxRounds = maxRounds_;
    }

    function courtCount() external view returns (uint256) {
        return courts.length;
    }

    // ------------------------------------------------------------ IArbitrator
    // -------------------------------------------------------- IEvidenceGroups
    /// @inheritdoc IEvidenceGroups
    /// @dev Forwarded to the round currently sitting. The coordinator is the child court's app, so
    ///      it is the only address that court will accept the link from.
    function linkEvidenceGroup(uint256 coordId, uint256 appGroupId) external {
        CoordDispute storage cd = _disputes[coordId];
        if (msg.sender != cd.app) revert OnlyApp();
        cd.evidenceGroupId = appGroupId;
        cd.groupLinked = true;
        IEvidenceGroups(address(courts[cd.round])).linkEvidenceGroup(cd.childId, appGroupId);
        emit EvidenceGroupLinked(coordId, appGroupId);
    }

    /// @inheritdoc IEvidenceGroups
    function evidenceGroupOf(uint256 coordId) external view returns (uint256) {
        return _disputes[coordId].evidenceGroupId;
    }

    /// @inheritdoc IArbitrator
    function arbitrationCost(bytes calldata extraData) public view returns (uint256) {
        return courts[0].arbitrationCost(extraData);
    }

    /// @notice Cost to appeal `coordId` to the next court (0 if none higher).
    function appealCost(uint256 coordId) public view returns (uint256) {
        CoordDispute storage cd = _disputes[coordId];
        uint256 next = uint256(cd.round) + 1;
        if (next >= maxRounds) return 0; // capped, or the ladder ran out
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
        coordExtraData[++coordCount] = extraData;

        coordId = coordCount; // bumped above, alongside the stored party list
        CoordDispute storage cd = _disputes[coordId];
        cd.app = msg.sender;
        cd.choices = choices;
        cd.round = 0;
        cd.childId = childId;
        cd.state = CoordState.Pending;
        cd.evidenceGroupId = IEvidenceGroups(address(c0)).evidenceGroupOf(childId); // whatever the first court defaulted to
        _link[address(c0)][childId] = coordId;
        roundChild[coordId][0] = childId;

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
    /// @param isFinal ignored: a court has a single round, so its own verdict is always final to
    ///        itself. Finality for the app behind this coordinator is decided here, by whether an
    ///        appeal window is still open.
    function rule(uint256 childId, uint256 ruling, bool isFinal) external noReentrant {
        uint256 coordId = _link[msg.sender][childId];
        if (coordId == 0) revert UnknownDispute();
        CoordDispute storage cd = _disputes[coordId];
        if (msg.sender != address(courts[cd.round])) revert NotCurrentCourt();
        if (cd.state != CoordState.Pending) revert WrongState();

        cd.ruling = uint8(ruling);
        cd.state = CoordState.Appealable;
        cd.appealDeadline = uint64(block.number) + appealWindowBlocks;
        emit Ruling(IArbitrator(msg.sender), childId, ruling, isFinal);
        emit RoundRuled(coordId, cd.round, cd.ruling, cd.appealDeadline);

        // A ruling for round r>0 decides the appeal that was funded against round r-1.
        if (cd.round > 0) _settlePot(coordId, cd.round - 1, cd.ruling);

        // No appeals possible (window disabled or round cap reached) -> this is already final.
        if (appealWindowBlocks == 0 || uint256(cd.round) + 1 >= maxRounds) {
            _finalize(coordId, cd);
        } else {
            // Appealable: hand the app the provisional result so it can show it, flagged not final
            // so it cannot act on a ruling a later round may reverse.
            _deliver(coordId, cd, false);
        }
    }

    /// @notice Back a specific outcome for the next round, inside the appeal window (FR-AP-02).
    /// @dev Funding is per CHOICE, not per dispute. Whoever wants the next panel to reach `choice`
    ///      pays toward that choice's bucket; the bucket is live once it covers the next court's
    ///      full arbitration cost. Anything sent beyond that is handed straight back, so a backer
    ///      can always send a round number without overpaying.
    function fundAppeal(uint256 coordId, uint8 choice) external payable noReentrant {
        CoordDispute storage cd = _disputes[coordId];
        if (cd.state != CoordState.Appealable) revert WrongState();
        if (block.number > cd.appealDeadline) revert AppealClosed();
        if (choice == 0 || choice > cd.choices) revert BadChoice();
        uint256 next = uint256(cd.round) + 1;
        if (next >= maxRounds) revert NoHigherCourt();

        uint32 r = cd.round;
        uint256 cost = courts[next].arbitrationCost("");
        uint256 already = choiceFunding[coordId][r][choice];
        if (already >= cost) revert WrongFee(0); // this choice is covered; nothing more is needed

        uint256 need = cost - already;
        uint256 taken = msg.value > need ? need : msg.value;
        if (taken == 0) revert WrongFee(need);

        choiceFunding[coordId][r][choice] = already + taken;
        contributionOf[coordId][r][choice][msg.sender] += taken;
        appealPot[coordId][r].total += taken;
        emit AppealFunded(coordId, r, choice, msg.sender, taken);

        if (already + taken == cost) {
            fundedChoices[coordId][r][choice] = 1;
            fundedCount[coordId][r] += 1;
            soleFundedChoice[coordId][r] = choice; // only read when the count is exactly 1
            emit AppealChoiceCovered(coordId, r, choice);
        }

        // Refund the overshoot in the same call rather than parking it.
        if (msg.value > taken) _pay(msg.sender, msg.value - taken);
    }

    /// @notice Close the appeal window and act on what was funded. Permissionless crank.
    function finalizeAppeal(uint256 coordId) external noReentrant {
        CoordDispute storage cd = _disputes[coordId];
        if (cd.state != CoordState.Appealable) revert WrongState();
        if (block.number <= cd.appealDeadline) revert TooEarly();

        uint32 r = cd.round;
        uint8 funded = fundedCount[coordId][r];

        if (funded >= 2 && _advance(coordId, cd)) return;
        if (funded >= 2) {
            // Nobody will hear it. The round's own ruling stands and every backer gets their
            // money back — none of it was spent.
            _settlePot(coordId, r, 0);
            _finalize(coordId, cd);
            return;
        }

        if (funded == 1) {
            // One side paid to argue; the other did not turn up. The case goes to the side that
            // did, without a new panel — there is no second position left to weigh.
            uint8 winner = soleFundedChoice[coordId][r];
            cd.ruling = winner;
            cd.tied = false;
            emit WonByDefault(coordId, r, winner);
            _settlePot(coordId, r, winner);
            _finalize(coordId, cd);
            return;
        }

        // Nobody paid: the round's own ruling stands, and any partial funding goes back.
        _settlePot(coordId, r, 0);
        _finalize(coordId, cd);
    }

    /// @dev Open the next round against the bigger court, paid for out of the pot.
    ///      Returns false — having changed nothing — when that court will not take the case.
    ///
    ///      The higher court can refuse: it may have drained below its readiness floor, or be
    ///      otherwise unwilling. Letting that revert would leave the coordId wedged in Appealable
    ///      with no other exit, and since the pot is only settled on the way out, every backer's
    ///      money would be locked with it. An appeal nobody will hear ends the case instead.
    function _advance(uint256 coordId, CoordDispute storage cd) private returns (bool) {
        uint32 r = cd.round;
        uint256 next = uint256(r) + 1;
        IArbitrator nc = courts[next];
        uint256 cost = nc.arbitrationCost("");

        // The WHOLE advance is inside the try, the group link included. A court that does not
        // implement IEvidenceGroups would otherwise revert after its child dispute already
        // existed, and finalizeAppeal would revert forever — the exact wedge this catch exists
        // to prevent, reintroduced one line lower.
        try this.openRound(nc, cd.choices, coordExtraData[coordId], cd.evidenceGroupId, cost)
            returns (uint256 childId)
        {
            appealPot[coordId][r].spent = cost;
            cd.round = uint32(next);
            cd.childId = childId;
            cd.state = CoordState.Pending;
            _link[address(nc)][childId] = coordId;
            roundChild[coordId][uint32(next)] = childId;
            emit Appealed(coordId, cd.round, childId);
            return true;
        } catch {
            emit AppealCourtRefused(coordId, uint32(next));
            return false;
        }
    }

    /// @dev The body of an advance, external ONLY so the caller can try/catch it as one unit.
    ///      Self-call restricted: nothing outside this contract may open a round.
    function openRound(
        IArbitrator nc,
        uint8 choices,
        bytes memory extraData,
        uint256 groupId,
        uint256 cost
    ) external returns (uint256 childId) {
        if (msg.sender != address(this)) revert OnlyApp();
        childId = nc.createDispute{value: cost}(choices, extraData);
        // Every round files into the SAME group. An appeal re-argues one case; splitting the
        // record per round would hide round 1's evidence from round 2's panel.
        IEvidenceGroups(address(nc)).linkEvidenceGroup(childId, groupId);
    }

    /// @dev Fix what each backer of round `r`'s appeal is owed, once the outcome is known.
    ///      `outcome` 0 — or a choice nobody backed — means nothing was decided between the
    ///      funded positions, so every contribution comes back pro rata instead.
    function _settlePot(uint256 coordId, uint32 r, uint8 outcome) private {
        AppealPot storage p = appealPot[coordId][r];
        if (p.settled || p.total == 0) {
            p.settled = true;
            return;
        }
        // Only a FULLY funded position can win the pot. Merely non-zero funding let anyone drop
        // a single wei on a third choice and, if the panel happened to land there, collect the
        // entire residual — money put up by the two positions that actually paid for the round,
        // since the payout divides by that choice's own funding.
        if (outcome != 0 && fundedChoices[coordId][r][outcome] != 1) outcome = 0;
        p.winningChoice = outcome;
        p.settled = true;
        // Nothing was bought, so there is no round refund to wait for.
        if (p.spent == 0) p.swept = true;
        emit AppealPotSettled(coordId, r, outcome, p.total + p.extra - p.spent);
    }

    /// @notice Pull what backing `choice` in round `r`'s appeal turned out to be worth.
    /// @dev Pull, per backer: paying everyone inside finalize would loop a list anyone can
    ///      lengthen, which is a way to freeze the chain of rounds.
    ///
    ///      The money that funded the losing positions is what paid for the round the winners
    ///      asked for; whatever is left over is split among the winning backers in proportion to
    ///      what they put in. Two sides funded and one round run means the winners come out whole
    ///      and the losers lose their stake — which is exactly the price of a frivolous appeal.
    function claimAppealReward(uint256 coordId, uint32 r, uint8 choice) external noReentrant returns (uint256 amount) {
        AppealPot storage p = appealPot[coordId][r];
        // Both gates matter: settled fixes WHICH position won, swept fixes HOW MUCH there is.
        // Paying before the round's refund lands would shortchange whoever claimed first and
        // overpay whoever waited. reclaimFees is permissionless, so nobody can hold this up.
        if (!p.settled || !p.swept) revert WrongState();
        uint256 contributed = contributionOf[coordId][r][choice][msg.sender];
        if (contributed == 0 || rewardClaimed[coordId][r][choice][msg.sender]) revert NothingToWithdraw();

        uint256 payable_ = p.total + p.extra - p.spent;
        if (p.spent == 0) {
            // No round was ever bought, so there is nothing to have won. This covers the
            // won-by-default case, where folding the losing side's money into the winner's share
            // paid the sole funder every partial backer's stake for a panel that never sat — a
            // party could profit purely by out-waiting a half-funded opponent. Everyone out, whole.
            amount = contributed;
        } else if (p.winningChoice == 0) {
            // No position prevailed: everyone shares what is left, in proportion to what they put in.
            amount = (contributed * payable_) / p.total;
        } else if (choice == p.winningChoice) {
            amount = (contributed * payable_) / choiceFunding[coordId][r][p.winningChoice];
        } else {
            amount = 0;
        }

        rewardClaimed[coordId][r][choice][msg.sender] = true;
        if (amount == 0) revert NothingToWithdraw();
        _pay(msg.sender, amount);
        emit AppealRewardClaimed(coordId, r, choice, msg.sender, amount);
    }

    /// @notice Re-attempt final delivery if the app's callback previously failed.
    function redeliverRuling(uint256 coordId) external noReentrant {
        CoordDispute storage cd = _disputes[coordId];
        if (cd.state != CoordState.Resolved || cd.ruled) revert WrongState();
        _deliver(coordId, cd, true);
    }

    /// @inheritdoc IArbitrator
    /// @dev Present for interface conformance and effectively unused: this coordinator routes
    ///      every refund per coordId through reclaimFees + claimRefund, because a lump an app
    ///      cannot attribute to a case is a lump it cannot credit to anyone. Nothing writes
    ///      `withdrawable`, so this reverts. Apps should call claimRefund(coordId).
    function withdraw() external noReentrant {
        uint256 amount = withdrawable[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        withdrawable[msg.sender] = 0;
        _pay(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Pull the fee refund one ROUND's court left for this coordId, and tag it to it.
    /// @dev The defect this replaces: the old version called the court's withdraw(), which hands
    ///      over everything credited to this coordinator across EVERY coordId that court has
    ///      heard, then credited the whole lump to whichever coordId the caller happened to name.
    ///      The first caller took other disputes' refunds. Courts now pay per dispute, so the
    ///      amount that arrives is exactly this round's and nothing else moves.
    function reclaimFees(uint256 coordId, uint32 round) external noReentrant {
        CoordDispute storage cd = _disputes[coordId];
        if (cd.app == address(0)) revert UnknownDispute();
        uint256 childId = roundChild[coordId][round];
        if (childId == 0) revert UnknownDispute();

        // The round must have SETTLED first. Sweeping earlier looks harmless — the call simply
        // returns nothing — but it latches `swept`, which is what fixes how much each backer is
        // owed. A crank bot sweeping every round on sight would freeze the pot at zero extra, the
        // backers would split only what was left after the round was bought, and the refund that
        // arrived later would sit in this contract with every reward already claimed.
        if (courts[round].disputeState(childId) != CHILD_RESOLVED) revert TooEarly();

        uint256 before = address(this).balance;
        // Tolerated now that the round is final: a settled round that left nothing back is a
        // normal outcome, and this call must still mark the pot swept or every backer's reward
        // would be stuck behind it.
        try courts[round].claimRefund(childId) {} catch {}
        uint256 received = address(this).balance - before;

        if (round == 0) {
            // Round 0 was bought by the app, so its residue goes back to the app.
            if (received > 0) coordRefund[coordId] += received;
            return;
        }

        // Every later round was bought by an appeal pot, and its residue belongs to the backers
        // who bought it — not to the app, which never funded that round.
        AppealPot storage p = appealPot[coordId][round - 1];
        p.extra += received;
        p.swept = true;
        emit AppealRefundSwept(coordId, round - 1, received);
    }

    /// @inheritdoc IArbitrator
    /// @dev Same tagging one level up: the app behind this coordinator must be able to tell which
    ///      of its cases a refund belongs to, so it pulls per coordId rather than as a lump.
    function claimRefund(uint256 coordId) external noReentrant returns (uint256 amount) {
        CoordDispute storage cd = _disputes[coordId];
        if (cd.app == address(0)) revert UnknownDispute();
        // App-only, for the same reason the courts' own claimRefund is: a pull-payment app has no
        // way to credit value that arrives unannounced, so an open call is a way to strand it.
        if (msg.sender != cd.app) revert OnlyApp();
        amount = coordRefund[coordId];
        if (amount == 0) revert NothingToWithdraw();
        coordRefund[coordId] = 0;
        _pay(cd.app, amount);
        emit RefundClaimed(coordId, cd.app, amount);
    }

    /// @inheritdoc IArbitrator
    /// @dev The first round's panel — what an app is quoted before any appeal exists.
    function panelSize() external view returns (uint32) {
        return courts[0].panelSize();
    }

    function getDispute(uint256 coordId) external view returns (CoordDispute memory) {
        return _disputes[coordId];
    }

    // ------------------------------------------------------------ internals
    function _finalize(uint256 coordId, CoordDispute storage cd) private {
        cd.state = CoordState.Resolved;
        emit FinalRuling(coordId, cd.ruling);
        _deliver(coordId, cd, true);
    }

    /// @dev Revert-proof: a hostile/codeless app can never freeze the chain.
    /// @dev A provisional delivery must never mark the dispute delivered, and a failed one must
    ///      never brick the chain of rounds — hence the low-level call and the isFinal guard.
    function _deliver(uint256 coordId, CoordDispute storage cd, bool isFinal) private {
        (bool ok, ) = cd.app.call(abi.encodeCall(IArbitrable.rule, (coordId, uint256(cd.ruling), isFinal)));
        if (ok) {
            if (isFinal) cd.ruled = true;
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
