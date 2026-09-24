/**
 * JuryArbitrator — a typed facade over ContractClient for ArbitratorCore (Phase 2).
 *
 * Splits into two seams:
 *   - app side:   create a dispute, prepay the fee, read the ruling/state.
 *   - juror side: stake, self-select + claim seats (k-slot), commit/reveal,
 *                 crank (closeDrawing/openReveal/finalize), pull payouts.
 *
 * The contract computes msg.sender as the H160 mapped from the calling substrate
 * account. Anything that binds to the juror identity (the commit hash, the
 * per-slot sortition draw) therefore needs the juror's EVM address explicitly —
 * the PAPI signer alone does not surface it. Those helpers take a `juror` arg.
 */

import { type PolkadotSigner } from 'polkadot-api';
import { ethers } from 'ethers';
import { ContractClient, type ContractClientOpts, type WriteResult } from './client.js';
import ArbitratorCoreAbi from './abi/ArbitratorCore.json';

/** Mirrors ArbitratorCore.DisputeState. */
export enum DisputeState {
  None = 0,
  Drawing = 1,
  Committing = 2,
  Revealing = 3,
  Resolved = 4,
}

/** Seat role fixed at openReveal (ArbitratorCore.ROLE_*). */
export enum SeatRole {
  Released = 0, // admitted alternate, not needed
  Seated = 1, // committed, on duty to reveal
  Silent = 2, // primary that never committed (still slashed)
}

/** Decoded ArbitratorCore.Dispute (getDispute). */
export interface DisputeView {
  app: string;
  choices: number;
  ruling: number;
  tied: boolean;
  ruled: boolean;
  state: DisputeState;
  drawBlock: bigint;
  commitDeadline: bigint;
  revealDeadline: bigint;
  seatCount: number; // total admitted seats
  seatedWeight: number; // ROLE_SEATED seats (set at openReveal)
  revealedCount: number; // revealed seat weight
  feePot: bigint;
  configHash: string;
}

/** Decoded ArbitratorCore.JurorRound (jurorRoundOf) — per juror, per dispute. */
export interface JurorRoundView {
  seatCount: number; // seats this juror holds
  dutySeats: number; // of those, ROLE_SEATED (set at openReveal)
  committed: boolean;
  revealed: boolean;
  choice: number;
  commitment: string;
}

/** Decoded ArbitratorCore.SeatEntry (getSeats) — one per admitted seat. */
export interface SeatEntryView {
  juror: string;
  slot: number; // the juror's stake-slot index
  role: SeatRole;
  settled: boolean;
  vrfOutput: bigint; // keccak(seed, juror, slot); lower = higher draw priority
  slotStake: bigint;
}

/** Decoded ArbitratorCore.CourtConfig (config). */
export interface CourtConfigView {
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

export interface RulingView {
  ruling: bigint;
  tied: boolean;
  finalized: boolean;
}

export class JuryArbitrator {
  readonly client: ContractClient;

  constructor(address: string, opts: ContractClientOpts = {}) {
    this.client = new ContractClient(address, ArbitratorCoreAbi as ethers.InterfaceAbi, opts);
  }

  // ------------------------------------------------------------------ app side
  /**
   * Prepay the arbitration fee and open a dispute over `choices`.
   *
   * `feeValue` must equal `arbitrationCost(extraData)` — the contract reverts with
   * WrongFee otherwise. The old default of 0n therefore GUARANTEED a revert, so when
   * `feeValue` is omitted (or 0n) we read the current cost and prepay exactly that.
   * Pass an explicit non-zero `feeValue` to skip the extra read.
   */
  async createDispute(
    signer: PolkadotSigner,
    choices: number,
    extraData: string = '0x',
    feeValue = 0n,
  ): Promise<WriteResult> {
    const fee = feeValue > 0n ? feeValue : await this.arbitrationCost(extraData);
    return this.client.write(signer, 'createDispute', [choices, extraData], fee);
  }

