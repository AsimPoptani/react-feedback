import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from './server';
import { run, transcript } from './cli';
import * as store from './store';
import { asideGroups, parseBtw, pendingAsides } from './inbox/aside.js';
import { filterRows, groupRows } from './inbox/tracker.js';

let dir: string;
let handle: ReturnType<typeof createHandler>;
const api = (path: string, data?: unknown) => new Request(`http://local/__feedback/api/${path}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'feedback-rf5-')); handle = createHandler(dir); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const start = async (title = 'T', text = 'first') => (await store.createThread(dir, { title, text, origin: 'user' })).id;
const detail = async (id: string) => (await (await handle(api(`threads/${id}`))).json());
const user = (id: string, text: string, extra: Record<string, unknown> = {}) => handle(api(`threads/${id}/messages`, { text, ...extra }));
const summary = async (id: string) => (await store.summarise(dir, id)).summary;
const lines = async (id: string) => (await readFile(join(dir, id, 'thread.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));

// ---- Asides
test('parseBtw strips the prefix and only matches /btw as a word', () => {
  expect(parseBtw('/btw what is x?')).toEqual({ aside: true, text: 'what is x?' });
  expect(parseBtw('  /BTW   hi')).toEqual({ aside: true, text: 'hi' });
  expect(parseBtw('/btw')).toEqual({ aside: true, text: '' });
  expect(parseBtw('/btwx no')).toEqual({ aside: false, text: '/btwx no' });
  expect(parseBtw('hello /btw')).toEqual({ aside: false, text: 'hello /btw' });
});

test('an aside is stored with aside:true, logged as an event, and an old message has neither field', async () => {
  const id = await start();
  const r = await user(id, 'side q', { aside: true });
  expect(r.status).toBe(201);
  const m = await r.json();
  expect(m.aside).toBe(true);
  expect('reply_to' in m).toBe(false);
  const d = await detail(id);
  expect('aside' in d.messages[0]).toBe(false);
  const events = (await readFile(join(dir, '_events.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  expect(events[events.length - 1]).toMatchObject({ kind: 'message', aside: true });
  expect('aside' in events[0]).toBe(false);
});

test('an unanswered aside makes the thread wait for the agent without touching the main flow', async () => {
  const id = await start();
  await store.appendMessage(dir, id, { author: 'agent', text: 'Answer', flag: 'fyi' });
  expect((await summary(id)).waiting).toBe('idle');
  await user(id, 'by the way?', { aside: true });
  const s = await summary(id);
  expect(s.waiting).toBe('agent');
  expect(s.waiting_aside).toBe(true);
  expect(s.last_author).toBe('agent'); // the aside does not make the main thread look unanswered
  // the agent answers the aside: back to idle, and the main flow is still "answered"
  await run(['reply', id, 'Here', '--aside', '--to', 'm3'], dir);
  const after = await summary(id);
  expect(after.waiting).toBe('idle');
  expect('waiting_aside' in after).toBe(false);
  expect(after.last_author).toBe('agent');
});

test('an aside does not make an unanswered main message look answered, and an agent aside answer does not answer it', async () => {
  const id = await start();
  await user(id, 'aside one', { aside: true });
  await run(['reply', id, 'aside answer', '--aside', '--to', 'm2'], dir);
  const s = await summary(id);
  expect(s.waiting).toBe('agent'); // m1 (main) still unanswered
  expect(s.last_author).toBe('user');
  expect('waiting_aside' in s).toBe(false);
});

test('main waiting on you stays "you" while an aside waits, and waiting_aside says so; ack clears the aside', async () => {
  const id = await start();
  await store.appendMessage(dir, id, { author: 'agent', text: 'Need a decision', flag: 'needs_you' });
  await user(id, 'quick one', { aside: true });
  let s = await summary(id);
  expect(s.waiting).toBe('you');
  expect(s.waiting_aside).toBe(true);
  expect((await run(['list', '--waiting'], dir))).toContain('[side question waiting]');
  await store.ackThread(dir, id);
  s = await summary(id);
  expect('waiting_aside' in s).toBe(false);
});

test('aside rules: no quote from a user aside, an answer must name an aside root, no flag, no questions, a main message cannot quote an aside', async () => {
  const id = await start();
  expect((await user(id, 'x', { aside: true, reply_to: 'm1' })).status).toBe(400);
  await user(id, 'root', { aside: true });
  await expect(store.appendMessage(dir, id, { author: 'agent', text: 'a', aside: true })).rejects.toThrow('name the side question');
  await expect(store.appendMessage(dir, id, { author: 'agent', text: 'a', aside: true, reply_to: 'm1' })).rejects.toThrow('name the side question');
  await expect(store.appendMessage(dir, id, { author: 'agent', text: 'a', aside: true, reply_to: 'm2', flag: 'done' })).rejects.toThrow('cannot be flagged');
  await expect(store.appendMessage(dir, id, { author: 'agent', text: 'a', aside: true, reply_to: 'm2', question: { prompt: 'p', options: [{ label: 'x' }] } })).rejects.toThrow();
  expect((await user(id, 'quote it', { reply_to: 'm2' })).status).toBe(400);
  expect((await user(id, 'x', { aside: 'yes' })).status).toBe(400);
});

test('read prints asides indented under "Side question", with a waiting note', async () => {
  const id = await start();
  await user(id, 'side q', { aside: true });
  let out = await run(['read', id], dir);
  expect(out).toContain('Side question (waiting for the agent)');
  expect(out).toMatch(/\n {4}m2 {2}user/);
  await run(['reply', id, 'side a', '--aside', '--to', 'm2'], dir);
  out = await run(['read', id], dir);
  expect(out).toContain('    Side question\n');
  expect(out).toMatch(/\n {4}m3 {2}agent/);
  expect(out).not.toContain('waiting for the agent');
});

test('asideGroups pairs answers with their root and honours the acknowledgement', () => {
  const ms = [
    { id: 'm1', author: 'user', created_at: '2026-01-01T00:00:01Z' },
    { id: 'm2', author: 'user', created_at: '2026-01-01T00:00:02Z', aside: true },
    { id: 'm3', author: 'agent', created_at: '2026-01-01T00:00:03Z', aside: true, reply_to: 'm2' },
    { id: 'm4', author: 'user', created_at: '2026-01-01T00:00:04Z', aside: true },
  ] as never[];
  const g = asideGroups(ms);
  expect(g.map(x => [x.root.id, x.answers.length, x.answered])).toEqual([['m2', 1, true], ['m4', 0, false]]);
  expect(pendingAsides(ms).map(m => m.id)).toEqual(['m4']);
  expect(pendingAsides(ms, '2026-01-01T00:00:05Z')).toEqual([]);
});

test('merging keeps asides with their links, remapped, and the aside stays pending in the target', async () => {
  const from = await start('From', 'src');
  const into = await start('Into', 'tgt');
  await user(from, 'aside in source', { aside: true });
  await store.appendMessage(dir, from, { author: 'agent', text: 'aside answer', aside: true, reply_to: 'm2' });
  await user(from, 'second aside', { aside: true });
  await store.mergeThreads(dir, from, into, 'agent');
  const d = await detail(into);
  const asides = d.messages.filter((m: { aside?: boolean }) => m.aside);
  expect(asides.length).toBe(3);
  const root = asides[0], answer = asides[1];
  expect(answer.reply_to).toBe(root.id);
  expect(root.id).not.toBe('m2');
  expect(d.waiting_aside).toBe(true);
});

test('metrics ignore asides for response times and for waiting since', async () => {
  const id = await start();
  await store.appendMessage(dir, id, { author: 'agent', text: 'ok', flag: 'fyi' });
  await user(id, 'aside', { aside: true });
  const { computeMetrics } = await import('./metrics');
  const m = await computeMetrics(dir, 'all');
  expect(m.response.user.count).toBe(0);
});

// ---- Attached checklist items
test('reply --todo adds items and the message stores their ids; they are in the panel', async () => {
  const id = await start();
  const out = await run(['reply', id, 'Plan', '--todo', 'Send the doc', '--todo', 'Review it', '--for', 'user'], dir);
  expect(out).toContain('added c1 c2');
  const d = await detail(id);
  expect(d.messages[1].added_items).toEqual(['c1', 'c2']);
  expect(d.checklist_items.map((i: { id: string; owner: string; created_by: string }) => [i.id, i.owner, i.created_by])).toEqual([['c1', 'user', 'agent'], ['c2', 'user', 'agent']]);
  await run(['reply', id, 'Mine', '--todo', 'Do it'], dir);
  expect((await detail(id)).checklist_items[2].owner).toBe('agent'); // default: the agent's own list
});

test('reply --check ticks items and the message stores what it ticked; an already ticked item is not repeated', async () => {
  const id = await start();
  await store.addChecklistItem(dir, id, { owner: 'agent', text: 'A', by: 'agent' });
  await store.addChecklistItem(dir, id, { owner: 'agent', text: 'B', by: 'agent' });
  await run(['reply', id, 'Done A', '--check', 'c1'], dir);
  const out = await run(['reply', id, 'Done both', '--check', 'c1', '--check', 'c2'], dir);
  expect(out).toContain('ticked c2');
  const d = await detail(id);
  expect(d.messages[1].ticked_items).toEqual(['c1']);
  expect(d.messages[2].ticked_items).toEqual(['c2']);
  expect(d.checklist_items.every((i: { done: boolean }) => i.done)).toBe(true);
});

test('attached items are all-or-nothing: an unknown id or a bad text writes nothing', async () => {
  const id = await start();
  await expect(run(['reply', id, 'x', '--todo', 'ok', '--check', 'c9'], dir)).rejects.toThrow('No such item');
  const d = await detail(id);
  expect(d.messages.length).toBe(1);
  expect(d.checklist_items.length).toBe(0);
  await expect(run(['reply', id, 'x', '--for', 'user'], dir)).rejects.toThrow('--for goes with --todo');
  await expect(run(['reply', id, 'x', '--todo', ' '], dir)).rejects.toThrow('Item text');
});

test('the user adds items with a message, never ticks, and a read-only thread refuses them', async () => {
  const id = await start();
  const r = await user(id, 'please do', { todo: ['One', 'Two'], for: 'agent' });
  expect(r.status).toBe(201);
  const m = await r.json();
  expect(m.added_items).toEqual(['c1', 'c2']);
  const d = await detail(id);
  expect(d.checklist_items.map((i: { owner: string }) => i.owner)).toEqual(['agent', 'agent']);
  const tick = await user(id, 'tick', { check: ['c1'] });
  expect(tick.status).toBe(403);
  expect((await detail(id)).checklist_items[0].done).toBe(false);
  await store.setReadOnly(dir, id, true);
  expect((await user(id, 'again', { todo: ['x'] })).status).toBe(409);
  expect((await detail(id)).checklist_items.length).toBe(2);
  // the agent (CLI) still can on a read-only thread
  await run(['reply', id, 'ok', '--check', 'c1'], dir);
  expect((await detail(id)).checklist_items[0].done).toBe(true);
});

test('read shows the items a message added and ticked', async () => {
  const id = await start();
  await run(['reply', id, 'Plan', '--todo', 'Send it'], dir);
  await run(['reply', id, 'Sent', '--check', 'c1'], dir);
  const out = await run(['read', id], dir);
  expect(out).toContain('+ added to checklist: c1 Send it');
  expect(out).toContain('[x] ticked: c1 Send it');
});

test('merging remaps attached item ids with the moved checklist', async () => {
  const from = await start('From', 's');
  const into = await start('Into', 't');
  await store.addChecklistItem(dir, into, { owner: 'agent', text: 'existing', by: 'agent' });
  await run(['reply', from, 'plan', '--todo', 'moved item'], dir);
  await store.mergeThreads(dir, from, into, 'agent');
  const d = await detail(into);
  const m = d.messages.find((x: { added_items?: string[] }) => x.added_items);
  expect(m.added_items).toEqual(['c2']);
  expect(d.checklist_items.find((i: { id: string }) => i.id === 'c2').text).toBe('moved item');
});

// ---- Move
test('moving one message: it lands in the target with its time and author, a stub is left, and the source recomputes', async () => {
  const wrong = await start('Wrong', 'first here');
  const right = await start('Right', 'right one');
  await store.appendMessage(dir, wrong, { author: 'agent', text: 'agent reply', flag: 'fyi' });
  await user(wrong, 'oops wrong thread');
  expect((await summary(wrong)).waiting).toBe('agent');
  const before = (await detail(wrong)).messages[2];
  const out = await run(['move', wrong, 'm3', '--to', right], dir);
  expect(out).toContain('Moved m3');
  const t = await detail(right);
  const copy = t.messages[t.messages.length - 1];
  expect(copy).toMatchObject({ author: 'user', text: 'oops wrong thread', created_at: before.created_at });
  expect(t.messages.some((m: { divider?: boolean; text: string }) => m.divider && m.text.startsWith('Moved from: Wrong'))).toBe(true);
  expect(t.waiting).toBe('agent');
  const s = await detail(wrong);
  expect(s.messages[2]).toMatchObject({ id: 'm3', divider: true, moved_to: right, text: `Moved to [Right](#/${right})`, created_at: before.created_at });
  expect(s.waiting).toBe('idle'); // m2 answered m1; the stub of the moved message does not count as a message
});

