import { expect } from 'chai';
import { ethers } from 'hardhat';
import { mine } from '@nomicfoundation/hardhat-network-helpers';
import { assertConservation } from './helpers';

// FR-ST-03 — what a court does when the panel produces no verdict of its own.
//
//   Redraw:  slash the silent, pay whoever turned up, and spend the forfeited stake on a fresh
//            panel. Capped at two attempts, and skipped outright if the pot cannot pay for one.
//            Note that every seat from the failed round is RELEASED — paid or slashed, its stake
//            leaves the pool — so the retry is heard by whoever else is staked, never by the same
//            jurors who just walked away from it.
//   Default: hand the app a configured answer — but settle the jurors at ruling 0 regardless, so
//            nobody is ever slashed against a number the votes did not produce (FR-ST-02).
//   Refuse:  ruling 0, as before.

function baseCfg(treasury: string, over: Record<string, any> = {}) {
  return {
    minStake: 100n, jurorFee: 10n, drawThreshold: ethers.MaxUint256,
    evidenceBond: 0n,
    evidenceBlocks: 5n, activationDelayBlocks: 0n, drawDelayBlocks: 1n, drawWindowBlocks: 100n,
    commitBlocks: 100n, revealBlocks: 100n, panelSize: 3n,
    betaBps: 1000n, gammaBps: 2500n, thetaBps: 2000n, quorumBps: 5000n,
    commitRequired: true, minPoolWeightMultiple: 0n,
    quorumFailure: 0n, tieBreak: 0n, defaultChoice: 0n,
    appFeeBps: 0n, protocolFeeBps: 0n, pinFeeBps: 0n,
    treasury, pinner: ethers.ZeroAddress, ...over,
  };
}

