// Per-dispute actions: claim seat, commit, reveal, and the permissionless cranks.

import { useEffect, useState } from 'react';
import { simulate, write } from '../lib/chain';
import { CHAIN, coreAbi, type CourtConfig, type CourtDeployment } from '../lib/contracts';
import {
  DisputeState,
  commitmentOf,
  phaseDeadline,
  type Dispute,
  type JurorRound,
} from '../lib/dispute';
import * as keystore from '../lib/keystore';
import { blocksLeft, short } from '../lib/format';
import type { WalletAccount } from '../lib/wallet';

type Tx = { state: 'idle' | 'signing' | 'done' | 'error'; msg?: string };

export function DisputeActions({
  court,
  cfg,
  dispute,
  round,
  head,
  account,
  onDone,
}: {
  court: CourtDeployment;
  cfg: CourtConfig;
  dispute: Dispute;
  round: JurorRound | null;
  head: number;
  account: WalletAccount | null;
  onDone: () => void;
}) {
  const [tx, setTx] = useState<Tx>({ state: 'idle' });
  const [choice, setChoice] = useState(1);
  const [pass, setPass] = useState('');
  const [saved, setSaved] = useState<keystore.SaltRecord | undefined>();

  useEffect(() => {
    if (account) setSaved(keystore.peek(court.core, dispute.id, account.h160));
  }, [court.core, dispute.id, account, tx.state]);

  if (!account) return <p className="muted">Connect a wallet to act on this dispute.</p>;

  const deadline = phaseDeadline(dispute, cfg);
  const windowOpen = deadline ? BigInt(head) <= deadline.endsAt : false;

  async function run(label: string, fn: string, params: unknown[]) {
    if (!account) return;
    setTx({ state: 'signing', msg: `${label}…` });
    const would = await simulate(account.ss58, court.core, coreAbi, fn, params);
    if (would) return setTx({ state: 'error', msg: `${label} would revert: ${would.reason} — nothing signed` });
    try {
      const r = await write(account.account.polkadotSigner, court.core, coreAbi, fn, params);
      setTx({ state: 'done', msg: `${label} included in ${short(r.blockHash, 10)}` });
      onDone();
    } catch (e: any) {
      setTx({ state: 'error', msg: e?.message ?? String(e) });
    }
  }

  async function commit() {
    if (!account) return;
    if (!pass) return setTx({ state: 'error', msg: 'Set a passphrase first — it encrypts the salt you must reveal with.' });
    const salt = keystore.generateSalt();
    // Persist BEFORE signing: a commit whose salt was never stored is a guaranteed gamma slash.
    await keystore.put(court.core, dispute.id, account.h160, choice, salt, pass);
    await run(`Commit choice ${choice}`, 'commitVote', [
      dispute.id,
      commitmentOf(dispute.id, account.h160, choice, salt),
    ]);
  }

  async function reveal() {
    if (!account) return;
    if (!pass) return setTx({ state: 'error', msg: 'Enter the passphrase you used at commit time.' });
    let got;
    try {
      got = await keystore.get(court.core, dispute.id, account.h160, pass);
    } catch {
      return setTx({ state: 'error', msg: 'Wrong passphrase — the stored salt could not be decrypted.' });
    }
    if (!got) return setTx({ state: 'error', msg: 'No salt stored for this dispute on this browser.' });
    await run(`Reveal choice ${got.choice}`, 'revealVote', [dispute.id, got.choice, got.salt]);
  }

  const mySeats = round?.seatCount ?? 0;

  return (
    <div className="dispute-actions">
      <div className="row">
        <span className="muted">
          you hold {mySeats} seat{mySeats === 1 ? '' : 's'}
          {round?.committed ? ' · committed' : ''}
          {round?.revealed ? ` · revealed choice ${round.choice}` : ''}
        </span>
        {deadline && (
          <span className="muted">
            {deadline.crank} {windowOpen ? `in ${blocksLeft(deadline.endsAt, head, CHAIN.blockTimeSeconds)}` : 'is due now'}
          </span>
        )}
      </div>

      <div className="actions">
        {dispute.state === DisputeState.Evidence && (
          <>
            <span className="muted">
              The record is open — either party may still file. It freezes before the panel forms.
            </span>
            <button
              className="btn ghost"
              disabled={tx.state === 'signing' || windowOpen}
              onClick={() => run('Close the record', 'openDrawing', [dispute.id])}
            >
              Close record and open draw
            </button>
          </>
        )}

        {dispute.state === DisputeState.Drawing && (
          <>
            <button className="btn" disabled={tx.state === 'signing'} onClick={() => run('Claim seat', 'claimSeat', [dispute.id])}>
              Claim seat
            </button>
            <button
              className="btn ghost"
              disabled={tx.state === 'signing' || windowOpen}
              onClick={() => run('Close drawing', 'closeDrawing', [dispute.id])}
            >
              Close drawing
            </button>
          </>
        )}

        {dispute.state === DisputeState.Committing && (
          <>
            <label className="field">
              <span>choice</span>
              <select className="select" value={choice} onChange={(e) => setChoice(Number(e.target.value))}>
                {Array.from({ length: dispute.choices }, (_, i) => i + 1).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>salt passphrase</span>
              <input className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
            </label>
            <button className="btn" disabled={tx.state === 'signing' || round?.committed} onClick={commit}>
              Commit vote
            </button>
            <button
              className="btn ghost"
              disabled={tx.state === 'signing' || windowOpen}
              onClick={() => run('Open reveal', 'openReveal', [dispute.id])}
            >
              Open reveal
            </button>
          </>
        )}

        {dispute.state === DisputeState.Revealing && (
          <>
            <label className="field">
              <span>salt passphrase</span>
              <input className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
            </label>
            <button className="btn" disabled={tx.state === 'signing' || round?.revealed} onClick={reveal}>
              Reveal vote
            </button>
            <button
              className="btn ghost"
              disabled={tx.state === 'signing' || round?.revealed || round?.reportedUnavailable}
              onClick={() => run('Report the record unreachable', 'reportUnavailable', [dispute.id])}
            >
              I cannot retrieve the evidence
            </button>
            <button
              className="btn ghost"
              disabled={tx.state === 'signing' || windowOpen}
              onClick={() => run('Finalize', 'finalize', [dispute.id])}
            >
              Finalize
            </button>
          </>
        )}

        {dispute.state === DisputeState.Resolved && !dispute.ruled && (
          <button
            className="btn ghost"
            disabled={tx.state === 'signing'}
            onClick={() => run('Redeliver ruling', 'redeliverRuling', [dispute.id])}
          >
            Redeliver ruling
          </button>
        )}
      </div>

      {dispute.state === DisputeState.Committing && saved && (
        <div className="hints">
          <span className="muted">
            a salt for this dispute is already stored in this browser (choice {saved.choice}) — committing again
            overwrites it
          </span>
        </div>
      )}

      {dispute.state === DisputeState.Revealing && round?.committed && !round.revealed && !saved && (
        <div className="banner warn">
          You committed but this browser has no stored salt for this dispute. Without it the reveal cannot be
          reconstructed and the seat is slashed at γ. Import a backup if you have one.
        </div>
      )}

      {dispute.state === DisputeState.Revealing && mySeats > 0 && !round?.revealed && (
        <p className="hint">
          Reporting the record unreachable answers for your seat instead of voting. If most of the
          jurors who turn up say the same, the case voids and nobody is slashed. If you are the only
          one, you are treated as silent and slashed at {cfg.gammaBps / 100}% — so say it only when
          it is true.
        </p>
      )}

      {tx.state !== 'idle' && <div className={`txline ${tx.state}`}>{tx.msg}</div>}
    </div>
  );
}
