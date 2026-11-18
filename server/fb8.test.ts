import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from './server';
import { run } from './cli';
import * as store from './store';
import { computeMetrics, duration, percentile, stats } from './metrics';

let dir: string;
let handle: ReturnType<typeof createHandler>;
const call = (method: string, path: string, data?: unknown) => handle(new Request(`http://local/__feedback/api/${path}`, {
  method, ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) }));
const get = async (path: string) => (await call('GET', path)).json();
const start = async (title = 'T') => (await (await call('POST', 'threads', { title, text: 'hello' })).json()).id as string;
const summary = async (id: string) => (await get('threads')).find((x: { id: string }) => x.id === id);
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'feedback-fb8-')); handle = createHandler(dir); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

// A thread written by hand, so every time is exact. Messages are [author, ISO time, flag?].
const NOW = new Date('2026-11-18T12:00:00.000Z');
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3600e3).toISOString();
async function seed(id: string, o: { title?: string; mode?: string; url?: string; created?: string; status?: string; messages: [string, string, string?][]; readOnly?: boolean; closedAt?: string }) {
  const path = join(dir, id);
  await mkdir(path, { recursive: true });
  const created = o.created ?? o.messages[0]?.[1] ?? NOW.toISOString();
  const item = o.mode === 'thread' || !o.mode
    ? { id, created_at: created, mode: 'thread', title: o.title ?? id, origin: 'user', note: 'n', ...(o.readOnly ? { read_only: true } : {}) }
    : { id, created_at: created, mode: o.mode, note: 'n', context: { url: o.url ?? '/' }, image: 'image.png' };
  await writeFile(join(path, 'item.json'), JSON.stringify(item));
  await writeFile(join(path, 'status.json'), JSON.stringify({ status: o.status ?? 'open' }));
  if (o.closedAt) await utimes(join(path, 'status.json'), new Date(o.closedAt), new Date(o.closedAt));
  await writeFile(join(path, 'thread.jsonl'), o.messages.map(([author, ts, flag], i) => `${JSON.stringify({ id: `m${i + 1}`, author, text: `t${i}`, images: [], created_at: ts, ...(flag ? { flag } : {}) })}\n`).join(''));
}
const MIN = 60e3;
const t = (hoursAgo: number, plusMin = 0) => new Date(Date.parse(at(hoursAgo)) + plusMin * MIN).toISOString();

// ---- the maths
test('percentiles interpolate between ranks; median of an even count is the middle pair', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  expect(percentile(hundred, 50)).toBe(50.5);
  expect(percentile(hundred, 99)).toBeCloseTo(99.01, 5);
  expect(percentile(hundred, 90)).toBeCloseTo(90.1, 5);
  expect(stats([5, 1, 3]).median).toBe(3);
  expect(stats([10, 20])).toMatchObject({ count: 2, median: 15, mean: 15, p90: 19, p99: 19.9 });
  expect(stats([7])).toEqual({ count: 1, median: 7, mean: 7, p90: 7, p99: 7 });
});
test('no samples gives nulls, not NaN', () => {
  expect(stats([])).toEqual({ count: 0, median: null, mean: null, p90: null, p99: null });
  expect(duration(null)).toBe('-');
  expect(duration(45e3)).toBe('45s');
  expect(duration(5 * MIN)).toBe('5m');
  expect(duration(200 * MIN)).toBe('3h 20m');
  expect(duration(3 * 86400e3 + 4 * 3600e3)).toBe('3d 4h');
});

// ---- the windows and the response times
test('response times: a run counts from its first message to the other side\'s next one, dated by the answer', async () => {
  await seed('20261118-100000-aaaa', { title: 'A', messages: [['user', t(30)], ['user', t(30, 5)], ['agent', t(30, 10)], ['user', t(29)]] });
  // user at -30h, user -29h55, agent -29h50 (10 minutes after the first user message of the run), user -29h
  const all = await computeMetrics(dir, 'all', NOW);
  expect(all.response.agent.count).toBe(1);
  expect(all.response.agent.median).toBe(10 * MIN);
  // agent at -29h50 then user at -29h: 50 minutes
  expect(all.response.user.count).toBe(1);
  expect(all.response.user.median).toBe(50 * MIN);
});

