import { expect } from 'chai';
import { ethers } from 'hardhat';
import { mine } from '@nomicfoundation/hardhat-network-helpers';

// Multi-round appeals via AppealCoordinator composing two single-round courts
// (panel 3 -> panel 7). Round 0 rules REFUND; the payee appeals; round 7 rules
// RELEASE; the final ruling is delivered to the escrow. Courts are unchanged.

type Cfg = {
  minStake: bigint; jurorFee: bigint; drawThreshold: bigint;
  evidenceBond: bigint;
  evidenceBlocks: bigint; activationDelayBlocks: bigint; drawDelayBlocks: bigint; drawWindowBlocks: bigint;
  commitBlocks: bigint; revealBlocks: bigint; panelSize: bigint;
  betaBps: bigint; gammaBps: bigint; thetaBps: bigint; quorumBps: bigint;
  appFeeBps: bigint; protocolFeeBps: bigint; pinFeeBps: bigint;
  treasury: string; pinner: string;
};

function courtCfg(treasury: string, panelSize: bigint): Cfg {
  return {
    minStake: 100n, jurorFee: 10n, drawThreshold: ethers.MaxUint256,
    evidenceBond: 0n, // a non-party files free in these courts
    evidenceBlocks: 5n, activationDelayBlocks: 0n, drawDelayBlocks: 1n, drawWindowBlocks: 100n,
    commitBlocks: 100n, revealBlocks: 100n, panelSize,
    betaBps: 1000n, gammaBps: 2500n, thetaBps: 2000n, quorumBps: 5000n,
    appFeeBps: 0n, protocolFeeBps: 0n, pinFeeBps: 0n,
    treasury, pinner: ethers.ZeroAddress,
  };
}

// Drive one court dispute to a ruling. `courtDisputeId` is the id INSIDE `court`
// (the commitment binds to it, not the coordinator id).
async function runRound(court: any, courtDisputeId: bigint, jurors: any[], choice: number) {
  for (const j of jurors) await (await court.connect(j).stake({ value: 100n })).wait();
  await mine(6);
  await (await court.openDrawing(courtDisputeId)).wait();
  await mine(2);
  for (const j of jurors) await (await court.connect(j).claimSeat(courtDisputeId)).wait();
  await mine(101);
  await (await court.closeDrawing(courtDisputeId)).wait();
  const salts: Record<string, string> = {};
  for (const j of jurors) {
    const salt = ethers.hexlify(ethers.randomBytes(32));
    salts[j.address] = salt;
    const c = ethers.solidityPackedKeccak256(
      ['uint256', 'address', 'uint8', 'bytes32'], [courtDisputeId, j.address, choice, salt],
    );
    await (await court.connect(j).commitVote(courtDisputeId, c)).wait();
  }
  await mine(101);
  await (await court.openReveal(courtDisputeId)).wait();
  for (const j of jurors) await (await court.connect(j).revealVote(courtDisputeId, choice, salts[j.address])).wait();
  await mine(101);
  await (await court.finalize(courtDisputeId)).wait(); // -> court delivers rule() to the coordinator
}