  /** Encode the parties of a dispute so the court bars them from its own panel (FR-SL-07). */
  static encodeParties(parties: string[]): string {
    return ethers.AbiCoder.defaultAbiCoder().encode(['address[]'], [parties]);
  }

  /** Whether an address is barred from a dispute's panel. */
  async isExcluded(disputeId: bigint | number, who: string): Promise<boolean> {
    return (await this.client.read('isExcluded', [disputeId, who]))[0] as boolean;
  }

  /** Grossed-up fee an app must prepay (jurors paid first; incl. app+protocol take). */
  async arbitrationCost(extraData: string = '0x'): Promise<bigint> {
    const r = await this.client.read('arbitrationCost', [extraData]);
    return r[0] as bigint;
  }

  /** Attach an evidence CID to a live dispute (event-only, no storage). */
  async submitEvidence(
    signer: PolkadotSigner,
    disputeId: bigint | number,
    cid: string,
    contentHash: string,
    sizeBytes: number,
  ): Promise<WriteResult> {
    return this.client.write(signer, 'submitEvidence', [disputeId, cid, contentHash, sizeBytes]);
  }

  /** Every evidence pointer on a dispute, read from storage — no indexer needed. */
  async getEvidence(disputeId: bigint | number) {
    const rows = (await this.client.read('getEvidence', [disputeId]))[0] as any[];
    return rows.map((r) => ({
      submitter: r.submitter as string,
      contentHash: r.contentHash as string,
      submittedAt: r.submittedAt as bigint,
      sizeBytes: Number(r.sizeBytes),
      uri: r.uri as string,
    }));
  }

  async currentRuling(disputeId: bigint | number): Promise<RulingView> {
    const r = await this.client.read('currentRuling', [disputeId]);
    return { ruling: r.ruling as bigint, tied: r.tied as boolean, finalized: r.finalized as boolean };
  }

  async disputeState(disputeId: bigint | number): Promise<DisputeState> {
    const r = await this.client.read('disputeState', [disputeId]);
    return Number(r[0]) as DisputeState;
  }

  async getDispute(disputeId: bigint | number): Promise<DisputeView> {
    const r = await this.client.read('getDispute', [disputeId]);
    const d = r[0];
    return {
      app: d.app as string,
      choices: Number(d.choices),
      ruling: Number(d.ruling),
      tied: d.tied as boolean,
      ruled: d.ruled as boolean,
      state: Number(d.state) as DisputeState,
      drawBlock: d.drawBlock as bigint,
      commitDeadline: d.commitDeadline as bigint,
      revealDeadline: d.revealDeadline as bigint,
      seatCount: Number(d.seatCount),
      seatedWeight: Number(d.seatedWeight),
      revealedCount: Number(d.revealedCount),
      feePot: d.feePot as bigint,
      configHash: d.configHash as string,
    };
  }

  /** Distinct jurors on a dispute's panel (deduped; a juror may hold many seats). */
  async getPanel(disputeId: bigint | number): Promise<string[]> {
    const r = await this.client.read('getPanel', [disputeId]);
    return Array.from(r[0] as string[]);
  }

  /** All admitted seats (one entry per seat; a juror may repeat under k-slots). */
  async getSeats(disputeId: bigint | number): Promise<SeatEntryView[]> {
    const r = await this.client.read('getSeats', [disputeId]);
    return Array.from(r[0] as unknown[]).map((s: any) => ({
      juror: s.juror as string,
      slot: Number(s.slot),
      role: Number(s.role) as SeatRole,
      settled: s.settled as boolean,
      vrfOutput: s.vrfOutput as bigint,
      slotStake: s.slotStake as bigint,
    }));
  }

  async drawSeed(disputeId: bigint | number): Promise<string> {
    const r = await this.client.read('drawSeed', [disputeId]);
    return r[0] as string;
  }

