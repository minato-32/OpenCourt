# Generic Jury Protocol on Polkadot — Build Plan

A shared arbitration layer that any app or DAO can call when a decision needs human judgement.
The protocol resolves disputes; it never knows what a dispute is about.

---

## 1. Thesis

Three claims this project is betting on:

1. **Dispute resolution is infrastructure, not a feature.** Every escrow, moderation queue,
   grants programme and insurance pool re-implements the same jury logic badly. One protocol
   with a stable interface serves all of them.
2. **Stake-weighted juries are plutocratic.** Every existing jury protocol makes jury capture a
   purchasing decision. Proof-of-personhood gating turns it into a coordination problem instead.
   This is the differentiator and it is only cheaply available on Polkadot.
3. **Generality lives in configuration, not in code.** Apps set their own rules within a
   protocol-enforced safety envelope. Nobody forks the core.

**Non-goals for v1:** a protocol token, cross-chain disputes, on-chain evidence storage,
non-binary rulings beyond a small fixed `K`, reputation systems.

---

## 2. Architecture

```
App layer            Escrow · Moderation · Grants · DAO proposals
                     (each implements IArbitrable)
                              │  createDispute(choices, extraData)
                              ▼  rule(disputeId, ruling)
Interface            IArbitrator / IArbitrable
                              │
Core                 CourtRegistry · JurorRegistry · Sortition
                     VoteBooth · Settlement · Evidence
                              │
Substrate            pallet-revive on Asset Hub  →  pallet-jury on own chain
```

### Configurability tiers

| Tier | What | Who sets it | Failure containment |
|---|---|---|---|
| **Protocol invariants** | randomness, stake custody, max panel, max slash, min activation delay | runtime governance | not configurable |
| **Court parameters** | timings, rates, quorum, ties, fees | app, at registration | validated on-chain, rejected if incoherent |
| **Policy modules** | eligibility, incentive math, fee curves | app, contract address | staticcall + gas cap + fallback to Tier 1 |
| *(escape hatch)* | whole arbitrator | app deploys own `IArbitrator` | loses shared pool, keeps interface |

Design principle: **an app may make its own court worse for itself in a hundred ways, and may
not make the protocol worse for anyone else in any way.** Test every exposed parameter against
that line.

---

## 3. Component inventory

### Contracts (Phase 1–3)

| Contract | Responsibility |
|---|---|
| `ArbitratorCore` | dispute lifecycle FSM, `IArbitrator` impl, ruling delivery |
| `CourtRegistry` | court configs, validation, timelocked updates, court tree |
| `JurorRegistry` | stake, holds, activation delay, unbonding, eligibility checks |
| `Sortition` | seed derivation, VRF verification, seat admission |
| `VoteBooth` | commitments, reveals, tally |
| `Settlement` | reward and slash computation, fee waterfall, pot distribution |
| `Evidence` | evidence metadata events (IPFS CIDs), no storage |
| `policies/*` | `StakeWeightedEligibility`, `PopGatedEligibility`, `LinearIncentive`, `FlatFee` |
| `examples/*` | `SimpleEscrow`, `DaoCallEscrow`, `OptimisticChallenge` |

### Pallet (Phase 4)

`pallet-jury` with the same state machine, plus what contracts cannot do:
ring-VRF verification, `on_initialize` phase transitions, native `fungible::MutateHold` stake,
fee-free `reveal_vote` via a `SignedExtension`, benchmarked weights, offchain worker notifications.

Exposed to Solidity and ink! through one **external precompile** implementing the `IArbitrator`
ABI at a fixed address. Apps keep writing ordinary contracts.

### SDK

TypeScript client: court registration helpers, dispute creation, juror daemon (watch for seats,
compute VRF locally, commit, reveal — with salt persistence, because a lost salt is a slash),
event indexer.

---

## 4. Core mechanisms

### 4.1 Selection

