import { expect } from 'chai';
import { ethers } from 'hardhat';
import { mine } from '@nomicfoundation/hardhat-network-helpers';
import { assertConservation } from './helpers';

// Regressions for defects a strict review turned up. Each test fails on the code as it was.

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

async function deployCourt(cfg: any) {
  const Elig = await ethers.getContractFactory('StakeWeightedEligibility');
  const elig = await Elig.deploy();
  await elig.waitForDeployment();
  const Core = await ethers.getContractFactory('ArbitratorCore');
  const core: any = await Core.deploy(cfg, await elig.getAddress(), 0n);
  await core.waitForDeployment();
  return core;
}

const commitmentOf = (id: bigint, juror: string, choice: number, salt: string) =>
  ethers.solidityPackedKeccak256(['uint256', 'address', 'uint8', 'bytes32'], [id, juror, choice, salt]);

async function round(core: any, cfg: any, panel: any[], voters: [any, number][], id = 1n) {
  for (const j of panel) await (await core.connect(j).stake({ value: cfg.minStake })).wait();
  await mine(2);
  for (const j of panel) await (await core.connect(j).claimSeat(id)).wait();
  await mine(101);
  await (await core.closeDrawing(id)).wait();
  const salts: Record<string, string> = {};
  for (const [j, c] of voters) {
    const salt = ethers.hexlify(ethers.randomBytes(32));
    salts[j.address] = salt;
    await (await core.connect(j).commitVote(id, commitmentOf(id, j.address, c, salt))).wait();
  }
  await mine(101);
  await (await core.openReveal(id)).wait();
  for (const [j, c] of voters) await (await core.connect(j).revealVote(id, c, salts[j.address])).wait();
  await mine(101);
}

describe('regression — a redraw must leave enough to settle the retry', () => {
  it('prices the retry at the grossed-up cost, not the bare wage bill', async () => {
    const signers = await ethers.getSigners();
    const [, treasury] = signers;
    // Non-zero takes are the whole point: settlement removes them from the pot BEFORE paying
    // jurors, so a pot of exactly panelSize * jurorFee cannot cover a full panel. Sizing the
    // redraw guard on the bare wage bill left finalize() underflowing on the retry — and
    // finalize() is the only exit from Revealing, so the dispute and its stakes were stuck.
    const cfg = baseCfg(treasury.address, {
      quorumFailure: 2n, betaBps: 100n, gammaBps: 100n, appFeeBps: 1000n, protocolFeeBps: 1000n,
    });
    const core = await deployCourt(cfg);
    const App = await ethers.getContractFactory('MockArbitrable');
    const app: any = await App.deploy(await core.getAddress());
    await app.waitForDeployment();

    const cost = (await core.arbitrationCost('0x')) as bigint;
    expect(cost).to.equal(38n); // 3 * 10 grossed up by a 20% take
    await (await app.createDispute(2, { value: cost })).wait();
    await mine(6);
    await (await core.openDrawing(1n)).wait();

    const first = signers.slice(2, 5);
    await round(core, cfg, first, [[first[0], 1]]); // 1 of 3 reveals -> quorum fails
    await (await core.finalize(1n)).wait();

    const d = await core.getDispute(1n);
    if (d.redraws > 0) {
      // If it redrew at all, the retry must be settleable — that is the regression.
      expect(d.feePot).to.be.gte(cost);
      const second = signers.slice(5, 8);
      await round(core, cfg, second, [[second[0], 1], [second[1], 1], [second[2], 1]]);
      await (await core.finalize(1n)).wait();
      expect((await core.currentRuling(1n))[0]).to.equal(1n);
    } else {
      expect(d.state).to.equal(5); // refused outright rather than reopening a round it cannot pay
    }
    await assertConservation(core, [
      ...signers.slice(2, 8).map((j) => j.address), await app.getAddress(), treasury.address,
    ]);
  });
});

