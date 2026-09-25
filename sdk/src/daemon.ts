/**
 * JurorDaemon — a headless juror that plays a dispute end-to-end.
 *
 * Loop (poll-based; PAPI event subscription needs the typed descriptor, so we
 * poll disputeCount + disputeState instead — same guarantees, no descriptor):
 *
 *   Drawing   -> if this juror self-selects (keccak(seed,juror) < drawThreshold)
 *                and is not yet seated, claimSeat.
 *   Committing-> if seated and not yet committed, ask the decision callback for a
 *                choice, generate + PERSIST a salt (before submitting), commitVote.
 *   Revealing -> if committed and not yet revealed, load the salt and revealVote.
 *                If finalizeWhenDone, also try to finalize past the deadline.
 *
 * Every write is idempotent against the chain: the daemon reads seat state first
 * and swallows the "already seated / already committed / wrong state" reverts a
 * racing daemon or a re-run would trigger.
 */

import { type PolkadotSigner } from 'polkadot-api';
import { JuryArbitrator, DisputeState, type DisputeView, type CourtConfigView } from './arbitrator.js';
import { SaltKeystore, generateSalt } from './keystore.js';

/** Open ballots carry no commitment, so the contract ignores the salt entirely. */
const ZERO_SALT = '0x' + '0'.repeat(64);
import { type WriteResult } from './client.js';

/**
 * Decide how to vote on a dispute. Return a 1-based choice in [1, dispute.choices],
 * or 0 to ABSTAIN (the daemon will not commit — the juror eats the non-reveal
 * slash, which is the honest default until an operator supplies real logic).
 */
export type DecisionFn = (
  disputeId: bigint,
  dispute: DisputeView,
) => number | Promise<number>;

/** Default decision: abstain everywhere. Operators MUST override to actually vote. */
export const abstainDecision: DecisionFn = () => 0;

export interface JurorDaemonOpts {
  arbitrator: JuryArbitrator;
  signer: PolkadotSigner;
  /** The juror's EVM (H160) address — what the contract sees as msg.sender. */
  juror: string;
  keystore?: SaltKeystore;
  decide?: DecisionFn;
  /** Also attempt finalize() once a dispute is past its reveal deadline. Default false. */
  finalizeWhenDone?: boolean;
  /** Also attempt openReveal() once the commit deadline passes. Default true. */
  openRevealWhenDue?: boolean;
  /** Crank Evidence -> Drawing once the record's window lapses. On by default. */
  openDrawingWhenDue?: boolean;
  log?: (msg: string) => void;
}

export class JurorDaemon {
  private readonly arb: JuryArbitrator;
  private readonly signer: PolkadotSigner;
  private readonly juror: string;
  private readonly keystore: SaltKeystore;
  private readonly decide: DecisionFn;
  private readonly finalizeWhenDone: boolean;
  private readonly openRevealWhenDue: boolean;
  private readonly openDrawingWhenDue: boolean;
  private readonly log: (msg: string) => void;

  private config: CourtConfigView | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(opts: JurorDaemonOpts) {
    this.arb = opts.arbitrator;
    this.signer = opts.signer;
    this.juror = opts.juror;
    // Namespace salts by the arbitrator address so a redeploy at the same dispute ids
    // can't collide with (and shadow) an old deployment's secrets.
    this.keystore = opts.keystore ?? new SaltKeystore({ arbitrator: this.arb.client.address });
    this.decide = opts.decide ?? abstainDecision;
    this.finalizeWhenDone = opts.finalizeWhenDone ?? false;
    this.openRevealWhenDue = opts.openRevealWhenDue ?? true;
    this.openDrawingWhenDue = opts.openDrawingWhenDue ?? true;
    this.log = opts.log ?? ((m) => console.log(`[juror ${short(this.juror)}] ${m}`));
  }

  /** Sweep every dispute once and take whatever action its phase allows. */
  async runOnce(): Promise<void> {
    const count = await this.arb.disputeCount();
    if (!this.config) this.config = await this.arb.courtConfig();

    for (let id = 1n; id <= count; id++) {
      try {
        await this.handleDispute(id);
      } catch (err) {
        this.log(`dispute ${id}: ${errMsg(err)}`);
      }
    }
  }

