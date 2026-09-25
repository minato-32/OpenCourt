// Client-side event indexer. Follows finalized blocks, decodes our contracts' events and caches
// them in IndexedDB. No backend: the product must work with chain access alone, so this is a local
// read cache, never a dependency. Anything it holds can be re-derived by backfilling.

import { ethers } from 'ethers';
import { api, client } from './chain';

export interface IndexedEvent {
  id: string; // `${block}:${index}`
  contract: string; // lowercase H160
  block: number;
  name: string;
  disputeId: string | null;
  args: Record<string, string>;
}

const DB_NAME = 'opencourt-index';
const STORE = 'events';
const META = 'meta';
/** Blocks pulled per backfill pass; a pass is one RPC round trip per block. */
const BACKFILL_CHUNK = 120;
/** Blocks fetched concurrently while backfilling. */
const BACKFILL_CONCURRENCY = 12;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('byContract', 'contract');
        store.createIndex('byDispute', 'disputeKey');
      }
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'k' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

async function putEvents(rows: IndexedEvent[]): Promise<void> {
  if (!rows.length) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    const store = t.objectStore(STORE);
    for (const e of rows) {
      store.put({
        key: `${e.contract}:${e.id}`,
        disputeKey: e.disputeId === null ? `${e.contract}:none` : `${e.contract}:${e.disputeId}`,
        ...e,
      });
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

async function meta<T>(k: string): Promise<T | undefined> {
  const row = await tx<any>(META, 'readonly', (s) => s.get(k));
  return row?.v;
}

async function setMeta(k: string, v: unknown): Promise<void> {
  await tx(META, 'readwrite', (s) => s.put({ k, v }) as IDBRequest<any>);
}

/**
 * Block hash for a height. The modern archive RPC is tried first and the legacy one is the
 * fallback; both were verified to return the same hash on this chain.
 */
async function hashAtHeight(height: number): Promise<string | null> {
  try {
    const r = (await (client as any)._request('archive_v1_hashByHeight', [height])) as string[] | string;
    const hash = Array.isArray(r) ? r[0] : r;
    if (hash) return hash;
  } catch {
    // fall through to the legacy method
  }
  try {
    return ((await (client as any)._request('chain_getBlockHash', [height])) as string) ?? null;
  } catch {
    return null;
  }
}

/** Decode every event our contracts emitted in one finalized block. */
async function eventsInBlock(
  blockHash: string,
  blockNumber: number,
  watched: Set<string>,
  iface: ethers.Interface,
): Promise<IndexedEvent[]> {
  const raw = await api.query.System.Events.getValue({ at: blockHash as any });
  const out: IndexedEvent[] = [];

  raw.forEach((record: any, index: number) => {
    const ev = record.event;
    if (ev?.type !== 'Revive' || ev.value?.type !== 'ContractEmitted') return;
    const v = ev.value.value;
    const contract: string = (v.contract?.asHex?.() ?? v.contract ?? '').toLowerCase();
    if (!watched.has(contract)) return;

    try {
      const parsed = iface.parseLog({
        topics: (v.topics ?? []).map((t: any) => (t.asHex ? t.asHex() : t)),
        data: v.data?.asHex ? v.data.asHex() : v.data,
      });
      if (!parsed) return;

      const args: Record<string, string> = {};
      parsed.fragment.inputs.forEach((input, i) => {
        args[input.name || String(i)] = String(parsed.args[i]);
      });

      out.push({
        id: `${blockNumber}:${index}`,
        contract,
        block: blockNumber,
        name: parsed.name,
        disputeId: args.disputeId ?? null,
        args,
      });
    } catch {
      // An event from a contract we watch but whose ABI we do not have; skip it.
    }
  });

  return out;
}

export interface IndexerHandle {
  stop: () => void;
  /** Pull older blocks in one bounded pass. Returns how many events it found. */
  backfill: (blocks?: number) => Promise<number>;
  range: () => Promise<{ from: number; to: number } | null>;
}

type Listener = (events: IndexedEvent[]) => void;

/**
 * Start following finalized blocks for `contracts`. Returns immediately; the first events arrive
 * on the next finalized block. History needs `backfill`.
 */
export function startIndexer(
  contracts: string[],
  abi: ethers.InterfaceAbi,
  onEvents?: Listener,
  onProgress?: (done: number, total: number) => void,
): IndexerHandle {
  const watched = new Set(contracts.map((c) => c.toLowerCase()));
  const iface = new ethers.Interface(abi);
  const key = [...watched].sort().join(',');
  let stopped = false;

  const sub = client.finalizedBlock$.subscribe(async (b) => {
    if (stopped) return;
    try {
      const found = await eventsInBlock(b.hash, b.number, watched, iface);
      const range = ((await meta<{ from: number; to: number }>(`range:${key}`)) ?? {
        from: b.number,
        to: b.number,
      }) as { from: number; to: number };
      await setMeta(`range:${key}`, { from: Math.min(range.from, b.number), to: Math.max(range.to, b.number) });
      if (found.length) {
        await putEvents(found);
        onEvents?.(found);
      }
    } catch {
      // A dropped connection must not kill the watcher; the next block retries.
    }
  });

  return {
    stop: () => {
      stopped = true;
      sub.unsubscribe();
    },
    range: () => meta<{ from: number; to: number }>(`range:${key}`).then((r) => r ?? null),
    backfill: async (blocks = BACKFILL_CHUNK) => {
      const head = (await client.getFinalizedBlock()).number;
      const range = (await meta<{ from: number; to: number }>(`range:${key}`)) ?? { from: head, to: head };
      const target = Math.max(0, range.from - blocks);
      const heights: number[] = [];
      for (let n = range.from - 1; n >= target; n--) heights.push(n);

      let total = 0;
      // Walk in small concurrent batches: 400 sequential round trips is tens of seconds, and a
      // single failed block must skip rather than abandon the rest of the range.
      for (let i = 0; i < heights.length; i += BACKFILL_CONCURRENCY) {
        if (stopped) break;
        const batch = heights.slice(i, i + BACKFILL_CONCURRENCY);
        const results = await Promise.all(
          batch.map(async (n) => {
            try {
              const hash = await hashAtHeight(n);
              if (!hash) return [];
              return await eventsInBlock(hash, n, watched, iface);
            } catch {
              return [];
            }
          }),
        );
        const found = results.flat();
        if (found.length) {
          await putEvents(found);
          onEvents?.(found);
          total += found.length;
        }
        onProgress?.(Math.min(i + batch.length, heights.length), heights.length);
      }

      await setMeta(`range:${key}`, { from: target, to: Math.max(range.to, head) });
      return total;
    },
  };
}

/** Cached events for one dispute, oldest first. */
export async function eventsForDispute(contract: string, disputeId: bigint | string): Promise<IndexedEvent[]> {
  const db = await openDb();
  const wanted = `${contract.toLowerCase()}:${disputeId}`;
  return new Promise((resolve, reject) => {
    const out: IndexedEvent[] = [];
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).index('byDispute').openCursor(IDBKeyRange.only(wanted));
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve(out.sort((a, b) => a.block - b.block || a.id.localeCompare(b.id)));
      out.push(cur.value as IndexedEvent);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/** Cached events naming `who` in any argument — how a juror finds their own history. */
export async function eventsForAccount(who: string): Promise<IndexedEvent[]> {
  const db = await openDb();
  const needle = who.toLowerCase();
  return new Promise((resolve, reject) => {
    const out: IndexedEvent[] = [];
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve(out.sort((a, b) => b.block - a.block));
      const e = cur.value as IndexedEvent;
      if (Object.values(e.args).some((v) => String(v).toLowerCase() === needle)) out.push(e);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function clearIndex(): Promise<void> {
  await tx(STORE, 'readwrite', (s) => s.clear() as IDBRequest<any>);
  await tx(META, 'readwrite', (s) => s.clear() as IDBRequest<any>);
}
