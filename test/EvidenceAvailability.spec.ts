import { expect } from 'chai';
import { ethers } from 'hardhat';
import { mine } from '@nomicfoundation/hardhat-network-helpers';
import { assertConservation } from './helpers';

// FR-EV-06 — evidence availability.
//
//   The protocol funds pinning out of every arbitration fee (pinFeeBps -> pinner) and it CANNOT
//   verify that the pinner did the job. The enforcement is on the other side: a seated juror who
//   cannot retrieve the record says so instead of voting, and when most of the participating panel
//   says the same thing the dispute VOIDS — ruling 0, nobody slashed. A pinner who does not
//   deliver ends up voiding the cases they were paid to support.
//
//   Reporting is not a free exit. A lone reporter is just a juror who did not reveal, and takes
//   the same gamma as any other silence.

type Cfg = Record<string, any>;

function baseCfg(treasury: string, over: Cfg = {}): Cfg {
  return {
    minStake: 100n, jurorFee: 10n, drawThreshold: ethers.MaxUint256,
    evidenceBond: 0n,
    evidenceBlocks: 5n, activationDelayBlocks: 0n, drawDelayBlocks: 1n, drawWindowBlocks: 100n,
    commitBlocks: 100n, revealBlocks: 100n, panelSize: 3n,
    betaBps: 1000n, gammaBps: 2500n, thetaBps: 2000n, quorumBps: 5000n,
    appFeeBps: 0n, protocolFeeBps: 0n, pinFeeBps: 0n,
    treasury, pinner: ethers.ZeroAddress, ...over,
  };
}

/** A court, an app, `n` single-slot jurors, and a dispute seated and ready to reveal. */
async function seatedPanel(cfg: Cfg, n: number, choices = 2) {
  const rest = (await ethers.getSigners()).slice(2);
  const Elig = await ethers.getContractFactory('StakeWeightedEligibility');
  const elig = await Elig.deploy();
  await elig.waitForDeployment();
  const Core = await ethers.getContractFactory('ArbitratorCore');
  const core = (await Core.deploy(cfg, await elig.getAddress(), 0n)) as any;
  await core.waitForDeployment();
  const App = await ethers.getContractFactory('MockArbitrable');
  const app = (await App.deploy(await core.getAddress())) as any;
  await app.waitForDeployment();

  const jurors = rest.slice(0, n);
  for (const j of jurors) await (await core.connect(j).stake({ value: cfg.minStake })).wait();
  const cost = (await core.arbitrationCost('0x')) as bigint;
  await (await app.createDispute(choices, { value: cost })).wait();

  await mine(6);
  await (await core.openDrawing(1n)).wait();
  await mine(2);
  for (const j of jurors) await (await core.connect(j).claimSeat(1n)).wait();
  await mine(101);
  await (await core.closeDrawing(1n)).wait();
  return { core, app, jurors, cost, id: 1n };
}

const commitmentOf = (id: bigint, juror: string, choice: number, salt: string) =>
  ethers.solidityPackedKeccak256(['uint256', 'address', 'uint8', 'bytes32'], [id, juror, choice, salt]);

/** Commit `choice` for each juror (0 = commit nothing) and open the reveal window. */
async function commitAndOpen(core: any, id: bigint, jurors: any[], choices: number[]) {
  const salts: Record<string, string> = {};
  for (const [i, j] of jurors.entries()) {
    if (choices[i] === 0) continue;
    const salt = ethers.hexlify(ethers.randomBytes(32));
    salts[j.address] = salt;
    await (await core.connect(j).commitVote(id, commitmentOf(id, j.address, choices[i], salt))).wait();
  }
  await mine(101);
  await (await core.openReveal(id)).wait();
  return salts;
}