  /** Poll runOnce() forever. Returns immediately; call stop() to end. */
  start(intervalMs = 12_000): void {
    if (this.timer) return;
    const tick = async () => {
      if (this.running) return; // never overlap sweeps
      this.running = true;
      try {
        await this.runOnce();
      } catch (err) {
        this.log(`sweep failed: ${errMsg(err)}`);
      } finally {
        this.running = false;
      }
    };
    void tick();
    this.timer = setInterval(tick, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ----------------------------------------------------------------- internal
  private async handleDispute(id: bigint): Promise<void> {
    const d = await this.arb.getDispute(id);
    const cfg = this.config!;

    switch (d.state) {
      case DisputeState.Evidence:
        // Nothing for a juror to do while the parties are still filing — but somebody has to
        // freeze the record, and the crank is permissionless.
        if (this.openDrawingWhenDue) await this.tryOpenDrawing(id, d);
        break;
      case DisputeState.Drawing:
        await this.tryClaimSeat(id, d, cfg);
        // Crank Drawing -> Committing (or refund an undersubscribed draw) once the
        // window lapses. Gated on block height so we never fee-burn a TooEarly revert.
        await this.tryCloseDrawing(id, d, cfg);
        break;
      case DisputeState.Committing:
        await this.tryCommit(id, d);
        if (this.openRevealWhenDue) await this.tryOpenReveal(id, d);
        break;
      case DisputeState.Revealing:
        await this.tryReveal(id);
        if (this.finalizeWhenDone) await this.tryFinalize(id, d);
        break;
      case DisputeState.Resolved:
      case DisputeState.None:
      default:
        break;
    }
  }

  private async tryClaimSeat(id: bigint, d: DisputeView, cfg: CourtConfigView): Promise<void> {
    const jr = await this.arb.jurorRoundOf(id, this.juror);
    if (jr.seatCount > 0) return; // already drawn this dispute

    // Precondition gate (mirrors ArbitratorCore.claimSeat): the draw is only open in
    // (drawBlock, drawBlock + drawWindowBlocks]. Outside it, claimSeat is a guaranteed
    // TooEarly / DrawClosed revert — don't spend a tx on it every 12s sweep.
    const now = await this.arb.blockNumber();
    if (now <= d.drawBlock) return; // draw not open yet (TooEarly)
    if (now > d.drawBlock + cfg.drawWindowBlocks) return; // draw window closed (DrawClosed)

    const seed = await this.arb.drawSeed(id);
    // Zero seed => the draw block's hash is not yet in scope; nothing selectable.
    if (/^0x0*$/.test(seed)) return;

    const weight = await this.arb.weightOf(this.juror);
    if (weight === 0n) return; // no active stake
    // k-slot: claim only if at least one of the juror's slots self-selects.
    if (!JuryArbitrator.anySlotSelects(seed, this.juror, weight, cfg.drawThreshold)) return;

    await this.submit(id, 'claimSeat', () => this.arb.claimSeat(this.signer, id), () =>
      this.isSeated(id),
    );
  }

  /** Crank Evidence -> Drawing once the record's window lapses. */
  private async tryOpenDrawing(id: bigint, d: DisputeView): Promise<void> {
    const now = await this.arb.blockNumber();
    if (now <= d.evidenceDeadline) return; // record still open — TooEarly
    await this.submit(id, 'openDrawing', () => this.arb.openDrawing(this.signer, id), async () =>
      (await this.arb.getDispute(id)).state !== DisputeState.Evidence,
    );
  }

  /** Crank Drawing -> Committing once the claim window lapses (or finalize if undersubscribed). */
  private async tryCloseDrawing(id: bigint, d: DisputeView, cfg: CourtConfigView): Promise<void> {
    const now = await this.arb.blockNumber();
    if (now <= d.drawBlock + cfg.drawWindowBlocks) return; // draw window still open — TooEarly

    if (d.seatCount < cfg.panelSize) {
      // Undersubscribed: closeDrawing would revert PanelFull; finalize() refunds instead.
      if (!this.finalizeWhenDone) return;
      await this.submit(id, 'finalize(undersubscribed)', () => this.arb.finalize(this.signer, id), () =>
        this.isResolved(id),
      );
      return;
    }

    await this.submit(id, 'closeDrawing', () => this.arb.closeDrawing(this.signer, id), () =>
      this.stateChangedFrom(id, DisputeState.Drawing),
    );
  }

  private async tryCommit(id: bigint, d: DisputeView): Promise<void> {
    // An open-ballot court (commitRequired == false) rejects commitVote outright; its jurors
    // cast a single open vote in the reveal window instead.
    if (!this.config!.commitRequired) return;
    const jr = await this.arb.jurorRoundOf(id, this.juror);
    if (jr.seatCount === 0) return; // never got drawn
    if (jr.committed) return; // already committed (one commit covers all seats)

    // Commit window closed => committing now is a guaranteed DrawClosed revert (and the
    // juror is heading for a silent slash). Skip the tx; the reveal-phase logic reports it.
    const now = await this.arb.blockNumber();
    if (now > d.commitDeadline) return;

    const choice = await this.decide(id, d);
    if (!choice || choice < 1 || choice > d.choices) {
      this.log(`dispute ${id}: abstaining (decision returned ${choice})`);
      return;
    }

    // Reuse a salt persisted by an earlier (possibly crashed) run — regenerating would
    // orphan any commitment already on-chain, making the vote unrevealable (gammaBps slash).
    // Only generate + persist when none exists yet; persist BEFORE submitting the commit.
    //
    // Keyed by REDRAW, not by dispute alone. A quorum failure reruns commit/reveal under the same
    // dispute id, and a juror who revealed in the previous round has already published that salt —
    // reusing it would let anyone brute-force the new commitment over the eight possible choices
    // and read the vote before the reveal window shut. Secret ballot, gone, for the jurors who did
    // the right thing.
    let salt = this.keystore.loadSalt(id, d.redraws);
    if (!salt) {
      salt = generateSalt();
      this.keystore.saveSalt(id, salt, d.redraws);
    }

    await this.submit(id, `commitVote(${choice})`, () =>
      this.arb.commitVote(this.signer, id, choice, salt!, this.juror), () => this.isCommitted(id),
    );
  }

  private async tryReveal(id: bigint): Promise<void> {
    const jr = await this.arb.jurorRoundOf(id, this.juror);
    if (jr.seatCount === 0 || jr.revealed) return;
    if (jr.reportedUnavailable) return; // answered already, the other way

    if (!this.config!.commitRequired) {
      // Open ballot: there is no commitment to recover a choice from, so ask for one now. The
      // salt is ignored by the contract in this mode.
      if (jr.dutySeats === 0) return;
      const d = await this.arb.getDispute(id);
      const open = await this.decide(id, d);
      if (!open || open < 1 || open > d.choices) {
        this.log(`dispute ${id}: abstaining (decision returned ${open})`);
        return;
      }
      await this.submit(id, `openVote(${open})`, () =>
        this.arb.revealVote(this.signer, id, open, ZERO_SALT), () => this.isRevealed(id),
      );
      return;
    }

    if (!jr.committed) return; // never committed, nothing to reveal (already slashed silent)
    if (jr.dutySeats === 0) return; // committed alternate that wasn't promoted — no duty

    const d = await this.arb.getDispute(id);
    // Reveal-time lookup: tolerant, because the commitment on chain is the judge of whether the
    // salt is the right one. tryCommit stays strict.
    const salt = this.keystore.loadSaltForReveal(id, d.redraws);
    if (!salt) {
      this.log(`dispute ${id}: SALT LOST — cannot reveal, will be slashed (gammaBps)`);
      return;
    }
    // Recover the committed choice by matching against the stored commitment.
    const choice = this.recoverChoice(id, salt, jr.commitment);
    if (choice === 0) {
      this.log(`dispute ${id}: stored salt does not match commitment — cannot reveal`);
      return;
    }

    await this.submit(id, `revealVote(${choice})`, () =>
      this.arb.revealVote(this.signer, id, choice, salt), () => this.isRevealed(id),
    );
  }

  /** Flip Committing -> Revealing once the commit deadline passes; gated so it never reverts TooEarly. */
  private async tryOpenReveal(id: bigint, d: DisputeView): Promise<void> {
    const now = await this.arb.blockNumber();
    if (now <= d.commitDeadline) return; // commit window still open — TooEarly
    await this.submit(id, 'openReveal', () => this.arb.openReveal(this.signer, id), () =>
      this.stateChangedFrom(id, DisputeState.Committing),
    );
  }

  private async tryFinalize(id: bigint, d: DisputeView): Promise<void> {
    const now = await this.arb.blockNumber();
    if (now <= d.revealDeadline) return; // reveal window still open — TooEarly
    await this.submit(id, 'finalize', () => this.arb.finalize(this.signer, id), () =>
      this.isResolved(id),
    );
  }

  // ---- state read-backs used to confirm a reverted write already took effect --------
  private async isSeated(id: bigint): Promise<boolean> {
    return (await this.arb.jurorRoundOf(id, this.juror)).seatCount > 0;
  }
  private async isCommitted(id: bigint): Promise<boolean> {
    return (await this.arb.jurorRoundOf(id, this.juror)).committed;
  }
  private async isRevealed(id: bigint): Promise<boolean> {
    return (await this.arb.jurorRoundOf(id, this.juror)).revealed;
  }
  private async isResolved(id: bigint): Promise<boolean> {
    return (await this.arb.disputeState(id)) === DisputeState.Resolved;
  }
  private async stateChangedFrom(id: bigint, from: DisputeState): Promise<boolean> {
    return (await this.arb.disputeState(id)) !== from;
  }

  /**
   * The juror committed choice C but only the (choice,salt)->commitment hash is
   * on-chain. Salt is known; brute-force the small choice space [1, MAX_CHOICES]
   * to recover C without trusting local bookkeeping. Returns 0 on no match.
   */
  private recoverChoice(id: bigint, salt: string, commitment: string): number {
    for (let c = 1; c <= MAX_CHOICES; c++) {
      if (JuryArbitrator.computeCommitment(id, this.juror, c, salt) === commitment) return c;
    }
    return 0;
  }

  /**
   * Run a write and, on revert, swallow it ONLY if a state read-back confirms the
   * intended effect is already in place (a racing daemon or a prior run did it).
   *
   * The old approach string-matched Solidity custom-error names against the revert
   * message — but pallet-revive surfaces a `ContractReverted` module error that does
   * NOT carry the error name, so the match never fired and every benign revert
   * rethrew (aborting the rest of the crank). Worse, blindly ignoring DrawClosed /
   * TooEarly would have hidden real slashes (a missed commit/reveal window). Reading
   * state back is both correct against the opaque error and refuses to mask a genuine
   * failure: if the effect is NOT in place, we rethrow so the operator sees it.
   */
  private async submit(
    id: bigint,
    label: string,
    fn: () => Promise<WriteResult>,
    confirmDone?: () => Promise<boolean>,
  ): Promise<void> {
    try {
      const { txHash } = await fn();
      this.log(`dispute ${id}: ${label} ok (${short(txHash)})`);
    } catch (err) {
      if (confirmDone) {
        try {
          if (await confirmDone()) {
            this.log(`dispute ${id}: ${label} already done (${errMsg(err)})`);
            return;
          }
        } catch {
          // read-back itself failed — fall through and rethrow the original error
        }
      }
      throw err;
    }
  }
}

const MAX_CHOICES = 8; // ArbitratorCore.MAX_CHOICES

function short(hex: string): string {
  return hex.length > 12 ? `${hex.slice(0, 8)}…${hex.slice(-4)}` : hex;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