test('after the move the source thread no longer waits on the moved user message', async () => {
  const wrong = await start('Wrong', 'first');
  const right = await start('Right', 'r');
  await store.appendMessage(dir, wrong, { author: 'agent', text: 'reply', flag: 'fyi' });
  await user(wrong, 'oops');
  await run(['move', wrong, 'm3', '--to', right], dir);
  expect((await summary(wrong)).waiting).toBe('idle');
  expect((await summary(wrong)).last_author).toBe('agent');
});

test('moving several messages keeps their order and remaps reply_to; a quote of a message left behind is dropped', async () => {
  const a = await start('A', 'a1');
  const b = await start('B', 'b1');
  await user(a, 'a2');
  await user(a, 'a3 quotes a2', { reply_to: 'm2' });
  await user(a, 'a4 quotes a1', { reply_to: 'm1' });
  await run(['move', a, 'm2', 'm3', 'm4', '--to', b], dir);
  const t = (await detail(b)).messages.filter((m: { moved_from?: string; divider?: boolean }) => m.moved_from && !m.divider);
  expect(t.map((m: { text: string }) => m.text)).toEqual(['a2', 'a3 quotes a2', 'a4 quotes a1']);
  expect(t[1].reply_to).toBe(t[0].id);
  expect('reply_to' in t[2]).toBe(false);
  const src = await detail(a);
  expect(src.messages.filter((m: { moved_to?: string }) => m.moved_to).length).toBe(3);
  expect(src.messages[0].text).toBe('a1');
});

