import { expect } from 'chai';
import { ethers } from 'hardhat';
import { mine } from '@nomicfoundation/hardhat-network-helpers';

// FR-DL-02: a dispute opens with the record OPEN and the panel not yet forming. The record closes
// before the draw, so every juror judges exactly the same set of evidence, and the sortition seed
// anchors to a block nobody could see while evidence was still being written.

const HASH = ethers.id('evidence bytes');

function cfg(treasury: string) {
  return {
    minStake: 100n, jurorFee: 10n, drawThreshold: ethers.MaxUint256,
    evidenceBond: 0n, // a non-party files free in these courts
    evidenceBlocks: 5n, activationDelayBlocks: 0n, drawDelayBlocks: 1n, drawWindowBlocks: 100n,
    commitBlocks: 100n, revealBlocks: 100n, panelSize: 3n,
    betaBps: 1000n, gammaBps: 2500n, thetaBps: 2000n, quorumBps: 5000n,
    appFeeBps: 0n, protocolFeeBps: 0n, pinFeeBps: 0n,
    treasury, pinner: ethers.ZeroAddress,
  };
}

async function openCase() {
  const [, treasury, payer, payee, stranger] = await ethers.getSigners();
  const Elig = await ethers.getContractFactory('StakeWeightedEligibility');
  const elig = await Elig.deploy();
  await elig.waitForDeployment();
  const Core = await ethers.getContractFactory('ArbitratorCore');
  const core = (await Core.deploy(cfg(treasury.address), await elig.getAddress(), 0n)) as any;
  await core.waitForDeployment();
  const Escrow = await ethers.getContractFactory('SimpleEscrow');
  const escrow = (await Escrow.deploy(await core.getAddress())) as any;
  await escrow.waitForDeployment();

  await (await escrow.connect(payer).fund(payee.address, '', { value: 1000n })).wait();
  await (await escrow.connect(payer).dispute(1n, { value: await core.arbitrationCost('0x') })).wait();
  return { core, escrow, payer, payee, stranger, disputeId: 1n };
}

describe('Evidence phase (FR-DL-02)', () => {
  it('opens with the record open and no draw block set yet', async () => {
    const { core, disputeId } = await openCase();
    expect(await core.disputeState(disputeId)).to.equal(1); // Evidence

    const d = await core.getDispute(disputeId);
    expect(d.evidenceDeadline).to.be.greaterThan(0n);
    // Nothing to grind against: the seed's anchor block does not exist while evidence is open.
    expect(d.drawBlock).to.equal(0n);
  });

  it('accepts evidence while open and refuses it once frozen', async () => {
    const { core, stranger, disputeId } = await openCase();

    await (await core.connect(stranger).submitEvidence(disputeId, 'ipfs://early', HASH, 10)).wait();
    expect((await core.getEvidence(disputeId)).length).to.equal(1);

    await mine(6);
    await expect(core.openDrawing(disputeId))
      .to.emit(core, 'EvidenceClosed')
      .withArgs(disputeId, 1);
    expect(await core.disputeState(disputeId)).to.equal(2); // Drawing

    // The panel is forming; the record it will judge can no longer change.
    await expect(
      core.connect(stranger).submitEvidence(disputeId, 'ipfs://late', HASH, 10),
    ).to.be.revertedWithCustomError(core, 'WrongState');
    expect((await core.getEvidence(disputeId)).length).to.equal(1);
  });

  it('refuses to open the draw before the record closes, and refuses seats before that', async () => {
    const { core, stranger, disputeId } = await openCase();

    await expect(core.openDrawing(disputeId)).to.be.revertedWithCustomError(core, 'TooEarly');

    // A juror cannot jump the queue either: there is no draw to claim into yet.
    await (await core.connect(stranger).stake({ value: 100n })).wait();
    await expect(core.connect(stranger).claimSeat(disputeId)).to.be.revertedWithCustomError(core, 'WrongState');

    await mine(6);
    await (await core.openDrawing(disputeId)).wait();
    await mine(2);
    await (await core.connect(stranger).claimSeat(disputeId)).wait();
    expect((await core.jurorRoundOf(disputeId, stranger.address)).seatCount).to.equal(1n);
  });

  it('sets the draw block only when the record closes, so the seed cannot be pre-computed', async () => {
    const { core, disputeId } = await openCase();
    await mine(6);
    const tx = await core.openDrawing(disputeId);
    const rc = await tx.wait();

    const d = await core.getDispute(disputeId);
    // drawDelayBlocks is 1, so the anchor is the block after the crank — not the one the dispute
    // was created in, which the parties already knew.
    expect(d.drawBlock).to.equal(BigInt(rc!.blockNumber) + 1n);
  });

  it('rejects a court configured with no evidence window at all', async () => {
    const [, treasury] = await ethers.getSigners();
    const Elig = await ethers.getContractFactory('StakeWeightedEligibility');
    const elig = await Elig.deploy();
    await elig.waitForDeployment();
    const Core = await ethers.getContractFactory('ArbitratorCore');
    await expect(
      Core.deploy({ ...cfg(treasury.address), evidenceBlocks: 0n }, await elig.getAddress(), 0n),
    ).to.be.revertedWithCustomError(Core, 'BadConfig').withArgs('evidenceBlocks');
  });
});
