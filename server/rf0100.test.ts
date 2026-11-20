// 0.10: feedback on shared pages, and session replay (opt-in per link, the viewer is told and can opt out).
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHandler } from './server';
import { run } from './cli';
import { createMcpServer } from './mcp';
import { publishArtifact } from './artifacts';
import { createShare, readShares } from './shares';
import { cleanupReplays, listReplays, REPLAY_MAX_BYTES, REPLAY_MAX_MS } from './replay';
import { loadReplayDays } from './config';
import { computeMetrics } from './metrics';
import * as store from './store';

let dir: string;
let handle: ReturnType<typeof createHandler>;
let clock = Date.parse('2026-11-20T12:00:00.000Z');
const SESSION = 'AbCdEfGhIjKlMnOpQrStUvWx';
const api = (path: string, data?: unknown, method?: string) => new Request(`http://local/__feedback/${path}`, data === undefined && !method ? {} : { method: method ?? 'POST', headers: { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
const viewer = (token: string, what: 'feedback' | 'replay', data: unknown, init: { type?: string; ua?: string; ip?: string; method?: string } = {}) => handle(new Request(`http://local/__feedback/s/${token}/${what}`, {
  method: init.method ?? 'POST', headers: { 'Content-Type': init.type ?? 'text/plain', 'User-Agent': init.ua ?? 'ViewerAgent/9.9', 'X-Forwarded-For': init.ip ?? '203.0.113.7' }, ...((init.method ?? 'POST') === 'POST' ? { body: typeof data === 'string' ? data : JSON.stringify(data) } : {}) }));
const textOf = (path: string) => handle(new Request(`http://local${path}`));
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'feedback-0100-'));
  clock = Date.parse('2026-11-20T12:00:00.000Z');
  handle = createHandler(dir, undefined, { now: () => clock });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function setup(page = '<!doctype html><html><head><title>Options</title></head><body><button id="go">Go</button><p>Pick one</p></body></html>') {
  const { id } = await store.createThread(dir, { title: 'Options', text: 'Here are the options', origin: 'agent' });
  const art = await publishArtifact(dir, { thread: id, title: 'Options', content: page, format: 'html' });
  return { thread: id, art };
}
async function link(art: string, body: Record<string, unknown> = {}) {
  const created = await (await handle(api(`api/artifacts/${art}/share`, { expires: 'none', ...body }))).json() as { id: string; url: string; record: boolean };
  return { ...created, token: created.url.split('/').pop()! };
}
const click = (t: number, x = 40, y = 20) => ({ type: 3, timestamp: t, data: { source: 2, type: 2, id: 7, x, y } });
const meta = (t: number, w = 800, h = 600) => ({ type: 4, timestamp: t, data: { href: 'about:srcdoc', width: w, height: h } });
const snap = (t: number) => ({ type: 2, timestamp: t, data: { node: { id: 1, type: 0, childNodes: [] }, initialOffset: { left: 0, top: 0 } } });
const missShape = async (response: Response) => ({ status: response.status, body: await response.text(), headers: [...response.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]).sort() });

