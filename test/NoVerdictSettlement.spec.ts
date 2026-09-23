import { expect } from 'chai';
import { ethers } from 'hardhat';
import { mine } from '@nomicfoundation/hardhat-network-helpers';
import { assertConservation } from './helpers';

// PRD gap-close coverage.
//
//   FR-ST-02 / FR-ST-03 — a settlement that carries NO verdict (a genuine tie, a
//   quorum failure, or an empty reveal) must never slash a juror who showed up and
//   voted. Only SILENCE is slashed. Every case below pins the exact per-seat
//   waterfall the PRD §5.9 specifies:
//       ROLE_RELEASED (alternate never needed) -> slot stake back, NO fee
//       ROLE_SEATED   + revealed               -> slot stake + jurorFee + pot share
//       ROLE_SEATED   + silent at reveal       -> gamma slash
//       ROLE_SILENT   (never committed)        -> gamma slash
//       pot (gamma only) -> thetaBps to treasury, remainder split among revealers;
//       zero revealers  -> the WHOLE pot to treasury and the prepay back to the app.
//
//   FR-CR-02 — the q* "jurors underpaid" guard, enforced IDENTICALLY by the
//   ArbitratorCore constructor and by CourtRegistry.validateConfig (a config that
//   passes one and fails the other is the validation-parity bug class).
//
// Every settlement is followed by assertConservation (never-mint invariant).

type Cfg = {
  minStake: bigint; jurorFee: bigint; drawThreshold: bigint;
  activationDelayBlocks: bigint; drawDelayBlocks: bigint; drawWindowBlocks: bigint;
  commitBlocks: bigint; revealBlocks: bigint; panelSize: bigint;
  betaBps: bigint; gammaBps: bigint; thetaBps: bigint; quorumBps: bigint;
  appFeeBps: bigint; protocolFeeBps: bigint; treasury: string;
};

function baseCfg(treasury: string, over: Partial<Cfg> = {}): Cfg {
  return {
    minStake: 100n, jurorFee: 10n, drawThreshold: ethers.MaxUint256,
    activationDelayBlocks: 0n, drawDelayBlocks: 1n, drawWindowBlocks: 100n,
    commitBlocks: 100n, revealBlocks: 100n, panelSize: 3n,
    betaBps: 1000n, gammaBps: 2500n, thetaBps: 2000n, quorumBps: 5000n,
    appFeeBps: 0n, protocolFeeBps: 0n, treasury, ...over,
  };
}

async function deployCore(cfg: Cfg) {
  const Elig = await ethers.getContractFactory('StakeWeightedEligibility');
  const elig = await Elig.deploy();
  await elig.waitForDeployment();
  const Core = await ethers.getContractFactory('ArbitratorCore');
  const core = (await Core.deploy(cfg, await elig.getAddress())) as any;
  await core.waitForDeployment();
  return core;
}

/// Deploy a court + a MockArbitrable app, stake `jurorCount` jurors at one slot
/// each, and open a dispute over `choices` outcomes. Returns everything the phase
/// cranks below need.
async function openDispute(cfg: Cfg, jurorCount: number, choices: number) {
  // Signer 0 is the deployer and signer 1 is the treasury (the caller already put
  // it in cfg.treasury), so jurors start at index 2 and never collide with either.
  const rest = (await ethers.getSigners()).slice(2);
  const core = await deployCore(cfg);
  const App = await ethers.getContractFactory('MockArbitrable');
  const app = (await App.deploy(await core.getAddress())) as any;
  await app.waitForDeployment();

  const jurors = rest.slice(0, jurorCount);
  for (const j of jurors) await (await core.connect(j).stake({ value: cfg.minStake })).wait();
  const cost = (await core.arbitrationCost('0x')) as bigint;
  await (await app.createDispute(choices, { value: cost })).wait();
  return { core, app, jurors, cost, disputeId: 1n };
}

function commitmentOf(disputeId: bigint, juror: string, choice: number, salt: string): string {
  return ethers.solidityPackedKeccak256(
    ['uint256', 'address', 'uint8', 'bytes32'],
    [disputeId, juror, choice, salt],
  );
}

