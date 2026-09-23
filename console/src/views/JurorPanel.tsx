// Juror onboarding: eligibility, stake, activation countdown, weight, withdraw.

import { useCallback, useEffect, useState } from 'react';
import { PAS_EVM, freeBalance, simulate, write } from '../lib/chain';
import {
  CHAIN,
  activeAtOf,
  coreAbi,
  courtConfig,
  isEligible,
  stakedOf,
  weightOf,
  withdrawableOf,
  type CourtConfig,
  type CourtDeployment,
} from '../lib/contracts';
import { blocksLeft, pas, pasPlanck, short } from '../lib/format';
import type { WalletAccount } from '../lib/wallet';

type Tx = { state: 'idle' | 'signing' | 'done' | 'error'; msg?: string };

interface JurorState {
  staked: bigint;
  weight: bigint;
  activeAt: bigint;
  withdrawable: bigint;
  eligible: boolean;
  balance: bigint;
}

export function JurorPanel({
  court,
  head,
  account,
}: {
  court: CourtDeployment;
  head: number;
  account: WalletAccount | null;
}) {
  const [cfg, setCfg] = useState<CourtConfig | null>(null);
  const [st, setSt] = useState<JurorState | null>(null);
  const [amount, setAmount] = useState('');
  const [tx, setTx] = useState<Tx>({ state: 'idle' });
  const [blocked, setBlocked] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!account) return setSt(null);
    const [config, staked, weight, activeAt, withdrawable, balance] = await Promise.all([
      courtConfig(court.core),
      stakedOf(court.core, account.h160),
      weightOf(court.core, account.h160),
      activeAtOf(court.core, account.h160),
      withdrawableOf(court.core, account.h160),
      freeBalance(account.ss58),
    ]);
    const eligible = await isEligible(court.eligibility, account.h160).catch(() => false);
    setCfg(config);
    setSt({ staked, weight, activeAt, withdrawable, eligible, balance });
    if (!amount) setAmount((Number(config.minStake / 10n ** 16n) / 100).toString());
  }, [court.core, court.eligibility, account, amount]);

  useEffect(() => {
    refresh().catch(() => setSt(null));
  }, [court.core, account, head]);

  if (!account) {
    return (
      <section className="card">
        <div className="card-head">
          <h2>Juror</h2>
        </div>
        <p className="muted">Connect a wallet to stake into this court.</p>
      </section>
    );
  }

  if (!cfg || !st) return <section className="card">Loading juror state…</section>;

  const amountEvm = (() => {
    const n = Number(amount);
    return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e6)) * (PAS_EVM / 1_000_000n) : 0n;
  })();

  const active = st.activeAt !== 0n && BigInt(head) >= st.activeAt;
  const pendingActivation = st.activeAt !== 0n && BigInt(head) < st.activeAt;

  async function run(label: string, fn: string, params: unknown[], valueEvm = 0n) {
    if (!account) return;
    setTx({ state: 'signing', msg: `${label}…` });
    setBlocked(null);
    // Dry-run first so a revert shows as a reason instead of a failed signature.
    const would = await simulate(account.ss58, court.core, coreAbi, fn, params, valueEvm);
    if (would) {
      setBlocked(would.reason);
      setTx({ state: 'error', msg: `${label} would revert: ${would.reason}` });
      return;
    }
    try {
      const r = await write(account.account.polkadotSigner, court.core, coreAbi, fn, params, valueEvm);
      setTx({ state: 'done', msg: `${label} included in ${short(r.blockHash, 10)}` });
      await refresh();
    } catch (e: any) {
      setTx({ state: 'error', msg: e?.message ?? String(e) });
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Juror</h2>
        <code className="mono">{short(account.h160, 10)}</code>
      </div>

      <div className="grid">
        <Fact k="free stake" v={pas(st.staked)} />
        <Fact k="weight (slots)" v={String(st.weight)} />
        <Fact k="withdrawable" v={pas(st.withdrawable)} />
        <Fact k="wallet balance" v={pasPlanck(st.balance, 2)} />
        <Fact k="eligibility policy" v={st.eligible ? 'eligible' : 'NOT eligible'} />
        <Fact
          k="activation"
          v={
            st.activeAt === 0n
              ? 'not staked'
              : active
                ? `active since block ${st.activeAt}`
                : `active in ${blocksLeft(st.activeAt, head, CHAIN.blockTimeSeconds)}`
          }
        />
      </div>

      {pendingActivation && (
        <div className="banner warn">
          Stake is locked out of draws until block {String(st.activeAt)}. Every `stake()` re-arms this
          delay on the whole balance — that is the anti-panel-capture guard, not a bug.
        </div>
      )}

      <div className="actions">
        <label className="field">
          <span>amount (PAS)</span>
          <input
            className="input"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
          />
        </label>
        <button
          className="btn"
          disabled={tx.state === 'signing' || amountEvm === 0n}
          onClick={() => run('Stake', 'stake', [], amountEvm)}
        >
          Stake
        </button>
        <button
          className="btn ghost"
          disabled={tx.state === 'signing' || st.staked === 0n}
          onClick={() => run('Unstake', 'unstake', [amountEvm])}
        >
          Unstake
        </button>
        <button
          className="btn ghost"
          disabled={tx.state === 'signing' || st.withdrawable === 0n}
          onClick={() => run('Withdraw', 'withdraw', [])}
        >
          Withdraw {st.withdrawable > 0n ? pas(st.withdrawable, 2) : ''}
        </button>
      </div>

      <div className="hints">
        <span className="muted">
          one slot = {pas(cfg.minStake)} · staking {amount || '0'} PAS gives weight{' '}
          {amountEvm > 0n ? String(amountEvm / cfg.minStake) : '0'}
        </span>
      </div>

      {tx.state !== 'idle' && (
        <div className={`txline ${tx.state}`}>
          {tx.msg}
          {blocked && <span className="muted"> — nothing was signed</span>}
        </div>
      )}
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
