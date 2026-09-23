# PRD — Generic Jury Protocol for Polkadot

**Codename:** TBD · **Status:** Draft for build · **Owner:** Bhavya
**Supersedes:** `jury-protocol-build-plan.md` (kept in-repo as `docs/spec.md`)

---

## 1. Overview

A shared arbitration layer any app or DAO can call when a decision requires human judgement.
The protocol resolves disputes; it never knows what a dispute is about.

Three product surfaces:

| Surface | Audience | What it is |
|---|---|---|
| **Console** (SPA) | app developers | register and configure courts, manage pools, monitor disputes |
| **SDK** (TypeScript) | app developers | integrate disputes into an app; drop-in juror UI |
| **Protocol** (contracts → pallet) | everyone | courts, sortition, voting, settlement |

### 1.1 Thesis

1. **Dispute resolution is infrastructure, not a feature.**
2. **Stake-weighted juries are plutocratic.** PoP gating turns capture into a coordination problem.
3. **Generality lives in configuration, not code.**

### 1.2 Design principle

> An app may make its own court worse for itself in a hundred ways, and may not make the protocol
> worse for anyone else in any way.

### 1.3 Non-goals for v1

Protocol token · cross-chain disputes · on-chain evidence storage · `K > 8` · reputation scores ·
fiat on-ramp · mobile apps.

---

## 2. Success metrics

| Metric | Target at 6 months post-mainnet |
|---|---|
| Integrated apps with >=1 real dispute | 5 |
| Disputes resolved end to end | 250 |
| Median time to first ruling | <= 6 days |
| Reveal rate among committed jurors | >= 95% |
| Disputes voided for evidence unavailability | <= 2% |
| Courts rejected at registration for bad economics | tracked, not minimised |
| Appeal rate | 5-15% |
| Support tickets about lost salts | <= 1% of commits |

---

## 3. Personas

**Priya** — app developer, freelance marketplace, one day to integrate.
**Rahul** — end user/party, wants money back, abandons on surprise timelines.
**Anita** — juror, stakes 300 DOT, leaves permanently if slashed unfairly.
**Dev** — DAO operator, wants human veto over token votes without rewriting governance.

---

## 4. Architecture

```
App layer        Escrow · Moderation · Grants · DAO proposals   (implement IArbitrable)
                        | createDispute(kind, choices, extraData)
                        v rule(disputeId, ruling, final)
Interface        IArbitrator / IArbitrable / IEligibility / IIncentivePolicy / IFeePolicy
                        |
Core             CourtRegistry · CourtRouter · JurorRegistry · Sortition
                 VoteBooth · Settlement · Evidence
                        |
Substrate        pallet-revive on Asset Hub  ->  pallet-jury + precompile on own chain
```

### 4.1 Configurability tiers

| Tier | Scope | Set by | Containment |
|---|---|---|---|
| **Protocol invariants** | randomness, stake custody, max panel, max slash, min activation delay, fee ceilings | runtime governance | not configurable |
| **Court parameters** | timings, rates, quorum, ties, fees, pool policy | app at registration | validated on-chain; incoherent configs rejected |
| **Policy modules** | eligibility, incentive math, fee curves | app, contract address | staticcall + gas cap + output re-validation + fallback to Tier 1 |
| *Escape hatch* | whole arbitrator | app deploys own `IArbitrator` | loses shared pool, keeps interface |

### 4.2 Authentication model

**There is no API key.** Registration returns a public `courtId`. All authentication is by address
and signature. The SDK never contacts a first-party backend for authorisation; an integrated app
must remain fully operable if the console is down.

---

## 5. Functional requirements

### 5.1 Court registration and configuration

**FR-CR-01** — `registerCourt(CourtConfig)` is permissionless, returns `uint96 courtId`.

