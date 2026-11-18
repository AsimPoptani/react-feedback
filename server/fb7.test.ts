import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from './server';
import { run } from './cli';
import * as store from './store';

let dir: string;
let handle: ReturnType<typeof createHandler>;
const call = (method: string, path: string, data?: unknown) => handle(new Request(`http://local/__feedback/api/${path}`, {
  method, ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) }));
const get = async (path: string) => (await call('GET', path)).json();
const events = async () => (await readFile(join(dir, '_events.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));
const start = async (title = 'T') => (await (await call('POST', 'threads', { title, text: 'hello' })).json()).id as string;
const add = async (id: string, owner: string, text: string) => (await call('POST', `threads/${id}/checklist`, { owner, text })).json();
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'feedback-fb7-')); handle = createHandler(dir); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

// ---- flags
test('agent messages carry a flag: fyi by default, set by the CLI, needs_you for questions, never set by the user', async () => {
  const id = await start();
  await run(['reply', id, 'plain'], dir);
  await run(['reply', id, 'look', '--needs-you'], dir);
  await run(['reply', id, 'shipped', '--done'], dir);
  await run(['ask', id, 'which?', '--option', 'a'], dir);
  const t = await get(`threads/${id}`);
  expect(t.messages.map((m: { flag?: string }) => m.flag)).toEqual([undefined, 'fyi', 'needs_you', 'done', 'needs_you']);
  expect(t.last_flag).toBe('needs_you');
  await expect(run(['reply', id, 'x', '--fyi', '--done'], dir)).rejects.toThrow('only one');
  await expect(store.appendMessage(dir, id, { author: 'agent', text: 'x', flag: 'loud' })).rejects.toThrow('flag must be');
  await expect(store.appendMessage(dir, id, { author: 'user', text: 'x', flag: 'needs_you' })).rejects.toThrow('Only the agent');
  // the HTTP route ignores any flag a user sends: the field is not read
  const m = await (await call('POST', `threads/${id}/messages`, { text: 'hi', flag: 'done' })).json();
  expect(m.flag).toBeUndefined();
  // an old stored agent message with no flag reads as fyi, and an old question as needs_you
  const lines = (await readFile(join(dir, id, 'thread.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  expect(lines[1].flag).toBe('fyi');
  const fromNew = await run(['new', 'Idea', 'text', '--needs-you'], dir);
  expect((await get(`threads/${fromNew.replace('Started ', '')}`)).last_flag).toBe('needs_you');
});

test('only needs_you and unanswered questions make a thread unread or waiting on you; fyi and done never do', async () => {
  const id = await start();
  const sum = async () => (await get('threads')).find((x: { id: string }) => x.id === id);
  await run(['reply', id, 'note'], dir);
  expect(await sum()).toMatchObject({ unread_for_user: false, waiting: 'idle', last_flag: 'fyi' });
  await Bun.sleep(3);
  await run(['reply', id, 'need', '--needs-you'], dir);
  expect(await sum()).toMatchObject({ unread_for_user: true, waiting: 'you' });
  await Bun.sleep(3);
  await run(['reply', id, 'later fyi'], dir); // an fyi after a needs_you does not clear it
  expect(await sum()).toMatchObject({ unread_for_user: true, waiting: 'you' });
  await call('POST', `threads/${id}/read`, {});
  expect(await sum()).toMatchObject({ unread_for_user: false, waiting: 'you' });
  await call('POST', `threads/${id}/messages`, { text: 'ok' });
  expect(await sum()).toMatchObject({ waiting: 'agent' });
  await run(['reply', id, 'fine'], dir);
  expect(await sum()).toMatchObject({ waiting: 'idle', unread_for_user: false });
});

test('a done message closes the thread unless the user has open items; a user message reopens it', async () => {
  const id = await start();
  expect(await run(['reply', id, 'all done', '--done'], dir)).toContain('thread closed');
  expect((await get(`threads/${id}`)).status).toBe('done');
  await call('POST', `threads/${id}/messages`, { text: 'one more' });
  expect((await get(`threads/${id}`)).status).toBe('open');
  const item = await add(id, 'user', 'send me the file');
  expect(await run(['reply', id, 'done again', '--done'], dir)).toContain('left open');
  expect((await get(`threads/${id}`)).status).toBe('open');
  // a claimed-but-unchecked item still blocks it; ticking the item lets it close
  await call('PATCH', `threads/${id}/checklist/${item.id}`, { claimed: true });
  expect(await run(['reply', id, 'again', '--done'], dir)).toContain('left open');
  await run(['todo', id, 'done', item.id], dir);
  expect(await run(['reply', id, 'now', '--done'], dir)).toContain('thread closed');
  expect((await get(`threads/${id}`)).status).toBe('done');
  // a thread started with --done and nothing open is born closed
  const born = (await run(['new', 'Report', 'finished', '--done'], dir)).replace('Started ', '');
  expect((await get(`threads/${born}`)).status).toBe('done');
});

// ---- checklist
test('checklist round trip through the server and the CLI', async () => {
  const id = await start();
  expect(await get(`threads/${id}/checklist`)).toEqual({ items: [] });
  const a = await add(id, 'agent', '  write the doc ');
  expect(a).toMatchObject({ id: 'c1', owner: 'agent', text: 'write the doc', done: false, created_by: 'user' });
  expect(await run(['todo', id, 'add', 'user', 'pick a colour'], dir)).toContain('c2');
  const out = await run(['todo', id, 'list'], dir);
  expect(out).toContain('c1'); expect(out).toContain('pick a colour');
  const detail = await get(`threads/${id}`);
  expect(detail.checklist_items.map((i: { id: string }) => i.id)).toEqual(['c1', 'c2']);
  expect(detail.checklist).toEqual({ total: 2, done: 0, claimed: 0 });
  expect(detail.open_for_you).toBe(1);
  const edited = await (await call('PATCH', `threads/${id}/checklist/c1`, { text: 'write the docs' })).json();
  expect(edited.text).toBe('write the docs');
  await run(['todo', id, 'check', 'c1'], dir);
  const done = (await get(`threads/${id}/checklist`)).items[0];
  expect(done).toMatchObject({ done: true, done_by: 'agent' }); expect(typeof done.done_at).toBe('string');
  expect((await get(`threads/${id}`)).checklist).toEqual({ total: 2, done: 1, claimed: 0 });
  await run(['todo', id, 'uncheck', 'c1'], dir);
  expect((await get(`threads/${id}/checklist`)).items[0].done).toBe(false);
  expect((await call('DELETE', `threads/${id}/checklist/c1`)).status).toBe(200); // the user made it
  expect((await get(`threads/${id}/checklist`)).items.map((i: { id: string }) => i.id)).toEqual(['c2']);
  await run(['todo', id, 'add', 'agent', 'again'], dir);
  expect((await get(`threads/${id}/checklist`)).items.map((i: { id: string }) => i.id)).toEqual(['c2', 'c3']); // ids never reuse the highest
  expect(await run(['todo', id, 'edit', 'c3', 'again, better'], dir)).toContain('again, better');
  expect(await run(['todo', id, 'rm', 'c3'], dir)).toBe('Removed c3');
  expect((await call('GET', 'threads/20260101-000000-abcd/checklist')).status).toBe(404);
  expect((await call('PATCH', `threads/${id}/checklist/c9`, { text: 'x' })).status).toBe(404);
});

test('only the agent ticks: the server refuses done from the inbox, and the user may claim instead', async () => {
  const id = await start();
  await add(id, 'user', 'send me the logo');
  await add(id, 'agent', 'draw the logo');
  for (const done of [true, false]) {
    const r = await call('PATCH', `threads/${id}/checklist/c1`, { done });
    expect(r.status).toBe(403);
    expect((await r.json()).detail).toContain('Only the agent');
  }
  expect((await get(`threads/${id}/checklist`)).items[0].done).toBe(false);
  const before = (await events()).length;
  const claimed = await (await call('PATCH', `threads/${id}/checklist/c1`, { claimed: true })).json();
  expect(typeof claimed.claimed_by_user_at).toBe('string'); expect(claimed.done).toBe(false);
  const last = (await events()).slice(before);
  expect(last).toHaveLength(1);
  expect(last[0]).toMatchObject({ id, author: 'user', kind: 'checklist_claim' });
  // the claim shows in the counts and in `todos --claimed`; it does not count as done
  expect((await get(`threads/${id}`)).checklist).toEqual({ total: 2, done: 0, claimed: 1 });
  expect(await run(['todos', '--claimed'], dir)).toContain('send me the logo');
  expect(await run(['todos', '--claimed'], dir)).not.toContain('draw the logo');
  expect((await get(`threads/${id}`)).waiting).toBe('agent'); // the move is the agent's
  // the agent unclaims with a note; a note is required
  await expect(run(['todo', id, 'unclaim', 'c1'], dir)).rejects.toThrow();
  await expect(store.patchChecklistItem(dir, id, 'c1', { claimed: false }, 'agent')).rejects.toThrow('needs a note');
  await run(['todo', id, 'unclaim', 'c1', 'the file is empty'], dir);
  const after = (await get(`threads/${id}/checklist`)).items[0];
  expect(after.claimed_by_user_at).toBeUndefined();
  expect(after.unclaim_note).toBe('the file is empty');
  expect(await run(['todos', '--claimed'], dir)).toBe('Nothing is waiting for your check.');
  // claim again, then withdraw it yourself; a done item cannot be claimed
  await call('PATCH', `threads/${id}/checklist/c1`, { claimed: true });
  expect((await get(`threads/${id}/checklist`)).items[0].unclaim_note).toBeUndefined();
  await call('PATCH', `threads/${id}/checklist/c1`, { claimed: false });
  expect((await get(`threads/${id}/checklist`)).items[0].claimed_by_user_at).toBeUndefined();
  await run(['todo', id, 'done', 'c1'], dir);
  expect((await call('PATCH', `threads/${id}/checklist/c1`, { claimed: true })).status).toBe(409);
  // claiming works on the agent's list too
  expect((await call('PATCH', `threads/${id}/checklist/c2`, { claimed: true })).status).toBe(200);
});

test('the user edits and deletes only what they added; the agent can change anything', async () => {
  const id = await start();
  await run(['todo', id, 'add', 'agent', 'the agent wrote this'], dir);
  await add(id, 'agent', 'the user wrote this');
  expect((await call('PATCH', `threads/${id}/checklist/c1`, { text: 'hijack' })).status).toBe(403);
  expect((await call('DELETE', `threads/${id}/checklist/c1`)).status).toBe(403);
  expect((await call('PATCH', `threads/${id}/checklist/c2`, { text: 'mine, edited' })).status).toBe(200);
  expect(await run(['todo', id, 'edit', 'c2', 'agent edit'], dir)).toContain('agent edit');
  await run(['todo', id, 'rm', 'c2'], dir);
  expect((await get(`threads/${id}/checklist`)).items.map((i: { id: string }) => i.id)).toEqual(['c1']);
});

test('checklist validation: text length, item cap, owner, empty patch, bad types', async () => {
  const id = await start();
  expect((await call('POST', `threads/${id}/checklist`, { owner: 'agent', text: 'x'.repeat(301) })).status).toBe(400);
  expect((await call('POST', `threads/${id}/checklist`, { owner: 'agent', text: '   ' })).status).toBe(400);
  expect((await call('POST', `threads/${id}/checklist`, { owner: 'robot', text: 'x' })).status).toBe(400);
  expect((await call('POST', `threads/${id}/checklist`, { owner: 'agent', text: 'x'.repeat(300) })).status).toBe(201);
  expect((await call('PATCH', `threads/${id}/checklist/c1`, {})).status).toBe(400);
  expect((await call('PATCH', `threads/${id}/checklist/c1`, { claimed: 'yes' })).status).toBe(400);
  expect((await call('PATCH', `threads/${id}/checklist/c1`, { text: 'y'.repeat(301) })).status).toBe(400);
  for (let i = 1; i < store.MAX_ITEMS; i++) await store.addChecklistItem(dir, id, { owner: 'agent', text: `i${i}`, by: 'agent' });
  const over = await call('POST', `threads/${id}/checklist`, { owner: 'user', text: 'one too many' });
  expect(over.status).toBe(400);
  expect((await over.json()).detail).toContain('at most 50');
  expect((await get(`threads/${id}/checklist`)).items).toHaveLength(50);
});

test('checklist writes are atomic and concurrent adds keep unique ids', async () => {
  const id = await start();
  await Promise.all(Array.from({ length: 12 }, (_, i) => call('POST', `threads/${id}/checklist`, { owner: i % 2 ? 'user' : 'agent', text: `item ${i}` })));
  const ids = (await get(`threads/${id}/checklist`)).items.map((i: { id: string }) => i.id);
  expect(new Set(ids).size).toBe(12);
  const files = await readdir(join(dir, id));
  expect(files.filter(f => f.endsWith('.tmp'))).toEqual([]); // renamed into place, nothing left behind
  expect(JSON.parse(await readFile(join(dir, id, 'checklist.json'), 'utf8')).items).toHaveLength(12);
  // a torn or foreign checklist.json reads as empty rather than hiding the thread
  await Bun.write(join(dir, id, 'checklist.json'), '{not json');
  expect((await get(`threads/${id}`)).checklist).toEqual({ total: 0, done: 0, claimed: 0 });
  await store.writeAtomic(join(dir, 'x.json'), '1'); await store.writeAtomic(join(dir, 'x.json'), '2');
  expect(await readFile(join(dir, 'x.json'), 'utf8')).toBe('2');
});

test('every user checklist change logs an event; the agent does not', async () => {
  const id = await start();
  const before = (await events()).length;
  await add(id, 'agent', 'one');                                   // checklist
  await call('PATCH', `threads/${id}/checklist/c1`, { text: 'two' }); // checklist
  await call('PATCH', `threads/${id}/checklist/c1`, { claimed: true }); // checklist_claim
  await call('DELETE', `threads/${id}/checklist/c1`);               // checklist
  await run(['todo', id, 'add', 'agent', 'agent made'], dir);
  await run(['todo', id, 'done', 'c1'], dir);
  const kinds = (await events()).slice(before).map(e => e.kind);
  expect(kinds).toEqual(['checklist', 'checklist', 'checklist_claim', 'checklist']);
  expect((await events()).slice(before)[0].first_line).toContain('one');
});

test('open For-you items put a thread under Waiting on you until claimed; claimed items wait on the agent', async () => {
  const id = await start();
  await run(['reply', id, 'hello'], dir);
  const w = async () => (await get(`threads/${id}`)).waiting;
  expect(await w()).toBe('idle');
  await run(['todo', id, 'add', 'user', 'confirm the date'], dir);
  expect(await w()).toBe('you');
  expect((await get(`threads/${id}`)).open_for_you).toBe(1);
  await call('PATCH', `threads/${id}/checklist/c1`, { claimed: true });
  expect(await w()).toBe('agent');
  expect((await get(`threads/${id}`)).open_for_you).toBe(0);
  await run(['todo', id, 'check', 'c1'], dir);
  expect(await w()).toBe('idle');
  await run(['todo', id, 'add', 'agent', 'agent work'], dir); // the agent's own items do not ask anything of the user
  expect(await w()).toBe('idle');
});

test('todos --mine lists open agent items across threads; --claimed lists claims; the CLI rejects bad calls', async () => {
  const a = await start('First'), b = await start('Second');
  await run(['todo', a, 'add', 'agent', 'fix spacing'], dir);
  await run(['todo', b, 'add', 'agent', 'write notes'], dir);
  await run(['todo', b, 'add', 'user', 'your task'], dir);
  await run(['todo', a, 'done', 'c1'], dir);
  const mine = await run(['todos', '--mine'], dir);
  expect(mine).toContain('write notes'); expect(mine).not.toContain('fix spacing'); expect(mine).not.toContain('your task');
  expect(await run(['todos'], dir)).toContain('your task');
  await call('PATCH', `threads/${b}/checklist/c2`, { claimed: true });
  expect(await run(['todos', '--claimed'], dir)).toContain(`${b}`);
  await expect(run(['todo', a, 'add', 'robot', 'x'], dir)).rejects.toThrow('owner');
  await expect(run(['todo', a, 'done'], dir)).rejects.toThrow('Usage');
  await expect(run(['todo', a, 'done', 'c99'], dir)).rejects.toThrow('No such item');
  await expect(run(['todo', 'nope', 'list'], dir)).rejects.toThrow();
  expect(await run(['todos', '--mine'], await mkdtemp(join(tmpdir(), 'fb7-empty-')))).toBe('No open items for the agent.');
});

// ---- pins
test('pins: toggle threads and areas, persisted server-side in _profile/pins.json, validated', async () => {
  const id = await start();
  expect(await get('pins')).toEqual({ threads: [], areas: [] });
  expect(await (await call('POST', 'pins', { kind: 'thread', id })).json()).toEqual({ threads: [id], areas: [] }); // omitted pinned toggles
  expect(await (await call('POST', 'pins', { kind: 'area', id: 'ops', pinned: true })).json()).toEqual({ threads: [id], areas: ['ops'] });
  await call('POST', 'pins', { kind: 'area', id: 'ops', pinned: true }); // idempotent
  expect((await get('pins')).areas).toEqual(['ops']);
  const disk = JSON.parse(await readFile(join(dir, '_profile', 'pins.json'), 'utf8'));
  expect(disk).toEqual({ threads: [id], areas: ['ops'] });
  // a new handler (a reload, or another device) sees the same pins
  expect(await (await createHandler(dir)(new Request('http://local/__feedback/api/pins'))).json()).toEqual(disk);
  expect(await (await call('POST', 'pins', { kind: 'thread', id, pinned: false })).json()).toEqual({ threads: [], areas: ['ops'] });
  for (const bad of [{ kind: 'thread', id: 'nope' }, { kind: 'area', id: 'Not An Area!' }, { kind: 'cat', id }, { kind: 'thread', id, pinned: 'yes' }, {}]) {
    expect((await call('POST', 'pins', bad)).status).toBe(400);
  }
  expect((await readdir(join(dir, '_profile'))).filter(f => f.endsWith('.tmp'))).toEqual([]);
});

test('concurrent pin changes are not lost', async () => {
  const ids = await Promise.all(Array.from({ length: 6 }, (_, i) => start(`T${i}`)));
  await Promise.all(ids.map(id => call('POST', 'pins', { kind: 'thread', id, pinned: true })));
  expect((await get('pins')).threads.sort()).toEqual([...ids].sort());
  await Bun.write(join(dir, '_profile', 'pins.json'), 'garbage');
  expect(await get('pins')).toEqual({ threads: [], areas: [] }); // a torn file reads as no pins
});

// ---- merge
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(8)]);
test('merge: messages copied in order with their authors and times, images renumbered, source done with a link, checklist and pins moved', async () => {
  const from = (await (await call('POST', 'threads', { title: 'Dup', text: 'first', images: [`data:image/png;base64,${PNG.toString('base64')}`] })).json()).id as string;
  await Bun.sleep(3);
  const into = await start('Main');
  await call('POST', `threads/${into}/messages`, { text: 'target msg', images: [`data:image/png;base64,${PNG.toString('base64')}`] });
  await run(['reply', from, 'agent says'], dir);
  await run(['ask', from, 'pick?', '--option', 'a'], dir);
  await call('POST', `threads/${from}/answer`, { question_id: 'q3', option_ids: ['o1'] });
  await add(from, 'user', 'moving item'); await add(into, 'agent', 'stays');
  await call('POST', 'pins', { kind: 'thread', id: from });
  const srcBefore = (await get(`threads/${from}`)).messages;
  const before = (await events()).length;
  expect(await (await call('POST', `threads/${from}/merge`, { into })).json()).toEqual({ merged: true, into });
  const t = await get(`threads/${into}`);
  const texts = t.messages.map((m: { text: string }) => m.text);
  expect(texts.slice(0, 2)).toEqual(['hello', 'target msg']);
  expect(t.messages[2]).toMatchObject({ divider: true, text: 'Merged from: Dup' });
  const copied = t.messages.slice(3);
  expect(copied.map((m: { author: string; text: string; created_at: string }) => [m.author, m.text, m.created_at]))
    .toEqual(srcBefore.map((m: { author: string; text: string; created_at: string }) => [m.author, m.text, m.created_at]));
  expect(copied[0].images).toEqual(['msg-2.png']); // msg-1 was the target's own
  expect((await handle(new Request(`http://local/__feedback/api/items/${into}/msg-2.png`))).status).toBe(200);
  expect(copied[2].question.id).toBe('q6'); expect(copied[3].answer.question_id).toBe('q6'); // renumbered: it was q3 in the source
  expect(new Set(t.messages.map((m: { id: string }) => m.id)).size).toBe(t.messages.length);
  const s = await get(`threads/${from}`);
  expect(s.status).toBe('done'); expect(s.merged_into).toBe(into); expect(s.waiting).toBe('done');
  const last = s.messages[s.messages.length - 1];
  expect(last).toMatchObject({ author: 'agent', flag: 'done', text: `Merged into [Main](#/${into})` });
  expect(srcBefore.length).toBeGreaterThan(0);
  expect((await get(`threads/${from}`)).messages.slice(0, srcBefore.length).map((m: { text: string }) => m.text)).toEqual(srcBefore.map((m: { text: string }) => m.text)); // still readable
  expect((await get(`threads/${into}/checklist`)).items.map((i: { id: string; text: string }) => [i.id, i.text])).toEqual([['c1', 'stays'], ['c2', 'moving item']]);
  expect((await get(`threads/${from}/checklist`)).items).toEqual([]);
  expect(await get('pins')).toEqual({ threads: [into], areas: [] });
  const merged = (await events()).slice(before);
  expect(merged).toHaveLength(1); expect(merged[0]).toMatchObject({ kind: 'merge', author: 'user', id: into });
});

test('merge is idempotent, refuses self, chains and unknown threads, and the CLI merges without an event', async () => {
  const a = await start('A'), b = await start('B'), c = await start('C');
  expect(await run(['merge', a, b], dir)).toBe(`Merged ${a} into ${b}`);
  const count = (await get(`threads/${b}`)).messages.length;
  const ev = (await events()).length;
  expect(await run(['merge', a, b], dir)).toContain('already merged');
  expect((await get(`threads/${b}`)).messages.length).toBe(count);
  expect((await call('POST', `threads/${a}/merge`, { into: b })).status).toBe(200);
  expect((await get(`threads/${b}`)).messages.length).toBe(count);
  expect((await events()).length).toBe(ev); // the CLI is the agent: no event; a no-op logs none either
  await expect(run(['merge', a, c], dir)).rejects.toThrow('already merged');
  await expect(run(['merge', c, a], dir)).rejects.toThrow('itself merged');
  await expect(run(['merge', c, c], dir)).rejects.toThrow('itself');
  expect((await call('POST', `threads/${c}/merge`, { into: '20260101-000000-abcd' })).status).toBe(404);
  expect((await call('POST', `threads/${c}/merge`, { into: 5 })).status).toBe(404);
});

test('merge locks both threads in id order: opposite merges at once cannot deadlock', async () => {
  const a = await start('A'), b = await start('B');
  const results = await Promise.allSettled([store.mergeThreads(dir, a, b, 'user'), store.mergeThreads(dir, b, a, 'user')]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); // the loser sees a merged target
  expect((await readdir(join(dir, a))).includes('.lock')).toBe(false);
  expect((await readdir(join(dir, b))).includes('.lock')).toBe(false);
  // a lock held on either thread blocks the merge until it is released, then it goes through
  const x = await start('X'), y = await start('Y');
  await Bun.write(join(dir, y, '.lock'), 'held');
  let finished = false;
  const held = store.mergeThreads(dir, x, y, 'agent').then(r => { finished = true; return r; });
  await Bun.sleep(80);
  expect(finished).toBe(false);
  await rm(join(dir, y, '.lock'));
  expect((await held).merged).toBe(true);
  // concurrent appends to the target during a merge keep message ids unique
  const p = await start('P'), q = await start('Q');
  await Promise.all([store.mergeThreads(dir, p, q, 'agent'), call('POST', `threads/${q}/messages`, { text: 'during' }), call('POST', `threads/${q}/messages`, { text: 'during 2' })]);
  const ids = (await get(`threads/${q}`)).messages.map((m: { id: string }) => m.id);
  expect(new Set(ids).size).toBe(ids.length);
});

// ---- review fixes
test('a user message wins over an open For-you item, and a claim waits on the agent even with other items open', async () => {
  const id = await start();
  await run(['reply', id, 'ok'], dir);
  await run(['todo', id, 'add', 'user', 'send the screenshot'], dir);
  await run(['todo', id, 'add', 'user', 'another'], dir);
  const w = async () => (await get(`threads/${id}`)).waiting;
  expect(await w()).toBe('you');
  await Bun.sleep(3);
  await call('POST', `threads/${id}/messages`, { text: 'Where do I find it?' });
  expect(await w()).toBe('agent');
  expect(await run(['list', '--waiting'], dir)).toContain(id);
  await run(['reply', id, 'in the menu'], dir);
  expect(await w()).toBe('you'); // the open items ask again once the agent has answered
  await call('PATCH', `threads/${id}/checklist/c1`, { claimed: true });
  expect(await w()).toBe('agent'); // c2 is still open, but the claim is the agent's to check
  await run(['reply', id, 'needs a look', '--needs-you'], dir);
  await call('PATCH', `threads/${id}/checklist/c1`, { claimed: false });
  expect(await w()).toBe('you');
});

test('merging keeps an unanswered user message waiting for the agent until the agent speaks after the merge', async () => {
  // (a) target waiting for the agent, source tail is an agent message
  const old = await start('Old'); await run(['reply', old, 'looking'], dir);
  await Bun.sleep(5);
  const fresh = await start('New');
  expect((await get(`threads/${fresh}`)).waiting).toBe('agent');
  await store.mergeThreads(dir, old, fresh, 'user');
  expect((await get(`threads/${fresh}`)).waiting).toBe('agent');
  expect(await run(['list', '--waiting'], dir)).toContain(fresh);
  await Bun.sleep(5);
  await run(['reply', fresh, 'on it'], dir);
  expect((await get(`threads/${fresh}`)).waiting).toBe('idle'); // an agent message after the merge clears it
  // (b) target done, source's last message is an unanswered user message
  const target = await start('Target'); await run(['reply', target, 'fixed', '--done'], dir);
  expect((await get(`threads/${target}`)).status).toBe('done');
  await Bun.sleep(5);
  const src = await start('Src');
  await store.mergeThreads(dir, src, target, 'user');
  const t = await get(`threads/${target}`);
  expect(t.status).toBe('open'); expect(t.waiting).toBe('agent');
  expect((await get(`threads/${src}`)).status).toBe('done');
  expect(await run(['list', '--waiting'], dir)).toContain(target);
  // a merge of two quiet threads stays quiet, and last_message_at never moves back
  const q1 = await start('Q1'); await run(['reply', q1, 'a', '--done'], dir);
  const q2 = await start('Q2'); await run(['reply', q2, 'b'], dir); await run(['status', q2, 'done'], dir);
  const before = (await get(`threads/${q2}`)).last_message_at;
  await store.mergeThreads(dir, q1, q2, 'agent');
  expect((await get(`threads/${q2}`)).last_message_at >= before).toBe(true);
  expect((await get(`threads/${q2}`)).waiting).toBe('done');
});

test('an interrupted merge can be retried without duplicating messages, items or the farewell', async () => {
  const s = await start('S4');
  await run(['reply', s, 'agent line'], dir);
  await store.addChecklistItem(dir, s, { owner: 'user', text: 'x', by: 'user' });
  await Bun.sleep(5);
  const t = await start('T4');
  await Bun.write(join(dir, t, 'checklist.json', 'blocker'), 'x'); // a directory where the file belongs: the checklist step fails after the messages were copied
  await expect(store.mergeThreads(dir, s, t, 'agent')).rejects.toThrow();
  expect((await get(`threads/${s}`)).merged_into).toBeNull(); // not complete yet
  await rm(join(dir, t, 'checklist.json'), { recursive: true });
  expect((await store.mergeThreads(dir, s, t, 'agent')).merged).toBe(true);
  const texts = (await get(`threads/${t}`)).messages.map((m: { text: string }) => m.text);
  expect(texts).toEqual(['hello', 'Merged from: S4', 'hello', 'agent line']);
  expect((await get(`threads/${t}/checklist`)).items).toHaveLength(1);
  const src = (await get(`threads/${s}`)).messages.map((m: { text: string }) => m.text);
  expect(src.filter((x: string) => x.startsWith('Merged into'))).toHaveLength(1);
  expect((await get(`threads/${s}`)).merged_into).toBe(t);
  expect((await store.mergeThreads(dir, s, t, 'agent')).merged).toBe(false);
});

test('a thread the agent starts defaults to needs_you', async () => {
  const id = (await run(['new', 'Hey', 'look at this'], dir)).replace('Started ', '');
  expect((await get(`threads/${id}`)).last_flag).toBe('needs_you');
  const quiet = (await run(['new', 'Hey2', 'fyi', '--fyi'], dir)).replace('Started ', '');
  expect((await get(`threads/${quiet}`)).last_flag).toBe('fyi');
});