/** A court, an app, and a dispute already in Drawing. Jurors stake per round, not up front. */
async function open(cfg: any, choices = 2) {
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

/** Stake `panel`, seat them, and reveal exactly `voters`. Leaves the dispute past its reveal end. */
async function round(core: any, cfg: any, panel: any[], voters: [any, number][]) {
  for (const j of panel) await (await core.connect(j).stake({ value: cfg.minStake })).wait();
  await mine(2);
  for (const j of panel) await (await core.connect(j).claimSeat(1n)).wait();
  await mine(101);
  await (await core.closeDrawing(1n)).wait();
  const salts: Record<string, string> = {};
  for (const [j, c] of voters) {
    const salt = ethers.hexlify(ethers.randomBytes(32));
    salts[j.address] = salt;
    await (await core.connect(j).commitVote(1n, commitmentOf(1n, j.address, c, salt))).wait();
  }
  await mine(101);
  await (await core.openReveal(1n)).wait();
  for (const [j, c] of voters) await (await core.connect(j).revealVote(1n, c, salts[j.address])).wait();
  await mine(101);
}

async function raise(core: any, app: any, choices = 2) {
  await (await app.createDispute(choices, { value: await core.arbitrationCost('0x') })).wait();
  await mine(6);
  await (await core.openDrawing(1n)).wait();
}

describe('FR-ST-03 — redrawing a panel nobody turned up for', () => {
  it('slashes the silent, pays the one who showed, and funds a fresh panel from the forfeits', async () => {
    const signers = await ethers.getSigners();
    const [, treasury] = signers;
    const cfg = baseCfg(treasury.address, { quorumFailure: 2n });
    const { core, app } = await open(cfg);
    await raise(core, app);

    const first = signers.slice(2, 5);
    // Only one of three reveals: need = ceil(3 * 50%) = 2, so quorum fails.
    await round(core, cfg, first, [[first[0], 1]]);
    const tx = await core.finalize(1n);
    await expect(tx).to.emit(core, 'Redrawn');
    await expect(tx).to.emit(core, 'Slashed').withArgs(1n, first[1].address, 25n);
    await expect(tx).to.emit(core, 'Slashed').withArgs(1n, first[2].address, 25n);

    // Back in Drawing on a brand-new seed, with the round wiped.
    const d = await core.getDispute(1n);
    expect(d.state).to.equal(2); // Drawing
    expect(d.redraws).to.equal(1);
    expect(d.seatCount).to.equal(0n);
    expect(d.revealedCount).to.equal(0n);
    expect((await core.getSeats(1n)).length).to.equal(0);
    expect((await core.jurorRoundOf(1n, first[0].address)).committed).to.equal(false);

    // The juror who turned up was paid and released; the two who did not funded the retry.
    expect(await core.withdrawable(first[0].address)).to.equal(110n);
    expect(await core.withdrawable(first[1].address)).to.equal(75n);
    expect(d.feePot).to.equal(30n - 10n + 50n); // prepay less the wage paid, plus both gamma slashes

    // Second attempt, heard by the jurors who are still staked: the case decides normally.
    const second = signers.slice(5, 8);
    await round(core, cfg, second, [[second[0], 1], [second[1], 1], [second[2], 1]]);
    await (await core.finalize(1n)).wait();
    expect((await core.currentRuling(1n))[0]).to.equal(1n);
    for (const j of second) expect(await core.withdrawable(j.address)).to.equal(110n);
    await assertConservation(core, [
      ...signers.slice(2, 8).map((j) => j.address), await app.getAddress(), treasury.address,
    ]);
  });

  it('stops after two attempts and refuses rather than burning a third panel', async () => {
    const signers = await ethers.getSigners();
    const [, treasury] = signers;
    const cfg = baseCfg(treasury.address, { quorumFailure: 2n });
    const { core, app } = await open(cfg);
    await raise(core, app);

    for (let attempt = 1; attempt <= 2; attempt++) {
      await round(core, cfg, signers.slice(2 + 3 * (attempt - 1), 5 + 3 * (attempt - 1)), []);
      await expect(core.finalize(1n)).to.emit(core, 'Redrawn');
      expect((await core.getDispute(1n)).redraws).to.equal(attempt);
    }

    await round(core, cfg, signers.slice(8, 11), []);
    await expect(core.finalize(1n)).to.not.emit(core, 'Redrawn');
    expect((await core.getDispute(1n)).state).to.equal(5); // Resolved
    expect((await core.currentRuling(1n))[0]).to.equal(0n);
    await assertConservation(core, [
      ...signers.slice(2, 11).map((j) => j.address), await app.getAddress(), treasury.address,
    ]);
  });

  it('will not reopen a round the remaining fees cannot pay for', async () => {
    const signers = await ethers.getSigners();
    const [, treasury] = signers;
    // Wages 30, a thin 10% gamma, and every seat must reveal. Two do: 20 goes out in wages and
    // only 10 comes back from the one silent seat, leaving 20 against a 30 panel.
    const cfg = baseCfg(treasury.address, {
      quorumFailure: 2n, quorumBps: 10000n, betaBps: 1000n, gammaBps: 1000n,
    });
    const { core, app } = await open(cfg);
    await raise(core, app);

    const panel = signers.slice(2, 5);
    await round(core, cfg, panel, [[panel[0], 1], [panel[1], 1]]);
    await expect(core.finalize(1n)).to.not.emit(core, 'Redrawn');
    expect((await core.getDispute(1n)).state).to.equal(5); // Resolved, not reopened
    expect((await core.currentRuling(1n))[0]).to.equal(0n);
    await assertConservation(core, [
      ...panel.map((j) => j.address), await app.getAddress(), treasury.address,
    ]);
  });
});

describe('FR-ST-03 — a court that would rather answer than refuse', () => {
  it('hands the app its default on a quorum failure, without settling against it', async () => {
    const signers = await ethers.getSigners();
    const [, treasury] = signers;
    const cfg = baseCfg(treasury.address, { quorumFailure: 1n, defaultChoice: 2n });
    const { core, app } = await open(cfg);
    await raise(core, app);

    const panel = signers.slice(2, 5);
    // One reveal for choice 1 — below quorum. The court answers 2 anyway.
    await round(core, cfg, panel, [[panel[0], 1]]);
    await expect(core.finalize(1n)).to.emit(core, 'FallbackRuling').withArgs(1n, 2, false);

    const [ruling] = await core.currentRuling(1n);
    expect(ruling).to.equal(2n);
    // The juror revealed for 1 and the delivered answer is 2, yet they are rewarded, not slashed:
    // settlement saw ruling 0. Folding the fallback into settlement would punish them for a
    // number no vote produced. Stake 100 + fee 10 + their share of the two gamma slashes.
    expect(await core.withdrawable(panel[0].address)).to.equal(150n);
    expect(await core.withdrawable(panel[1].address)).to.equal(75n); // silent, gamma
    await assertConservation(core, [
      ...panel.map((j) => j.address), await app.getAddress(), treasury.address,
    ]);
  });

  it('breaks a genuine tie with the default and still slashes nobody', async () => {
    const signers = await ethers.getSigners();
    const [, treasury] = signers;
    const cfg = baseCfg(treasury.address, { panelSize: 5n, tieBreak: 1n, defaultChoice: 1n });
    const { core, app } = await open(cfg);
    await raise(core, app, 3);

    // 2-2-1 across three choices: a real split, with every seat revealing.
    const panel = signers.slice(2, 7);
    await round(core, cfg, panel, [
      [panel[0], 1], [panel[1], 1], [panel[2], 2], [panel[3], 2], [panel[4], 3],
    ]);
    const tx = await core.finalize(1n);
    await expect(tx).to.emit(core, 'FallbackRuling').withArgs(1n, 1, true);
    await expect(tx).to.not.emit(core, 'Slashed');

    const [ruling, tied] = await core.currentRuling(1n);
    expect(ruling).to.equal(1n);
    expect(tied).to.equal(true); // the app is told it was a tie, not a verdict
    for (const j of panel) expect(await core.withdrawable(j.address)).to.equal(110n);
    await assertConservation(core, [
      ...panel.map((j) => j.address), await app.getAddress(), treasury.address,
    ]);
  });

  it('refuses a court whose Default policy has no choice to fall back on', async () => {
    const [, treasury] = await ethers.getSigners();
    const Elig = await ethers.getContractFactory('StakeWeightedEligibility');
    const elig = await Elig.deploy();
    await elig.waitForDeployment();
    const Core = await ethers.getContractFactory('ArbitratorCore');
    await expect(Core.deploy(baseCfg(treasury.address, { tieBreak: 1n }), await elig.getAddress(), 0n))
      .to.be.revertedWithCustomError(Core, 'BadConfig').withArgs('defaultChoice');
    await expect(Core.deploy(baseCfg(treasury.address, { quorumFailure: 3n }), await elig.getAddress(), 0n))
      .to.be.revertedWithCustomError(Core, 'BadConfig').withArgs('quorumFailure');
  });

  it('falls back to refusing when the default is not a choice this dispute offers', async () => {
    const signers = await ethers.getSigners();
    const [, treasury] = signers;
    const cfg = baseCfg(treasury.address, { quorumFailure: 1n, defaultChoice: 5n });
    const { core, app } = await open(cfg);
    await raise(core, app, 2); // only choices 1 and 2 exist here
    const panel = signers.slice(2, 5);
    await round(core, cfg, panel, [[panel[0], 1]]);
    await expect(core.finalize(1n)).to.not.emit(core, 'FallbackRuling');
    expect((await core.currentRuling(1n))[0]).to.equal(0n);
  });
});
