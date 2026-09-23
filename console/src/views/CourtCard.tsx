// Court config read straight from the deployed ArbitratorCore, plus its implied q*.

import { useEffect, useState } from 'react';
import {
  arbitrationCost,
  courtConfig,
  drawTarget,
  qStar,
  type CourtConfig,
  type CourtDeployment,
} from '../lib/contracts';
import { bps, pas, short } from '../lib/format';

export function CourtCard({ court }: { court: CourtDeployment }) {
  const [cfg, setCfg] = useState<CourtConfig | null>(null);
  const [cost, setCost] = useState<bigint | null>(null);
  const [target, setTarget] = useState<bigint | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setCfg(null);
    setErr(null);
    Promise.all([courtConfig(court.core), arbitrationCost(court.core), drawTarget(court.core)])
      .then(([c, a, t]) => {
        if (!live) return;
        setCfg(c);
        setCost(a);
        setTarget(t);
      })
      .catch((e) => live && setErr(e?.message ?? String(e)));
    return () => {
      live = false;
    };
  }, [court.core]);

  if (err) return <section className="card err-card">Court read failed: {err}</section>;
  if (!cfg) return <section className="card">Loading court…</section>;

  const q = qStar(cfg);

  return (
    <section className="card">
      <div className="card-head">
        <h2>{court.label}</h2>
        <code className="mono">{court.core}</code>
      </div>

      <div className="grid">
        <Fact k="minStake" v={pas(cfg.minStake)} />
        <Fact k="jurorFee" v={pas(cfg.jurorFee)} />
        <Fact k="arbitrationCost" v={cost ? pas(cost) : '…'} />
        <Fact k="panel / draw target" v={`${cfg.panelSize} / ${target ?? '…'}`} />
        <Fact k="β incoherence" v={bps(cfg.betaBps)} />
        <Fact k="γ non-reveal" v={bps(cfg.gammaBps)} />
        <Fact k="θ treasury cut" v={bps(cfg.thetaBps)} />
        <Fact k="quorum" v={bps(cfg.quorumBps)} />
        <Fact k="app / protocol take" v={`${bps(cfg.appFeeBps)} / ${bps(cfg.protocolFeeBps)}`} />
        <Fact k="draw / commit / reveal" v={`${cfg.drawWindowBlocks} / ${cfg.commitBlocks} / ${cfg.revealBlocks} blocks`} />
        <Fact k="activation delay" v={`${cfg.activationDelayBlocks} blocks`} />
        <Fact k="treasury" v={short(cfg.treasury)} mono />
      </div>

      <div className={`qstar ${q <= 0.6 ? 'ok' : 'bad'}`}>
        q* = {q.toFixed(4)} — {q <= 0.6 ? 'passes the FR-CR-02 guard (≤ 0.60)' : 'would be rejected as underpaid'}
        <span className="muted"> · a juror better than this confidence profits in expectation</span>
      </div>
    </section>
  );
}

function Fact({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="fact">
      <span className="k">{k}</span>
      <span className={`v ${mono ? 'mono' : ''}`}>{v}</span>
    </div>
  );
}