describe('FR-EV-06 — the record could not be reached', () => {
  it('voids the dispute when most of the panel that turned up reports it, slashing nobody', async () => {
    const [, treasury] = await ethers.getSigners();
    const cfg = baseCfg(treasury.address);
    const { core, app, jurors, cost, id } = await seatedPanel(cfg, 3);
    const salts = await commitAndOpen(core, id, jurors, [1, 1, 1]);

    // Two of the three cannot retrieve the evidence; the third votes anyway.
    await expect(core.connect(jurors[0]).reportUnavailable(id))
      .to.emit(core, 'EvidenceUnavailable').withArgs(id, jurors[0].address, 1n);
    await (await core.connect(jurors[1]).reportUnavailable(id)).wait();
    await (await core.connect(jurors[2]).revealVote(id, 1, salts[jurors[2].address])).wait();

    // A juror is one or the other, never both.
    await expect(core.connect(jurors[0]).revealVote(id, 1, salts[jurors[0].address] ?? ethers.ZeroHash))
      .to.be.revertedWithCustomError(core, 'BadReveal');
    await expect(core.connect(jurors[1]).reportUnavailable(id))
      .to.be.revertedWithCustomError(core, 'AlreadyReported');

    await mine(101);
    const tx = await core.finalize(id);
    await expect(tx).to.emit(core, 'DisputeVoided').withArgs(id, 2n, 3n);
    await expect(tx).to.not.emit(core, 'Slashed');

    expect(await core.isVoided(id)).to.equal(true);
    const [ruling, tied, finalized] = await core.currentRuling(id);
    expect(ruling).to.equal(0n);
    expect(tied).to.equal(false);
    expect(finalized).to.equal(true);

    // Reporting the truth is doing the work: it is paid exactly like a reveal.
    for (const j of jurors) expect(await core.withdrawable(j.address)).to.equal(110n);
    await assertConservation(core, [
      ...jurors.map((j) => j.address), await app.getAddress(), treasury.address,
    ]);
    expect(cost).to.equal(30n);
  });

  it('returns stake to a seat that stayed silent through a void, but pays it nothing', async () => {
    const [, treasury] = await ethers.getSigners();
    const cfg = baseCfg(treasury.address, { panelSize: 5n });
    const { core, app, jurors, id } = await seatedPanel(cfg, 5);
    const salts = await commitAndOpen(core, id, jurors, [1, 1, 1, 1, 1]);

    // 3 report, 1 votes, 1 goes dark. Participation 4 >= quorum 3, and 3*2 > 4.
    for (const j of jurors.slice(0, 3)) await (await core.connect(j).reportUnavailable(id)).wait();
    await (await core.connect(jurors[3]).revealVote(id, 1, salts[jurors[3].address])).wait();

    await mine(101);
    const tx = await core.finalize(id);
    await expect(tx).to.emit(core, 'DisputeVoided').withArgs(id, 3n, 4n);
    await expect(tx).to.not.emit(core, 'Slashed');

    for (const j of jurors.slice(0, 4)) expect(await core.withdrawable(j.address)).to.equal(110n);
    // Silence is not shirking when the record was demonstrably unreachable — but it is not work
    // either, so the seat gets its stake back and no fee.
    expect(await core.withdrawable(jurors[4].address)).to.equal(100n);
    await assertConservation(core, [
      ...jurors.map((j) => j.address), await app.getAddress(), treasury.address,
    ]);
  });

  it('slashes a lone reporter like any other silence — one voice is not a void', async () => {
    const [, treasury] = await ethers.getSigners();
    const cfg = baseCfg(treasury.address);
    const { core, app, jurors, id } = await seatedPanel(cfg, 3);
    const salts = await commitAndOpen(core, id, jurors, [1, 1, 1]);

    await (await core.connect(jurors[0]).reportUnavailable(id)).wait();
    await (await core.connect(jurors[1]).revealVote(id, 1, salts[jurors[1].address])).wait();
    await (await core.connect(jurors[2]).revealVote(id, 1, salts[jurors[2].address])).wait();

    await mine(101);
    await expect(core.finalize(id))
      .to.emit(core, 'Slashed').withArgs(id, jurors[0].address, 25n); // gamma 25%
    expect(await core.isVoided(id)).to.equal(false);
    expect((await core.currentRuling(id))[0]).to.equal(1n); // the case still decided
    expect(await core.withdrawable(jurors[0].address)).to.equal(75n);
    await assertConservation(core, [
      ...jurors.map((j) => j.address), await app.getAddress(), treasury.address,
    ]);
  });

  it('will not let a single report on an empty panel void a case below quorum', async () => {
    const [, treasury] = await ethers.getSigners();
    // quorum need = ceil(5 * 50%) = 3; one reporter alone is a majority of the turnout but far
    // short of the floor, so this is an ordinary quorum failure and the reporter is slashed.
    const cfg = baseCfg(treasury.address, { panelSize: 5n });
    const { core, app, jurors, id } = await seatedPanel(cfg, 5);
    await commitAndOpen(core, id, jurors, [1, 1, 1, 1, 1]);

    await (await core.connect(jurors[0]).reportUnavailable(id)).wait();
    await mine(101);
    await (await core.finalize(id)).wait();

    expect(await core.isVoided(id)).to.equal(false);
    expect((await core.currentRuling(id))[0]).to.equal(0n);
    expect(await core.withdrawable(jurors[0].address)).to.equal(75n); // gamma, like the rest
    await assertConservation(core, [
      ...jurors.map((j) => j.address), await app.getAddress(), treasury.address,
    ]);
  });

  it('refuses a report from someone who is not on the panel, or outside the reveal window', async () => {
    const [, treasury] = await ethers.getSigners();
    const outsider = (await ethers.getSigners())[9];
    const cfg = baseCfg(treasury.address);
    const { core, jurors, id } = await seatedPanel(cfg, 3);

    // Committing phase: too early to say anything about the evidence.
    await expect(core.connect(jurors[0]).reportUnavailable(id))
      .to.be.revertedWithCustomError(core, 'WrongState');

    await commitAndOpen(core, id, jurors, [1, 1, 1]);
    await expect(core.connect(outsider).reportUnavailable(id))
      .to.be.revertedWithCustomError(core, 'NotSeated');

    await mine(101);
    await expect(core.connect(jurors[0]).reportUnavailable(id))
      .to.be.revertedWithCustomError(core, 'DrawClosed');
  });
});