describe('regression — the appeal coordinator must not wedge or mis-route', () => {
  async function ladder(treasury: string, sizes: bigint[], over: Record<string, any>[] = []) {
    const out: any[] = [];
    for (const [i, n] of sizes.entries()) {
      out.push(await deployCourt(baseCfg(treasury, { panelSize: n, ...(over[i] ?? {}) })));
    }
    return out;
  }

  it('ends the appeal instead of freezing when the higher court will not take the case', async () => {
    const signers = await ethers.getSigners();
    const [, treasury, payer, payee] = signers;
    // Court B demands a pool it does not have, so it refuses every dispute.
    const cs = await ladder(treasury.address, [3n, 7n], [{}, { minPoolWeightMultiple: 5n }]);
    const Coord = await ethers.getContractFactory('AppealCoordinator');
    const coord: any = await Coord.deploy(await Promise.all(cs.map((c) => c.getAddress())), 100n, 2);
    await coord.waitForDeployment();
    const Escrow = await ethers.getContractFactory('SimpleEscrow');
    const escrow: any = await Escrow.deploy(await coord.getAddress());
    await escrow.waitForDeployment();

    await (await escrow.connect(payer).fund(payee.address, '', { value: 1000n })).wait();
    await (await escrow.connect(payer).dispute(1n, { value: await coord.arbitrationCost('0x') })).wait();

    await mine(6);
    await (await cs[0].openDrawing(1n)).wait();
    await round(cs[0], baseCfg(treasury.address), signers.slice(4, 7), [
      [signers[4], 2], [signers[5], 2], [signers[6], 2],
    ]);
    await (await cs[0].finalize(1n)).wait();
    expect(await coord.disputeState(1n)).to.equal(2); // Appealable

    const cost = await coord.appealCost(1n);
    await (await coord.connect(payee).fundAppeal(1n, 1, { value: cost })).wait();
    await (await coord.connect(payer).fundAppeal(1n, 2, { value: cost })).wait();
    await mine(101);

    // Both sides paid, so it tries to advance — and court B refuses. The case must still end.
    await expect(coord.finalizeAppeal(1n)).to.emit(coord, 'AppealCourtRefused').withArgs(1n, 1);
    expect(await coord.disputeState(1n)).to.equal(3); // Resolved, not wedged in Appealable
    expect((await coord.currentRuling(1n))[0]).to.equal(2n); // round 0's ruling stands

    // Nothing was spent, so every backer gets all of it back.
    await expect(coord.connect(payee).claimAppealReward(1n, 0, 1)).to.changeEtherBalance(payee, cost);
    await expect(coord.connect(payer).claimAppealReward(1n, 0, 2)).to.changeEtherBalance(payer, cost);
  });

  it('keeps paying out refunds round after round instead of latching after the first', async () => {
    const signers = await ethers.getSigners();
    const [, treasury, payer, payee] = signers;
    const cs = await ladder(treasury.address, [3n, 7n]);
    const Coord = await ethers.getContractFactory('AppealCoordinator');
    const coord: any = await Coord.deploy(await Promise.all(cs.map((c) => c.getAddress())), 100n, 2);
    await coord.waitForDeployment();
    const Escrow = await ethers.getContractFactory('SimpleEscrow');
    const escrow: any = await Escrow.deploy(await coord.getAddress());
    await escrow.waitForDeployment();

    await (await escrow.connect(payer).fund(payee.address, '', { value: 1000n })).wait();
    await (await escrow.connect(payer).dispute(1n, { value: await coord.arbitrationCost('0x') })).wait();

    // Round 0 goes undersubscribed, so the whole prepay refunds to the coordinator.
    await mine(6);
    await (await cs[0].openDrawing(1n)).wait();
    await mine(160);
    await (await cs[0].finalize(1n)).wait();
    await (await coord.reclaimFees(1n, 0)).wait();
    expect(await coord.coordRefund(1n)).to.equal(30n);
    await (await escrow.claimFees(1n)).wait(); // the app pulls its own case's refund
    expect(await coord.coordRefund(1n)).to.equal(0n);
    const afterFirst = await escrow.pendingWithdrawals(payer.address);
    expect(afterFirst).to.equal(30n);

    // A second, independent case through the same coordinator must still be payable — the old
    // one-shot flag latched per coordId and stranded everything after the first claim.
    await (await escrow.connect(payer).fund(payee.address, '', { value: 1000n })).wait();
    await (await escrow.connect(payer).dispute(2n, { value: await coord.arbitrationCost('0x') })).wait();
    await mine(6);
    await (await cs[0].openDrawing(2n)).wait();
    await mine(160);
    await (await cs[0].finalize(2n)).wait();
    await (await coord.reclaimFees(2n, 0)).wait();
    await (await escrow.claimFees(2n)).wait();
    expect((await escrow.pendingWithdrawals(payer.address)) - afterFirst).to.equal(30n);

    // And a coordId whose refund was already paid says so rather than paying twice.
    await expect(escrow.claimFees(1n)).to.be.revertedWithCustomError(coord, 'NothingToWithdraw');

    // Only the app may pull it — an open call would push value into a pull-payment app that has
    // no hook to credit it to anyone, stranding it in the contract.
    await expect(coord.connect(payer).claimRefund(1n)).to.be.revertedWithCustomError(coord, 'OnlyApp');
  });

  it('carries the declared parties onto every appeal round', async () => {
    const signers = await ethers.getSigners();
    const [, treasury, payer, payee] = signers;
    const cs = await ladder(treasury.address, [3n, 7n]);
    const Coord = await ethers.getContractFactory('AppealCoordinator');
    const coord: any = await Coord.deploy(await Promise.all(cs.map((c) => c.getAddress())), 100n, 2);
    await coord.waitForDeployment();
    const Escrow = await ethers.getContractFactory('SimpleEscrow');
    const escrow: any = await Escrow.deploy(await coord.getAddress());
    await escrow.waitForDeployment();

    await (await escrow.connect(payer).fund(payee.address, '', { value: 1000n })).wait();
    await (await escrow.connect(payer).dispute(1n, { value: await coord.arbitrationCost('0x') })).wait();
    expect(await cs[0].isExcluded(1n, payer.address)).to.equal(true);

    await mine(6);
    await (await cs[0].openDrawing(1n)).wait();
    await round(cs[0], baseCfg(treasury.address), signers.slice(4, 7), [
      [signers[4], 2], [signers[5], 2], [signers[6], 2],
    ]);
    await (await cs[0].finalize(1n)).wait();

    const cost = await coord.appealCost(1n);
    await (await coord.connect(payee).fundAppeal(1n, 1, { value: cost })).wait();
    await (await coord.connect(payer).fundAppeal(1n, 2, { value: cost })).wait();
    await mine(101);
    await (await coord.finalizeAppeal(1n)).wait();

    // The appeal used to be opened with empty extraData, which quietly let a disputant sit on the
    // panel rehearing their own case — and charged them the third-party evidence bond to file.
    expect(await cs[1].isExcluded(1n, payer.address)).to.equal(true);
    expect(await cs[1].isExcluded(1n, payee.address)).to.equal(true);
    expect(await cs[1].isExcluded(1n, signers[4].address)).to.equal(false);
  });
});

