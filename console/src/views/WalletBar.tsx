// Extension connect + the account's mapped H160 (what the contract sees as msg.sender).

import { useEffect, useState } from 'react';
import { connect, listExtensions, type WalletAccount } from '../lib/wallet';
import { pasPlanck, short } from '../lib/format';

export function WalletBar({
  account,
  balance,
  onPick,
}: {
  account: WalletAccount | null;
  balance: bigint | null;
  onPick: (a: WalletAccount | null) => void;
}) {
  const [exts, setExts] = useState<string[]>([]);
  const [accounts, setAccounts] = useState<WalletAccount[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => setExts(listExtensions()), []);

  async function pickExtension(name: string) {
    setErr(null);
    try {
      const list = await connect(name);
      setAccounts(list);
      if (list.length) onPick(list[0]);
      if (!list.length) setErr('Extension has no accounts for this chain.');
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }

  if (!exts.length) {
    return (
      <div className="wallet">
        <span className="muted">No wallet extension detected</span>
        <span className="hint">Install Talisman or polkadot-js — reads work without it</span>
      </div>
    );
  }

  return (
    <div className="wallet">
      {!accounts.length ? (
        <div className="row">
          {exts.map((e) => (
            <button key={e} className="btn" onClick={() => pickExtension(e)}>
              Connect {e}
            </button>
          ))}
        </div>
      ) : (
        <div className="row">
          <select
            className="select"
            value={account?.ss58 ?? ''}
            onChange={(ev) => onPick(accounts.find((a) => a.ss58 === ev.target.value) ?? null)}
          >
            {accounts.map((a) => (
              <option key={a.ss58} value={a.ss58}>
                {a.name} — {short(a.ss58)}
              </option>
            ))}
          </select>
          {account && (
            <div className="acct">
              <span className="mono">{short(account.h160)}</span>
              <span className="muted">mapped H160</span>
            </div>
          )}
          {balance !== null && <span className="bal">{pasPlanck(balance, 2)}</span>}
        </div>
      )}
      {err && <span className="err">{err}</span>}
    </div>
  );
}
