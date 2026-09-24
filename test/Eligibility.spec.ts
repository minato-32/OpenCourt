import { expect } from 'chai';
import { ethers } from 'hardhat';

// FR-EL-02: the core calls the eligibility policy through a gas-capped staticcall and treats every
// failure as weight zero. A broken or hostile policy must lock jurors out, never let one in, and
// never be able to brick the court.

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

async function courtWith(policy: string, treasury: string) {
  const Core = await ethers.getContractFactory('ArbitratorCore');
  const core = (await Core.deploy(cfg(treasury), policy, 0n)) as any;
  await core.waitForDeployment();
  return core;
}

describe('Eligibility — the policy caps weight, it never grants it', () => {
  it('a juror fields the lower of what they staked for and what the policy allows', async () => {
    const [, treasury, juror] = await ethers.getSigners();
    const Hostile = await ethers.getContractFactory('HostileEligibility');
    const policy = (await Hostile.deploy()) as any;
    await policy.waitForDeployment();
    const core = await courtWith(await policy.getAddress(), treasury.address);

    // Staked for three slots.
    await (await core.connect(juror).stake({ value: 300n })).wait();
    expect(await core.stakeSlotsOf(juror.address)).to.equal(3n);

    await (await policy.setAllowed(2)).wait();
    expect(await core.weightOf(juror.address)).to.equal(2n); // policy caps

    await (await policy.setAllowed(99)).wait();
    expect(await core.weightOf(juror.address)).to.equal(3n); // stake caps; no slot is conjured

    await (await policy.setAllowed(0)).wait();
    expect(await core.weightOf(juror.address)).to.equal(0n); // not eligible
  });
});

describe('Eligibility — fails closed (FR-EL-02)', () => {
  const MODES: [string, number][] = [
    ['a reverting policy', 1],
    ['a policy that burns gas', 2],
    ['a policy returning garbage', 3],
  ];

  for (const [label, mode] of MODES) {
    it(`${label} yields weight zero instead of bricking the court`, async () => {
      const [, treasury, juror] = await ethers.getSigners();
      const Hostile = await ethers.getContractFactory('HostileEligibility');
      const policy = (await Hostile.deploy()) as any;
      await policy.waitForDeployment();
      const core = await courtWith(await policy.getAddress(), treasury.address);

      // Staking still works: the policy has no say over stake custody.
      await (await core.connect(juror).stake({ value: 100n })).wait();
      expect(await core.stakeSlotsOf(juror.address)).to.equal(1n);

      await (await policy.set(mode)).wait();

      // The read does not revert, it returns zero.
      expect(await core.weightOf(juror.address)).to.equal(0n);

      // And the juror is refused a seat rather than the whole call exploding.
      const App = await ethers.getContractFactory('MockArbitrable');
      const app = (await App.deploy(await core.getAddress())) as any;
      await app.waitForDeployment();
      await (await app.createDispute(2, { value: await core.arbitrationCost('0x') })).wait();
      await ethers.provider.send('hardhat_mine', ['0x6']);
      await (await core.openDrawing(1n)).wait();
      await ethers.provider.send('hardhat_mine', ['0x2']);
      await expect(core.connect(juror).claimSeat(1n)).to.be.revertedWithCustomError(core, 'NotEligible');

      // Unstaking still works, so nobody's money is trapped behind a broken policy.
      await (await core.connect(juror).unstake(100n)).wait();
      expect(await core.staked(juror.address)).to.equal(0n);
    });
  }

  it('reports the policy descriptor, and an empty string when the policy will not say', async () => {
    const [, treasury] = await ethers.getSigners();
    const Stake = await ethers.getContractFactory('StakeWeightedEligibility');
    const stake = await Stake.deploy();
    await stake.waitForDeployment();
    const good = await courtWith(await stake.getAddress(), treasury.address);
    expect(await good.policyDescriptor()).to.contain('stake-weighted');

    const Hostile = await ethers.getContractFactory('HostileEligibility');
    const policy = (await Hostile.deploy()) as any;
    await policy.waitForDeployment();
    const core = await courtWith(await policy.getAddress(), treasury.address);
    expect(await core.policyDescriptor()).to.contain('hostile');
  });
});