test('a message left behind that quoted a moved one now quotes the stub', async () => {
  const a = await start('A', 'a1');
  const b = await start('B', 'b1');
  await user(a, 'a2');
  await user(a, 'a3', { reply_to: 'm2' });
  await run(['move', a, 'm2', '--to', b], dir);
  const src = await detail(a);
  expect(src.messages[2].reply_to).toBe('m2');
  expect(src.messages[1].moved_to).toBe(b);
});

test('images move with the message', async () => {
  const a = await start('A', 'a1');
  const b = await start('B', 'b1');
  await user(a, 'with pic', { images: [png] });
  await run(['move', a, 'm2', '--to', b], dir);
  const t = await detail(b);
  const copy = t.messages[t.messages.length - 1];
  expect(copy.images).toEqual(['msg-1.png']);
  const file = await handle(new Request(`http://local/__feedback/api/threads/${b}/files/${copy.images[0]}`));
  expect([200, 404]).toContain(file.status);
  expect((await readFile(join(dir, b, 'msg-1.png'))).length).toBeGreaterThan(0);
});

test('items a moved message added travel with it', async () => {
  const a = await start('A', 'a1');
  const b = await start('B', 'b1');
  await store.addChecklistItem(dir, b, { owner: 'agent', text: 'target item', by: 'agent' });
  await run(['reply', a, 'plan', '--todo', 'travel'], dir);
  await run(['move', a, 'm2', '--to', b], dir);
  const t = await detail(b);
  const copy = t.messages[t.messages.length - 1];
  expect(copy.added_items).toEqual(['c2']);
  expect(t.checklist_items.map((i: { text: string }) => i.text)).toEqual(['target item', 'travel']);
  expect((await detail(a)).checklist_items.length).toBe(0);
});