test('the window keeps only responses that arrived inside it', async () => {
  // old thread: agent answered 60 min after the user, 40 hours ago. recent thread: agent answered 30 min after, 2 hours ago.
  await seed('20261116-200000-aaaa', { messages: [['user', t(41)], ['agent', t(41, 60)]] });
  await seed('20261118-090000-bbbb', { messages: [['user', t(2, -30)], ['agent', t(2)]] });
  const day = await computeMetrics(dir, '24h', NOW);
  expect(day.response.agent).toMatchObject({ count: 1, median: 30 * MIN });
  const week = await computeMetrics(dir, '7d', NOW);
  expect(week.response.agent).toMatchObject({ count: 2, median: 45 * MIN, mean: 45 * MIN, p99: 59.7 * MIN });
  const everything = await computeMetrics(dir, 'all', NOW);
  expect(everything.response.agent.count).toBe(2);
  expect(day.since).toBe(at(24));
  expect(everything.since).toBeNull();
  // messages are counted inside the window too
  expect(day.velocity.messages).toEqual({ user: 1, agent: 1 });
  expect(week.velocity.messages).toEqual({ user: 2, agent: 2 });
});

test('an empty folder, an empty thread and a thread with one message do not break anything', async () => {
  const empty = await computeMetrics(join(dir, 'missing'), '7d', NOW);
  expect(empty.response.agent.median).toBeNull();
  expect(empty.workload).toMatchObject({ threads: 0, open: 0, oldest_waiting: null, checklist: { open: 0, claimed: 0, ticked: 0 } });
  expect(empty.areas).toEqual([]);
  expect(empty.velocity.per_hour).toHaveLength(24);
  await seed('20261118-100000-aaaa', { messages: [] });
  await seed('20261118-100001-aaab', { messages: [['user', t(1)]] });
  const m = await computeMetrics(dir, 'all', NOW);
  expect(m.workload.threads).toBe(2);
  expect(m.response.agent).toMatchObject({ count: 0, median: null, p99: null });
  expect(m.response.user.count).toBe(0);
  expect(m.events).toEqual({ count: 0, by_kind: {}, last_at: null });
});

test('velocity: messages by day and hour, threads opened and closed', async () => {
  await seed('20261117-100000-aaaa', { created: t(26), status: 'done', closedAt: t(3), messages: [['user', t(26)], ['agent', t(25.5)], ['user', t(25)]] });
  await seed('20261118-110000-bbbb', { created: t(0.5), messages: [['user', t(0.5)], ['agent', t(0.25)]] });
  const m = await computeMetrics(dir, '7d', NOW);
  const byDay = Object.fromEntries(m.velocity.per_day.map(d => [d.day, d]));
  expect(byDay['2026-11-17']).toMatchObject({ user: 2, agent: 1, opened: 1, closed: 0 });
  expect(byDay['2026-11-18']).toMatchObject({ user: 1, agent: 1, opened: 1, closed: 1 });
  expect(m.velocity.per_day[0]!.day).toBe('2026-11-11'); // seven days back, then every day to today
  expect(m.velocity.per_day.at(-1)!.day).toBe('2026-11-18');
  expect(m.velocity.opened).toBe(2);
  expect(m.velocity.closed).toBe(1);
  const hours = m.velocity.per_hour;
  expect(hours.at(-1)!.hour).toBe('2026-11-18T12:00:00Z');
  expect(hours.find(h => h.hour === '2026-11-18T11:00:00Z')).toMatchObject({ user: 1, agent: 1 });
  expect(hours.reduce((a, h) => a + h.user + h.agent, 0)).toBe(2); // the three messages from 25 hours ago and earlier are outside the 24 hours
});

