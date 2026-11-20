// 0.15: working together. Typing presence, capture routing, agent message checks, recommended options, split, reactions, promises, offline answers, and the remote listener's Host rules.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHandler } from './server';
import { run } from './cli';
import { createMcpServer } from './mcp';
import * as store from './store';
import { internalCodes, lintMessage, promisesIn } from './lint';
import { closestProject, loadProjects, matchProject, routesByUrl } from './projects';
import { Pairing } from './pair';
import { createRemoteHandler } from './remote';

let root: string, dir: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'feedback-rfmeta-')); dir = join(root, 'a'); await mkdir(dir); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const quiet = () => { const lines: string[] = []; return { lines, notice: (l: string) => { lines.push(l); } }; };
const cli = (args: string[], d = dir, env: Record<string, string | undefined> = {}) => { const n = quiet(); return run(args, d, undefined, env, n.notice).then(out => ({ out, lines: n.lines })); };
const post = (handle: ReturnType<typeof createHandler>, path: string, body: unknown) => handle(new Request(`http://local/__feedback/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
const get = (handle: ReturnType<typeof createHandler>, path: string) => handle(new Request(`http://local/__feedback/api/${path}`));

describe('typing presence', () => {
  test('a withdraw, merge, move and split refuse with 409 while the person is typing, and --force goes through', async () => {
    const a = (await store.createThread(dir, { title: 'One', text: 'hello', origin: 'agent' })).id;
    const b = (await store.createThread(dir, { title: 'Two', text: 'there', origin: 'agent' })).id;
    const asked = await store.appendMessage(dir, a, { author: 'agent', text: 'Which?', question: { prompt: 'Which?', options: [{ label: 'x' }] } });
    await store.setTyping(dir, a, true);
    const refused = async (fn: () => Promise<unknown>) => { try { await fn(); return null; } catch (e) { return e as store.Invalid; } };
    const cancel = await refused(() => store.cancelQuestion(dir, a, asked.question!.id));
    expect(cancel?.status).toBe(409); expect(cancel?.message).toBe('the person is typing here');
    expect((await refused(() => store.mergeThreads(dir, a, b, 'agent')))?.status).toBe(409);
    expect((await refused(() => store.mergeThreads(dir, b, a, 'agent')))?.status).toBe(409); // typing in the target counts too
    expect((await refused(() => store.moveMessages(dir, a, ['m1'], b)))?.status).toBe(409);
    expect((await refused(() => store.splitThread(dir, a, 'm1', 'Elsewhere')))?.status).toBe(409);
    expect(await store.isTyping(dir, b)).toBe(false);
    expect((await store.cancelQuestion(dir, a, asked.question!.id, undefined, { force: true })).withdrawn).toBe(true);
  });
  test('the marker lapses 15 seconds after the last ping, and typing:false clears it at once', async () => {
    const a = (await store.createThread(dir, { title: 'One', text: 'hello', origin: 'agent' })).id;
    await store.setTyping(dir, a, true, 1_000_000);
    expect(await store.isTyping(dir, a, 1_000_000 + 14_000)).toBe(true);
    expect(await store.isTyping(dir, a, 1_000_000 + 15_001)).toBe(false);
    await store.setTyping(dir, a, true, 2_000_000); await store.setTyping(dir, a, false, 2_000_100);
    expect(await store.isTyping(dir, a, 2_000_200)).toBe(false);
    expect(await readFile(join(dir, '_typing.json'), 'utf8')).not.toContain('hello'); // timestamps only
  });
  test('over HTTP: the inbox reports typing, an agent merge over MCP and the CLI are refused, and the inbox\'s own merge (force) is not', async () => {
    const handle = createHandler(dir);
    const a = (await store.createThread(dir, { title: 'One', text: 'hello', origin: 'agent' })).id;
    const b = (await store.createThread(dir, { title: 'Two', text: 'there', origin: 'agent' })).id;
    expect((await post(handle, `threads/${a}/typing`, { typing: 'yes' })).status).toBe(400);
    expect((await post(handle, `threads/${a}/typing`, { typing: true })).status).toBe(200);
    const merge = await post(handle, `threads/${a}/merge`, { into: b });
    expect(merge.status).toBe(409); expect((await merge.json()).detail).toBe('the person is typing here');
    await expect(cli(['merge', a, b])).rejects.toThrow('the person is typing here');
    const server = createMcpServer({ dir, env: {} }); const client = new Client({ name: 't', version: '1' });
    const [x, y] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(x), client.connect(y)]);
    const viaMcp = await client.callTool({ name: 'merge', arguments: { from: a, into: b } }) as { isError?: boolean; content: { text: string }[] };
    expect(viaMcp.isError).toBe(true); expect(viaMcp.content[0]!.text).toBe('the person is typing here');
    const read = await client.callTool({ name: 'read_thread', arguments: { id: a } }) as { structuredContent: { typing?: boolean } };
    expect(read.structuredContent.typing).toBe(true);
    expect((await post(handle, `threads/${a}/merge`, { into: b, force: true })).status).toBe(200);
    await client.close();
  });
  test('--force on the CLI', async () => {
    const a = (await store.createThread(dir, { title: 'One', text: 'hello', origin: 'agent' })).id;
    const b = (await store.createThread(dir, { title: 'Two', text: 'there', origin: 'agent' })).id;
    await store.setTyping(dir, a, true);
    expect((await cli(['merge', a, b, '--force'])).out).toContain('Merged');
  });
});