```solidity
struct CourtConfig {
    // participation
    address stakeAsset;
    uint256 minStake;
    uint32  activationDelay;
    uint8   panelSize;              // odd, <= MAX_PANEL
    uint16  alternatesBps;
    uint8   eligibilityMode;        // STAKE | POP | HYBRID | MODULE   [immutable]
    address eligibilityModule;      //                                [immutable]
    bytes32 popCredential;

    // pool policy (see 5.3)
    PoolPolicy pool;

    // evidence
    uint32  evidencePeriod;
    uint8   evidenceAccess;         // PARTIES | PARTIES_PLUS_BONDED | OPEN
    uint256 evidenceBond;
    uint16  maxSubmissionsPerParty;
    uint32  maxEvidenceBytes;

    // voting
    uint32  commitPeriod;
    uint32  revealPeriod;
    bool    commitRequired;
    uint16  quorumBps;
    uint8   quorumFailure;          // REDRAW | DEFAULT | REVERT
    uint8   tieBreak;               // REVERT | DEFAULT | ESCALATE

    // incentives
    uint16  incoherenceBps;         // beta, <= MAX_SLASH_BPS
    uint16  nonRevealBps;           // gamma, >= beta
    uint256 jurorFee;               // f per slot
    uint16  treasuryCutBps;         // theta

    // fees
    uint16  appFeeBps;
    address appFeeRecipient;

    // appeals
    uint96  parentCourt;
    uint16  appealCostGrowthBps;
    uint8   maxAppealRounds;

    // access
    bool    openToPublic;           // false => arbitrable allowlist enforced
}
```

**FR-CR-02** — Registration MUST reject economically incoherent configs:

```solidity
require(cfg.panelSize % 2 == 1 && cfg.panelSize <= MAX_PANEL);
require(cfg.nonRevealBps >= cfg.incoherenceBps,        "silence must cost more");
require(cfg.incoherenceBps <= MAX_SLASH_BPS,           "over ceiling");
require(cfg.revealPeriod >= MIN_REVEAL,                "unrevealable");
require(cfg.appFeeBps + PROTOCOL_FEE_BPS <= MAX_TAKE_BPS, "jurors starved");

// q* = beta*s / (beta*s + f + expectedPotShare) must land near a coin flip
uint256 atRisk = cfg.incoherenceBps * cfg.minStake / 10_000;
uint256 upside = cfg.jurorFee + expectedPotShare(cfg);
require(atRisk * 10_000 <= upside * MAX_QSTAR_RATIO,   "jurors underpaid");
```

**FR-CR-03** — Config split into **immutable** (`stakeAsset`, `eligibilityMode`,
`eligibilityModule`, `pool.policyType`) and **mutable** halves. Immutable fields revert on update.

**FR-CR-04** — Mutable updates queue for `max(UPDATE_TIMELOCK, unbondingPeriod)`.

**FR-CR-05** — Any queued change to `incoherenceBps`, `nonRevealBps`, `minStake`, or
`eligibilityModule` opens a **penalty-free juror exit window** for the timelock duration,
unbonding waived.

**FR-CR-06** — `configHash` snapshotted into each dispute at creation. Settlement uses the
snapshot, never live storage.

**FR-CR-07** — Courts form a tree via `parentCourt` for appeal escalation.

**FR-CR-08** — When `openToPublic == false`, only allowlisted arbitrable addresses may call
`createDispute`. Allowlist managed by the court owner, timelocked for removals only.

### 5.2 Eligibility

**FR-EL-01** — Interface:

```solidity
interface IEligibility {
    /// @return weight in slot units; 0 = not eligible. MUST be view and O(1).
    function weightOf(address juror, uint96 courtId) external view returns (uint256);
    function policyDescriptor() external view returns (string memory);
}
```

**FR-EL-02** — All module calls use `staticcall` with `ELIGIBILITY_GAS_CAP`. On revert, timeout,
or a return value failing core invariants, weight resolves to **0** (fail closed for eligibility —
unlike incentives, which fail open to Tier-1 defaults).

**FR-EL-03** — Four modes: `STAKE` (plutocratic by design) · `POP` (personhood, weight 1) ·
`HYBRID` (`f(stake) x isPerson`) · `MODULE` (app-supplied predicate).

**FR-EL-04** — App-supplied modules SHOULD be **objective on-chain predicates**, not allowlists.

### 5.3 Closed-pool guardrails

Applies whenever `eligibilityMode == MODULE` or `pool.closed == true`.

