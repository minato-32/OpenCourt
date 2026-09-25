// Two surfaces over the same chain state: the product a person uses, and the console an operator
// uses. The indexer runs once for both and only ever caches.

import { useEffect, useMemo, useState } from 'react';
import { watchBlocks, freeBalance } from './lib/chain';
import {
  CHAIN,
  COURTS,
  coreAbi,
  courtConfig,
  disputeCount,
  type CourtConfig,
  type CourtDeployment,
} from './lib/contracts';
import { DisputeState, getDispute, type Dispute } from './lib/dispute';
import { startIndexer } from './lib/indexer';
import type { WalletAccount } from './lib/wallet';
import { WalletBar } from './views/WalletBar';
import { CourtCard } from './views/CourtCard';
import { DisputeExplorer } from './views/DisputeExplorer';
import { JurorPanel } from './views/JurorPanel';
import { EscrowPanel } from './views/EscrowPanel';
import { CaseView } from './views/product/CaseView';

type Surface = 'cases' | 'console';

export default function App() {
  const [head, setHead] = useState<number>(0);
  const [court, setCourt] = useState<CourtDeployment>(COURTS[0]);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [surface, setSurface] = useState<Surface>('cases');

  const [cfg, setCfg] = useState<CourtConfig | null>(null);
  const [cases, setCases] = useState<Dispute[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [indexed, setIndexed] = useState(0);
  const [scan, setScan] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => watchBlocks(setHead), []);

  // One indexer across every known court. It follows finalized blocks and backfills recent history.
  const allCores = useMemo(() => COURTS.map((c) => c.core), []);
  useEffect(() => {
    const idx = startIndexer(
      allCores,
      coreAbi,
      (found) => setIndexed((n) => n + found.length),
      (done, total) => setScan(done >= total ? null : { done, total }),
    );
    idx.backfill(400).catch(() => undefined);
    return () => idx.stop();
  }, [allCores]);

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

  useEffect(() => {
    let live = true;
    setCases([]);
    setCfg(null);
    (async () => {
      const config = await courtConfig(court.core);
      if (!live) return;
      setCfg(config);
      const n = await disputeCount(court.core);
      const out: Dispute[] = [];
      for (let id = n; id >= 1n; id--) {
        const d = await getDispute(court.core, id);
        if (!live) return;
        out.push(d);
        setCases([...out]);
      }
      if (live && out.length) setSelected((s) => (s && out.some((d) => d.id.toString() === s) ? s : out[0].id.toString()));
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [court.core, nonce]);

  const current = cases.find((d) => d.id.toString() === selected) ?? null;

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          <div>
            <h1>OpenCourt</h1>
            <p className="sub">
              {CHAIN.name} · block {head || '…'} ·{' '}
              {scan ? `indexing ${scan.done}/${scan.total} blocks` : `${indexed} events indexed locally`}
            </p>
          </div>
        </div>
        <WalletBar account={account} balance={balance} onPick={setAccount} />
      </header>

      <div className="surface-tabs">
        <button className={`surface-tab ${surface === 'cases' ? 'active' : ''}`} onClick={() => setSurface('cases')}>
          Cases
        </button>
        <button className={`surface-tab ${surface === 'console' ? 'active' : ''}`} onClick={() => setSurface('console')}>
          Operator console
        </button>
      </div>

      <nav className="courts">
        {COURTS.map((c) => (
          <button
            key={c.core}
            className={`court-tab ${c.core === court.core ? 'active' : ''}`}
            onClick={() => {
              setCourt(c);
              setSelected(null);
            }}
          >
            {c.label}
          </button>
        ))}
      </nav>

      <main>
        {surface === 'cases' ? (
          <>
            {cases.length > 1 && (
              <div className="case-list">
                {cases.map((d) => (
                  <button
                    key={d.id.toString()}
                    className={`case-pick ${d.id.toString() === selected ? 'active' : ''}`}
                    onClick={() => setSelected(d.id.toString())}
                  >
                    <span className="mono">#{d.id.toString()}</span>
                    <span>
                      {d.state === DisputeState.Resolved
                        ? d.ruling === 0
                          ? 'no decision'
                          : `ruling ${d.ruling}`
                        : 'in progress'}
                    </span>
                    <span className="muted">{d.seatCount} seats</span>
                  </button>
                ))}
              </div>
            )}
            {current && cfg ? (
              <CaseView
                court={court}
                dispute={current}
                cfg={cfg}
                head={head}
                account={account}
                onRefresh={() => setNonce((n) => n + 1)}
              />
            ) : (
              <section className="card">No cases on this court yet.</section>
            )}
          </>
        ) : (
          <>
            <CourtCard court={court} />
            <EscrowPanel court={court} head={head} account={account} />
            <JurorPanel court={court} head={head} account={account} />
            <DisputeExplorer court={court} head={head} account={account} />
          </>
        )}
      </main>

      <footer>
        Reads come straight from chain via <code>ReviveApi.call</code>. The local index is a cache, never a dependency.
      </footer>
    </div>
  );
}