// ---- workload and areas
test('workload and areas: open, waiting, the oldest waiting thread, checklist counts, merged and read-only threads', async () => {
  await seed('20261118-080000-aaaa', { title: 'Home one', mode: 'element', url: '/', messages: [['user', t(4)], ['user', t(3.5)]] }); // waits for the agent since -4h
  await seed('20261118-080001-aaab', { title: 'Billing one', mode: 'element', url: '/billing/x', messages: [['user', t(6)], ['agent', t(5), 'needs_you']] }); // waits on you since -5h
  await seed('20261118-080002-aaac', { title: 'Projects', mode: 'element', url: '/projects/p1', status: 'done', messages: [['user', t(9)], ['agent', t(8), 'done']] });
  await seed('20261118-080003-aaad', { title: 'Talk', messages: [['user', t(2)], ['agent', t(1), 'fyi']] });
  await seed('20261118-080004-aaae', { title: 'Updates', readOnly: true, messages: [['agent', t(1)], ['agent', t(0.5), 'needs_you']] });
  const id = '20261118-080001-aaab';
  await store.addChecklistItem(dir, id, { owner: 'agent', text: 'one', by: 'agent' });
  await store.addChecklistItem(dir, id, { owner: 'agent', text: 'two', by: 'agent' });
  await store.addChecklistItem(dir, id, { owner: 'user', text: 'three', by: 'agent' });
  await store.patchChecklistItem(dir, id, 'c2', { done: true }, 'agent');
  await store.patchChecklistItem(dir, id, 'c1', { claimed: true }, 'user');
  const m = await computeMetrics(dir, 'all', NOW);
  expect(m.workload).toMatchObject({ threads: 5, open: 4, waiting_agent: 1, waiting_you: 1, read_only: 1 });
  expect(m.workload.checklist).toEqual({ open: 1, claimed: 1, ticked: 1 });
  expect(m.workload.oldest_waiting).toMatchObject({ id, waiting: 'you', since: t(5), age_ms: 5 * 3600e3 });
  const area = Object.fromEntries(m.areas.map(a => [a.area, a]));
  expect(m.areas.map(a => a.area)).toEqual(['home', 'billing', 'projects', 'conversations']);
  expect(area.home).toMatchObject({ threads: 1, open: 1, waiting_agent: 1, waiting_you: 0, messages_user: 2, messages_agent: 0 });
  expect(area.billing).toMatchObject({ threads: 1, waiting_you: 1 });
  expect(area.projects).toMatchObject({ threads: 1, open: 0 });
  expect(area.conversations).toMatchObject({ threads: 2, open: 2, waiting_agent: 0, waiting_you: 0 });
  expect(area.projects.agent_response.median).toBe(3600e3);
  // a read-only thread gives no user response samples; the others give: billing 0 (user first), none for user
  expect(m.response.user.count).toBe(0);
});

test('the waiting age of a thread the agent owes starts at the first message of the user\'s last run', async () => {
  await seed('20261118-080000-aaaa', { messages: [['user', t(10)], ['agent', t(9)], ['user', t(5)], ['user', t(4)], ['user', t(3)]] });
  const m = await computeMetrics(dir, 'all', NOW);
  expect(m.workload.oldest_waiting).toMatchObject({ waiting: 'agent', since: t(5) });
});

test('a merged-away thread is left out, so its copied messages are not counted twice', async () => {
  const a = await start('A'), b = await start('B');
  await run(['reply', a, 'ok'], dir);
  await store.mergeThreads(dir, a, b, 'user');
  const m = await computeMetrics(dir, 'all');
  expect(m.workload.threads).toBe(1);
  const into = await store.summarise(dir, b);
  expect(m.velocity.messages.user + m.velocity.messages.agent).toBe(into.messages.filter(x => !x.divider).length);
});

test('events by kind come from _events.jsonl and follow the window', async () => {
  await writeFile(join(dir, '_events.jsonl'), [
    { ts: t(1), kind: 'message' }, { ts: t(2), kind: 'message' }, { ts: t(3), kind: 'checklist_claim' }, { ts: t(100), kind: 'thread' }].map(e => `${JSON.stringify(e)}\n`).join('') + 'not json\n');
  const day = await computeMetrics(dir, '24h', NOW);
  expect(day.events).toEqual({ count: 3, by_kind: { message: 2, checklist_claim: 1 }, last_at: t(1) });
  expect((await computeMetrics(dir, 'all', NOW)).events.count).toBe(4);
});

// ---- the endpoint and the CLI
test('GET /api/metrics answers with the window, and refuses an unknown one', async () => {
  await start('A');
  const body = await get('metrics?window=24h');
  expect(body.window).toBe('24h');
  expect(body.workload.threads).toBe(1);
  expect(body.velocity.per_hour).toHaveLength(24);
  expect((await get('metrics')).window).toBe('7d');
  expect((await call('GET', 'metrics?window=1y')).status).toBe(400);
  for (const w of ['toString', '__proto__', 'constructor']) expect((await call('GET', `metrics?window=${w}`)).status).toBe(400);
  expect((await handle(new Request('http://local/__feedback/inbox/constructor'))).status).toBe(404);
  expect((await call('POST', 'metrics', {})).status).toBe(404);
});

