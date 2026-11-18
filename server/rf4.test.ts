import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from './server';
import * as store from './store';
import { donutArcs, donutLabel } from './inbox/donut.js';

let dir: string;
let handle: ReturnType<typeof createHandler>;
const api = (path: string, data?: unknown) => new Request(`http://local/__feedback/api/${path}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'feedback-rf4-')); handle = createHandler(dir); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const start = async (title: string, text: string) => (await store.createThread(dir, { title, text, origin: 'user' })).id;

test('reply_to may not name a merge divider (400), but the messages around it are fine', async () => {
  const from = await start('From', 'src one');
  const into = await start('Into', 'tgt one');
  await store.mergeThreads(dir, from, into, 'user');
  const msgs = (await (await handle(api(`threads/${into}`))).json()).messages as { id: string; divider?: boolean }[];
  const divider = msgs.find(m => m.divider)!;
  expect(divider).toBeDefined();
  const bad = await handle(api(`threads/${into}/messages`, { text: 'x', reply_to: divider.id }));
  expect(bad.status).toBe(400);
  const ok = await handle(api(`threads/${into}/messages`, { text: 'y', reply_to: msgs.find(m => !m.divider)!.id }));
  expect(ok.status).toBe(201);
});

test('the inbox serves donut.js', async () => {
  const r = await handle(new Request('http://local/__feedback/inbox/donut.js'));
  expect(r.status).toBe(200);
  expect(r.headers.get('content-type')).toContain('javascript');
});

test('donut label and arcs: none, partial, all done, claimed', () => {
  expect(donutLabel({ total: 0, done: 0, claimed: 0 })).toBe('No checklist items');
  expect(donutLabel({ total: 11, done: 0, claimed: 0 })).toBe('0 of 11 done');
  expect(donutLabel({ total: 11, done: 2, claimed: 1 })).toBe('2 of 11 done, 1 claimed');
  expect(donutArcs({ total: 0, done: 0, claimed: 0 })).toEqual({ done: 0, claimed: 0 });
  expect(donutArcs({ total: 10, done: 0, claimed: 0 })).toEqual({ done: 0, claimed: 0 });
  const half = donutArcs({ total: 10, done: 5, claimed: 0 });
  expect(half.done).toBeCloseTo(half.claimed);
  const all = donutArcs({ total: 4, done: 4, claimed: 0 });
  expect(all.done).toBeCloseTo(2 * Math.PI * 7);
  const claimed = donutArcs({ total: 4, done: 1, claimed: 2 });
  expect(claimed.claimed).toBeCloseTo(0.75 * 2 * Math.PI * 7);
  expect(donutArcs({ total: 2, done: 9, claimed: 9 }).claimed).toBeCloseTo(2 * Math.PI * 7); // never past the ring
});