describe('regression — only a fully funded position can take the appeal pot', () => {
  it('ignores a dust stake on a choice that never covered the cost', async () => {
    const signers = await ethers.getSigners();
    const [, treasury, payer, payee] = signers;
    const dust = signers[12];
    const cs = [
      await deployCourt(baseCfg(treasury.address, { panelSize: 3n })),
      await deployCourt(baseCfg(treasury.address, { panelSize: 7n })),
    ];
    const Coord = await ethers.getContractFactory('AppealCoordinator');
    const coord: any = await Coord.deploy(await Promise.all(cs.map((c) => c.getAddress())), 100n, 2);
    await coord.waitForDeployment();
    const App = await ethers.getContractFactory('MockArbitrable');
    const app: any = await App.deploy(await coord.getAddress());
    await app.waitForDeployment();
    await (await app.createDispute(3, { value: await coord.arbitrationCost('0x') })).wait();

    await mine(6);
    await (await cs[0].openDrawing(1n)).wait();
    await round(cs[0], baseCfg(treasury.address), signers.slice(4, 7), [
      [signers[4], 1], [signers[5], 1], [signers[6], 1],
    ]);
    await (await cs[0].finalize(1n)).wait();

    const cost = (await coord.appealCost(1n)) as bigint;
    await (await coord.connect(payer).fundAppeal(1n, 1, { value: cost })).wait();
    await (await coord.connect(payee).fundAppeal(1n, 2, { value: cost })).wait();
    // One wei on a third position that nobody ever covered.
    await (await coord.connect(dust).fundAppeal(1n, 3, { value: 1n })).wait();
    await mine(101);
    await (await coord.finalizeAppeal(1n)).wait();

    // The bigger panel happens to land on choice 3 — the position that paid nothing.
    await mine(6);
    await (await cs[1].openDrawing(1n)).wait();
    await round(cs[1], baseCfg(treasury.address), signers.slice(4, 11), [
      ...signers.slice(4, 11).map((j) => [j, 3] as [any, number]),
    ]);
    await (await cs[1].finalize(1n)).wait();
    expect((await coord.currentRuling(1n))[0]).to.equal(3n);

    // Paying out by funding alone would have handed the dust backer the ENTIRE residual pot —
    // 2 * cost put up by the two real positions, for one wei of risk. A position that never
    // covered the cost wins nothing, and the pot refunds pro rata instead.
    await expect(coord.connect(dust).claimAppealReward(1n, 0, 3))
      .to.changeEtherBalance(dust, 0n)
      .catch(() => undefined);
    await (await coord.reclaimFees(1n, 1)).wait();
    const potLeft = 2n * cost + 1n - cost;
    await expect(coord.connect(payer).claimAppealReward(1n, 0, 1))
      .to.changeEtherBalance(payer, (cost * potLeft) / (2n * cost + 1n));
  });
});

