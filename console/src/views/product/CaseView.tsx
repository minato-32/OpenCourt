// The case as a person sees it: what is being decided, the evidence, where it stands, what to do.

import { useEffect, useState } from 'react';
import { read, simulate, write } from '../../lib/chain';
import { CHAIN, coreAbi, escrowAbi, type CourtConfig, type CourtDeployment } from '../../lib/contracts';
import {
  DisputeState,
  getEvidence,
  getSeats,
  jurorRoundOf,
  noVerdictReason,
  OUTCOME_LABEL,
  phaseDeadline,
  ROLE_LABEL,
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
import { EvidenceFiling } from './EvidenceFiling';

/** What the escrow app calls each ruling, so a juror reads options instead of numbers. */
const CHOICE_LABEL: Record<number, { title: string; detail: string }> = {
  1: { title: 'Release to the payee', detail: 'The work stands; the escrow is paid out to whoever did it.' },
  2: { title: 'Refund the payer', detail: 'The delivery fell short; the escrow goes back to whoever paid.' },
};

const PHASE_STORY: Record<DisputeState, string> = {
  [DisputeState.None]: 'This case does not exist.',
  [DisputeState.Evidence]: 'Both sides are filing evidence. No juror has been drawn yet.',
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
  const [rounds, setRounds] = useState<Record<string, JurorRound>>({});
  const [parties, setParties] = useState<{ payer: string; payee: string; amount: bigint } | null>(null);
  const [timeline, setTimeline] = useState<IndexedEvent[]>([]);
  const [bondMsg, setBondMsg] = useState('');

  useEffect(() => {
    let live = true;
    (async () => {
      const [ev, st] = await Promise.all([getEvidence(court.core, dispute.id), getSeats(court.core, dispute.id)]);
      if (!live) return;
      setEvidence(ev);
      setSeats(st);

      // Every juror's record, not just the connected account's: a panel where only one row shows an
      // outcome reads as though only one juror was settled.
      const jurors = [...new Set(st.map((x) => x.juror))];
      const byJuror: Record<string, JurorRound> = {};
      for (const j of jurors) byJuror[j.toLowerCase()] = await jurorRoundOf(court.core, dispute.id, j);
      if (!live) return;
      setRounds(byJuror);

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

  const me = account?.h160.toLowerCase();
  const isParty = !!parties && (me === parties.payer.toLowerCase() || me === parties.payee.toLowerCase());

  async function reclaimBond(index: number) {
    if (!account) return;
    const params = [dispute.id, BigInt(index)];
    const would = await simulate(account.ss58, court.core, coreAbi, 'reclaimEvidenceBond', params);
    if (would) return setBondMsg(`Would revert: ${would.reason} — nothing signed.`);
    try {
      await write(account.account.polkadotSigner, court.core, coreAbi, 'reclaimEvidenceBond', params);
      setBondMsg('Bond returned. Withdraw it from your balance whenever you like.');
      onRefresh();
    } catch (e: any) {
      setBondMsg(e?.message ?? String(e));
    }
  }

  const deadline = phaseDeadline(dispute, cfg);
  const reason = noVerdictReason(dispute, cfg);
  const mySeats = round?.seatCount ?? 0;
  const decided = dispute.state === DisputeState.Resolved;

  const outcomeLine = decided
    ? dispute.ruling === 0
      ? dispute.voided
        ? 'No decision was reached: most of the jury could not retrieve the evidence, so the case was voided and no juror was penalised. The escrow returns to the payer.'
        : `No decision was reached — ${reason ?? 'the panel refused to rule'}. The escrow returns to the payer.`
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

      {dispute.redraws > 0 && (
        <div className="banner warn">
          {dispute.redraws === 1 ? 'A panel' : `${dispute.redraws} panels`} failed to reach quorum on
          this case. Those jurors were released — paid if they voted, slashed if they went silent —
          and their forfeited stake paid for the panel sitting now.
        </div>
      )}

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
        <h3>
          Evidence <span className="muted">({evidence.length})</span>
          {dispute.state === DisputeState.Evidence ? (
            <span className="muted"> · still open</span>
          ) : (
            <span className="muted"> · frozen</span>
          )}
        </h3>
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
                  {e.bond > 0n && (
                    <div className="muted">
                      {pas(e.bond)} bond{e.bondReclaimed ? ' · returned' : decided ? ' · claimable' : ' · held'}
                      {decided && !e.bondReclaimed && me === e.submitter.toLowerCase() && (
                        <button className="btn ghost small" onClick={() => reclaimBond(e.index)}>
                          Claim it back
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {dispute.state === DisputeState.Evidence && (
          <EvidenceFiling
            court={court}
            cfg={cfg}
            disputeId={dispute.id}
            account={account}
            isParty={isParty}
            onDone={onRefresh}
          />
        )}

        {bondMsg && <div className="txline">{bondMsg}</div>}

        <p className="hint">
          The chain stores the pointer and the hash, never the bytes. A juror can check the file they
          downloaded against the hash recorded here.
          {dispute.state !== DisputeState.Evidence &&
            ' This record closed before the panel formed, so every juror judged exactly these files.'}
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
              const r = rounds[s.juror.toLowerCase()];
              const outcome = r ? seatOutcome(s, r, dispute) : 'pending';
              const vote = !r
                ? '…'
                : r.revealed
                  ? `voted ${CHOICE_LABEL[r.choice]?.title ?? r.choice}`
                  : r.reportedUnavailable
                    ? 'could not retrieve the evidence'
                    : r.committed
                      ? 'committed, never revealed'
                      : 'never voted';
              return (
                <div key={i} className={`panel-row ${mine ? 'mine' : ''}`}>
                  <span className="mono">{short(s.juror)}</span>
                  {mine && <span className="tag">you</span>}
                  <span className="muted">{vote}</span>
                  <span className={`outcome ${outcome}`}>{decided ? OUTCOME_LABEL[outcome] : ROLE_LABEL[s.role]}</span>
                </div>
              );
            })}
            <p className="hint">
              {dispute.revealedCount} of {seats.length} seats revealed · {quorumNeeded(cfg)} needed for a verdict
              {decided && dispute.revealedCount < quorumNeeded(cfg) ? ' — quorum was not met' : ''}
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
