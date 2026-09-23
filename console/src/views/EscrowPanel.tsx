// Disputant flow: fund an escrow, release it, or escalate it to the jury.

import { useCallback, useEffect, useState } from 'react';
import { PAS_EVM, read, simulate, write } from '../lib/chain';
import { arbitrationCost, escrowAbi, type CourtDeployment } from '../lib/contracts';
import { pas, short } from '../lib/format';
import type { WalletAccount } from '../lib/wallet';

const STATE = ['none', 'funded', 'disputed', 'resolved'] as const;

interface Escrow {
  id: bigint;
  payer: string;
  payee: string;
  amount: bigint;
  state: number;
  disputeId?: bigint;
}

type Tx = { state: 'idle' | 'signing' | 'done' | 'error'; msg?: string };

export function EscrowPanel({
  court,
  head,
  account,
}: {
  court: CourtDeployment;
  head: number;
  account: WalletAccount | null;
}) {
  const [escrows, setEscrows] = useState<Escrow[]>([]);
  const [cost, setCost] = useState<bigint>(0n);
  const [pending, setPending] = useState<bigint>(0n);
  const [payee, setPayee] = useState('');
  const [amount, setAmount] = useState('20');
  const [tx, setTx] = useState<Tx>({ state: 'idle' });

  const refresh = useCallback(async () => {
    const c = await arbitrationCost(court.core);
    setCost(c);
    const n = (await read(court.escrow, escrowAbi, 'escrowCount'))[0] as bigint;
    const list: Escrow[] = [];
    for (let id = n; id >= 1n && id > n - 10n; id--) {
      const e = await read(court.escrow, escrowAbi, 'escrows', [id]);
      list.push({
        id,
        payer: e[0] as string,
        payee: e[1] as string,
        amount: e[2] as bigint,
        state: Number(e[3]),
      });
    }
    setEscrows(list);
    if (account) {
      setPending((await read(court.escrow, escrowAbi, 'pendingWithdrawals', [account.h160]))[0] as bigint);
    }
  }, [court.core, court.escrow, account]);

  useEffect(() => {
    refresh().catch(() => setEscrows([]));
  }, [court.escrow, account, head]);

  const amountEvm = (() => {
    const n = Number(amount);
    return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e6)) * (PAS_EVM / 1_000_000n) : 0n;
  })();

  async function run(label: string, fn: string, params: unknown[], valueEvm = 0n) {
    if (!account) return;
    setTx({ state: 'signing', msg: `${label}…` });
    const would = await simulate(account.ss58, court.escrow, escrowAbi, fn, params, valueEvm);
    if (would) return setTx({ state: 'error', msg: `${label} would revert: ${would.reason} — nothing signed` });
    try {
      const r = await write(account.account.polkadotSigner, court.escrow, escrowAbi, fn, params, valueEvm);
      setTx({ state: 'done', msg: `${label} included in ${short(r.blockHash, 10)}` });
      await refresh();
    } catch (e: any) {
      setTx({ state: 'error', msg: e?.message ?? String(e) });
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Escrow (the app raising disputes)</h2>
        <code className="mono">{court.escrow}</code>
      </div>

      {!account ? (
        <p className="muted">Connect a wallet to fund an escrow or raise a dispute.</p>
      ) : (
        <>
          <div className="actions">
            <label className="field">
              <span>payee address (H160)</span>
              <input
                className="input wide"
                placeholder="0x…"
                value={payee}
                onChange={(e) => setPayee(e.target.value.trim())}
              />
            </label>
            <label className="field">
              <span>amount (PAS)</span>
              <input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
            </label>
            <button
              className="btn"
              disabled={tx.state === 'signing' || amountEvm === 0n || !/^0x[0-9a-fA-F]{40}$/.test(payee)}
              onClick={() => run('Fund escrow', 'fund', [payee], amountEvm)}
            >
              Fund escrow
            </button>
            <button
              className="btn ghost"
              disabled={tx.state === 'signing' || pending === 0n}
              onClick={() => run('Withdraw', 'withdraw', [])}
            >
              Withdraw {pending > 0n ? pas(pending, 2) : ''}
            </button>
          </div>
          <div className="hints">
            <span className="muted">
              raising a dispute prepays {pas(cost)} — the court's grossed-up arbitration cost
            </span>
          </div>
        </>
      )}

      {escrows.length > 0 && (
        <table className="seats">
          <thead>
            <tr>
              <th>id</th>
              <th>payer</th>
              <th>payee</th>
              <th>amount</th>
              <th>state</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {escrows.map((e) => {
              const mine = account && e.payer.toLowerCase() === account.h160.toLowerCase();
              const party =
                account &&
                (e.payer.toLowerCase() === account.h160.toLowerCase() ||
                  e.payee.toLowerCase() === account.h160.toLowerCase());
              return (
                <tr key={String(e.id)} className={mine ? 'mine' : ''}>
                  <td className="mono">#{String(e.id)}</td>
                  <td className="mono">{short(e.payer)}</td>
                  <td className="mono">{short(e.payee)}</td>
                  <td>{pas(e.amount)}</td>
                  <td>{STATE[e.state] ?? e.state}</td>
                  <td>
                    {e.state === 1 && party && (
                      <div className="row">
                        <button
                          className="btn small"
                          disabled={tx.state === 'signing'}
                          onClick={() => run(`Dispute #${e.id}`, 'dispute', [e.id], cost)}
                        >
                          Raise dispute
                        </button>
                        {mine && (
                          <button
                            className="btn ghost small"
                            disabled={tx.state === 'signing'}
                            onClick={() => run(`Release #${e.id}`, 'release', [e.id])}
                          >
                            Release
                          </button>
                        )}
                      </div>
                    )}
                    {e.state === 2 && (
                      <button
                        className="btn ghost small"
                        disabled={tx.state === 'signing'}
                        onClick={() => run(`Claim fees #${e.id}`, 'claimFees', [e.id])}
                      >
                        Claim fee refund
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {tx.state !== 'idle' && <div className={`txline ${tx.state}`}>{tx.msg}</div>}
    </section>
  );
}
