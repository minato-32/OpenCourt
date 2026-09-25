import { expect } from 'chai';
import { ethers } from 'hardhat';
import { mine } from '@nomicfoundation/hardhat-network-helpers';

// Phase-2 backlog: evidence, alternates promotion, k-slot weighting, gross-up
// fees, and the standalone CourtRegistry. Each `describe` builds a court tuned to
// exercise one mechanic; the Phase-1 loop lives in ArbitratorCore.spec.ts and
// stays green independently.

type Cfg = {
  minStake: bigint;
  jurorFee: bigint;
  drawThreshold: bigint;
  evidenceBond: bigint;
  evidenceBlocks: bigint;
  activationDelayBlocks: bigint;
  drawDelayBlocks: bigint;
  drawWindowBlocks: bigint;
  commitBlocks: bigint;
  revealBlocks: bigint;
  panelSize: bigint;
  betaBps: bigint;
  gammaBps: bigint;
  thetaBps: bigint;
  quorumBps: bigint;
  commitRequired: boolean;
  minPoolWeightMultiple: bigint;
  quorumFailure: bigint;
  tieBreak: bigint;
  defaultChoice: bigint;
  closedPool: boolean;
  appFeeBps: bigint;
  protocolFeeBps: bigint;
  pinFeeBps: bigint;
  treasury: string;
  pinner: string;
};

function baseCfg(treasury: string, over: Partial<Cfg> = {}): Cfg {
  return {
    minStake: 100n,
    jurorFee: 10n,
    drawThreshold: ethers.MaxUint256, // everyone self-selects (test only)
    evidenceBond: 0n, // a non-party files free in these courts
    evidenceBlocks: 5n, activationDelayBlocks: 0n,
    drawDelayBlocks: 1n,
    drawWindowBlocks: 100n,
    commitBlocks: 100n,
    revealBlocks: 100n,
    panelSize: 3n,
    betaBps: 1000n,
    gammaBps: 2500n,
    thetaBps: 2000n,
    quorumBps: 5000n,
    commitRequired: true,
    minPoolWeightMultiple: 0n,
    quorumFailure: 0n,
    tieBreak: 0n,
    defaultChoice: 0n,
    closedPool: false,
    appFeeBps: 0n,
    protocolFeeBps: 0n,
    pinFeeBps: 0n,
    treasury,
    pinner: ethers.ZeroAddress,
    ...over,
  };
}

async function deployCourt(cfg: Cfg) {
  const Elig = await ethers.getContractFactory('StakeWeightedEligibility');
  const elig = await Elig.deploy();
  await elig.waitForDeployment();

  const Core = await ethers.getContractFactory('ArbitratorCore');
  const core = await Core.deploy(cfg, await elig.getAddress(), 0n);
  await core.waitForDeployment();

  const Escrow = await ethers.getContractFactory('SimpleEscrow');
  const escrow = await Escrow.deploy(await core.getAddress());
  await escrow.waitForDeployment();
  // typed `Cfg` doesn't match typechain's generated struct type, so `.deploy()`
  // resolves to the untyped BaseContract overload; expose the handles loosely so
  // the specs read the contract methods (hardhat runs them via ts-node anyway).
  return { core: core as any, escrow: escrow as any };
}

function commitmentOf(disputeId: bigint, juror: string, choice: number, salt: string): string {
  return ethers.solidityPackedKeccak256(
    ['uint256', 'address', 'uint8', 'bytes32'],
    [disputeId, juror, choice, salt],
  );
}

