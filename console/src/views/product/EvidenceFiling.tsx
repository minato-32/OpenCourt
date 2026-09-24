// Filing evidence as a person does it: pick the file, get its hash, paste where it lives.

import { useState } from 'react';
import { simulate, write } from '../../lib/chain';
import { coreAbi, type CourtConfig, type CourtDeployment } from '../../lib/contracts';
import { pas } from '../../lib/format';
import type { WalletAccount } from '../../lib/wallet';

type Picked = { name: string; sizeBytes: number; sha256: string };

/** sha256 of the exact bytes, computed here — the chain only ever sees the digest. */
async function digest(file: File): Promise<Picked> {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { name: file.name, sizeBytes: buf.byteLength, sha256: `0x${hex}` };
}

export function EvidenceFiling({
  court,
  cfg,
  disputeId,
  account,
  isParty,
  onDone,
}: {
  court: CourtDeployment;
  cfg: CourtConfig;
  disputeId: bigint;
  account: WalletAccount | null;
  isParty: boolean;
  onDone: () => void;
}) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [uri, setUri] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  if (!account) return <p className="muted">Connect a wallet to file evidence.</p>;

  // A party to the case files free. Anyone else posts a refundable bond, so bulk filing by
  // strangers costs locked capital rather than nothing.
  const bond = isParty ? 0n : cfg.evidenceBond;

  async function file() {
    if (!account || !picked || !uri) return setMsg('Pick a file and give the address it is stored at.');
    setBusy(true);
    setMsg('');
    const params = [disputeId, uri, picked.sha256, picked.sizeBytes];
    try {
      const would = await simulate(account.ss58, court.core, coreAbi, 'submitEvidence', params, bond);
      if (would) {
        setMsg(`Would revert: ${would.reason} — nothing signed.`);
        return;
      }
      await write(account.account.polkadotSigner, court.core, coreAbi, 'submitEvidence', params, bond);
      setMsg('Filed. It is part of the record every juror will read.');
      setPicked(null);
      setUri('');
      onDone();
    } catch (e: any) {
      setMsg(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="file-evidence">
      <div className="row">
        <label className="field">
          <span>document</span>
          <input
            className="input"
            type="file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) digest(f).then(setPicked).catch(() => setMsg('Could not read that file.'));
            }}
          />
        </label>
        <label className="field grow">
          <span>where it is stored (IPFS CID or URL)</span>
          <input
            className="input"
            placeholder="ipfs://bafy…"
            value={uri}
            onChange={(e) => setUri(e.target.value)}
          />
        </label>
      </div>

      {picked && (
        <p className="hint mono">
          {picked.name} · {(picked.sizeBytes / 1024).toFixed(0)} KB · sha256 {picked.sha256.slice(0, 18)}…
        </p>
      )}

      <div className="row">
        <button className="btn" disabled={busy || !picked || !uri} onClick={file}>
          {bond > 0n ? `File evidence · ${pas(bond)} bond` : 'File evidence'}
        </button>
        <span className="muted">
          {bond > 0n
            ? 'You are not a party to this case, so a bond is held until it ends — then you claim it back in full.'
            : 'You are a party to this case, so filing is free.'}
        </span>
      </div>

      <p className="hint">
        Upload the file wherever you like; only its address and hash go on chain. The hash is what
        lets a juror prove the file they opened is the file you filed.
      </p>

      {msg && <div className="txline">{msg}</div>}
    </div>
  );
}
