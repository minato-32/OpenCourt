import { expect } from 'chai';
import { ethers } from 'hardhat';
import { mine } from '@nomicfoundation/hardhat-network-helpers';

// FR-SL-04: the panel is the LOWEST vrf outputs among everyone who claimed inside the window, not
// the first claims to arrive. FR-SL-07: a declared party cannot sit on the panel judging its own
// dispute.

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

async function deployCourt(cfg: Cfg) {
  const Elig = await ethers.getContractFactory('StakeWeightedEligibility');
  const elig = await Elig.deploy();
  await elig.waitForDeployment();
  const Core = await ethers.getContractFactory('ArbitratorCore');
  const core = (await Core.deploy(cfg, await elig.getAddress(), 0n)) as any;
  await core.waitForDeployment();
  return core;
}

/** The vrf output the contract will compute for this juror's slot 0. */
function vrfOf(seed: string, juror: string, slot: number): bigint {
  return BigInt(ethers.solidityPackedKeccak256(['bytes32', 'address', 'uint16'], [seed, juror, slot]));
}

describe('Sortition — lowest vrf wins the seat (FR-SL-04)', () => {
  it('a later, better claim displaces the worst seated one and returns its stake', async () => {
    const [, treasury] = await ethers.getSigners();
    const rest = (await ethers.getSigners()).slice(2);
    const core = await deployCourt(baseCfg(treasury.address));

    const App = await ethers.getContractFactory('MockArbitrable');
    const app = (await App.deploy(await core.getAddress())) as any;
    await app.waitForDeployment();

    // Eight candidates for a five-seat over-draw, so three must lose.
    const jurors = rest.slice(0, 8);
    for (const j of jurors) await (await core.connect(j).stake({ value: 100n })).wait();
    await (await app.createDispute(2, { value: await core.arbitrationCost('0x') })).wait();
    const disputeId = 1n;
    await mine(2);

    const seed = await core.drawSeed(disputeId);
    const ranked = [...jurors].sort((a, b) => (vrfOf(seed, a.address, 0) < vrfOf(seed, b.address, 0) ? -1 : 1));
    const target = Number(await core.drawTarget()); // 5

    // Claim in the WORST-first order. Under first-come admission the five worst would take every
    // seat and the three best would be refused; displacement must end with the opposite set.
    for (const j of [...ranked].reverse()) {
      await (await core.connect(j).claimSeat(disputeId)).wait();
    }

    const seats = await core.getSeats(disputeId);
    expect(seats.length).to.equal(target);

    const seated = new Set(seats.map((s: any) => s.juror.toLowerCase()));
    for (const j of ranked.slice(0, target)) {
      expect(seated.has(j.address.toLowerCase()), `best ${j.address} should hold a seat`).to.equal(true);
    }
    for (const j of ranked.slice(target)) {
      expect(seated.has(j.address.toLowerCase()), `worst ${j.address} should be displaced`).to.equal(false);
      // A displaced claim gets its locked slot stake back, free to claim elsewhere.
      expect(await core.staked(j.address)).to.equal(100n);
      expect((await core.jurorRoundOf(disputeId, j.address)).seatCount).to.equal(0n);
    }
  });

  it('refuses a claim that is worse than every seat already taken', async () => {
    const [, treasury] = await ethers.getSigners();
    const rest = (await ethers.getSigners()).slice(2);
    const core = await deployCourt(baseCfg(treasury.address));
    const App = await ethers.getContractFactory('MockArbitrable');
    const app = (await App.deploy(await core.getAddress())) as any;
    await app.waitForDeployment();

    const jurors = rest.slice(0, 6);
    for (const j of jurors) await (await core.connect(j).stake({ value: 100n })).wait();
    await (await app.createDispute(2, { value: await core.arbitrationCost('0x') })).wait();
    await mine(2);

    const seed = await core.drawSeed(1n);
    const ranked = [...jurors].sort((a, b) => (vrfOf(seed, a.address, 0) < vrfOf(seed, b.address, 0) ? -1 : 1));

    // Seat the five best, then let the worst try.
    for (const j of ranked.slice(0, 5)) await (await core.connect(j).claimSeat(1n)).wait();
    const loser = ranked[5];
    await expect(core.connect(loser).claimSeat(1n)).to.be.revertedWithCustomError(core, 'NotEligible');
    expect((await core.getSeats(1n)).length).to.equal(5);
  });

  it('does not close the draw early when the over-draw fills', async () => {
    const [, treasury] = await ethers.getSigners();
    const rest = (await ethers.getSigners()).slice(2);
    const core = await deployCourt(baseCfg(treasury.address));
    const App = await ethers.getContractFactory('MockArbitrable');
    const app = (await App.deploy(await core.getAddress())) as any;
    await app.waitForDeployment();

    const jurors = rest.slice(0, 5);
    for (const j of jurors) await (await core.connect(j).stake({ value: 100n })).wait();
    await (await app.createDispute(2, { value: await core.arbitrationCost('0x') })).wait();
    await mine(2);
    for (const j of jurors) await (await core.connect(j).claimSeat(1n)).wait();

    // Full, but still Drawing: a better claim must still be able to arrive.
    expect((await core.getSeats(1n)).length).to.equal(5);
    expect(await core.disputeState(1n)).to.equal(1);
    await expect(core.closeDrawing(1n)).to.be.revertedWithCustomError(core, 'TooEarly');

    await mine(101);
    await (await core.closeDrawing(1n)).wait();
    expect(await core.disputeState(1n)).to.equal(2);
  });
});

