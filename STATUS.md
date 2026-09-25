# Build status

Standalone repo. **No git / no PR / no issues** until the user instructs (they will do it later).

## Decisions locked
- PoP source = reuse on-chain `ZKPassportRegistry.isVerified()` (same-chain read; dissolves the
  cross-chain People Chain blocker).
- Standalone `opencourt` repo (tooling copied from p2p-market).
- v1 depth = **Phase-1 MVP → then SDK** → then generality (registry / appeals).
- SDK = standalone PAPI (headless juror daemon).
- Toolchain = Solidity 0.8.28 + viaIR + `@parity/hardhat-polkadot` (resolc → PolkaVM), OZ ^5,
  deploy via PAPI + sr25519 mnemonic (the funded wallet is SS58).

## Phase-1 MVP scope (the "build the DAO" deliverable)
One hardcoded court; no registry / appeals / policy-module tiers beyond the two eligibility policies.
Contracts: `interfaces/{IArbitrator,IArbitrable,IEligibility}`, `core/ArbitratorCore`
(FSM + stake escrow + ecrecover-VRF sortition + commit/reveal vote booth + settlement),
`policies/{PopGatedEligibility,StakeWeightedEligibility}`, `examples/SimpleEscrow`.

Done when one dispute runs create → draw → commit → reveal → rule → payout on Paseo, gas per step recorded.

## Progress
- [x] Repo scaffold (package.json, hardhat.config, tsconfig, solhint, download-binaries, .env, .gitignore)
- [x] Phase-1 contracts: interfaces (IArbitrator/IArbitrable/IEligibility/IZKPassportRegistry),
      ArbitratorCore (FSM + stake escrow + hash sortition + commit/reveal + settlement),
      PopGatedEligibility + StakeWeightedEligibility, SimpleEscrow example
- [x] **Compiles clean** (solc 0.8.28, viaIR, optimizer 200 — 8 files)
- [x] **Full resolution loop test passes** (fund → dispute → stake → draw → commit → reveal →
      finalize → rule → payout) + undersubscribed-refund terminal path
- [x] `scripts/deploy.ts` (PAPI + sr25519 mnemonic, args-in-bytecode)
- [x] SDK transport core (`sdk/`: signer + generic ContractClient)
- [ ] resolc/PolkaVM compile + deploy to Paseo (needs `bin/resolc` + `papi add paseohub`)
- [ ] Real PolkaVM gas benchmark on Paseo (below numbers are EVM estimates)
- [ ] SDK app/juror helpers + headless juror daemon (salt persistence)
- [ ] Foundry invariant suite

## Gas (EVM estimate, local — PolkaVM weights differ; real bench pending on Paseo)
stake 72k · claimSeat 130k · commitVote 52k · revealVote 50k · openReveal 36k · finalize 138k (max 182k)
· escrow.fund 135k · escrow.dispute 189k · ArbitratorCore deploy 1.99M (11.9% of block)

## Key design decision (validated against the fable design)
Sortition = **keccak(seed, juror) < drawThreshold**, NOT ecrecover-VRF. The fable design used
ecrecover but flagged (a) ECDSA malleability lets a juror grind a lower VRF output, and (b) it
requires secp256k1 senders — the SDK juror daemon uses **sr25519/SS58** accounts with no matching
secp256k1 key, so ecrecover would break for it. Hash sortition is account-agnostic and still
anti-grind (seed anchors to a future blockhash). Secret/ring-VRF is a pallet-era refinement.

## Phase-2 backlog (distilled from docs/phase2-fable-design.json)
- k-slot weighting (stake/minStake independently-slashed slots) — MVP is 1 slot/juror.
- Alternates promotion (draw ceil(1.4×panel); backups replace non-committers) — MVP breaks quorum on absentees.
- Re-draw attempts on undersubscription before applying the default — MVP refunds immediately.
- Gross-up fee math (appFeeBps/protocolFeeBps, jurors paid first) — MVP takes no protocol fee.
- `submitEvidence` events (CID-only, no storage) — MVP passes evidence via app/Bulletin off-path.
- CourtRegistry + appeals + timelocked config (Phase 2 generality).
- Secret VRF sortition via `pallet-jury` (Phase 4).