test('moving a question needs its answer, and a side question its answers', async () => {
  const a = await start('A', 'a1');
  const b = await start('B', 'b1');
  await store.appendMessage(dir, a, { author: 'agent', text: 'Pick', question: { prompt: 'Pick', options: [{ label: 'x' }] } });
  await store.appendMessage(dir, a, { author: 'user', text: undefined, answer: { question_id: 'q2', option_ids: ['o1'] } });
  await expect(run(['move', a, 'm2', '--to', b], dir)).rejects.toThrow('together');
  await run(['move', a, 'm2', 'm3', '--to', b], dir);
  const t = await detail(b);
  const q = t.messages.find((m: { question?: unknown }) => m.question);
  const ans = t.messages.find((m: { answer?: unknown }) => m.answer);
  expect(ans.answer.question_id).toBe(q.question.id);
  await user(a, 'aside', { aside: true });
  await store.appendMessage(dir, a, { author: 'agent', text: 'ans', aside: true, reply_to: 'm4' });
  await expect(run(['move', a, 'm4', '--to', b], dir)).rejects.toThrow('together');
  await run(['move', a, 'm4', 'm5', '--to', b], dir);
  const asides = (await detail(b)).messages.filter((m: { aside?: boolean }) => m.aside);
  expect(asides[1].reply_to).toBe(asides[0].id);
});