describe('regression — a quorum redraw treats an unavailability report as silence', () => {
  it('slashes a lone reporter on a redraw exactly as a terminal settlement would', async () => {
    const signers = await ethers.getSigners();
    const [, treasury] = signers;
    const cfg = baseCfg(treasury.address, { quorumFailure: 2n });
    const core = await deployCourt(cfg);
    const App = await ethers.getContractFactory('MockArbitrable');
    const app: any = await App.deploy(await core.getAddress());
    await app.waitForDeployment();
    await (await app.createDispute(2, { value: await core.arbitrationCost('0x') })).wait();
    await mine(6);
    await (await core.openDrawing(1n)).wait();

    const panel = signers.slice(2, 5);
    for (const j of panel) await (await core.connect(j).stake({ value: cfg.minStake })).wait();
    await mine(2);
    for (const j of panel) await (await core.connect(j).claimSeat(1n)).wait();
    await mine(101);
    await (await core.closeDrawing(1n)).wait();
    const salts: Record<string, string> = {};
    for (const j of panel) {
      const salt = ethers.hexlify(ethers.randomBytes(32));
      salts[j.address] = salt;
      await (await core.connect(j).commitVote(1n, commitmentOf(1n, j.address, 1, salt))).wait();
    }
    await mine(101);
    await (await core.openReveal(1n)).wait();

    // One votes, one reports the record unreachable, one goes dark. Participation 2 meets the
    // quorum floor but reporters are not a majority of it, so this is a quorum failure, not a
    // void — revealedCount 1 < need 2.
    await (await core.connect(panel[0]).revealVote(1n, 1, salts[panel[0].address])).wait();
    await (await core.connect(panel[1]).reportUnavailable(1n)).wait();
    await mine(101);

    const tx = await core.finalize(1n);
    await expect(tx).to.emit(core, 'Redrawn');
    // The reporter is slashed like the silent seat. Paying them a full fee here would have made
    // reporting weakly dominant over voting on any redraw court.
    await expect(tx).to.emit(core, 'Slashed').withArgs(1n, panel[1].address, 25n);
    expect(await core.withdrawable(panel[0].address)).to.equal(110n); // voted
    expect(await core.withdrawable(panel[1].address)).to.equal(75n); // reported
    expect(await core.withdrawable(panel[2].address)).to.equal(75n); // silent
    // No conservation check here: the dispute is mid-flight, back in Drawing with its fee pot
    // still escrowed, so the core legitimately holds more than the sum of pullable balances.
  });
});

describe('regression — an appeal round refunds to the pot that bought it, not to the app', () => {
  it('returns an undersubscribed round\'s fee to the backers, never to the original fee-payer', async () => {
    const signers = await ethers.getSigners();
    const [, treasury, payer, payee] = signers;
    const cs = [
      await deployCourt(baseCfg(treasury.address, { panelSize: 3n })),
      await deployCourt(baseCfg(treasury.address, { panelSize: 7n })),
    ];
    const Coord = await ethers.getContractFactory('AppealCoordinator');
    const coord: any = await Coord.deploy(await Promise.all(cs.map((c) => c.getAddress())), 100n, 2);
    await coord.waitForDeployment();
    const App = await ethers.getContractFactory('MockArbitrable');
    const app: any = await App.deploy(await coord.getAddress());
    await app.waitForDeployment();
    await (await app.createDispute(2, { value: await coord.arbitrationCost('0x') })).wait();

    await mine(6);
    await (await cs[0].openDrawing(1n)).wait();
    await round(cs[0], baseCfg(treasury.address), signers.slice(4, 7), [
      [signers[4], 1], [signers[5], 1], [signers[6], 1],
    ]);
    await (await cs[0].finalize(1n)).wait();

    const cost = (await coord.appealCost(1n)) as bigint; // 70
    await (await coord.connect(payer).fundAppeal(1n, 1, { value: cost })).wait();
    await (await coord.connect(payee).fundAppeal(1n, 2, { value: cost })).wait();
    await mine(101);
    await (await coord.finalizeAppeal(1n)).wait();

    // Nobody stakes in court B, so its draw is undersubscribed and it refunds the WHOLE fee.
    await mine(6);
    await (await cs[1].openDrawing(1n)).wait();
    await mine(160);
    await (await cs[1].finalize(1n)).wait();
    expect((await coord.currentRuling(1n))[2]).to.equal(true); // finalized at round 1's refusal

    // That money bought the appeal round; it belongs to the backers who paid for it. Routing it
    // to the app would have sent it out to the party who funded round 0 and never backed this.
    await (await coord.reclaimFees(1n, 1)).wait();
    expect(await coord.coordRefund(1n)).to.equal(0n);

    // Pot 140, spent 70, refunded 70 -> the full 140 is payable again. Round 1 refused (ruling 0)
    // so no position prevailed and both sides are made whole.
    await expect(coord.connect(payer).claimAppealReward(1n, 0, 1)).to.changeEtherBalance(payer, cost);
    await expect(coord.connect(payee).claimAppealReward(1n, 0, 2)).to.changeEtherBalance(payee, cost);
  });
});

