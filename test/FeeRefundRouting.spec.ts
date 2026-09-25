import { expect } from 'chai';
import { ethers } from 'hardhat';
import { mine } from '@nomicfoundation/hardhat-network-helpers';

// The refund-misrouting defect, pinned.
//
//   A court credits an app's fee refund to the app's pull balance. withdraw() hands over EVERY
//   such credit at once, and the app cannot tell which dispute any of it came from. Both apps in
//   this repo used to sweep that lump and hand the whole thing to one dispute's fee-payer, so with
//   two cases outstanding the first caller walked off with the other's money.
//
//   Courts now pay per dispute: claimRefund(disputeId) moves exactly that dispute's share.

function cfg(treasury: string) {
  return {
    minStake: 100n, jurorFee: 10n, drawThreshold: ethers.MaxUint256,
    evidenceBond: 0n,
    evidenceBlocks: 5n, activationDelayBlocks: 0n, drawDelayBlocks: 1n, drawWindowBlocks: 100n,
    commitBlocks: 100n, revealBlocks: 100n, panelSize: 3n,
    betaBps: 1000n, gammaBps: 2500n, thetaBps: 2000n, quorumBps: 5000n,
    commitRequired: true, minPoolWeightMultiple: 0n,
    appFeeBps: 0n, protocolFeeBps: 0n, pinFeeBps: 0n,
    treasury, pinner: ethers.ZeroAddress,
  };
}

async function deploy() {
  const [, treasury, alice, bob, carol] = await ethers.getSigners();
  const Elig = await ethers.getContractFactory('StakeWeightedEligibility');
  const elig = await Elig.deploy();
  await elig.waitForDeployment();
  const Core = await ethers.getContractFactory('ArbitratorCore');
  const core: any = await Core.deploy(cfg(treasury.address), await elig.getAddress(), 0n);
  await core.waitForDeployment();
  const Escrow = await ethers.getContractFactory('SimpleEscrow');
  const escrow: any = await Escrow.deploy(await core.getAddress());
  await escrow.waitForDeployment();
  return { core, escrow, alice, bob, carol, treasury };
}

/** Raise a dispute that nobody judges, so the whole prepay comes back to the app. */
async function abandonedDispute(core: any, escrow: any, payer: any, payee: any, escrowId: bigint) {
  await (await escrow.connect(payer).fund(payee.address, '', { value: 1000n })).wait();
  const cost = await core.arbitrationCost('0x');
  await (await escrow.connect(payer).dispute(escrowId, { value: cost })).wait();
  return cost as bigint;
}

describe('Fee refunds are tagged to the dispute that earned them', () => {
  it('pays one escrow its own refund and leaves the other escrow untouched', async () => {
    const { core, escrow, alice, bob, carol } = await deploy();

    // Two separate escrows, two separate disputes, two different people prepaid.
    const cost1 = await abandonedDispute(core, escrow, alice, bob, 1n);
    const cost2 = await abandonedDispute(core, escrow, carol, bob, 2n);

    await mine(6);
    await (await core.openDrawing(1n)).wait();
    await (await core.openDrawing(2n)).wait();
    await mine(160);
    await (await core.finalize(1n)).wait();
    await (await core.finalize(2n)).wait();

    // The core holds both refunds for the escrow as one indistinguishable balance.
    expect(await core.withdrawable(await escrow.getAddress())).to.equal(cost1 + cost2);
    expect(await core.refundOf(1n)).to.equal(cost1);
    expect(await core.refundOf(2n)).to.equal(cost2);

    // Ruling 0 already credited each payer their escrowed principal back; the fee refund is a
    // separate movement on top, so measure the delta rather than the balance.
    const aliceBefore = await escrow.pendingWithdrawals(alice.address);
    const carolBefore = await escrow.pendingWithdrawals(carol.address);

    // Claiming escrow 1's fees takes escrow 1's share and nothing else.
    await (await escrow.claimFees(1n)).wait();
    expect((await escrow.pendingWithdrawals(alice.address)) - aliceBefore).to.equal(cost1);
    expect(await escrow.pendingWithdrawals(carol.address)).to.equal(carolBefore);
    expect(await core.withdrawable(await escrow.getAddress())).to.equal(cost2);

    await (await escrow.claimFees(2n)).wait();
    expect((await escrow.pendingWithdrawals(carol.address)) - carolBefore).to.equal(cost2);
    expect(await core.withdrawable(await escrow.getAddress())).to.equal(0n);

    await expect(escrow.connect(alice).withdraw()).to.changeEtherBalance(alice, aliceBefore + cost1);
    await expect(escrow.connect(carol).withdraw()).to.changeEtherBalance(carol, carolBefore + cost2);
  });

  it('will not pay the same dispute twice', async () => {
    const { core, escrow, alice, bob } = await deploy();
    await abandonedDispute(core, escrow, alice, bob, 1n);
    await mine(6);
    await (await core.openDrawing(1n)).wait();
    await mine(160);
    await (await core.finalize(1n)).wait();

    await (await escrow.claimFees(1n)).wait();
    await expect(escrow.claimFees(1n)).to.be.revertedWithCustomError(core, 'NothingToWithdraw');
  });

  it('refuses to tag a refund an app has already swept as a lump', async () => {
    const { core, alice } = await deploy();
    const App = await ethers.getContractFactory('MockArbitrable');
    const app: any = await App.deploy(await core.getAddress());
    await app.waitForDeployment();
    await (await app.connect(alice).createDispute(2, { value: await core.arbitrationCost('0x') })).wait();
    await mine(6);
    await (await core.openDrawing(1n)).wait();
    await mine(160);
    await (await core.finalize(1n)).wait();

    await (await app.claimFees()).wait(); // the old lump-sum path
    await expect(core.claimRefund(1n)).to.be.revertedWithCustomError(core, 'NothingToWithdraw');
  });
});