## Phase-2 — DONE (3-agent parallel build + combine, all green)
- [x] submitEvidence event · alternates promotion · k-slot weighting · gross-up fees · CourtRegistry
- [x] Appeals — DEFERRED (needs multi-round subsystem; clean next seam)
- [x] Security review applied (from the audit agent):
      - CRITICAL: sortition seed predictable at draw-open → `block.number > drawBlock` (strict) + reject zero blockhash
      - HIGH: `drawWindowBlocks ∈ [1,255]` + `drawDelayBlocks ≥ 1` so the seed hash is always live
      - MEDIUM: `redeliverRuling` now `noReentrant` (no double `rule()` delivery)
      - LOW: `gammaBps > 0` (silence always penalized)
      - Audit-verified invariants: never mints, never over-slashes (≤50%), always terminal, no stake double-spend
- [x] SDK reconciled to the Phase-2 ABI: `arbitrator.ts` (jurorRoundOf/getSeats/closeDrawing/weightOf/
      per-slot self-select), `daemon.ts` (closeDrawing crank), deploy scripts (fee fields)
- [x] **Full tree green**: `hardhat test` 9 passing · root `tsc` clean · sdk `tsc` clean

## Round-1 review incorporated + appeals done (all green: 15 passing · both tsc clean)
- Review (fable, 39 agents) → `docs/review-round1.md`. Blockers fixed:
  - Terminality freeze (EOA-app `AppNotContract` guard + revert-proof low-level `_deliver`)
  - Panel-capture (activation re-armed on every `stake`)
  - Honest PoP NatSpec (presence-only gate, demo-grade, revoke-rebind documented)
  - `SimpleEscrow` → pull-payment + `claimFees`; `IArbitrator.withdraw`; `CourtRegistry.verified`; config-validation parity
  - SDK: revert-flag check, H160 derivation (`evmAddress`), `commitVote` pre-flight, atomic/namespaced keystore, daemon state-read-back submit (no salt clobber, no fee-burn)
  - Tests: never-mint conservation, beta slash, tie/no-quorum, PoP mock, EOA-terminality
- **Appeals (was the deferred item) — DONE** via `contracts/core/AppealCoordinator.sol`: a compositional
  IArbitrator+IArbitrable layer over an ordered list of courts (bigger panel per round), gated by
  `appealWindowBlocks`, revert-proof final delivery. ZERO changes to `ArbitratorCore` (kept the 13 green
  tests + all fixes intact). `test/Appeals.spec.ts`: full appeal chain + no-appeal finalize.

## PRD gap-close: FR-ST-02 + FR-CR-02 — DONE (29 passing · root tsc clean · sdk tsc clean)
- **Round-1 audit MEDIUM #4 ("honest revealers are slashed on a genuine tie / no quorum") —
  RESOLVED.** It is no longer an open item; the fix and its coverage are below.
- **FR-ST-02 / FR-ST-03 — no-verdict settlement fixed** (was audit MEDIUM #4, previously
  "left as-is"). `ArbitratorCore._settle` now pays every seat whose juror REVEALED when
  `ruling == 0` (genuine tie, quorum failure, empty reveal): full slot stake + `jurorFee`
  + pot share, no slash. Only silence is penalised (gamma) — SEATED-but-never-revealed and
  ROLE_SILENT primaries. The pot on a no-verdict settlement is therefore gamma slashes only.
  The beta arm is now reachable ONLY for a revealed-but-wrong seat under a real verdict.
- **FR-CR-02 — q\* underpayment guard added** to the `ArbitratorCore` constructor AND
  `CourtRegistry.validateConfig` (byte-identical expressions — validation parity):
  `q* = atRisk / (atRisk + jurorFee + expectedPotShare) <= 0.60` (`MAX_QSTAR_RATIO = 6000`),
  with `incoherent = panelSize / 3` (spec's one-third-dissent model), all terms scaled by BPS
  and compared cross-multiplied so a sub-unit pot share cannot truncate to zero. Reverts
  `BadConfig("jurorsUnderpaid")`. Reproduces spec §7's worked numbers exactly (panel 7 /
  f 5 / beta 10% -> q* 0.549 accepted; panel 7 / f 3 / beta 20% -> q* 0.68 rejected). Every
  existing court config (panel 3 and 7, s 100, f 10, beta 10%, theta 20% -> q* 0.417/0.431)
  still passes. Neither change touches the ABI, so the SDK needed no edit.