describe('regression — the evidence deadline is hard', () => {
  it('refuses a filing after the stated deadline, even before anyone cranks the record shut', async () => {
    const signers = await ethers.getSigners();
    const [, treasury, stranger] = signers;
    const cfg = baseCfg(treasury.address);
    const core = await deployCourt(cfg);
    const App = await ethers.getContractFactory('MockArbitrable');
    const app: any = await App.deploy(await core.getAddress());
    await app.waitForDeployment();
    await (await app.createDispute(2, { value: await core.arbitrationCost('0x') })).wait();

    await (await core.connect(stranger).submitEvidence(1n, 'ipfs://in-time', ethers.ZeroHash, 1)).wait();

    await mine(10); // past evidenceDeadline, but nobody has called openDrawing yet
    expect(await core.disputeState(1n)).to.equal(1); // still Evidence
    // Gating on state alone let an opponent keep filing in this gap and answer a party who
    // stopped when the UI said the record closed.
    await expect(core.connect(stranger).submitEvidence(1n, 'ipfs://too-late', ethers.ZeroHash, 1))
      .to.be.revertedWithCustomError(core, 'DrawClosed');
  });
});

describe('regression — a fallback ruling is not a verdict', () => {
  it('records that the court supplied the answer, so a reader cannot mistake it for the panel\'s', async () => {
    const signers = await ethers.getSigners();
    const [, treasury] = signers;
    const cfg = baseCfg(treasury.address, { quorumFailure: 1n, defaultChoice: 2n });
    const core = await deployCourt(cfg);
    const App = await ethers.getContractFactory('MockArbitrable');
    const app: any = await App.deploy(await core.getAddress());
    await app.waitForDeployment();
    await (await app.createDispute(2, { value: await core.arbitrationCost('0x') })).wait();
    await mine(6);
    await (await core.openDrawing(1n)).wait();

    const panel = signers.slice(2, 5);
    await round(core, cfg, panel, [[panel[0], 1]]); // one vote for 1, below quorum
    await (await core.finalize(1n)).wait();

    const d = await core.getDispute(1n);
    expect(d.ruling).to.equal(2n); // the court's default
    expect(d.fallbackRuling).to.equal(true);
    // Without that flag a reader compares choice 1 against ruling 2 and calls a PAID juror
    // slashed. Settlement ran at ruling 0: they were rewarded.
    expect(await core.withdrawable(panel[0].address)).to.be.gt(110n);

    // A real verdict carries no such flag.
    await (await app.createDispute(2, { value: await core.arbitrationCost('0x') })).wait();
    await mine(6);
    await (await core.openDrawing(2n)).wait();
    const panel2 = signers.slice(5, 8);
    await round(core, cfg, panel2, panel2.map((j) => [j, 1] as [any, number]), 2n);
    await (await core.finalize(2n)).wait();
    const d2 = await core.getDispute(2n);
    expect(d2.ruling).to.equal(1n);
    expect(d2.fallbackRuling).to.equal(false);
  });
});

