import { expect } from 'chai';
import { ethers } from 'hardhat';
import { mine } from '@nomicfoundation/hardhat-network-helpers';
import { assertConservation } from './helpers';

// FR-VT-03 / FR-VT-04 / FR-PG-06 — the three cheap guards around voting and court readiness.

function baseCfg(treasury: string, over: Record<string, any> = {}) {
  return {
    minStake: 100n, jurorFee: 10n, drawThreshold: ethers.MaxUint256,
    evidenceBond: 0n,
    evidenceBlocks: 5n, activationDelayBlocks: 0n, drawDelayBlocks: 1n, drawWindowBlocks: 100n,
    commitBlocks: 100n, revealBlocks: 100n, panelSize: 3n,
    betaBps: 1000n, gammaBps: 2500n, thetaBps: 2000n, quorumBps: 5000n,
    commitRequired: true, minPoolWeightMultiple: 0n,
    quorumFailure: 0n, tieBreak: 0n, defaultChoice: 0n,
    closedPool: false,
    appFeeBps: 0n, protocolFeeBps: 0n, pinFeeBps: 0n,
    treasury, pinner: ethers.ZeroAddress, ...over,
  };
}

async function court(cfg: any) {
  const Elig = await ethers.getContractFactory('StakeWeightedEligibility');
  const elig = await Elig.deploy();
  await elig.waitForDeployment();
  const Core = await ethers.getContractFactory('ArbitratorCore');
  const core: any = await Core.deploy(cfg, await elig.getAddress(), 0n);
  await core.waitForDeployment();
  const App = await ethers.getContractFactory('MockArbitrable');
  const app: any = await App.deploy(await core.getAddress());
  await app.waitForDeployment();
  return { core, app };
}

const commitmentOf = (id: bigint, juror: string, choice: number, salt: string) =>
  ethers.solidityPackedKeccak256(['uint256', 'address', 'uint8', 'bytes32'], [id, juror, choice, salt]);

/** Stake `n` jurors, open a dispute, and carry it as far as the commit window. */
async function toCommit(cfg: any, n: number) {
  const jurors = (await ethers.getSigners()).slice(2, 2 + n);
  const { core, app } = await court(cfg);
  for (const j of jurors) await (await core.connect(j).stake({ value: cfg.minStake })).wait();
  await (await app.createDispute(2, { value: await core.arbitrationCost('0x') })).wait();
  await mine(6);
  await (await core.openDrawing(1n)).wait();
  await mine(2);
  for (const j of jurors) await (await core.connect(j).claimSeat(1n)).wait();
  await mine(101);
  await (await core.closeDrawing(1n)).wait();
  return { core, app, jurors };
}

describe('FR-VT-04 — somebody else can put the reveal on chain', () => {
  it('accepts the juror\'s own committed pair from any sender, and nothing else', async () => {
    const [, treasury, , , , , , , , relayer, stranger] = await ethers.getSigners();
    const cfg = baseCfg(treasury.address);
    const { core, app, jurors } = await toCommit(cfg, 3);

    const salts: Record<string, string> = {};
    for (const j of jurors) {
      const salt = ethers.hexlify(ethers.randomBytes(32));
      salts[j.address] = salt;
      await (await core.connect(j).commitVote(1n, commitmentOf(1n, j.address, 1, salt))).wait();
    }
    await mine(101);
    await (await core.openReveal(1n)).wait();

    // A relayer reveals for a juror who lost the browser holding their salt.
    await expect(core.connect(relayer).revealVoteFor(1n, jurors[0].address, 1, salts[jurors[0].address]))
      .to.emit(core, 'VoteRevealed').withArgs(1n, jurors[0].address, 1, 1n);

    // The commitment binds the JUROR's address, so a relayer cannot vote differently for them.
    await expect(core.connect(relayer).revealVoteFor(1n, jurors[1].address, 2, salts[jurors[1].address]))
      .to.be.revertedWithCustomError(core, 'BadReveal');
    // Nor can a stranger reveal their own pair under someone else's seat.
    await expect(core.connect(stranger).revealVoteFor(1n, jurors[1].address, 1, ethers.ZeroHash))
      .to.be.revertedWithCustomError(core, 'BadReveal');

    await (await core.connect(relayer).revealVoteFor(1n, jurors[1].address, 1, salts[jurors[1].address])).wait();
    await (await core.connect(jurors[2]).revealVote(1n, 1, salts[jurors[2].address])).wait();

    await mine(101);
    await expect(core.finalize(1n)).to.not.emit(core, 'Slashed');
    expect((await core.currentRuling(1n))[0]).to.equal(1n);
    for (const j of jurors) expect(await core.withdrawable(j.address)).to.equal(110n);
    await assertConservation(core, [
      ...jurors.map((j) => j.address), await app.getAddress(), treasury.address, relayer.address,
    ]);
  });
});

