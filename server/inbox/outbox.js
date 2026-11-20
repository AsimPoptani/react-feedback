// The inbox's offline outbox: messages written with no signal wait here (IndexedDB, or memory when the browser has none) and go out in order when it returns.
// No build, no deps. A key from the secure box is NEVER queued: this module only ever sees ordinary messages.
export const BACKOFF = [2000, 5000, 15000, 30000, 60000]; // ms; after the last, every minute
const DB = 'fb-inbox-outbox', TABLE = 'queue';

// A client message id: the server stores a message with that id once, so a retry (even one whose first try arrived) never posts twice.
export function newCid() {
  const random = globalThis.crypto?.randomUUID?.();
  return (random ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64).padEnd(8, '0');
}

function openDb() {
  return new Promise(resolve => {
    try {
      const factory = globalThis.indexedDB;
      if (!factory) { resolve(null); return; }
      const request = factory.open(DB, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore(TABLE, { keyPath: 'cid' }); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = request.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}
function run(db, mode, act) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TABLE, mode);
    const request = act(tx.objectStore(TABLE));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
// IndexedDB holds the queue (images are data URLs, several MB); with no IndexedDB a Map does, and `ready` resolves false so the page can warn.
export function openStore() {
  const memory = new Map();
  const open = openDb();
  const ready = open.then(db => db !== null);
  const use = async (onDb, onMemory) => {
    const db = await open;
    if (!db) return onMemory();
    try { return await onDb(db); } catch { return onMemory(); }
  };
  return {
    ready,
    load: () => use(db => run(db, 'readonly', t => t.getAll()), () => [...memory.values()]),
    put: record => use(async db => { await run(db, 'readwrite', t => t.put(record)); }, () => { memory.set(record.cid, record); }),
    remove: cid => use(async db => { await run(db, 'readwrite', t => t.delete(cid)); }, () => { memory.delete(cid); }),
  };
}

// `post(entry)` sends one message and resolves `{ status }`; it throws when the network failed (no answer at all).
// A 2xx removes the entry. A network error, 408, 429 or 5xx keeps it and backs off: nothing behind it goes first, so order holds.
// Any other answer (the thread is read-only or gone, the message was refused) marks that one `failed` with a reason and the rest carry on.
export function createOutbox({ store = openStore(), post, canSend = () => true, onChange = () => {}, onSent = () => {}, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = t => clearTimeout(t) }) {
  let entries = [], loaded = false, persistent = true, running = false, timer, last = 0, idle = 0;
  const emit = () => onChange();
  const save = entry => { if (entries.includes(entry)) void store.put(snapshotOf(entry)).catch(() => {}); };
  // `files` are the files that go with the message: { name, size, type, blob } until each is uploaded (a Blob is kept in IndexedDB as it is), then also { id } (the server's upload id). `uploadId` keeps a half-finished upload resumable.
  const snapshotOf = ({ cid, seq, thread, text, images, files, reply_to, quote, aside, written_at, state, reason }) => ({ cid, seq, thread, text, images, ...(files?.length ? { files } : {}), ...(reply_to ? { reply_to } : {}), ...(quote ? { quote } : {}), ...(aside ? { aside: true } : {}), written_at, state, ...(reason ? { reason } : {}) });
  const loading = (async () => {
    persistent = await store.ready;
    const records = await store.load().catch(() => []);
    const known = new Set(entries.map(e => e.cid));
    for (const r of records) if (!known.has(r.cid)) entries.push({ ...r, state: r.state === 'failed' ? 'failed' : 'queued', attempts: 0, nextAt: 0, sending: false });
    entries.sort((a, b) => a.seq - b.seq);
    loaded = true; emit();
  })();
  async function pump() {
    await loading;
    if (running) return;
    running = true;
    try {
      for (;;) {
        const entry = entries.find(e => e.state === 'queued');
        if (!entry) return;
        if (!canSend()) { clearTimer(timer); timer = setTimer(() => { void pump(); }, BACKOFF[Math.min(idle++, BACKOFF.length - 1)]); return; } // offline: look again later (flush() looks at once), so a missed 'online' never strands the queue
        const wait = entry.nextAt - now();
        if (wait > 0) { clearTimer(timer); timer = setTimer(() => { void pump(); }, wait); return; }
        entry.sending = true; emit();
        let result;
        try { result = await post(entry); } catch { result = { network: true }; }
        entry.sending = false;
        const status = result.status ?? 0;
        if (!result.network && status >= 200 && status < 300) {
          idle = 0; entries = entries.filter(e => e !== entry);
          await store.remove(entry.cid).catch(() => {});
          emit(); onSent(entry, result);
        } else if (result.network || status >= 500 || status === 408 || status === 429) {
          entry.nextAt = now() + BACKOFF[Math.min(entry.attempts, BACKOFF.length - 1)]; entry.attempts++;
          emit();
        } else {
          entry.state = 'failed'; entry.reason = result.reason || `The server refused it (${status}).`; save(entry); emit();
        }
      }
    } finally { running = false; }
  }
  return {
    // Resolves once the message is stored. `thread`, `text`, `images` (data URLs), `reply_to`, `quote` ({ message_id, text }), `aside`; `cid` and `written_at` may be given (a send that failed on the network keeps its own).
    async add(input) {
      await loading;
      last = Math.max(now(), last + 1);
      const entry = { cid: input.cid || newCid(), seq: last, thread: input.thread, text: input.text ?? '', images: input.images ?? [], ...(input.files?.length ? { files: input.files } : {}), ...(input.reply_to ? { reply_to: input.reply_to } : {}), ...(input.quote ? { quote: input.quote } : {}), ...(input.aside ? { aside: true } : {}),
        written_at: input.written_at || new Date(now()).toISOString(), state: 'queued', attempts: 0, nextAt: 0, sending: false };
      entries.push(entry);
      await store.put(snapshotOf(entry)).catch(() => {});
      emit(); void pump();
      return entry;
    },
    // The caller changed an entry while sending it (an upload id, progress): save it, and say so to the page.
    touch(entry, persist = false) { if (persist) save(entry); emit(); },
    // Delete a message before it sends (also clears a failed one).
    async remove(cid) {
      await loading;
      const entry = entries.find(e => e.cid === cid);
      if (!entry || entry.sending) return false;
      entries = entries.filter(e => e !== entry);
      await store.remove(cid).catch(() => {});
      emit(); return true;
    },
    // The network or the tab came back: skip the waiting and send now.
    flush() { idle = 0; for (const e of entries) e.nextAt = 0; void pump(); },
    retry(cid) { const e = entries.find(x => x.cid === cid && x.state === 'failed'); if (!e) return; e.state = 'queued'; e.reason = undefined; e.attempts = 0; e.nextAt = 0; save(e); emit(); void pump(); },
    start() { void pump(); },
    stop() { clearTimer(timer); },
    entries: () => entries,
    forThread: id => entries.filter(e => e.thread === id),
    pending: () => entries.filter(e => e.state === 'queued').length,
    persistent: () => persistent,
    ready: () => loading,
    isLoaded: () => loaded,
  };
}
