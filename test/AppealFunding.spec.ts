import { expect } from 'chai';
import { ethers } from 'hardhat';
import { mine } from '@nomicfoundation/hardhat-network-helpers';

// FR-AP-01 / FR-AP-02 — what makes an appeal cost something.
//
//   The ladder must actually escalate (2n+1 per round) and it must end (maxRounds).
//   An appeal is funded PER OUTCOME. A side that will not pay to defend a ruling loses it without
//   a second panel ever sitting, and the money that backed the losing position is what pays for
//   the round the winners asked for.

function courtCfg(treasury: string, panelSize: bigint) {
  return {
    minStake: 100n, jurorFee: 10n, drawThreshold: ethers.MaxUint256,
    evidenceBond: 0n,
    evidenceBlocks: 5n, activationDelayBlocks: 0n, drawDelayBlocks: 1n, drawWindowBlocks: 100n,
    commitBlocks: 100n, revealBlocks: 100n, panelSize,
    betaBps: 1000n, gammaBps: 2500n, thetaBps: 2000n, quorumBps: 5000n,
    commitRequired: true, minPoolWeightMultiple: 0n,
    quorumFailure: 0n, tieBreak: 0n, defaultChoice: 0n,
    closedPool: false,
    appFeeBps: 0n, protocolFeeBps: 0n, pinFeeBps: 0n,
    treasury, pinner: ethers.ZeroAddress,
  };
}

async function courts(treasury: string, sizes: bigint[]) {
  const Elig = await ethers.getContractFactory('StakeWeightedEligibility');
  const elig = await Elig.deploy();
  await elig.waitForDeployment();
  const Core = await ethers.getContractFactory('ArbitratorCore');
  const out: any[] = [];
  for (const n of sizes) {
    const c: any = await Core.deploy(courtCfg(treasury, n), await elig.getAddress(), 0n);
    await c.waitForDeployment();
    out.push(c);
  }
  return out;
}

/** Drive one court dispute to a unanimous ruling for `choice`. */
async function runRound(court: any, childId: bigint, jurors: any[], choice: number) {
  for (const j of jurors) await (await court.connect(j).stake({ value: 100n })).wait();
  await mine(6);
  await (await court.openDrawing(childId)).wait();
  await mine(2);
  for (const j of jurors) await (await court.connect(j).claimSeat(childId)).wait();
  await mine(101);
  await (await court.closeDrawing(childId)).wait();
  const salts: Record<string, string> = {};
  for (const j of jurors) {
    const salt = ethers.hexlify(ethers.randomBytes(32));
    salts[j.address] = salt;
    await (await court.connect(j).commitVote(childId, ethers.solidityPackedKeccak256(
      ['uint256', 'address', 'uint8', 'bytes32'], [childId, j.address, choice, salt],
    ))).wait();
  }
  await mine(101);
  await (await court.openReveal(childId)).wait();
  for (const j of jurors) await (await court.connect(j).revealVote(childId, choice, salts[j.address])).wait();
  await mine(101);
  await (await court.finalize(childId)).wait();
}

async function setup(sizes: bigint[], maxRounds: number) {
  const signers = await ethers.getSigners();
  const [, payer, payee, treasury] = signers;
  const cs = await courts(treasury.address, sizes);
  const Coord = await ethers.getContractFactory('AppealCoordinator');
  const coord: any = await Coord.deploy(await Promise.all(cs.map((c) => c.getAddress())), 100n, maxRounds);
  await coord.waitForDeployment();
  const Escrow = await ethers.getContractFactory('SimpleEscrow');
  const escrow: any = await Escrow.deploy(await coord.getAddress());
  await escrow.waitForDeployment();
  await (await escrow.connect(payer).fund(payee.address, '', { value: 1000n })).wait();
  await (await escrow.connect(payer).dispute(1n, { value: await coord.arbitrationCost('0x') })).wait();
  return { coord, escrow, cs, payer, payee, treasury, signers };
}