describe('Phase-2 — submitEvidence', () => {
  const HASH = ethers.id('evidence bytes');

  it('records a pointer on chain, emits the event, and rejects a dead dispute', async () => {
    const [, treasury, payer, payee, stranger] = await ethers.getSigners();
    const { core, escrow } = await deployCourt(baseCfg(treasury.address));

    await (await escrow.connect(payer).fund(payee.address, '', { value: 1000n })).wait();
    const cost = await core.arbitrationCost('0x');
    await (await escrow.connect(payer).dispute(1n, { value: cost })).wait();
    const disputeId = 1n;

    // Anyone can submit evidence while Drawing.
    await expect(core.connect(stranger).submitEvidence(disputeId, 'ipfs://cid-1', HASH, 1234))
      .to.emit(core, 'EvidenceSubmitted')
      .withArgs(disputeId, stranger.address, 'ipfs://cid-1');

    // The pointer is readable without an indexer — that is why it is stored, not only logged.
    const records = await core.getEvidence(disputeId);
    expect(records.length).to.equal(1);
    expect(records[0].submitter).to.equal(stranger.address);
    expect(records[0].uri).to.equal('ipfs://cid-1');
    expect(records[0].contentHash).to.equal(HASH);
    expect(records[0].sizeBytes).to.equal(1234n);
    expect(records[0].submittedAt).to.be.greaterThan(0n);
    expect(await core.evidenceCountOf(disputeId, stranger.address)).to.equal(1n);

    await expect(core.connect(stranger).submitEvidence(999n, 'ipfs://x', HASH, 1)).to.be.revertedWithCustomError(
      core,
      'WrongState',
    );
  });

  it('bounds what one submitter can attach, and rejects an empty or oversized pointer', async () => {
    const [, treasury, payer, payee, stranger] = await ethers.getSigners();
    // A window wide enough that the eleven filings below all land inside it: the deadline is
    // hard now, so a short window would close the record part-way through.
    const { core, escrow } = await deployCourt(baseCfg(treasury.address, { evidenceBlocks: 50n }));

    await (await escrow.connect(payer).fund(payee.address, '', { value: 1000n })).wait();
    const cost = await core.arbitrationCost('0x');
    await (await escrow.connect(payer).dispute(1n, { value: cost })).wait();
    const disputeId = 1n;

    await expect(core.connect(stranger).submitEvidence(disputeId, '', HASH, 1)).to.be.revertedWithCustomError(
      core,
      'BadEvidence',
    );
    await expect(
      core.connect(stranger).submitEvidence(disputeId, 'x'.repeat(129), HASH, 1),
    ).to.be.revertedWithCustomError(core, 'BadEvidence');

    // Eight is the per-submitter cap; the ninth is refused, and another address is unaffected.
    for (let i = 0; i < 8; i++) {
      await (await core.connect(stranger).submitEvidence(disputeId, `ipfs://cid-${i}`, HASH, 10)).wait();
    }
    await expect(
      core.connect(stranger).submitEvidence(disputeId, 'ipfs://one-too-many', HASH, 10),
    ).to.be.revertedWithCustomError(core, 'EvidenceCapReached');

    await (await core.connect(payer).submitEvidence(disputeId, 'ipfs://from-the-payer', HASH, 10)).wait();
    expect((await core.getEvidence(disputeId)).length).to.equal(9);
  });
});

describe('Phase-2 — alternates promotion', () => {
  it('promotes a committed alternate when a primary stays silent, preserving quorum', async () => {
    const signers = await ethers.getSigners();
    const treasury = signers[1];
    const payer = signers[2];
    const payee = signers[3];
    const jurors = signers.slice(4, 9); // 5 jurors -> drawTarget = ceil(1.4*3) = 5

    const { core, escrow } = await deployCourt(baseCfg(treasury.address));

    await (await escrow.connect(payer).fund(payee.address, '', { value: 1000n })).wait();
    for (const j of jurors) await (await core.connect(j).stake({ value: 100n })).wait();

    const cost = await core.arbitrationCost('0x');
    await (await escrow.connect(payer).dispute(1n, { value: cost })).wait();
    const disputeId = 1n;

    // Reach the draw, all five claim -> panel over-drawn to drawTarget. The draw still runs its
    // full window, because a lower vrf output arriving late must be able to displace a seat.
    await mine(6);
    await (await core.openDrawing(disputeId)).wait();
    await mine(2);
    for (const j of jurors) await (await core.connect(j).claimSeat(disputeId)).wait();
    await mine(101);
    await (await core.closeDrawing(disputeId)).wait();
    expect(await core.disputeState(disputeId)).to.equal(3); // Committing

    // Reconstruct the sortition ranking off-chain (lowest keccak = higher priority).
    const seed = await core.drawSeed(disputeId);
    const ranked = [...jurors].sort((a, b) => {
      const va = BigInt(ethers.solidityPackedKeccak256(['bytes32', 'address', 'uint16'], [seed, a.address, 0]));
      const vb = BigInt(ethers.solidityPackedKeccak256(['bytes32', 'address', 'uint16'], [seed, b.address, 0]));
      return va < vb ? -1 : va > vb ? 1 : 0;
    });
    const primaries = ranked.slice(0, 3);
    const alternates = ranked.slice(3);

    const silentPrimary = primaries[0]; // a PRIMARY that never commits
    const releasedAlt = alternates[1]; // an alternate that is never needed
    const committers = [primaries[1], primaries[2], alternates[0]]; // 2 primaries + 1 promoted alt

    const salts: Record<string, string> = {};
    for (const j of committers) {
      const salt = ethers.hexlify(ethers.randomBytes(32));
      salts[j.address] = salt;
      await (await core.connect(j).commitVote(disputeId, commitmentOf(disputeId, j.address, 1, salt))).wait();
    }

    await mine(101);
    await (await core.openReveal(disputeId)).wait();

    const d = await core.getDispute(disputeId);
    expect(d.seatedWeight).to.equal(3); // absent primary refilled by a promoted alternate

    for (const j of committers) await (await core.connect(j).revealVote(disputeId, 1, salts[j.address])).wait();

    await mine(101);
    await (await core.finalize(disputeId)).wait();
    const [ruling] = await core.currentRuling(disputeId);
    expect(ruling).to.equal(1n); // quorum survived the silent primary

    // Silent primary is gamma-slashed (25%): 100 - 25 = 75.
    expect(await core.withdrawable(silentPrimary.address)).to.equal(75n);
    // Unneeded alternate gets its full slot stake back, no fee.
    expect(await core.withdrawable(releasedAlt.address)).to.equal(100n);
    // pot = 25; treasuryCut = 5; toCoherent = 20; share = 6 (dust 2). Coherent = 100 + 10 + 6.
    for (const j of committers) expect(await core.withdrawable(j.address)).to.equal(116n);
    // treasury = protocolCut(0) + treasuryCut(5) + dust(2).
    expect(await core.withdrawable(treasury.address)).to.equal(7n);
  });
});

