// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {IEligibility} from "../interfaces/IEligibility.sol";

/// @title ClosedPoolEligibility — an app-gated juror pool, with the guardrails that make it honest.
/// @notice A court whose jurors the app chooses is peer review by that app's members, not neutral
///         third-party arbitration. That is a legitimate thing to want — members have the domain
///         context a stranger lacks — but it hands the app a lever, so the lever is bounded here.
///
/// @dev The guardrails, and what each is actually for (FR-PG-02 to FR-PG-08):
///
///      REMOVALS NEVER TOUCH A DRAWN PANEL (FR-PG-03). Ejecting a juror mid-dispute, or purging
///      the ones who ruled against the app, is jury tampering — this is the guardrail to ship
///      first if only one ships. Two things enforce it. Here: a removal is scheduled, not
///      immediate, and does not bite for REMOVAL_TIMELOCK_BLOCKS. In the core: the policy is
///      consulted ONLY at claimSeat, so a seat already claimed has its stake locked and its duty
///      fixed; nothing re-reads eligibility afterwards. A juror removed today keeps every seat
///      they already hold, every pending settlement, and their full stake-withdrawal rights — all
///      of which live in the core, which this contract cannot touch.
///
///      GROWTH IS RATE-LIMITED (FR-PG-04). Total pool weight may not rise by more than
///      maxGrowthBpsPerEpoch in one epoch. An app that doubles its pool the week before a large
///      dispute is visible in the PoolGrowth log rather than merely suspected.
///
///      NO SINGLE JUROR DOMINATES (FR-PG-05). A cap in basis points of total pool weight stops a
///      pool that is nominally forty members and effectively three.
///
///      THE SHAPE IS IMMUTABLE (FR-PG-07). Nothing here can turn a published rule into a different
///      one after jurors have staked against it.
///
///      What this contract does NOT do: it does not decide who deserves to be a member. That is
///      the app's judgement, and the PRD is blunt that an objective on-chain predicate earns the
///      credibility an allowlist does not. This is the allowlist shape, bounded — `policyType`
///      says so out loud so a dispute viewer can too.
contract ClosedPoolEligibility is IEligibility {
    /// @notice How membership is decided, disclosed rather than inferred.
    enum PolicyType {
        Predicate, // derived from on-chain facts the app does not control
        Attestation, // an issuer vouches, and can stop vouching
        Allowlist // the app simply names them
    }

    /// @dev ~7 days at 6s blocks. A removal that lands sooner than a dispute can run is a removal
    ///      that can be aimed at a live one.
    uint64 public constant REMOVAL_TIMELOCK_BLOCKS = 100_800;
    uint16 internal constant BPS = 10_000;
    /// @dev Protocol ceilings. A court may be stricter than these and may not be looser.
    uint16 internal constant MAX_POOL_GROWTH_BPS = 500;
    uint16 internal constant MAX_JUROR_WEIGHT_BPS = 1_500;

    address public immutable owner;
    PolicyType public immutable policyType;
    uint16 public immutable maxGrowthBpsPerEpoch;
    uint64 public immutable epochBlocks;
    uint16 public immutable maxJurorWeightBps;
    bool public immutable removalsAllowed;
    /// @notice The rule the app says it applies. Held here so a viewer can quote it (FR-PG-08).
    string public predicateDescription;

    /// @notice Slots each member may field, before the core's own stake cap applies.
    mapping(address => uint256) public memberWeight;
    /// @notice Block from which a scheduled removal takes effect. Zero means no removal pending.
    mapping(address => uint64) public removalEffectiveAt;

    uint256 public totalWeight;
    /// @notice Total weight as it stood when the current epoch opened, and which epoch that is.
    uint256 public epochOpeningWeight;
    uint64 public epochStartedAt;

    event JurorAdmitted(address indexed juror, uint256 weight, uint256 totalWeight);
    event JurorRemoved(address indexed juror, uint64 effectiveAt);
    event RemovalCancelled(address indexed juror);
    event RemovalFinalized(address indexed juror, uint256 weightFreed, uint256 totalWeight);
    event PoolGrowth(uint64 indexed epochStartedAt, uint256 weightBefore, uint256 weightAfter);

    error NotOwner();
    error RemovalsDisabled();
    error NothingScheduled();
    error GrowthCapReached(uint256 allowed, uint256 requested);
    error JurorWeightCapReached(uint256 allowed, uint256 requested);
    error BadPolicy(string what);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address owner_,
        PolicyType policyType_,
        uint16 maxGrowthBpsPerEpoch_,
        uint64 epochBlocks_,
        uint16 maxJurorWeightBps_,
        bool removalsAllowed_,
        string memory predicateDescription_
    ) {
        if (owner_ == address(0)) revert BadPolicy("owner");
        if (maxGrowthBpsPerEpoch_ == 0 || maxGrowthBpsPerEpoch_ > MAX_POOL_GROWTH_BPS) {
            revert BadPolicy("growth");
        }
        if (epochBlocks_ == 0) revert BadPolicy("epoch");
        if (maxJurorWeightBps_ == 0 || maxJurorWeightBps_ > MAX_JUROR_WEIGHT_BPS) {
            revert BadPolicy("jurorCap");
        }
        if (bytes(predicateDescription_).length == 0) revert BadPolicy("description");

        owner = owner_;
        policyType = policyType_;
        maxGrowthBpsPerEpoch = maxGrowthBpsPerEpoch_;
        epochBlocks = epochBlocks_;
        maxJurorWeightBps = maxJurorWeightBps_;
        removalsAllowed = removalsAllowed_;
        predicateDescription = predicateDescription_;
        epochStartedAt = uint64(block.number);
    }

    // ------------------------------------------------------------------ reads
    /// @inheritdoc IEligibility
    /// @dev O(1) and view, as the gas cap demands. A member whose removal has come due reads as
    ///      zero; one whose removal is merely scheduled still fields their full weight, which is
    ///      the point of the timelock.
    function weightOf(address juror, uint96) external view returns (uint256) {
        uint64 effectiveAt = removalEffectiveAt[juror];
        if (effectiveAt != 0 && block.number >= effectiveAt) return 0;
        return memberWeight[juror];
    }

    /// @inheritdoc IEligibility
    function policyDescriptor() external view returns (string memory) {
        return string.concat(
            "closed pool (",
            policyType == PolicyType.Predicate
                ? "predicate"
                : policyType == PolicyType.Attestation ? "attestation" : "allowlist",
            "): ",
            predicateDescription
        );
    }

    /// @notice What one more slot of weight would do to this juror's share of the pool.
    function jurorWeightCap() public view returns (uint256) {
        return (totalWeight * maxJurorWeightBps) / BPS;
    }

    /// @notice Weight this epoch may still admit before the growth cap bites.
    function growthHeadroom() public view returns (uint256) {
        uint256 opening = _liveEpochOpeningWeight();
        uint256 allowed = (opening * maxGrowthBpsPerEpoch) / BPS;
        // A pool that starts empty has to be able to start: the cap is a rate, and a rate applied
        // to nothing is nothing. One slot per epoch is the floor.
        if (allowed == 0) allowed = 1;
        uint256 grown = totalWeight > opening ? totalWeight - opening : 0;
        return grown >= allowed ? 0 : allowed - grown;
    }

    // ----------------------------------------------------------------- writes
    /// @notice Admit a member, or raise an existing member's weight.
    function admit(address juror, uint256 weight) external onlyOwner {
        if (juror == address(0) || weight == 0) revert BadPolicy("admit");
        _rollEpoch();

        uint256 current = memberWeight[juror];
        if (weight <= current) revert BadPolicy("admit"); // use removal to reduce, not this
        uint256 added = weight - current;

        uint256 headroom = growthHeadroom();
        if (added > headroom) revert GrowthCapReached(headroom, added);

        uint256 newTotal = totalWeight + added;
        // Measured against the pool AS IT WILL BE, so admitting one huge member cannot slip in
        // by being the thing that makes the denominator large enough.
        uint256 cap = (newTotal * maxJurorWeightBps) / BPS;
        if (cap == 0) cap = 1; // the first members would otherwise be uncapped-by-zero
        if (weight > cap) revert JurorWeightCapReached(cap, weight);

        memberWeight[juror] = weight;
        totalWeight = newTotal;
        // Admitting clears a pending removal: the app changed its mind before it took effect.
        if (removalEffectiveAt[juror] != 0) {
            removalEffectiveAt[juror] = 0;
            emit RemovalCancelled(juror);
        }
        emit JurorAdmitted(juror, weight, newTotal);
    }

    /// @notice Schedule a member's removal. It does not bite for REMOVAL_TIMELOCK_BLOCKS.
    /// @dev Deliberately not immediate, and deliberately loud. Everything the juror is owed lives
    ///      in the core and is untouched by this: seats already drawn, pending settlements, and
    ///      the right to withdraw their stake.
    function scheduleRemoval(address juror) external onlyOwner {
        if (!removalsAllowed) revert RemovalsDisabled();
        if (memberWeight[juror] == 0) revert BadPolicy("member");
        uint64 effectiveAt = uint64(block.number) + REMOVAL_TIMELOCK_BLOCKS;
        removalEffectiveAt[juror] = effectiveAt;
        emit JurorRemoved(juror, effectiveAt);
    }

    /// @notice Call off a scheduled removal before it takes effect.
    function cancelRemoval(address juror) external onlyOwner {
        if (removalEffectiveAt[juror] == 0) revert NothingScheduled();
        removalEffectiveAt[juror] = 0;
        emit RemovalCancelled(juror);
    }

    /// @notice Settle a removal that has come due, freeing the weight it held.
    /// @dev Permissionless: the app is the last party you want deciding when its own removal
    ///      finishes counting. Until this is called the member simply reads as weight zero, so
    ///      nothing is gained by delaying it except a stale totalWeight.
    function finalizeRemoval(address juror) external {
        uint64 effectiveAt = removalEffectiveAt[juror];
        if (effectiveAt == 0) revert NothingScheduled();
        if (block.number < effectiveAt) revert BadPolicy("tooEarly");

        uint256 weight = memberWeight[juror];
        memberWeight[juror] = 0;
        removalEffectiveAt[juror] = 0;
        totalWeight -= weight;
        // A removal is not growth, so it must not create headroom either. Lower the epoch's
        // opening mark with it, or an app could churn members to admit past the cap.
        uint256 opening = _liveEpochOpeningWeight();
        epochOpeningWeight = opening > weight ? opening - weight : 0;
        epochStartedAt = _currentEpochStart();
        emit RemovalFinalized(juror, weight, totalWeight);
    }

    // -------------------------------------------------------------- internals
    function _currentEpochStart() private view returns (uint64) {
        uint64 elapsed = uint64(block.number) - epochStartedAt;
        return epochStartedAt + (elapsed / epochBlocks) * epochBlocks;
    }

    /// @dev The opening weight of the epoch we are actually in, without writing to storage.
    function _liveEpochOpeningWeight() private view returns (uint256) {
        return block.number >= epochStartedAt + epochBlocks ? totalWeight : epochOpeningWeight;
    }

    function _rollEpoch() private {
        if (block.number < epochStartedAt + epochBlocks) return;
        emit PoolGrowth(epochStartedAt, epochOpeningWeight, totalWeight);
        epochStartedAt = _currentEpochStart();
        epochOpeningWeight = totalWeight;
    }
}