describe('capture routing', () => {
  const projects = () => [{ id: 'app', name: 'App', dir: join(root, 'app'), match: ['http://localhost:5173'] }, { id: 'site', name: 'Site', dir: join(root, 'site'), match: ['https://*.acme.test/docs', 'https://acme.test/docs'] }, { id: 'tools', name: 'Tools', dir: join(root, 'tools'), inbox: true as const }];
  const capture = (handle: ReturnType<typeof createHandler>, url: string, query = '') => handle(new Request(`http://local/__feedback/api/items${query}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'a note', mode: 'page', image: `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString('base64')}`, context: { url } }) }));
  test('matching is by URL prefix or glob; the longest rule wins; the inbox\'s own pages go to the inbox project', () => {
    const p = projects();
    expect(matchProject(p, 'http://localhost:5173/billing?x=1')?.id).toBe('app');
    expect(matchProject(p, 'http://localhost:51730/billing')).toBeNull(); // a prefix ends at a segment
    expect(matchProject(p, 'https://eu.acme.test/docs/start#top')?.id).toBe('site');
    expect(matchProject(p, 'http://localhost:8099/__feedback/inbox/')?.id).toBe('tools');
    expect(matchProject(p, 'https://other.test/')).toBeNull();
    expect(routesByUrl(p)).toBe(true); expect(routesByUrl([p[2]!])).toBe(false);
    expect(closestProject(p, 'http://localhost:5173x/other', 'app')).toBeNull();
    expect(closestProject(p, 'https://acme.test/pricing', 'app')?.id).toBe('site');
  });
  test('a capture goes to its project; one that fits none goes to the first, flagged, with the closest as the suggestion', async () => {
    const p = projects(); for (const x of p) await mkdir(x.dir, { recursive: true });
    const handle = createHandler(p[0]!.dir, undefined, { projects: p });
    const a = await (await capture(handle, 'https://acme.test/docs/intro')).json();
    const b = await (await capture(handle, 'http://localhost:8099/__feedback/inbox/')).json();
    const c = await (await capture(handle, 'https://acme.test/pricing')).json();
    const d = await (await capture(handle, 'https://nowhere.test/x')).json();
    expect((await store.listThreads(p[1]!.dir)).map(t => t.id)).toEqual([a.id]);
    expect((await store.listThreads(p[2]!.dir)).map(t => t.id)).toEqual([b.id]);
    expect((await store.listThreads(p[0]!.dir)).map(t => t.id).sort()).toEqual([c.id, d.id].sort());
    const near = await (await get(handle, `threads/${c.id}`)).json();
    expect(near.unmatched).toBe(true); expect(near.suggested_project).toEqual({ id: 'site', name: 'Site' });
    const far = await (await get(handle, `threads/${d.id}`)).json();
    expect(far.unmatched).toBe(true); expect(far.suggested_project).toBeNull();
    expect((await (await get(handle, `threads/${await (async () => a.id)()}?project=site`)).json()).unmatched).toBeUndefined();
    // the widget names no project and still lists and reads everything it sent
    expect((await (await get(handle, 'items')).json()).length).toBe(4);
    expect((await get(handle, `items/${a.id}/image.png`)).status).toBe(200);
    // an explicit ?project= is taken at its word
    const named = await (await capture(handle, 'https://acme.test/docs/x', '?project=tools')).json();
    expect((await store.listThreads(p[2]!.dir)).some(t => t.id === named.id)).toBe(true);
  });
  test('with no rules, nothing changes; the new fields are validated', () => {
    const p = [{ id: 'a', name: 'A', dir: '/x/a' }, { id: 'b', name: 'B', dir: '/x/b' }];
    expect(routesByUrl(p)).toBe(false);
    const env = (list: unknown) => ({ FEEDBACK_PROJECTS: JSON.stringify(list) });
    expect(loadProjects(env([{ id: 'a', name: 'A', dir: '/x/a', match: ['http://x.test'], inbox: true }]))[0]).toMatchObject({ match: ['http://x.test'], inbox: true });
    expect(() => loadProjects(env([{ id: 'a', name: 'A', dir: '/x/a', match: 'x' }]))).toThrow('match');
    expect(() => loadProjects(env([{ id: 'a', name: 'A', dir: '/x/a', inbox: true }, { id: 'b', name: 'B', dir: '/x/b', inbox: true }]))).toThrow('inbox');
  });
});

describe('checks on agent messages', () => {
  const long = Array.from({ length: 130 }, (_, i) => `word${i}`).join(' ');
  test('length, internal codes and paths, no recommended option, a second open question', () => {
    expect(lintMessage({ text: 'Short and plain.' })).toEqual([]);
    expect(lintMessage({ text: long }).join()).toContain('130 words');
    expect(internalCodes('See R1-fix, G7, q3 and c14 in src/app/Thing.tsx, and the API at https://x.test/a/b.ts, HTTP and BLOCKED.')).toEqual(['src/app/Thing.tsx', 'R1-fix', 'G7', 'q3', 'c14', 'BLOCKED']);
    expect(lintMessage({ text: 'Which one?', asking: { options: [{}, {}] } }).join()).toContain('recommended');
    expect(lintMessage({ text: 'Which one?', asking: { options: [{}, { recommended: true }] } })).toEqual([]);
    expect(lintMessage({ text: long }, { FEEDBACK_AGENT_LINT: 'off' })).toEqual([]);
    expect(lintMessage({ text: long }, { FEEDBACK_AGENT_LINT: 'warn' }).length).toBe(1);
  });
  test('the CLI prints warnings and still sends; MCP returns warnings; a second open question is flagged', async () => {
    const id = (await store.createThread(dir, { title: 'One', text: 'hello', origin: 'user' })).id;
    const sent = await cli(['reply', id, `${long} see q3`]);
    expect(sent.out).toContain('Replied'); expect(sent.lines.join('\n')).toContain('words'); expect(sent.lines.join('\n')).toContain('internal codes');
    expect((await cli(['reply', id, `${long} see q3`], dir, { FEEDBACK_AGENT_LINT: 'off' })).lines.filter(l => l.startsWith('warning'))).toEqual([]);
    const first = await cli(['ask', id, 'Which one?', '--option', 'A', '--option', 'B']);
    expect(first.lines.join('\n')).toContain('recommended');
    const second = await cli(['ask', id, 'And this one?', '--option', 'A', '--option', 'B', '--recommend', '2']);
    expect(second.lines.join('\n')).toContain('already has an open question'); expect(second.lines.join('\n')).not.toContain('recommended');
    const server = createMcpServer({ dir, env: {} }); const client = new Client({ name: 't', version: '1' });
    const [x, y] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(x), client.connect(y)]);
    const r = await client.callTool({ name: 'reply', arguments: { id, text: long } }) as { structuredContent: { warnings?: string[]; posted: unknown } };
    expect(r.structuredContent.posted).toBeTruthy(); expect(r.structuredContent.warnings?.[0]).toContain('130 words');
    const ask = await client.callTool({ name: 'ask', arguments: { id, prompt: 'Third?', options: [{ label: 'A', recommended: true }, { label: 'B' }] } }) as { structuredContent: { warnings?: string[] } };
    expect(ask.structuredContent.warnings?.join()).toContain('already has an open question');
    await client.close();
  });
  test('an option marked recommended is stored, survives a re-ask, and shows when read', async () => {
    const id = (await store.createThread(dir, { title: 'One', text: 'hello', origin: 'user' })).id;
    await cli(['ask', id, 'Pick?', '--option', 'A', '--option', 'B|why', '--recommend', '2']);
    const { messages } = await store.summarise(dir, id);
    const q = messages.find(m => m.question)!.question!;
    expect(q.options.map(o => !!o.recommended)).toEqual([false, true]);
    const bumped = await store.bumpQuestion(dir, id, q.id);
    const copy = (await store.summarise(dir, id)).messages.find(m => m.question?.id === bumped.question_id)!.question!;
    expect(copy.options[1]!.recommended).toBe(true);
    await expect(cli(['ask', id, 'x', '--option', 'A', '--recommend', '4'])).rejects.toThrow('not there');
  });
});

describe('promises', () => {
  test('"I\'ll …" is spotted; the CLI suggests a checklist item and --promise adds it', async () => {
    expect(promisesIn("I'll check the build tonight. Then I will email you.")).toEqual(['check the build tonight', 'email you']);
    expect(promisesIn('Nothing promised here')).toEqual([]);
    const id = (await store.createThread(dir, { title: 'One', text: 'hello', origin: 'user' })).id;
    const plain = await cli(['reply', id, "I'll fix the layout tomorrow."]);
    expect(plain.lines.join('\n')).toContain('--promise');
    const tracked = await cli(['reply', id, "I'll fix the layout tomorrow.", '--promise', "I'll fix the layout tomorrow"]);
    expect(tracked.lines.join('\n')).not.toContain('You promised');
    const items = await store.listChecklist(dir, id);
    expect(items.map(i => [i.owner, i.text])).toEqual([['agent', "I'll fix the layout tomorrow"]]);
  });
});

describe('split', () => {
  test('a message and its replies move to a new thread with a link in both', async () => {
    const id = (await store.createThread(dir, { title: 'Billing', text: 'start', origin: 'agent' })).id;
    await store.appendMessage(dir, id, { author: 'user', text: 'Also, can we talk about the logo?' }); // m2
    await store.appendMessage(dir, id, { author: 'agent', text: 'Sure, about the logo', reply_to: 'm2' }); // m3
    await store.appendMessage(dir, id, { author: 'agent', text: 'Back to billing' }); // m4
    const r = await cli(['split', id, 'm2', '--title', 'Logo']);
    expect(r.out).toContain('m2 m3');
    const threads = await store.listThreads(dir);
    const made = threads.find(t => t.title === 'Logo')!;
    const there = (await store.summarise(dir, made.id)).messages.map(m => m.text);
    expect(there.some(t => t.includes('Split from "Billing"'))).toBe(true);
    expect(there).toContain('Moved from: Billing'); expect(there.join('\n')).toContain('logo');
    const here = (await store.summarise(dir, id)).messages.map(m => m.text);
    expect(here.filter(t => t.startsWith('Moved to [Logo]'))).toHaveLength(2);
    expect(here).toContain('Back to billing');
    await expect(cli(['split', id, 'm9', '--title', 'X'])).rejects.toThrow('No message');
    expect((await store.listThreads(dir)).length).toBe(2); // a failed split leaves no empty thread behind
  });
});

describe('reactions, closing done threads, waiting on you', () => {
  test('a reaction is an event, not a message; Done closes the thread; reading shows it', async () => {
    const handle = createHandler(dir);
    const id = (await store.createThread(dir, { title: 'One', text: 'all fixed', origin: 'agent' })).id;
    const before = (await store.summarise(dir, id)).messages.length;
    expect((await post(handle, `threads/${id}/messages/m1/react`, { reaction: 'wave' })).status).toBe(400);
    expect((await post(handle, `threads/${id}/messages/m1/react`, { reaction: 'thumbs_up' })).status).toBe(200);
    expect((await store.summarise(dir, id)).messages.length).toBe(before);
    const done = await (await post(handle, `threads/${id}/messages/m1/react`, { reaction: 'done' })).json();
    expect(done.closed).toBe(true);
    expect((await store.summarise(dir, id)).summary.status).toBe('done');
    const events = (await readFile(join(dir, '_events.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l)).filter(e => e.kind === 'reaction');
    expect(events.map(e => e.first_line)).toEqual(['\u{1F44D} on m1', 'Done, close it (on m1)']);
    expect((await (await get(handle, `threads/${id}`)).json()).reactions.m1).toMatchObject({ thumbs_up: expect.any(String), done: expect.any(String) });
    expect((await cli(['read', id])).out).toContain('you reacted: thumbs up, Done, close it');
    await store.appendMessage(dir, id, { author: 'user', text: 'actually' });
    expect((await post(handle, `threads/${id}/messages/m2/react`, { reaction: 'done' })).status).toBe(400); // only an agent message
  });
  test('Close all done threads closes the ones the agent called done and nobody waits on', async () => {
    const handle = createHandler(dir);
    const finished = (await store.createThread(dir, { title: 'Finished', text: 'ok', origin: 'agent', flag: 'done' })).id;
    await store.setStatus(dir, finished, 'open'); // done-flagged but still open (the person has an item)
    const waiting = (await store.createThread(dir, { title: 'Needs you', text: 'ok?', origin: 'agent' })).id;
    const closed = await (await post(handle, 'threads/close-done', {})).json();
    expect(closed.closed).toEqual([finished]);
    expect((await store.summarise(dir, waiting)).summary.status).toBe('open');
  });
  test('Waiting on you lists every open question and needs-you item across projects', async () => {
    const one = join(root, 'p1'), two = join(root, 'p2'); await mkdir(one); await mkdir(two);
    const projects = [{ id: 'p1', name: 'One', dir: one }, { id: 'p2', name: 'Two', dir: two }];
    const q = await store.createThread(one, { title: 'Asked', text: 'Which?', origin: 'agent', question: { prompt: 'Which?', options: [{ label: 'a' }] } });
    const n = await store.createThread(two, { title: 'Flagged', text: 'Look at this', origin: 'agent', flag: 'needs_you' });
    await store.createThread(two, { title: 'Fyi', text: 'just so you know', origin: 'agent', flag: 'fyi' });
    const handle = createHandler(one, undefined, { projects });
    const body = await (await get(handle, 'waiting')).json();
    expect(body.count).toBe(2);
    expect(body.items.map((i: { project: string; thread: string; kind: string }) => [i.project, i.thread, i.kind]).sort()).toEqual([['p1', q.id, 'question'], ['p2', n.id, 'needs_you']].sort());
    expect(body.items[0]).toHaveProperty('project_name');
  });
});

describe('answers sent from the offline queue', () => {
  test('a retry with the same client id answers once (200), and a question that went away still refuses with 409', async () => {
    const handle = createHandler(dir);
    const id = (await store.createThread(dir, { title: 'One', text: 'Which?', origin: 'agent', question: { prompt: 'Which?', options: [{ label: 'a' }, { label: 'b' }] } })).id;
    const body = { question_id: 'q1', option_ids: ['o2'], client_id: 'offline-answer-1', written_at: new Date().toISOString() };
    const first = await post(handle, `threads/${id}/answer`, body);
    expect(first.status).toBe(201);
    const again = await post(handle, `threads/${id}/answer`, body);
    expect(again.status).toBe(200);
    expect((await store.summarise(dir, id)).messages.filter(m => m.answer)).toHaveLength(1);
    expect((await post(handle, `threads/${id}/answer`, { question_id: 'q1', option_ids: ['o1'], client_id: 'offline-answer-2' })).status).toBe(409);
    const gone = (await store.createThread(dir, { title: 'Two', text: 'Which?', origin: 'agent', question: { prompt: 'Which?', options: [{ label: 'a' }] } })).id;
    await store.cancelQuestion(dir, gone, 'q1');
    const late = await post(handle, `threads/${gone}/answer`, { question_id: 'q1', option_ids: ['o1'], client_id: 'offline-answer-3' });
    expect(late.status).toBe(409); expect((await late.json()).detail).toContain('withdrawn');
  });
});

describe('the remote listener', () => {
  test('the Host guard is on by default once a public address is in play, and an empty Host is a 400, not a 500', async () => {
    const pairing = new Pairing(dir);
    const inner = async () => new Response('inner');
    const handler = createRemoteHandler(inner, pairing, { publicUrl: () => 'https://phone.example.test' });
    const send = (host: string | null) => handler(new Request('https://phone.example.test/__feedback/api/threads', host === null ? {} : { headers: { Host: host } }));
    expect((await send('evil.example')).status).toBe(403);
    expect((await send('phone.example.test')).status).toBe(401); // reaches the cookie check: the guard let it by
    expect((await send('localhost:8099')).status).toBe(401);
    expect((await send('')).status).toBe(400);
    const off = createRemoteHandler(inner, pairing, { publicUrl: () => 'https://phone.example.test', hostGuard: false });
    expect((await off(new Request('https://phone.example.test/__feedback/api/threads', { headers: { Host: 'evil.example' } }))).status).toBe(401);
  });
});

describe('review fixes', () => {
  test('a glob is matched piece by piece (no backtracking blow-up), and an address over 2 KB is never matched', () => {
    const projects = [{ id: 'a', name: 'A', dir: '/x/a', match: ['http://*a*a*a*a*a*a*a*a*a*a*a*a*b/docs'] }, { id: 'b', name: 'B', dir: '/x/b', match: ['https://*.acme.test/docs', 'https://acme.test/*/edit'] }];
    const evil = `http://${'a'.repeat(1900)}`;
    const t0 = performance.now();
    expect(matchProject(projects, evil)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(200);
    expect(matchProject(projects, `https://eu.acme.test/docs/x#f`)?.id).toBe('b');
    expect(matchProject(projects, `https://eu.acme.test/docsx`)).toBeNull();
    expect(matchProject(projects, `https://acme.test/p/9/edit?x=1`)?.id).toBe('b');
    expect(matchProject(projects, `https://acme.test/p/9/editor`)).toBeNull();
    expect(matchProject(projects, `https://eu.acme.test/docs/${'x'.repeat(2100)}`)).toBeNull();
    expect(closestProject(projects, `https://acme.test/${'x'.repeat(2100)}`)).toBeNull();
  });
  test('the same client id on an answer and on a plain message are two messages; a repeat of the same kind is still one', async () => {
    const id = (await store.createThread(dir, { title: 'One', text: 'Which?', origin: 'agent', question: { prompt: 'Which?', options: [{ label: 'a' }] } })).id;
    const cid = 'same-client-id-1';
    const plain = await store.appendMessage(dir, id, { author: 'user', text: 'a word', client_id: cid });
    const answer = await store.appendMessage(dir, id, { author: 'user', text: undefined, answer: { question_id: 'q1', option_ids: ['o1'] }, client_id: cid });
    expect(answer.id).not.toBe(plain.id);
    const again = await store.appendMessage(dir, id, { author: 'user', text: 'a word', client_id: cid });
    expect(again.id).toBe(plain.id);
    expect((await store.summarise(dir, id)).messages.filter(m => m.author === 'user')).toHaveLength(2);
  });
  test('Close all done: leaves a thread you reopened, one waiting on the agent to check an item, and Undo reopens exactly the closed ids', async () => {
    const handle = createHandler(dir);
    const finished = (await store.createThread(dir, { title: 'Finished', text: 'ok', origin: 'agent', flag: 'done' })).id;
    const reopened = (await store.createThread(dir, { title: 'Reopened', text: 'ok', origin: 'agent', flag: 'done' })).id;
    const checking = (await store.createThread(dir, { title: 'Checking', text: 'ok', origin: 'agent', flag: 'fyi' })).id;
    for (const id of [finished, reopened, checking]) await store.setStatus(dir, id, 'open');
    await store.appendMessage(dir, checking, { author: 'agent', text: 'all done', flag: 'done' });
    await store.addChecklistItem(dir, checking, { owner: 'agent', text: 'verify', by: 'agent' });
    const item = (await store.listChecklist(dir, checking))[0]!;
    await store.patchChecklistItem(dir, checking, item.id, { claimed: true }, 'user'); // the person says it is done: the agent has to check
    await store.setStatus(dir, checking, 'open');
    expect((await post(handle, `threads/${reopened}/status`, { status: 'open' })).status).toBe(200); // the person reopened it
    const closed = await (await post(handle, 'threads/close-done', {})).json();
    expect(closed.closed).toEqual([finished]);
    expect((await store.summarise(dir, reopened)).summary.status).toBe('open');
    expect((await store.summarise(dir, checking)).summary.status).toBe('open');
    const undo = await (await post(handle, 'threads/reopen', { ids: closed.closed })).json();
    expect(undo.reopened).toEqual([finished]);
    expect((await store.summarise(dir, finished)).summary.status).toBe('open');
    expect((await post(handle, 'threads/reopen', { ids: ['../x'] })).status).toBe(400);
    expect((await (await post(handle, 'threads/close-done', {})).json()).closed).toEqual([]); // an Undo is a reopen too: not closed again
  });
  test('GET api/waiting is computed again only when a thread changes (or a listed question expires)', async () => {
    const handle = createHandler(dir);
    const id = (await store.createThread(dir, { title: 'Asked', text: 'Which?', origin: 'agent', question: { prompt: 'Which?', options: [{ label: 'a' }] } })).id;
    const before = store.waitingStats.computed;
    expect((await (await get(handle, 'waiting')).json()).count).toBe(1);
    await get(handle, 'waiting'); await get(handle, 'waiting');
    expect(store.waitingStats.computed).toBe(before + 1);
    await cli(['reply', id, 'a word'], dir); // a write by another process shows too
    expect((await (await get(handle, 'waiting')).json()).count).toBe(1);
    expect(store.waitingStats.computed).toBe(before + 2);
    await store.appendMessage(dir, id, { author: 'user', text: undefined, answer: { question_id: 'q1', option_ids: ['o1'] } });
    expect((await (await get(handle, 'waiting')).json()).count).toBe(0);
    expect(store.waitingStats.computed).toBe(before + 3);
    const soon = (await store.createThread(dir, { title: 'Expiring', text: 'Quick?', origin: 'agent', question: { prompt: 'Quick?', options: [{ label: 'a' }], expires: '1m' } })).id;
    expect((await (await get(handle, 'waiting')).json()).items.some((i: { thread: string }) => i.thread === soon)).toBe(true);
  });
});
