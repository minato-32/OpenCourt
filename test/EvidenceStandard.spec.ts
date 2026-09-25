import { expect } from 'chai';
import { ethers } from 'hardhat';
import { mine } from '@nomicfoundation/hardhat-network-helpers';
import { assertConservation } from './helpers';

// FR-EV: the record is readable by a standard indexer (ERC-1497 log shapes, grouped by the app's
// own id) and filing it is priced for anyone who is not a party to the case.

type Cfg = { evidenceBond: bigint };

async function deploy(over: Partial<Cfg> = {}) {
  const [, treasury, payer, payee, stranger] = await ethers.getSigners();
  const Elig = await ethers.getContractFactory('StakeWeightedEligibility');
  const elig = await Elig.deploy();
  await elig.waitForDeployment();

  const cfg = {
    minStake: 100n, jurorFee: 10n, drawThreshold: ethers.MaxUint256,
    evidenceBond: 0n,
    evidenceBlocks: 5n, activationDelayBlocks: 0n, drawDelayBlocks: 1n, drawWindowBlocks: 100n,
    commitBlocks: 100n, revealBlocks: 100n, panelSize: 3n,
    betaBps: 1000n, gammaBps: 2500n, thetaBps: 2000n, quorumBps: 5000n,
    commitRequired: true, minPoolWeightMultiple: 0n,
    appFeeBps: 0n, protocolFeeBps: 0n, pinFeeBps: 0n,
    treasury: treasury.address, pinner: ethers.ZeroAddress,
    ...over,
  };

  const Core = await ethers.getContractFactory('ArbitratorCore');
  const core = (await Core.deploy(cfg, await elig.getAddress(), 0n)) as any;
  await core.waitForDeployment();

  const Escrow = await ethers.getContractFactory('SimpleEscrow');
  const escrow = (await Escrow.deploy(await core.getAddress())) as any;
  await escrow.waitForDeployment();

  return { core, escrow, treasury, payer, payee, stranger };
}

const CID = 'ipfs://bafyEvidenceOne';

describe('Evidence — ERC-1497 log shapes', () => {
  it('logs the agreement at funding and joins the dispute to its group when it is raised', async () => {
    const { core, escrow, payer, payee } = await deploy();
    const AGREEMENT = 'ipfs://bafyAgreement';

    await expect(escrow.connect(payer).fund(payee.address, AGREEMENT, { value: 1000n }))
      .to.emit(escrow, 'MetaEvidence')
      .withArgs(1n, AGREEMENT);

    const cost = await core.arbitrationCost('0x');
    // The escrow's group is its escrow id, so anything filed about escrow 1 — before or after the
    // dispute existed — carries the same key.
    await expect(escrow.connect(payer).dispute(1n, { value: cost }))
      .to.emit(escrow, 'Dispute')
      .withArgs(await core.getAddress(), 1n, 1n, 1n);

    expect(await core.evidenceGroupOf(1n)).to.equal(1n);
  });

  it('emits the standard Evidence log beside its own record', async () => {
    const { core, escrow, payer, payee } = await deploy();
    await (await escrow.connect(payer).fund(payee.address, '', { value: 1000n })).wait();
    await (await escrow.connect(payer).dispute(1n, { value: await core.arbitrationCost('0x') })).wait();

    await expect(core.connect(payer).submitEvidence(1n, CID, ethers.id('bytes'), 42))
      .to.emit(core, 'Evidence')
      .withArgs(await core.getAddress(), 1n, payer.address, CID)
      .and.to.emit(core, 'EvidenceSubmitted')
      .withArgs(1n, payer.address, CID);
  });

  it('lets only the app repoint the group, and only while the record is open', async () => {
    const { core, stranger } = await deploy();
    const App = await ethers.getContractFactory('MockArbitrable');
    const app = (await App.deploy(await core.getAddress())) as any;
    await app.waitForDeployment();
    await (await app.createDispute(2, { value: await core.arbitrationCost('0x') })).wait();

    expect(await core.evidenceGroupOf(1n)).to.equal(1n); // default: its own dispute id

    const iface = new ethers.Interface(['function linkEvidenceGroup(uint256,uint256)']);
    const link = (g: bigint) => iface.encodeFunctionData('linkEvidenceGroup', [1n, g]);

    await expect(core.connect(stranger).linkEvidenceGroup(1n, 99n))
      .to.be.revertedWithCustomError(core, 'OnlyApp');

    await (await app.forward(await core.getAddress(), link(77n))).wait();
    expect(await core.evidenceGroupOf(1n)).to.equal(77n);

    // Filings from here land in the new group.
    await expect(core.connect(stranger).submitEvidence(1n, CID, ethers.ZeroHash, 1))
      .to.emit(core, 'Evidence')
      .withArgs(await core.getAddress(), 77n, stranger.address, CID);

    // Once the panel can form, the key is frozen with the rest of the record.
    await mine(6);
    await (await core.openDrawing(1n)).wait();
    await expect(app.forward(await core.getAddress(), link(78n))).to.be.reverted;
  });
});