test('move validation: same thread, unknown ids, dividers, read-only targets, merged threads, duplicates, no ids', async () => {
  const a = await start('A', 'a1');
  const b = await start('B', 'b1');
  await expect(run(['move', a, 'm1', '--to', a], dir)).rejects.toThrow('different thread');
  await expect(run(['move', a, 'm9', '--to', b], dir)).rejects.toThrow('No message m9');
  await expect(run(['move', a, 'm1', '--to', '20260101-000000-abcd'], dir)).rejects.toThrow('Not found');
  await expect(run(['move', a, 'm1'], dir)).rejects.toThrow('--to');
  await expect(run(['move', a, 'm1', 'm1', '--to', b], dir)).rejects.toThrow('once');
  await store.setReadOnly(dir, b, true);
  await expect(run(['move', a, 'm1', '--to', b], dir)).rejects.toThrow('read-only');
  await store.appendMessage(dir, a, { author: 'agent', text: 'agent msg', flag: 'fyi' });
  await run(['move', a, 'm2', '--to', b], dir); // an agent message may go into a read-only thread
  await store.setReadOnly(dir, b, false);
  const c = await start('C', 'c1');
  const d = await start('D', 'd1');
  await store.mergeThreads(dir, c, d, 'agent');
  await expect(run(['move', c, 'm1', '--to', b], dir)).rejects.toThrow('merged');
  await expect(run(['move', a, 'm1', '--to', c], dir)).rejects.toThrow('merged');
  // a plain divider
  const e = await start('E', 'e1');
  const f = await start('F', 'f1');
  await store.mergeThreads(dir, e, f, 'agent');
  const g = await start('G', 'g1');
  const div = (await detail(f)).messages.find((m: { divider?: boolean }) => m.divider);
  await expect(run(['move', f, div.id, '--to', g], dir)).rejects.toThrow('divider');
});

test('running a finished move again does nothing; an interrupted move (copies written, stubs not) finishes without duplicates', async () => {
  const a = await start('A', 'a1');
  const b = await start('B', 'b1');
  await user(a, 'a2'); await user(a, 'a3');
  await run(['move', a, 'm2', 'm3', '--to', b], dir);
  expect(await run(['move', a, 'm2', 'm3', '--to', b], dir)).toContain('already moved');
  expect((await detail(b)).messages.filter((m: { moved_from?: string; divider?: boolean }) => m.moved_from && !m.divider).length).toBe(2);
  // an interrupted one: restore the source file as it was before the stubs were written
  const c = await start('C', 'c1');
  const d = await start('D', 'd1');
  await user(c, 'c2'); await user(c, 'c3');
  const before = await readFile(join(dir, c, 'thread.jsonl'), 'utf8');
  await run(['move', c, 'm2', 'm3', '--to', d], dir);
  await writeFile(join(dir, c, 'thread.jsonl'), before); // crash: stubs were never written
  await run(['move', c, 'm2', 'm3', '--to', d], dir);
  const copies = (await detail(d)).messages.filter((m: { moved_from?: string; divider?: boolean }) => m.moved_from && !m.divider);
  expect(copies.map((m: { text: string }) => m.text)).toEqual(['c2', 'c3']);
  expect((await lines(c)).filter(m => m.moved_to).length).toBe(2);
  // a half-written batch (only the first copy made)
  const e = await start('E', 'e1');
  const f = await start('F', 'f1');
  await user(e, 'e2'); await user(e, 'e3', { reply_to: 'm2' });
  const beforeE = await readFile(join(dir, e, 'thread.jsonl'), 'utf8');
  await run(['move', e, 'm2', 'm3', '--to', f], dir);
  const full = await lines(f);
  await writeFile(join(dir, f, 'thread.jsonl'), `${full.slice(0, 3).map(m => JSON.stringify(m)).join('\n')}\n`); // header, divider, first copy
  await writeFile(join(dir, e, 'thread.jsonl'), beforeE);
  await run(['move', e, 'm2', 'm3', '--to', f], dir);
  const tf = (await detail(f)).messages;
  const got = tf.filter((m: { moved_from?: string; divider?: boolean }) => m.moved_from && !m.divider);
  expect(got.map((m: { text: string }) => m.text)).toEqual(['e2', 'e3']);
  expect(got[1].reply_to).toBe(got[0].id);
  expect(tf.filter((m: { divider?: boolean }) => m.divider).length).toBe(1);
});

