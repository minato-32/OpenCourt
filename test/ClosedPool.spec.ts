import { expect } from 'chai';
import { ethers } from 'hardhat';
import { mine } from '@nomicfoundation/hardhat-network-helpers';

// FR-PG — the guardrails that make an app-gated juror pool honest.
//
//   A court whose jurors the app picks is peer review by that app's members. Legitimate, but it
//   hands the app a lever, so: removals cannot reach a drawn panel, growth is rate-limited, no
//   single member dominates, the shape is immutable, and the result is always appealable to a
//   pool the app does not control.

const PREDICATE = 0;
const ATTESTATION = 1;
const ALLOWLIST = 2;
const REMOVAL_TIMELOCK = 100_800n;
const CLOSED_ACTIVATION = 201_600n;

function baseCfg(treasury: string, over: Record<string, any> = {}) {
  return {
    minStake: 100n, jurorFee: 10n, drawThreshold: ethers.MaxUint256,
    evidenceBond: 0n,
    evidenceBlocks: 5n, activationDelayBlocks: 0n, drawDelayBlocks: 1n, drawWindowBlocks: 100n,
    commitBlocks: 100n, revealBlocks: 100n, panelSize: 3n,
    betaBps: 1000n, gammaBps: 2500n, thetaBps: 2000n, quorumBps: 5000n,
    commitRequired: true, minPoolWeightMultiple: 0n,
    quorumFailure: 0n, tieBreak: 0n, defaultChoice: 0n, closedPool: false,
    appFeeBps: 0n, protocolFeeBps: 0n, pinFeeBps: 0n,
    treasury, pinner: ethers.ZeroAddress, ...over,
  };
}

async function pool(owner: string, over: Partial<{
  policyType: number; growthBps: bigint; epochBlocks: bigint; jurorCapBps: bigint; removals: boolean;
}> = {}) {
  const Pool = await ethers.getContractFactory('ClosedPoolEligibility');
  const p: any = await Pool.deploy(
    owner,
    over.policyType ?? ALLOWLIST,
    over.growthBps ?? 500n,
    over.epochBlocks ?? 50n,
    over.jurorCapBps ?? 1500n,
    over.removals ?? true,
    'members with >=5 completed orders and no open dispute',
  );
  await p.waitForDeployment();
  return p;
}

async function courtWith(policy: string, treasury: string, over: Record<string, any> = {}) {
  const Core = await ethers.getContractFactory('ArbitratorCore');
  const core: any = await Core.deploy(baseCfg(treasury, over), policy, 0n);
  await core.waitForDeployment();
  return core;
}

describe('FR-PG-02 / FR-PG-07 — a closed court declares itself and pays for it in time', () => {
  it('refuses a closed court whose activation delay is not the elevated one', async () => {
    const [owner, treasury] = await ethers.getSigners();
    const p = await pool(owner.address);
    const Core = await ethers.getContractFactory('ArbitratorCore');

    await expect(
      Core.deploy(baseCfg(treasury.address, { closedPool: true, activationDelayBlocks: 1000n }), await p.getAddress(), 0n),
    ).to.be.revertedWithCustomError(Core, 'BadConfig').withArgs('closedActivationDelay');

    // At the floor it deploys, and says what it is.
    const core = await courtWith(await p.getAddress(), treasury.address, {
      closedPool: true, activationDelayBlocks: CLOSED_ACTIVATION,
    });
    expect(await core.poolIsClosed()).to.equal(true);
    expect(await core.policyDescriptor()).to.contain('closed pool (allowlist)');
    expect(await core.policyDescriptor()).to.contain('completed orders');
  });

  it('holds an open court to nothing extra, and the registry agrees with the core', async () => {
    const [owner, treasury] = await ethers.getSigners();
    const p = await pool(owner.address);
    const core = await courtWith(await p.getAddress(), treasury.address);
    expect(await core.poolIsClosed()).to.equal(false);

    const Reg = await ethers.getContractFactory('CourtRegistry');
    const reg: any = await Reg.deploy();
    await reg.waitForDeployment();
    // Validation parity: a config that passes one and fails the other is the bug class.
    await expect(
      reg.validateConfig(baseCfg(treasury.address, { closedPool: true, activationDelayBlocks: 1000n }), await p.getAddress()),
    ).to.be.revertedWithCustomError(reg, 'BadConfig').withArgs('closedActivationDelay');
    await reg.validateConfig(
      baseCfg(treasury.address, { closedPool: true, activationDelayBlocks: CLOSED_ACTIVATION }),
      await p.getAddress(),
    );
  });
});

