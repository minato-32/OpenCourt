// Every dispute on a court: phase, panel, and what each seat was actually paid.

import { useEffect, useState } from 'react';
import { courtConfig, disputeCount, withdrawableOf, type CourtConfig, type CourtDeployment } from '../lib/contracts';
import {
  DisputeState,
  OUTCOME_LABEL,
  ROLE_LABEL,
  STATE_LABEL,
  getDispute,
  getSeats,
  jurorRoundOf,
  noVerdictReason,
  phaseDeadline,
  quorumNeeded,
  seatOutcome,
  type Dispute,
  type JurorRound,
  type Seat,
} from '../lib/dispute';
import { CHAIN } from '../lib/contracts';
import { blocksLeft, pas, short } from '../lib/format';
import type { WalletAccount } from '../lib/wallet';
import { DisputeActions } from './DisputeActions';

interface Row {
  dispute: Dispute;
  seats: Seat[];
  rounds: Record<string, JurorRound>;
  paid: Record<string, bigint>;
}

export function DisputeExplorer({
  court,
  head,
  account,
}: {
  court: CourtDeployment;
  head: number;
  account: WalletAccount | null;
}) {
  const [cfg, setCfg] = useState<CourtConfig | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setRows([]);
    setErr(null);

    (async () => {
      const config = await courtConfig(court.core);
      if (!live) return;
      setCfg(config);

      const n = await disputeCount(court.core);
      const out: Row[] = [];
      for (let id = n; id >= 1n; id--) {
        const dispute = await getDispute(court.core, id);
        const seats = await getSeats(court.core, id);
        const jurors = [...new Set(seats.map((s) => s.juror))];
        const rounds: Record<string, JurorRound> = {};
        const paid: Record<string, bigint> = {};
        for (const j of jurors) {
          rounds[j] = await jurorRoundOf(court.core, id, j);
          paid[j] = await withdrawableOf(court.core, j);
        }
        if (!live) return;
        out.push({ dispute, seats, rounds, paid });
        setRows([...out]);
      }
      if (live) setLoading(false);
    })().catch((e) => {
      if (!live) return;
      setErr(e?.message ?? String(e));
      setLoading(false);
    });

    return () => {
      live = false;
    };
  }, [court.core, nonce]);

  if (err) return <section className="card err-card">Explorer failed: {err}</section>;
  if (!rows.length) return <section className="card">{loading ? 'Loading disputes…' : 'No disputes on this court yet.'}</section>;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Disputes</h2>
        <span className="muted">{loading ? 'loading…' : `${rows.length} total`}</span>
      </div>

      {rows.map((row) => {
        const d = row.dispute;
        const key = d.id.toString();
        const isOpen = open === key;
        const deadline = cfg ? phaseDeadline(d, cfg) : null;
        const reason = cfg ? noVerdictReason(d, cfg) : null;

        return (
          <div key={key} className={`dispute ${isOpen ? 'open' : ''}`}>
            <button className="dispute-head" onClick={() => setOpen(isOpen ? null : key)}>
              <span className="id">#{key}</span>
              <span className={`pill s${d.state}`}>{STATE_LABEL[d.state]}</span>
              <span className="verdict">
                {d.state === DisputeState.Resolved
                  ? d.ruling === 0
                    ? `no verdict${reason ? ` — ${reason}` : ''}`
                    : `ruling ${d.ruling}`
                  : deadline
                    ? `${deadline.crank} in ${blocksLeft(deadline.endsAt, head, CHAIN.blockTimeSeconds)}`
                    : '—'}
              </span>
              <span className="muted">
                {d.seatCount} seats · {d.revealedCount} revealed
                {cfg ? ` / ${quorumNeeded(cfg)} needed` : ''}
              </span>
              <span className="chev">{isOpen ? '−' : '+'}</span>
            </button>

            {isOpen && (
              <div className="dispute-body">
                <div className="grid">
                  <Fact k="app" v={short(d.app)} />
                  <Fact k="choices" v={String(d.choices)} />
                  <Fact k="ruled (delivered)" v={d.ruled ? 'yes' : 'no'} />
                  <Fact k="tied" v={d.tied ? 'yes' : 'no'} />
                  <Fact k="fee pot" v={pas(d.feePot)} />
                  <Fact k="draw block" v={String(d.drawBlock)} />
                  <Fact k="commit deadline" v={String(d.commitDeadline)} />
                  <Fact k="reveal deadline" v={String(d.revealDeadline)} />
                </div>

                {d.state === DisputeState.Resolved && d.ruling === 0 && (
                  <div className="banner">
                    No verdict carried. FR-ST-02: every juror who revealed keeps their stake and is
                    paid the fee — only silence is slashed.
                  </div>
                )}

                {cfg && (
                  <DisputeActions
                    court={court}
                    cfg={cfg}
                    dispute={d}
                    round={account ? (row.rounds[account.h160] ?? null) : null}
                    head={head}
                    account={account}
                    onDone={() => setNonce((n) => n + 1)}
                  />
                )}

                <table className="seats">
                  <thead>
                    <tr>
                      <th>juror</th>
                      <th>slot</th>
                      <th>role</th>
                      <th>vote</th>
                      <th>outcome</th>
                      <th>stake locked</th>
                      <th>withdrawable now</th>
                    </tr>
                  </thead>
                  <tbody>
                    {row.seats.map((s, i) => {
                      const r = row.rounds[s.juror];
                      const outcome = seatOutcome(s, r, d);
                      const mine = account && s.juror.toLowerCase() === account.h160.toLowerCase();
                      return (
                        <tr key={i} className={mine ? 'mine' : ''}>
                          <td className="mono">
                            {short(s.juror)}
                            {mine && <span className="tag">you</span>}
                          </td>
                          <td>{s.slot}</td>
                          <td>{ROLE_LABEL[s.role]}</td>
                          <td>{r.revealed ? `choice ${r.choice}` : r.committed ? 'committed, not revealed' : 'nothing'}</td>
                          <td className={`outcome ${outcome}`}>{OUTCOME_LABEL[outcome]}</td>
                          <td>{pas(s.slotStake)}</td>
                          <td>{pas(row.paid[s.juror] ?? 0n)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="fact">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}