describe('FR-VT-03 — open voting', () => {
  it('seats the panel by rank and takes votes with no commitment at all', async () => {
    const [, treasury] = await ethers.getSigners();
    const cfg = baseCfg(treasury.address, { commitRequired: false });
    const { core, app, jurors } = await toCommit(cfg, 3);

    // There is nothing to commit to, and the contract says so rather than quietly accepting one.
    await expect(core.connect(jurors[0]).commitVote(1n, ethers.ZeroHash))
      .to.be.revertedWithCustomError(core, 'WrongState');

    await mine(101);
    await (await core.openReveal(1n)).wait();
    // The panel is the top-ranked seats outright — nothing has happened that could separate a
    // primary from an absentee.
    expect((await core.getDispute(1n)).seatedWeight).to.equal(3n);

    for (const j of jurors) await (await core.connect(j).revealVote(1n, 1, ethers.ZeroHash)).wait();
    // Open or not, only the juror casts their own vote.
    await expect(core.revealVoteFor(1n, jurors[0].address, 2, ethers.ZeroHash))
      .to.be.revertedWithCustomError(core, 'BadReveal');

    await mine(101);
    await (await core.finalize(1n)).wait();
    expect((await core.currentRuling(1n))[0]).to.equal(1n);
    for (const j of jurors) expect(await core.withdrawable(j.address)).to.equal(110n);
    await assertConservation(core, [
      ...jurors.map((j) => j.address), await app.getAddress(), treasury.address,
    ]);
  });

  it('still slashes a seat that never votes', async () => {
    const [, treasury] = await ethers.getSigners();
    const cfg = baseCfg(treasury.address, { commitRequired: false });
    const { core, jurors } = await toCommit(cfg, 3);
    await mine(101);
    await (await core.openReveal(1n)).wait();
    await (await core.connect(jurors[0]).revealVote(1n, 1, ethers.ZeroHash)).wait();
    await (await core.connect(jurors[1]).revealVote(1n, 1, ethers.ZeroHash)).wait();
    await mine(101);
    await expect(core.finalize(1n))
      .to.emit(core, 'Slashed').withArgs(1n, jurors[2].address, 25n);
  });
});

describe('FR-PG-06 — a court says it is empty instead of stalling', () => {
  it('refuses a dispute until the pool can cover the panels it promises', async () => {
    const [, treasury] = await ethers.getSigners();
    const jurors = (await ethers.getSigners()).slice(2, 8);
    // 2 full panels of 3 seats at 100 each = 600 before this court will hear anything.
    const cfg = baseCfg(treasury.address, { minPoolWeightMultiple: 2n });
    const { core, app } = await court(cfg);

    expect(await core.readinessThreshold()).to.equal(600n);
    let [ready, have, need] = await core.courtReadiness();
    expect(ready).to.equal(false);
    expect(have).to.equal(0n);
    expect(need).to.equal(600n);

    const cost = await core.arbitrationCost('0x');
    await expect(app.createDispute(2, { value: cost }))
      .to.be.revertedWithCustomError(core, 'CourtNotReady').withArgs(0n, 600n);

    for (const j of jurors.slice(0, 5)) await (await core.connect(j).stake({ value: 100n })).wait();
    await expect(app.createDispute(2, { value: cost }))
      .to.be.revertedWithCustomError(core, 'CourtNotReady').withArgs(500n, 600n);

    await (await core.connect(jurors[5]).stake({ value: 100n })).wait();
    [ready, have] = await core.courtReadiness();
    expect(ready).to.equal(true);
    expect(have).to.equal(600n);
    await (await app.createDispute(2, { value: cost })).wait();
    expect(await core.disputeCount()).to.equal(1n);
  });

  it('tracks the pool total through every movement of stake', async () => {
    const [, treasury] = await ethers.getSigners();
    const jurors = (await ethers.getSigners()).slice(2, 5);
    const cfg = baseCfg(treasury.address);
    const { core, app } = await court(cfg);

    for (const j of jurors) await (await core.connect(j).stake({ value: 200n })).wait();
    expect(await core.poolStake()).to.equal(600n);

    await (await core.connect(jurors[0]).unstake(50n)).wait();
    expect(await core.poolStake()).to.equal(550n);

    // A claimed seat locks its slot stake out of the free pool.
    await (await app.createDispute(2, { value: await core.arbitrationCost('0x') })).wait();
    await mine(6);
    await (await core.openDrawing(1n)).wait();
    await mine(2);
    await (await core.connect(jurors[1]).claimSeat(1n)).wait();
    expect(await core.poolStake()).to.equal(550n - 200n); // both of that juror's slots self-select

    let sum = 0n;
    for (const j of jurors) sum += await core.staked(j.address);
    expect(sum).to.equal(await core.poolStake());
  });
});