test('CLI metrics prints the numbers, takes --window, and refuses a bad one', async () => {
  const id = await start('A');
  await run(['reply', id, 'hi'], dir);
  const out = await run(['metrics'], dir);
  expect(out).toContain('Window: last 7 days');
  expect(out).toContain('Response times');
  expect(out).toContain('open threads 1 of 1');
  expect(await run(['metrics', '--window', 'all'], dir)).toContain('all time');
  expect(await run(['metrics', '--window', '24h'], dir)).toContain('last 24 hours');
  await expect(run(['metrics', '--window', 'month'], dir)).rejects.toThrow('window must be');
  await expect(run(['metrics', '--window', 'toString'], dir)).rejects.toThrow('window must be');
});

// ---- read-only threads
test('a read-only thread: the agent starts it, the user cannot post, and it never waits for anyone', async () => {
  const out = await run(['new', 'Status', 'what I am doing', '--read-only'], dir);
  const id = out.replace('Started ', '').replace(' (read-only)', '');
  expect(out).toContain('(read-only)');
  let s = await summary(id);
  expect(s).toMatchObject({ read_only: true, waiting: 'idle', unread_for_user: true, status: 'open' });
  const detail = await get(`threads/${id}`);
  expect(detail.read_only).toBe(true);
  // a plain agent message is still an unread update; a needs_you one does not make it wait on the user
  await run(['reply', id, 'more', '--needs-you'], dir);
  expect(await summary(id)).toMatchObject({ waiting: 'idle', unread_for_user: true });
  // the user's messages and answers are refused with a 409 and a friendly note
  const refused = await call('POST', `threads/${id}/messages`, { text: 'hi' });
  expect(refused.status).toBe(409);
  expect((await refused.json()).detail).toContain('read-only');
  await expect(store.appendMessage(dir, id, { author: 'user', text: 'hi' })).rejects.toThrow('read-only');
  // reading clears the unread mark
  await call('POST', `threads/${id}/read`, {});
  expect(await summary(id)).toMatchObject({ unread_for_user: false, waiting: 'idle' });
  // the user can still close it, and the agent can still post
  await call('POST', `threads/${id}/status`, { status: 'done' });
  expect((await summary(id)).waiting).toBe('done');
  await Bun.sleep(3);
  await run(['reply', id, 'later'], dir);
  expect(await summary(id)).toMatchObject({ unread_for_user: true });
  // the user's own messages (none were stored) never reached the thread
  const lines = (await readFile(join(dir, id, 'thread.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  expect(lines.every((l: { author: string }) => l.author === 'agent')).toBe(true);
  s = await summary(id);
  expect(s.read_only).toBe(true);
});

test('readonly on|off switches an existing thread, and nothing user-written is lost', async () => {
  const id = await start('Chat');
  expect(await run(['readonly', id, 'on'], dir)).toContain('now read-only');
  expect(await summary(id)).toMatchObject({ read_only: true, waiting: 'idle' }); // the user spoke last, but a read-only thread waits for nobody
  expect((await call('POST', `threads/${id}/messages`, { text: 'x' })).status).toBe(409);
  await run(['readonly', id, 'off'], dir);
  expect(await summary(id)).toMatchObject({ read_only: false, waiting: 'agent' });
  expect((await call('POST', `threads/${id}/messages`, { text: 'x' })).status).toBe(201);
  const item = JSON.parse(await readFile(join(dir, id, 'item.json'), 'utf8'));
  expect(item.read_only).toBeUndefined();
  expect(item.title).toBe('Chat');
  await expect(run(['readonly', id, 'maybe'], dir)).rejects.toThrow('Usage');
});

test('only the agent can start a read-only thread; it cannot hold a question; nothing merges into one', async () => {
  await expect(store.createThread(dir, { title: 'x', text: 'y', origin: 'user', readOnly: true })).rejects.toThrow('Only the agent');
  await expect(store.createThread(dir, { title: 'x', text: 'y', origin: 'agent', readOnly: true, question: { prompt: 'q', options: [{ label: 'a' }] } })).rejects.toThrow('cannot hold a question');
  const { id } = await store.createThread(dir, { title: 'ro', text: 'y', origin: 'agent', readOnly: true });
  const other = await start('B');
  await expect(store.mergeThreads(dir, other, id, 'user')).rejects.toThrow('read-only');
  // the server never lets the user set it
  const made = await (await call('POST', 'threads', { title: 'x', text: 'y', read_only: true })).json();
  expect((await summary(made.id)).read_only).toBe(false);
});

// ---- acknowledging
test('ack clears Waiting for agent without a message, shows read, and a later user message waits again', async () => {
  const id = await start();
  expect((await summary(id)).waiting).toBe('agent');
  expect(await run(['ack', id], dir)).toContain('Acknowledged');
  const s = await summary(id);
  expect(s).toMatchObject({ waiting: 'idle', last_author: 'user' });
  expect(s.acked_through).toBeTruthy();
  const d = await get(`threads/${id}`);
  expect(d.messages).toHaveLength(1); // no reply was written
  expect(d.agent_read_at >= d.messages[0].created_at).toBe(true); // two ticks
  expect(d.acked_through).toBe(d.messages[0].created_at);
  await Bun.sleep(3);
  await call('POST', `threads/${id}/messages`, { text: 'one more' });
  expect((await summary(id)).waiting).toBe('agent');
  await run(['ack', id], dir);
  expect((await summary(id)).waiting).toBe('idle');
  // acking twice changes nothing
  const before = JSON.parse(await readFile(join(dir, id, 'agent-read.json'), 'utf8'));
  await run(['ack', id], dir);
  expect(JSON.parse(await readFile(join(dir, id, 'agent-read.json'), 'utf8'))).toEqual(before);
});

test('ack survives a later read or reply, and does not hide a claimed item or log an event', async () => {
  const id = await start();
  await run(['ack', id], dir);
  await Bun.sleep(3);
  await call('POST', `threads/${id}/messages`, { text: 'again' });
  await run(['read', id], dir); // moves the read time on, and must keep the acknowledgement
  expect(JSON.parse(await readFile(join(dir, id, 'agent-read.json'), 'utf8')).acked_through).toBeTruthy();
  expect((await summary(id)).waiting).toBe('agent'); // the new message is not covered by the old ack
  await Bun.sleep(3);
  await run(['reply', id, 'fine'], dir);
  expect(JSON.parse(await readFile(join(dir, id, 'agent-read.json'), 'utf8')).acked_through).toBeTruthy();
  await store.addChecklistItem(dir, id, { owner: 'user', text: 'do it', by: 'agent' });
  await call('PATCH', `threads/${id}/checklist/c1`, { claimed: true });
  await run(['ack', id], dir);
  expect((await summary(id)).waiting).toBe('agent'); // the claim still waits for the agent's check
  const events = (await readFile(join(dir, '_events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  expect(events.every((e: { author: string }) => e.author === 'user')).toBe(true);
  expect(events.filter((e: { kind: string }) => e.kind === 'thread')).toHaveLength(1);
});

test('ack needs a user message to acknowledge', async () => {
  const { id } = await store.createThread(dir, { title: 'Agent talks', text: 'hello', origin: 'agent' });
  await expect(run(['ack', id], dir)).rejects.toThrow('no message from the user');
  await expect(run(['ack', '20200101-000000-aaaa'], dir)).rejects.toThrow('Not found');
});

test('on a read-only thread the user cannot touch the checklist, and the agent cannot ask a question', async () => {
  const { id } = await store.createThread(dir, { title: 'ro', text: 'y', origin: 'agent', readOnly: true });
  await run(['todo', id, 'add', 'agent', 'agent item'], dir); // the agent still can
  expect((await call('POST', `threads/${id}/checklist`, { owner: 'user', text: 'x' })).status).toBe(409);
  expect((await call('PATCH', `threads/${id}/checklist/c1`, { claimed: true })).status).toBe(409);
  expect((await call('DELETE', `threads/${id}/checklist/c1`)).status).toBe(409);
  expect((await get(`threads/${id}/checklist`)).items).toHaveLength(1);
  expect((await summary(id)).checklist.claimed).toBe(0);
  await run(['todo', id, 'done', 'c1'], dir);
  await expect(run(['ask', id, 'which?', '--option', 'a'], dir)).rejects.toThrow('read-only');
  await run(['readonly', id, 'off'], dir);
  expect((await call('POST', `threads/${id}/checklist`, { owner: 'user', text: 'x' })).status).toBe(201);
});