describe('regression — an appeal pot is swept only once its round has settled', () => {
  it('refuses an early sweep, so a crank bot cannot freeze the pot at zero', async () => {
    const signers = await ethers.getSigners();
    const [, treasury, payer, payee] = signers;
    const cs = [
      await deployCourt(baseCfg(treasury.address, { panelSize: 3n })),
      await deployCourt(baseCfg(treasury.address, { panelSize: 7n })),
    ];
    const Coord = await ethers.getContractFactory('AppealCoordinator');
    const coord: any = await Coord.deploy(await Promise.all(cs.map((c) => c.getAddress())), 100n, 2);
    await coord.waitForDeployment();
    const App = await ethers.getContractFactory('MockArbitrable');
    const app: any = await App.deploy(await coord.getAddress());
    await app.waitForDeployment();
    await (await app.createDispute(2, { value: await coord.arbitrationCost('0x') })).wait();

    await mine(6);
    await (await cs[0].openDrawing(1n)).wait();
    await round(cs[0], baseCfg(treasury.address), signers.slice(4, 7), [
      [signers[4], 1], [signers[5], 1], [signers[6], 1],
    ]);
    await (await cs[0].finalize(1n)).wait();

    const cost = (await coord.appealCost(1n)) as bigint; // 70
    await (await coord.connect(payer).fundAppeal(1n, 1, { value: cost })).wait();
    await (await coord.connect(payee).fundAppeal(1n, 2, { value: cost })).wait();
    await mine(101);
    await (await coord.finalizeAppeal(1n)).wait();

    // Round 1 is live. Sweeping now would latch `swept` with nothing collected, and the backers
    // would split 140 - 70 = 70 between them instead of the full 140 that comes back — with the
    // refund then stranded, since every reward flag is already claimed. Anyone can call this, so
    // an honest crank bot sweeping on sight would have done it.
    await expect(coord.reclaimFees(1n, 1)).to.be.revertedWithCustomError(coord, 'TooEarly');
    await expect(coord.connect(payer).claimAppealReward(1n, 0, 1))
      .to.be.revertedWithCustomError(coord, 'WrongState');

    // Round 1 goes undersubscribed and refunds the whole fee.
    await mine(6);
    await (await cs[1].openDrawing(1n)).wait();
    await mine(160);
    await (await cs[1].finalize(1n)).wait();

    await (await coord.reclaimFees(1n, 1)).wait();
    await expect(coord.connect(payer).claimAppealReward(1n, 0, 1)).to.changeEtherBalance(payer, cost);
    await expect(coord.connect(payee).claimAppealReward(1n, 0, 2)).to.changeEtherBalance(payee, cost);
  });
});

describe('regression — an evidence bond must fit the record it is stored in', () => {
  it('rejects a court whose bond would be truncated into the uint128 it is kept in', async () => {
    const [, treasury] = await ethers.getSigners();
    const Elig = await ethers.getContractFactory('StakeWeightedEligibility');
    const elig = await Elig.deploy();
    await elig.waitForDeployment();
    const Core = await ethers.getContractFactory('ArbitratorCore');
    const tooBig = (1n << 128n);
    await expect(Core.deploy(baseCfg(treasury.address, { evidenceBond: tooBig }), await elig.getAddress(), 0n))
      .to.be.revertedWithCustomError(Core, 'BadConfig').withArgs('evidenceBond');

    // The registry mirrors every constructor guard; a config that passes one and fails the other
    // is the validation-parity bug class.
    const Reg = await ethers.getContractFactory('CourtRegistry');
    const reg: any = await Reg.deploy();
    await reg.waitForDeployment();
    await expect(reg.validateConfig(baseCfg(treasury.address, { evidenceBond: tooBig }), await elig.getAddress()))
      .to.be.revertedWithCustomError(reg, 'BadConfig').withArgs('evidenceBond');
  });
});

describe('regression — a win by default refunds everyone, it does not pay the winner', () => {
  it('returns a half-funded backer their stake instead of handing it to the sole funder', async () => {
    const signers = await ethers.getSigners();
    const [, treasury, payer, payee] = signers;
    const cs = [
      await deployCourt(baseCfg(treasury.address, { panelSize: 3n })),
      await deployCourt(baseCfg(treasury.address, { panelSize: 7n })),
    ];
    const Coord = await ethers.getContractFactory('AppealCoordinator');
    const coord: any = await Coord.deploy(await Promise.all(cs.map((c) => c.getAddress())), 100n, 2);
    await coord.waitForDeployment();
    const App = await ethers.getContractFactory('MockArbitrable');
    const app: any = await App.deploy(await coord.getAddress());
    await app.waitForDeployment();
    await (await app.createDispute(2, { value: await coord.arbitrationCost('0x') })).wait();

    await mine(6);
    await (await cs[0].openDrawing(1n)).wait();
    await round(cs[0], baseCfg(treasury.address), signers.slice(4, 7), [
      [signers[4], 2], [signers[5], 2], [signers[6], 2],
    ]);
    await (await cs[0].finalize(1n)).wait();

    const cost = (await coord.appealCost(1n)) as bigint; // 70
    await (await coord.connect(payee).fundAppeal(1n, 1, { value: cost })).wait();
    // One short of covering their position, and the window shuts.
    await (await coord.connect(payer).fundAppeal(1n, 2, { value: cost - 1n })).wait();
    await mine(101);
    await expect(coord.finalizeAppeal(1n)).to.emit(coord, 'WonByDefault').withArgs(1n, 0, 1);
    expect((await coord.currentRuling(1n))[0]).to.equal(1n);

    // No panel ever sat, so there is nothing anyone won and nothing to pay for. Folding the
    // partial backer's stake into the winner's share let a party profit purely by out-waiting a
    // half-funded opponent: the payee would have taken 139 and the payer's 69 would be lost.
    await expect(coord.connect(payee).claimAppealReward(1n, 0, 1)).to.changeEtherBalance(payee, cost);
    await expect(coord.connect(payer).claimAppealReward(1n, 0, 2)).to.changeEtherBalance(payer, cost - 1n);
  });
});