```
stake(courtId, amount)
  → held via MutateHold / escrowed in JurorRegistry
  → not eligible until block + activationDelay        [anti just-in-time staking]

dispute created at B, drawing opens at B + Δ          [Δ ≈ 10–50 blocks]
seed = H(relayRandomness(B+Δ) ‖ disputeId ‖ courtId)  [delayed + mixed, anti-grinding]

weight: k × minStake ⇒ k slots, each independently staked and slashed
```

**Pull-based draw (contracts).** Per slot, juror computes `h = VRF(sk, seed ‖ slotIndex)` locally,
submits a claim only if `h / 2²⁵⁶ < τ` where `τ ≈ 1.3 × panelSize / totalWeight`.
Collect claims for a fixed window, then admit the `panelSize` claims with the **lowest** VRF output.
Not first-come — first-come is a latency race that favours collator-adjacent jurors.
Cost is O(panel), not O(pool). If undersubscribed after the window, lower τ and reopen once.

**Push-based draw (pallet).** Stake-weighted Fenwick tree, `r = H(seed, k) mod totalStake`,
O(log n) walk per seat, executed in `on_initialize`. No juror interaction at all — far better UX.

**Alternates.** Draw `ceil(1.4 × panelSize)`; overflow are backups promoted if a primary
fails to commit. Without this a single absentee can break quorum.

### 4.2 Voting

```
commit:  keccak256(disputeId, juror, choice, salt)   [salt from local keystore]
reveal:  (choice, salt) → verified against commitment
tally:   weighted majority over revealed votes
```

Courts may set `commitRequired = false` for cheap low-stakes votes, accepting bandwagoning.

### 4.3 Settlement

```
pot P = β·s·|incoherent| + γ·s·|silent|

coherent      → + jurorFee + (1−θ)·P / |coherent|
incoherent    → − β·s, forfeits fee
silent        → − γ·s, forfeits fee, reduced draw weight for N periods
tie / no quorum → nobody slashed except the silent
```

Non-reveal costs more than being wrong (`γ > β`): being wrong is a mistake, being silent is a
strategy that both griefs quorum and dodges the coherence lottery.

**Ties and quorum failure carry no slashing for participants.** Punishing jurors for genuine
ambiguity drives away exactly the jurors you want. On quorum failure: slash the silent, refund
revealers with fee, re-draw from the slashed pot, cap at two re-draws, then apply the default.

**Appeals settle per round, independently.** Round `r` panel = `2·n_{r−1} + 1`; higher courts
carry higher `minStake` and `jurorFee`, so cost grows ~2.5× per round. The appellant must fully
fund the next round inside the appeal window; if only one side funds, they win by default.

No retroactive slashing of lower-round jurors on overturn. New evidence appears on appeal, and
a payoff that depends on information the juror could not have had at vote time destroys the
Schelling point. Accepted cost: a captured lower court's jurors still get paid.

---

## 5. Economic calibration

Break-even confidence for a juror:

```
q* = β·s / (β·s + jurorFee + expectedPotShare)
```

Target `q* ≈ 0.5–0.6` so a juror who is better than a coin flip profits in expectation.

Worked example — 7 slots, `s` = 100 DOT, `fee` = 5, `β` = 10%, `γ` = 25%, `θ` = 20%, verdict 5–2:

| | n | per slot |
|---|---|---|
| coherent | 5 | +5 + 0.8×20/5 = **+8.2** |
| incoherent | 2 | **−10** |
| treasury | — | +4 |

`q*` = 10 / 18.2 ≈ **0.55**. Set `β` = 20% with `fee` = 3 instead and `q*` climbs to 0.68 —
honest jurors lose money on hard cases and stop taking them. **When a court needs more security,
raise the fee, not the penalty.** Enforce this at registration:

```solidity
require(atRisk * 10_000 <= upside * MAX_QSTAR_RATIO, "jurors underpaid");
require(cfg.nonRevealBps >= cfg.incoherenceBps);
require(cfg.incoherenceBps <= MAX_SLASH_BPS);
require(cfg.appFeeBps + cfg.protocolFeeBps <= MAX_TAKE_BPS);  // jurors paid first
```