```solidity
struct PoolPolicy {
    bool    closed;                  // pool is app-gated          [immutable]
    uint8   policyType;              // PREDICATE | ATTESTATION | ALLOWLIST  [immutable]
    uint16  maxGrowthBpsPerEpoch;    // <= MAX_POOL_GROWTH_BPS (500)
    uint32  epochLength;
    uint16  maxJurorWeightBps;       // single-juror weight cap, <= 1500
    uint32  minPoolWeightMultiple;   // x panelSize x minStake before disputes allowed
    bool    removalsAllowed;
}
```

**FR-PG-01 — Appeal to a neutral parent is mandatory.** `closed == true` requires
`parentCourt != 0` and that the parent is **not** app-gated by the same owner.

**FR-PG-02 — Elevated activation delay.** `closed == true` requires
`activationDelay >= MIN_CLOSED_ACTIVATION` (14 days, recommended 30).

**FR-PG-03 — Removals must not touch live disputes.** A removal: never affects already-drawn
slots in `Drawing`/`Commit`/`Reveal`/`Tally`; is timelocked by `REMOVAL_TIMELOCK` (>= 7 days);
preserves full stake withdrawal rights and pending settlements; emits
`JurorRemoved(courtId, juror, effectiveAt)`. **If only one guardrail ships, ship this one.**

**FR-PG-04 — Rate-limited growth.** Pool weight may not increase more than
`maxGrowthBpsPerEpoch` per epoch; excess queues to next epoch. Emit
`PoolGrowth(courtId, epoch, weightBefore, weightAfter)`.

**FR-PG-05 — Per-juror weight cap.** No juror above `maxJurorWeightBps` of total pool weight.

**FR-PG-06 — Minimum pool before disputes.** `createDispute` reverts `CourtNotReady` when
`activeWeight < panelSize * minStake * minPoolWeightMultiple`. Exposed as `courtReadiness()`.

**FR-PG-07 — `eligibilityMode`, `eligibilityModule`, `pool.closed`, `pool.policyType` immutable.**

**FR-PG-08 — Mandatory disclosure.** MetaEvidence MUST carry a `jurorPool` block recorded
permanently with the dispute:

```json
"jurorPool": {
  "policy": "app-members",
  "predicate": ">=5 completed orders, no open dispute",
  "eligibilityModule": "0x...",
  "openToPublic": false,
  "appealCourt": "General Court #1"
}
```

The dispute viewer MUST show pool policy next to the verdict.

**Reference implementation:**

```solidity
contract AppMemberEligibility is IEligibility {
    IMarketplace public immutable app;
    uint256      public immutable minOrders;
    uint96       public immutable courtId;

    function weightOf(address juror, uint96 cid) external view returns (uint256) {
        if (cid != courtId)                        return 0;
        if (app.completedOrders(juror) < minOrders) return 0;
        if (app.isPartyToOpenDispute(juror))       return 0;
        if (app.isBanned(juror))                   return 0;
        return 1;                                   // one member, one slot
    }

    function policyDescriptor() external pure returns (string memory) {
        return "app-members: >=5 completed orders, no open dispute, not banned";
    }
}
```

Keep it `view` and O(1) — it runs under a gas cap. Never loop over order history.

### 5.4 Two-court routing — Phase 2

- **User vs user** — closed app-member pool is appropriate.
- **User vs app** — a pool the app controls is a direct conflict of interest; no VRF fixes it.

**FR-2C-01** — Every app registers **two courts**: a **peer court** (closed, app-member predicate)
and a **neutral court** (`openToPublic`, STAKE or POP, not app-gated). The peer court's
`parentCourt` MUST be the neutral court (also satisfies FR-PG-01).

**FR-2C-02** — `createDispute` takes a `disputeKind`; a `CourtRouter` resolves it:

```solidity
contract CourtRouter {
    struct Route { uint96 courtId; bool appMayBeParty; }
    mapping(address arbitrable => mapping(uint8 kind => Route)) public routes;

    function resolve(address arbitrable, uint8 kind, address[] calldata parties)
        external view returns (uint96 courtId)
    {
        Route memory r = routes[arbitrable][kind];
        require(r.courtId != 0, "unrouted kind");
        if (_appIsParty(arbitrable, parties)) {
            require(!registry.isAppGated(r.courtId, arbitrable), "ConflictedCourt");
        }
        return r.courtId;
    }
}
```

**FR-2C-03** — `_appIsParty` is enforced by the core: true if any party is the arbitrable itself,
its declared owner, fee recipient, treasury, or a declared affiliate. Undeclared affiliates are
accepted residual risk.