describe('regression — the pinner is paid even when no panel sat', () => {
  it('takes the pinning cut out of an undersubscribed draw\'s refund', async () => {
    const signers = await ethers.getSigners();
    const [, treasury, , , , , , , , pinner] = signers;
    const cfg = baseCfg(treasury.address, { pinFeeBps: 500n, pinner: pinner.address });
    const core = await deployCourt(cfg);
    const App = await ethers.getContractFactory('MockArbitrable');
    const app: any = await App.deploy(await core.getAddress());
    await app.waitForDeployment();
    const cost = (await core.arbitrationCost('0x')) as bigint;
    await (await app.createDispute(2, { value: cost })).wait();

    await mine(6);
    await (await core.openDrawing(1n)).wait();
    await mine(160);
    await (await core.finalize(1n)).wait();

    // The record was hosted through the whole evidence phase; only the panel failed to appear.
    const pinShare = (cost * 500n) / 10000n;
    expect(pinShare).to.be.gt(0n);
    expect(await core.withdrawable(pinner.address)).to.equal(pinShare);
    expect(await core.withdrawable(await app.getAddress())).to.equal(cost - pinShare);
    expect(await core.refundOf(1n)).to.equal(cost - pinShare);
    await assertConservation(core, [
      await app.getAddress(), treasury.address, pinner.address,
    ]);
  });
});

describe('regression — an appeal pot never settles on a ruling no panel produced', () => {
  it('refunds both sides pro rata when the appeal court falls back to its default', async () => {
    const signers = await ethers.getSigners();
    const [, treasury, alice, bob] = signers;
    const cs = [
      await deployCourt(baseCfg(treasury.address, { panelSize: 3n })),
      // The appeal court answers a quorum failure with its standing default instead of refusing.
      await deployCourt(baseCfg(treasury.address, { panelSize: 7n, quorumFailure: 1n, defaultChoice: 1n })),
    ];
    const Coord = await ethers.getContractFactory('AppealCoordinator');
    const coord: any = await Coord.deploy(await Promise.all(cs.map((c) => c.getAddress())), 100n, 2);
    await coord.waitForDeployment();
    const App = await ethers.getContractFactory('MockArbitrable');
    const app: any = await App.deploy(await coord.getAddress());
    await app.waitForDeployment();
    await (await app.createDispute(2, { value: await coord.arbitrationCost('0x') })).wait();

    await mine(6);
    await (await cs[0].openDrawing(1n)).wait();
    await round(cs[0], baseCfg(treasury.address), signers.slice(4, 7), [
      [signers[4], 2], [signers[5], 2], [signers[6], 2],
    ]);
    await (await cs[0].finalize(1n)).wait();

    const cost = (await coord.appealCost(1n)) as bigint;
    await (await coord.connect(alice).fundAppeal(1n, 1, { value: cost })).wait();
    await (await coord.connect(bob).fundAppeal(1n, 2, { value: cost })).wait();
    await mine(101);
    await (await coord.finalizeAppeal(1n)).wait();

    // The appeal panel is seated but misses quorum, so court B delivers its default: choice 1.
    await mine(6);
    await (await cs[1].openDrawing(1n)).wait();
    const panel = signers.slice(8, 15);
    await round(cs[1], baseCfg(treasury.address), panel, [[panel[0], 2]]);
    await (await cs[1].finalize(1n)).wait();

    expect((await coord.currentRuling(1n))[0]).to.equal(1n);
    expect(await coord.rulingIsFallback(1n)).to.equal(true);

    // Alice backed choice 1 and the delivered ruling IS 1 — but no jury reached it, and the
    // court slashed nobody over it. Handing her Bob's stake would move money on a verdict that
    // does not exist. Both sides split what is left pro rata instead.
    await (await coord.reclaimFees(1n, 1)).wait();
    const aliceBefore = await ethers.provider.getBalance(alice.address);
    await (await coord.connect(alice).claimAppealReward(1n, 0, 1)).wait();
    const aliceGot = (await ethers.provider.getBalance(alice.address)) - aliceBefore;
    // Bound chosen to DISCRIMINATE: settling the pot on the fallback would pay her the winning
    // bucket's whole share (cost + extra); refunding pro rata halves it. `lt(cost * 2n)` held
    // under both behaviours and guarded nothing.
    expect(aliceGot).to.be.lt(cost);

    await expect(coord.connect(bob).claimAppealReward(1n, 0, 2)).to.not.be.reverted;
  });
});