### Config change safety

- **Snapshot `configHash` into the dispute at creation**; settle against the snapshot, never live
  storage. Otherwise an app watches votes arrive and raises slashing before settlement.
- **Timelock ≥ unbondingPeriod**, plus a penalty-free exit window whenever `β`, `γ`, `minStake`
  or the eligibility module changes. A juror who signed up for 10% must never wake up to 25%.
- `stakeAsset` and `eligibilityMode` are **immutable after registration**.

---

## 6. DAO integration surfaces

Ordered by how little the DAO has to change:

| Surface | Mechanism | Use when |
|---|---|---|
| Proxy account | jury sovereign account registered as a governance proxy | day-one demo |
| Origin adapter | `EnsureOrigin` for `JuryApproved<CourtId>` | OpenGov track gating |
| Call escrow | DAO submits bounded `Call` + courtId; dispatched on approve | generic plugin, DAO needs no jury awareness |
| **Optimistic challenge** | token vote passes → challenge window → bonded escalation → jury veto | **the pattern DAOs will actually adopt** |
| XCM binding | `MultiLocation → courtId`, ruling returned as XCM | Phase 5 |

The optimistic challenge layer is the one to lead with. Token voting stays fast for the 95% of
uncontroversial proposals; the jury only ever sees the contested 5%. It composes with plutocratic
voting instead of trying to replace it.

Ship adapters for stacks people actually use: an OpenGov track, an OZ `Governor` veto hook, a Safe module.

---

## 7. Threat model

| Attack | Mitigation | Residual |
|---|---|---|
| Just-in-time staking | activation delay before stake counts | none |
| Collator seed grinding | delayed + mixed seed, VRF self-selection | small |
| Latency race for seats | lowest-VRF-output admission, fixed window | none |
| Unstake to dodge slash | unbonding ≥ max dispute lifetime; drawn stake locked | none |
| Sybil splitting | harmless under stake weight; **fatal under one-person-one-vote** | requires real PoP credential |
| Non-reveal griefing | `γ > β`, alternates, reduced future draw weight | none |
| Malicious `rule` callback | try/catch + `RulingDeliveryFailed` + pull fallback | none |
| Malicious policy module | staticcall, gas cap, output re-validation, Tier-1 fallback | none |
| **Predatory court draining shared pool** | **per-court stake silos in v1** | capital fragmentation |
| Party seats itself on own panel | exclude disputants + declared linked accounts | linked accounts undetectable |
| p+ε bribery | secret panels, unknown size, superlinear appeals; ring-VRF in Phase 4 | **open — document honestly** |
| Whale stake concentration | PoP-gated courts | plutocratic in stake courts by design |

---

## 8. Decisions to close before writing code

These gate the design; resolve them in Phase 0, not mid-build.

1. **Can an Asset Hub contract read People Chain PoP attestations?** If not, v1 needs a
   signed-claim verifier with an attestor set — which is a real trust regression that must be
   documented, not hidden. This gates the entire differentiator.
2. **Is any Bandersnatch / ring-VRF precompile available on Asset Hub?** Almost certainly not.
   Phase 1 therefore uses a secp256k1-based VRF or commit-reveal RANDAO; anonymous panels wait
   for the pallet.
3. **Stake silos or shared pool?** → **Silos.** Getting this backwards is very hard to unwind,
   because unwinding means asking every juror to re-stake.
4. **Stake asset:** DOT-only in v1, app-supplied assets via the ERC-20 assets precompile later.
5. **Protocol token: no.** Fee-based only. A token adds bootstrapping, regulatory and valuation
   problems to a project whose hard part is mechanism design. Revisit after real volume exists.
6. **`K` for non-binary rulings:** cap at 8. Beyond that tie handling and Schelling convergence
   both degrade badly.

---

## 9. Roadmap