test('the share link serves a trusted shell: the sandboxed artifact, a Feedback button, no inbox chrome, and the same sandbox header as before', async () => {
  const { art } = await setup();
  const { token } = await link(art.id);
  const response = await textOf(`/__feedback/s/${token}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-security-policy')).toBe('sandbox allow-scripts allow-popups');
  expect(response.headers.get('x-robots-tag')).toBe('noindex');
  expect(response.headers.get('set-cookie')).toBeNull();
  const html = await response.text();
  expect(html).toContain('<iframe id="art" sandbox="allow-scripts allow-popups"');
  expect(html).toContain('Pick one');
  expect(html).toContain('id="fb-open">Feedback<');
  expect(html).not.toContain('/__feedback/api');
  expect(html).not.toContain('/__feedback/inbox');
  expect(html).not.toContain('allow-same-origin');
  expect(html).not.toContain('RFRecorder'); // recording is off: the recorder is not in the page
  expect(html).toContain('{"record":false}');
  expect(JSON.parse(await readFile(join(dir, '_shares.json'), 'utf8')).shares[0].views).toBe(1);
});

test('recording is off by default, and only the owner can switch it on: the recorder is injected only for a link with the switch on', async () => {
  const { art } = await setup();
  const off = await link(art.id);
  const on = await link(art.id, { expires: 'none', record: true });
  expect(off.record).toBe(false);
  expect(on.record).toBe(true);
  const offHtml = await (await textOf(`/__feedback/s/${off.token}`)).text();
  const onHtml = await (await textOf(`/__feedback/s/${on.token}`)).text();
  expect(offHtml).not.toContain('RFRecorder');
  expect(onHtml).toContain('RFRecorder');
  expect(onHtml).toContain('{"record":true}');
  expect(onHtml).toContain('This page records clicks and mouse movement to help the author.');
  expect(onHtml).toContain("Don't record");
  expect(onHtml).toContain('maskAllInputs'); // the bundled recorder masks inputs
  expect(onHtml).toContain('data-rf-private');
  // The inbox viewer page and the plain artifact URL never carry the recorder.
  const plain = await textOf(`/__feedback/a/${art.id}/v1`);
  expect(await plain.text()).not.toContain('RFRecorder');
  expect(plain.headers.get('content-security-policy')).toBe('sandbox allow-scripts allow-popups');
  // The owner can flip it per link; a bad body is refused.
  const flipped = await (await handle(api(`api/shares/${off.id}/record`, { on: true }))).json() as { record: boolean };
  expect(flipped.record).toBe(true);
  expect(await (await textOf(`/__feedback/s/${off.token}`)).text()).toContain('RFRecorder');
  expect((await handle(api(`api/shares/${off.id}/record`, { on: 'yes' }))).status).toBe(400);
  expect((await handle(api('api/shares/s00000000/record', { on: true }))).status).toBe(404);
  await handle(api(`api/shares/${off.id}/record`, { on: false }));
  expect(await (await textOf(`/__feedback/s/${off.token}`)).text()).not.toContain('RFRecorder');
});

test('an agent cannot enable recording: not through the library, the CLI or MCP', async () => {
  const { art } = await setup();
  const made = await createShare(dir, { artifact: art.id, expires: '7d', by: 'Scout', agent: true, record: true });
  expect(made.share.record).toBeUndefined();
  await expect(run(['artifact', 'share', art.id, '--record'], dir, undefined, { FEEDBACK_AGENT_NAME: 'Scout' })).rejects.toThrow(/cannot turn it on/);
  const server = createMcpServer({ dir, agentName: 'Scout', env: {} });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  for (const tool of (await client.listTools()).tools) expect(JSON.stringify(tool.inputSchema)).not.toMatch(/record/i);
  const result = await client.callTool({ name: 'share_artifact', arguments: { artifact: art.id, id: art.id, record: true } }) as { isError?: boolean };
  const stored = (await readShares(dir)).filter(share => share.created_by === 'Scout');
  expect(stored.every(share => share.record !== true)).toBe(true);
  expect(typeof result).toBe('object');
  await client.close();
});

test('viewer feedback lands in the artifact thread, flagged for you, with what they pointed at, and stores no address or user agent', async () => {
  const { thread, art } = await setup();
  const { id, token } = await link(art.id);
  const sent = await viewer(token, 'feedback', { note: 'This button is hard to find', quote: { text: 'Go', path: 'body > button#go', box: [0.1, 0.2, 0.3, 0.05] } }, { ua: 'SecretBrowser/7', ip: '198.51.100.23' });
  expect(sent.status).toBe(201);
  expect(sent.headers.get('access-control-allow-origin')).toBe('*');
  expect(await sent.json()).toEqual({ ok: true });
  const { summary, messages } = await store.summarise(dir, thread);
  const note = messages.find(m => m.author === 'viewer')!;
  expect(note.text).toBe('This button is hard to find');
  expect(note.flag).toBe('needs_you');
  expect(note.kind).toBe('viewer_feedback');
  expect(note.label).toContain('Options');
  expect(note.label).toContain(id);
  expect(note.quote).toEqual({ text: 'Go', path: 'body > button#go', box: [0.1, 0.2, 0.3, 0.05] });
  expect(summary.waiting).toBe('you');
  expect(summary.unread_for_user).toBe(true);
  expect(summary.last_author).toBe('agent');
  const raw = [await readFile(join(dir, thread, 'thread.jsonl'), 'utf8'), await readFile(join(dir, '_shares.json'), 'utf8'), await readFile(join(dir, '_events.jsonl'), 'utf8')].join('\n');
  expect(raw).not.toContain('SecretBrowser');
  expect(raw).not.toContain('198.51.100.23');
  expect(raw).not.toContain('203.0.113.7');
  // The inbox sees a per-link count; the thread detail carries the message.
  const listed = await (await handle(api('api/shares'))).json() as { id: string; feedback: number; record: boolean }[];
  expect(listed.find(row => row.id === id)!.feedback).toBe(1);
  const detail = await (await handle(api(`api/threads/${thread}`))).json() as { messages: { author: string }[] };
  expect(detail.messages.some(m => m.author === 'viewer')).toBe(true);
  // Answering clears the wait; the viewer's note is neither side of the conversation in the metrics.
  await handle(api(`api/threads/${thread}/messages`, { text: 'Thanks, fixing it' }));
  expect((await store.summarise(dir, thread)).summary.waiting).toBe('agent');
  const metrics = await computeMetrics(dir, 'all', new Date(clock + 864e5));
  expect(metrics.velocity.messages.user).toBe(1);
  // An agent reading the thread sees it as the viewer's, as data.
  expect(await run(['read', thread], dir)).toContain('viewer feedback');
});

test('feedback and replay endpoints: a bad, revoked or expired token is the same 404 as an unknown page, and there is no read path', async () => {
  const { art } = await setup();
  const live = await link(art.id, { expires: '1d', record: true });
  const revoked = await link(art.id, { record: true });
  await handle(api(`api/shares/${revoked.id}/revoke`, {}));
  const unknown = await missShape(await textOf('/__feedback/s/not-a-real-token-at-all'));
  for (const what of ['feedback', 'replay'] as const) {
    expect(await missShape(await viewer('not-a-real-token-at-all', what, { note: 'x' }))).toEqual(unknown);
    expect(await missShape(await viewer(revoked.token, what, { note: 'x' }))).toEqual(unknown);
    // Nothing is readable, whatever the method.
    for (const method of ['GET', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH']) expect(await missShape(await viewer(live.token, what, '', { method }))).toEqual(unknown);
  }
  clock += 2 * 864e5;
  for (const what of ['feedback', 'replay'] as const) expect(await missShape(await viewer(live.token, what, { note: 'x' }))).toEqual(unknown);
  await expect(stat(join(dir, '_replays'))).rejects.toThrow();
  // A path that is not exactly the token and one action is not a route.
  expect((await textOf(`/__feedback/s/${live.token}/feedback/extra`)).status).toBe(404);
  expect((await textOf(`/__feedback/s/${live.token}/replays`)).status).toBe(404);
});

test('feedback: the note is capped, the type is checked, and a link is rate limited per minute and per day', async () => {
  const { thread, art } = await setup();
  const { token } = await link(art.id);
  // Every call counts against the limits, so each check below starts a minute later.
  const later = () => { clock += 61e3; };
  expect((await viewer(token, 'feedback', { note: 'x'.repeat(4001) })).status).toBe(400); later();
  expect((await viewer(token, 'feedback', { note: '   ' })).status).toBe(400); later();
  expect((await viewer(token, 'feedback', { note: 5 })).status).toBe(400); later();
  expect((await viewer(token, 'feedback', 'not json')).status).toBe(400); later();
  expect((await viewer(token, 'feedback', { note: 'hi' }, { type: 'application/x-www-form-urlencoded' })).status).toBe(415); later();
  expect((await viewer(token, 'feedback', { note: 'x'.repeat(4000) }, { type: 'application/json' })).status).toBe(201); later();
  expect((await viewer(token, 'feedback', { note: 'z'.repeat(20000) })).status).toBe(413); later();
  // 5 a minute for one link (none sent in this minute yet).
  for (let i = 0; i < 5; i++) expect((await viewer(token, 'feedback', { note: `n${i}` }, { ip: `192.0.2.${i}` })).status).toBe(201);
  expect((await viewer(token, 'feedback', { note: 'too many' }, { ip: '192.0.2.99' })).status).toBe(429);
  clock += 61e3;
  expect((await viewer(token, 'feedback', { note: 'later' }, { ip: '192.0.2.50' })).status).toBe(201);
  // One caller is limited across links too: 5 a minute.
  const other = await link(art.id);
  for (let i = 0; i < 4; i++) await viewer(other.token, 'feedback', { note: `c${i}` }, { ip: '198.51.100.1' });
  expect((await viewer(other.token, 'feedback', { note: 'c3' }, { ip: '198.51.100.1' })).status).toBe(201);
  expect((await viewer(other.token, 'feedback', { note: 'c4' }, { ip: '198.51.100.1' })).status).toBe(429);
  // 50 a day for a link.
  const day = await link(art.id);
  let sent = 0;
  for (let i = 0; i < 12 && sent < 50; i++) { clock += 61e3; for (let j = 0; j < 5; j++) { if ((await viewer(day.token, 'feedback', { note: `d${sent}` }, { ip: `10.0.${i}.${j}` })).status === 201) sent++; } }
  expect(sent).toBe(50);
  clock += 61e3;
  expect((await viewer(day.token, 'feedback', { note: 'one more' }, { ip: '10.9.9.9' })).status).toBe(429);
  expect((await store.summarise(dir, thread)).messages.filter(m => m.author === 'viewer').length).toBeGreaterThan(50);
});

test('replay uploads are refused when recording is off for the link, and nothing is written', async () => {
  const { art } = await setup();
  const { token } = await link(art.id);
  const refused = await viewer(token, 'replay', { session: SESSION, seq: 0, events: [snap(1000)] });
  expect(refused.status).toBe(403);
  expect(await refused.json()).toEqual({ kind: 'recording_off' });
  await expect(stat(join(dir, '_replays'))).rejects.toThrow();
});

test('replays: chunks are stored compressed with metadata and no address or user agent; retries do not double; the owner lists, plays and deletes them', async () => {
  const { art } = await setup();
  const { id, token } = await link(art.id, { expires: 'none', record: true });
  const t0 = 1_700_000_000_000;
  const first = await viewer(token, 'replay', { session: SESSION, seq: 0, events: [meta(t0), snap(t0 + 1), click(t0 + 500, 100, 40), { type: 3, timestamp: t0 + 600, data: { source: 1, positions: [] } }] }, { ua: 'SecretBrowser/7', ip: '198.51.100.23' });
  expect(first.status).toBe(200);
  expect(first.headers.get('access-control-allow-origin')).toBe('*');
  const again = await viewer(token, 'replay', { session: SESSION, seq: 0, events: [meta(t0), snap(t0 + 1)] });
  expect(again.status).toBe(200); // a retry of a chunk that arrived is acknowledged and ignored
  expect((await viewer(token, 'replay', { session: SESSION, seq: 2, events: [click(t0 + 900)] })).status).toBe(409);
  expect((await viewer(token, 'replay', { session: SESSION, seq: 1, events: [click(t0 + 1500, 700, 90), click(t0 + 2500)] })).status).toBe(200);
  const folder = join(dir, '_replays', art.id);
  expect((await readdir(folder)).filter(name => !name.startsWith('.')).sort()).toEqual([`${SESSION}.json`, `${SESSION}.jsonl.gz`]);
  const lines = gunzipSync(await readFile(join(folder, `${SESSION}.jsonl.gz`))).toString('utf8').trim().split('\n');
  expect(lines.length).toBe(6);
  const stored = JSON.parse(await readFile(join(folder, `${SESSION}.json`), 'utf8')) as Record<string, unknown>;
  expect(stored).toMatchObject({ session: SESSION, scope: art.id, link: id, version: 1, clicks: 3, events: 6, seq: 1, duration_ms: 2500, viewport: { w: 800, h: 600 } });
  const everything = (await readFile(join(folder, `${SESSION}.json`), 'utf8')) + gunzipSync(await readFile(join(folder, `${SESSION}.jsonl.gz`))).toString('utf8');
  for (const forbidden of ['SecretBrowser', '198.51.100.23', '203.0.113.7']) expect(everything).not.toContain(forbidden);
  // The owner's side.
  const list = await (await handle(api(`api/artifacts/${art.id}/replays`))).json() as { session: string; clicks: number; duration_ms: number; version: number; link: string }[];
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ session: SESSION, clicks: 3, duration_ms: 2500, version: 1, link: id });
  const played = await (await handle(api(`api/artifacts/${art.id}/replays/${SESSION}`))).json() as { events: { type: number }[] };
  expect(played.events).toHaveLength(6);
  const heat = await (await handle(api(`api/artifacts/${art.id}/heatmap?version=1`))).json() as { sessions: number; clicks: { x: number; y: number }[] };
  expect(heat.sessions).toBe(1);
  expect(heat.clicks).toHaveLength(3);
  expect(heat.clicks[0]).toEqual({ x: 0.125, y: 0.05 });
  expect((await (await handle(api(`api/artifacts/${art.id}/heatmap?version=2`))).json() as { sessions: number }).sessions).toBe(0);
  // Revoking the link stops new recordings; what exists stays until deleted.
  await handle(api(`api/shares/${id}/revoke`, {}));
  expect((await viewer(token, 'replay', { session: SESSION, seq: 2, events: [click(t0 + 3000)] })).status).toBe(404);
  expect(await listReplays(dir, art.id)).toHaveLength(1);
  expect((await handle(api(`api/artifacts/${art.id}/replays/${SESSION}`, undefined, 'DELETE'))).status).toBe(200);
  expect(await listReplays(dir, art.id)).toHaveLength(0);
  expect((await handle(api(`api/artifacts/${art.id}/replays/${SESSION}`, undefined, 'DELETE'))).status).toBe(404);
});

test('replay caps: a session is at most 5 MB and 30 minutes, events must look like events, and one session id belongs to one link', async () => {
  const { art } = await setup();
  const one = await link(art.id, { expires: 'none', record: true });
  const two = await link(art.id, { expires: 'none', record: true });
  const t0 = 1_700_000_000_000;
  expect((await viewer(one.token, 'replay', { session: 'short', seq: 0, events: [snap(t0)] })).status).toBe(400);
  expect((await viewer(one.token, 'replay', { session: SESSION, seq: 0, events: [] })).status).toBe(400);
  expect((await viewer(one.token, 'replay', { session: SESSION, seq: 0, events: [{ type: 99, timestamp: t0 }] })).status).toBe(400);
  expect((await viewer(one.token, 'replay', { session: SESSION, seq: 0, events: [{ type: 3, timestamp: 'now' }] })).status).toBe(400);
  expect((await viewer(one.token, 'replay', { session: SESSION, seq: 0, events: ['x'] })).status).toBe(400);
  expect((await viewer(one.token, 'replay', { session: SESSION, seq: 0, events: [snap(t0)] })).status).toBe(200);
  expect((await viewer(two.token, 'replay', { session: SESSION, seq: 1, events: [snap(t0 + 1)] })).status).toBe(404);
  // Time: an event more than 30 minutes after the first is refused.
  expect((await viewer(one.token, 'replay', { session: SESSION, seq: 1, events: [click(t0 + REPLAY_MAX_MS + 1)] })).status).toBe(413);
  expect((await viewer(one.token, 'replay', { session: SESSION, seq: 1, events: [click(t0 + REPLAY_MAX_MS)] })).status).toBe(200);
  // Size: chunks beyond 5 MB of events are refused.
  const filler = (t: number) => ({ type: 5, timestamp: t, data: { tag: 'x', payload: 'y'.repeat(900_000) } });
  let seq = 2, accepted = 0, status = 200;
  while (status === 200 && accepted < 10) { status = (await viewer(one.token, 'replay', { session: SESSION, seq, events: [filler(t0 + 10 + seq)] })).status; if (status === 200) { seq++; accepted++; } }
  expect(status).toBe(413);
  expect(accepted).toBeLessThanOrEqual(Math.floor(REPLAY_MAX_BYTES / 900_000));
  const [row] = await listReplays(dir, art.id);
  expect(row!.bytes).toBeLessThanOrEqual(REPLAY_MAX_BYTES);
  // A body far past the cap is refused before it is parsed.
  expect((await viewer(two.token, 'replay', { session: 'ZyXwVuTsRqPoNmLkJiHgFeDc', seq: 0, events: [filler(t0)], pad: 'z'.repeat(7 * 1024 * 1024) })).status).toBe(413);
});

test('replay chunk and session rates are limited per link', async () => {
  const { art } = await setup();
  const { token } = await link(art.id, { expires: 'none', record: true });
  const t0 = 1_700_000_000_000;
  let last = 200;
  for (let i = 0; i < 125 && last === 200; i++) last = (await viewer(token, 'replay', { session: SESSION, seq: i, events: [click(t0 + i)] })).status;
  expect(last).toBe(429);
  const sessions = await link(art.id, { expires: 'none', record: true });
  let refused = 0;
  for (let i = 0; i < 52; i++) {
    if (i % 30 === 29) clock += 61e3;
    const id = `Sess${String(i).padStart(20, '0')}`;
    if ((await viewer(sessions.token, 'replay', { session: id, seq: 0, events: [snap(t0)] }, { ip: `10.1.0.${i}` })).status === 429) refused++;
  }
  expect(refused).toBe(2);
});

test('retention: cleanup removes sessions older than the days kept, and FEEDBACK_REPLAY_DAYS is checked', async () => {
  const { art } = await setup();
  const { token } = await link(art.id, { expires: 'none', record: true });
  const t0 = 1_700_000_000_000;
  await viewer(token, 'replay', { session: SESSION, seq: 0, events: [snap(t0)] });
  await viewer(token, 'replay', { session: 'Second0ldSessionIdHere01', seq: 0, events: [snap(t0)] });
  clock += 20 * 864e5;
  await viewer(token, 'replay', { session: 'FreshSessionIdNumber0001', seq: 0, events: [snap(t0)] });
  expect(await cleanupReplays(dir, 30, clock)).toBe(0);
  clock += 15 * 864e5;
  expect(await cleanupReplays(dir, 30, clock)).toBe(2);
  expect((await listReplays(dir, art.id)).map(row => row.session)).toEqual(['FreshSessionIdNumber0001']);
  expect(await cleanupReplays(dir, 30, clock)).toBe(0);
  expect(loadReplayDays({})).toBe(30);
  expect(loadReplayDays({ FEEDBACK_REPLAY_DAYS: '7' })).toBe(7);
  for (const bad of ['0', '-1', 'x', '1.5', '99999']) expect(() => loadReplayDays({ FEEDBACK_REPLAY_DAYS: bad })).toThrow(/FEEDBACK_REPLAY_DAYS/);
});

test('the inbox records itself only when its owner switches it on, and the sessions are listed under their own scope', async () => {
  const t0 = 1_700_000_000_000;
  expect(await (await handle(api('api/replay-settings'))).json()).toEqual({ record_inbox: false });
  const off = await handle(api('api/replays', { session: SESSION, seq: 0, events: [snap(t0)] }));
  expect(off.status).toBe(403);
  await expect(stat(join(dir, '_replays', '_inbox'))).rejects.toThrow();
  expect((await handle(api('api/replay-settings', { record_inbox: 'on' }))).status).toBe(400);
  expect(await (await handle(api('api/replay-settings', { record_inbox: true }))).json()).toEqual({ record_inbox: true });
  expect((await handle(api('api/replays', { session: SESSION, seq: 0, events: [meta(t0), click(t0 + 5)] }))).status).toBe(200);
  const list = await (await handle(api('api/replays'))).json() as { session: string; link: null; version: null; clicks: number }[];
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ session: SESSION, link: null, version: null, clicks: 1 });
  expect((await (await handle(api(`api/replays/${SESSION}`))).json() as { events: unknown[] }).events).toHaveLength(2);
  expect((await handle(api(`api/replays/${SESSION}`, undefined, 'DELETE'))).status).toBe(200);
  expect(await (await handle(api('api/replays'))).json()).toEqual([]);
  // The upload API is the inbox's: it needs JSON, like every inbox write.
  expect((await handle(new Request('http://local/__feedback/api/replays', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }))).status).toBe(415);
});

test('the recorder and the replay player are served by the package, not a CDN, and the player page has a strict CSP', async () => {
  const recorder = await textOf('/__feedback/replay/recorder.js');
  expect(recorder.status).toBe(200);
  expect(recorder.headers.get('content-type')).toContain('javascript');
  const code = await recorder.text();
  expect(code).toContain('RFRecorder');
  expect(code).not.toMatch(/https?:\/\/(cdn|unpkg|cdnjs|jsdelivr)/i);
  const page = await textOf('/__feedback/replay/player');
  const csp = page.headers.get('content-security-policy')!;
  expect(csp).toContain("script-src 'self';");
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("default-src 'none'");
  expect(await page.text()).toContain('player.js');
  expect((await textOf('/__feedback/replay/player.js')).status).toBe(200);
  expect((await textOf('/__feedback/replay/player.css')).headers.get('content-type')).toContain('css');
  expect((await textOf('/__feedback/replay/nope.js')).status).toBe(404);
  const shell = await (await textOf(`/__feedback/s/${(await link((await setup()).art.id, { expires: 'none', record: true })).token}`)).text();
  expect(shell).not.toMatch(/<script[^>]+src=/); // every script is inline: no CDN, no other origin
});

test('the shell only believes its own iframe, and the feedback helper only believes its parent', async () => {
  const { art } = await setup();
  const { token } = await link(art.id, { expires: 'none', record: true });
  const html = await (await textOf(`/__feedback/s/${token}`)).text();
  const plain = await (await textOf(`/__feedback/s/${(await link(art.id)).token}`)).text(); // without the bundled recorder, which has its own code
  const shell = html.slice(html.indexOf('<script>(function () {\n  var cfg'));
  expect(shell).toContain('event.source !== frame.contentWindow');
  expect(html).toContain('event.source !== parent'); // the helper and the recorder glue inside the page
  // The page never uses the parent's DOM, storage or cookies.
  expect(plain).not.toMatch(/parent\.(document|localStorage|sessionStorage|cookie)/);
});

test('metrics, the list and the transcript cope with a thread that holds only viewer notes', async () => {
  const { thread, art } = await setup();
  const { token } = await link(art.id);
  await viewer(token, 'feedback', { note: 'first' });
  expect((await store.listThreads(dir)).find(t => t.id === thread)!.waiting).toBe('you');
  expect(JSON.stringify(await computeMetrics(dir, 'all', new Date(clock + 1000)))).toContain('"velocity"');
});