describe('Phase-2 — k-slot weighting', () => {
  it('lets one juror field weight-many seats that each count and each settle', async () => {
    const [, treasury, payer, payee, whale] = await ethers.getSigners();
    const { core, escrow } = await deployCourt(baseCfg(treasury.address));

    // whale stakes 3 * minStake -> weight 3 -> claims 3 seats (the whole panel).
    await (await core.connect(whale).stake({ value: 300n })).wait();
    expect(await core.weightOf(whale.address)).to.equal(3n);

    await (await escrow.connect(payer).fund(payee.address, '', { value: 1000n })).wait();
    const cost = await core.arbitrationCost('0x');
    await (await escrow.connect(payer).dispute(1n, { value: cost })).wait();
    const disputeId = 1n;

    await mine(6);
    await (await core.openDrawing(disputeId)).wait();
    await mine(2);
    await (await core.connect(whale).claimSeat(disputeId)).wait();
    expect((await core.getSeats(disputeId)).length).to.equal(3); // 3 independent slots

    // panelSize(3) <= seats(3) < drawTarget(5): needs the closeDrawing crank.
    await mine(101);
    await (await core.closeDrawing(disputeId)).wait();
    expect(await core.disputeState(disputeId)).to.equal(3);

    const salt = ethers.hexlify(ethers.randomBytes(32));
    await (await core.connect(whale).commitVote(disputeId, commitmentOf(disputeId, whale.address, 1, salt))).wait();

    await mine(101);
    await (await core.openReveal(disputeId)).wait();
    const jr = await core.jurorRoundOf(disputeId, whale.address);
    expect(jr.dutySeats).to.equal(3); // all three seats are on duty

    await (await core.connect(whale).revealVote(disputeId, 1, salt)).wait();
    await mine(101);
    await (await core.finalize(disputeId)).wait();

    const [ruling] = await core.currentRuling(disputeId);
    expect(ruling).to.equal(1n);
    // 3 coherent seats: 3*minStake back + 3*jurorFee, pot 0.
    expect(await core.withdrawable(whale.address)).to.equal(330n);
  });
});