### Phase 0 — Decide and specify (1–2 weeks)
Close all six decisions above. Write the interface spec and the FSM. Benchmark VRF verification
cost in contract bytecode on Paseo — if it is prohibitive, the sortition design changes.
**Done when:** interfaces are frozen and the VRF gas number is measured, not estimated.

### Phase 1 — MVP, one court, Paseo (4–6 weeks)
Fixed parameters, no registry. Commit-reveal, pull-based sortition, flat settlement,
`SimpleEscrow` as the only app.
**Done when:** one dispute goes create → draw → commit → reveal → rule → payout on Paseo Asset
Hub, with gas costs recorded per step.

Do not build the configuration system before the resolution loop works. This is the main
temptation of a generic protocol and it is how these projects die.

### Phase 2 — Generality (4–6 weeks)
`CourtRegistry` with Tier-1 parameters and full registration validation. Appeals with the funding
mechanic. Tie and quorum policies. Fee waterfall. Timelocked config updates with exit windows.
Second example app with a deliberately different config.
**Done when:** two apps with materially different court configs share one core and one juror pool,
and a deliberately predatory config is rejected at registration.

### Phase 3 — The differentiator (4 weeks)
`PopGatedEligibility` reading People Chain credentials. Tier-2 policy module plumbing with
containment. TypeScript SDK plus juror daemon. Indexer and a minimal juror dashboard.
**Done when:** a PoP-gated court resolves a dispute one-person-one-vote, and a custom incentive
module runs — including a test where the module reverts and settlement falls back cleanly.

### Phase 4 — Native engine (8–12 weeks)
`pallet-jury` + external precompile on your own parachain, on-demand coretime. Ring-VRF anonymous
panels. Fee-free reveals. `on_initialize` transitions. Push-based sum-tree draw.
**Done when:** feature parity with the contract version, plus a dispute where panel composition
is never revealed even after the ruling.

### Phase 5 — Adoption (ongoing)
Publish `pallet-jury` as a crate other runtimes adopt. DAO adapters. XCM for remote disputes.
Two audits (mechanism design and implementation are separate audits — do not let one firm do both).
Mainnet.

---

## 10. Workspace layout

```
jury-protocol/
├── contracts/
│   ├── src/interfaces/     IArbitrator, IArbitrable, IEligibility,
│   │                       IIncentivePolicy, IFeePolicy
│   ├── src/core/           ArbitratorCore, CourtRegistry, JurorRegistry,
│   │                       Sortition, VoteBooth, Settlement, Evidence
│   ├── src/policies/
│   ├── src/examples/
│   └── test/
├── pallets/pallet-jury/
├── precompile/
├── sdk/                    TS client + juror daemon
├── indexer/
├── sim/                    agent-based economic simulation
└── docs/                   spec, threat model, integration guide
```

---

## 11. Testing strategy

The economics need as much testing as the code.

- **Invariant / property tests (foundry):** settlement never mints; total slashed ≤ ceilings;
  a dispute always reaches a terminal state regardless of module behaviour; no juror loses more
  than their locked slot stake.
- **Fuzz the registry:** random configs in, assert every accepted config satisfies the economic
  invariants and every rejected one violates at least one.
- **Adversarial integration tests:** reverting `rule`, reverting policy module, gas-bomb module,
  all-silent panel, exact-tie panel, unstake attempt mid-dispute, config change mid-dispute.
- **Agent-based simulation (`sim/`):** honest, lazy, and bribed juror populations across a
  parameter sweep. The output you want is the region of `(β, γ, fee, panelSize)` space where
  honest play dominates. Publish it — it is the strongest argument the protocol has.
- **Two independent audits**, mechanism and implementation, by different firms.

---

## 12. What would make this fail

Worth writing on a wall:

- Building the configuration system before one dispute resolves end to end.
- Shipping a shared juror pool with permissionless court creation.
- Setting slashing high and fees low, so good jurors quietly stop taking hard cases.
- Letting app-supplied code sit on the critical path without a fallback.
- Claiming p+ε resistance you do not have.
- Solving cross-chain before solving same-chain.
