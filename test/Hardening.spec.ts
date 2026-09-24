import { expect } from 'chai';
import { ethers } from 'hardhat';
import { mine } from '@nomicfoundation/hardhat-network-helpers';
import { assertConservation } from './helpers';

// Audit hardening: never-mint conservation, the beta arm (split vote), the
// no-verdict branch (FR-ST-02: a 1-1-1 tie pays its revealers and slashes only
// silence), the FR-CR-02 q* underpayment guard (core/registry parity), PoP
// gating, and ruling-delivery terminality (reverting app + codeless EOA creator).

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

async function deployCore(cfg: Cfg, eligAddr?: string) {
  let elig = eligAddr;
  if (!elig) {
    const Elig = await ethers.getContractFactory('StakeWeightedEligibility');
    const e = await Elig.deploy();
    await e.waitForDeployment();
    elig = await e.getAddress();
  }
  const Core = await ethers.getContractFactory('ArbitratorCore');
  const core = (await Core.deploy(cfg, elig, 0n)) as any;
  await core.waitForDeployment();
  return core;
}

function commitmentOf(disputeId: bigint, juror: string, choice: number, salt: string): string {
  return ethers.solidityPackedKeccak256(
    ['uint256', 'address', 'uint8', 'bytes32'],
    [disputeId, juror, choice, salt],
  );
}

describe('Hardening — beta arm (split vote)', () => {
  it('slashes the incoherent (beta) seat and pins withdrawables + pot split', async () => {
    const [, treasury, ...rest] = await ethers.getSigners();
    const jurors = rest.slice(0, 3);
    const core = await deployCore(baseCfg(treasury.address));

    const App = await ethers.getContractFactory('MockArbitrable');
    const app = (await App.deploy(await core.getAddress())) as any;
    await app.waitForDeployment();

    for (const j of jurors) await (await core.connect(j).stake({ value: 100n })).wait();
    const cost = await core.arbitrationCost('0x');
    await (await app.createDispute(2, { value: cost })).wait();
    const disputeId = 1n;

    await mine(2);
    for (const j of jurors) await (await core.connect(j).claimSeat(disputeId)).wait();
    await mine(101);
    await (await core.closeDrawing(disputeId)).wait();

    // 2 vote choice 1, 1 votes choice 2 -> ruling 1, the lone choice-2 seat is beta-slashed.
    const votes: Record<string, number> = {
      [jurors[0].address]: 1, [jurors[1].address]: 1, [jurors[2].address]: 2,
    };
    const salts: Record<string, string> = {};
    for (const j of jurors) {
      const salt = ethers.hexlify(ethers.randomBytes(32));
      salts[j.address] = salt;
      await (await core.connect(j).commitVote(disputeId, commitmentOf(disputeId, j.address, votes[j.address], salt))).wait();
    }
    await mine(101);
    await (await core.openReveal(disputeId)).wait();
    for (const j of jurors) await (await core.connect(j).revealVote(disputeId, votes[j.address], salts[j.address])).wait();
    await mine(101);
    await (await core.finalize(disputeId)).wait();

    const [ruling, tied] = await core.currentRuling(disputeId);
    expect(ruling).to.equal(1n);
    expect(tied).to.equal(false);

    // beta = 100*10% = 10; pot = 10; treasuryCut = 10*20% = 2; toCoherent = 8; 2 coherent -> share 4, dust 0.
    expect(await core.withdrawable(jurors[0].address)).to.equal(114n); // 100 + fee 10 + share 4
    expect(await core.withdrawable(jurors[1].address)).to.equal(114n);
    expect(await core.withdrawable(jurors[2].address)).to.equal(90n); // 100 - beta 10
    // cost 30, no take: residue = 30 - jurorFeesPaid(2*10) = 10 -> app.
    expect(await core.withdrawable(await app.getAddress())).to.equal(10n);
    expect(await core.withdrawable(treasury.address)).to.equal(2n); // treasuryCut + dust(0)

    await assertConservation(core, [
      ...jurors.map((j) => j.address), await app.getAddress(), treasury.address,
    ]);
  });
});