describe('Phase-2 — gross-up fees', () => {
  it('grosses up the cost so jurors get full fee while app + protocol takes route correctly', async () => {
    const signers = await ethers.getSigners();
    const treasury = signers[1];
    const payer = signers[2];
    const payee = signers[3];
    const jurors = signers.slice(4, 7);

    // 5% app + 5% protocol take. denom = 9000. cost = ceil(3*10*10000/9000) = 34.
    const { core, escrow } = await deployCourt(baseCfg(treasury.address, { appFeeBps: 500n, protocolFeeBps: 500n }));
    const escrowAddr = await escrow.getAddress();

    expect(await core.arbitrationCost('0x')).to.equal(34n);

    await (await escrow.connect(payer).fund(payee.address, '', { value: 1000n })).wait();
    for (const j of jurors) await (await core.connect(j).stake({ value: 100n })).wait();

    const cost = await core.arbitrationCost('0x');
    await (await escrow.connect(payer).dispute(1n, { value: cost })).wait();
    const disputeId = 1n;

    await mine(6);
    await (await core.openDrawing(disputeId)).wait();
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
    await (await core.finalize(disputeId)).wait();

    const [ruling] = await core.currentRuling(disputeId);
    expect(ruling).to.equal(1n);

    // Every coherent juror is paid the FULL jurorFee first: 100 + 10.
    for (const j of jurors) expect(await core.withdrawable(j.address)).to.equal(110n);
    // protocolCut = floor(34*5%) = 1 -> treasury. treasuryCut/dust from pot 0.
    expect(await core.withdrawable(treasury.address)).to.equal(1n);
    // appCut(1) + residue(34-1-1-30=2) = 3 -> credited to the app in the CORE.
    expect(await core.withdrawable(escrowAddr)).to.equal(3n);

    // The refund would be stranded in the core (the escrow is pull-based too), so
    // the app must actively pull it. claimFees() calls arbitrator.withdraw(), lands
    // the 3 via receive(), and credits the original fee-payer (the payer).
    await (await escrow.connect(payer).claimFees(1n)).wait();
    expect(await core.withdrawable(escrowAddr)).to.equal(0n); // pulled out of the core
    expect(await escrow.pendingWithdrawals(payer.address)).to.equal(3n);
    // The fee-payer can now withdraw the reclaimed refund from the escrow.
    await expect(escrow.connect(payer).withdraw()).to.changeEtherBalance(payer, 3n);
  });
});

describe('Phase-2 — CourtRegistry', () => {
  async function fixture() {
    const [, treasury] = await ethers.getSigners();
    const Elig = await ethers.getContractFactory('StakeWeightedEligibility');
    const elig = await Elig.deploy();
    await elig.waitForDeployment();
    const Reg = await ethers.getContractFactory('CourtRegistry');
    const reg = await Reg.deploy();
    await reg.waitForDeployment();
    return { reg, elig: await elig.getAddress(), treasury };
  }

  it('validates config and mints a courtId via the factory', async () => {
    const { reg, elig, treasury } = await fixture();
    const cfg = baseCfg(treasury.address);

    const tx = await reg.createCourt(cfg, elig);
    await tx.wait();
    expect(await reg.courtCount()).to.equal(1n);
    const arb = await reg.courtArbitrator(1n);
    expect(arb).to.not.equal(ethers.ZeroAddress);

    // The registered court is a working ArbitratorCore with the same config hash.
    const core = await ethers.getContractAt('ArbitratorCore', arb);
    const stored = (await reg.courts(1n)).configHash;
    expect(await core.configHash()).to.equal(stored);

    // Factory-deployed => provenance verified.
    expect((await reg.courts(1n)).verified).to.equal(true);
    const [known, verified] = await reg.courtVerified(1n);
    expect(known).to.equal(true);
    expect(verified).to.equal(true);
  });

  it('rejects economically-unsafe configs (gamma < beta, take too high)', async () => {
    const { reg, elig, treasury } = await fixture();

    await expect(
      reg.createCourt(baseCfg(treasury.address, { betaBps: 3000n, gammaBps: 1000n }), elig),
    ).to.be.revertedWithCustomError(reg, 'BadConfig');

    await expect(
      reg.createCourt(baseCfg(treasury.address, { appFeeBps: 1500n, protocolFeeBps: 1500n }), elig),
    ).to.be.revertedWithCustomError(reg, 'BadConfig');
  });

  it('registers an already-deployed core only when the config hash matches', async () => {
    const { reg, elig, treasury } = await fixture();
    const cfg = baseCfg(treasury.address);
    const { core } = await deployCourt(cfg);

    await (await reg.registerCourt(await core.getAddress(), cfg)).wait();
    expect(await reg.courtArbitrator(1n)).to.equal(await core.getAddress());

    // Self-reported external core => provenance UNverified (trust at your own risk).
    expect((await reg.courts(1n)).verified).to.equal(false);
    const [known, verified] = await reg.courtVerified(1n);
    expect(known).to.equal(true);
    expect(verified).to.equal(false);

    // A config that validates but does not match the deployed court is refused.
    const wrong = baseCfg(treasury.address, { jurorFee: 99n });
    await expect(reg.registerCourt(await core.getAddress(), wrong)).to.be.revertedWithCustomError(
      reg,
      'ConfigMismatch',
    );
  });
});