**FR-2C-04** — Conflict + app-gated court => `createDispute` reverts `ConflictedCourt`.

**FR-2C-05** — Either party may unilaterally escalate a peer-court dispute to the neutral court
during the appeal window by funding the appeal.

**FR-2C-06** — Console MUST surface routing as first-class config and warn on conflicted routing.

### 5.5 Dispute lifecycle

```
Created -> Evidence -> Drawing -> Commit -> Reveal -> Tally -> Appealable -> Ruled -> Executed
```

**FR-DL-01** — Every transition time-bounded and crankable by anyone. No transition may depend on
a party acting.

**FR-DL-02** — Evidence freezes when `Evidence` closes, before `Drawing` opens.

**FR-DL-03** — `rule` delivered by push wrapped in try/catch; on failure emit
`RulingDeliveryFailed` and expose a pull method.

**FR-DL-04** — `rule(disputeId, ruling, final)` carries a `final` flag; `false` while appeal
rounds remain. Apps must not execute irreversible actions on non-final rulings.

**FR-DL-05** — `numChoices` MUST match `rulingOptions.titles` count in MetaEvidence, validated at
`createDispute`. Ruling `0` is always "refuse to arbitrate".

### 5.6 Evidence

**FR-EV-01** — ERC-1497-compatible events:

```solidity
event MetaEvidence(uint256 indexed metaEvidenceId, string evidenceURI);
event Dispute(IArbitrator indexed arbitrator, uint256 indexed disputeId,
              uint256 metaEvidenceId, uint256 evidenceGroupId);
event Evidence(IArbitrator indexed arbitrator, uint256 indexed evidenceGroupId,
               address indexed party, string evidenceURI);
```

**FR-EV-02** — `evidenceGroupId` independent of `disputeId`.

**FR-EV-03** — On-chain storage is metadata only:

```solidity
struct EvidenceRecord {
    address submitter; bytes32 contentHash; uint64 submittedAt;
    uint32 sizeBytes;  bool confidential;
}   // URI lives in the event log
```

**FR-EV-04** — Parties submit free up to `maxSubmissionsPerParty`; third parties post
`evidenceBond`, refunded at ruling unless a majority of revealing jurors flags it as spam.
The cap matters more than the bond.

**FR-EV-05 — Availability.** v1 uses **protocol pinning funded from arbitration cost** for
`disputeLifetime + appealWindow + archival`. Stated centralisation assumption, documented plainly.

**FR-EV-06 — Unavailability escape hatch.** If a majority of revealing jurors report evidence
unretrievable, dispute voids to `ruling = 0`: parties refunded, jurors paid base fee,
**nobody slashed.**

**FR-EV-07 — Confidential evidence.** Jurors publish an X25519 key at registration; after the draw
the submitter encrypts a symmetric key to each drawn juror, XChaCha20-Poly1305 payload on IPFS.
**Non-anonymous courts only** — cannot compose with Phase-4 ring-VRF anonymous panels.

### 5.7 Selection

**FR-SL-01** — `stake(courtId, amount)` holds funds; eligibility begins at `block + activationDelay`.

**FR-SL-02** — `k x minStake` => `k` slots, each independently staked and slashed.

**FR-SL-03** — `seed = H(relayRandomness(B+delta) || disputeId || courtId)`, delta = 10-50 blocks.
Never app-configurable.

**FR-SL-04 — Pull draw (contracts).** Juror computes `h = VRF(sk, seed || slotIndex)` locally,
claims only if `h/2^256 < tau`, `tau ~ 1.3 * panelSize / totalWeight`. Claims collect for a fixed
window; the `panelSize` **lowest VRF outputs** are admitted. **Not first-come.**

**FR-SL-05 — Push draw (pallet).** Stake-weighted Fenwick tree in `on_initialize`.

**FR-SL-06** — Draw `ceil((1 + alternatesBps) * panelSize)`; overflow are alternates promoted when
a primary fails to commit.

**FR-SL-07** — Disputants and their declared affiliates are excluded from their own panels.

### 5.8 Voting

