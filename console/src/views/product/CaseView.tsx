// The case as a person sees it: what is being decided, the evidence, where it stands, what to do.

import { useEffect, useState } from 'react';
import { read } from '../../lib/chain';
import { CHAIN, coreAbi, escrowAbi, type CourtConfig, type CourtDeployment } from '../../lib/contracts';
import {
  DisputeState,
  getEvidence,
  getSeats,
  jurorRoundOf,
  noVerdictReason,
  phaseDeadline,
  quorumNeeded,
  seatOutcome,
  type Dispute,
  type EvidenceItem,
  type JurorRound,
  type Seat,
} from '../../lib/dispute';
import { eventsForDispute, type IndexedEvent } from '../../lib/indexer';
import { blocksLeft, pas, short } from '../../lib/format';
import type { WalletAccount } from '../../lib/wallet';
import { DisputeActions } from '../DisputeActions';

/** What the escrow app calls each ruling, so a juror reads options instead of numbers. */
const CHOICE_LABEL: Record<number, { title: string; detail: string }> = {
  1: { title: 'Release to the payee', detail: 'The work stands; the escrow is paid out to whoever did it.' },
  2: { title: 'Refund the payer', detail: 'The delivery fell short; the escrow goes back to whoever paid.' },
};

const PHASE_STORY: Record<DisputeState, string> = {
  [DisputeState.None]: 'This case does not exist.',
  [DisputeState.Drawing]: 'A panel is being drawn. Jurors are claiming seats.',
  [DisputeState.Committing]: 'The panel is seated and voting in secret. No vote is visible yet.',
  [DisputeState.Revealing]: 'Jurors are revealing the votes they committed to.',
  [DisputeState.Resolved]: 'Decided.',
};

