// Dispute model: state, phase deadlines, seats, and the settlement each seat got.

import { ethers } from 'ethers';
import { read } from './chain';
import { coreAbi, type CourtConfig } from './contracts';

export enum DisputeState {
  None = 0,
  Drawing = 1,
  Committing = 2,
  Revealing = 3,
  Resolved = 4,
}

export const STATE_LABEL: Record<DisputeState, string> = {
  [DisputeState.None]: 'None',
  [DisputeState.Drawing]: 'Drawing',
  [DisputeState.Committing]: 'Committing',
  [DisputeState.Revealing]: 'Revealing',
  [DisputeState.Resolved]: 'Resolved',
};

export enum SeatRole {
  Released = 0,
  Seated = 1,
  Silent = 2,
}

export const ROLE_LABEL: Record<SeatRole, string> = {
  [SeatRole.Released]: 'alternate (released)',
  [SeatRole.Seated]: 'seated',
  [SeatRole.Silent]: 'silent primary',
};

export interface Dispute {
  id: bigint;
  app: string;
  choices: number;
  ruling: number;
  tied: boolean;
  ruled: boolean;
  state: DisputeState;
  drawBlock: bigint;
  commitDeadline: bigint;
  revealDeadline: bigint;
  seatCount: number;
  seatedWeight: number;
  revealedCount: number;
  feePot: bigint;
  configHash: string;
}

export interface Seat {
  juror: string;
  slot: number;
  role: SeatRole;
  settled: boolean;
  vrfOutput: bigint;
  slotStake: bigint;
}

export interface JurorRound {
  seatCount: number;
  dutySeats: number;
  committed: boolean;
  revealed: boolean;
  choice: number;
  commitment: string;
}

export async function getDispute(core: string, id: bigint): Promise<Dispute> {
  const d = (await read(core, coreAbi, 'getDispute', [id]))[0] as any;
  return {
    id,
    app: d.app,
    choices: Number(d.choices),
    ruling: Number(d.ruling),
    tied: d.tied,
    ruled: d.ruled,
    state: Number(d.state) as DisputeState,
    drawBlock: d.drawBlock,
    commitDeadline: d.commitDeadline,
    revealDeadline: d.revealDeadline,
    seatCount: Number(d.seatCount),
    seatedWeight: Number(d.seatedWeight),
    revealedCount: Number(d.revealedCount),
    feePot: d.feePot,
    configHash: d.configHash,
  };
}

export async function getSeats(core: string, id: bigint): Promise<Seat[]> {
  const rows = (await read(core, coreAbi, 'getSeats', [id]))[0] as any[];
  return rows.map((s) => ({
    juror: s.juror,
    slot: Number(s.slot),
    role: Number(s.role) as SeatRole,
    settled: s.settled,
    vrfOutput: s.vrfOutput,
    slotStake: s.slotStake,
  }));
}

export async function jurorRoundOf(core: string, id: bigint, juror: string): Promise<JurorRound> {
  const j = (await read(core, coreAbi, 'jurorRoundOf', [id, juror]))[0] as any;
  return {
    seatCount: Number(j.seatCount),
    dutySeats: Number(j.dutySeats),
    committed: j.committed,
    revealed: j.revealed,
    choice: Number(j.choice),
    commitment: j.commitment,
  };
}

/** Commitment the contract checks a reveal against. */
export const commitmentOf = (id: bigint, juror: string, choice: number, salt: string) =>
  ethers.solidityPackedKeccak256(['uint256', 'address', 'uint8', 'bytes32'], [id, juror, choice, salt]);

/** The block a dispute's current phase ends at, and which crank advances it. */
export function phaseDeadline(d: Dispute, cfg: CourtConfig): { endsAt: bigint; crank: string } | null {
  switch (d.state) {
    case DisputeState.Drawing:
      return { endsAt: d.drawBlock + cfg.drawWindowBlocks, crank: 'closeDrawing' };
    case DisputeState.Committing:
      return { endsAt: d.commitDeadline, crank: 'openReveal' };
    case DisputeState.Revealing:
      return { endsAt: d.revealDeadline, crank: 'finalize' };
    default:
      return null;
  }
}

/** Revealed weight a verdict needs: ceil(panelSize * quorumBps / 10000). */
export const quorumNeeded = (cfg: CourtConfig) =>
  Math.ceil((cfg.panelSize * cfg.quorumBps) / 10_000);

export type Outcome = 'rewarded' | 'slashed-gamma' | 'slashed-beta' | 'released' | 'pending';

/** What a settled seat actually got. FR-ST-02: on ruling 0 a revealer is rewarded, never slashed. */
export function seatOutcome(seat: Seat, round: JurorRound, d: Dispute): Outcome {
  if (d.state !== DisputeState.Resolved) return 'pending';
  if (seat.role === SeatRole.Released) return 'released';
  const rewarded = round.revealed && (d.ruling === 0 || round.choice === d.ruling);
  if (rewarded) return 'rewarded';
  return seat.role === SeatRole.Seated && round.revealed ? 'slashed-beta' : 'slashed-gamma';
}

export const OUTCOME_LABEL: Record<Outcome, string> = {
  rewarded: 'paid: stake + fee + pot share',
  'slashed-beta': 'slashed β (revealed, but wrong)',
  'slashed-gamma': 'slashed γ (silent)',
  released: 'stake back, no fee',
  pending: 'not settled yet',
};

/** Why a dispute carried no verdict. */
export function noVerdictReason(d: Dispute, cfg: CourtConfig): string | null {
  if (d.state !== DisputeState.Resolved || d.ruling !== 0) return null;
  if (d.tied) return 'genuine tie';
  if (d.seatCount < cfg.panelSize) return 'undersubscribed draw — refunded';
  if (d.revealedCount < quorumNeeded(cfg)) return `quorum failed (${d.revealedCount}/${quorumNeeded(cfg)} revealed)`;
  return 'refused to arbitrate';
}