**FR-VT-01** — `commit(disputeId, slot, keccak256(disputeId, juror, choice, salt))`.
**FR-VT-02** — `reveal(disputeId, slot, choice, salt)` verified against the commitment.
**FR-VT-03** — Weighted majority over revealed votes; `commitRequired == false` permits open voting.
**FR-VT-04 — Reveal resilience.** v1 ships **relayer reveal**: anyone may submit a valid
`(choice, salt)` on a juror's behalf. Disclosed privacy leak limited to relayer + reveal window.
Timelock-encrypted reveal is the Phase-5 fix.

### 5.9 Settlement

```
pot P = beta*s*|incoherent| + gamma*s*|silent|

coherent        -> + jurorFee + (1-theta)*P / |coherent|
incoherent      -> - beta*s, forfeits fee
silent          -> - gamma*s, forfeits fee, reduced draw weight for N epochs
tie / no quorum -> nobody slashed except the silent
```

**FR-ST-01** — `gamma > beta` enforced.
**FR-ST-02** — Ties and quorum failures do not slash participants.
**FR-ST-03** — Quorum failure: slash the silent, refund revealers with fee, redraw from the
slashed pot, cap at 2 redraws, then apply `quorumFailure` policy.
**FR-ST-04** — Fee waterfall enforced in code: jurors first, then pinning, then app fee, then
protocol fee. `appFeeBps + protocolFeeBps <= MAX_TAKE_BPS`.
**FR-ST-05** — Settlement never mints. Invariant-tested.

### 5.10 Appeals

**FR-AP-01** — Round `r` panel = `2*n_{r-1} + 1`; higher courts carry higher `minStake` and
`jurorFee`; cost grows ~2.5x per round.
**FR-AP-02** — The appellant must fully fund the next round inside the appeal window. If only one
side funds, that side wins by default.
**FR-AP-03** — No retroactive slashing across rounds.

### 5.11 DAO integration

| Surface | Mechanism | Use when |
|---|---|---|
| Proxy account | jury sovereign account as governance proxy | day-one demo |
| Origin adapter | `EnsureOrigin` for `JuryApproved<CourtId>` | OpenGov track gating |
| Call escrow | DAO submits bounded `Call` + kind; dispatched on approve | DAO needs no jury awareness |
| **Optimistic challenge** | token vote passes -> challenge window -> bonded escalation -> jury veto | **lead with this** |
| XCM binding | `MultiLocation -> courtId`, ruling returned via XCM | Phase 5 |

Ship adapters for an OpenGov track, an OZ `Governor` veto hook, and a Safe module.

---

## 6. Product surfaces

### 6.1 Console (SPA)

| Screen | Requirements |
|---|---|
| Court registration | guided config with live `q*` calculation, inline validation mirroring FR-CR-02 |
| **Routing** | map `disputeKind -> court`; warn on conflicted routing (FR-2C-06) |
| Pool management | eligibility module, pool policy, growth chart, weight distribution, additions/removals with timelock status |
| Config updates | diff view, timelock countdown, juror exit-window banner |
| MetaEvidence | editor with `jurorPool` auto-populated, IPFS pinning, versioning |
| Dispute monitor | live phase, panel drawn vs target, evidence health, verdict history |
| Court health | active weight vs readiness, reveal rate, appeal rate, median resolution time |
| Balance | optional subsidy prefunding, per-dispute cap, low-balance alerts |

**NFR:** the console is never the source of truth. Every console action must be reproducible via
SDK or direct contract call.

### 6.2 SDK (`@org/jury-sdk`)

```ts
const jury = new JuryClient({ chain: 'paseo-asset-hub', signer });
const ready = await jury.courtReadiness(COURT_ID);        // gate the escalate button
const cost  = await jury.arbitrationCost(COURT_ID);       // always fetch fresh
const { disputeId } = await jury.createDispute({
  courtId: COURT_ID, kind: DisputeKind.UserVsUser,
  arbitrable: escrowAddr, choices: 3, metaEvidence: META_ID,
  parties: [buyer, seller], value: cost,
});
jury.onRuling(escrowAddr, ({ disputeId, ruling, final }) => {
  if (final) settleOrder(disputeId, ruling);
});

await jury.submitEvidence({ groupId: orderId, files, pin: true });

const { seats, phase, deadline, commit, reveal } = useJurorSession(COURT_ID);
```