/// Every `Slashed` event the given transaction emitted, decoded. The PRD's whole
/// claim is about WHO is slashed, so the tests assert on the events, not only on
/// the resulting balances.
async function slashesOf(core: any, tx: any): Promise<{ juror: string; amount: bigint }[]> {
  const rc = await tx.wait();
  const coreAddr = (await core.getAddress()).toLowerCase();
  const out: { juror: string; amount: bigint }[] = [];
  for (const log of rc.logs) {
    if (log.address.toLowerCase() !== coreAddr) continue;
    const parsed = core.interface.parseLog({ topics: [...log.topics], data: log.data });
    if (parsed && parsed.name === 'Slashed') {
      out.push({ juror: (parsed.args.juror as string).toLowerCase(), amount: parsed.args.amount as bigint });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. TIE — every seated juror revealed, nobody is slashed.
// ---------------------------------------------------------------------------
describe('FR-ST-02 — genuine tie, every seated juror revealed', () => {
  it('pays each revealer slot stake + jurorFee, slashes nobody, refunds the app', async () => {
    const [, treasury] = await ethers.getSigners();
    // Panel 5 so the tie is 2-2-1 (a real split, not the degenerate 1-1-1) and
    // quorum is comfortably met: need = ceil(5 * 50%) = 3, revealed = 5.
    const cfg = baseCfg(treasury.address, { panelSize: 5n });
    const { core, app, jurors, cost, disputeId } = await openDispute(cfg, 5, 3);
    expect(cost).to.equal(50n); // 5 seats * fee 10, no take

    await mine(2);
    for (const j of jurors) await (await core.connect(j).claimSeat(disputeId)).wait();
    await mine(101);
    await (await core.closeDrawing(disputeId)).wait();

    // 2 votes for choice 1, 2 for choice 2, 1 for choice 3 -> best is tied at 2.
    const votes = [1, 1, 2, 2, 3];
    const salts: Record<string, string> = {};
    for (let i = 0; i < jurors.length; i++) {
      const j = jurors[i];
      const salt = ethers.hexlify(ethers.randomBytes(32));
      salts[j.address] = salt;
      await (await core.connect(j).commitVote(disputeId, commitmentOf(disputeId, j.address, votes[i], salt))).wait();
    }
    await mine(101);
    await (await core.openReveal(disputeId)).wait();
    expect((await core.getDispute(disputeId)).seatedWeight).to.equal(5n);
    for (let i = 0; i < jurors.length; i++) {
      await (await core.connect(jurors[i]).revealVote(disputeId, votes[i], salts[jurors[i].address])).wait();
    }
    await mine(101);

    // Deltas are measured, not assumed: nothing is pullable before settlement.
    const before: Record<string, bigint> = {};
    for (const j of jurors) before[j.address] = await core.withdrawable(j.address);
    for (const j of jurors) expect(before[j.address]).to.equal(0n);

    // FR-ST-02: NOT ONE Slashed event on a no-verdict settlement where everybody voted.
    await expect(core.finalize(disputeId)).to.not.emit(core, 'Slashed');

    const [ruling, tied, finalized] = await core.currentRuling(disputeId);
    expect(ruling).to.equal(0n); // no verdict carried
    expect(tied).to.equal(true); // ...because of a genuine tie
    expect(finalized).to.equal(true);
    expect(await core.disputeState(disputeId)).to.equal(4); // Resolved

    // Every revealer: stake 100 back + jurorFee 10. pot = 0 (nothing was slashed),
    // so the pot share is 0 — the fee alone is the reward for showing up.
    for (const j of jurors) {
      const delta = (await core.withdrawable(j.address)) - before[j.address];
      expect(delta, `revealer ${j.address} delta`).to.equal(110n);
      expect(await core.staked(j.address)).to.equal(0n); // the slot stake was routed, not kept
    }
    // cost 50 == 5 rewarded seats * fee 10 -> no residue for the app, and with no
    // pot and no take the treasury earns nothing.
    expect(await core.withdrawable(await app.getAddress())).to.equal(0n);
    expect(await core.withdrawable(treasury.address)).to.equal(0n);

    const accounts = [...jurors.map((j) => j.address), await app.getAddress(), treasury.address];
    await assertConservation(core, accounts);

    // The credit is real money, not just an accounting entry: pull it.
    const coreBalBefore = await ethers.provider.getBalance(await core.getAddress());
    await (await core.connect(jurors[0]).withdraw()).wait();
    expect(await core.withdrawable(jurors[0].address)).to.equal(0n);
    expect(await ethers.provider.getBalance(await core.getAddress())).to.equal(coreBalBefore - 110n);
    await assertConservation(core, accounts); // still exact after a withdrawal
  });

  it('returns a RELEASED alternate its stake with NO fee while revealers are paid', async () => {
    const [, treasury] = await ethers.getSigners();
    // Panel 3 with drawTarget = ceil(1.4 * 3) = 5. Five jurors claim, so the draw
    // is fully over-drawn (it auto-advances to Committing on the 5th claim) and two
    // admitted seats end up as unneeded alternates.
    const cfg = baseCfg(treasury.address);
    const { core, app, jurors, cost, disputeId } = await openDispute(cfg, 5, 5);
    expect(cost).to.equal(30n); // panel 3 * fee 10

    await mine(2);
    for (const j of jurors) await (await core.connect(j).claimSeat(disputeId)).wait();
    expect(await core.disputeState(disputeId)).to.equal(2); // Committing (over-drawn)

    // All five commit, each to a DISTINCT choice, so whichever three the sortition
    // ranks as primaries reveal three different choices -> a guaranteed tie.
    const salts: Record<string, string> = {};
    for (let i = 0; i < jurors.length; i++) {
      const j = jurors[i];
      const salt = ethers.hexlify(ethers.randomBytes(32));
      salts[j.address] = salt;
      await (await core.connect(j).commitVote(disputeId, commitmentOf(disputeId, j.address, i + 1, salt))).wait();
    }
    await mine(101);
    await (await core.openReveal(disputeId)).wait();

    // Read the roles the panel seating actually assigned (ranked by keccak, so the
    // split is not predictable from the signer order).
    const seats = await core.getSeats(disputeId);
    expect(seats.length).to.equal(5);
    const seated = seats.filter((s: any) => Number(s.role) === 1).map((s: any) => s.juror as string);
    const released = seats.filter((s: any) => Number(s.role) === 0).map((s: any) => s.juror as string);
    expect(seated.length).to.equal(3); // every primary committed -> no promotion needed
    expect(released.length).to.equal(2);
    expect(seats.filter((s: any) => Number(s.role) === 2).length).to.equal(0); // no ROLE_SILENT

    for (const j of jurors) {
      if (!seated.includes(j.address)) continue;
      const choice = jurors.indexOf(j) + 1;
      await (await core.connect(j).revealVote(disputeId, choice, salts[j.address])).wait();
    }
    // A released alternate holds no duty seat and so cannot reveal at all.
    const alt = jurors.find((j) => released.includes(j.address))!;
    expect((await core.jurorRoundOf(disputeId, alt.address)).dutySeats).to.equal(0n);
    await expect(core.connect(alt).revealVote(disputeId, 1, salts[alt.address])).to.be.revertedWithCustomError(
      core,
      'NotSeated',
    );

    await mine(101);
    await expect(core.finalize(disputeId)).to.not.emit(core, 'Slashed');

    const [ruling, tied] = await core.currentRuling(disputeId);
    expect(ruling).to.equal(0n);
    expect(tied).to.equal(true);

    // Seated revealers: 100 + fee 10. Released alternates: 100 back, NO fee.
    for (const a of seated) expect(await core.withdrawable(a), `seated ${a}`).to.equal(110n);
    for (const a of released) expect(await core.withdrawable(a), `released ${a}`).to.equal(100n);
    // cost 30 == 3 rewarded * fee 10 -> nothing left over for the app.
    expect(await core.withdrawable(await app.getAddress())).to.equal(0n);
    expect(await core.withdrawable(treasury.address)).to.equal(0n);

    await assertConservation(core, [
      ...jurors.map((j) => j.address), await app.getAddress(), treasury.address,
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. NO QUORUM with mixed behaviour — revealers paid, the silent slashed.
// ---------------------------------------------------------------------------
describe('FR-ST-02 — quorum failure with mixed behaviour', () => {
  it('pays the revealers, gamma-slashes the seats that committed then went silent', async () => {
    const [, treasury] = await ethers.getSigners();
    // Panel 5, quorum 50% -> need = ceil(2.5) = 3 revealed seats. Only 2 reveal, so
    // the dispute dies on QUORUM, not on a tie (tied stays false) — a different
    // ruling == 0 path from the tie tests above.
    const cfg = baseCfg(treasury.address, { panelSize: 5n });
    const { core, app, jurors, cost, disputeId } = await openDispute(cfg, 5, 2);
    expect(cost).to.equal(50n);

    await mine(2);
    for (const j of jurors) await (await core.connect(j).claimSeat(disputeId)).wait();
    await mine(101);
    await (await core.closeDrawing(disputeId)).wait();

    // ALL FIVE commit -> all five are ROLE_SEATED. Only the first two reveal.
    const salts: Record<string, string> = {};
    for (const j of jurors) {
      const salt = ethers.hexlify(ethers.randomBytes(32));
      salts[j.address] = salt;
      await (await core.connect(j).commitVote(disputeId, commitmentOf(disputeId, j.address, 1, salt))).wait();
    }
    await mine(101);
    await (await core.openReveal(disputeId)).wait();
    expect((await core.getDispute(disputeId)).seatedWeight).to.equal(5n);

    const revealers = jurors.slice(0, 2);
    const silent = jurors.slice(2); // committed, then never revealed
    for (const j of revealers) await (await core.connect(j).revealVote(disputeId, 1, salts[j.address])).wait();
    await mine(101);

    const d = await core.getDispute(disputeId);
    expect(d.revealedCount).to.equal(2n); // < need 3

    const slashes = await slashesOf(core, await core.finalize(disputeId));

    const [ruling, tied] = await core.currentRuling(disputeId);
    expect(ruling).to.equal(0n);
    expect(tied).to.equal(false); // a QUORUM failure, not a tie

    // Exactly the three silent seats are slashed, each by gamma = 25% of 100 = 25.
    expect(slashes.length).to.equal(3);
    expect(slashes.map((s) => s.juror).sort()).to.deep.equal(
      silent.map((j) => j.address.toLowerCase()).sort(),
    );
    for (const s of slashes) expect(s.amount).to.equal(25n);
    for (const j of revealers) {
      expect(slashes.some((s) => s.juror === j.address.toLowerCase()), 'revealer must not be slashed').to.equal(false);
    }

    // pot = 3 * 25 = 75; treasuryCut = 75 * 20% = 15; toRewarded = 60; 2 rewarded
    // seats -> share 30, dust 0.
    for (const j of revealers) expect(await core.withdrawable(j.address)).to.equal(140n); // 100 + 10 + 30
    for (const j of silent) expect(await core.withdrawable(j.address)).to.equal(75n); // 100 - gamma 25
    // cost 50, no take: residue = 50 - jurorFeesPaid(2 * 10) = 30 -> app.
    expect(await core.withdrawable(await app.getAddress())).to.equal(30n);
    expect(await core.withdrawable(treasury.address)).to.equal(15n); // treasuryCut + dust(0)

    await assertConservation(core, [
      ...jurors.map((j) => j.address), await app.getAddress(), treasury.address,
    ]);
  });

  it('treats a ROLE_SILENT primary (never committed) exactly the same — gamma, never beta', async () => {
    const [, treasury] = await ethers.getSigners();
    const cfg = baseCfg(treasury.address, { panelSize: 5n });
    const { core, app, jurors, disputeId } = await openDispute(cfg, 5, 2);

    await mine(2);
    for (const j of jurors) await (await core.connect(j).claimSeat(disputeId)).wait();
    await mine(101);
    await (await core.closeDrawing(disputeId)).wait();

    // Only two jurors commit at all. The other three never commit, so at openReveal
    // they are ROLE_SILENT — and, with exactly panelSize seats admitted, there are
    // no alternates to promote in their place. Quorum (3) therefore fails.
    const revealers = jurors.slice(0, 2);
    const never = jurors.slice(2);
    const salts: Record<string, string> = {};
    for (const j of revealers) {
      const salt = ethers.hexlify(ethers.randomBytes(32));
      salts[j.address] = salt;
      await (await core.connect(j).commitVote(disputeId, commitmentOf(disputeId, j.address, 1, salt))).wait();
    }
    await mine(101);
    await (await core.openReveal(disputeId)).wait();

    const seats = await core.getSeats(disputeId);
    expect(seats.filter((s: any) => Number(s.role) === 2).length).to.equal(3); // ROLE_SILENT
    expect((await core.getDispute(disputeId)).seatedWeight).to.equal(2n);

    // The contract's own proof obligation: a ROLE_SILENT seat can NEVER be revealed,
    // because its juror was given no duty seat, so revealVote refuses them. That is
    // what makes `revealed` a safe reward predicate under ruling == 0.
    for (const j of never) {
      const jr = await core.jurorRoundOf(disputeId, j.address);
      expect(jr.committed).to.equal(false);
      expect(jr.dutySeats).to.equal(0n);
      expect(jr.revealed).to.equal(false);
      await expect(core.connect(j).revealVote(disputeId, 1, ethers.ZeroHash)).to.be.revertedWithCustomError(
        core,
        'NotSeated',
      );
    }

    for (const j of revealers) await (await core.connect(j).revealVote(disputeId, 1, salts[j.address])).wait();
    await mine(101);
    const slashes = await slashesOf(core, await core.finalize(disputeId));

    const [ruling, tied] = await core.currentRuling(disputeId);
    expect(ruling).to.equal(0n);
    expect(tied).to.equal(false);

    // Identical waterfall to the committed-then-silent case: gamma 25, never beta 10.
    expect(slashes.length).to.equal(3);
    for (const s of slashes) expect(s.amount).to.equal(25n);
    for (const j of revealers) expect(await core.withdrawable(j.address)).to.equal(140n);
    for (const j of never) expect(await core.withdrawable(j.address)).to.equal(75n);
    expect(await core.withdrawable(await app.getAddress())).to.equal(30n);
    expect(await core.withdrawable(treasury.address)).to.equal(15n);

    await assertConservation(core, [
      ...jurors.map((j) => j.address), await app.getAddress(), treasury.address,
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. ALL SILENT — the zero-rewarded-seats branch.
// ---------------------------------------------------------------------------
describe('FR-ST-02 — nobody reveals (zero rewarded seats)', () => {
  it('gamma-slashes every seat, routes the whole pot to the treasury, refunds the app', async () => {
    const [, treasury] = await ethers.getSigners();
    // A court WITH a take (5% app + 5% protocol) so the else-branch's fee routing is
    // exercised, not just the zero-fee shape: arbCost grosses up to
    // ceil(3 * 10 * 10000 / 9000) = 34.
    const cfg = baseCfg(treasury.address, { appFeeBps: 500n, protocolFeeBps: 500n });
    const { core, app, jurors, cost, disputeId } = await openDispute(cfg, 3, 2);
    expect(cost).to.equal(34n);

    await mine(2);
    for (const j of jurors) await (await core.connect(j).claimSeat(disputeId)).wait();
    await mine(101);
    await (await core.closeDrawing(disputeId)).wait();

    // Everyone commits — and then the whole panel goes dark at reveal.
    for (const j of jurors) {
      const salt = ethers.hexlify(ethers.randomBytes(32));
      await (await core.connect(j).commitVote(disputeId, commitmentOf(disputeId, j.address, 1, salt))).wait();
    }
    await mine(101);
    await (await core.openReveal(disputeId)).wait();
    expect((await core.getDispute(disputeId)).seatedWeight).to.equal(3n);
    await mine(101);

    const slashes = await slashesOf(core, await core.finalize(disputeId));

    const [ruling, tied] = await core.currentRuling(disputeId);
    expect(ruling).to.equal(0n);
    expect(tied).to.equal(false);
    expect((await core.getDispute(disputeId)).revealedCount).to.equal(0n);

    // Every seat: gamma 25% of 100 = 25 -> 75 back. pot = 75.
    expect(slashes.length).to.equal(3);
    for (const s of slashes) expect(s.amount).to.equal(25n);
    for (const j of jurors) expect(await core.withdrawable(j.address)).to.equal(75n);
    // Zero rewarded seats: no fee is earned, so the prepay less the protocol take
    // goes back to the app and the ENTIRE pot goes to the treasury.
    // protocolCut = 34 * 5% = 1 (floor); app = 34 - 1 = 33; treasury = 1 + 75 = 76.
    expect(await core.withdrawable(await app.getAddress())).to.equal(33n);
    expect(await core.withdrawable(treasury.address)).to.equal(76n);

    await assertConservation(core, [
      ...jurors.map((j) => j.address), await app.getAddress(), treasury.address,
    ]);
  });

  it('does the same when nobody even commits (every seat ROLE_SILENT)', async () => {
    const [, treasury] = await ethers.getSigners();
    const cfg = baseCfg(treasury.address);
    const { core, app, jurors, cost, disputeId } = await openDispute(cfg, 3, 2);
    expect(cost).to.equal(30n);

    await mine(2);
    for (const j of jurors) await (await core.connect(j).claimSeat(disputeId)).wait();
    await mine(101);
    await (await core.closeDrawing(disputeId)).wait();
    await mine(101);
    await (await core.openReveal(disputeId)).wait(); // seats the panel with zero commits

    const seats = await core.getSeats(disputeId);
    expect(seats.filter((s: any) => Number(s.role) === 2).length).to.equal(3); // all ROLE_SILENT
    expect((await core.getDispute(disputeId)).seatedWeight).to.equal(0n);
    await mine(101);

    const slashes = await slashesOf(core, await core.finalize(disputeId));
    const [ruling] = await core.currentRuling(disputeId);
    expect(ruling).to.equal(0n);
    expect(await core.disputeState(disputeId)).to.equal(4); // terminal

    expect(slashes.length).to.equal(3);
    for (const s of slashes) expect(s.amount).to.equal(25n);
    for (const j of jurors) expect(await core.withdrawable(j.address)).to.equal(75n);
    expect(await core.withdrawable(await app.getAddress())).to.equal(30n); // full prepay, no take
    expect(await core.withdrawable(treasury.address)).to.equal(75n); // the whole pot

    await assertConservation(core, [
      ...jurors.map((j) => j.address), await app.getAddress(), treasury.address,
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4-6. FR-CR-02 — the q* underpayment guard and core/registry parity.
// ---------------------------------------------------------------------------
describe('FR-CR-02 — q* underpayment guard (core constructor)', () => {
  it("rejects the PRD's underpaid example with BadConfig('jurorsUnderpaid')", async () => {
    const [, treasury] = await ethers.getSigners();
    const Elig = await ethers.getContractFactory('StakeWeightedEligibility');
    const elig = await Elig.deploy();
    await elig.waitForDeployment();
    const Core = await ethers.getContractFactory('ArbitratorCore');

    // PRD §7 rejected example: panel 7, s 100, f 3, beta 20%, theta 20%
    // -> incoherent 2, coherent 5, potShare 6.4, q* = 20 / 29.4 = 0.68 > 0.60.
    const bad = baseCfg(treasury.address, {
      panelSize: 7n, minStake: 100n, jurorFee: 3n, betaBps: 2000n, thetaBps: 2000n,
    });
    await expect(Core.deploy(bad, await elig.getAddress()))
      .to.be.revertedWithCustomError(Core, 'BadConfig')
      .withArgs('jurorsUnderpaid');
  });

  it("accepts the PRD's well-paid example and prices it correctly", async () => {
    const [, treasury] = await ethers.getSigners();
    // PRD §7 accepted example: panel 7, s 100, f 5, beta 10%, theta 20%
    // -> potShare 3.2, q* = 10 / 18.2 = 0.549, inside the 0.5-0.6 target band.
    const ok = baseCfg(treasury.address, {
      panelSize: 7n, minStake: 100n, jurorFee: 5n, betaBps: 1000n, thetaBps: 2000n,
    });
    const core = await deployCore(ok);
    expect(await core.arbitrationCost('0x')).to.equal(35n); // 7 seats * fee 5, no take
    const stored = await core.config();
    expect(stored.panelSize).to.equal(7n);
    expect(stored.jurorFee).to.equal(5n);
  });

  it('raising the FEE is what rescues an over-penalised court, not lowering the panel', async () => {
    const [, treasury] = await ethers.getSigners();
    const Elig = await ethers.getContractFactory('StakeWeightedEligibility');
    const elig = await Elig.deploy();
    await elig.waitForDeployment();
    const eligAddr = await elig.getAddress();
    const Core = await ethers.getContractFactory('ArbitratorCore');

    const over = { panelSize: 7n, minStake: 100n, betaBps: 2000n, thetaBps: 2000n };
    // f = 3 -> q* 0.680 reject; f = 5 -> q* 0.637 still reject; f = 8 -> q* 0.581 accept.
    for (const fee of [3n, 5n]) {
      await expect(Core.deploy(baseCfg(treasury.address, { ...over, jurorFee: fee }), eligAddr))
        .to.be.revertedWithCustomError(Core, 'BadConfig')
        .withArgs('jurorsUnderpaid');
    }
    const fixed = await Core.deploy(baseCfg(treasury.address, { ...over, jurorFee: 8n }), eligAddr);
    await fixed.waitForDeployment();
  });

  it('handles panelSize 1 (coherent == 1, potShare 0) without dividing by zero', async () => {
    const [, treasury] = await ethers.getSigners();
    const Elig = await ethers.getContractFactory('StakeWeightedEligibility');
    const elig = await Elig.deploy();
    await elig.waitForDeployment();
    const eligAddr = await elig.getAddress();
    const Core = await ethers.getContractFactory('ArbitratorCore');

    // incoherent = 1 / 3 = 0, coherent = 1, expectedPotShare = 0.
    // f 10 -> q* = 10 / 20 = 0.50 -> accepted (and NOT a revert/panic).
    const one = await Core.deploy(baseCfg(treasury.address, { panelSize: 1n, jurorFee: 10n }), eligAddr);
    await one.waitForDeployment();
    expect(await one.arbitrationCost('0x')).to.equal(10n);
    // f 5 -> q* = 10 / 15 = 0.667 -> rejected, on the same zero-pot arithmetic.
    await expect(Core.deploy(baseCfg(treasury.address, { panelSize: 1n, jurorFee: 5n }), eligAddr))
      .to.be.revertedWithCustomError(Core, 'BadConfig')
      .withArgs('jurorsUnderpaid');
  });
});

describe('FR-CR-02 — core / CourtRegistry validation parity', () => {
  // Configs chosen so that EVERY other guard passes: the only thing that can decide
  // them is the q* ceiling. A disagreement between the two implementations on any
  // row is the validation-parity bug class the round-1 audit flagged.
  //
  // The three `accept` rows marked (pot) are accepted ONLY because the sub-unit
  // expected pot share is carried scaled by BPS — a naive implementation that let it
  // truncate to zero would reject all three. They are the regression test for the
  // "do not truncate to zero" requirement.
  const table: { name: string; over: Partial<Cfg>; accept: boolean }[] = [
    { name: "PRD §7 accepted (panel 7, f 5, beta 10%) q* 0.549", over: { panelSize: 7n, jurorFee: 5n, betaBps: 1000n }, accept: true },
    { name: 'PRD §7 rejected (panel 7, f 3, beta 20%) q* 0.680', over: { panelSize: 7n, jurorFee: 3n, betaBps: 2000n }, accept: false },
    { name: 'the existing test court (panel 3, f 10, beta 10%) q* 0.417', over: {}, accept: true },
    { name: 'the appeals court (panel 7, f 10, beta 10%) q* 0.431', over: { panelSize: 7n }, accept: true },
    { name: 'panel 5, f 2, beta 10% q* 0.714', over: { panelSize: 5n, jurorFee: 2n }, accept: false },
    { name: 'panel 5, f 10, beta 25% q* 0.625', over: { panelSize: 5n, betaBps: 2500n }, accept: false },
    { name: 'panel 7, f 3, beta 10% q* 0.617', over: { panelSize: 7n, jurorFee: 3n }, accept: false },
    { name: 'panel 9, f 4, beta 15% — q* EXACTLY 0.600 (pot)', over: { panelSize: 9n, jurorFee: 4n, betaBps: 1500n }, accept: true },
    { name: 'panel 3, f 6, beta 10%, theta 85% — pot share 0.75 (pot)', over: { jurorFee: 6n, betaBps: 1000n, thetaBps: 8500n }, accept: true },
    { name: 'panel 1, f 10 — zero pot share, q* 0.500', over: { panelSize: 1n }, accept: true },
    { name: 'panel 1, f 5 — zero pot share, q* 0.667', over: { panelSize: 1n, jurorFee: 5n }, accept: false },
    { name: 'beta 0 — nothing at risk, q* 0', over: { betaBps: 0n }, accept: true },
    { name: 'panel 15, 1e18 stake, 0.05e18 fee — q* 0.526 (pot, 18 decimals)', over: { panelSize: 15n, minStake: 10n ** 18n, jurorFee: 5n * 10n ** 16n }, accept: true },
    { name: 'panel 15, 1e18 stake, 0.01e18 fee — q* 0.667 (18 decimals)', over: { panelSize: 15n, minStake: 10n ** 18n, jurorFee: 10n ** 16n }, accept: false },
  ];

  it('agrees with CourtRegistry.validateConfig on every config, in both directions', async () => {
    const [, treasury] = await ethers.getSigners();
    const Elig = await ethers.getContractFactory('StakeWeightedEligibility');
    const elig = await Elig.deploy();
    await elig.waitForDeployment();
    const eligAddr = await elig.getAddress();
    const Core = await ethers.getContractFactory('ArbitratorCore');
    const Reg = await ethers.getContractFactory('CourtRegistry');
    const reg = (await Reg.deploy()) as any;
    await reg.waitForDeployment();

    for (const row of table) {
      const cfg = baseCfg(treasury.address, row.over);
      if (row.accept) {
        // Core constructor, the registry's pure dry-run, and the registry factory
        // must ALL admit it.
        const core = await Core.deploy(cfg, eligAddr);
        await core.waitForDeployment();
        await reg.validateConfig(cfg, eligAddr);
        await (await reg.createCourt(cfg, eligAddr)).wait();
        // ...and an already-deployed core must be admissible under the same config.
        await (await reg.registerCourt(await core.getAddress(), cfg)).wait();
      } else {
        await expect(Core.deploy(cfg, eligAddr), `core must reject: ${row.name}`)
          .to.be.revertedWithCustomError(Core, 'BadConfig')
          .withArgs('jurorsUnderpaid');
        await expect(reg.validateConfig(cfg, eligAddr), `validateConfig must reject: ${row.name}`)
          .to.be.revertedWithCustomError(reg, 'BadConfig')
          .withArgs('jurorsUnderpaid');
        await expect(reg.createCourt(cfg, eligAddr), `createCourt must reject: ${row.name}`)
          .to.be.revertedWithCustomError(reg, 'BadConfig')
          .withArgs('jurorsUnderpaid');
      }
    }

    // Sanity: the accepted rows really did mint courts, and each is registry-verified
    // when the registry deployed it and self-attested when it did not.
    const accepted = table.filter((r) => r.accept).length;
    expect(await reg.courtCount()).to.equal(BigInt(accepted * 2));
    const [known, verified] = await reg.courtVerified(1n);
    expect(known).to.equal(true);
    expect(verified).to.equal(true); // courtId 1 came from createCourt
    const [, verified2] = await reg.courtVerified(2n);
    expect(verified2).to.equal(false); // courtId 2 came from registerCourt
  });

  it('still lets an underpaying court through no back door: registerCourt re-validates', async () => {
    const [, treasury] = await ethers.getSigners();
    const Elig = await ethers.getContractFactory('StakeWeightedEligibility');
    const elig = await Elig.deploy();
    await elig.waitForDeployment();
    const eligAddr = await elig.getAddress();
    const Reg = await ethers.getContractFactory('CourtRegistry');
    const reg = (await Reg.deploy()) as any;
    await reg.waitForDeployment();

    // A legitimately-deployed core cannot be re-registered under a DIFFERENT, underpaid
    // config: validateConfig runs before the config-hash check, so the q* reason wins.
    const ok = baseCfg(treasury.address, { panelSize: 7n, jurorFee: 5n, betaBps: 1000n });
    const core = await deployCore(ok);
    const underpaid = baseCfg(treasury.address, { panelSize: 7n, jurorFee: 3n, betaBps: 2000n });
    await expect(reg.registerCourt(await core.getAddress(), underpaid))
      .to.be.revertedWithCustomError(reg, 'BadConfig')
      .withArgs('jurorsUnderpaid');
    // The honest registration still works.
    await (await reg.registerCourt(await core.getAddress(), ok)).wait();
    expect(await reg.courtCount()).to.equal(1n);
  });
});
