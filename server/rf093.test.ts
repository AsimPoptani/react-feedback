import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { publishArtifact } from './artifacts';
import { run } from './cli';
import { createMcpServer } from './mcp';
import { moveThreadToProject } from './move-project';
import * as reminders from './reminders';
import { createHandler } from './server';
import { redactMessage, unredactMessage } from './sensitive';
import { createShare, openShare, readShares } from './shares';
import * as store from './store';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
let root: string, alpha: string, beta: string, vault: string, env: Record<string, string | undefined>;
const projects = () => [{ id: 'alpha', name: 'Alpha', dir: alpha }, { id: 'beta', name: 'Beta', dir: beta }];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rf093-'));
  alpha = join(root, 'alpha'); beta = join(root, 'beta'); vault = join(root, 'vault');
  await mkdir(alpha); await mkdir(beta); await mkdir(vault, { mode: 0o700 });
  env = { FEEDBACK_PROJECTS: JSON.stringify(projects()), FEEDBACK_VAULT_DIR: vault, FEEDBACK_DIR: alpha };
});
afterEach(async () => { await chmod(beta, 0o700).catch(() => {}); await rm(root, { recursive: true, force: true }); });

async function fingerprint(dir: string): Promise<string> {
  const rows: string[] = [];
  const walk = async (path: string, rel: string): Promise<void> => {
    let names: string[] = [];
    try { names = await readdir(path); } catch { return; }
    for (const name of names.sort()) {
      const abs = join(path, name), relPath = rel ? `${rel}/${name}` : name, st = await lstat(abs);
      if (st.isDirectory()) await walk(abs, relPath);
      else rows.push(`${relPath} ${createHash('sha256').update(await readFile(abs)).digest('hex')}`);
    }
  };
  await walk(dir, '');
  return rows.join('\n');
}
async function events(dir: string): Promise<{ id: string; kind: string; author: string; first_line: string }[]> {
  try {
    return (await readFile(join(dir, '_events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { id: string; kind: string; author: string; first_line: string });
  } catch { return []; }
}
const unread = async (dir: string) => (await store.listThreads(dir)).filter(thread => thread.unread_for_user).length;
const ask = async (dir: string, title: string, prompt: string) => {
  const id = (await store.createThread(dir, { title, text: 'Start', origin: 'user' })).id;
  const message = await store.appendMessage(dir, id, { author: 'agent', text: prompt, question: { prompt, options: [{ label: 'Yes' }, { label: 'No' }] }, flag: 'needs_you' });
  return { id, qid: message.question!.id };
};

test('a thread moves with its artifact, share, merged child, vault entry, checklist and reminder', async () => {
  const id = (await store.createThread(alpha, { title: 'Ship the list', text: 'Start', origin: 'user' })).id;
  const child = (await store.createThread(alpha, { title: 'Side note', text: 'Fold me in', origin: 'user' })).id;
  await store.mergeThreads(alpha, child, id, 'agent');
  await store.addChecklistItem(alpha, id, { owner: 'user', text: 'Bring the list', by: 'agent' });
  await reminders.addReminder(alpha, id, { kind: 'every', value: '2h', say: 'Check the list', by: 'agent' });
  await writeFile(join(alpha, id, 'notes.txt'), 'keep me\n');
  await writeFile(join(alpha, id, 'shot.png'), png);
  await store.setPin(alpha, { kind: 'thread', id, pinned: true });
  const asked = await store.appendMessage(alpha, id, { author: 'agent', text: 'Ship it?', question: { prompt: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }, flag: 'needs_you' });
  const qid = asked.question!.id;
  const meta = await publishArtifact(alpha, { thread: id, title: 'Notes', content: '<p>Notes</p>', format: 'html' });
  const shared = await createShare(alpha, { artifact: meta.id, expires: '7d', by: 'Agent', agent: true });
  expect(await openShare(alpha, shared.token)).toContain('Notes');
  await redactMessage(alpha, id, 'm1', { by: 'user', vault });
  const quiet = (await store.createThread(alpha, { title: 'Note', text: 'I wrote last', origin: 'user' })).id;
  const beforeA = await fingerprint(alpha), beforeB = await fingerprint(beta);
  const preview = await run(['move-project', id, 'beta', '--dry-run'], alpha, undefined, env);
  expect(preview).toContain('dry run');
  expect(preview).toContain(`${id} → Beta (beta), same id`);
  expect(preview).toContain(`with ${child} (merged into it)`);
  expect(preview).toContain(meta.id);
  expect(preview).toContain('shares: 1 link, viewed 1×');
  expect(preview).toContain('redacted messages: 1');
  expect(await fingerprint(alpha)).toBe(beforeA);
  expect(await fingerprint(beta)).toBe(beforeB);
  const unreadBefore = await unread(alpha);
  expect(unreadBefore).toBeGreaterThan(0);
  const moved = await run(['move-project', id, 'beta'], alpha, undefined, env);
  expect(moved).toBe(`Moved ${id} to Beta`);
  await expect(lstat(join(alpha, id))).rejects.toThrow();
  const { summary, messages } = await store.summarise(beta, id);
  expect(summary.waiting).toBe('you');
  expect(summary.unread_for_user).toBe(true);
  expect(summary.open_question).toBe(true);
  expect(messages.filter(m => m.divider && m.text === 'Moved from Alpha')).toHaveLength(1);
  expect(messages.some(m => m.question?.id === qid && !m.question.withdrawn)).toBe(true);
  expect(await readFile(join(beta, id, 'notes.txt'), 'utf8')).toBe('keep me\n');
  expect(await readFile(join(beta, id, 'shot.png'))).toEqual(png);
  expect((await store.readChecklist(join(beta, id))).some(item => item.text === 'Bring the list')).toBe(true);
  expect(await readFile(join(beta, id, 'reminders.json'), 'utf8')).toContain('Check the list');
  const childNote = JSON.parse(await readFile(join(beta, child, 'merged.json'), 'utf8')) as { into: string };
  expect(childNote.into).toBe(id);
  const childText = await readFile(join(beta, child, 'thread.jsonl'), 'utf8');
  expect(childText).toContain(`(#/${id})`);
  expect(childText).toContain('Moved from Alpha');
  await expect(lstat(join(alpha, child))).rejects.toThrow();
  expect((await readShares(beta)).map(share => share.views)).toEqual([1]);
  expect(await readFile(join(alpha, '_shares.json'), 'utf8')).not.toContain(shared.share.token_hash);
  const handle = createHandler(alpha, undefined, { projects: projects(), vaultDir: vault });
  expect((await handle(new Request(`http://local/__feedback/s/${shared.token}`))).status).toBe(200);
  expect((await readShares(beta))[0]!.views).toBe(2);
  const vaultFile = join(vault, 'beta', id, 'm1.json');
  expect(JSON.parse(await readFile(vaultFile, 'utf8')).thread).toBe(id);
  await expect(readFile(join(vault, id, 'm1.json'))).rejects.toThrow();
  expect((await unredactMessage(beta, id, 'm1', vault)).restored).toBe(true);
  expect((await store.summarise(beta, id)).messages.find(m => m.id === 'm1')?.text).toBe('Start');
  expect((await store.readPins(beta)).threads).toContain(id);
  expect((await store.readPins(alpha)).threads).not.toContain(id);
  const movedEvents = async (dir: string) => (await events(dir)).filter(event => event.kind === 'moved' && event.author === 'system' && event.id === id);
  expect(await movedEvents(alpha)).toHaveLength(1);
  expect(await movedEvents(beta)).toHaveLength(1);
  expect((await movedEvents(beta))[0]!.first_line).toContain('from Alpha');
  expect(await unread(alpha)).toBe(unreadBefore - 1);
  expect(await unread(beta)).toBe(1);
  const listed = await (await handle(new Request('http://local/__feedback/api/projects'))).json() as { projects: { id: string; unread: number }[] };
  expect(listed.projects).toEqual([{ id: 'alpha', name: 'Alpha', unread: await unread(alpha) }, { id: 'beta', name: 'Beta', unread: await unread(beta) }]);
  expect(await run(['move-project', id, 'beta'], alpha, undefined, env)).toBe(`${id} is already in Beta`);
  expect(await movedEvents(alpha)).toHaveLength(1);
  expect((await store.summarise(beta, id)).messages.filter(m => m.divider && m.text === 'Moved from Alpha')).toHaveLength(1);
  await run(['move-project', quiet, 'beta'], alpha, undefined, env);
  const quietSummary = (await store.summarise(beta, quiet)).summary;
  expect(quietSummary.waiting).toBe('agent');
  expect(quietSummary.last_author).toBe('user');
});

test('a taken id is remapped and the share link still serves', async () => {
  const { id } = await ask(alpha, 'Ship the list', 'Ship it?');
  const meta = await publishArtifact(alpha, { thread: id, title: 'Notes', content: '<p>Notes</p>', format: 'html' });
  const shared = await createShare(alpha, { artifact: meta.id, expires: '7d', by: 'Agent', agent: true });
  const child = (await store.createThread(alpha, { title: 'Side note', text: 'Fold me in', origin: 'user' })).id;
  await store.mergeThreads(alpha, child, id, 'agent');
  await mkdir(join(beta, '_artifacts'), { recursive: true });
  await cp(join(alpha, id), join(beta, id), { recursive: true });
  await cp(join(alpha, child), join(beta, child), { recursive: true });
  await cp(join(alpha, '_artifacts', meta.id), join(beta, '_artifacts', meta.id), { recursive: true });
  const text = await run(['move-project', id, 'beta'], alpha, undefined, env);
  const next = /as (\d{8}-\d{6}-[0-9a-f]{4})/.exec(text)?.[1];
  expect(next).toBeTruthy();
  expect(next).not.toBe(id);
  expect(store.ID.test(next!)).toBe(true);
  const raw = await readFile(join(beta, next!, 'thread.jsonl'), 'utf8');
  expect(raw).toContain('Moved from Alpha');
  expect(await readFile(join(beta, id, 'thread.jsonl'), 'utf8')).not.toContain('Moved from Alpha');
  let movedChild = '';
  for (const name of await readdir(beta)) {
    if (!store.ID.test(name) || name === next) continue;
    const body = await readFile(join(beta, name, 'thread.jsonl'), 'utf8');
    if (body.includes('Moved from Alpha') && body.includes('Fold me in')) movedChild = name;
  }
  expect(movedChild).not.toBe('');
  expect(JSON.parse(await readFile(join(beta, movedChild, 'merged.json'), 'utf8')).into).toBe(next);
  expect(await readFile(join(beta, movedChild, 'thread.jsonl'), 'utf8')).toContain(`(#/${next})`);
  const handle = createHandler(alpha, undefined, { projects: projects(), vaultDir: vault });
  const served = await handle(new Request(`http://local/__feedback/s/${shared.token}`));
  expect(served.status).toBe(200);
  expect(await served.text()).toContain('Notes');
});

test('a failed move leaves the thread in the source', async () => {
  const id = (await store.createThread(alpha, { title: 'Stay', text: 'Keep this', origin: 'user' })).id;
  await chmod(beta, 0o500);
  try {
    await expect(run(['move-project', id, 'beta'], alpha, undefined, env)).rejects.toThrow();
  } finally { await chmod(beta, 0o700); }
  const raw = await readFile(join(alpha, id, 'thread.jsonl'), 'utf8');
  expect(raw).toContain('Keep this');
  expect(raw).not.toContain('Moved from');
  expect(await readdir(beta)).not.toContain(id);
});

test('refuses one project, the same project, and an unknown project', async () => {
  const id = (await store.createThread(alpha, { title: 'Stay', text: 'Keep this', origin: 'user' })).id;
  await expect(run(['move-project', id, 'beta'], alpha, undefined, { FEEDBACK_DIR: alpha })).rejects.toThrow(/more than one project/);
  await expect(run(['move-project', id, 'alpha'], alpha, undefined, env)).rejects.toThrow(/already in that project/);
  await expect(run(['move-project', id, 'nope'], alpha, undefined, env)).rejects.toThrow(/Unknown project/);
  const one = createHandler(alpha);
  const refused = await one(new Request(`http://local/__feedback/api/threads/${id}/move-project`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'beta' }) }));
  expect(refused.status).toBe(409);
});