  /** Over-draw target: ceil(1.4 * panelSize) seats admitted during Drawing. */
  async drawTarget(): Promise<bigint> {
    const r = await this.client.read('drawTarget', []);
    return r[0] as bigint;
  }

  // ------------------------------------------------------------- juror reads
  /** Current finalized block height — for phase/deadline preconditions. */
  async blockNumber(): Promise<bigint> {
    return this.client.blockNumber();
  }

  async disputeCount(): Promise<bigint> {
    const r = await this.client.read('disputeCount', []);
    return r[0] as bigint;
  }

  async courtConfig(): Promise<CourtConfigView> {
    const c = await this.client.read('config', []);
    return {
      minStake: c.minStake as bigint,
      jurorFee: c.jurorFee as bigint,
      drawThreshold: c.drawThreshold as bigint,
      activationDelayBlocks: c.activationDelayBlocks as bigint,
      drawDelayBlocks: c.drawDelayBlocks as bigint,
      drawWindowBlocks: c.drawWindowBlocks as bigint,
      commitBlocks: c.commitBlocks as bigint,
      revealBlocks: c.revealBlocks as bigint,
      panelSize: Number(c.panelSize),
      betaBps: Number(c.betaBps),
      gammaBps: Number(c.gammaBps),
      thetaBps: Number(c.thetaBps),
      quorumBps: Number(c.quorumBps),
      appFeeBps: Number(c.appFeeBps),
      protocolFeeBps: Number(c.protocolFeeBps),
      treasury: c.treasury as string,
    };
  }

  /** A juror's per-dispute round record (commit/reveal + seat counts). */
  async jurorRoundOf(disputeId: bigint | number, juror: string): Promise<JurorRoundView> {
    const r = await this.client.read('jurorRoundOf', [disputeId, juror]);
    const s = r[0];
    return {
      seatCount: Number(s.seatCount),
      dutySeats: Number(s.dutySeats),
      committed: s.committed as boolean,
      revealed: s.revealed as boolean,
      choice: Number(s.choice),
      commitment: s.commitment as string,
    };
  }

  /** Number of independent slots a juror can field = floor(staked / minStake). */
  async weightOf(juror: string): Promise<bigint> {
    const r = await this.client.read('weightOf', [juror]);
    return r[0] as bigint;
  }

  /** Free (unlocked) stake for `juror`, in planck. */
  async stakedOf(juror: string): Promise<bigint> {
    const r = await this.client.read('staked', [juror]);
    return r[0] as bigint;
  }

  /** Pull-payment balance owed to `account`, in planck. */
  async withdrawableOf(account: string): Promise<bigint> {
    const r = await this.client.read('withdrawable', [account]);
    return r[0] as bigint;
  }

  // ------------------------------------------------------------- juror writes
  /** Lock `value` planck as jury stake (subject to activationDelayBlocks). */
  async stake(signer: PolkadotSigner, value: bigint): Promise<WriteResult> {
    return this.client.write(signer, 'stake', [], value);
  }

  async unstake(signer: PolkadotSigner, amount: bigint): Promise<WriteResult> {
    return this.client.write(signer, 'unstake', [amount]);
  }

  /** Claim every self-selecting slot for the caller in one tx (k-slot). */
  async claimSeat(signer: PolkadotSigner, disputeId: bigint | number): Promise<WriteResult> {
    return this.client.write(signer, 'claimSeat', [disputeId]);
  }

  /** Close the draw (Drawing -> Committing) after the claim window. Permissionless crank. */
  async closeDrawing(signer: PolkadotSigner, disputeId: bigint | number): Promise<WriteResult> {
    return this.client.write(signer, 'closeDrawing', [disputeId]);
  }