**FR-SDK-01** — No first-party backend dependency for any authorisation path.
**FR-SDK-02** — `courtReadiness()` and fresh `arbitrationCost()` on every escalation.
**FR-SDK-03** — Salt generation, encrypted persistence, backup are SDK responsibilities.
**FR-SDK-04** — Ship a drop-in juror UI component.
**FR-SDK-05** — Typed errors mapping every core revert reason, especially `CourtNotReady`,
`ConflictedCourt`, `JurorsUnderpaid`.

### 6.3 Juror onboarding page (in-app, SDK component)

A front end over `stake(courtId, amount)` — **not an admin tool.** It may not approve, weight,
exclude or invite specific jurors; that is the eligibility predicate's job.

---

## 7. Economics

`q* = beta*s / (beta*s + f + expectedPotShare)`. Target **0.5-0.6**.

Worked example — 7 slots, s = 100 DOT, f = 5, beta = 10%, gamma = 25%, theta = 20%, verdict 5-2,
arbitration cost 40 DOT:

| Flow | Amount |
|---|---|
| Parties in | 40 |
| -> juror fee pool (7 x 5) | 35 |
| -> evidence pinning | 2 |
| -> app fee (2%) | 2 |
| -> protocol fee (1%) | 1 |
| Slash pot (2 x 10 DOT) | 20 |
| -> treasury (theta) | 4 |
| -> 5 coherent jurors | 16 |
| **Coherent juror** | **+5 + 3.2 = +8.2** |
| **Incoherent juror** | **-10** |

`q*` = 10/18.2 ~ **0.55**. **For more security, raise the fee, not the penalty.**

**Closed-pool token risk:** if a closed pool stakes the app's own token, jury security correlates
with token price. Denominate `minStake` in a stable-ish asset, or repeg dynamically with a floor.

---

## 8. Threat model

| Attack | Mitigation | Residual |
|---|---|---|
| Just-in-time staking | activation delay | none |
| Collator seed grinding | delayed + mixed seed, VRF | small |
| Latency race for seats | lowest-VRF admission, fixed window | none |
| Unstake to dodge slash | unbonding > max dispute life; drawn stake locked | none |
| Sybil splitting | harmless under stake weight; fatal under 1p1v | needs real PoP credential |
| Non-reveal griefing | gamma > beta, alternates, reduced future weight | none |
| Lost salt | relayer reveal, encrypted backup | privacy leak to relayer |
| Reverting `rule` | try/catch + pull fallback | none |
| Malicious policy module | staticcall, gas cap, output re-validation, Tier-1 fallback | none |
| **Pool packing (closed court)** | **neutral parent appeal, 30d activation, growth cap, weight cap, immutable mode** | **app can still shape the pool over months** |
| **App as party in own court** | **CourtRouter conflict predicate, `ConflictedCourt` revert** | **undeclared affiliates** |
| Mid-dispute juror removal | removals never touch drawn slots, timelocked | none |
| Predatory court draining shared pool | per-court stake silos in v1 | capital fragmentation |
| Evidence unavailability | protocol pinning + juror void path | centralised pinning in v1 |
| p+e bribery | secret panels, unknown size, superlinear appeals; ring-VRF Phase 4 | **open — document honestly** |

---

## 9. User journeys

### 9.1 Priya integrates (one day)
Register peer + neutral courts -> configure routing -> publish MetaEvidence with `jurorPool` ->
implement `IArbitrable` -> deploy on Paseo -> run one dispute with test jurors -> seed the pool ->
mainnet.

### 9.2 Rahul escalates
Escalate button gated on `courtReadiness` -> cost and ~6-day timeline shown upfront -> pays ->
3-day evidence window -> evidence freezes -> ~4 days with phase notifications -> ruling, escrow
moves, verdict + vote split + pool policy shown -> 3-day appeal window.

### 9.3 Anita jurors
`stake(courtId, 300 DOT)` -> 30-day activation (closed pool) -> notified when seed publishes ->
daemon computes VRF, claims seats -> reads MetaEvidence + evidence with retrievability warnings ->
commits (salt persisted) -> reveals (or relayer does) -> settled +8.2 or -10 per slot -> unbonds,
or exits penalty-free if the court raises beta.

---

