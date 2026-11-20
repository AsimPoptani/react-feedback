// 0.9: artifacts, sandboxed share links, projects, and pinned questions.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHandler } from './server';
import { run } from './cli';
import { createMcpServer } from './mcp';
import { MAX_ARTIFACT_BYTES, publishArtifact } from './artifacts';
import { createShare, hashToken } from './shares';
import * as store from './store';
import type { Project } from './projects';

let dir: string;
let handle: ReturnType<typeof createHandler>;
let clock = Date.parse('2026-11-20T12:00:00.000Z');
const api = (path: string, data?: unknown) => new Request(`http://local/__feedback/${path}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const textOf = async (path: string) => handle(new Request(`http://local${path}`));
const events = async () => (await readFile(join(dir, '_events.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'feedback-v09-'));
  clock = Date.parse('2026-11-20T12:00:00.000Z');
  handle = createHandler(dir, undefined, { now: () => clock });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const thread = async () => (await store.createThread(dir, { title: 'Options', text: 'Here are the options', origin: 'agent' })).id;
const publish = (id: string, content: string, format: 'html' | 'md', title = 'Options', artifact?: string) =>
  publishArtifact(dir, { thread: id, title, content, format, ...(artifact ? { id: artifact } : {}) });

async function connect(name = 'Scout') {
  const server = createMcpServer({ dir, agentName: name, env: {} });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const tool = async (n: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name: n, arguments: args }) as { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] };
    return { error: result.isError === true, data: result.structuredContent, text: result.content[0]!.text };
  };
  return { tool, close: () => client.close(), tools: () => client.listTools() };
}

function missShape(response: Response, body: string) {
  const headers = [...response.headers.entries()].map(([key, value]) => [key.toLowerCase(), value]).sort();
  return { status: response.status, body, headers };
}

test('publish keeps versions, renders Markdown, caps the size, and serves a full HTML document unchanged', async () => {
  const id = await thread();
  const first = await publish(id, '<p>One</p>', 'html');
  const second = await publish(id, '<p>Two</p>', 'html', 'Options revised', first.id);
  expect(second.latest).toBe(2);
  expect(second.versions.map(version => version.n)).toEqual([1, 2]);
  expect(await readFile(join(dir, '_artifacts', first.id, 'v1', 'body.html'), 'utf8')).toContain('<p>One</p>');
  const md = await publish(id, '# Hello\n\n<script>alert(1)</script>', 'md', 'Notes');
  const page = await readFile(join(dir, '_artifacts', md.id, 'v1', 'body.html'), 'utf8');
  expect(page).toContain('function markdown');
  expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(page).not.toContain('<script>alert(1)</script>');
  await expect(publish(id, 'x'.repeat(MAX_ARTIFACT_BYTES + 1), 'html')).rejects.toThrow(/5 MB/);
  const probe = '<!doctype html><html><head><title>Probe</title></head><body><script>window.probe = 1</script></body></html>';
  const html = await publish(id, probe, 'html', 'Probe');
  const served = await textOf(`/__feedback/a/${html.id}/v1`);
  expect(await served.text()).toBe(probe);
  expect(served.headers.get('content-security-policy')).toBe('sandbox allow-scripts allow-popups');
  expect(served.headers.get('x-content-type-options')).toBe('nosniff');
  expect(served.headers.get('referrer-policy')).toBe('no-referrer');
  expect(served.headers.get('set-cookie')).toBeNull();
});

test('a share link from the inbox, the CLI and MCP: expiry, the scan, revoke, the same 404, and view counts', async () => {
  const id = await thread();
  const page = await publish(id, '<p>Share me</p>', 'html', 'Share me');
  const file = join(dir, 'page.md');
  await writeFile(file, '# Shared\n\nHello');
  const published = await run(['artifact', 'publish', id, file, '--title', 'From a file'], dir, undefined, { FEEDBACK_AGENT_NAME: 'Scout' });
  expect(published).toContain('v1');
  const suggested = await run(['artifact', 'suggest-share', page.id], dir, undefined, {});
  expect(suggested).toContain(page.id);
  expect(await readFile(join(dir, '_shares.json'), 'utf8').catch(() => '')).toBe('');

  const created = await (await handle(api(`api/artifacts/${page.id}/share`, { expires: 'none' }))).json() as { id: string; url: string; created_by: string };
  expect(created.created_by).toBe('you');
  const stored = JSON.parse(await readFile(join(dir, '_shares.json'), 'utf8')) as { shares: { token_hash: string; created_by: string; views: number }[] };
  const token = created.url.split('/').pop()!;
  expect(JSON.stringify(stored)).not.toContain(token);
  expect(stored.shares[0]!.token_hash).toBe(hashToken(token));
  expect(stored.shares[0]!.token_hash).toBe(createHash('sha256').update(token).digest('hex'));

  const open = await textOf(created.url);
  expect(open.status).toBe(200);
  expect(open.headers.get('x-robots-tag')).toBe('noindex');
  expect(open.headers.get('content-security-policy')).toBe('sandbox allow-scripts allow-popups');
  expect(open.headers.get('set-cookie')).toBeNull();
  expect(await open.text()).toContain('Share me');
  const after = JSON.parse(await readFile(join(dir, '_shares.json'), 'utf8')) as { shares: { views: number; last_viewed_at: string | null }[] };
  expect(after.shares[0]!.views).toBe(1);
  expect(after.shares[0]!.last_viewed_at).toBe(new Date(clock).toISOString());
  expect(JSON.stringify(after)).not.toContain('userAgent');
  expect(JSON.stringify(after)).not.toMatch(/"ip"/);

  const unknown = await textOf('/__feedback/s/not-a-real-token');
  const unknownBody = await unknown.text();
  const revoked = await handle(api(`api/shares/${created.id}/revoke`, {}));
  expect(revoked.status).toBe(200);
  const afterRevoke = await textOf(created.url);
  expect(missShape(afterRevoke, await afterRevoke.text())).toEqual(missShape(unknown, unknownBody));

  const expiring = await (await handle(api(`api/artifacts/${page.id}/share`, { expires: '1d' }))).json() as { url: string };
  clock += 2 * 864e5;
  const expired = await textOf(expiring.url);
  expect(missShape(expired, await expired.text())).toEqual(missShape(unknown, unknownBody));

  const agent = await run(['artifact', 'share', page.id], dir, undefined, { FEEDBACK_AGENT_NAME: 'Scout' });
  expect(agent).toContain('/__feedback/s/');
  const shares = JSON.parse(await readFile(join(dir, '_shares.json'), 'utf8')) as { shares: { id: string; created_by: string; expires_at: string | null }[] };
  const byScout = shares.shares.find(share => share.created_by === 'Scout')!;
  expect(Date.parse(byScout.expires_at!) - Date.now()).toBeGreaterThan(6 * 864e5);
  expect(Date.parse(byScout.expires_at!) - Date.now()).toBeLessThan(8 * 864e5);
  const messages = await store.readMessages(join(dir, id), await store.readItem(join(dir, id)));
  expect(messages.some(message => message.kind === 'share_notice' && message.text.includes("Scout shared 'Share me'") && message.text.includes('Revoke'))).toBe(true);
  await expect(run(['artifact', 'share', page.id, '--expires', 'none'], dir, undefined, { FEEDBACK_AGENT_NAME: 'Scout' })).rejects.toThrow(/no expiry/);
  const month = await run(['artifact', 'share', page.id, '--expires', '30d'], dir, undefined, { FEEDBACK_AGENT_NAME: 'Scout' });
  expect(month).toContain('expires');
  await expect(run(['artifact', 'unshare', created.id], dir, undefined, { FEEDBACK_AGENT_NAME: 'Scout' })).rejects.toThrow(/only revoke a link it created/);

  const secret = await publish(id, '<p>sk-live-ABCDEFGH1234</p>', 'html', 'Secret');
  await expect(run(['artifact', 'share', secret.id], dir, undefined, { FEEDBACK_AGENT_NAME: 'Scout' })).rejects.toThrow(/not shared/);
  const refused = await handle(api(`api/artifacts/${secret.id}/share`, { expires: '7d' }));
  expect(refused.status).toBe(409);
  expect((await refused.json()).detail).toContain('looks like it contains');
  const anyway = await (await handle(api(`api/artifacts/${secret.id}/share`, { expires: '7d', confirm: true }))).json() as { id: string };
  expect(anyway.id).toMatch(/^s[0-9a-f]{8}$/);

  const mcp = await connect('Scout');
  const shared = await mcp.tool('share_artifact', { id: page.id, expires: '7d' });
  expect(shared.error).toBe(false);
  const foreign = await mcp.tool('revoke_share', { id: anyway.id });
  expect(foreign.error).toBe(true);
  expect(foreign.text).toContain('only revoke a link it created');
  const own = (shared.data as { share: { id: string } }).share.id;
  expect((await mcp.tool('revoke_share', { id: own })).error).toBe(false);
  const blocked = await mcp.tool('share_artifact', { id: secret.id });
  expect(blocked.error).toBe(true);
  expect(blocked.text).toContain('not shared');
  await mcp.close();
});

test('projects stay apart, unread counts travel with the menu, and one project ignores ?project=', async () => {
  const base = await mkdtemp(join(tmpdir(), 'feedback-v09-projects-'));
  const alpha = join(base, 'alpha');
  const beta = join(base, 'beta');
  const projects: Project[] = [{ id: 'alpha', name: 'Alpha', dir: alpha }, { id: 'beta', name: 'Beta', dir: beta }];
  const both = createHandler(alpha, undefined, { projects });
  const a = await store.createThread(alpha, { title: 'Alpha only', text: 'a', origin: 'user' });
  const b = await store.createThread(beta, { title: 'Beta only', text: 'b', origin: 'agent', question: { prompt: 'Go?', options: [{ label: 'Yes' }, { label: 'No' }] }, flag: 'needs_you' });
  const list = async (query: string) => (await both(new Request(`http://local/__feedback/api/threads${query}`))).json() as { id: string }[];
  expect((await list('')).map(row => row.id)).toEqual([a.id]);
  expect((await list('?project=beta')).map(row => row.id)).toEqual([b.id]);
  expect((await both(new Request('http://local/__feedback/api/threads?project=nope'))).status).toBe(404);
  const menu = await (await both(new Request('http://local/__feedback/api/projects'))).json() as { projects: { id: string; unread: number; dir?: string }[] };
  expect(menu.projects.map(project => project.id)).toEqual(['alpha', 'beta']);
  expect(menu.projects.find(project => project.id === 'beta')!.unread).toBe(1);
  expect(menu.projects.find(project => project.id === 'alpha')!.unread).toBe(0);
  expect(JSON.stringify(menu)).not.toContain(alpha);
  const alone = createHandler(dir);
  await store.createThread(dir, { title: 'Only', text: 'one', origin: 'user' });
  const ignored = await (await alone(new Request('http://local/__feedback/api/threads?project=beta'))).json() as { title: string }[];
  expect(ignored.map(row => row.title)).toEqual(['Only']);
  expect((await alone(new Request('http://local/__feedback/api/threads?project=nope'))).status).toBe(200);
  await rm(base, { recursive: true, force: true });
});

test('cancel and bump, from the CLI and MCP, and an answer names its question', async () => {
  const id = (await store.createThread(dir, { title: 'Options', text: 'Here are the options', origin: 'user' })).id;
  await run(['ask', id, 'Build secret share links for the inbox now?', '--option', 'Yes, build it', '--option', 'No'], dir);
  const withdrawn = await run(['ask-cancel', id, 'q2', '--reason', 'asked too soon'], dir);
  expect(withdrawn).toContain('Withdrew q2');
  let detail = await store.summarise(dir, id);
  expect(detail.summary.open_question).toBe(false);
  expect(detail.summary.waiting).not.toBe('you');
  const old = detail.messages.find(message => message.question?.id === 'q2')!.question!;
  expect(old.withdrawn?.reason).toBe('asked too soon');
  await expect(store.appendMessage(dir, id, { author: 'user', text: undefined, answer: { question_id: 'q2', option_ids: ['o1'] } })).rejects.toThrow(/withdrawn/);

  await run(['ask', id, 'Build secret share links for the inbox now?', '--option', 'Yes, build it', '--option', 'No'], dir);
  const bumped = await run(['ask-bump', id, 'q3'], dir);
  expect(bumped).toContain('q4');
  detail = await store.summarise(dir, id);
  expect(detail.messages.find(message => message.question?.id === 'q3')!.question!.reasked).toBe(true);
  expect(detail.summary.open_question).toBe(true);
  expect(detail.summary.waiting).toBe('you');

  const mcp = await connect();
  expect((await mcp.tool('cancel_question', { id, question: 'q4', reason: 'later' })).error).toBe(false);
  expect((await store.summarise(dir, id)).summary.waiting).not.toBe('you');
  await run(['ask', id, 'Once more?', '--option', 'Yes', '--option', 'No'], dir);
  const bumpedByAgent = await mcp.tool('bump_question', { id, question: 'q5' });
  expect(bumpedByAgent.error).toBe(false);
  await mcp.close();

  const live = (await store.summarise(dir, id)).messages.filter(message => message.question && !message.question.reasked && !message.question.withdrawn).pop()!;
  const answered = await handle(api(`api/threads/${id}/answer`, { question_id: live.question!.id, option_ids: ['o1'] }));
  expect(answered.status).toBe(201);
  const line = (await events()).find((event: { kind: string; first_line: string }) => event.kind === 'answer').first_line;
  expect(line).toBe(`${live.question!.id} (Once more?): Yes`);
  const printed = await run(['read', id], dir);
  expect(printed).toContain(`${live.question!.id} (Once more?): Yes`);
  await run(['ask', id, 'Build secret share links for the whole inbox please', '--option', 'Yes, build it'], dir);
  const asked = (await store.summarise(dir, id)).messages.filter(message => message.question && !message.question.reasked && !message.question.withdrawn).pop()!;
  await handle(api(`api/threads/${id}/answer`, { question_id: asked.question!.id, option_ids: ['o1'] }));
  const clipped = (await events()).filter((event: { kind: string }) => event.kind === 'answer').pop().first_line as string;
  const prompt = 'Build secret share links for the whole inbox please';
  const short = `${prompt.slice(0, 39)}…`;
  expect(clipped).toBe(`${asked.question!.id} (${short}): Yes, build it`);
});

test('an unknown share does not create the shares file', async () => {
  const response = await textOf('/__feedback/s/missing-token-value');
  expect(response.status).toBe(404);
  await expect(stat(join(dir, '_shares.json'))).rejects.toThrow();
});

test('an agent share is pinned to the current version', async () => {
  const id = await thread();
  const page = await publish(id, '<p>Pin me</p>', 'html', 'Pin me');
  await expect(createShare(dir, { artifact: page.id, latest: true, by: 'Scout', agent: true })).rejects.toThrow(/pinned to the current version/);
  await expect(run(['artifact', 'share', page.id, '--latest'], dir, undefined, { FEEDBACK_AGENT_NAME: 'Scout' })).rejects.toThrow(/pinned to the current version/);
  expect(await readFile(join(dir, '_shares.json'), 'utf8').catch(() => '')).toBe('');
  const agent = await run(['artifact', 'share', page.id], dir, undefined, { FEEDBACK_AGENT_NAME: 'Scout' });
  const token = agent.split('/').pop()!.trim();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const stored = JSON.parse(await readFile(join(dir, '_shares.json'), 'utf8')) as { shares: { version: number | string; created_by: string }[] };
  expect(stored.shares.find(share => share.created_by === 'Scout')!.version).toBe(1);
  const mcp = await connect('Scout');
  const listed = await mcp.tools();
  const schema = listed.tools.find(tool => tool.name === 'share_artifact')!.inputSchema as { properties?: Record<string, unknown> };
  expect(schema.properties?.latest).toBeUndefined();
  const shared = await mcp.tool('share_artifact', { id: page.id, latest: true });
  expect(shared.error).toBe(false);
  expect((shared.data as { share: { version: number | string } }).share.version).toBe(1);
  await mcp.close();
  const user = await createShare(dir, { artifact: page.id, expires: '7d', latest: true, by: 'you', agent: false });
  expect(user.share.version).toBe('latest');
});

test('a latest link scans the next version and a new version posts a thread line', async () => {
  const id = await thread();
  const page = await publish(id, '<p>Clean</p>', 'html', 'Clean');
  const pinned = await createShare(dir, { artifact: page.id, expires: '7d', by: 'you', agent: false });
  expect(pinned.share.version).toBe(1);
  const secretOnPinned = await publish(id, '<p>sk-live-ABCDEFGH1234</p>', 'html', 'Secret', page.id);
  expect(secretOnPinned.latest).toBe(2);
  const messages = async () => store.readMessages(join(dir, id), await store.readItem(join(dir, id)));
  expect((await messages()).some(message => message.text?.includes('now live on a shared link'))).toBe(false);

  const clean = await publish(id, '<p>Public</p>', 'html', 'Public');
  const latest = await createShare(dir, { artifact: clean.id, expires: '30d', latest: true, by: 'you', agent: false });
  expect(latest.share.version).toBe('latest');
  await expect(publish(id, '<p>sk-live-ABCDEFGH1234</p>', 'html', 'Nope', clean.id)).rejects.toThrow(/not published/);
  const stayed = JSON.parse(await readFile(join(dir, '_artifacts', clean.id, 'meta.json'), 'utf8')) as { latest: number };
  expect(stayed.latest).toBe(1);
  await expect(stat(join(dir, '_artifacts', clean.id, 'v2'))).rejects.toThrow();
  const next = await publish(id, '<p>Second</p>', 'html', 'Second', clean.id);
  expect(next.latest).toBe(2);
  expect((await messages()).some(message => message.text === 'New version v2 is now live on a shared link')).toBe(true);
  expect(await (await textOf(latest.path)).text()).toContain('Second');
  const odd = JSON.parse(await readFile(join(dir, '_shares.json'), 'utf8')) as { shares: { token_hash: string }[] };
  odd.shares[0]!.token_hash = 'abc';
  await writeFile(join(dir, '_shares.json'), JSON.stringify(odd));
  expect((await textOf(pinned.path)).status).toBe(404);
});

test('a version folder left behind by a crash does not wedge the next publish', async () => {
  const id = await thread();
  const page = await publish(id, '<p>One</p>', 'html', 'One');
  const folder = join(dir, '_artifacts', page.id);
  await mkdir(join(folder, 'v2'), { recursive: true });
  await writeFile(join(folder, 'v2', 'body.html'), '<p>Orphan</p>');
  await writeFile(join(folder, 'v2', 'source.html'), '<p>Orphan</p>');
  await writeFile(join(folder, 'v2', 'meta.json'), JSON.stringify({ n: 2, format: 'html', bytes: 12, title: 'One', created_at: '2026-11-20T12:00:00.000Z' }));
  const repaired = await publish(id, '<p>Three</p>', 'html', 'Three', page.id);
  expect(repaired.versions.map(version => version.n)).toEqual([1, 2, 3]);
  expect(repaired.latest).toBe(3);
  expect(await readFile(join(folder, 'v2', 'body.html'), 'utf8')).toContain('Orphan');
  expect(await readFile(join(folder, 'v3', 'body.html'), 'utf8')).toContain('Three');

  const bare = await publish(id, '<p>Bare</p>', 'html', 'Bare');
  await mkdir(join(dir, '_artifacts', bare.id, 'v2'), { recursive: true });
  await writeFile(join(dir, '_artifacts', bare.id, 'v2', 'body.html'), '<p>No meta</p>');
  const skipped = await publish(id, '<p>Next</p>', 'html', 'Next', bare.id);
  expect(skipped.versions.map(version => version.n)).toEqual([1, 3]);
  expect(skipped.latest).toBe(3);
  expect(await readFile(join(dir, '_artifacts', bare.id, 'v3', 'body.html'), 'utf8')).toContain('Next');
});

test('marking a thread read requires a JSON content type', async () => {
  const id = await thread();
  expect((await store.summarise(dir, id)).summary.user_read_at).toBeNull();
  const plain = await handle(new Request(`http://local/__feedback/api/threads/${id}/read`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }));
  const form = await handle(new Request(`http://local/__feedback/api/threads/${id}/read`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'seen=1' }));
  const none = await handle(new Request(`http://local/__feedback/api/threads/${id}/read`, { method: 'POST' }));
  expect([plain.status, form.status, none.status]).toEqual([415, 415, 415]);
  expect((await store.summarise(dir, id)).summary.user_read_at).toBeNull();
  expect((await handle(api(`api/threads/${id}/read`, {}))).status).toBe(200);
  expect((await store.summarise(dir, id)).summary.user_read_at).not.toBeNull();
});
