// Dispute model: state, phase deadlines, seats, and the settlement each seat got.

import { ethers } from 'ethers';
import { read } from './chain';
import { coreAbi, type CourtConfig } from './contracts';

export enum DisputeState {
  None = 0,
  Evidence = 1,
  Drawing = 2,
  Committing = 3,
  Revealing = 4,
  Resolved = 5,
}

export const STATE_LABEL: Record<DisputeState, string> = {
  [DisputeState.None]: 'None',
  [DisputeState.Evidence]: 'Evidence',
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
  /** Resolved to 0 because most of the panel could not reach the evidence. */
  voided: boolean;
  /**
   * The delivered ruling is the court's configured fallback, not one the votes produced.
   * Settlement still ran at ruling 0, so every revealer was paid — read it before judging a seat.
   */
  fallbackRuling: boolean;
  /** Panels already burned to a quorum failure on this dispute. */
  redraws: number;
  state: DisputeState;
  evidenceDeadline: bigint;
  drawBlock: bigint;
  commitDeadline: bigint;
  revealDeadline: bigint;
  seatCount: number;
  seatedWeight: number;
  revealedCount: number;
  unavailableWeight: number;
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

export interface EvidenceItem {
  index: number;
  submitter: string;
  contentHash: string;
  submittedAt: bigint;
  sizeBytes: number;
  /** Bond the filer posted. Zero for a party — they file free. */
  bond: bigint;
  bondReclaimed: boolean;
  uri: string;
}

export interface JurorRound {
  seatCount: number;
  dutySeats: number;
  committed: boolean;
  revealed: boolean;
  /** Answered by reporting the record unreachable instead of voting. */
  reportedUnavailable: boolean;
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
    voided: d.voided,
    fallbackRuling: d.fallbackRuling,
    redraws: Number(d.redraws),
    state: Number(d.state) as DisputeState,
    evidenceDeadline: d.evidenceDeadline,
    drawBlock: d.drawBlock,
    commitDeadline: d.commitDeadline,
    revealDeadline: d.revealDeadline,
    seatCount: Number(d.seatCount),
    seatedWeight: Number(d.seatedWeight),
    revealedCount: Number(d.revealedCount),
    unavailableWeight: Number(d.unavailableWeight),
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

/** Evidence pointers a dispute carries. Read from storage, so no indexer is required. */
export async function getEvidence(core: string, id: bigint): Promise<EvidenceItem[]> {
  const rows = (await read(core, coreAbi, 'getEvidence', [id]))[0] as any[];
  return rows.map((r, index) => ({
    index,
    submitter: r.submitter,
    contentHash: r.contentHash,
    submittedAt: r.submittedAt,
    sizeBytes: Number(r.sizeBytes),
    bond: r.bond as bigint,
    bondReclaimed: r.bondReclaimed as boolean,
    uri: r.uri,
  }));
}

/** The ERC-1497 group this dispute's filings are logged under. */
export const evidenceGroupOf = async (core: string, id: bigint) =>
  (await read(core, coreAbi, 'evidenceGroupOf', [id]))[0] as bigint;

export async function jurorRoundOf(core: string, id: bigint, juror: string): Promise<JurorRound> {
  const j = (await read(core, coreAbi, 'jurorRoundOf', [id, juror]))[0] as any;
  return {
    seatCount: Number(j.seatCount),
    dutySeats: Number(j.dutySeats),
    committed: j.committed,
    revealed: j.revealed,
    reportedUnavailable: j.reportedUnavailable,
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
    case DisputeState.Evidence:
      return { endsAt: d.evidenceDeadline, crank: 'openDrawing' };
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
  // In a void nobody is slashed: answering (either way) is paid, and silence just gets its stake.
  if (d.voided) return round.revealed || round.reportedUnavailable ? 'rewarded' : 'released';
  // A fallback ruling was not produced by the votes, and settlement ran at ruling 0 — every
  // revealer was rewarded. Comparing a juror's choice against it would label paid jurors slashed.
  const noVerdict = d.ruling === 0 || d.fallbackRuling;
  const rewarded = round.revealed && (noVerdict || round.choice === d.ruling);
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
  if (d.state !== DisputeState.Resolved) return null;
  // A non-zero ruling that the court supplied itself is still a no-verdict settlement.
  if (d.ruling !== 0 && !d.fallbackRuling) return null;
  if (d.voided) return 'the evidence could not be retrieved by most of the panel';
  if (d.tied) return 'genuine tie';
  if (d.redraws > 0) return `too few jurors turned up, across ${d.redraws + 1} panels`;
  // The CAUSE, not the conclusion: callers already say the default was applied, and restating it
  // here produced "the jury settled nothing — the panel settled nothing, so the default was
  // applied — so the default applied". This is the branch an ordinary quorum miss lands on.
  if (d.fallbackRuling) return `too few jurors revealed (${d.revealedCount}/${quorumNeeded(cfg)})`;
  if (d.seatCount < cfg.panelSize) return 'undersubscribed draw — refunded';
  if (d.revealedCount < quorumNeeded(cfg)) return `quorum failed (${d.revealedCount}/${quorumNeeded(cfg)} revealed)`;
  return 'refused to arbitrate';
}
