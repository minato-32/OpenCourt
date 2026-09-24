// Deployed addresses, ABIs and typed reads. Addresses come from deployments/paseo-asset-hub-next.json.

import { ethers } from 'ethers';
import coreAbiJson from '../../../sdk/src/abi/ArbitratorCore.json';
import escrowAbiJson from '../../../sdk/src/abi/SimpleEscrow.json';
import appealAbiJson from '../../../sdk/src/abi/AppealCoordinator.json';
import registryAbiJson from '../../../sdk/src/abi/CourtRegistry.json';
import deployments from '../../../deployments/paseo-asset-hub-next.json';
import { read } from './chain';

export const coreAbi = coreAbiJson as ethers.InterfaceAbi;
export const escrowAbi = escrowAbiJson as ethers.InterfaceAbi;
export const appealAbi = appealAbiJson as ethers.InterfaceAbi;
export const registryAbi = registryAbiJson as ethers.InterfaceAbi;

export interface CourtDeployment {
  label: string;
  core: string;
  escrow: string;
  eligibility: string;
  /** Set when the court's eligibility policy reads a personhood registry. */
  registry?: string;
  note?: string;
}

/** Courts the console knows about; later slices can read these from CourtRegistry. */
export const COURTS: CourtDeployment[] = [
  {
    label: 'Canonical court',
    core: deployments.current.ArbitratorCore,
    escrow: deployments.current.SimpleEscrow,
    eligibility: deployments.current.StakeWeightedEligibility,
    note: deployments.current.note,
  },
  {
    label: 'Demo court (personhood gated)',
    core: deployments.demoCourt.ArbitratorCore,
    escrow: deployments.demoCourt.SimpleEscrow,
    eligibility: deployments.demoCourt.PopGatedEligibility,
    registry: deployments.demoCourt.PersonhoodRegistry,
    note: deployments.demoCourt.note,
  },
  {
    label: 'Feature-1 proof court',
    core: deployments.feature1LiveProof.ArbitratorCore,
    escrow: deployments.feature1LiveProof.SimpleEscrow,
    eligibility: deployments.feature1LiveProof.StakeWeightedEligibility,
    note: deployments.feature1LiveProof.note,
  },
];

export const CHAIN = {
  name: deployments.chain,
  wss: deployments.wss,
  blockTimeSeconds: deployments.blockTimeSeconds,
};

/** Court config as the constructor froze it. */
export interface CourtConfig {
  minStake: bigint;
  jurorFee: bigint;
  drawThreshold: bigint;
  evidenceBond: bigint;
  activationDelayBlocks: bigint;
  drawDelayBlocks: bigint;
  drawWindowBlocks: bigint;
  evidenceBlocks: bigint;
  commitBlocks: bigint;
  revealBlocks: bigint;
  panelSize: number;
  betaBps: number;
  gammaBps: number;
  thetaBps: number;
  quorumBps: number;
  appFeeBps: number;
  protocolFeeBps: number;
  pinFeeBps: number;
  treasury: string;
  pinner: string;
}

export async function courtConfig(core: string): Promise<CourtConfig> {
  const c = await read(core, coreAbi, 'config');
  return {
    minStake: c[0] as bigint,
    jurorFee: c[1] as bigint,
    drawThreshold: c[2] as bigint,
    evidenceBond: c[3] as bigint,
    evidenceBlocks: c[4] as bigint,
    activationDelayBlocks: c[5] as bigint,
    drawDelayBlocks: c[6] as bigint,
    drawWindowBlocks: c[7] as bigint,
    commitBlocks: c[8] as bigint,
    revealBlocks: c[9] as bigint,
    panelSize: Number(c[10]),
    betaBps: Number(c[11]),
    gammaBps: Number(c[12]),
    thetaBps: Number(c[13]),
    quorumBps: Number(c[14]),
    appFeeBps: Number(c[15]),
    protocolFeeBps: Number(c[16]),
    pinFeeBps: Number(c[17]),
    treasury: c[18] as string,
    pinner: c[19] as string,
  };
}

export const arbitrationCost = async (core: string) =>
  (await read(core, coreAbi, 'arbitrationCost', ['0x']))[0] as bigint;

export const disputeCount = async (core: string) =>
  (await read(core, coreAbi, 'disputeCount'))[0] as bigint;

export const drawTarget = async (core: string) =>
  (await read(core, coreAbi, 'drawTarget'))[0] as bigint;

export const withdrawableOf = async (core: string, who: string) =>
  (await read(core, coreAbi, 'withdrawable', [who]))[0] as bigint;

export const stakedOf = async (core: string, who: string) =>
  (await read(core, coreAbi, 'staked', [who]))[0] as bigint;

export const activeAtOf = async (core: string, who: string) =>
  (await read(core, coreAbi, 'activeAt', [who]))[0] as bigint;

export const weightOf = async (core: string, who: string) =>
  (await read(core, coreAbi, 'weightOf', [who]))[0] as bigint;

/** IEligibility is two functions; no need to ship a whole artifact for it. */
export const eligibilityAbi: ethers.InterfaceAbi = [
  {
    type: 'function',
    name: 'weightOf',
    stateMutability: 'view',
    inputs: [
      { name: 'juror', type: 'address' },
      { name: 'courtId', type: 'uint96' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'policyDescriptor',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
];

/** Slots the policy allows this juror, before the court caps it by stake. */
export const policyWeightOf = async (eligibility: string, who: string, courtId = 0) =>
  (await read(eligibility, eligibilityAbi, 'weightOf', [who, courtId]))[0] as bigint;

export const isEligible = async (eligibility: string, who: string, courtId = 0) =>
  (await policyWeightOf(eligibility, who, courtId)) > 0n;

/** What the court's policy says it enforces, read through the court so a broken policy reads empty. */
export const policyDescriptor = async (core: string) =>
  (await read(core, coreAbi, 'policyDescriptor'))[0] as string;

/** Slots a juror has staked for, before the policy caps them. */
export const stakeSlotsOf = async (core: string, who: string) =>
  (await read(core, coreAbi, 'stakeSlotsOf', [who]))[0] as bigint;

/** The subset of PersonhoodRegistry the console reads. */
export const registryAbiMin: ethers.InterfaceAbi = [
  { type: 'function', name: 'issuer', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'function',
    name: 'rebindCooldownBlocks',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'isVerified',
    stateMutability: 'view',
    inputs: [{ name: 'wallet', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
];

export async function registryInfo(registry: string) {
  const [issuer, cooldown] = await Promise.all([
    read(registry, registryAbiMin, 'issuer'),
    read(registry, registryAbiMin, 'rebindCooldownBlocks'),
  ]);
  return { issuer: issuer[0] as string, cooldownBlocks: cooldown[0] as bigint };
}

/** q* implied by a config, same one-third-dissent model the constructor guard uses. */
export function qStar(cfg: CourtConfig): number {
  const BPS = 10_000n;
  const incoherent = BigInt(Math.floor(cfg.panelSize / 3));
  const coherent = BigInt(cfg.panelSize) - incoherent;
  const atRisk = (BigInt(cfg.betaBps) * cfg.minStake) / BPS;
  const potShare =
    coherent === 0n
      ? 0n
      : ((BPS - BigInt(cfg.thetaBps)) * BigInt(cfg.betaBps) * cfg.minStake * incoherent) /
        (BPS * BPS * coherent);
  const denom = atRisk + cfg.jurorFee + potShare;
  return denom === 0n ? 0 : Number((atRisk * 1_000_000n) / denom) / 1_000_000;
}