describe('Hardening — tie / no quorum (1-1-1)', () => {
  it('pays every revealer stake + fee and slashes nobody (FR-ST-02), resolves', async () => {
    const [, treasury, ...rest] = await ethers.getSigners();
    const jurors = rest.slice(0, 3);
    const core = await deployCore(baseCfg(treasury.address));

    const App = await ethers.getContractFactory('MockArbitrable');
    const app = (await App.deploy(await core.getAddress())) as any;
    await app.waitForDeployment();

    for (const j of jurors) await (await core.connect(j).stake({ value: 100n })).wait();
    const cost = await core.arbitrationCost('0x');
    await (await app.createDispute(3, { value: cost })).wait(); // 3 choices for a 3-way tie
    const disputeId = 1n;

    await mine(2);
    for (const j of jurors) await (await core.connect(j).claimSeat(disputeId)).wait();
    await mine(101);
    await (await core.closeDrawing(disputeId)).wait();

    // Each juror votes a DISTINCT choice -> 1-1-1 -> tie -> ruling 0.
    const votes: Record<string, number> = {
      [jurors[0].address]: 1, [jurors[1].address]: 2, [jurors[2].address]: 3,
    };
    const salts: Record<string, string> = {};
    for (const j of jurors) {
      const salt = ethers.hexlify(ethers.randomBytes(32));
      salts[j.address] = salt;
      await (await core.connect(j).commitVote(disputeId, commitmentOf(disputeId, j.address, votes[j.address], salt))).wait();
    }
    await mine(101);
    await (await core.openReveal(disputeId)).wait();
    for (const j of jurors) await (await core.connect(j).revealVote(disputeId, votes[j.address], salts[j.address])).wait();
    await mine(101);
    await (await core.finalize(disputeId)).wait();

    const [ruling, tied] = await core.currentRuling(disputeId);
    expect(ruling).to.equal(0n);
    expect(tied).to.equal(true);
    expect(await core.disputeState(disputeId)).to.equal(4); // Resolved

    // FR-ST-02: a genuine tie slashes NOBODY who revealed. Every seat that voted is
    // made whole and still paid its jurorFee: 100 + 10. pot = 0 (no silence), so the
    // pot share is 0. (This ASSERTION was inverted before the FR-ST-02 fix: it pinned
    // the old behaviour of beta-slashing all three honest revealers to 90.)
    for (const j of jurors) expect(await core.withdrawable(j.address)).to.equal(110n);
    // The prepay went to fees, so no residue refunds to the app; nothing was slashed,
    // so the treasury takes nothing (appFee/protocolFee are both 0 in this court).
    expect(await core.withdrawable(await app.getAddress())).to.equal(0n); // cost 30 == 3 * fee 10
    expect(await core.withdrawable(treasury.address)).to.equal(0n); // pot = 0, no take

    await assertConservation(core, [
      ...jurors.map((j) => j.address), await app.getAddress(), treasury.address,
    ]);
  });
});