test('a move logs a move event, and metrics do not count it as a user action', async () => {
  const a = await start('A', 'a1');
  const b = await start('B', 'b1');
  await run(['move', a, 'm1', '--to', b], dir);
  const events = (await readFile(join(dir, '_events.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  expect(events[events.length - 1]).toMatchObject({ kind: 'move', author: 'agent', id: a });
  const { computeMetrics } = await import('./metrics');
  expect((await computeMetrics(dir, 'all')).events.by_kind.move).toBeUndefined();
  expect((await summary(a)).waiting).toBe('idle'); // only a stub left
});

test('moving a user message into a done thread reopens it', async () => {
  const a = await start('A', 'a1');
  const b = await start('B', 'b1');
  await store.setStatus(dir, b, 'done');
  await run(['move', a, 'm1', '--to', b], dir);
  expect((await summary(b)).status).toBe('open');
});

// ---- Tracker
const tr = async (q = '') => (await (await handle(api(`tracker${q}`))).json());
test('the tracker groups items For you, For the agent and Done recently, and counts everything', async () => {
  const a = await start('Alpha', 'a');
  const b = await start('Beta', 'b');
  await store.addChecklistItem(dir, a, { owner: 'user', text: 'user job', by: 'agent' });
  await store.addChecklistItem(dir, a, { owner: 'agent', text: 'agent job', by: 'agent' });
  await store.addChecklistItem(dir, b, { owner: 'agent', text: 'finished', by: 'agent' });
  await store.addChecklistItem(dir, b, { owner: 'agent', text: 'finished long ago', by: 'agent' });
  await store.patchChecklistItem(dir, b, 'c1', { done: true }, 'agent');
  await store.patchChecklistItem(dir, b, 'c2', { done: true }, 'agent');
  const old = JSON.parse(await readFile(join(dir, b, 'checklist.json'), 'utf8'));
  old.items[1].done_at = '2020-01-01T00:00:00.000Z';
  await writeFile(join(dir, b, 'checklist.json'), JSON.stringify(old));
  await store.patchChecklistItem(dir, a, 'c2', { claimed: true }, 'user');
  const t = await tr();
  expect(t.you.map((r: { item: { text: string } }) => r.item.text)).toEqual(['user job']);
  expect(t.agent.map((r: { item: { text: string } }) => r.item.text)).toEqual(['agent job']);
  expect(t.done_recent.map((r: { item: { text: string } }) => r.item.text)).toEqual(['finished']);
  expect(t.counts).toEqual({ total: 4, done: 2, claimed: 1 });
  expect(t.threads.map((x: { title: string }) => x.title).sort()).toEqual(['Alpha', 'Beta']);
  expect(t.you[0]).toMatchObject({ title: 'Alpha', read_only: false });
});

test('tracker filters: thread, state and search; merged-away threads are excluded', async () => {
  const a = await start('Alpha', 'a');
  const b = await start('Beta', 'b');
  const c = await start('Gamma', 'c');
  await store.addChecklistItem(dir, a, { owner: 'user', text: 'Buy milk', by: 'agent' });
  await store.addChecklistItem(dir, b, { owner: 'user', text: 'Call Bob', by: 'agent' });
  await store.addChecklistItem(dir, c, { owner: 'agent', text: 'Gamma thing', by: 'agent' });
  await store.patchChecklistItem(dir, b, 'c1', { claimed: true }, 'user');
  expect((await tr(`?thread=${a}`)).you.length).toBe(1);
  expect((await tr('?state=claimed')).you.map((r: { thread: string }) => r.thread)).toEqual([b]);
  expect((await tr('?q=MILK')).you.map((r: { item: { text: string } }) => r.item.text)).toEqual(['Buy milk']);
  expect((await tr('?state=open')).you.length).toBe(1);
  await store.mergeThreads(dir, c, a, 'agent');
  const after = await tr();
  expect(after.threads.map((x: { id: string }) => x.id).sort()).toEqual([a, b].sort()); // c is merged away; its item moved to a
  expect(after.agent.map((r: { thread: string }) => r.thread)).toEqual([a]);
  expect(after.counts.total).toBe(3);
});

test('tracker rows keep the item rules: only the agent ticks, read-only threads refuse the user', async () => {
  const a = await start('Alpha', 'a');
  await store.addChecklistItem(dir, a, { owner: 'user', text: 'job', by: 'agent' });
  const claim = await handle(new Request(`http://local/__feedback/api/threads/${a}/checklist/c1`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ claimed: true }) }));
  expect(claim.status).toBe(200);
  const tick = await handle(new Request(`http://local/__feedback/api/threads/${a}/checklist/c1`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: true }) }));
  expect(tick.status).toBe(403);
  await store.setReadOnly(dir, a, true);
  const back = await handle(new Request(`http://local/__feedback/api/threads/${a}/checklist/c1`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ claimed: false }) }));
  expect(back.status).toBe(409);
  expect((await tr()).agent.concat((await tr()).you)[0].read_only).toBe(true);
});