describe('AppealCoordinator — multi-round appeal', () => {
  it('round 0 REFUND -> appeal -> round 1 RELEASE delivered to the escrow', async () => {
    const signers = await ethers.getSigners();
    const [deployer, payer, payee, treasury] = signers;
    const jurors = signers.slice(4, 11); // 7 jurors (round 0 uses 3, round 1 uses all 7)

    const Elig = await ethers.getContractFactory('StakeWeightedEligibility');
    const elig = await Elig.deploy(); await elig.waitForDeployment();
    const eligAddr = await elig.getAddress();

    const Core = await ethers.getContractFactory('ArbitratorCore');
    const courtA: any = await Core.deploy(courtCfg(treasury.address, 3n), eligAddr, 0n);
    await courtA.waitForDeployment();
    const courtB: any = await Core.deploy(courtCfg(treasury.address, 7n), eligAddr, 0n);
    await courtB.waitForDeployment();

    const Coord = await ethers.getContractFactory('AppealCoordinator');
    const coord: any = await Coord.deploy([await courtA.getAddress(), await courtB.getAddress()], 100n);
    await coord.waitForDeployment();

    const Escrow = await ethers.getContractFactory('SimpleEscrow');
    const escrow: any = await Escrow.deploy(await coord.getAddress());
    await escrow.waitForDeployment();

    // Fund + dispute (coordinator is the escrow's arbitrator).
    const AMOUNT = ethers.parseUnits('1', 'gwei');
    await (await escrow.connect(payer).fund(payee.address, '', { value: AMOUNT })).wait();
    const cost0 = await coord.arbitrationCost('0x');
    expect(cost0).to.equal(30n); // court A: 3 * 10
    await (await escrow.connect(payer).dispute(1n, { value: cost0 })).wait();
    const coordId = 1n;

    // Round 0 in court A: rule REFUND (2). Coordinator opens the appeal window.
    await runRound(courtA, 1n, jurors.slice(0, 3), 2);
    expect(await coord.disputeState(coordId)).to.equal(2); // Appealable
    let [ruling, , finalized] = await coord.currentRuling(coordId);
    expect(ruling).to.equal(2n);
    expect(finalized).to.equal(false);

    // FR-DL-04: the app is told the provisional result but must not act on it. REFUND would have
    // credited the payer; the escrow is still Disputed and nobody has been paid.
    expect(await escrow.provisionalRuling(1n)).to.equal(2n);
    expect((await escrow.escrows(1n)).state).to.equal(2); // Disputed
    expect(await escrow.pendingWithdrawals(payer.address)).to.equal(0n);
    expect(await escrow.pendingWithdrawals(payee.address)).to.equal(0n);

    // Appeal to court B (panel 7).
    const costA = await coord.appealCost(coordId);
    expect(costA).to.equal(70n); // court B: 7 * 10
    await (await coord.connect(payee).appeal(coordId, { value: costA })).wait();
    expect(await coord.disputeState(coordId)).to.equal(1); // Pending (round 1 running)

    // Round 1 in court B: rule RELEASE (1). Highest court -> finalizes to the escrow.
    await runRound(courtB, 1n, jurors, 1);
    expect(await coord.disputeState(coordId)).to.equal(3); // Resolved
    [ruling, , finalized] = await coord.currentRuling(coordId);
    expect(ruling).to.equal(1n);
    expect(finalized).to.equal(true);

    // Only now, on the FINAL ruling, does the escrow move — and it moves to RELEASE, the opposite
    // of the provisional result it was shown. Acting early would have paid the wrong party.
    expect((await escrow.escrows(1n)).state).to.equal(3); // Resolved
    expect(await escrow.pendingWithdrawals(payer.address)).to.equal(0n);
    expect(await escrow.pendingWithdrawals(payee.address)).to.equal(AMOUNT);
    await (await escrow.connect(payee).withdraw()).wait();
    expect(await escrow.pendingWithdrawals(payee.address)).to.equal(0n);
  });

  it('no appeal within the window -> round 0 ruling finalizes to the app', async () => {
    const signers = await ethers.getSigners();
    const [deployer, payer, payee, treasury] = signers;
    const jurors = signers.slice(4, 7);

    const Elig = await ethers.getContractFactory('StakeWeightedEligibility');
    const elig = await Elig.deploy(); await elig.waitForDeployment();
    const Core = await ethers.getContractFactory('ArbitratorCore');
    const courtA: any = await Core.deploy(courtCfg(treasury.address, 3n), await elig.getAddress(), 0n);
    await courtA.waitForDeployment();
    const courtB: any = await Core.deploy(courtCfg(treasury.address, 7n), await elig.getAddress(), 0n);
    await courtB.waitForDeployment();
    const Coord = await ethers.getContractFactory('AppealCoordinator');
    const coord: any = await Coord.deploy([await courtA.getAddress(), await courtB.getAddress()], 100n);
    await coord.waitForDeployment();
    const Escrow = await ethers.getContractFactory('SimpleEscrow');
    const escrow: any = await Escrow.deploy(await coord.getAddress());
    await escrow.waitForDeployment();

    await (await escrow.connect(payer).fund(payee.address, '', { value: 1000n })).wait();
    await (await escrow.connect(payer).dispute(1n, { value: await coord.arbitrationCost('0x') })).wait();

    await runRound(courtA, 1n, jurors.slice(0, 3), 1); // RELEASE
    expect(await coord.disputeState(1n)).to.equal(2); // Appealable

    // Provisional only: shown, not acted on.
    expect(await escrow.provisionalRuling(1n)).to.equal(1n);
    expect(await escrow.pendingWithdrawals(payee.address)).to.equal(0n);

    // Let the appeal window lapse, then finalize -> delivers to the escrow.
    await mine(101);
    await (await coord.finalizeAppeal(1n)).wait();
    expect(await coord.disputeState(1n)).to.equal(3); // Resolved
    const [ruling] = await coord.currentRuling(1n);
    expect(ruling).to.equal(1n);
    expect(await escrow.pendingWithdrawals(payee.address)).to.equal(1000n);
  });

  it('a court wired straight to an app delivers one ruling, already final', async () => {
    const signers = await ethers.getSigners();
    const [, payer, payee, treasury] = signers;
    const jurors = signers.slice(4, 7);

    const Elig = await ethers.getContractFactory('StakeWeightedEligibility');
    const elig = await Elig.deploy(); await elig.waitForDeployment();
    const Core = await ethers.getContractFactory('ArbitratorCore');
    const court: any = await Core.deploy(courtCfg(treasury.address, 3n), await elig.getAddress(), 0n);
    await court.waitForDeployment();
    const App = await ethers.getContractFactory('MockArbitrable');
    const app: any = await App.deploy(await court.getAddress());
    await app.waitForDeployment();

    const cost = await court.arbitrationCost('0x');
    await (await app.createDispute(2, { value: cost })).wait();
    await runRound(court, 1n, jurors, 1);

    // No coordinator in front, so there is no round that could overturn this one.
    expect(await app.ruled()).to.equal(true);
    expect(await app.lastWasFinal()).to.equal(true);
    expect(await app.provisionalCount()).to.equal(0n);
    expect(await app.lastRuling()).to.equal(1n);
  });
});
