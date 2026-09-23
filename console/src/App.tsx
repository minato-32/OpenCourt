// Console shell: chain header, wallet bar, court picker, dispute explorer.

import { useEffect, useState } from 'react';
import { watchBlocks, freeBalance } from './lib/chain';
import { CHAIN, COURTS, type CourtDeployment } from './lib/contracts';
import type { WalletAccount } from './lib/wallet';
import { WalletBar } from './views/WalletBar';
import { CourtCard } from './views/CourtCard';
import { DisputeExplorer } from './views/DisputeExplorer';
import { JurorPanel } from './views/JurorPanel';
import { EscrowPanel } from './views/EscrowPanel';

export default function App() {
  const [head, setHead] = useState<number>(0);
  const [court, setCourt] = useState<CourtDeployment>(COURTS[0]);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);

  useEffect(() => watchBlocks(setHead), []);

  useEffect(() => {
    if (!account) return setBalance(null);
    let live = true;
    freeBalance(account.ss58)
      .then((b) => live && setBalance(b))
      .catch(() => live && setBalance(null));
    return () => {
      live = false;
    };
  }, [account, head]);

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          <div>
            <h1>GetCourt</h1>
            <p className="sub">
              {CHAIN.name} · block {head || '…'} · {CHAIN.blockTimeSeconds}s blocks
            </p>
          </div>
        </div>
        <WalletBar account={account} balance={balance} onPick={setAccount} />
      </header>

      <nav className="courts">
        {COURTS.map((c) => (
          <button
            key={c.core}
            className={`court-tab ${c.core === court.core ? 'active' : ''}`}
            onClick={() => setCourt(c)}
          >
            {c.label}
          </button>
        ))}
      </nav>

      <main>
        <CourtCard court={court} />
        <EscrowPanel court={court} head={head} account={account} />
        <JurorPanel court={court} head={head} account={account} />
        <DisputeExplorer court={court} head={head} account={account} />
      </main>

      <footer>
        Reads come straight from chain via <code>ReviveApi.call</code>. No backend, no indexer.
      </footer>
    </div>
  );
}
