// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {IArbitrator} from "../interfaces/IArbitrator.sol";
import {IArbitrable} from "../interfaces/IArbitrable.sol";
import {IEligibility} from "../interfaces/IEligibility.sol";
import {IEvidenceGroups} from "../interfaces/IEvidence.sol";

/// @title ArbitratorCore — Phase-2 of the OpenCourt (one court).
/// @notice A single hardcoded court that resolves disputes via a commit-reveal
///         jury drawn by hash-based sortition. The protocol never knows what a
///         dispute is about. Built for pallet-revive on Paseo Asset Hub.
///
/// Phase-2 mechanics on top of the Phase-1 MVP:
///  - EVIDENCE: submitEvidence(id, cid, contentHash, sizeBytes) records a bounded pointer on
///    chain and logs it, during the Evidence phase only, so every juror judges one frozen set.
///    Bounded by MAX_URI_BYTES and MAX_EVIDENCE_PER_SUBMITTER so it can never bloat state, and
///    priced for non-parties by a refundable bond. Also logged in the ERC-1497 `Evidence` shape,
///    so a standard indexer reads it with no adapter. Group ids are the app's to choose (default:
///    the dispute id); two apps on one court may pick the same number, so an indexer joining on
///    the group alone must also filter by app. Per-dispute reads are unambiguous either way.
///  - K-SLOT WEIGHTING: a juror who stakes N*minStake owns weight = N slots. Each
///    slot self-selects independently (keccak(seed, juror, slot) < drawThreshold),
///    each locks minStake, each is independently slashed. One commit / one reveal
///    per juror covers ALL of that juror's seats in a round.
///  - ALTERNATES: the draw admits up to drawTarget = ceil(1.4 * panelSize) seats,
///    ranked by keccak output (lower = higher priority). On the commit -> reveal
///    transition the seated set is chosen: committed primaries stay, primaries who
///    did NOT commit are marked SILENT (still slashed) and their capacity is filled
///    by the lowest-ranked committed alternates so quorum survives absentees.
///  - GROSS-UP FEES: arbitrationCost grosses up an app fee + protocol fee so that
///    rewarded jurors are always paid their full jurorFee first; the protocol fee
///    is routed to the treasury.
///  - NO-VERDICT SETTLEMENT (FR-ST-02 / FR-ST-03): a tie, a quorum failure or an
///    empty reveal (ruling == 0) never punishes a juror who did the work. Every
///    seat whose juror REVEALED is made whole and paid, whatever they voted; only
///    silence is slashed.
///
/// Deliberate MVP tradeoffs kept from Phase 1 (documented, extractable later):
///  - Sortition = keccak(seed, juror, slot) < drawThreshold. The seed mixes a
///    FUTURE blockhash so a juror cannot grind before the draw opens. This is a
///    deterministic (not secret) selector. We KEEP hash sortition on purpose: the
///    juror daemon uses sr25519 accounts with no secp256k1 key, so an ecrecover /
///    signature "VRF" would break. A secret ring-VRF selector is a pallet-era feature.
///  - Payouts are PULL (withdraw), so no push-loop can revert/gas-bomb the core.
///  - Settlement NEVER mints: everything paid out is escrowed stake + prepaid fees.
///  - Appeals and a multi-court registry live outside this contract (CourtRegistry).
contract ArbitratorCore is IArbitrator, IEvidenceGroups {
    // ------------------------------------------------------------------ config
    struct CourtConfig {
        uint256 minStake; // stake locked per seat (one slot)
        uint256 jurorFee; // fee paid to each rewarded seat (from the app's prepay)
        uint256 drawThreshold; // keccak(seed,juror,slot) must be below this to self-select
        uint256 evidenceBond; // what a non-party pays to file; refundable, 0 = an open record
        uint64 evidenceBlocks; // FR-DL-02: how long the record stays open, before any draw
        uint64 activationDelayBlocks; // anti just-in-time staking
        uint64 drawDelayBlocks; // Δ before the draw opens (future-blockhash seed)
        uint64 drawWindowBlocks; // window to collect seat claims
        uint64 commitBlocks; // commit phase length
        uint64 revealBlocks; // reveal phase length
        uint32 panelSize; // target seats (odd, <= MAX_PANEL)
        uint16 betaBps; // incoherence slash of stake
        uint16 gammaBps; // non-reveal slash of stake (gamma >= beta)
        uint16 thetaBps; // treasury cut of the slashed pot
        uint16 quorumBps; // min revealed weight / panelSize for a valid verdict
        bool commitRequired; // FR-VT-03: false = open voting, cheap but bandwagon-prone
        uint32 minPoolWeightMultiple; // FR-PG-06: pool must cover this many full panels; 0 = off
        uint8 quorumFailure; // FR-ST-03: Refuse | Default | Redraw (see QF_*)
        uint8 tieBreak; // FR-ST-03: Refuse | Default (see TB_*)
        uint8 defaultChoice; // the ruling a Default policy hands the app; must be 1..choices
        /// @dev FR-PG-07: the pool is gated by the app rather than open to any staker. Immutable,
        ///      like every field here — a court that launches open and later closes its pool has
        ///      rug-pulled its own arbitration. Declared by the app; the eligibility policy's
        ///      descriptor is what lets anyone check the declaration against reality.
        bool closedPool;
        uint16 appFeeBps; // fee take credited back to the app at settlement
        uint16 protocolFeeBps; // fee take routed to the treasury at settlement
        uint16 pinFeeBps; // FR-EV-06: fee take routed to whoever pins this court's evidence
        address treasury;
        address pinner; // paid pinFeeBps of every arbitration fee; may be 0 when pinFeeBps is 0 // receives the treasury cut + protocol fee (pull)
    }

    enum DisputeState {
        None, // 0
        Evidence, // 1 — parties argue; the record is still open
        Drawing, // 2 — record frozen, panel forming
        Committing, // 3
        Revealing, // 4
        Resolved // 5 (tallied, settled; ruling may still be pending delivery)
    }

    // Seat role, fixed at the commit->reveal transition (openReveal).
    uint8 internal constant ROLE_RELEASED = 0; // admitted alternate that was not needed
    uint8 internal constant ROLE_SEATED = 1; // committed, on duty to reveal
    uint8 internal constant ROLE_SILENT = 2; // primary that never committed (still slashed)

    // Protocol invariants — NOT configurable.
    uint16 internal constant BPS = 10_000;
    uint16 internal constant MAX_SLASH_BPS = 5_000; // no court may slash > 50%
    uint16 internal constant MAX_TAKE_BPS = 2_000; // app + protocol fee take cap (jurors paid first)
    uint16 internal constant ALT_FACTOR_BPS = 14_000; // over-draw = ceil(1.4 * panelSize)
    uint16 internal constant MAX_QSTAR_RATIO = 6_000; // FR-CR-02: q* <= 0.60 (spec §7 band 0.5-0.6)
    uint32 internal constant MAX_PANEL = 15;
    uint8 internal constant MAX_CHOICES = 8; // K <= 8
    uint8 internal constant MAX_REDRAWS = 2; // FR-ST-03 caps re-draws; a protocol invariant
    /// @dev FR-PG-02. In an open court the activation delay is anti just-in-time hygiene; in a
    ///      closed one it is the primary defence, because a juror the app adds today still cannot
    ///      touch any dispute the app can currently foresee. ~14 days at 6s blocks.
    uint64 internal constant MIN_CLOSED_ACTIVATION_BLOCKS = 201_600;

    // What a court does when the panel produces no verdict of its own.
    // A court picks whether to redraw at all; the CAP on redraws is not the court's to set.
    uint8 internal constant QF_REFUSE = 0; // ruling 0 — the app decides what that means
    uint8 internal constant QF_DEFAULT = 1; // hand the app defaultChoice
    uint8 internal constant QF_REDRAW = 2; // try a fresh panel, up to MAX_REDRAWS, then refuse
    uint8 internal constant TB_REFUSE = 0;
    uint8 internal constant TB_DEFAULT = 1;
    uint16 internal constant MAX_URI_BYTES = 128; // bounds one evidence pointer
    uint32 internal constant MAX_EVIDENCE_PER_SUBMITTER = 8; // bounds one submitter per dispute
    uint256 internal constant MAX_EXCLUDED_PARTIES = 16; // bounds the parties an app may declare
    uint256 internal constant ELIGIBILITY_GAS_CAP = 100_000; // FR-EL-02: a policy cannot burn the call

    // ------------------------------------------------------------------ state
    CourtConfig public config;
    IEligibility public immutable eligibility;
    /// @notice Identifier this court passes to its eligibility policy; 0 when deployed standalone.
    uint96 public immutable courtId;
    bytes32 public immutable configHash;
    uint256 public immutable arbCost; // grossed-up arbitration cost, cached at deploy

    /// @dev One entry per admitted SEAT (a juror may hold several under k-slot weighting).
    struct SeatEntry {
        address juror;
        uint16 slot; // the juror's stake-slot index this seat came from
        uint8 role; // ROLE_* — assigned at openReveal
        bool settled;
        uint256 vrfOutput; // keccak(seed, juror, slot); lower = higher draw priority
        uint256 slotStake; // minStake locked for this seat
    }

    /// @dev Per-juror, per-dispute aggregate. Commit/reveal is once per juror and
    ///      covers ALL of that juror's seats in the dispute.
    struct JurorRound {
        uint32 seatCount; // seats this juror holds
        uint32 dutySeats; // of those, how many are ROLE_SEATED (set at openReveal)
        bool committed;
        bool revealed;
        /// @dev The juror discharged their duty by reporting the evidence unretrievable instead
        ///      of voting. Exclusive with `revealed`: a round is one or the other, never both.
        bool reportedUnavailable;
        uint8 choice;
        bytes32 commitment;
    }

    /// @dev One evidence pointer. The chain stores who, what hash, when and how big; the bytes
    ///      themselves live off chain under `uri`.
    struct EvidenceRecord {
        address submitter;
        bytes32 contentHash; // sha256 of the referenced bytes, so a juror can detect substitution
        uint64 submittedAt;
        uint32 sizeBytes;
        uint128 bond; // posted by a third-party filer, reclaimable once the dispute resolves
        bool bondReclaimed;
        string uri;
    }

    struct Dispute {
        address app;
        uint8 choices;
        uint8 ruling;
        bool tied;
        bool ruled; // ruling delivered to the app
        bool voided; // resolved to 0 because the panel could not reach the evidence
        /// @dev The delivered ruling is the court's configured fallback, not one the votes
        ///      produced. Settlement still ran at ruling 0, so nobody was slashed against it —
        ///      a reader that cannot tell the two apart reports paid jurors as slashed ones.
        bool fallbackRuling;
        uint8 redraws; // panels burned to a quorum failure so far, capped at MAX_REDRAWS
        DisputeState state;
        uint64 evidenceDeadline;
        uint64 drawBlock;
        uint64 commitDeadline;
        uint64 revealDeadline;
        uint32 seatCount; // total admitted seats
        uint32 seatedWeight; // ROLE_SEATED seats (set at openReveal)
        uint32 revealedCount; // revealed seat weight
        uint32 unavailableWeight; // seat weight that reported the evidence unretrievable
        uint256 feePot; // prepaid by the app at createDispute (== arbCost)
        uint256 evidenceGroupId; // ERC-1497 group; defaults to disputeId, app may point it elsewhere
        bytes32 configHash; // snapshot; settle against this, never live config
    }

    uint256 public disputeCount;
    mapping(uint256 => Dispute) private _disputes;
    mapping(uint256 => SeatEntry[]) private _seatsOf; // disputeId => seats
    mapping(uint256 => mapping(address => JurorRound)) private _jurorRound;
    mapping(uint256 => mapping(address => mapping(uint16 => bool))) private _slotClaimed;
    mapping(uint256 => mapping(uint8 => uint32)) private _votes; // disputeId => choice => weight
    mapping(uint256 => EvidenceRecord[]) private _evidenceOf; // disputeId => evidence
    mapping(uint256 => mapping(address => uint32)) private _evidenceCount; // disputeId => submitter => count
    mapping(uint256 => mapping(address => bool)) private _excluded; // disputeId => barred from the panel

    /// @notice Every juror's unlocked stake, and its running total.
    /// @dev `poolStake` mirrors the sum of `staked` exactly — updated at each of the four places
    ///      that move it — so readiness is an O(1) read rather than a walk over the pool.
    mapping(address => uint256) public staked; // free stake
    uint256 public poolStake;
    mapping(address => uint64) public activeAt; // block from which stake is eligible
    mapping(address => uint256) public withdrawable; // pull-payment balance

    /// @notice Third-party evidence bonds still escrowed. Held apart from every fee pot and every
    ///         stake, so settlement can never spend one and the never-mint sum stays checkable.
    uint256 public bondsHeld;

    /// @notice What settlement left the app for a single dispute, and whether it has been taken.
    /// @dev Tagged per dispute on purpose. `withdraw()` hands a caller EVERYTHING credited to it,
    ///      which an app holding several disputes cannot attribute — it sees one lump and has to
    ///      guess which case it came from. Every app built on this (the escrow, the appeal
    ///      coordinator) was mis-crediting that lump to whichever dispute id the caller named.
    ///      claimRefund(disputeId) pays exactly this dispute's share, so there is nothing to guess.
    mapping(uint256 => uint256) public refundOf;
    mapping(uint256 => bool) public refundClaimed;

    // reentrancy guard (custom, matching p2p-market convention — not OZ)
    uint256 private _lock = 1;
    modifier noReentrant() {
        require(_lock == 1, "reentrant");
        _lock = 2;
        _;
        _lock = 1;
    }

    // ------------------------------------------------------------------ events
    event Staked(address indexed juror, uint256 amount, uint64 activeAt);
    event Unstaked(address indexed juror, uint256 amount);
    /// @param phaseDeadline the block the dispute's FIRST phase ends — the evidence deadline.
    ///        It is not the draw block: since FR-DL-02 that is unset at creation and only assigned
    ///        by openDrawing, so an indexer scheduling claimSeat off this field would aim at the
    ///        wrong height entirely.
    event DisputeCreated(uint256 indexed disputeId, address indexed app, uint8 choices, uint64 phaseDeadline);
    event PartyExcluded(uint256 indexed disputeId, address indexed party);
    event SeatGranted(uint256 indexed disputeId, address indexed juror, uint32 seatCount);
    event SeatClaimed(uint256 indexed disputeId, address indexed juror, uint16 slot, uint256 vrfOutput);
    /// @notice A seat was pushed out of the panel by a claim with a lower vrf output.
    event SeatDisplaced(uint256 indexed disputeId, address indexed juror, uint16 slot, uint256 vrfOutput);
    event DrawingClosed(uint256 indexed disputeId, uint32 seatCount);
    event PhaseAdvanced(uint256 indexed disputeId, DisputeState state);
    event PanelSeated(uint256 indexed disputeId, uint32 seatedWeight);
    event VoteCommitted(uint256 indexed disputeId, address indexed juror);
    event VoteRevealed(uint256 indexed disputeId, address indexed juror, uint8 choice, uint32 seats);
    event DisputeResolved(uint256 indexed disputeId, uint8 ruling, bool tied);
    event RulingDelivered(uint256 indexed disputeId, uint8 ruling);
    event RulingDeliveryFailed(uint256 indexed disputeId);
    event Slashed(uint256 indexed disputeId, address indexed juror, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event RefundClaimed(uint256 indexed disputeId, address indexed app, uint256 amount);
    /// @notice Evidence pointer for a dispute. Event-only: the core stores NOTHING;
    ///         the log IS the evidence record (an app/indexer reconstructs it).
    event EvidenceSubmitted(uint256 indexed disputeId, address indexed submitter, string cid);
    /// @notice The record is frozen; from here the panel judges exactly these pointers.
    event EvidenceClosed(uint256 indexed disputeId, uint32 evidenceCount);
    /// @notice ERC-1497. Declared here rather than inherited from IEvidence: that interface also
    ///         carries a `Dispute` event, which would collide with this contract's `Dispute`
    ///         struct. The signature is identical, so the log topic is the standard's.
    event Evidence(
        IArbitrator indexed _arbitrator,
        uint256 indexed _evidenceGroupID,
        address indexed _party,
        string _evidence
    );
    /// @notice The app pointed this dispute at an evidence group opened before the dispute existed.
    event EvidenceGroupLinked(uint256 indexed disputeId, uint256 indexed evidenceGroupId);
    event EvidenceBondPosted(uint256 indexed disputeId, address indexed submitter, uint256 amount);
    event EvidenceBondReclaimed(uint256 indexed disputeId, address indexed submitter, uint256 amount);
    /// @notice A seated juror could not retrieve the record they were asked to judge.
    event EvidenceUnavailable(uint256 indexed disputeId, address indexed juror, uint32 seats);
    /// @notice Most of the participating panel could not reach the record: no verdict, no slash.
    event DisputeVoided(uint256 indexed disputeId, uint32 unavailableWeight, uint32 participation);
    /// @notice Too few jurors showed up; the silent were slashed and a fresh panel is being drawn.
    event Redrawn(uint256 indexed disputeId, uint8 attempt, uint64 drawBlock, uint256 feePot);
    /// @notice No verdict carried on the votes, so the court's configured fallback was delivered.
    event FallbackRuling(uint256 indexed disputeId, uint8 ruling, bool fromTie);

    // ------------------------------------------------------------------ errors
    error BadConfig(string what);
    error WrongState();
    error NotSeated();
    error AlreadySeated();
    error AlreadyCommitted();
    error NotEligible();
    error PanelFull();
    error DrawClosed();
    error TooEarly();
    error BadChoice();
    error BadReveal();
    error InsufficientStake();
    error StakeLocked();
    error WrongFee(uint256 required);
    error TransferFailed();
    error NothingToWithdraw();
    error AppNotContract();
    error BadEvidence();
    error EvidenceCapReached();
    error TooManyParties();
    error BondRequired(uint256 required);
    error BondNotReclaimable();
    error OnlyApp();
    error CourtNotReady(uint256 have, uint256 need);
    error AlreadyReported();

    constructor(CourtConfig memory cfg, address eligibilityPolicy, uint96 id) {
        if (eligibilityPolicy == address(0)) revert BadConfig("eligibility");
        if (cfg.panelSize == 0 || cfg.panelSize > MAX_PANEL || cfg.panelSize % 2 == 0) revert BadConfig("panelSize");
        if (cfg.minStake == 0) revert BadConfig("minStake");
        if (cfg.jurorFee == 0) revert BadConfig("jurorFee");
        if (cfg.drawThreshold == 0) revert BadConfig("drawThreshold");
        // EvidenceRecord.bond is uint128; a larger bond would be stored truncated while bondsHeld
        // counted the full value, so refunds would underpay and the never-mint sum would drift.
        if (cfg.evidenceBond > type(uint128).max) revert BadConfig("evidenceBond");
        // drawDelay >= 1 (a real gap before the seed's blockhash) and window <= 255
        // so every claimable block has a live blockhash. (Audit HIGH fix.)
        // A zero evidence window would freeze the record in the block the dispute opens, before
        // either party could file anything.
        if (cfg.evidenceBlocks == 0) revert BadConfig("evidenceBlocks");
        if (cfg.drawDelayBlocks == 0) revert BadConfig("drawDelay");
        if (cfg.drawWindowBlocks == 0 || cfg.drawWindowBlocks > 255) revert BadConfig("drawWindow");
        // A zero commit or reveal window would close the phase in the same block it
        // opens, freezing every seated stake (nobody can commit / a zero reveal
        // window slashes every honest juror). activationDelayBlocks may be 0 (no
        // anti-JIT delay) but must fit its uint64 field like every other block count.
        if (cfg.commitBlocks == 0) revert BadConfig("commitBlocks");
        if (cfg.revealBlocks == 0) revert BadConfig("revealBlocks");
        if (cfg.betaBps > MAX_SLASH_BPS) revert BadConfig("betaBps");
        if (cfg.gammaBps == 0 || cfg.gammaBps > MAX_SLASH_BPS) revert BadConfig("gammaBps");
        // Non-reveal must cost at least as much as being wrong (gamma >= beta),
        // else silence dominates. And when a court wants more security it must
        // raise the FEE, not the penalty — see spec §5.
        if (cfg.gammaBps < cfg.betaBps) revert BadConfig("gamma<beta");
        if (cfg.thetaBps >= BPS) revert BadConfig("thetaBps");
        if (cfg.quorumBps == 0 || cfg.quorumBps > BPS) revert BadConfig("quorumBps");
        // FR-PG-02: a closed pool buys its safety with time, not with trust.
        if (cfg.closedPool && cfg.activationDelayBlocks < MIN_CLOSED_ACTIVATION_BLOCKS) {
            revert BadConfig("closedActivationDelay");
        }
        if (cfg.quorumFailure > QF_REDRAW) revert BadConfig("quorumFailure");
        if (cfg.tieBreak > TB_DEFAULT) revert BadConfig("tieBreak");
        // A Default policy with no choice to fall back on would silently behave as Refuse.
        if ((cfg.quorumFailure == QF_DEFAULT || cfg.tieBreak == TB_DEFAULT) && cfg.defaultChoice == 0) {
            revert BadConfig("defaultChoice");
        }
        if (cfg.defaultChoice > MAX_CHOICES) revert BadConfig("defaultChoice");
        // App + protocol take is bounded, and jurors are paid FIRST out of the
        // grossed-up cost (see arbitrationCost) — never underpaid by the take.
        if (uint256(cfg.appFeeBps) + cfg.protocolFeeBps + cfg.pinFeeBps > MAX_TAKE_BPS) revert BadConfig("take");
        if (cfg.treasury == address(0)) revert BadConfig("treasury");
        // A pinning take with nowhere to send it would silently accrue to nobody.
        if (cfg.pinFeeBps > 0 && cfg.pinner == address(0)) revert BadConfig("pinner");
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
        // MUST stay byte-identical to CourtRegistry.validateConfig (validation parity).
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

        config = cfg;
        eligibility = IEligibility(eligibilityPolicy);
        courtId = id;
        configHash = keccak256(abi.encode(cfg));

        // Gross-up: cost * (BPS - take) >= panelSize * jurorFee, so after the take is
        // removed the remaining pot still covers every rewarded seat's full fee
        // (rewarded seats are SEATED seats, so never more than panelSize of them).
        // cost = ceil( panelSize * jurorFee * BPS / (BPS - appFeeBps - protocolFeeBps - pinFeeBps) ).
        uint256 denom = uint256(BPS) - cfg.appFeeBps - cfg.protocolFeeBps - cfg.pinFeeBps; // > 0 by the take cap
        uint256 num = uint256(cfg.panelSize) * cfg.jurorFee * BPS;
        arbCost = (num + denom - 1) / denom;
    }

    // ------------------------------------------------------------ juror stake
    /// @dev Re-arms the WHOLE balance's activation delay on EVERY stake, not only on
    ///      the 0->nonzero transition. Otherwise an already-active juror could watch
    ///      the public draw seed land and top up in-window to field extra seats with
    ///      zero delay — panel capture. Re-arming forces even a top-up to wait out the
    ///      full activationDelayBlocks before ANY of the juror's stake is eligible.
    function stake() external payable noReentrant {
        if (msg.value == 0) revert InsufficientStake();
        activeAt[msg.sender] = uint64(block.number) + config.activationDelayBlocks;
        staked[msg.sender] += msg.value;
        poolStake += msg.value;
        emit Staked(msg.sender, msg.value, activeAt[msg.sender]);
    }

    function unstake(uint256 amount) external noReentrant {
        if (amount > staked[msg.sender]) revert InsufficientStake();
        staked[msg.sender] -= amount;
        poolStake -= amount;
        if (staked[msg.sender] == 0) activeAt[msg.sender] = 0; // re-delay on next stake
        _pay(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    /// @notice Free stake this court needs before it will accept a dispute (FR-PG-06).
    /// @dev Zero when the court sets no floor.
    function readinessThreshold() public view returns (uint256) {
        return uint256(config.minPoolWeightMultiple) * config.panelSize * config.minStake;
    }

    /// @notice Whether the pool can plausibly fill a panel, and by how much it is short.
    /// @dev Measured on free stake, not on stake that has cleared its activation delay — that
    ///      would need a walk over every juror. So this is an upper bound on what can be drawn:
    ///      it catches an empty court, which is the failure it exists for, and does not pretend
    ///      to promise that every staked slot is already eligible.
    function courtReadiness() public view returns (bool ready, uint256 have, uint256 need) {
        need = readinessThreshold();
        have = poolStake;
        ready = have >= need;
    }

    /// @notice Slots a juror has staked for, before the eligibility policy has its say.
    function stakeSlotsOf(address juror) public view returns (uint256) {
        return staked[juror] / config.minStake;
    }

    /// @notice Slots a juror may actually field: what they staked for, capped by the policy.
    /// @dev The cap direction matters. Stake custody stays entirely in this contract, so a policy
    ///      can only ever reduce a juror's weight, never conjure slots the stake does not back.
    function weightOf(address juror) public view returns (uint256) {
        uint256 slots = stakeSlotsOf(juror);
        if (slots == 0) return 0;
        uint256 allowed = _policyWeight(juror);
        return allowed < slots ? allowed : slots;
    }

    /// @dev FR-EL-02: gas-capped staticcall, fail closed. A policy that reverts, runs out of gas or
    ///      returns something other than one word yields zero — locked out, never let in, and never
    ///      able to brick the court for everybody else.
    function _policyWeight(address juror) private view returns (uint256) {
        (bool ok, bytes memory ret) = address(eligibility).staticcall{gas: ELIGIBILITY_GAS_CAP}(
            abi.encodeCall(IEligibility.weightOf, (juror, courtId))
        );
        if (!ok || ret.length != 32) return 0;
        return abi.decode(ret, (uint256));
    }

    /// @notice What the court's policy says it enforces; empty when the policy does not say.
    function policyDescriptor() external view returns (string memory) {
        (bool ok, bytes memory ret) = address(eligibility).staticcall{gas: ELIGIBILITY_GAS_CAP}(
            abi.encodeCall(IEligibility.policyDescriptor, ())
        );
        if (!ok || ret.length == 0) return "";
        return abi.decode(ret, (string));
    }

    // -------------------------------------------------------------- evidence
    /// @notice Attach an evidence pointer (an IPFS CID) to a live dispute.
    /// @dev Callable by ANYONE, but only while the record is open: from the moment the dispute is
    ///      raised until its evidence deadline passes (FR-DL-02). The protocol never interprets
    ///      the pointer.
    ///
    ///      The record is kept ON CHAIN, unlike the event-only first cut. The spec puts the URI in
    ///      the event log and only metadata in storage, which is the right shape once an indexer
    ///      exists; with no indexer a juror client cannot read past logs at all, so the pointer
    ///      would be unreachable exactly when it is needed. Bloat is bounded instead:
    ///      MAX_URI_BYTES per pointer and MAX_EVIDENCE_PER_SUBMITTER per address per dispute.
    ///      The event is still emitted for indexers that do exist.
    function submitEvidence(
        uint256 disputeId,
        string calldata cid,
        bytes32 contentHash,
        uint32 sizeBytes
    ) external payable {
        // FR-DL-02: the record closes before the panel forms, so every juror judges the same set
        // of evidence. Nothing can be added once a seat has been claimed.
        Dispute storage d = _disputes[disputeId];
        if (d.state != DisputeState.Evidence) revert WrongState();
        // The deadline is hard, not merely the point openDrawing becomes callable. Gating on
        // state alone left a gap between the advertised close and whenever a crank actually
        // landed, in which a party who stopped filing on time could still be answered.
        if (block.number > d.evidenceDeadline) revert DrawClosed();
        if (bytes(cid).length == 0 || bytes(cid).length > MAX_URI_BYTES) revert BadEvidence();
        if (_evidenceCount[disputeId][msg.sender] >= MAX_EVIDENCE_PER_SUBMITTER) revert EvidenceCapReached();

        // The declared parties and the app file for free: the record is the case they came to
        // make. Anyone else posts a bond. The bond is NEVER forfeited — no on-chain rule can judge
        // whether a stranger's filing was useful, and one that tried would hand the parties a
        // censorship lever. It prices bulk third-party filing in locked capital instead, and the
        // per-submitter cap still bounds how many any one address can open at once.
        uint256 required = (_excluded[disputeId][msg.sender] || msg.sender == d.app)
            ? 0
            : config.evidenceBond;
        if (msg.value != required) revert BondRequired(required);

        _evidenceCount[disputeId][msg.sender] += 1;
        _evidenceOf[disputeId].push(
            EvidenceRecord({
                submitter: msg.sender,
                contentHash: contentHash,
                submittedAt: uint64(block.number),
                sizeBytes: sizeBytes,
                bond: uint128(required),
                bondReclaimed: false,
                uri: cid
            })
        );

        if (required > 0) {
            bondsHeld += required;
            emit EvidenceBondPosted(disputeId, msg.sender, required);
        }

        emit EvidenceSubmitted(disputeId, msg.sender, cid);
        emit Evidence(IArbitrator(address(this)), d.evidenceGroupId, msg.sender, cid);
    }

    /// @notice Pull back an evidence bond once the dispute it was filed on has resolved.
    /// @dev Pull, not push: refunding every bond inside finalize() would loop over a list any
    ///      stranger can lengthen, which is a way to freeze settlement and with it every juror's
    ///      stake. Each filer reclaims their own record, one call, no loop.
    function reclaimEvidenceBond(uint256 disputeId, uint256 index) external noReentrant {
        if (_disputes[disputeId].state != DisputeState.Resolved) revert WrongState();
        EvidenceRecord storage e = _evidenceOf[disputeId][index];
        if (e.submitter != msg.sender || e.bond == 0 || e.bondReclaimed) revert BondNotReclaimable();

        e.bondReclaimed = true;
        uint256 amount = e.bond;
        bondsHeld -= amount;
        withdrawable[msg.sender] += amount;
        emit EvidenceBondReclaimed(disputeId, msg.sender, amount);
    }

    /// @notice Every evidence pointer attached to a dispute, oldest first.
    function getEvidence(uint256 disputeId) external view returns (EvidenceRecord[] memory) {
        return _evidenceOf[disputeId];
    }

    /// @notice How many pointers `submitter` has attached to `disputeId`.
    function evidenceCountOf(uint256 disputeId, address submitter) external view returns (uint32) {
        return _evidenceCount[disputeId][submitter];
    }

    // -------------------------------------------------------------- disputes
    /// @notice Over-draw target: ceil(1.4 * panelSize) seats (primaries + alternates).
    function drawTarget() public view returns (uint32) {
        return uint32((uint256(config.panelSize) * ALT_FACTOR_BPS + BPS - 1) / BPS);
    }

    /// @inheritdoc IArbitrator
    /// @dev Grossed-up so that after the app + protocol take is removed, rewarded
    ///      jurors are still paid the full panelSize * jurorFee. Cached at deploy.
    function arbitrationCost(bytes calldata) public view returns (uint256) {
        return arbCost;
    }

    /// @inheritdoc IArbitrator
    /// @param extraData optional `abi.encode(address[])` — the parties to this dispute. They are
    ///        barred from their own panel (FR-SL-07). The protocol still learns nothing about what
    ///        the dispute is: it only ever compares these addresses to a seat claimant. An app that
    ///        declares nobody keeps the old behaviour, and undeclared affiliates remain the
    ///        documented residual risk.
    function createDispute(uint8 choices, bytes calldata extraData)
        external
        payable
        noReentrant
        returns (uint256 disputeId)
    {
        if (choices == 0 || choices > MAX_CHOICES) revert BadChoice();
        // Reject a codeless (EOA) app. solc 0.8.28's `try IArbitrable(app).rule(...)`
        // emits a pre-CALL extcodesize check that reverts OUTSIDE the catch for a
        // codeless address — so at delivery finalize() would revert and freeze every
        // juror stake forever. Require the app to be a contract at creation time.
        // (_deliver additionally uses a low-level call so an app self-destructed AFTER
        // creation still cannot brick settlement.)
        if (msg.sender.code.length == 0) revert AppNotContract();
        // FR-PG-06: refuse loudly now rather than let the dispute stall in Drawing with nobody to
        // draw. A party who is told the court is empty can go elsewhere; one whose case is frozen
        // for a week cannot.
        (bool ready, uint256 have, uint256 need) = courtReadiness();
        if (!ready) revert CourtNotReady(have, need);
        uint256 cost = arbCost;
        if (msg.value != cost) revert WrongFee(cost);

        disputeId = ++disputeCount;
        Dispute storage d = _disputes[disputeId];
        d.app = msg.sender;
        d.choices = choices;
        d.state = DisputeState.Evidence;
        d.evidenceDeadline = uint64(block.number) + config.evidenceBlocks;
        d.feePot = msg.value;
        d.configHash = configHash;
        // ERC-1497 default: the dispute is its own evidence group. An app that opened a group
        // earlier repoints it with linkEvidenceGroup while the record is still open.
        d.evidenceGroupId = disputeId;

        if (extraData.length > 0) {
            address[] memory parties = abi.decode(extraData, (address[]));
            if (parties.length > MAX_EXCLUDED_PARTIES) revert TooManyParties();
            for (uint256 i = 0; i < parties.length; i++) {
                if (parties[i] == address(0)) continue;
                _excluded[disputeId][parties[i]] = true;
                emit PartyExcluded(disputeId, parties[i]);
            }
        }

        emit DisputeCreated(disputeId, msg.sender, choices, d.evidenceDeadline);
    }

    /// @inheritdoc IEvidenceGroups
    /// @dev Re-linking within the window is allowed: the app may not know the final group id at
    ///      the instant it calls createDispute.
    function linkEvidenceGroup(uint256 disputeId, uint256 appGroupId) external {
        Dispute storage d = _disputes[disputeId];
        if (msg.sender != d.app) revert OnlyApp();
        if (d.state != DisputeState.Evidence) revert WrongState();
        d.evidenceGroupId = appGroupId;
        emit EvidenceGroupLinked(disputeId, appGroupId);
    }

    /// @inheritdoc IEvidenceGroups
    function evidenceGroupOf(uint256 disputeId) external view returns (uint256) {
        return _disputes[disputeId].evidenceGroupId;
    }

    /// @inheritdoc IArbitrator
    /// @dev Paid straight to the app, and only at the app's own request: it is the one contract
    ///      that knows which of its cases the money belongs to. Pushing here cannot brick
    ///      anything — a reverting app fails only this call, never settlement, which already
    ///      finished. An app that swept the lump with withdraw() first has nothing left to tag,
    ///      and is told so rather than underflowing.
    function claimRefund(uint256 disputeId) external noReentrant returns (uint256 amount) {
        Dispute storage d = _disputes[disputeId];
        // App-only. The money can go nowhere else, so restricting the caller costs nothing — and
        // leaving it open let anyone push value into the app outside the app's own accounting,
        // where a pull-payment app has no hook to credit it to anybody. It would simply sit there.
        if (msg.sender != d.app) revert OnlyApp();
        if (d.state != DisputeState.Resolved) revert WrongState();
        amount = refundOf[disputeId];
        if (amount == 0 || refundClaimed[disputeId] || withdrawable[d.app] < amount) {
            revert NothingToWithdraw();
        }
        refundClaimed[disputeId] = true;
        withdrawable[d.app] -= amount;
        _pay(d.app, amount);
        emit RefundClaimed(disputeId, d.app, amount);
    }

    /// @inheritdoc IArbitrator
    function panelSize() external view returns (uint32) {
        return config.panelSize;
    }

    /// @inheritdoc IArbitrator
    function poolIsClosed() external view returns (bool) {
        return config.closedPool;
    }

    /// @inheritdoc IArbitrator
    function rulingIsFallback(uint256 disputeId) external view returns (bool) {
        return _disputes[disputeId].fallbackRuling;
    }

    /// @notice Whether this dispute ended because the panel could not reach the evidence.
    function isVoided(uint256 disputeId) external view returns (bool) {
        return _disputes[disputeId].voided;
    }

    /// @notice Whether `who` is barred from this dispute's panel.
    function isExcluded(uint256 disputeId, address who) external view returns (bool) {
        return _excluded[disputeId][who] || who == _disputes[disputeId].app;
    }

    /// @notice Freeze the evidence record and open the draw. Permissionless crank.
    /// @dev The draw block is set HERE, not at creation: the sortition seed must anchor to a block
    ///      nobody could predict while the record was still being written.
    function openDrawing(uint256 disputeId) external {
        Dispute storage d = _disputes[disputeId];
        if (d.state != DisputeState.Evidence) revert WrongState();
        if (block.number <= d.evidenceDeadline) revert TooEarly();

        d.state = DisputeState.Drawing;
        d.drawBlock = uint64(block.number) + config.drawDelayBlocks;
        emit EvidenceClosed(disputeId, uint32(_evidenceOf[disputeId].length));
        emit PhaseAdvanced(disputeId, DisputeState.Drawing);
    }

    /// @notice Claim jury seats once the draw is open. A juror claims EVERY one of
    ///         their weight slots that self-selects this round. Self-selection of
    ///         slot k is keccak(seed, juror, k) < drawThreshold, where the seed
    ///         anchors to the drawBlock's hash (unknown until the draw opens → not
    ///         grindable). Admission is bounded at drawTarget seats; ranking of
    ///         primaries vs alternates happens at openReveal (lowest keccak first).
    function claimSeat(uint256 disputeId) external noReentrant {
        Dispute storage d = _disputes[disputeId];
        if (d.state != DisputeState.Drawing) revert WrongState();
        // Strict >: at block == drawBlock, blockhash(drawBlock) is 0 and the seed
        // would be precomputable at dispute creation -> panel capture. Require a
        // real past block. (Audit CRITICAL fix.)
        if (block.number <= d.drawBlock) revert TooEarly();
        if (block.number > d.drawBlock + config.drawWindowBlocks) revert DrawClosed();
        // FR-SL-07: the app and every party it declared at creation are barred from their own panel.
        if (msg.sender == d.app || _excluded[disputeId][msg.sender]) revert NotEligible();

        uint64 aAt = activeAt[msg.sender];
        if (aAt == 0 || block.number < aAt) revert NotEligible();
        // weightOf folds the policy in: zero means either no stake or not eligible. Separate the
        // two so a juror is told which one applies.
        if (stakeSlotsOf(msg.sender) == 0) revert InsufficientStake();
        uint256 weight = weightOf(msg.sender);
        if (weight == 0) revert NotEligible();

        // Reject an unavailable (zero) blockhash: the seed must anchor to a real
        // block in [drawBlock+1, drawBlock+256]. With drawWindow <= 255 and the
        // strict-> guard above this always holds, but fail closed. (Audit fix.)
        bytes32 bh = blockhash(d.drawBlock);
        if (bh == bytes32(0)) revert DrawClosed();
        bytes32 seed = keccak256(abi.encodePacked(bh, disputeId, address(this)));

        uint32 target = drawTarget();
        uint32 admitted = 0;
        for (uint256 k = 0; k < weight; k++) {
            uint16 slot = uint16(k);
            if (_slotClaimed[disputeId][msg.sender][slot]) continue; // already claimed this round
            uint256 vrf = uint256(keccak256(abi.encodePacked(seed, msg.sender, slot)));
            if (vrf >= config.drawThreshold) continue; // slot did not self-select

            if (d.seatCount < target) {
                _admit(disputeId, d, msg.sender, slot, vrf);
                admitted += 1;
                continue;
            }

            // FR-SL-04: the set is the LOWEST vrf outputs, not the first arrivals. Once the
            // over-draw is full a better claim displaces the worst one; a worse claim is simply
            // refused. Keeping the set capped is what stops an unbounded claim flood.
            (uint256 worstIdx, uint256 worstVrf) = _worstSeat(disputeId);
            if (vrf >= worstVrf) continue;
            _evict(disputeId, d, worstIdx);
            _admit(disputeId, d, msg.sender, slot, vrf);
            admitted += 1;
        }

        if (admitted == 0) revert NotEligible(); // no slot self-selected, or none good enough
    }

    /// @dev Lock one slot of stake and record the seat.
    function _admit(uint256 disputeId, Dispute storage d, address juror, uint16 slot, uint256 vrf) private {
        staked[juror] -= config.minStake;
        poolStake -= config.minStake;
        _slotClaimed[disputeId][juror][slot] = true;
        _seatsOf[disputeId].push(
            SeatEntry({
                juror: juror,
                slot: slot,
                role: ROLE_RELEASED,
                settled: false,
                vrfOutput: vrf,
                slotStake: config.minStake
            })
        );
        _jurorRound[disputeId][juror].seatCount += 1;
        d.seatCount += 1;
        emit SeatClaimed(disputeId, juror, slot, vrf);
        emit SeatGranted(disputeId, juror, d.seatCount);
    }

    /// @dev Index and value of the currently admitted seat with the highest (worst) vrf output.
    function _worstSeat(uint256 disputeId) private view returns (uint256 idx, uint256 vrf) {
        SeatEntry[] storage seats = _seatsOf[disputeId];
        for (uint256 i = 0; i < seats.length; i++) {
            if (seats[i].vrfOutput > vrf) {
                vrf = seats[i].vrfOutput;
                idx = i;
            }
        }
    }

    /// @dev Remove a seat and return its locked stake, by swapping the last entry into its place.
    ///      Displacement happens only during Drawing, before any role or vote exists, so nothing
    ///      else references a seat by index yet.
    function _evict(uint256 disputeId, Dispute storage d, uint256 idx) private {
        SeatEntry[] storage seats = _seatsOf[disputeId];
        SeatEntry memory gone = seats[idx];

        staked[gone.juror] += gone.slotStake;
        poolStake += gone.slotStake;
        _slotClaimed[disputeId][gone.juror][gone.slot] = false;
        _jurorRound[disputeId][gone.juror].seatCount -= 1;
        d.seatCount -= 1;

        seats[idx] = seats[seats.length - 1];
        seats.pop();

        emit SeatDisplaced(disputeId, gone.juror, gone.slot, gone.vrfOutput);
    }

    /// @notice Permissionless crank: close the draw window and open commit as long
    ///         as at least a full primary panel (panelSize seats) was admitted.
    ///         An UNDER-subscribed draw (< panelSize) is handled by finalize().
    function closeDrawing(uint256 disputeId) external {
        Dispute storage d = _disputes[disputeId];
        if (d.state != DisputeState.Drawing) revert WrongState();
        if (block.number <= d.drawBlock + config.drawWindowBlocks) revert TooEarly();
        if (d.seatCount < config.panelSize) revert PanelFull(); // undersubscribed -> finalize()
        d.state = DisputeState.Committing;
        d.commitDeadline = uint64(block.number) + config.commitBlocks;
        emit DrawingClosed(disputeId, d.seatCount);
        emit PhaseAdvanced(disputeId, DisputeState.Committing);
    }

    /// @notice Commit a hidden vote: keccak256(disputeId, juror, choice, salt).
    ///         One commit per juror covers ALL of that juror's admitted seats.
    ///         Clients MUST use a fresh salt per dispute.
    function commitVote(uint256 disputeId, bytes32 commitment) external {
        Dispute storage d = _disputes[disputeId];
        // An open-voting court has nothing to commit to; letting a commit through would seat a
        // panel by a rule the reveal step no longer checks.
        if (!config.commitRequired) revert WrongState();
        if (d.state != DisputeState.Committing) revert WrongState();
        if (block.number > d.commitDeadline) revert DrawClosed();
        JurorRound storage jr = _jurorRound[disputeId][msg.sender];
        if (jr.seatCount == 0) revert NotSeated();
        if (jr.committed) revert AlreadyCommitted();
        jr.committed = true;
        jr.commitment = commitment;
        emit VoteCommitted(disputeId, msg.sender);
    }

    /// @notice Move Committing -> Revealing after the commit deadline, choosing the
    ///         seated set: committed primaries stay; primaries that did NOT commit
    ///         are marked SILENT and their capacity is filled by the lowest-ranked
    ///         committed alternates (promotion) so absentees can't break quorum.
    function openReveal(uint256 disputeId) external {
        Dispute storage d = _disputes[disputeId];
        if (d.state != DisputeState.Committing) revert WrongState();
        if (block.number <= d.commitDeadline) revert TooEarly();

        _seatPanel(disputeId, d);

        d.state = DisputeState.Revealing;
        d.revealDeadline = uint64(block.number) + config.revealBlocks;
        emit PanelSeated(disputeId, d.seatedWeight);
        emit PhaseAdvanced(disputeId, DisputeState.Revealing);
    }

    /// @notice Reveal a committed vote. Adds the juror's SEATED-seat weight to the
    ///         tally in one shot (k-slot weighting).
    function revealVote(uint256 disputeId, uint8 choice, bytes32 salt) external {
        _reveal(disputeId, msg.sender, choice, salt);
    }

    /// @notice Reveal on a juror's behalf (FR-VT-04). Anyone may call it.
    /// @dev A juror who loses the browser that holds their salt is otherwise slashed for an
    ///      accident, which is the single most expensive support case this protocol has. The
    ///      commitment binds the juror's own address, so a relayer cannot put words in their
    ///      mouth: only the (choice, salt) pair that juror actually committed will verify.
    ///
    ///      The cost is real and is not hidden: the relayer sees the vote before the reveal is
    ///      mined, so a juror who hands their pair to a relayer has given up secrecy for that
    ///      window. Timelock-encrypted reveal is the proper fix and is a later phase.
    function revealVoteFor(uint256 disputeId, address juror, uint8 choice, bytes32 salt) external {
        _reveal(disputeId, juror, choice, salt);
    }

    function _reveal(uint256 disputeId, address juror, uint8 choice, bytes32 salt) private {
        Dispute storage d = _disputes[disputeId];
        if (d.state != DisputeState.Revealing) revert WrongState();
        if (block.number > d.revealDeadline) revert DrawClosed();
        if (choice == 0 || choice > d.choices) revert BadChoice();
        JurorRound storage jr = _jurorRound[disputeId][juror];
        if (jr.dutySeats == 0) revert NotSeated(); // not on the seated panel
        if (jr.revealed || jr.reportedUnavailable) revert BadReveal();
        // Open voting has no commitment to check — the vote IS the reveal, in the open, which is
        // exactly the bandwagoning the court opted into. Only the juror may cast it.
        if (config.commitRequired) {
            if (keccak256(abi.encodePacked(disputeId, juror, choice, salt)) != jr.commitment) revert BadReveal();
        } else if (msg.sender != juror) {
            revert BadReveal();
        }

        jr.revealed = true;
        jr.choice = choice;
        _votes[disputeId][choice] += jr.dutySeats;
        d.revealedCount += jr.dutySeats;
        emit VoteRevealed(disputeId, juror, choice, jr.dutySeats);
    }

    /// @notice Report that this dispute's evidence cannot be retrieved, instead of voting.
    /// @dev A juror who cannot read the record cannot judge it, and voting anyway is worse than
    ///      saying so. This is a discharge of the reveal duty, not a vote: it carries no choice,
    ///      so it can never tip a verdict one way.
    ///
    ///      Reporting alone is NOT free. A lone reporter is a juror who did not reveal, and is
    ///      slashed at gamma like any other silence. It costs nothing only when MOST of the
    ///      participating panel reports the same thing — at which point the failure is the
    ///      court's, not theirs, and the dispute voids with nobody slashed (see _tally).
    function reportUnavailable(uint256 disputeId) external {
        Dispute storage d = _disputes[disputeId];
        if (d.state != DisputeState.Revealing) revert WrongState();
        if (block.number > d.revealDeadline) revert DrawClosed();
        JurorRound storage jr = _jurorRound[disputeId][msg.sender];
        if (jr.dutySeats == 0) revert NotSeated();
        if (jr.revealed) revert BadReveal();
        if (jr.reportedUnavailable) revert AlreadyReported();

        jr.reportedUnavailable = true;
        d.unavailableWeight += jr.dutySeats;
        emit EvidenceUnavailable(disputeId, msg.sender, jr.dutySeats);
    }

    /// @notice Tally + settle a dispute. Callable by anyone once terminal-eligible.
    ///          - undersubscribed draw (panel never reached panelSize) -> refund, ruling 0
    ///          - normal reveal deadline reached                        -> tally + settle
    function finalize(uint256 disputeId) external noReentrant {
        Dispute storage d = _disputes[disputeId];

        if (d.state == DisputeState.Drawing) {
            if (block.number <= d.drawBlock + config.drawWindowBlocks) revert TooEarly();
            // A full-enough panel must be advanced via closeDrawing(), not refunded.
            if (d.seatCount >= config.panelSize) revert WrongState();
            // Undersubscribed: return seated stakes, refund the app, refuse to rule.
            _returnSeatedStakes(disputeId);
            // The pinner is owed here too. It hosted the record through the whole evidence phase,
            // which did happen — only the panel did not. Refunding the app in full contradicted
            // the rule _settle states plainly: the pinning take is paid whatever the outcome.
            uint256 pinShare = (d.feePot * config.pinFeeBps) / BPS;
            if (pinShare > 0) withdrawable[config.pinner] += pinShare;
            uint256 appShare = d.feePot - pinShare;
            withdrawable[d.app] += appShare;
            refundOf[disputeId] = appShare;
            _resolve(disputeId, d, 0, false);
            return;
        }

        if (d.state != DisputeState.Revealing) revert WrongState();
        if (block.number <= d.revealDeadline) revert TooEarly();

        (uint8 ruling, bool tied, bool noQuorum) = _tally(disputeId, d);

        // FR-ST-03: too few jurors turned up. Slash the silent, pay whoever did the work, and put
        // their forfeited stake toward a fresh panel rather than closing a case nobody heard.
        if (noQuorum && !d.voided && config.quorumFailure == QF_REDRAW && d.redraws < MAX_REDRAWS) {
            if (_redraw(disputeId, d)) return;
            // Fell through: the pot could not cover another panel's fees. Settle as normal below
            // rather than reopen a round that cannot pay.
        }

        // The app may be handed a fallback answer, but SETTLEMENT still sees ruling 0. A juror
        // must never be slashed against a number the votes did not produce — that is FR-ST-02,
        // and folding the fallback into settlement would quietly break it.
        uint8 delivered = ruling;
        if (ruling == 0 && !d.voided) {
            if (tied && config.tieBreak == TB_DEFAULT) delivered = _fallbackChoice(d);
            else if (noQuorum && config.quorumFailure == QF_DEFAULT) delivered = _fallbackChoice(d);
            if (delivered != 0) {
                d.fallbackRuling = true;
                emit FallbackRuling(disputeId, delivered, tied);
            }
        }

        _settle(disputeId, d, ruling);
        _resolve(disputeId, d, delivered, tied);
    }

    /// @dev The configured fallback, or 0 when it is not a choice this dispute offers.
    function _fallbackChoice(Dispute storage d) private view returns (uint8) {
        uint8 c = config.defaultChoice;
        return (c == 0 || c > d.choices) ? 0 : c;
    }

    /// @dev Settle the failed round and reopen the draw. Returns false — changing nothing — when
    ///      the fees left could not pay a fresh panel, so the caller settles terminally instead.
    function _redraw(uint256 disputeId, Dispute storage d) private returns (bool) {
        SeatEntry[] storage seats = _seatsOf[disputeId];
        uint256 n = seats.length;
        uint256 pot = 0;
        uint256 owed = 0;

        // Price the round before paying for any of it: the forfeited stake is part of what funds
        // the retry, so the affordability test has to include it.
        for (uint256 i = 0; i < n; i++) {
            SeatEntry storage look = seats[i];
            if (look.settled || look.role == ROLE_RELEASED) continue;
            JurorRound storage lr = _jurorRound[disputeId][look.juror];
            if (lr.revealed) owed += config.jurorFee;
            else pot += (look.slotStake * config.gammaBps) / BPS;
        }
        // What the retry needs is the GROSSED-UP cost, not the bare wage bill. Settlement takes
        // the app, protocol and pinning cuts off the pot it is handed, and only what survives
        // that pays the panel — so a pot of exactly panelSize * jurorFee underflows _settle the
        // moment any of those takes is non-zero, and finalize() is the only way out of Revealing.
        // That would strand the dispute and the retry panel's stakes for good.
        if (d.feePot + pot < owed + arbCost) return false;
        pot = 0; // recounted for real below

        for (uint256 i = 0; i < n; i++) {
            SeatEntry storage seat = seats[i];
            if (seat.settled) continue;
            seat.settled = true;
            JurorRound storage jr = _jurorRound[disputeId][seat.juror];

            if (seat.role == ROLE_RELEASED) {
                withdrawable[seat.juror] += seat.slotStake; // never needed, never at risk
            } else if (jr.revealed) {
                // Voted. Paid and released — they are not made to sit the retry.
                withdrawable[seat.juror] += seat.slotStake + config.jurorFee;
            } else {
                // Everyone else, INCLUDING a juror who reported the record unreachable. Reporting
                // is only doing the work when the panel agrees and the dispute voids; this is a
                // quorum failure, not a void, so it is treated exactly as _settle treats it — as
                // silence. Paying it here would make reporting weakly dominant on a redraw court:
                // free, never worse than staying quiet, sometimes a full fee for no work.
                uint256 slash = (seat.slotStake * config.gammaBps) / BPS;
                pot += slash;
                withdrawable[seat.juror] += seat.slotStake - slash;
                emit Slashed(disputeId, seat.juror, slash);
            }
        }

        // The silence pays for the retry. No treasury cut here: the pot is not a windfall, it is
        // the budget for the round it caused.
        d.feePot = d.feePot - owed + pot;
        d.redraws += 1;
        _resetRound(disputeId, d);
        emit Redrawn(disputeId, d.redraws, d.drawBlock, d.feePot);
        return true;
    }

    /// @dev Wipe everything a round wrote, so the next draw starts from a clean panel.
    ///      Bounded by drawTarget seats and MAX_CHOICES, both small and fixed.
    function _resetRound(uint256 disputeId, Dispute storage d) private {
        SeatEntry[] storage seats = _seatsOf[disputeId];
        for (uint256 i = 0; i < seats.length; i++) {
            delete _slotClaimed[disputeId][seats[i].juror][seats[i].slot];
            delete _jurorRound[disputeId][seats[i].juror];
        }
        delete _seatsOf[disputeId];
        for (uint8 c = 1; c <= d.choices; c++) delete _votes[disputeId][c];

        d.seatCount = 0;
        d.seatedWeight = 0;
        d.revealedCount = 0;
        d.unavailableWeight = 0;
        d.commitDeadline = 0;
        d.revealDeadline = 0;
        d.state = DisputeState.Drawing;
        // A fresh future block for the seed: the old one is public now, and reusing it would let
        // the same jurors who just walked away know exactly which seats they would win.
        d.drawBlock = uint64(block.number) + config.drawDelayBlocks;
        emit PhaseAdvanced(disputeId, DisputeState.Drawing);
    }

    /// @notice Re-attempt ruling delivery if the app's callback previously failed.
    /// @dev noReentrant: a malicious app rule() must not re-enter and get the
    ///      ruling delivered twice (IArbitrable is "called once"). (Audit fix.)
    function redeliverRuling(uint256 disputeId) external noReentrant {
        Dispute storage d = _disputes[disputeId];
        if (d.state != DisputeState.Resolved || d.ruled) revert WrongState();
        _deliver(disputeId, d);
    }

    function withdraw() external noReentrant {
        uint256 amount = withdrawable[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        withdrawable[msg.sender] = 0;
        _pay(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ----------------------------------------------------------- internals
    /// @dev Rank admitted seats by ascending vrfOutput (lower keccak = higher
    ///      priority). Ranks 0..panelSize-1 are primaries, the rest alternates.
    ///      Committed primaries are SEATED; uncommitted primaries are SILENT; then
    ///      the lowest-ranked committed alternates are promoted to SEATED to refill
    ///      the panel up to panelSize. Everything else is RELEASED (unslashed).
    function _seatPanel(uint256 disputeId, Dispute storage d) private {
        SeatEntry[] storage seats = _seatsOf[disputeId];
        uint256 n = seats.length;
        if (n == 0) return;

        // Rank by ascending vrfOutput via an index array (insertion sort; n <= 21).
        uint256[] memory idx = new uint256[](n);
        for (uint256 i = 0; i < n; i++) idx[i] = i;
        for (uint256 i = 1; i < n; i++) {
            uint256 j = i;
            while (j > 0 && seats[idx[j - 1]].vrfOutput > seats[idx[j]].vrfOutput) {
                (idx[j - 1], idx[j]) = (idx[j], idx[j - 1]);
                j--;
            }
        }

        uint256 primaries = config.panelSize;
        uint32 seated = 0;

        // With open voting there is no commitment to sort on, so the panel is the top-ranked
        // seats outright and alternates are never promoted — nothing has happened yet that could
        // tell a primary apart from an absentee.
        bool gated = config.commitRequired;

        // Pass 1: primaries. Committed -> SEATED; uncommitted -> SILENT (still slashed).
        for (uint256 r = 0; r < n && r < primaries; r++) {
            SeatEntry storage s = seats[idx[r]];
            if (!gated || _jurorRound[disputeId][s.juror].committed) {
                s.role = ROLE_SEATED;
                _jurorRound[disputeId][s.juror].dutySeats += 1;
                seated += 1;
            } else {
                s.role = ROLE_SILENT;
            }
        }

        // Pass 2: promote lowest-ranked committed alternates until the panel is full.
        for (uint256 r = primaries; gated && r < n && seated < primaries; r++) {
            SeatEntry storage s = seats[idx[r]];
            if (_jurorRound[disputeId][s.juror].committed) {
                s.role = ROLE_SEATED;
                _jurorRound[disputeId][s.juror].dutySeats += 1;
                seated += 1;
            }
            // else stays ROLE_RELEASED
        }

        d.seatedWeight = seated;
    }

    /// @dev `noQuorum` is reported separately from the ruling because the two answer different
    ///      questions: what the app should be told, and whether the panel actually decided it.
    function _tally(uint256 disputeId, Dispute storage d)
        private
        returns (uint8 ruling, bool tied, bool noQuorum)
    {
        // FR-EV-06: the record was unreachable for most of the panel that turned up. There is no
        // honest verdict to be had, so the dispute voids: ruling 0, and nobody is slashed for a
        // failure that was the court's. Checked BEFORE the vote tally, because the votes that did
        // land were cast by jurors reading a record their peers could not.
        uint256 need = (uint256(config.panelSize) * config.quorumBps + BPS - 1) / BPS;
        uint32 participation = d.revealedCount + d.unavailableWeight;
        // The quorum floor matters: without it one reporter on an otherwise silent panel would be
        // a majority of one and could void any case single-handed.
        if (participation >= need && uint256(d.unavailableWeight) * 2 > participation) {
            d.voided = true;
            emit DisputeVoided(disputeId, d.unavailableWeight, participation);
            return (0, false, false);
        }

        uint32 best = 0;
        for (uint8 c = 1; c <= d.choices; c++) {
            uint32 v = _votes[disputeId][c];
            if (v > best) {
                best = v;
                ruling = c;
                tied = false;
            } else if (v == best && v != 0) {
                tied = true;
            }
        }
        // Quorum: enough of the panel weight revealed, else refuse (ruling 0).
        noQuorum = d.revealedCount < need || best == 0;
        if (noQuorum || tied) {
            return (0, tied, noQuorum);
        }
        return (ruling, false, false);
    }

    /// @dev Settlement waterfall. `ruling == 0` means NO verdict carried — a genuine
    ///      tie, a quorum failure, or nobody revealed. FR-ST-02/FR-ST-03 require that
    ///      outcome to punish only SILENCE, never a juror who showed up and voted, so
    ///      the payout predicate is "revealed AND (no verdict carried OR voted with
    ///      the verdict)". Per seat:
    ///        ROLE_RELEASED                  -> full slot stake back, no fee
    ///        revealed, ruling == 0          -> full stake + jurorFee + pot share
    ///        revealed, choice == ruling     -> full stake + jurorFee + pot share
    ///        revealed, choice != ruling     -> beta slash (ruling != 0 only)
    ///        ROLE_SEATED, never revealed    -> gamma slash
    ///        ROLE_SILENT (never committed)  -> gamma slash
    ///      A ROLE_SILENT seat can never be `revealed`: the role is only assigned to a
    ///      juror whose JurorRound.committed is false, and such a juror gets no
    ///      dutySeats at _seatPanel, so revealVote reverts NotSeated for them. The
    ///      beta arm is therefore reachable only for a revealed-but-wrong seat under a
    ///      real verdict, and on a ruling == 0 settlement the pot is gamma slashes only.
    function _settle(uint256 disputeId, Dispute storage d, uint8 ruling) private {
        SeatEntry[] storage seats = _seatsOf[disputeId];
        uint256 n = seats.length;
        uint256 pot = 0;
        uint256 rewardedSeats = 0;

        // Pass 1: release unneeded alternates, slash the wrong + the silent into the
        // pot, count the rewarded (paid in pass 2).
        for (uint256 i = 0; i < n; i++) {
            SeatEntry storage s = seats[i];
            if (s.settled) continue;

            if (s.role == ROLE_RELEASED) {
                // Alternate never needed: return the full slot stake, no fee.
                s.settled = true;
                withdrawable[s.juror] += s.slotStake;
                continue;
            }

            JurorRound storage jr = _jurorRound[disputeId][s.juror];
            // Rewarded = the juror revealed, AND either no verdict carried (tie /
            // quorum failure — FR-ST-02 forbids slashing them) or they voted with it.
            // In a VOID, reporting the record unreachable is doing the work: it is the answer the
            // court asked for, so it is paid exactly like a reveal.
            bool rewarded = d.voided
                ? (jr.revealed || jr.reportedUnavailable)
                : (jr.revealed && (ruling == 0 || jr.choice == ruling));
            if (rewarded) {
                rewardedSeats += 1; // paid in pass 2
            } else if (d.voided) {
                // Nobody is slashed in a void, not even a seat that stayed silent: the evidence
                // was demonstrably unreachable, so silence is not proof of shirking. Stake back,
                // no fee — the seat did not answer.
                s.settled = true;
                withdrawable[s.juror] += s.slotStake;
            } else {
                // SEATED + revealed-but-wrong => beta (reachable only when ruling != 0;
                // with ruling == 0 every revealer was rewarded above). Otherwise
                // (SEATED but silent at reveal, or a SILENT primary that never
                // committed) => gamma. gamma >= beta guaranteed at deploy.
                uint16 bps = (s.role == ROLE_SEATED && jr.revealed) ? config.betaBps : config.gammaBps;
                uint256 slash = (s.slotStake * bps) / BPS;
                pot += slash;
                s.settled = true;
                withdrawable[s.juror] += s.slotStake - slash;
                emit Slashed(disputeId, s.juror, slash);
            }
        }

        // Fee routing (gross-up): protocol take -> treasury, app take -> app; the
        // remaining prepay covers each rewarded seat's full jurorFee. Same shape
        // whether or not a verdict carried — a tie still pays its revealers.
        uint256 cost = d.feePot; // == arbCost
        uint256 appCut = (cost * config.appFeeBps) / BPS;
        uint256 protocolCut = (cost * config.protocolFeeBps) / BPS;
        // FR-EV-06: the pinning take is paid whatever the outcome. Whoever hosts this court's
        // evidence did that job before a single juror turned up, and is owed for it even when the
        // panel never ruled. The chain cannot verify that they pinned anything — that is what the
        // unavailability void is for: a pinner who does not deliver ends up voiding cases.
        uint256 pinCut = (cost * config.pinFeeBps) / BPS;
        if (pinCut > 0) withdrawable[config.pinner] += pinCut;

        // Distribute the slashed pot: treasury cut, then rewarded seats split the rest.
        uint256 treasuryCut = (pot * config.thetaBps) / BPS;
        uint256 toRewarded = pot - treasuryCut;

        if (rewardedSeats > 0) {
            uint256 share = toRewarded / rewardedSeats;
            uint256 dust = toRewarded - share * rewardedSeats;
            for (uint256 i = 0; i < n; i++) {
                SeatEntry storage s = seats[i];
                if (s.settled) continue; // remaining unsettled == rewarded
                s.settled = true;
                withdrawable[s.juror] += s.slotStake + config.jurorFee + share;
            }
            uint256 jurorFeesPaid = rewardedSeats * config.jurorFee;
            // Residue of the prepay (forfeited fees) refunds to the app.
            uint256 appRefund = appCut + (cost - appCut - protocolCut - pinCut - jurorFeesPaid);
            withdrawable[d.app] += appRefund;
            refundOf[disputeId] = appRefund;
            withdrawable[config.treasury] += protocolCut + treasuryCut + dust;
        } else {
            // NOBODY revealed (so nobody earned a fee — note this is no longer the
            // tie/quorum-failure case, which pays its revealers above): refund the
            // prepay less the protocol take to the app, slashed pot to treasury.
            withdrawable[d.app] += cost - protocolCut - pinCut;
            refundOf[disputeId] = cost - protocolCut - pinCut;
            withdrawable[config.treasury] += protocolCut + pot;
        }
    }

    function _returnSeatedStakes(uint256 disputeId) private {
        SeatEntry[] storage seats = _seatsOf[disputeId];
        for (uint256 i = 0; i < seats.length; i++) {
            SeatEntry storage s = seats[i];
            if (s.settled) continue;
            s.settled = true;
            withdrawable[s.juror] += s.slotStake;
        }
    }

    function _resolve(uint256 disputeId, Dispute storage d, uint8 ruling, bool tied) private {
        d.ruling = ruling;
        d.tied = tied;
        d.state = DisputeState.Resolved;
        emit DisputeResolved(disputeId, ruling, tied);
        _deliver(disputeId, d);
    }

    function _deliver(uint256 disputeId, Dispute storage d) private {
        // Ruling delivery must NEVER brick the protocol. A low-level call cannot
        // revert into this frame regardless of the callee: a reverting rule(), an
        // out-of-gas callee, or an app self-destructed after creation (code.length
        // now 0) all resolve to ok == false here instead of bubbling a revert the
        // way solc's `try/catch` would for a codeless target. On failure the ruling
        // stays pending and can be pulled later via redeliverRuling().
        // isFinal is true: this court has one round and nothing here can overturn its verdict. A
        // coordinator sitting in front of it decides finality for the app behind it.
        (bool ok, ) = d.app.call(abi.encodeCall(IArbitrable.rule, (disputeId, uint256(d.ruling), true)));
        if (ok) {
            d.ruled = true;
            emit RulingDelivered(disputeId, d.ruling);
        } else {
            emit RulingDeliveryFailed(disputeId);
        }
    }

    function _pay(address to, uint256 amount) private {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ------------------------------------------------------------ views (IArbitrator)
    function currentRuling(uint256 disputeId) external view returns (uint256 ruling, bool tied, bool finalized) {
        Dispute storage d = _disputes[disputeId];
        return (d.ruling, d.tied, d.state == DisputeState.Resolved);
    }

    function disputeState(uint256 disputeId) external view returns (uint8) {
        return uint8(_disputes[disputeId].state);
    }

    function getDispute(uint256 disputeId) external view returns (Dispute memory) {
        return _disputes[disputeId];
    }

    /// @notice Distinct jurors currently holding at least one seat, in claim order.
    function getPanel(uint256 disputeId) external view returns (address[] memory jurors) {
        SeatEntry[] storage seats = _seatsOf[disputeId];
        uint256 n = seats.length;
        address[] memory tmp = new address[](n);
        uint256 count = 0;
        for (uint256 i = 0; i < n; i++) {
            address j = seats[i].juror;
            bool seen = false;
            for (uint256 m = 0; m < count; m++) {
                if (tmp[m] == j) {
                    seen = true;
                    break;
                }
            }
            if (!seen) tmp[count++] = j;
        }
        jurors = new address[](count);
        for (uint256 i = 0; i < count; i++) jurors[i] = tmp[i];
    }

    /// @notice Every admitted seat (a juror may appear multiple times under k-slots).
    function getSeats(uint256 disputeId) external view returns (SeatEntry[] memory) {
        return _seatsOf[disputeId];
    }

    /// @notice Per-juror aggregate for a dispute (commit/reveal + seat counts).
    function jurorRoundOf(uint256 disputeId, address juror) external view returns (JurorRound memory) {
        return _jurorRound[disputeId][juror];
    }

    /// @notice Compute the sortition seed for a dispute (for the juror daemon).
    function drawSeed(uint256 disputeId) external view returns (bytes32) {
        Dispute storage d = _disputes[disputeId];
        return keccak256(abi.encodePacked(blockhash(d.drawBlock), disputeId, address(this)));
    }

    receive() external payable {
        revert("use stake()");
    }
}