export function CaseView({
  court,
  dispute,
  cfg,
  head,
  account,
  onRefresh,
}: {
  court: CourtDeployment;
  dispute: Dispute;
  cfg: CourtConfig;
  head: number;
  account: WalletAccount | null;
  onRefresh: () => void;
}) {
  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [round, setRound] = useState<JurorRound | null>(null);
  const [parties, setParties] = useState<{ payer: string; payee: string; amount: bigint } | null>(null);
  const [timeline, setTimeline] = useState<IndexedEvent[]>([]);

  useEffect(() => {
    let live = true;
    (async () => {
      const [ev, st] = await Promise.all([getEvidence(court.core, dispute.id), getSeats(court.core, dispute.id)]);
      if (!live) return;
      setEvidence(ev);
      setSeats(st);

      // The escrow knows who the humans are; the protocol deliberately does not.
      try {
        const escrowId = (await read(court.escrow, escrowAbi, 'disputeToEscrow', [dispute.id]))[0] as bigint;
        if (escrowId > 0n) {
          const e = await read(court.escrow, escrowAbi, 'escrows', [escrowId]);
          if (live) setParties({ payer: e[0] as string, payee: e[1] as string, amount: e[2] as bigint });
        }
      } catch {
        setParties(null);
      }

      if (account) {
        const jr = await jurorRoundOf(court.core, dispute.id, account.h160);
        if (live) setRound(jr);
      }
      const events = await eventsForDispute(court.core, dispute.id.toString());
      if (live) setTimeline(events);
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [court.core, court.escrow, dispute.id, dispute.state, account, head]);

  const deadline = phaseDeadline(dispute, cfg);
  const reason = noVerdictReason(dispute, cfg);
  const mySeats = round?.seatCount ?? 0;
  const decided = dispute.state === DisputeState.Resolved;

  const outcomeLine = decided
    ? dispute.ruling === 0
      ? `No decision was reached — ${reason ?? 'the panel refused to rule'}. The escrow returns to the payer.`
      : `${CHOICE_LABEL[dispute.ruling]?.title ?? `Ruling ${dispute.ruling}`}.`
    : PHASE_STORY[dispute.state];

  return (
    <article className="case">
      <header className="case-head">
        <div>
          <span className="case-id">Case #{String(dispute.id)}</span>
          <h2>Escrow dispute over delivered work</h2>
          <p className="muted">
            {parties
              ? `${pas(parties.amount)} held in escrow · payer ${short(parties.payer)} · payee ${short(parties.payee)}`
              : 'Loading parties…'}
          </p>
        </div>
        <div className={`case-status s${dispute.state}`}>
          {decided ? 'Decided' : PHASE_STORY[dispute.state].split('.')[0]}
          {deadline && !decided && (() => {
            const left = blocksLeft(deadline.endsAt, head, CHAIN.blockTimeSeconds);
            // Past the deadline the phase is not waiting on time any more, it is waiting on a crank.
            return <span className="muted"> · {left === 'elapsed' ? `${deadline.crank} is due` : `${left} left`}</span>;
          })()}
        </div>
      </header>

      <p className="outcome-line">{outcomeLine}</p>

      {mySeats > 0 && !decided && (
        <div className="callout">
          You are on this jury with {mySeats} seat{mySeats === 1 ? '' : 's'}.
          {dispute.state === DisputeState.Committing && !round?.committed && ' Commit your vote before the window closes.'}
          {dispute.state === DisputeState.Revealing && round?.committed && !round.revealed &&
            ` Reveal now — a seat that stays silent loses ${cfg.gammaBps / 100}% of its stake.`}
        </div>
      )}

      <section className="case-block">
        <h3>What the jury decides</h3>
        <div className="choices">
          {Array.from({ length: dispute.choices }, (_, i) => i + 1).map((c) => (
            <div key={c} className={`choice ${decided && dispute.ruling === c ? 'won' : ''}`}>
              <span className="choice-n">{c}</span>
              <div>
                <strong>{CHOICE_LABEL[c]?.title ?? `Option ${c}`}</strong>
                <p className="muted">{CHOICE_LABEL[c]?.detail ?? 'Defined by the application.'}</p>
              </div>
              {decided && dispute.ruling === c && <span className="won-tag">chosen</span>}
            </div>
          ))}
        </div>
      </section>

      <section className="case-block">
        <h3>Evidence <span className="muted">({evidence.length})</span></h3>
        {evidence.length === 0 ? (
          <p className="muted">Nothing has been submitted for this case.</p>
        ) : (
          <ul className="evidence">
            {evidence.map((e, i) => {
              const from =
                parties && e.submitter.toLowerCase() === parties.payer.toLowerCase()
                  ? 'the payer'
                  : parties && e.submitter.toLowerCase() === parties.payee.toLowerCase()
                    ? 'the payee'
                    : 'a third party';
              return (
                <li key={i}>
                  <a href={e.uri} target="_blank" rel="noreferrer" className="ev-name">
                    {e.uri.split('/').pop()}
                  </a>
                  <div className="muted">
                    from {from} · {short(e.submitter)} · block {String(e.submittedAt)} ·{' '}
                    {(e.sizeBytes / 1024).toFixed(0)} KB
                  </div>
                  <div className="hint mono">sha256 {short(e.contentHash, 14)}</div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="hint">
          The chain stores the pointer and the hash, never the bytes. A juror can check the file they
          downloaded against the hash recorded here.
        </p>
      </section>

      <section className="case-block">
        <h3>Panel</h3>
        {seats.length === 0 ? (
          <p className="muted">No seats claimed yet.</p>
        ) : (
          <div className="panel-rows">
            {seats.map((s, i) => {
              const mine = account && s.juror.toLowerCase() === account.h160.toLowerCase();
              const outcome = round && mine ? seatOutcome(s, round, dispute) : null;
              return (
                <div key={i} className={`panel-row ${mine ? 'mine' : ''}`}>
                  <span className="mono">{short(s.juror)}</span>
                  {mine && <span className="tag">you</span>}
                  <span className="muted">
                    {decided && outcome ? outcome.replace('-', ' ') : `seat ${s.slot}`}
                  </span>
                </div>
              );
            })}
            <p className="hint">
              {dispute.revealedCount} of {quorumNeeded(cfg)} revealed votes needed for a verdict.
            </p>
          </div>
        )}
      </section>

      {timeline.length > 0 && (
        <section className="case-block">
          <h3>History <span className="muted">(from your local index)</span></h3>
          <ol className="timeline">
            {timeline.map((e) => (
              <li key={e.id}>
                <span className="tl-block mono">#{e.block}</span>
                <span className="tl-name">{e.name}</span>
                <span className="muted">
                  {Object.entries(e.args)
                    .filter(([k]) => k !== 'disputeId')
                    .map(([k, v]) => `${k} ${v.startsWith('0x') && v.length > 20 ? short(v) : v}`)
                    .join(' · ')}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="case-block">
        <h3>Your actions</h3>
        <DisputeActions
          court={court}
          cfg={cfg}
          dispute={dispute}
          round={round}
          head={head}
          account={account}
          onDone={onRefresh}
        />
      </section>
    </article>
  );
}