describe('FR-PG-01 — a closed pool is never the last word', () => {
  it('refuses a ladder whose final reachable round is app-gated', async () => {
    const [owner, treasury] = await ethers.getSigners();
    const p = await pool(owner.address);
    const closed = { closedPool: true, activationDelayBlocks: CLOSED_ACTIVATION };
    const peer = await courtWith(await p.getAddress(), treasury.address, { panelSize: 3n, ...closed });
    const alsoClosed = await courtWith(await p.getAddress(), treasury.address, { panelSize: 7n, ...closed });
    const neutral = await courtWith(await p.getAddress(), treasury.address, { panelSize: 7n });

    const Coord = await ethers.getContractFactory('AppealCoordinator');
    await expect(
      Coord.deploy([await peer.getAddress(), await alsoClosed.getAddress()], 100n, 2),
    ).to.be.revertedWithCustomError(Coord, 'ClosedPoolNeedsNeutralParent');

    // Packing a panel is pointless when an open pool can overturn it.
    const coord: any = await Coord.deploy([await peer.getAddress(), await neutral.getAddress()], 100n, 2);
    await coord.waitForDeployment();
    expect(await coord.poolIsClosed()).to.equal(true); // the first round is, and says so

    // A cap that makes the neutral court unreachable is the same failure wearing a disguise.
    await expect(
      Coord.deploy([await peer.getAddress(), await neutral.getAddress()], 100n, 1),
    ).to.be.revertedWithCustomError(Coord, 'ClosedPoolNeedsNeutralParent');
  });
});

