// Reveal-salt persistence. A lost salt is a gamma slash, so salts are stored per
// (court, dispute, juror), encrypted with a passphrase, and always exportable.

const DB = 'opencourt-salts';
/** What this store was called before the project was renamed. Read once, then carried forward. */
const LEGACY_DB = 'getcourt-salts';
const enc = new TextEncoder();
const dec = new TextDecoder();

export interface SaltRecord {
  core: string;
  disputeId: string;
  juror: string;
  choice: number;
  /** base64 of iv + ciphertext. */
  blob: string;
  savedAt: number;
}

const key = (core: string, disputeId: bigint | string, juror: string) =>
  `${core.toLowerCase()}:${disputeId}:${juror.toLowerCase()}`;

const load = (): Record<string, SaltRecord> => {
  try {
    const raw = localStorage.getItem(DB);
    if (raw) return JSON.parse(raw);
    // Renaming the store without this would orphan every salt already in a juror's browser, and
    // a salt that cannot be found is a gamma slash on a vote they actually cast. Adopt the old
    // store once, keep the old copy: nothing here is worth deleting to save a few bytes.
    const legacy = localStorage.getItem(LEGACY_DB);
    if (!legacy) return {};
    localStorage.setItem(DB, legacy);
    return JSON.parse(legacy);
  } catch {
    return {};
  }
};

const save = (all: Record<string, SaltRecord>) => localStorage.setItem(DB, JSON.stringify(all));

async function aesKey(passphrase: string, salt: BufferSource): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase) as BufferSource, 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 250_000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Fresh 32-byte salt as 0x-hex. */
export function generateSalt(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function put(
  core: string,
  disputeId: bigint,
  juror: string,
  choice: number,
  saltHex: string,
  passphrase: string,
): Promise<void> {
  const kdfSalt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      await aesKey(passphrase, kdfSalt as BufferSource),
      enc.encode(saltHex) as BufferSource,
    ),
  );
  const packed = new Uint8Array(kdfSalt.length + iv.length + ct.length);
  packed.set(kdfSalt, 0);
  packed.set(iv, kdfSalt.length);
  packed.set(ct, kdfSalt.length + iv.length);

  const all = load();
  all[key(core, disputeId, juror)] = {
    core,
    disputeId: disputeId.toString(),
    juror,
    choice,
    blob: b64(packed),
    savedAt: Date.now(),
  };
  save(all);
}

export function peek(core: string, disputeId: bigint, juror: string): SaltRecord | undefined {
  return load()[key(core, disputeId, juror)];
}

export async function get(
  core: string,
  disputeId: bigint,
  juror: string,
  passphrase: string,
): Promise<{ salt: string; choice: number } | undefined> {
  const rec = peek(core, disputeId, juror);
  if (!rec) return undefined;
  const packed = unb64(rec.blob);
  const kdfSalt = packed.slice(0, 16);
  const iv = packed.slice(16, 28);
  const ct = packed.slice(28);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    await aesKey(passphrase, kdfSalt as BufferSource),
    ct as BufferSource,
  );
  return { salt: dec.decode(pt), choice: rec.choice };
}

export const all = (): SaltRecord[] => Object.values(load());

/** Download every stored salt record; the ciphertext is useless without the passphrase. */
export function exportBackup(): void {
  const blob = new Blob([JSON.stringify(all(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'opencourt-salts-backup.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

export function importBackup(records: SaltRecord[]): number {
  const store = load();
  let n = 0;
  for (const r of records) {
    store[key(r.core, r.disputeId, r.juror)] = r;
    n++;
  }
  save(store);
  return n;
}
