# GetCourt — Final Per-File Review Report

Date: 2026-07-21 · Scope: contracts/, sdk/, scripts/, test/ · Basis: verified findings only (confirmed + verification-pass additions; false positives excluded)

---

## 1. VERDICT

**Not sound for deployment.** One CRITICAL (the PoP gate performs no proof verification — sybil for gas) and ~20 HIGHs, including a terminality-breaking core bug (codeless-app delivery revert freezes juror stakes forever), a panel-capture economics bug (post-seed stake top-up bypasses the activation delay), three independent SDK paths that slash honest jurors, and a deploy pipeline that has never actually executed (`const api: any = null` stubs in every script and the SDK client). The core state machine and settlement math are largely correct where tested, but the always-terminal and never-mint invariants are both violated or unverified. Demo-grade at best until the blockers land.

---

## 2. BLOCKERS (CRITICAL / HIGH)

### A. Sybil / proof-of-personhood — the differentiator is hollow

| Loc | Problem | Fix |
|---|---|---|
| `IZKPassportRegistry.sol:7` + `PopGatedEligibility.sol:27` **[CRITICAL, same root cause — counted once]** | The deployed `ZKPassportRegistry` verifies no zk proof on-chain: `submitAttestation` accepts any nonzero `bytes32` from any caller (p2p-market's own docs confirm proof verification is off-chain and unenforced). `isVerified` — the sole PoP gate consumed at `ArbitratorCore.sol:313` — is just "hash != 0". Jury capture = N wallets × gas, exactly the purchasing decision the NatSpec claims to eliminate. | Do not ship the PoP gate against registry v1.0.0 as enforcement. Gate on a registry with on-chain proof verification or a trusted-attester role; otherwise rewrite the NatSpec (both files) to state the real guarantee and treat PoP courts as demo-grade. |
| `IZKPassportRegistry.sol:9` + `PopGatedEligibility.sol:27` **[HIGH, same root — counted once]** | Revoke-and-rebind: `revokeAttestation` frees the `uniqueIdHash` instantly (no cooldown); eligibility is checked only once, at `claimSeat` (`ArbitratorCore.sol:313`, sole call site). One passport serially backs wallets A, B, C within one draw window → multiple seats per panel. | Registry cooldown > drawWindow + dispute lifetime, and/or court-side per-panel `uniqueIdHash` dedup (requires adding `getAttestation` to the interface — see §4). |

### B. Terminality invariant broken

| Loc | Problem | Fix |
|---|---|---|
| `ArbitratorCore.sol:626` + `IArbitrable.sol:9` **[HIGH, same bug — counted once]** | `try IArbitrable(d.app).rule(...)` — solc 0.8.28 emits an extcodesize check that `revert(0,0)`s **before** the CALL and outside the catch (empirically verified with the repo's exact toolchain). `createDispute` (line 280) accepts EOA callers. Both `finalize` branches (lines 440, 449) funnel through `_deliver`, so a codeless app makes the dispute permanently non-terminal: up to 21 × minStake of honest juror stake + the fee pot frozen forever. Attacker cost: one arbitrationCost. `redeliverRuling` can't rescue (requires Resolved). | Both: (1) `if (msg.sender.code.length == 0) revert AppNotContract()` in `createDispute`; (2) make `_deliver` revert-proof via low-level `d.app.call(abi.encodeCall(...))` (verified: succeeds against codeless address) — mandatory since contracts can be destroyed post-creation. |

### C. Panel capture economics

| Loc | Problem | Fix |
|---|---|---|
| `ArbitratorCore.sol:220` **[HIGH]** | `stake()` sets `activeAt` only on the 0→nonzero transition; top-ups activate instantly. An already-active juror reads the public post-draw seed, computes which slots self-select, then tops up in-window to cover exactly those slots — deploying capital *after* seeing the seed. Defeats the anti-JIT delay; can fill up to drawTarget (≤21) seats. | Apply activation delay to every `stake()` call, or snapshot eligible weight at `drawBlock` (only stake activated before drawBlock counts). |

### D. Registry provenance

| Loc | Problem | Fix |
|---|---|---|
| `CourtRegistry.sol:87` **[HIGH]** | `registerCourt` trusts self-reported `eligibility()` / `configHash()` only. Any contract returning a matching `configHash` and nonzero eligibility is recorded `active:true` with a legit `CourtRegistered` event — `configHash` proves knowledge of a config, not execution of ArbitratorCore code. Apps routing fees via `courtArbitrator` can be sent to a fee-stealing / never-terminal contract. | Bind trust to provenance: track factory deployments (`_deployedHere` set in `createCourt`) and require it, or drop `registerCourt` for Phase 2. EXTCODEHASH won't work (immutables differ per deploy). Record external courts `verified:false` if they must stay admissible. |

### E. Example app strands & freezes funds

| Loc | Problem | Fix |
|---|---|---|
| `SimpleEscrow.sol:97` **[HIGH]** | `rule()` push-pays via `_pay` which reverts on failure; a payer names a reverting payee at `fund()` → RELEASE ruling reverts, rolls back to Disputed, every `redeliverRuling` re-fails, dispute never terminates at app layer. Directly contradicts the core's own pull-withdraw rationale, in the flagship example integrators copy. | Credit winner to `pendingWithdrawals` + add `withdraw()` (pull), or on `_pay` failure fall back to crediting so `rule()` always succeeds. Apply to `release()` too. |
| `SimpleEscrow.sol:13` **[MEDIUM→ blocker-adjacent, fund loss]** | Arbitration-fee refunds/appCut credited to the escrow's pull balance in the core (lines 439/596/601) are permanently stranded: `core.withdraw()` pays only `msg.sender`, SimpleEscrow has no function that calls it, no `receive()`, and `IArbitrator` doesn't even expose `withdraw()`. Value lost on **every** refund path. Test `ArbitratorCore.spec.ts:137` and `Phase2.spec.ts:254` codify the stranding as "correct". | Add `claimFees()` calling `arbitrator.withdraw()`, a `receive()` restricted to the arbitrator, and account recovered fees to the fee-payer via pull-withdraw. |

### F. SDK — three independent honest-juror-slash paths + a broken transport

| Loc | Problem | Fix |
|---|---|---|
| `client.ts:72` **[HIGH]** | `read()` checks `result.success` but never the REVERT flag. On a contract revert, `success` is true, `flags & 1` is set, and `data` holds error bytes fed straight into `decodeFunctionResult` → throws/mis-decodes. Affects every arbitrator read. Inherited from p2p-market. | After the success check: `if (res.result.value.flags & 1) throw ...parseError(data)` before decoding. |
| `arbitrator.ts:286` **[HIGH]** | `commitVote()` hashes the caller-supplied `juror`, but the contract binds the commitment to `msg.sender` (`ArbitratorCore.sol:418`). A wrong/mismatched H160 → commit succeeds, reveal is permanently impossible, honest operator eats gammaBps. Silent, unrecoverable. | Pre-flight: read `jurorRoundOf(disputeId, juror)`, throw if `seatCount==0`; normalize with `getAddress`; long-term derive H160 from the signer. |
| `signer.ts:30` **[HIGH]** | Signer exposes only the sr25519 pubkey; no H160 derivation and no signer↔`juror` consistency check. A mismatched `juror` (daemon.ts:39) → either silent non-participation (liveness) or unrevealable commitment + gammaBps slash. | Export `evmAddress(publicKey)` (keccak256(pubkey)[12..], matches pallet-revive fallback), derive `juror` from the signer by default, throw on mismatch. |
| `daemon.ts:239` **[HIGH]** | Idempotent-revert filter is **dead code**: it matches Solidity custom-error *names* against a pallet-revive `ContractReverted` Module error that never contains them. So every benign revert rethrows — a benign `claimSeat` revert throws past `idempotent()` and skips the `tryCloseDrawing` crank. | Dry-run via `ReviveApi.call` + `iface.parseError()` for the real error name, or match the `ContractReverted` shape and confirm state via read-back. |
| `daemon.ts:174` + `keystore.ts:57` **[HIGH ×2, one root — salt clobber]** | `tryCommit` unconditionally `generateSalt()` + `saveSalt()` (overwrites). On restart mid-in-flight-commit (`jr.committed==false`), a fresh salt overwrites the one matching the landed on-chain commitment → `revealVote` can never pass the keccak check → gammaBps slash. `keystore.ts` header claims this race is supported. | `const salt = loadSalt(id) ?? generateSalt()`, save only if none existed; make keystore append-only per dispute (salts keyed by commitment). |
| `keystore.ts:42` **[HIGH]** | `read()` bare-`catch` swallows every error (EACCES, parse, EBUSY) and returns empty; next `saveSalt` writes a file containing only the new salt → **all other pending disputes' salts destroyed** → gammaBps slash each. | Return empty only on ENOENT; on parse failure rename to `.corrupt` and log loudly; rethrow other IO errors. |
| `keystore.ts:51` **[HIGH]** | Non-atomic `writeFileSync` (no temp+rename, no fsync). Crash mid-write → truncated JSON → next read's catch-all wipes all salts. | Temp file (mode 0600) + fsync + atomic `renameSync`. |

### G. Test suite — settlement invariants unpinned

| Loc | Problem | Fix |
|---|---|---|
| `ArbitratorCore.spec.ts:118` / `Phase2.spec.ts:151` **[HIGH, same gap]** | The never-mint conservation invariant is asserted **nowhere**: no test checks `balance(core) == Σ withdrawable + Σ staked` post-finalize. An over-credit bug would mint claims and pass every existing assertion. | Shared helper asserting balance == sum of all withdrawables + all staked, called at the end of every settlement test. |
| `ArbitratorCore.spec.ts:81` / `Phase2.spec.ts:155` **[HIGH, same gap]** | Beta (incoherent-reveal) slash never exercised — every juror votes choice 1 suite-wide. `_settle:566`'s beta arm and the coherent-majority pot split are untested; swapping beta/gamma passes CI. | Split-vote test (2× choice 1, 1× choice 2); pin exact withdrawables and pot/treasury split. |
| `ArbitratorCore.spec.ts:47` / `Phase2.spec.ts:5` **[HIGH, same gap]** | Tie / no-quorum terminal path (`_tally` ruling 0, `_settle` `coherentSeats==0`) untested — the documented "tie slashes honest revealers" design question is pinned by nothing and could regress or break conservation silently. | 1-1-1 tie and below-quorum cases; assert beta-slashed revealers, app refund `cost - protocolCut`, treasury `protocolCut + pot`, `disputeState==4`. |

---

## 3. BY FILE

| File | C | H | M | L | Info | One-line health |
|---|---|---|---|---|---|---|
| `interfaces/IArbitrator.sol` | | | 1 | 3 | 2 | Under-specified seam: no enum, no events, ERC-792 selector drift — all documentation/API hygiene. |
| `interfaces/IArbitrable.sol` | | 1 | 1 | | 1 | Delivery-failure guarantee is false for codeless apps → terminality break. |
| `interfaces/IEligibility.sol` | | | 1 | 2 | | Context-free eligibility enables lazy passport binding; no deploy-time wiring probe. |
| `interfaces/IZKPassportRegistry.sol` | **1** | 1 | 2 | | | PoP guarantee is false against the deployed registry — the headline blocker. |
| `core/ArbitratorCore.sol` | | 2 | 1 | 4 | 1 | Sound state machine, but codeless-delivery freeze + post-seed capture are serious; several config/loop footguns. |
| `core/CourtRegistry.sol` | | 1 | 2 | 3 | 1 | Spoofable registration; validateConfig drifts from constructor; dead `active`/`NotACourt`. |
| `policies/PopGatedEligibility.sol` | **1** | 1 | 1 | 1 | 1 | Hollow sybil gate + revoke-rebind; zero coverage. |
| `policies/StakeWeightedEligibility.sol` | | | | 1 | 2 | Weight math sound; "sybil-harmless" overclaim; misleading name (no-op policy). |
| `examples/SimpleEscrow.sol` | | 1 | 1 | 3 | 3 | Push-pay freeze + stranded fee refunds contradict the pull-withdraw model it demonstrates. |
| `sdk/src/client.ts` | | 1 | 4 | 2 | 1 | Revert flag ignored; blockHash-as-txHash; `api=null` stub; no dry-run; no tests. |
| `sdk/src/signer.ts` | | 1 | 2 | 1 | 1 | No H160 derivation, no account mapping — silent wrong-identity slashes. |
| `sdk/src/arbitrator.ts` | | 1 | 4 | 2 | 1 | Caller-supplied juror hashing → unrevealable commits; drawSeed zero-check gap; no redeliver. |
| `sdk/src/keystore.ts` | | 3 | 4 | 4 | | Every slash-critical path (atomicity, overwrite, error-swallow, namespacing) defective. |
| `sdk/src/daemon.ts` | | 2 | 4 | 3 | 2 | Dead revert filter, salt clobber, fee-burn cranks, unbounded sweep. |
| `sdk/src/index.ts` | | | 1 | 1 | 3 | Barrel doc drift (VRF vs keccak, wrong method names); no SDK tests. |
| `scripts/deploy.ts` | | 1 | 2 | 3 | 2 | Unmapped treasury H160 → locked cut; `api=null` — script never ran. |
| `scripts/deploy-pop-court.ts` | | 1 | 1 | 5 | 3 | EVM-vs-PVM artifact mismatch; unvalidated registry; duplicated harness. |
| `test/ArbitratorCore.spec.ts` | | 3 | 4 | 3 | | Happy-path only; conservation, beta, tie, withdraw all unpinned. |
| `test/Phase2.spec.ts` | | 1 | 5 | 5 | 1 | Codifies fund-stranding as correct; PoP gate, tie branch, withdraw untested. |

Counts are verified findings per file (confirmed + missed; falsePositives excluded). Cross-file duplicates (e.g. the PopGated/registry pair, the IArbitrable/core delivery bug) are counted in each file where they surface but collapsed in §2.

---

## 4. CROSS-FILE / SYSTEMIC

**S1 — PoP gate is hollow end-to-end (CRITICAL).** `IZKPassportRegistry.sol` NatSpec → `PopGatedEligibility.sol:27` → `ArbitratorCore.sol:313`, all resting on a registry with no on-chain proof verification. This is one systemic failure surfaced in three files; the interface, the policy, and the deploy script (`deploy-pop-court.ts:152`, unvalidated registry address) all inherit it. Fix at the registry/architecture level, not per-file.

**S2 — Codeless-app delivery freeze (HIGH).** `IArbitrable.sol:9` promises try/catch re-delivery; `ArbitratorCore.sol:626` cannot honor it for codeless apps (pre-CALL extcodesize revert). One bug, two files. Breaks the always-terminal invariant.

**S3 — Eligibility is a single point-in-time check with no context.** `IEligibility.isEligible(address)` carries no dispute/block context and is sampled once at `claimSeat`. This is the shared root of: post-seed stake top-up (`ArbitratorCore.sol:220`), lazy passport binding (`IEligibility.sol`), and revoke-rebind (`IZKPassportRegistry.sol:9`). Because `eligibility` is immutable (`ArbitratorCore.sol:82`), hardening requires an interface change (`isEligibleAt(addr, block)`) **and** a redeploy — cheap now, impossible after launch. Add `getAttestation` to `IZKPassportRegistry` in the same change (both funcs already exist on-chain).

**S4 — SDK ↔ contract identity drift is the dominant slash vector.** `signer.ts` (no H160 derivation) → `daemon.ts` (unchecked `juror` arg) → `arbitrator.ts:286` (hashes that arg) → `ArbitratorCore.sol:418` (verifies `msg.sender`). Any drift silently produces an unrevealable commitment and a gammaBps slash. There is no single place that derives the juror H160 from the signing key; every layer trusts the layer above. This is the systemic version of the three separate HIGHs in §2.F.

**S5 — Config validation drift: `CourtRegistry.validateConfig` vs `ArbitratorCore` constructor.** The registry advertises a dry-run "these are exactly the guards the core enforces" (line 50) but omits three: `drawDelayBlocks==0`, `drawWindowBlocks==0||>255` (the prior-audit HIGH fix), `gammaBps==0` (the prior-audit gamma>0 fix). Separately, **neither** validates `commitBlocks`/`revealBlocks`/`activationDelayBlocks==0` — a zero reveal window slashes every juror every dispute. A parity test (`validateConfig` succeeds iff `new ArbitratorCore` succeeds) would pin this permanently.

**S6 — ABI/type drift, SDK ↔ contracts, entirely unpinned.** `arbitrator.ts` `computeCommitment` (line 322) and `slotSelects` (line 338) hand-mirror the contract's `abi.encodePacked` layouts; `client.ts`/`index.ts` mirror function selectors and the DisputeState magic numbers. Nothing pins any of it — no selector test, no preimage round-trip, no shared enum (DisputeState lives only in `ArbitratorCore.sol:59`, tests hard-code 1..4). Any field-order/width/selector change keeps both sides compiling while every daemon commit becomes unrevealable. Move `DisputeState` into `IArbitrator`, add a selector-pinning test, and a preimage round-trip through the deployed contract.

**S7 — `withdraw()` pays only `msg.sender`, but contract-account payees can't call it.** `ArbitratorCore.withdraw()` + `SimpleEscrow` (no claim fn, no receive) + `IArbitrator` (no `withdraw` in interface) → app-owed fees permanently stranded. Systemic mismatch between the pull-withdraw model and integration surface; the tests codify it as correct.

**S8 — Deploy pipeline has never executed.** `scripts/deploy.ts:180`, `scripts/deploy-pop-court.ts:158`, and `sdk/src/client.ts:43` all contain `const api: any = null` (descriptor import commented out pending `papi add`). The whole write path — deploy and daemon — is untested against a real descriptor. Plus EVM-vs-PVM artifact mismatch (`deploy-pop-court.ts:106`: on-disk artifacts are EVM `0x60…`, chain target is PVM) and the unmapped-treasury-H160 locked-cut risk (`deploy.ts:70`). The `dest`-as-Binary and `weight_limit` field names are correct **for pinned papi v1** but are version-drift landmines on a v2 upgrade.

**Duplicate findings collapsed:** the SDK "zero tests" test-gap is reported once per SDK file (`client.ts:1`, `signer.ts:22`, `arbitrator.ts:322`, `keystore.ts:1`, `daemon.ts:1`, `index.ts:1`) — it is one gap: the SDK package defines no test script and has no test dir. The keystore atomicity/clobber/error-swallow trio is reported from both `keystore.ts` and `daemon.ts:175` (missed) — same root. The "blockHash labelled as txHash" appears in both `client.ts:102` and `daemon.ts:236` — one bug, fix in `client.ts`.

---

## 5. MEDIUM / LOW BACKLOG (terse)

Contracts:
- `ArbitratorCore.sol:323` — `claimSeat` weight loop unbounded → self-DoS above block gas; `uint16(k)` truncates so slots ≥65536 never self-select. Cap weight to MAX_SLOTS or add range params.
- `ArbitratorCore.sol:190` — constructor never validates `commitBlocks`/`revealBlocks`/`activationDelayBlocks==0` (see S5).
- `ArbitratorCore.sol:285` — per-dispute `configHash` is dead weight (always the immutable value; settlement reads live `config`). Snapshot real params or drop the field + misleading comment.
- `ArbitratorCore.sol:347` — `SeatGranted` emits dispute-wide count in a per-juror field; redundant with `SeatClaimed`. Fix or delete.
- `ArbitratorCore.sol:369` — `closeDrawing` reverts `PanelFull()` when panel is **not** full (undersubscribed). Add `Undersubscribed()`.
- `ArbitratorCore.sol:687` / `drawSeed()` — no zero-blockhash check (view diverges from claim path); daemon burns gas on garbage seed.
- `CourtRegistry.sol:98/31/94` — no per-arbitrator uniqueness (shadow-registration); dead `active` field + `NotACourt` error; double `configHash()` staticcall (check-then-use).
- `IEligibility.sol` — no ERC-165 / deploy-time probe; EOA/wrong wiring → permanent court-wide DoS surfaced only at first claim.
- `SimpleEscrow.sol` — reorder struct to pack `state` (saves a slot); accept `msg.value>=cost` + refund surplus; state-before-external-call ordering (defense-in-depth); no timeout/mutual-settle (payer can vanish); tie-favors-payer asymmetry undocumented.
- `StakeWeightedEligibility.sol` — rename to `OpenEligibility` (no-op policy); NatSpec "sybil-splitting harmless" is weight-only, not identity.

SDK:
- `client.ts` — hardcoded weight/storage-deposit constants, no dry-run (loop-heavy calls can exceed ceiling → daemon retry never succeeds → slash); `h160()` no address validation; `0x`-return treated as "function missing" (wrong for no-output views); `dest`-as-Binary + no signAndSubmit timeout/mortality (v2 drift + hang risk).
- `arbitrator.ts` — `createDispute` defaults `feeValue=0n` → guaranteed WrongFee; no `redeliverRuling` exposed; `anySlotSelects` throws at k=65536 (should clamp); `revealVote`/`createDispute` no pre-flight and no returned disputeId (racy).
- `keystore.ts` — bare-id key (no chain/arbitrator/juror namespace → collisions across redeploys); cwd-relative default path (systemd/cron → empty store); no advisory lock (concurrent writers); `mode:0600` ignored on existing files; `bigint|number` key notation divergence ≥1e21; version field ignored (silent downgrade); transient IO misreported as "salt lost".
- `daemon.ts` — cranks + claimSeat submitted unconditionally each 12s sweep → fee burn (no deadline/activation/eligibility precheck); `DrawClosed`/`TooEarly` in idempotent list hides real slashes; unbounded O(historical disputes) sweep; non-integer choice accepted → opaque encoding error + stray salt; default `abstainDecision` still claims seats → guaranteed slash; dead `ZERO32`.
- `signer.ts` — no `map_account` anywhere (AccountUnmapped or funds to keyless fallback); path-string not validated (`/x` vs `//x`); header claims keystore key support that doesn't exist.
- `index.ts` — header says "VRF" (it's keccak sortition); lists nonexistent `readDispute`/`readRuling`; `generateSalt` exported without persist coupling.

Scripts:
- `deploy.ts` — `api:null` stub + error message points at wrong line; event-address `?? ` fallback returns raw object past the guard; `Date.now()` salt (predictable/collidable); no balance pre-check/dry-run; no `deployments/*.json` + no read-back; EVM-vs-PVM latent; `pnpm deploy` shadowed by pnpm built-in (use `pnpm run deploy`).
- `deploy-pop-court.ts` — EVM artifact submitted to PVM target (HIGH-adjacent); unvalidated registry address; `api:null`; bigint-unsafe error stringify; `Date.now()` salt; no persisted output/read-back; undocumented near-max `drawThreshold` (everyone self-selects → fastest-bot panel); duplicated harness (extract to `scripts/lib/`).

---

## 6. TEST GAPS

Repo has two Hardhat/TS suites (`ArbitratorCore.spec.ts`, `Phase2.spec.ts`); **the SDK has no test script and no test directory at all.**

Highest priority (invariant-level):
- **Never-mint conservation** — assert `balance(core) == Σ withdrawable + Σ staked` after every finalize. Currently asserted nowhere.
- **Beta slash** (revealed-but-incoherent) — every test votes choice 1; the beta arm and coherent-majority pot split are unexercised.
- **Tie / no-quorum** — the documented honest-revealer-slash branch (`_settle` `coherentSeats==0`) is pinned by nothing.
- **`withdraw()` itself** — never called suite-wide; only the `withdrawable` view is read. Zeroing order, double-withdraw (`NothingToWithdraw`), `_pay` to a contract recipient all unexercised.

Path coverage:
- **PoP gate** — `PopGatedEligibility`, `ZKPassportRegistry`, and any mock registry have zero coverage; the `NotEligible` path is never hit with a false return. Add a `MockZKPassportRegistry`: unverified rejected, verified admitted, revoke-mid-dispute, codeless-registry-still-terminates-via-timeout, `ZeroRegistry` constructor revert.
- **Ruling-delivery failure / `redeliverRuling`** — no `RevertingApp` fixture; the try/catch, `RulingDeliveryFailed`, `ruled` flag, and the audit-fixed `noReentrant` redeliver path are untested. Include the EOA-created-dispute terminality case (pins the §2.B HIGH).
- **Core revert paths** — none in `ArbitratorCore.spec.ts`: early `claimSeat` (TooEarly, the audit-CRITICAL strict-open guard), late commit, wrong-salt/double reveal, early finalize, double-finalize (WrongState), undersubscribed `closeDrawing`. The prior audit's fixes have no regression tests.
- **`unstake()` + activation delay** — `unstake` never called; every fixture sets `activationDelayBlocks:0`, so the anti-JIT gate is never exercised.
- **`validateConfig` ↔ constructor parity** (S5) — fuzz all fields; assert equivalence.
- **Undersubscribed terminal assertions** — `ArbitratorCore.spec.ts:137` checks the refund but not `disputeState==4` / escrow `Resolved`.
- **App-self-exclusion** (`msg.sender==d.app`), `courtArbitrator` unknown-id, duplicate/EOA `registerCourt`.

SDK (all currently zero):
- Transport: `read()` rejects on REVERT flag and surfaces the decoded error; `write()` returns `r.txHash` not `r.block.hash`; `0x`-handling for no-output views; ABI encode/decode round-trips.
- Keystore: corrupted-file must **not** be wiped by a later save; ENOENT vs EACCES; atomic write survives crash; overwrite-vs-append; 0600 tightening; bigint/number key round-trip incl. ≥1e21 boundary.
- Daemon: `recoverChoice` round-trip vs `computeCommitment`; salt-persisted-before-submit ordering; salt reuse across restart (the clobber scenario); revert-filter behavior; cranks not submitted before deadlines.
- Signer: known-answer `deriveKeypair('//Alice')` pubkey, sign/verify round-trip, pinned H160.
- **SDK↔contract preimage/selector pinning** (S6) — round-trip `computeCommitment` through the deployed contract's commit/reveal; fuzz `slotSelects` against actual `claimSeat` admission / `SeatClaimed.vrfOutput`; selector-pin the four `IArbitrator` functions.