describe('FR-AP-01 — the ladder must escalate, and it must end', () => {
  it('refuses a ladder whose next court is not at least 2n+1', async () => {
    const [, , , treasury] = await ethers.getSigners();
    const cs = await courts(treasury.address, [3n, 5n]); // 5 < 2*3+1
    const Coord = await ethers.getContractFactory('AppealCoordinator');
    await expect(Coord.deploy(await Promise.all(cs.map((c) => c.getAddress())), 100n, 2))
      .to.be.revertedWithCustomError(Coord, 'BadCourtLadder');
  });

  it('accepts exactly 2n+1 and reports the first round as its panel size', async () => {
    const [, , , treasury] = await ethers.getSigners();
    const cs = await courts(treasury.address, [3n, 7n, 15n]);
    const Coord = await ethers.getContractFactory('AppealCoordinator');
    const coord: any = await Coord.deploy(await Promise.all(cs.map((c) => c.getAddress())), 100n, 3);
    await coord.waitForDeployment();
    expect(await coord.panelSize()).to.equal(3n);
  });

  it('refuses a round cap of zero or one longer than the ladder', async () => {
    const [, , , treasury] = await ethers.getSigners();
    const addrs = await Promise.all((await courts(treasury.address, [3n, 7n])).map((c) => c.getAddress()));
    const Coord = await ethers.getContractFactory('AppealCoordinator');
    await expect(Coord.deploy(addrs, 100n, 0)).to.be.revertedWithCustomError(Coord, 'BadRoundCap');
    await expect(Coord.deploy(addrs, 100n, 3)).to.be.revertedWithCustomError(Coord, 'BadRoundCap');
  });

  it('stops at the cap even when a taller court is wired in', async () => {
    const { coord, cs, signers } = await setup([3n, 7n, 15n], 2); // three courts, two rounds
    await runRound(cs[0], 1n, signers.slice(4, 7), 2);
    expect(await coord.appealCost(1n)).to.equal(70n);

    const [, , payee, , ...rest] = signers;
    await (await coord.connect(payee).fundAppeal(1n, 1, { value: 70n })).wait();
    await (await coord.connect(rest[0]).fundAppeal(1n, 2, { value: 70n })).wait();
    await mine(101);
    await (await coord.finalizeAppeal(1n)).wait();

    await runRound(cs[1], 1n, signers.slice(4, 11), 1);
    // Round 1 is the last one the cap allows, so its ruling is final on delivery.
    expect(await coord.disputeState(1n)).to.equal(3); // Resolved
    expect(await coord.appealCost(1n)).to.equal(0n);
  });
});

