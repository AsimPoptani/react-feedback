/** One queued note. `body` is null while its picture is still being taken; `fallback` is the text-only version. */
export interface OutboxRecord {
  id: string; seq: number; label: string; text: string;
  body: Record<string, unknown> | null; fallback: Record<string, unknown>;
  state: 'queued' | 'failed'; reason?: string;
}
export interface OutboxStore {
  /** Resolves true when records survive a reload, false when this browser only allows memory. */
  ready: Promise<boolean>;
  load: () => Promise<OutboxRecord[]>;
  put: (record: OutboxRecord) => Promise<void>;
  remove: (id: string) => Promise<void>;
}
const DB = 'fm-feedback-outbox', TABLE = 'items';
function openDb(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    try {
      const factory = globalThis.indexedDB;
      if (!factory) { resolve(null); return; }
      const request = factory.open(DB, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore(TABLE, { keyPath: 'id' }); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = request.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}
function run<T>(db: IDBDatabase, mode: IDBTransactionMode, act: (table: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TABLE, mode);
    const request = act(tx.objectStore(TABLE));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
/** IndexedDB holds the queue (the items can be several MB of data URLs); with no IndexedDB, a Map does. */
export function openStore(): OutboxStore {
  const memory = new Map<string, OutboxRecord>();
  const open = openDb();
  const ready = open.then(db => db !== null);
  const use = async <T,>(onDb: (db: IDBDatabase) => Promise<T>, onMemory: () => T): Promise<T> => {
    const db = await open;
    if (!db) return onMemory();
    try { return await onDb(db); } catch { return onMemory(); }
  };
  return {
    ready,
    load: () => use(db => run(db, 'readonly', table => table.getAll() as IDBRequest<OutboxRecord[]>), () => [...memory.values()]),
    put: record => use(async db => { await run(db, 'readwrite', table => table.put(record)); }, () => { memory.set(record.id, record); }),
    remove: id => use(async db => { await run(db, 'readwrite', table => table.delete(id)); }, () => { memory.delete(id); }),
  };
}