describe('Hardening — tie with a silent seat', () => {
  it('slashes only the silent seat (gamma) and still pays the revealers (FR-ST-03)', async () => {
    const [, treasury, ...rest] = await ethers.getSigners();
    const jurors = rest.slice(0, 3);
    const core = await deployCore(baseCfg(treasury.address));

    const App = await ethers.getContractFactory('MockArbitrable');
    const app = (await App.deploy(await core.getAddress())) as any;
    await app.waitForDeployment();

    for (const j of jurors) await (await core.connect(j).stake({ value: 100n })).wait();
    const cost = await core.arbitrationCost('0x');
    await (await app.createDispute(3, { value: cost })).wait();
    const disputeId = 1n;

    await mine(2);
    for (const j of jurors) await (await core.connect(j).claimSeat(disputeId)).wait();
    await mine(101);
    await (await core.closeDrawing(disputeId)).wait();

    // Two jurors commit DIFFERENT choices (1-1 tie); the third never commits at all
    // -> ROLE_SILENT. Quorum needs ceil(3 * 50%) = 2 revealed seats, which is met,
    // so the dispute dies on the tie, not on quorum.
    const voters = jurors.slice(0, 2);
    const silent = jurors[2];
    const salts: Record<string, string> = {};
    for (let i = 0; i < voters.length; i++) {
      const j = voters[i];
      const salt = ethers.hexlify(ethers.randomBytes(32));
      salts[j.address] = salt;
      await (await core.connect(j).commitVote(disputeId, commitmentOf(disputeId, j.address, i + 1, salt))).wait();
    }
    await mine(101);
    await (await core.openReveal(disputeId)).wait();
    for (let i = 0; i < voters.length; i++) {
      await (await core.connect(voters[i]).revealVote(disputeId, i + 1, salts[voters[i].address])).wait();
    }
    await mine(101);
    await (await core.finalize(disputeId)).wait();

    const [ruling, tied] = await core.currentRuling(disputeId);
    expect(ruling).to.equal(0n);
    expect(tied).to.equal(true);

    // Only the silent seat is slashed: gamma 25% of 100 = 25 -> 75 back, pot = 25.
    expect(await core.withdrawable(silent.address)).to.equal(75n);
    // treasuryCut = 25 * 20% = 5; toRewarded = 20; 2 rewarded seats -> share 10, dust 0.
    for (const j of voters) expect(await core.withdrawable(j.address)).to.equal(120n); // 100 + 10 + 10
    // cost 30, no take: residue = 30 - jurorFeesPaid(2 * 10) = 10 -> app.
    expect(await core.withdrawable(await app.getAddress())).to.equal(10n);
    expect(await core.withdrawable(treasury.address)).to.equal(5n); // treasuryCut + dust(0)

    await assertConservation(core, [
      ...jurors.map((j) => j.address), await app.getAddress(), treasury.address,
    ]);
  });
});

describe('Hardening — FR-CR-02 q* underpayment guard', () => {
  it('rejects an underpaid court in BOTH the core constructor and the registry', async () => {
    const [, treasury] = await ethers.getSigners();
    const Elig = await ethers.getContractFactory('StakeWeightedEligibility');
    const elig = await Elig.deploy();
    await elig.waitForDeployment();
    const eligAddr = await elig.getAddress();

    const Core = await ethers.getContractFactory('ArbitratorCore');
    const Reg = await ethers.getContractFactory('CourtRegistry');
    const reg = (await Reg.deploy()) as any;
    await reg.waitForDeployment();

    // spec §7 worked example: panel 7, s = 100, f = 5, beta 10%, theta 20%
    // -> incoherent 2, coherent 5, potShare 3.2, q* = 10 / 18.2 = 0.549 -> ACCEPTED.
    const ok = baseCfg(treasury.address, { panelSize: 7n, jurorFee: 5n, betaBps: 1000n });
    const core = await Core.deploy(ok, eligAddr, 0n);
    await core.waitForDeployment();
    await (await reg.createCourt(ok, eligAddr)).wait();
    await reg.validateConfig(ok, eligAddr); // pure dry-run must not revert

    // Same panel with a fatter penalty and a thinner fee: beta 20%, f = 3
    // -> potShare 6.4, q* = 20 / 29.4 = 0.68 > 0.60 -> REJECTED. Raise the FEE,
    // not the penalty. The core and the registry must agree exactly (parity).
    const bad = baseCfg(treasury.address, { panelSize: 7n, jurorFee: 3n, betaBps: 2000n });
    await expect(Core.deploy(bad, eligAddr, 0n)).to.be.revertedWithCustomError(Core, 'BadConfig').withArgs(
      'jurorsUnderpaid',
    );
    await expect(reg.createCourt(bad, eligAddr)).to.be.revertedWithCustomError(reg, 'BadConfig').withArgs(
      'jurorsUnderpaid',
    );
    await expect(reg.validateConfig(bad, eligAddr)).to.be.revertedWithCustomError(reg, 'BadConfig').withArgs(
      'jurorsUnderpaid',
    );
  });
});