  /**
   * Commit a hidden vote (one commit covers all the juror's seats). The commitment
   * binds to the juror's EVM address (the H160 the contract sees as msg.sender),
   * so it must be supplied.
   */
  async commitVote(
    signer: PolkadotSigner,
    disputeId: bigint | number,
    choice: number,
    salt: string,
    juror: string,
  ): Promise<WriteResult> {
    // The commitment binds to `juror`, but the contract verifies the reveal against
    // msg.sender's H160. If the supplied `juror` is not exactly the address the
    // contract will see, the commit lands yet the reveal can never match — a silent
    // gammaBps slash. Normalise to a checksummed address and pre-flight that this
    // address actually holds a seat on the panel before committing.
    const normJuror = ethers.getAddress(juror);
    const jr = await this.jurorRoundOf(disputeId, normJuror);
    if (jr.seatCount === 0) {
      throw new Error(
        `commitVote: ${normJuror} holds no seat on dispute ${disputeId} — ` +
          `either it was not drawn or this is the wrong juror address (msg.sender mismatch). ` +
          `Committing now would be unrevealable (gammaBps slash).`,
      );
    }
    const commitment = JuryArbitrator.computeCommitment(disputeId, normJuror, choice, salt);
    return this.client.write(signer, 'commitVote', [disputeId, commitment]);
  }

  /** Advance Committing -> Revealing after the commit deadline (promotes alternates). */
  async openReveal(signer: PolkadotSigner, disputeId: bigint | number): Promise<WriteResult> {
    return this.client.write(signer, 'openReveal', [disputeId]);
  }

  async revealVote(
    signer: PolkadotSigner,
    disputeId: bigint | number,
    choice: number,
    salt: string,
  ): Promise<WriteResult> {
    return this.client.write(signer, 'revealVote', [disputeId, choice, salt]);
  }

  /** Tally + settle (or refund an undersubscribed draw). Callable by anyone. */
  async finalize(signer: PolkadotSigner, disputeId: bigint | number): Promise<WriteResult> {
    return this.client.write(signer, 'finalize', [disputeId]);
  }

  /**
   * Re-push a finalized ruling to the requesting app (e.g. if the app's callback
   * reverted on first delivery). No-op unless the dispute is already Resolved.
   */
  async redeliverRuling(signer: PolkadotSigner, disputeId: bigint | number): Promise<WriteResult> {
    return this.client.write(signer, 'redeliverRuling', [disputeId]);
  }

  async withdraw(signer: PolkadotSigner): Promise<WriteResult> {
    return this.client.write(signer, 'withdraw', []);
  }

  destroy() {
    this.client.destroy();
  }

  // ------------------------------------------------------------------ helpers
  /**
   * commitment = keccak256(abi.encodePacked(disputeId, juror, choice, salt)).
   * Mirrors ArbitratorCore.revealVote exactly.
   */
  static computeCommitment(
    disputeId: bigint | number,
    juror: string,
    choice: number,
    salt: string,
  ): string {
    return ethers.solidityPackedKeccak256(
      ['uint256', 'address', 'uint8', 'bytes32'],
      [disputeId, juror, choice, salt],
    );
  }

  /**
   * Per-slot hash sortition: keccak256(abi.encodePacked(seed, juror, slot)) < drawThreshold.
   * Mirrors ArbitratorCore.claimSeat.
   */
  static slotSelects(seed: string, juror: string, slot: number, drawThreshold: bigint): boolean {
    const h = ethers.solidityPackedKeccak256(['bytes32', 'address', 'uint16'], [seed, juror, slot]);
    return BigInt(h) < drawThreshold;
  }

  /** True if ANY of the juror's `weight` slots self-selects — worth spending a claimSeat tx. */
  static anySlotSelects(
    seed: string,
    juror: string,
    weight: bigint | number,
    drawThreshold: bigint,
  ): boolean {
    const w = Number(weight);
    for (let k = 0; k < w; k++) {
      if (JuryArbitrator.slotSelects(seed, juror, k, drawThreshold)) return true;
    }
    return false;
  }
}