describe('FR-EV-06 — the pinning take', () => {
  it('grosses the cost up for it and pays the pinner whatever the case did', async () => {
    const [, treasury, , , , , , , , pinner] = await ethers.getSigners();
    const cfg = baseCfg(treasury.address, { pinFeeBps: 1000n, pinner: pinner.address });
    const { core, app, jurors, cost, id } = await seatedPanel(cfg, 3);

    // 3 seats * fee 10 grossed up by a 10% take = ceil(300 / 9000 * 10000) = 34.
    expect(cost).to.equal(34n);
    const pinCut = (cost * 1000n) / 10000n; // 3

    const salts = await commitAndOpen(core, id, jurors, [1, 1, 1]);
    for (const j of jurors) await (await core.connect(j).revealVote(id, 1, salts[j.address])).wait();
    await mine(101);
    await (await core.finalize(id)).wait();

    expect(await core.withdrawable(pinner.address)).to.equal(pinCut);
    for (const j of jurors) expect(await core.withdrawable(j.address)).to.equal(110n); // full fee, first
    // The app gets back only what was left after the pinner and the jurors were paid.
    expect(await core.withdrawable(await app.getAddress())).to.equal(cost - pinCut - 30n);
    await assertConservation(core, [
      ...jurors.map((j) => j.address), await app.getAddress(), treasury.address, pinner.address,
    ]);
  });

  it('pays the pinner even when the panel never ruled — hosting happened either way', async () => {
    const [, treasury, , , , , , , , pinner] = await ethers.getSigners();
    const cfg = baseCfg(treasury.address, { pinFeeBps: 1000n, pinner: pinner.address });
    const { core, app, jurors, cost, id } = await seatedPanel(cfg, 3);
    await commitAndOpen(core, id, jurors, [1, 1, 1]);

    await mine(101); // nobody reveals
    await (await core.finalize(id)).wait();

    const pinCut = (cost * 1000n) / 10000n;
    expect(await core.withdrawable(pinner.address)).to.equal(pinCut);
    expect(await core.withdrawable(await app.getAddress())).to.equal(cost - pinCut);
    await assertConservation(core, [
      ...jurors.map((j) => j.address), await app.getAddress(), treasury.address, pinner.address,
    ]);
  });

  it('refuses a court that takes a pinning fee with nowhere to send it', async () => {
    const [, treasury] = await ethers.getSigners();
    const Elig = await ethers.getContractFactory('StakeWeightedEligibility');
    const elig = await Elig.deploy();
    await elig.waitForDeployment();
    const Core = await ethers.getContractFactory('ArbitratorCore');
    await expect(Core.deploy(baseCfg(treasury.address, { pinFeeBps: 500n }), await elig.getAddress(), 0n))
      .to.be.revertedWithCustomError(Core, 'BadConfig').withArgs('pinner');
  });
});