describe('FR-PG-03 — a removal cannot reach a panel already drawn', () => {
  it('leaves a seated juror seated, paid, and able to withdraw', async () => {
    const signers = await ethers.getSigners();
    const [owner, treasury] = signers;
    const jurors = signers.slice(2, 5);
    const p = await pool(owner.address, { epochBlocks: 5n, growthBps: 500n, jurorCapBps: 1500n });
    // Admit the three over separate epochs so the growth cap is satisfied honestly.
    for (const j of jurors) {
      await (await p.admit(j.address, 1)).wait();
      await mine(6);
    }
    const core = await courtWith(await p.getAddress(), treasury.address);
    const App = await ethers.getContractFactory('MockArbitrable');
    const app: any = await App.deploy(await core.getAddress());
    await app.waitForDeployment();

    for (const j of jurors) await (await core.connect(j).stake({ value: 100n })).wait();
    await (await app.createDispute(2, { value: await core.arbitrationCost('0x') })).wait();
    await mine(6);
    await (await core.openDrawing(1n)).wait();
    await mine(2);
    for (const j of jurors) await (await core.connect(j).claimSeat(1n)).wait();

    // The app now turns on a juror who is already on the panel.
    const victim = jurors[0];
    const tx = await p.scheduleRemoval(victim.address);
    const rc = await tx.wait();
    const ev = rc.logs.map((l: any) => { try { return p.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === 'JurorRemoved');
    expect(ev.args.effectiveAt).to.equal(BigInt(rc.blockNumber) + REMOVAL_TIMELOCK);

    // Even once it bites, the drawn seat is untouched: the core reads the policy only at
    // claimSeat, and this juror's stake is already locked into a seat with a duty attached.
    await mine(Number(REMOVAL_TIMELOCK) + 1);
    expect(await p.weightOf(victim.address, 0)).to.equal(0n);
    expect(await core.weightOf(victim.address)).to.equal(0n); // cannot claim anything NEW

    await mine(101);
    await (await core.closeDrawing(1n)).wait();
    const salts: Record<string, string> = {};
    for (const j of jurors) {
      const salt = ethers.hexlify(ethers.randomBytes(32));
      salts[j.address] = salt;
      await (await core.connect(j).commitVote(1n, ethers.solidityPackedKeccak256(
        ['uint256', 'address', 'uint8', 'bytes32'], [1n, j.address, 1, salt],
      ))).wait();
    }
    await mine(101);
    await (await core.openReveal(1n)).wait();
    for (const j of jurors) await (await core.connect(j).revealVote(1n, 1, salts[j.address])).wait();
    await mine(101);
    await expect(core.finalize(1n)).to.not.emit(core, 'Slashed');

    // Removed, and still paid in full for the case they sat on.
    expect(await core.withdrawable(victim.address)).to.equal(110n);
    await expect(core.connect(victim).withdraw()).to.changeEtherBalance(victim, 110n);
  });

  it('refuses removals outright when the pool published that it does not do them', async () => {
    const [owner, , juror] = await ethers.getSigners();
    const p = await pool(owner.address, { removals: false });
    await (await p.admit(juror.address, 1)).wait();
    await expect(p.scheduleRemoval(juror.address)).to.be.revertedWithCustomError(p, 'RemovalsDisabled');
  });

  it('lets the app call a removal off, and nobody settle one early', async () => {
    const [owner, , juror] = await ethers.getSigners();
    const p = await pool(owner.address);
    await (await p.admit(juror.address, 1)).wait();
    await (await p.scheduleRemoval(juror.address)).wait();

    await expect(p.finalizeRemoval(juror.address)).to.be.revertedWithCustomError(p, 'BadPolicy');
    expect(await p.weightOf(juror.address, 0)).to.equal(1n); // still a full member meanwhile

    await (await p.cancelRemoval(juror.address)).wait();
    await mine(Number(REMOVAL_TIMELOCK) + 1);
    expect(await p.weightOf(juror.address, 0)).to.equal(1n);
  });
});

describe('FR-PG-04 / FR-PG-05 — the pool cannot be packed quietly', () => {
  it('rate-limits growth per epoch and logs what each epoch did', async () => {
    const signers = await ethers.getSigners();
    const owner = signers[0];
    const p = await pool(owner.address, { epochBlocks: 20n, growthBps: 500n });

    // An empty pool must be able to start: the cap is a rate, and 5% of nothing is nothing.
    expect(await p.growthHeadroom()).to.equal(1n);
    await (await p.admit(signers[2].address, 1)).wait();
    expect(await p.growthHeadroom()).to.equal(0n);
    await expect(p.admit(signers[3].address, 1))
      .to.be.revertedWithCustomError(p, 'GrowthCapReached').withArgs(0n, 1n);

    await mine(21);
    await expect(p.admit(signers[3].address, 1)).to.emit(p, 'PoolGrowth').withArgs(await p.epochStartedAt(), 0n, 1n);
    expect(await p.totalWeight()).to.equal(2n);
  });

  it('caps any one member as a share of the pool it would create', async () => {
    const signers = await ethers.getSigners();
    const owner = signers[0];
    const p = await pool(owner.address, { epochBlocks: 2n, growthBps: 500n, jurorCapBps: 1500n });

    // Build an honest pool of 20, one slot per epoch — the growth cap allows nothing faster.
    // Note the shape this forces: with growth capped at 5%, no SINGLE admission can ever be big
    // enough to hit a 15% weight cap, so the cap bites on a member raised over many epochs. That
    // is the realistic packing attempt, and the one worth testing.
    for (let i = 0; i < 20; i++) {
      await (await p.admit(signers[2 + (i % 15)].address, BigInt(Math.floor(i / 15) + 1))).wait();
      await mine(3);
    }
    expect(await p.totalWeight()).to.equal(20n);

    // A member the build loop left at weight 1, so each raise below is a real +1.
    const whale = signers[10];
    // 15% of a 21-weight pool is 3, so raising this member to 2 and then 3 is fine...
    await (await p.admit(whale.address, 2)).wait();
    await mine(3);
    await (await p.admit(whale.address, 3)).wait();
    await mine(3);
    // ...and the step that would make them a sixth of the pool is refused, measured against the
    // pool AS IT WOULD BE so the raise cannot justify itself by enlarging the denominator.
    await expect(p.admit(whale.address, 4))
      .to.be.revertedWithCustomError(p, 'JurorWeightCapReached').withArgs(3n, 4n);
  });

  it('refuses a pool whose published limits exceed the protocol ceilings', async () => {
    const [owner] = await ethers.getSigners();
    const Pool = await ethers.getContractFactory('ClosedPoolEligibility');
    const args = (growth: bigint, cap: bigint, desc = 'x') =>
      [owner.address, PREDICATE, growth, 50n, cap, true, desc] as const;
    await expect(Pool.deploy(...args(501n, 1500n))).to.be.revertedWithCustomError(Pool, 'BadPolicy').withArgs('growth');
    await expect(Pool.deploy(...args(500n, 1501n))).to.be.revertedWithCustomError(Pool, 'BadPolicy').withArgs('jurorCap');
    // FR-PG-08: a pool that will not say what its rule is cannot be disclosed, so it cannot exist.
    await expect(Pool.deploy(...args(500n, 1500n, ''))).to.be.revertedWithCustomError(Pool, 'BadPolicy').withArgs('description');
  });

  it('does not let a removal bank growth for the epoch it lands in', async () => {
    const signers = await ethers.getSigners();
    const owner = signers[0];
    const p = await pool(owner.address, { epochBlocks: 2n, growthBps: 500n });

    await (await p.admit(signers[2].address, 1)).wait();
    await mine(3);
    await (await p.admit(signers[3].address, 1)).wait(); // rolls the epoch; opening becomes 1
    expect(await p.epochOpeningWeight()).to.equal(1n);
    expect(await p.growthHeadroom()).to.equal(0n); // this epoch's one admission is spent

    await (await p.scheduleRemoval(signers[2].address)).wait();
    await mine(Number(REMOVAL_TIMELOCK) + 1);
    await (await p.finalizeRemoval(signers[2].address)).wait();

    // The epoch's opening mark falls WITH the removal. Leaving it alone would make the pool look
    // as though it had shrunk below where the epoch began, handing the app back an admission it
    // had already used — churn out a member, admit two.
    expect(await p.totalWeight()).to.equal(1n);
    expect(await p.epochOpeningWeight()).to.equal(0n);
    expect(await p.growthHeadroom()).to.equal(0n);
  });

  it('describes itself for disclosure, whichever shape it is', async () => {
    const [owner] = await ethers.getSigners();
    expect(await (await pool(owner.address, { policyType: PREDICATE })).policyDescriptor())
      .to.contain('closed pool (predicate)');
    expect(await (await pool(owner.address, { policyType: ATTESTATION })).policyDescriptor())
      .to.contain('closed pool (attestation)');
  });

  it('lets only the owner move the membership', async () => {
    const [owner, , stranger] = await ethers.getSigners();
    const p = await pool(owner.address);
    await expect(p.connect(stranger).admit(stranger.address, 1)).to.be.revertedWithCustomError(p, 'NotOwner');
    await (await p.admit(stranger.address, 1)).wait();
    await expect(p.connect(stranger).scheduleRemoval(stranger.address)).to.be.revertedWithCustomError(p, 'NotOwner');
  });
});