test('HTTP move-project moves the thread and a second call is idempotent', async () => {
  const id = (await store.createThread(alpha, { title: 'Over', text: 'Hello', origin: 'user' })).id;
  const handle = createHandler(alpha, undefined, { projects: projects(), vaultDir: vault });
  const post = (project: string) => handle(new Request(`http://local/__feedback/api/threads/${id}/move-project?project=alpha`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project }) }));
  const first = await (await post('beta')).json() as { moved: boolean; id: string; project: string; from: string };
  expect(first).toEqual({ moved: true, id, project: 'beta', from: 'alpha' });
  const second = await (await post('beta')).json() as { moved: boolean };
  expect(second.moved).toBe(false);
  expect((await post('nope')).status).toBe(404);
  expect((await store.summarise(beta, id)).summary.title).toBe('Over');
});

test('MCP move_project is registered, and a dry run writes nothing', async () => {
  const id = (await store.createThread(alpha, { title: 'Tool', text: 'Move me', origin: 'user' })).id;
  const before = await fingerprint(alpha);
  const server = createMcpServer({ dir: alpha, env });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(left), client.connect(right)]);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  expect(names).toContain('move_project');
  const dry = await client.callTool({ name: 'move_project', arguments: { id, project: 'beta', dry_run: true } }) as { isError?: boolean; structuredContent?: { dryRun?: boolean; id?: string } };
  expect(dry.isError).toBeFalsy();
  expect(dry.structuredContent?.dryRun).toBe(true);
  expect(dry.structuredContent?.id).toBe(id);
  expect(await fingerprint(alpha)).toBe(before);
  expect(await fingerprint(beta)).toBe('');
  const moved = await client.callTool({ name: 'move_project', arguments: { id, project: 'beta' } }) as { isError?: boolean; structuredContent?: { moved?: boolean } };
  expect(moved.isError).toBeFalsy();
  expect(moved.structuredContent?.moved).toBe(true);
  expect((await store.summarise(beta, id)).summary.title).toBe('Tool');
  await client.close();
});

test('moveThreadToProject reports the plan without writing on a dry run', async () => {
  const id = (await store.createThread(alpha, { title: 'Plan', text: 'Hello', origin: 'user' })).id;
  const result = await moveThreadToProject({ projects: projects(), from: 'alpha', to: 'beta', thread: id, dryRun: true, vault });
  expect(result.dryRun).toBe(true);
  expect(result.id).toBe(id);
  expect(await lstat(join(alpha, '_moves')).catch(() => null)).toBeNull();
});
