// biome-ignore-all lint/suspicious/noExplicitAny: the tests read loose tool JSON
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHandler } from './server';
import { run } from './cli';
import { createMcpServer } from './mcp';
import * as reminders from './reminders';
import * as store from './store';
import { presenceLines, relative } from './inbox/presence.js';

let dir: string, base: string, clock: number;
let handle: ReturnType<typeof createHandler>;
const T0 = Date.parse('2026-11-19T10:00:00.000Z');
const call = (method: string, path: string, data?: unknown, headers: Record<string, string> = {}) => handle(new Request(`http://local/__feedback/${path}`, { method, headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }));
const presence = async () => (await call('GET', 'api/presence')).json() as Promise<store.Presence>;
let notes: string[] = [];
const cli = (...args: string[]) => run(args, dir, undefined, {}, line => { notes.push(line); });
beforeEach(async () => {
  notes = [];
  base = await mkdtemp(join(tmpdir(), 'feedback-rf8-'));
  dir = join(base, 'data');
  await mkdir(dir, { recursive: true });
  clock = T0;
  handle = createHandler(dir, undefined, { now: () => clock });
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); });
const userFile = async () => JSON.parse(await readFile(join(dir, '_presence', 'user.json'), 'utf8'));

test('the user\'s last seen is written at most once a minute', async () => {
  expect((await store.readPresence(dir)).user).toBeNull(); // no data until the user shows up (the poll below is the user being here)
  await presence();
  const first = await userFile();
  expect(first.at).toBe(new Date(T0).toISOString());
  clock = T0 + 59e3; await call('GET', 'api/threads');
  expect((await userFile()).at).toBe(first.at); // 59 s later: not rewritten
  clock = T0 + 61e3; await call('GET', 'api/threads');
  expect((await userFile()).at).toBe(new Date(T0 + 61e3).toISOString());
  expect((await presence()).user).toEqual({ at: new Date(T0 + 61e3).toISOString() });
});
test('loading the page, polling and sending a message count as the user being here; the widget and the health check do not', async () => {
  await call('GET', 'healthz');
  await call('POST', 'api/items', { note: 'x' }).catch(() => {});
  expect(await readdir(dir)).not.toContain('_presence');
  await call('GET', 'inbox/');
  expect((await userFile()).at).toBe(new Date(T0).toISOString());
  await rm(join(dir, '_presence'), { recursive: true });
  const id = (await (await call('POST', 'api/threads', { title: 'T', text: 'hi' })).json()).id;
  expect(await readdir(join(dir, '_presence'))).toEqual(['user.json']);
  clock = T0 + 120e3; await call('POST', `api/threads/${id}/messages`, { text: 'again' });
  expect((await userFile()).at).toBe(new Date(T0 + 120e3).toISOString());
});
test('presence holds timestamps and an agent name only: no address, browser or thread', async () => {
  await call('GET', 'api/threads', undefined, { 'x-forwarded-for': '203.0.113.9', 'user-agent': 'SecretBrowser/1.0', cookie: 'a=b' });
  await cli('list');
  for (const f of await readdir(join(dir, '_presence'))) {
    const text = await readFile(join(dir, '_presence', f), 'utf8');
    expect(Object.keys(JSON.parse(text)).every(k => k === 'at' || k === 'name')).toBe(true);
    expect(text).not.toMatch(/203\.0|SecretBrowser|cookie/);
  }
});
test('the agent\'s last active moves on a reply, read, ack, tick, merge and reminder, and a CLI list', async () => {
  const a = await store.createThread(dir, { title: 'A', text: 'hello', origin: 'user' }), b = await store.createThread(dir, { title: 'B', text: 'hello', origin: 'user' });
  const agentAt = async () => (await store.readPresence(dir)).agents[0]?.at ?? null;
  expect(await agentAt()).toBeNull();
  const steps: [string, () => Promise<unknown>][] = [
    ['list', () => cli('list')], ['read', () => cli('read', a.id)], ['reply', () => cli('reply', a.id, 'hi', '--todo', 'ship')], ['tick', () => cli('todo', a.id, 'done', 'c1')],
    ['ack', () => cli('ack', a.id)], ['reminder', () => cli('remind', a.id, 'add', '--every', '2h', '--say', 'x')], ['merge', () => cli('merge', b.id, a.id)] ];
  for (const [name, step] of steps) {
    await rm(join(dir, '_presence'), { recursive: true, force: true });
    await step();
    const now = await agentAt();
    expect(now, name).not.toBeNull();
  }
});
test('agent writes are throttled to one every 5 s, and each agent name has its own entry', async () => {
  await store.touchPresence(dir, { agent: undefined }, T0);
  await store.touchPresence(dir, { agent: undefined }, T0 + 4e3);
  expect((await store.readPresence(dir)).agents).toEqual([{ name: null, at: new Date(T0).toISOString() }]);
  await store.touchPresence(dir, { agent: undefined }, T0 + 6e3);
  await store.touchPresence(dir, { agent: 'Codex' }, T0 + 7e3);
  const p = await store.readPresence(dir);
  expect(p.agents.map(a => a.name)).toEqual(['Codex', null]); // newest first
  expect(p.agents[1]!.at).toBe(new Date(T0 + 6e3).toISOString());
});
test('a broken or foreign file in _presence is ignored, and a failed write never throws', async () => {
  await mkdir(join(dir, '_presence'), { recursive: true });
  await Bun.write(join(dir, '_presence', 'user.json'), 'not json');
  await Bun.write(join(dir, '_presence', 'other.json'), JSON.stringify({ at: '2026-01-01T00:00:00Z' }));
  expect(await store.readPresence(dir)).toEqual({ user: null, agents: [] });
  await store.touchPresence('/nonexistent/\0/dir', 'user'); // no throw
});
test('the CLI sends presence through notice (stderr), never into the output, and leaves out the caller itself', async () => {
  const id = (await store.createThread(dir, { title: 'T', text: 'hello', origin: 'user' })).id;
  clock = Date.now(); await call('GET', 'api/threads');
  await store.touchPresence(dir, { agent: 'Codex' });
  const out = await cli('list');
  expect(out).toStartWith(id);
  expect(out).not.toMatch(/active|last seen/); // stdout is only the rows
  expect(notes).toEqual(['Codex · active just now', 'You · last seen just now']); // the unnamed CLI agent is the caller: not shown to itself
  notes = [];
  expect(await cli('read', id)).not.toMatch(/active|last seen/);
  expect(notes).toEqual(['Codex · active just now', 'You · last seen just now']);
  await rm(join(dir, '_presence'), { recursive: true });
  expect(await cli('list', '--waiting')).toBe(`${id}  agent  user   ${(await store.listThreads(dir))[0]!.last_message_at.slice(0, 16)}  T`);
  await store.setStatus(dir, id, 'done');
  expect(await cli('list', '--waiting')).toBe('Nothing is waiting for the agent.');
});
test('the CLI records its presence under FEEDBACK_AGENT_NAME, the same entry the MCP server of that name uses', async () => {
  await run(['list'], dir, undefined, { FEEDBACK_AGENT_NAME: 'Claude' }, () => {});
  expect((await store.readPresence(dir)).agents.map(a => a.name)).toEqual(['Claude']);
  const { tool, close } = await connect('Claude');
  const listed = await tool('list_threads');
  expect((await store.readPresence(dir)).agents.map(a => a.name)).toEqual(['Claude']); // one entry, not two
  expect(listed.presence.agents).toEqual([]); // the caller does not see itself
  await close();
});
test('presence is only written when the data folder already exists', async () => {
  const ghost = join(base, 'nope');
  await store.touchPresence(ghost, 'user');
  await run(['list'], ghost, undefined, {}, () => {}).catch(() => {});
  expect(await readdir(base)).not.toContain('nope');
});
test('the user\'s entry is found even when there are many agent files', async () => {
  await store.touchPresence(dir, 'user', T0);
  for (let i = 0; i < 30; i++) await store.touchPresence(dir, { agent: `Agent ${i}` }, T0);
  expect((await store.readPresence(dir)).user).toEqual({ at: new Date(T0).toISOString() });
});
async function connect(name?: string) {
  const server = createMcpServer({ dir, agentName: name, env: {} });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [x, y] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(x), client.connect(y)]);
  return { tool: async (n: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name: n, arguments: args })) as any).structuredContent, close: () => client.close() };
}
test('MCP: every tool call is activity under the agent\'s name, and list_threads and read_thread return presence', async () => {
  const id = (await store.createThread(dir, { title: 'T', text: 'hello', origin: 'user' })).id;
  await call('GET', 'api/threads');
  const { tool, close } = await connect('Codex');
  const listed = await tool('list_threads');
  expect(listed.presence.user.at).toBeString();
  expect(listed.presence.agents).toEqual([]); // Codex itself is not shown to Codex
  await store.touchPresence(dir, { agent: 'Claude' });
  const read = await tool('read_thread', { id });
  expect(read.presence.agents.map((a: any) => a.name)).toEqual(['Claude']);
  expect((await store.readPresence(dir)).agents.map(a => a.name).sort()).toEqual(['Claude', 'Codex']); // Codex's calls were recorded
  await tool('events_since'); // even a poll of the feed is the agent being here
  await close();
});
test('the presence lines: relative under an hour, the time after, nothing without data', () => {
  const now = T0, clock = (iso: string) => `T(${iso.slice(11, 16)})`;
  expect(relative(new Date(now - 10e3).toISOString(), now)).toBe('just now');
  expect(relative(new Date(now - 120e3).toISOString(), now)).toBe('2 min ago');
  expect(relative(new Date(now - 3599e3).toISOString(), now)).toBe('59 min ago');
  const p = { user: { at: new Date(now - 3600e3).toISOString() }, agents: [{ name: null, at: new Date(now - 120e3).toISOString() }, { name: 'Codex', at: new Date(now - 7200e3).toISOString() }] };
  expect(presenceLines(p, now, { agentName: 'Claude', clock }).map(l => l.text)).toEqual(['Claude · active 2 min ago', 'Codex · active T(08:00)', 'You · last seen T(09:00)']);
  expect(presenceLines({ user: null, agents: [] }, now, { clock })).toEqual([]);
  expect(presenceLines(null, now, { clock })).toEqual([]);
  // each viewer sees the other side only
  expect(presenceLines(p, now, { agentName: 'Claude', clock, viewer: 'user' }).map(l => l.text)).toEqual(['Claude · active 2 min ago', 'Codex · active T(08:00)']);
  expect(presenceLines(p, now, { agentName: 'Claude', clock, viewer: { agent: 'Codex' } }).map(l => l.text)).toEqual(['Claude · active 2 min ago', 'You · last seen T(09:00)']);
  expect(presenceLines(p, now, { agentName: 'Claude', clock, viewer: { agent: undefined } }).map(l => l.text)).toEqual(['Codex · active T(08:00)', 'You · last seen T(09:00)']);
});
test('fired reminders stay in the stored list and the reminders API (the sheet reads them) and in the agent\'s event', async () => {
  const id = (await store.createThread(dir, { title: 'T', text: 'hello', origin: 'user' })).id;
  await reminders.addReminder(dir, id, { kind: 'idle', value: '1m', say: 'Is it done?', by: 'user' });
  await reminders.fireThread(dir, id, { now: Date.now() + 5 * 60e3, armedAt: 0 });
  expect(((await (await call('GET', `api/threads/${id}/reminders`)).json()) as any).fired.map((f: any) => f.text)).toEqual(['Is it done?']);
  const events = (await readFile(join(dir, '_events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  expect(events.some(e => e.kind === 'reminder' && e.author === 'system')).toBe(true);
});