describe('Sortition — parties are off their own panel (FR-SL-07)', () => {
  it('bars every address the app declared at creation, and nobody else', async () => {
    const [, treasury, payer, payee, outsider] = await ethers.getSigners();
    const core = await deployCourt(baseCfg(treasury.address));

    const Escrow = await ethers.getContractFactory('SimpleEscrow');
    const escrow = (await Escrow.deploy(await core.getAddress())) as any;
    await escrow.waitForDeployment();

    await (await escrow.connect(payer).fund(payee.address, { value: 1000n })).wait();
    await (await escrow.connect(payer).dispute(1n, { value: await core.arbitrationCost('0x') })).wait();
    const disputeId = 1n;

    // SimpleEscrow declares both parties, so the core knows to bar them.
    expect(await core.isExcluded(disputeId, payer.address)).to.equal(true);
    expect(await core.isExcluded(disputeId, payee.address)).to.equal(true);
    expect(await core.isExcluded(disputeId, outsider.address)).to.equal(false);
    expect(await core.isExcluded(disputeId, await escrow.getAddress())).to.equal(true); // the app itself

    for (const who of [payer, payee, outsider]) {
      await (await core.connect(who).stake({ value: 100n })).wait();
    }
    await mine(2);

    await expect(core.connect(payer).claimSeat(disputeId)).to.be.revertedWithCustomError(core, 'NotEligible');
    await expect(core.connect(payee).claimSeat(disputeId)).to.be.revertedWithCustomError(core, 'NotEligible');

    // An unrelated juror is unaffected.
    await (await core.connect(outsider).claimSeat(disputeId)).wait();
    expect((await core.jurorRoundOf(disputeId, outsider.address)).seatCount).to.equal(1n);
  });

  it('rejects a party list longer than the cap', async () => {
    const [, treasury] = await ethers.getSigners();
    const core = await deployCourt(baseCfg(treasury.address));
    const App = await ethers.getContractFactory('MockArbitrable');
    const app = (await App.deploy(await core.getAddress())) as any;
    await app.waitForDeployment();

    // MockArbitrable passes no extraData, so drive the core through a direct call from it.
    const tooMany = Array.from({ length: 17 }, (_, i) =>
      ethers.getAddress('0x' + (i + 1).toString(16).padStart(40, '0')),
    );
    const iface = new ethers.Interface([
      'function createDispute(uint8 choices, bytes extraData) payable returns (uint256)',
    ]);
    const data = iface.encodeFunctionData('createDispute', [2, ethers.AbiCoder.defaultAbiCoder().encode(['address[]'], [tooMany])]);
    const cost = await core.arbitrationCost('0x');
    await expect(app.forward(await core.getAddress(), data, { value: cost })).to.be.reverted;
  });
});