- Coverage: `test/NoVerdictSettlement.spec.ts` (per-seat waterfall for tie / quorum failure /
  zero-reveal, RELEASED alternates, ROLE_SILENT, q\* worked examples, core-vs-registry parity)
  + the reworked tie tests in `test/Hardening.spec.ts`. **29 passing**, every settlement test
  followed by the never-mint conservation assert.

## Known defect — deferred to the appeals feature (NOT Feature 1)
- `AppealCoordinator.reclaimFees(coordId, courtIndex)` (`contracts/core/AppealCoordinator.sol:202-209`)
  calls `courts[courtIndex].withdraw()`, which pays out the coordinator's ENTIRE credited balance in
  that court, then credits all of it to `_disputes[coordId].app`. Two coordinator disputes sharing a
  court (every dispute shares `courts[0]`) therefore let the first caller route the other dispute's
  fee residue to the wrong app; the loser's `reclaimFees` then reverts `NothingToWithdraw`.
  Pre-existing — independent of the FR-ST-02 change, which only alters the SIZE of the residue.
  Belongs to **FR-AP-02 / FR-ST-04 at the coordinator layer** (per-dispute fee accounting: snapshot
  the expected refund per `childId` and credit only that, or settle on the court's `rule()` callback).

## LIVE ON PASEO ASSET HUB NEXT (PolkaVM) — Feature 1 proven on chain

Deployed with resolc 0.6.0 -> PolkaVM, via PAPI + the sr25519 deployer. Addresses and the
full record live in `deployments/paseo-asset-hub-next.json`.

- Canonical court: `ArbitratorCore 0xd4594022d6a1344b8b5b9a603132ba471e4e7db8`,
  `SimpleEscrow 0x40c58fb8633d4cd85fcb6b2ad989d0622554006e`,
  `StakeWeightedEligibility 0xe32d6bdc699d367867c4c882d0f339a71e07ee56`.
  Config read back from chain: minStake 100 PAS, jurorFee 10 PAS, arbitrationCost 30 PAS, panel 3.
- **FR-ST-02 proven live** (`scripts/demo-feature1-live.ts`): a genuine 1-1 tie with one silent
  juror settled as `ruling 0, tied true` with exactly ONE `Slashed` event. Both revealers were paid
  **120 PAS** (100 stake + 10 fee + 10 pot share) and neither was slashed; the silent juror took the
  gamma 25% and kept 75 PAS; app residue 10 PAS; treasury 5 PAS. Before this feature each revealer
  would have received 90 PAS.
- **FR-CR-02 proven live**: the spec's underpaid court (panel 7, fee 3, beta 20% -> q* 0.68) is
  rejected on chain with `BadConfig("jurorsUnderpaid")`, and the deployed court exists only because
  its q* 0.4167 passed the constructor guard.

### Chain-level facts learned (all verified, none assumed)
- `Revive.instantiate_with_code` / `Revive.call` take **`weight_limit`**, not `gas_limit`.
- Constructor args go in **`data`**; `code` is the untouched PolkaVM blob. Appending args to the blob
  (the older revive pattern copied from p2p-market) is rejected as `Revive::CodeRejected`.
- Contract-side value is in **1e18 EVM decimals** while extrinsic value is in **1e10 planck** —
  divide by 1e8. A config written in planck makes a "100 PAS" stake worth 0.000001 PAS.
- `ReviveApi.upload_code` accepted the 126,233-byte `ArbitratorCore` blob (deposit 16.6 PAS), so blob
  size was never the constraint.
- A contract revert is a SUCCESSFUL dispatch whose return flags have bit 0 set; the payload is the
  custom-error selector.
- Block time is ~2s and `signAndSubmit` waits for finalization (~12 blocks per extrinsic), so phase
  windows must be sized for that.

## Still open (needs network/CLI, not code)
- Real PolkaVM gas benchmark on Paseo (numbers above are EVM estimates).
- Appeals (multi-round) — the contract layer is DONE (`AppealCoordinator`); what remains is the
  per-dispute fee accounting above plus the FR-DL-04 `final` flag and FR-AP-02 funding policy.
