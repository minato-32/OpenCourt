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
  activationDelayBlocks: bigint;
  drawDelayBlocks: bigint;
  drawWindowBlocks: bigint;
  commitBlocks: bigint;
  revealBlocks: bigint;
  panelSize: number;
  betaBps: number;
  gammaBps: number;
  thetaBps: number;
  quorumBps: number;
  appFeeBps: number;
  protocolFeeBps: number;
  treasury: string;
}

export async function courtConfig(core: string): Promise<CourtConfig> {
  const c = await read(core, coreAbi, 'config');
  return {
    minStake: c[0] as bigint,
    jurorFee: c[1] as bigint,
    drawThreshold: c[2] as bigint,
    activationDelayBlocks: c[3] as bigint,
    drawDelayBlocks: c[4] as bigint,
    drawWindowBlocks: c[5] as bigint,
    commitBlocks: c[6] as bigint,
    revealBlocks: c[7] as bigint,
    panelSize: Number(c[8]),
    betaBps: Number(c[9]),
    gammaBps: Number(c[10]),
    thetaBps: Number(c[11]),
    quorumBps: Number(c[12]),
    appFeeBps: Number(c[13]),
    protocolFeeBps: Number(c[14]),
    treasury: c[15] as string,
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