describe('Hardening — PoP gating (presence-only registry)', () => {
  it('rejects an unattested juror and admits an attested one', async () => {
    const [, treasury, verified, unverified] = await ethers.getSigners();

    const Reg = await ethers.getContractFactory('MockZKPassportRegistry');
    const reg = (await Reg.deploy()) as any;
    await reg.waitForDeployment();
    await (await reg.setVerified(verified.address, true)).wait();

    const Pop = await ethers.getContractFactory('PopGatedEligibility');
    const pop = (await Pop.deploy(await reg.getAddress())) as any;
    await pop.waitForDeployment();

    // The policy reflects the registry's presence flag verbatim.
    expect(await pop.weightOf(verified.address, 0n)).to.equal(1n);
    expect(await pop.weightOf(unverified.address, 0n)).to.equal(0n);

    // And it gates seating end-to-end.
    const core = await deployCore(baseCfg(treasury.address), await pop.getAddress());
    const App = await ethers.getContractFactory('MockArbitrable');
    const app = (await App.deploy(await core.getAddress())) as any;
    await app.waitForDeployment();

    for (const j of [verified, unverified]) await (await core.connect(j).stake({ value: 100n })).wait();
    const cost = await core.arbitrationCost('0x');
    await (await app.createDispute(2, { value: cost })).wait();
    await mine(2);

    await expect(core.connect(unverified).claimSeat(1n)).to.be.revertedWithCustomError(core, 'NotEligible');
    await (await core.connect(verified).claimSeat(1n)).wait();
    expect((await core.getSeats(1n)).length).to.equal(1);
  });
});

describe('Hardening — ruling-delivery terminality', () => {
  it('still terminates when the app rule() reverts, and rejects an EOA creator', async () => {
    const [, treasury, eoa, ...rest] = await ethers.getSigners();
    const jurors = rest.slice(0, 3);
    const core = await deployCore(baseCfg(treasury.address));

    // A codeless (EOA) app is rejected at creation (AppNotContract).
    const cost = await core.arbitrationCost('0x');
    await expect(core.connect(eoa).createDispute(2, '0x', { value: cost })).to.be.revertedWithCustomError(
      core,
      'AppNotContract',
    );

    // A contract app whose rule() ALWAYS reverts must still resolve terminally.
    const App = await ethers.getContractFactory('RevertingApp');
    const app = (await App.deploy(await core.getAddress())) as any;
    await app.waitForDeployment();

    for (const j of jurors) await (await core.connect(j).stake({ value: 100n })).wait();
    await (await app.createDispute(2, { value: cost })).wait();
    const disputeId = 1n;

    await mine(2);
    for (const j of jurors) await (await core.connect(j).claimSeat(disputeId)).wait();
    await mine(101);
    await (await core.closeDrawing(disputeId)).wait();

    const salts: Record<string, string> = {};
    for (const j of jurors) {
      const salt = ethers.hexlify(ethers.randomBytes(32));
      salts[j.address] = salt;
      await (await core.connect(j).commitVote(disputeId, commitmentOf(disputeId, j.address, 1, salt))).wait();
    }
    await mine(101);
    await (await core.openReveal(disputeId)).wait();
    for (const j of jurors) await (await core.connect(j).revealVote(disputeId, 1, salts[j.address])).wait();
    await mine(101);

    // finalize resolves + attempts delivery; the reverting rule() surfaces as
    // RulingDeliveryFailed rather than bricking the whole settlement.
    await expect(core.finalize(disputeId)).to.emit(core, 'RulingDeliveryFailed').withArgs(disputeId);
    expect(await core.disputeState(disputeId)).to.equal(4); // Resolved
    const d = await core.getDispute(disputeId);
    expect(d.ruled).to.equal(false); // delivery failed but the dispute is settled
    const [ruling] = await core.currentRuling(disputeId);
    expect(ruling).to.equal(1n);

    // Jurors were still paid; nothing minted.
    await assertConservation(core, [...jurors.map((j) => j.address), await app.getAddress(), treasury.address]);
  });
});