## 10. Roadmap

### Phase 0 — Decide and specify (1-2 weeks)
Close §11 decisions. Freeze interfaces and FSM. **Benchmark VRF verification cost on Paseo.**
*Done when:* interfaces frozen, VRF gas measured not estimated.

### Phase 1 — MVP, one court, Paseo (4-6 weeks)
Fixed params, no registry. Commit-reveal, pull sortition, flat settlement, `SimpleEscrow`.
*Done when:* one dispute goes create -> draw -> commit -> reveal -> rule -> payout, gas recorded.

**Do not build the configuration system before the resolution loop works.**

### Phase 2 — Generality, closed pools, two-court routing (6-8 weeks)
`CourtRegistry` + Tier-1 validation · `CourtRouter` + conflict predicate · `AppMemberEligibility`
+ all FR-PG guardrails · appeals with funding mechanic · tie/quorum policies · fee waterfall ·
timelocked updates with exit windows · console v1.
*Done when:* an app runs a peer court and a neutral court; a dispute where the app is a party is
**rejected** from the peer court; a predatory config is rejected; a mid-dispute juror removal
provably does not affect the drawn panel.

### Phase 3 — Differentiator and SDK (4-6 weeks)
`PopGatedEligibility` on People Chain credentials · Tier-2 module plumbing · SDK + juror daemon +
drop-in juror UI · indexer · relayer reveal.

### Phase 4 — Native engine (8-12 weeks)
`pallet-jury` + precompile · ring-VRF anonymous panels · fee-free reveals · `on_initialize` ·
push sum-tree draw.

### Phase 5 — Adoption (ongoing)
Publish crate · DAO adapters · XCM · Filecoin/Crust evidence deals · timelock-encrypted reveal ·
**two audits by different firms** · mainnet.

---

## 11. Open decisions — close in Phase 0

1. **Can an Asset Hub contract read People Chain PoP attestations?** Gates the differentiator.
2. **Any Bandersnatch/ring-VRF precompile on Asset Hub?** Almost certainly not.
3. **Stake silos or shared pool?** -> **Silos.**
4. **Stake asset:** DOT-only v1.
5. **Protocol token: no.**
6. **`K` cap:** 8.
7. **Who stakes the first 700 DOT** so dispute #1 can resolve?
8. **Do you subsidise arbitration cost?** If yes, allowlisting becomes mandatory.

---

## 12. Testing

- **Invariants (foundry):** never mints · total slashed <= ceilings · always terminal · no juror
  loses more than locked slot stake · removals never alter a drawn panel.
- **Registry fuzzing:** every accepted config satisfies the economic invariants, every rejected one
  violates >=1.
- **Adversarial integration:** reverting `rule` · reverting module · gas-bomb module · all-silent
  panel · exact tie · unstake mid-dispute · config change mid-dispute · pool doubled pre-dispute ·
  app routed as party into peer court.
- **Agent simulation (`sim/`):** honest, lazy and bribed populations across a
  `(beta, gamma, f, panelSize)` sweep. **Publish it.**

---

## 13. What would make this fail

- Building the configuration system before one dispute resolves end to end.
- Shipping a shared juror pool with permissionless court creation.
- Setting slashing high and fees low.
- Letting app-supplied code sit on the critical path without a fallback.
- Shipping closed pools without the neutral parent appeal.
- Letting an app arbitrate a dispute it is party to.
- Claiming p+e resistance you do not have.
- Solving cross-chain before same-chain.

---

## 14. Appendix — workspace layout

```
jury-protocol/
├── contracts/src/interfaces/   IArbitrator IArbitrable IEligibility
│                               IIncentivePolicy IFeePolicy
├── contracts/src/core/         ArbitratorCore CourtRegistry CourtRouter
│                               JurorRegistry Sortition VoteBooth Settlement Evidence
├── contracts/src/policies/     StakeWeighted PopGated AppMember LinearIncentive FlatFee
├── contracts/src/examples/     SimpleEscrow DaoCallEscrow OptimisticChallenge
├── pallets/pallet-jury/
├── precompile/
├── sdk/                        TS client · juror daemon · juror UI component
├── console/                    SPA
├── indexer/
├── sim/                        agent-based economic simulation
└── docs/                       spec · threat model · integration guide
```