describe('Evidence — the third-party bond', () => {
  const BOND = 500n;

  it('parties file free, strangers post the bond and get it back when the case ends', async () => {
    const { core, escrow, payer, payee, stranger, treasury } = await deploy({ evidenceBond: BOND });
    await (await escrow.connect(payer).fund(payee.address, '', { value: 1000n })).wait();
    await (await escrow.connect(payer).dispute(1n, { value: await core.arbitrationCost('0x') })).wait();

    // A declared party pays nothing: the record is the case they came to make.
    await (await core.connect(payee).submitEvidence(1n, CID, ethers.ZeroHash, 1)).wait();
    expect(await core.bondsHeld()).to.equal(0n);
    await expect(core.connect(payee).submitEvidence(1n, CID, ethers.ZeroHash, 1, { value: BOND }))
      .to.be.revertedWithCustomError(core, 'BondRequired').withArgs(0n);

    // A stranger must send exactly the bond — not less, not more.
    await expect(core.connect(stranger).submitEvidence(1n, CID, ethers.ZeroHash, 1))
      .to.be.revertedWithCustomError(core, 'BondRequired').withArgs(BOND);
    await expect(core.connect(stranger).submitEvidence(1n, CID, ethers.ZeroHash, 1, { value: BOND - 1n }))
      .to.be.revertedWithCustomError(core, 'BondRequired').withArgs(BOND);

    await (await core.connect(stranger).submitEvidence(1n, CID, ethers.ZeroHash, 1, { value: BOND })).wait();
    expect(await core.bondsHeld()).to.equal(BOND);

    // Not reclaimable while the panel is still sitting.
    await expect(core.connect(stranger).reclaimEvidenceBond(1n, 1n))
      .to.be.revertedWithCustomError(core, 'WrongState');

    // Nobody staked, so the dispute runs to a refusal — the bond comes back regardless of how the
    // case turned out. No on-chain rule can judge whether a stranger's filing was useful, and one
    // that tried would hand the parties a lever to silence them.
    await mine(6);
    await (await core.openDrawing(1n)).wait();
    await mine(120);
    await (await core.finalize(1n)).wait();

    await expect(core.connect(payee).reclaimEvidenceBond(1n, 1n))
      .to.be.revertedWithCustomError(core, 'BondNotReclaimable'); // not their record
    await expect(core.connect(stranger).reclaimEvidenceBond(1n, 0n))
      .to.be.revertedWithCustomError(core, 'BondNotReclaimable'); // the party's free filing

    await (await core.connect(stranger).reclaimEvidenceBond(1n, 1n)).wait();
    expect(await core.withdrawable(stranger.address)).to.equal(BOND);
    expect(await core.bondsHeld()).to.equal(0n);

    await expect(core.connect(stranger).reclaimEvidenceBond(1n, 1n))
      .to.be.revertedWithCustomError(core, 'BondNotReclaimable'); // no double refund

    await expect(core.connect(stranger).withdraw()).to.changeEtherBalance(stranger, BOND);
    await assertConservation(core, [
      stranger.address, payer.address, payee.address, await escrow.getAddress(), treasury.address,
    ]);
  });

  it('leaves an unreclaimed bond escrowed for the filer, never folded into settlement', async () => {
    const { core, escrow, payer, payee, stranger, treasury } = await deploy({ evidenceBond: BOND });
    await (await escrow.connect(payer).fund(payee.address, '', { value: 1000n })).wait();
    await (await escrow.connect(payer).dispute(1n, { value: await core.arbitrationCost('0x') })).wait();
    await (await core.connect(stranger).submitEvidence(1n, CID, ethers.ZeroHash, 1, { value: BOND })).wait();

    await mine(6);
    await (await core.openDrawing(1n)).wait();
    await mine(120);
    await (await core.finalize(1n)).wait();

    // Settlement never touched it: the bond is escrowed apart from every fee pot and stake.
    expect(await core.bondsHeld()).to.equal(BOND);
    await assertConservation(core, [
      stranger.address, payer.address, payee.address, await escrow.getAddress(), treasury.address,
    ]);
  });
});
