import { expect } from 'chai';
import { ethers } from 'hardhat';
import { mine } from '@nomicfoundation/hardhat-network-helpers';
import { assertConservation } from './helpers';

// Full Phase-1 resolution loop against a StakeWeighted (open) court, with the
// draw threshold wide open so every staked juror self-selects deterministically.
describe('ArbitratorCore — full resolution loop', () => {
  async function deploy() {
    const [deployer, payer, payee, treasury, j1, j2, j3] = await ethers.getSigners();

    const Elig = await ethers.getContractFactory('StakeWeightedEligibility');
    const elig = await Elig.deploy();
    await elig.waitForDeployment();

    const cfg = {
      minStake: 100n,
      jurorFee: 10n,
      drawThreshold: ethers.MaxUint256, // everyone self-selects (test only)
      activationDelayBlocks: 0n,
      drawDelayBlocks: 1n,
      drawWindowBlocks: 100n,
      commitBlocks: 100n,
      revealBlocks: 100n,
      panelSize: 3n,
      betaBps: 1000n, // 10% incoherence slash
      gammaBps: 2500n, // 25% non-reveal slash
      thetaBps: 2000n, // 20% treasury cut
      quorumBps: 5000n, // 50% must reveal
      appFeeBps: 0n, // Phase-2 fee take (0 keeps arbitrationCost == panelSize*jurorFee)
      protocolFeeBps: 0n,
      treasury: treasury.address,
    };

    const Core = await ethers.getContractFactory('ArbitratorCore');
    const core = await Core.deploy(cfg, await elig.getAddress(), 0n);
    await core.waitForDeployment();

    const Escrow = await ethers.getContractFactory('SimpleEscrow');
    const escrow = await Escrow.deploy(await core.getAddress());
    await escrow.waitForDeployment();

    // typed `cfg` doesn't match typechain's generated struct type, so `.deploy()`
    // resolves to the untyped BaseContract overload; expose the handles loosely.
    return { core: core as any, escrow: escrow as any, deployer, payer, payee, treasury, jurors: [j1, j2, j3] };
  }

  it('resolves a disputed escrow in favour of the payee (ruling 1)', async () => {
    const { core, escrow, payer, payee, treasury, jurors } = await deploy();
    const AMOUNT = ethers.parseUnits('1', 'gwei'); // escrowed value

    // 1. Fund escrow.
    const fundTx = await escrow.connect(payer).fund(payee.address, { value: AMOUNT });
    await fundTx.wait();
    const escrowId = 1n;

    // 2. Jurors stake.
    for (const j of jurors) {
      await (await core.connect(j).stake({ value: 100n })).wait();
    }

    // 3. Payer raises a dispute (prepays arbitration cost = panelSize * jurorFee).
    const cost = await core.arbitrationCost('0x');
    expect(cost).to.equal(30n);
    await (await escrow.connect(payer).dispute(escrowId, { value: cost })).wait();
    const disputeId = 1n;
    expect(await core.disputeState(disputeId)).to.equal(1); // Drawing

    // 4. Reach the draw block, then all jurors claim a seat.
    await mine(2);
    for (const j of jurors) {
      await (await core.connect(j).claimSeat(disputeId)).wait();
    }
    // Panel == panelSize but < drawTarget (over-draw ceil(1.4*3)=5), so the draw
    // does not auto-close: crank closeDrawing once the claim window lapses.
    expect(await core.disputeState(disputeId)).to.equal(1); // still Drawing
    await mine(101);
    await (await core.closeDrawing(disputeId)).wait();
    expect(await core.disputeState(disputeId)).to.equal(2); // Committing

    // 5. Commit — all vote choice 1 (RELEASE to payee).
    const choice = 1;
    const salts: Record<string, string> = {};
    for (const j of jurors) {
      const salt = ethers.hexlify(ethers.randomBytes(32));
      salts[j.address] = salt;
      const commitment = ethers.solidityPackedKeccak256(
        ['uint256', 'address', 'uint8', 'bytes32'],
        [disputeId, j.address, choice, salt],
      );
      await (await core.connect(j).commitVote(disputeId, commitment)).wait();
    }

    // 6. Advance to reveal, reveal all votes.
    await mine(101);
    await (await core.openReveal(disputeId)).wait();
    expect(await core.disputeState(disputeId)).to.equal(3); // Revealing
    for (const j of jurors) {
      await (await core.connect(j).revealVote(disputeId, choice, salts[j.address])).wait();
    }

    // 7. Finalize -> tally ruling 1 -> settle -> deliver rule() -> payee CREDITED.
    await mine(101);
    await (await core.finalize(disputeId)).wait();

    expect(await core.disputeState(disputeId)).to.equal(4); // Resolved
    const [ruling, tied, finalized] = await core.currentRuling(disputeId);
    expect(ruling).to.equal(1n);
    expect(tied).to.equal(false);
    expect(finalized).to.equal(true);

    // Escrow is now PULL-payment: rule() credits the payee, who withdraws it.
    // The winning principal is parked as a pending withdrawal, then pulled.
    expect(await escrow.pendingWithdrawals(payee.address)).to.equal(AMOUNT);
    await expect(escrow.connect(payee).withdraw()).to.changeEtherBalance(payee, AMOUNT);
    expect(await escrow.pendingWithdrawals(payee.address)).to.equal(0n);

    // 8. Coherent jurors can withdraw: stake back + fee + pot share (pot=0 here,
    //    all coherent) => 100 + 10 each.
    for (const j of jurors) {
      const w = await core.withdrawable(j.address);
      expect(w).to.equal(110n);
    }

    // Never-mint: the core holds exactly what it was handed (stakes + prepaid fees).
    await assertConservation(core, [
      ...jurors.map((j) => j.address), await escrow.getAddress(), treasury.address,
    ]);
  });

  it('refunds the app and refuses to rule when the panel is undersubscribed', async () => {
    const { core, escrow, payer, payee } = await deploy();
    await (await escrow.connect(payer).fund(payee.address, { value: 1000n })).wait();
    const cost = await core.arbitrationCost('0x');
    await (await escrow.connect(payer).dispute(1n, { value: cost })).wait();

    // Nobody stakes / claims. Let the draw window lapse, then finalize.
    await mine(120);
    await (await core.finalize(1n)).wait();

    const [ruling] = await core.currentRuling(1n);
    expect(ruling).to.equal(0n); // refuse
    // The app (escrow) is refunded the arbitration fee.
    expect(await core.withdrawable(await escrow.getAddress())).to.equal(cost);
  });
});
