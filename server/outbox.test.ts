import { expect, test } from 'bun:test';
import { BACKOFF, createOutbox, newCid } from './inbox/outbox.js';

// A store that survives "reloads": two outboxes over one Map see the same records.
const store = (map = new Map<string, Record<string, unknown>>()) => ({ ready: Promise.resolve(true), load: async () => [...map.values()], put: async (r: { cid: string }) => { map.set(r.cid, r as never); }, remove: async (cid: string) => { map.delete(cid); }, map });
const entry = (thread: string, text: string) => ({ thread, text, images: [] as string[] });

test('queued messages go out one at a time, in the order they were written', async () => {
  const sent: string[] = []; const clock = 1000;
  const o = createOutbox({ store: store(), now: () => clock, post: async e => { sent.push(e.text); return { status: 201 }; }, canSend: () => false });
  await o.add(entry('t', 'a')); await o.add(entry('t', 'b')); await o.add(entry('t', 'c'));
  expect(sent).toEqual([]); expect(o.pending()).toBe(3);
  const live = createOutbox({ store: store(new Map(o.entries().map(e => [e.cid, { ...e }]))), post: async e => { sent.push(e.text); return { status: 201 }; } });
  await live.ready(); live.start(); await new Promise(r => setTimeout(r, 10));
  expect(sent).toEqual(['a', 'b', 'c']); expect(live.pending()).toBe(0);
});

test('a network failure stops the line: the failed one is tried again first, with a growing wait; later ones never jump ahead', async () => {
  const seen: string[] = []; let clock = 0, down = true; const timers: number[] = [];
  const o = createOutbox({ store: store(), now: () => clock, setTimer: (_f, ms) => { timers.push(ms); return 1; }, clearTimer: () => {},
    post: async e => { seen.push(e.text); if (down) throw new TypeError('offline'); return { status: 201 }; } });
  await o.add(entry('t', 'one')); await o.add(entry('t', 'two'));
  await new Promise(r => setTimeout(r, 5));
  expect(seen).toEqual(['one']); expect(timers.at(-1)).toBe(BACKOFF[0]);
  clock += BACKOFF[0]!; o.flush(); await new Promise(r => setTimeout(r, 5));
  expect(seen).toEqual(['one', 'one']); expect(timers.at(-1)).toBe(BACKOFF[1]);
  down = false; o.flush(); await new Promise(r => setTimeout(r, 5));
  expect(seen).toEqual(['one', 'one', 'one', 'two']); expect(o.pending()).toBe(0);
});

test('5xx, 408 and 429 are retried; any other refusal marks that one failed and the rest still go', async () => {
  const seen: string[] = []; const answers: Record<string, number> = { x: 503, y: 409, z: 201 }; const clock = 0;
  const o = createOutbox({ store: store(), now: () => clock, setTimer: () => 1, clearTimer: () => {}, post: async e => { seen.push(e.text); return { status: answers[e.text]!, reason: answers[e.text] === 409 ? 'read-only' : undefined }; } });
  await o.add(entry('t', 'y')); await o.add(entry('t', 'z'));
  await new Promise(r => setTimeout(r, 5));
  expect(seen).toEqual(['y', 'z']);
  expect(o.entries().find(e => e.text === 'y')).toMatchObject({ state: 'failed', reason: 'read-only' });
  await o.add(entry('t', 'x')); await new Promise(r => setTimeout(r, 5));
  expect(o.entries().find(e => e.text === 'x')).toMatchObject({ state: 'queued', attempts: 1 });
  o.retry(o.entries().find(e => e.text === 'y')!.cid); await new Promise(r => setTimeout(r, 5));
  expect(seen.filter(t => t === 'y').length).toBe(2); // tried again (and refused again)
});

test('a queued message survives a reload (it is in the store) and can be deleted before it sends', async () => {
  const s = store();
  const a = createOutbox({ store: s, post: async () => ({ status: 201 }), canSend: () => false });
  const kept = await a.add({ ...entry('t', 'keep'), images: ['data:image/png;base64,AAAA'], reply_to: 'm2', aside: false });
  const gone = await a.add(entry('t', 'drop'));
  expect(await a.remove(gone.cid)).toBe(true);
  expect([...s.map.keys()]).toEqual([kept.cid]);
  const b = createOutbox({ store: s, post: async () => ({ status: 201 }), canSend: () => false }); await b.ready();
  expect(b.entries().map(e => e.text)).toEqual(['keep']); expect(b.entries()[0]).toMatchObject({ images: ['data:image/png;base64,AAAA'], reply_to: 'm2', written_at: kept.written_at });
});

test('client ids are valid for the server and unique', () => {
  const ids = new Set(Array.from({ length: 200 }, newCid));
  expect(ids.size).toBe(200);
  for (const id of ids) expect(/^[A-Za-z0-9_-]{8,64}$/.test(id)).toBe(true);
});

test('a queue that found the network down looks again on its own (a server restart sends no online event)', async () => {
  let offline = true, clock = 0; const timers: { fn: () => void; ms: number }[] = []; const sent: string[] = [];
  const o = createOutbox({ store: store(), now: () => clock, canSend: () => !offline, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
    post: async e => { sent.push(e.text); return { status: 201 }; } });
  await o.add(entry('t', 'while down')); await new Promise(r => setTimeout(r, 5));
  expect(sent).toEqual([]); expect(timers.length).toBe(1); expect(timers[0]!.ms).toBe(BACKOFF[0]); // it did not just return
  timers.shift()!.fn(); await new Promise(r => setTimeout(r, 5));
  expect(timers[0]!.ms).toBe(BACKOFF[1]); // still down: wait longer
  offline = false; clock += 60000; timers.shift()!.fn(); await new Promise(r => setTimeout(r, 5));
  expect(sent).toEqual(['while down']); expect(o.pending()).toBe(0);
});
