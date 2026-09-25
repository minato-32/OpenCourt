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

/** An open-ballot court has no commitment, so the contract ignores the salt entirely. */
const ZERO_SALT = `0x${'0'.repeat(64)}`;

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
  const [relayFor, setRelayFor] = useState('');
  const [relayChoice, setRelayChoice] = useState(1);
  const [relaySalt, setRelaySalt] = useState('');

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
    // A commitment on chain is bound to ONE salt for the life of the round. Overwriting a stored
    // salt makes that commitment unrevealable, which is a guaranteed gamma slash — and the window
    // for it is wide: a lagging refresh re-enables this button, a second click replaces the salt,
    // the transaction is then refused as AlreadyCommitted, and the damage is already done.
    if (round?.committed) {
      return setTx({
        state: 'error',
        msg: 'You have already committed on this dispute. Committing again would replace the stored salt and make your on-chain vote unrevealable.',
      });
    }
    const salt = keystore.generateSalt();
    const params = [dispute.id, commitmentOf(dispute.id, account.h160, choice, salt)];

    // Simulate FIRST, store only once it is going to be signed. Storing up front meant a commit
    // that never left the browser had already overwritten the salt of one that did.
    setTx({ state: 'signing', msg: `Commit choice ${choice}…` });
    const would = await simulate(account.ss58, court.core, coreAbi, 'commitVote', params);
    if (would) {
      return setTx({ state: 'error', msg: `Commit would revert: ${would.reason} — nothing signed, nothing stored` });
    }
    // Persist BEFORE signing: a commit whose salt was never stored is a guaranteed gamma slash.
    await keystore.put(court.core, dispute.id, account.h160, choice, salt, pass);
    try {
      const r = await write(account.account.polkadotSigner, court.core, coreAbi, 'commitVote', params);
      setTx({ state: 'done', msg: `Commit choice ${choice} included in ${short(r.blockHash, 10)}` });
      onDone();
    } catch (e: any) {
      setTx({ state: 'error', msg: e?.message ?? String(e) });
    }
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
  // What the contract actually checks on a vote. An over-drawn alternate holds a seat but no
  // duty, and in an open-ballot court is never promoted — showing it a vote button would only
  // ever produce a NotSeated revert.
  const myDuty = round?.dutySeats ?? 0;

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
            {/* An undersubscribed draw cannot be closed — closeDrawing reverts PanelFull — and
                finalize is its only exit. Without this the console could not settle a dispute
                nobody turned up for, and the app's prepaid fee stayed locked. */}
            <button
              className="btn ghost"
              disabled={tx.state === 'signing' || windowOpen}
              onClick={() => run('Refund an empty draw', 'finalize', [dispute.id])}
            >
              Refund an empty draw
            </button>
          </>
        )}

        {dispute.state === DisputeState.Committing && !cfg.commitRequired && (
          <>
            <span className="muted">
              This court votes in the open — there is nothing to commit to. Wait for the reveal
              window, then cast your vote there.
            </span>
            <button
              className="btn ghost"
              disabled={tx.state === 'signing' || windowOpen}
              onClick={() => run('Open reveal', 'openReveal', [dispute.id])}
            >
              Open voting
            </button>
          </>
        )}

        {dispute.state === DisputeState.Revealing && !cfg.commitRequired && myDuty > 0 && (
          <>
            <label className="field">
              <span>your vote</span>
              <select className="select" value={choice} onChange={(e) => setChoice(Number(e.target.value))}>
                {Array.from({ length: dispute.choices }, (_, i) => i + 1).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="btn"
              disabled={tx.state === 'signing' || round?.revealed || round?.reportedUnavailable}
              onClick={() => run(`Vote ${choice}`, 'revealVote', [dispute.id, choice, ZERO_SALT])}
            >
              Cast vote
            </button>
            <span className="muted">
              Open ballot: your vote is visible the moment it lands, and everyone still voting can
              see it.
            </span>
          </>
        )}

        {dispute.state === DisputeState.Revealing && !cfg.commitRequired && (
          <>
            <button
              className="btn ghost"
              disabled={tx.state === 'signing' || myDuty === 0 || round?.revealed || round?.reportedUnavailable}
              onClick={() => run('Report the record unreachable', 'reportUnavailable', [dispute.id])}
            >
              I cannot retrieve the evidence
            </button>
            {/* Ungated by seats on purpose: settling is a permissionless crank, and without it an
                open-ballot court had no way to close a dispute from here at all. */}
            <button
              className="btn ghost"
              disabled={tx.state === 'signing' || windowOpen}
              onClick={() => run('Finalize', 'finalize', [dispute.id])}
            >
              Finalize
            </button>
          </>
        )}

        {dispute.state === DisputeState.Committing && cfg.commitRequired && (
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

        {dispute.state === DisputeState.Revealing && cfg.commitRequired && (
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
              disabled={tx.state === 'signing' || myDuty === 0 || round?.revealed || round?.reportedUnavailable}
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

        {dispute.state === DisputeState.Revealing && cfg.commitRequired && (
          <details className="relay">
            <summary>Reveal for another juror</summary>
            <p className="hint">
              A juror who still has their choice and salt but cannot reach their wallet can hand
              them to anyone to submit. The commitment is bound to the juror's own address, so the
              pair either matches what they committed or the call reverts — you cannot vote for
              them. They do give up secrecy for the rest of the reveal window.
            </p>
            <div className="row">
              <label className="field grow">
                <span>juror address</span>
                <input className="input" placeholder="0x…" value={relayFor}
                  onChange={(e) => setRelayFor(e.target.value.trim())} />
              </label>
              <label className="field">
                <span>choice</span>
                <select className="select" value={relayChoice}
                  onChange={(e) => setRelayChoice(Number(e.target.value))}>
                  {Array.from({ length: dispute.choices }, (_, i) => i + 1).map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label className="field grow">
                <span>salt</span>
                <input className="input" placeholder="0x…" value={relaySalt}
                  onChange={(e) => setRelaySalt(e.target.value.trim())} />
              </label>
              <button
                className="btn ghost"
                disabled={tx.state === 'signing' || !/^0x[0-9a-fA-F]{40}$/.test(relayFor) || !/^0x[0-9a-fA-F]{64}$/.test(relaySalt)}
                onClick={() => run('Relay reveal', 'revealVoteFor', [dispute.id, relayFor, relayChoice, relaySalt])}
              >
                Submit on their behalf
              </button>
            </div>
          </details>
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

      {dispute.state === DisputeState.Committing && cfg.commitRequired && saved && (
        <div className="hints">
          <span className="muted">
            a salt for this dispute is already stored in this browser (choice {saved.choice}) — committing again
            overwrites it
          </span>
        </div>
      )}

      {dispute.state === DisputeState.Revealing && cfg.commitRequired && round?.committed && !round.revealed && !saved && (
        <div className="banner warn">
          You committed but this browser has no stored salt for this dispute. Without it the reveal cannot be
          reconstructed and the seat is slashed at γ. Import a backup if you have one.
        </div>
      )}

      {dispute.state === DisputeState.Revealing && myDuty > 0 && !round?.revealed && (
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