test('the tracker CLI prints the groups, and --mine, --claimed and --open narrow them', async () => {
  const a = await start('Alpha', 'a');
  await store.addChecklistItem(dir, a, { owner: 'user', text: 'user job', by: 'agent' });
  await store.addChecklistItem(dir, a, { owner: 'agent', text: 'agent job', by: 'agent' });
  await store.addChecklistItem(dir, a, { owner: 'agent', text: 'finished', by: 'agent' });
  await store.patchChecklistItem(dir, a, 'c3', { done: true }, 'agent');
  await store.patchChecklistItem(dir, a, 'c1', { claimed: true }, 'user');
  const all = await run(['tracker'], dir);
  expect(all).toContain('1 of 3 done, 1 claimed');
  expect(all).toMatch(/For you\n.*user job/);
  expect(all).toMatch(/For the agent\n.*agent job/);
  expect(all).toMatch(/Done recently\n.*finished/);
  expect(all).toContain('<Alpha>');
  const mine = await run(['tracker', '--mine'], dir);
  expect(mine).toContain('agent job');
  expect(mine).not.toContain('user job');
  const claimed = await run(['tracker', '--claimed'], dir);
  expect(claimed).toContain('user job');
  expect(claimed).not.toContain('agent job');
  const open = await run(['tracker', '--open'], dir);
  expect(open).not.toContain('finished');
  expect(await run(['tracker', '--claimed'], await mkdtemp(join(tmpdir(), 'feedback-empty-')))).toContain('Nothing matches');
});

test('tracker.js: filterRows and groupRows are pure', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  const row = (id: string, owner: string, extra: Record<string, unknown> = {}) => ({ thread: 't', title: 'T', read_only: false, item: { id, owner, text: `item ${id}`, done: false, created_at: '2026-11-10T00:00:00Z', ...extra } }) as never;
  const rows = [row('c1', 'user'), row('c2', 'agent'), row('c3', 'agent', { done: true, done_at: '2026-11-17T00:00:00Z' }), row('c4', 'agent', { done: true, done_at: '2026-10-01T00:00:00Z' })];
  const g = groupRows(rows, now);
  expect([g.you.length, g.agent.length, g.done_recent.length]).toEqual([1, 1, 1]);
  expect(filterRows(rows, { q: 'c3' }).length).toBe(1);
  expect(filterRows(rows, { state: 'done' }).length).toBe(2);
});

test('the inbox serves aside.js and tracker.js', async () => {
  for (const f of ['aside.js', 'tracker.js']) {
    const r = await handle(new Request(`http://local/__feedback/inbox/${f}`));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('javascript');
  }
});

test('transcript tolerates an orphan aside answer', () => {
  const out = transcript([{ id: 'm1', author: 'agent', text: 'lost', images: [], created_at: '2026-01-01T00:00:00Z', aside: true, reply_to: 'm9' }] as never);
  expect(out).toContain('Side question (orphan)');
});