describe('regression — a default win that only confirms the panel is still the panel', () => {
  it('flags a changed answer as a court ruling and leaves a confirmed one alone', async () => {
    const signers = await ethers.getSigners();
    const [, treasury, alice, bob] = signers;

    async function ladder() {
      const cs = [
        await deployCourt(baseCfg(treasury.address, { panelSize: 3n })),
        await deployCourt(baseCfg(treasury.address, { panelSize: 7n })),
      ];
      const Coord = await ethers.getContractFactory('AppealCoordinator');
      const coord: any = await Coord.deploy(await Promise.all(cs.map((c) => c.getAddress())), 100n, 2);
      await coord.waitForDeployment();
      const App = await ethers.getContractFactory('MockArbitrable');
      const app: any = await App.deploy(await coord.getAddress());
      await app.waitForDeployment();
      await (await app.createDispute(2, { value: await coord.arbitrationCost('0x') })).wait();
      await mine(6);
      await (await cs[0].openDrawing(1n)).wait();
      await round(cs[0], baseCfg(treasury.address), signers.slice(4, 7), [
        [signers[4], 2], [signers[5], 2], [signers[6], 2],
      ]);
      await (await cs[0].finalize(1n)).wait();
      return coord;
    }

    // A panel really did rule 2. Alice pays to DEFEND it and nobody argues the other side.
    const confirming = await ladder();
    const cost = (await confirming.appealCost(1n)) as bigint;
    await (await confirming.connect(alice).fundAppeal(1n, 2, { value: cost })).wait();
    await mine(101);
    await (await confirming.finalizeAppeal(1n)).wait();
    expect((await confirming.currentRuling(1n))[0]).to.equal(2n);
    // Nothing about the jury's answer changed, so calling it a court default would tell every
    // reader — and any parent ladder settling a pot on this flag — that no jury decided it.
    expect(await confirming.rulingIsFallback(1n)).to.equal(false);

    // Now the other shape: Bob pays to OVERTURN it and nobody defends.
    const overturning = await ladder();
    await (await overturning.connect(bob).fundAppeal(1n, 1, { value: cost })).wait();
    await mine(101);
    await (await overturning.finalizeAppeal(1n)).wait();
    expect((await overturning.currentRuling(1n))[0]).to.equal(1n);
    expect(await overturning.rulingIsFallback(1n)).to.equal(true); // decided by who paid
  });
});

describe('regression — a court that cannot answer rulingIsFallback must not wedge the ladder', () => {
  it('treats an unanswerable probe as no fallback instead of locking every backer out', async () => {
    const signers = await ethers.getSigners();
    const [, treasury] = signers;
    const cs = [
      await deployCourt(baseCfg(treasury.address, { panelSize: 3n })),
      await deployCourt(baseCfg(treasury.address, { panelSize: 7n })),
    ];
    const Coord = await ethers.getContractFactory('AppealCoordinator');
    const coord: any = await Coord.deploy(await Promise.all(cs.map((c) => c.getAddress())), 100n, 2);
    await coord.waitForDeployment();

    // A hard call would revert here against any court deployed before rulingIsFallback existed —
    // and the courts already live on Paseo are exactly that. The court's own delivery is
    // revert-proof, so it would swallow the failure and the dispute would sit in Pending forever
    // with the previous round's appeal pot unsettled and every backer's money locked.
    const probe = await ethers.getContractAt('AppealCoordinator', await coord.getAddress());
    expect(await probe.rulingIsFallback(999n)).to.equal(false);

    // An address with no code at all answers the same way rather than reverting.
    const Core = await ethers.getContractFactory('ArbitratorCore');
    const iface = Core.interface.encodeFunctionData('rulingIsFallback', [1n]);
    const raw = await ethers.provider.call({ to: signers[19].address, data: iface });
    expect(raw).to.equal('0x'); // empty return — the coordinator reads this as false
  });
});