describe('FR-AP-02 — funding an appeal, per outcome', () => {
  it('hands back anything sent beyond what a choice still needs', async () => {
    const { coord, cs, signers, payee } = await setup([3n, 7n], 2);
    await runRound(cs[0], 1n, signers.slice(4, 7), 2);

    await (await coord.connect(payee).fundAppeal(1n, 1, { value: 30n })).wait();
    expect(await coord.choiceFunding(1n, 0, 1)).to.equal(30n);

    // 100 sent against a 40 shortfall: 40 taken, 60 straight back in the same call.
    await expect(coord.connect(payee).fundAppeal(1n, 1, { value: 100n }))
      .to.changeEtherBalance(payee, -40n);
    expect(await coord.choiceFunding(1n, 0, 1)).to.equal(70n);
    expect(await coord.fundedCount(1n, 0)).to.equal(1);

    // Covered choices take nothing more.
    await expect(coord.connect(payee).fundAppeal(1n, 1, { value: 1n }))
      .to.be.revertedWithCustomError(coord, 'WrongFee');
  });

  it('refuses a choice the dispute does not have, and funding after the window', async () => {
    const { coord, cs, signers, payee } = await setup([3n, 7n], 2);
    await runRound(cs[0], 1n, signers.slice(4, 7), 2);

    await expect(coord.connect(payee).fundAppeal(1n, 0, { value: 10n }))
      .to.be.revertedWithCustomError(coord, 'BadChoice');
    await expect(coord.connect(payee).fundAppeal(1n, 3, { value: 10n }))
      .to.be.revertedWithCustomError(coord, 'BadChoice');

    await mine(101);
    await expect(coord.connect(payee).fundAppeal(1n, 1, { value: 10n }))
      .to.be.revertedWithCustomError(coord, 'AppealClosed');
  });

  it('gives the case to the only side that paid, with no second panel', async () => {
    const { coord, escrow, cs, signers, payee } = await setup([3n, 7n], 2);
    // Round 0 says REFUND the payer (2). The payee funds RELEASE (1); the payer funds nothing.
    await runRound(cs[0], 1n, signers.slice(4, 7), 2);
    expect((await coord.currentRuling(1n))[0]).to.equal(2n);

    await (await coord.connect(payee).fundAppeal(1n, 1, { value: 70n })).wait();
    await mine(101);
    await expect(coord.finalizeAppeal(1n)).to.emit(coord, 'WonByDefault').withArgs(1n, 0, 1);

    // No round 1 was ever opened, and the ruling flipped to the side that showed up.
    expect(await coord.disputeState(1n)).to.equal(3); // Resolved
    const [ruling, , finalized] = await coord.currentRuling(1n);
    expect(ruling).to.equal(1n);
    expect(finalized).to.equal(true);
    expect(await cs[1].disputeCount()).to.equal(0n);
    expect(await escrow.pendingWithdrawals(payee.address)).to.equal(1000n);

    // Nothing was spent, so the backer takes the whole stake back.
    await expect(coord.connect(payee).claimAppealReward(1n, 0, 1)).to.changeEtherBalance(payee, 70n);
    await expect(coord.connect(payee).claimAppealReward(1n, 0, 1))
      .to.be.revertedWithCustomError(coord, 'NothingToWithdraw');
  });

  it('refunds partial backers in full when no side ever covered the cost', async () => {
    const { coord, cs, signers, payee } = await setup([3n, 7n], 2);
    await runRound(cs[0], 1n, signers.slice(4, 7), 1);
    await (await coord.connect(payee).fundAppeal(1n, 2, { value: 30n })).wait();
    await mine(101);
    await (await coord.finalizeAppeal(1n)).wait();

    expect((await coord.currentRuling(1n))[0]).to.equal(1n); // round 0 stands
    await expect(coord.connect(payee).claimAppealReward(1n, 0, 2)).to.changeEtherBalance(payee, 30n);
  });

  it('runs the round when both sides pay, and the losing stake pays for it', async () => {
    const { coord, escrow, cs, signers, payee, payer } = await setup([3n, 7n], 2);
    await runRound(cs[0], 1n, signers.slice(4, 7), 2); // REFUND

    const cost = await coord.appealCost(1n); // 70
    await (await coord.connect(payee).fundAppeal(1n, 1, { value: cost })).wait();
    await (await coord.connect(payer).fundAppeal(1n, 2, { value: cost })).wait();
    await mine(101);
    await (await coord.finalizeAppeal(1n)).wait();
    expect(await coord.disputeState(1n)).to.equal(1); // round 1 running

    // The bigger panel says RELEASE (1) — the payee's position.
    await runRound(cs[1], 1n, signers.slice(4, 11), 1);
    expect(await coord.disputeState(1n)).to.equal(3);
    expect((await coord.currentRuling(1n))[0]).to.equal(1n);
    expect(await escrow.pendingWithdrawals(payee.address)).to.equal(1000n);

    // The round's own fee residue belongs to the pot that bought the round, so it has to be
    // pulled in before anyone's share is fixed. The crank is permissionless.
    await (await coord.reclaimFees(1n, 1)).wait();

    // Pot 140, round cost 70 -> 70 left, all of it to the winning bucket. The winner comes out
    // whole; the side that backed the losing outcome paid for the panel that overruled it.
    await expect(coord.connect(payee).claimAppealReward(1n, 0, 1)).to.changeEtherBalance(payee, cost);
    await expect(coord.connect(payer).claimAppealReward(1n, 0, 2))
      .to.be.revertedWithCustomError(coord, 'NothingToWithdraw');
  });

  it('splits the surplus pro rata when a third position also paid', async () => {
    const { coord, cs, signers, payee, payer } = await setup([3n, 7n], 2);
    const third = signers[12];
    // Three choices so a third position can be funded at all.
    const Escrow = await ethers.getContractFactory('MockArbitrable');
    const app: any = await Escrow.deploy(await coord.getAddress());
    await app.waitForDeployment();
    await (await app.createDispute(3, { value: await coord.arbitrationCost('0x') })).wait();
    const coordId = 2n;

    await runRound(cs[0], 2n, signers.slice(4, 7), 1);
    const cost = await coord.appealCost(coordId); // 70
    // Two backers share choice 2's bucket, so the split is visibly proportional.
    await (await coord.connect(payee).fundAppeal(coordId, 2, { value: cost / 2n })).wait();
    await (await coord.connect(third).fundAppeal(coordId, 2, { value: cost / 2n })).wait();
    await (await coord.connect(payer).fundAppeal(coordId, 1, { value: cost })).wait();
    await (await coord.connect(signers[13]).fundAppeal(coordId, 3, { value: cost })).wait();
    await mine(101);
    await (await coord.finalizeAppeal(coordId)).wait();

    // Court B has only ever heard this one appeal, so inside it the child id is 1.
    await runRound(cs[1], 1n, signers.slice(4, 11), 2); // choice 2 wins
    expect((await coord.currentRuling(coordId))[0]).to.equal(2n);

    await (await coord.reclaimFees(coordId, 1)).wait();

    // Pot 210, spent 70 -> 140 across a 70-wide winning bucket: each backer doubles their stake.
    await expect(coord.connect(payee).claimAppealReward(coordId, 0, 2)).to.changeEtherBalance(payee, cost);
    await expect(coord.connect(third).claimAppealReward(coordId, 0, 2)).to.changeEtherBalance(third, cost);
  });
});
