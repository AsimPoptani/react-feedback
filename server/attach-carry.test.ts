// biome-ignore-all lint/suspicious/noExplicitAny: the tests read loose JSON
// 0.9.4 on top of 0.9.3: files follow a message through a post to a merged thread, a move to another project, and a redacted message's vault entry.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moveThreadToProject } from './move-project';
import { createHandler } from './server';
import { redactMessage, unredactMessage } from './sensitive';
import * as store from './store';

let root: string, alpha: string, beta: string, vault: string;
let handle: ReturnType<typeof createHandler>;
const projects = () => [{ id: 'alpha', name: 'Alpha', dir: alpha }, { id: 'beta', name: 'Beta', dir: beta }];
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const url = (path: string) => `http://local/__feedback/${path}`;
const json = (path: string, method: string, data?: unknown) => new Request(url(path), { method, headers: { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
const exists = (path: string) => stat(path).then(() => true, () => false);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'attach-carry-'));
  alpha = join(root, 'alpha'); beta = join(root, 'beta'); vault = join(root, 'vault');
  await mkdir(alpha); await mkdir(beta);
  handle = createHandler(alpha, undefined, { vaultDir: vault });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function upload(bytes: Buffer, name: string): Promise<string> {
  const made = await (await handle(json('api/uploads', 'POST', { name, size: bytes.length }))).json() as any;
  const put = await handle(new Request(url(`api/uploads/${made.id}?offset=0`), { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes as unknown as BodyInit }));
  expect(put.status).toBe(200);
  expect((await handle(json(`api/uploads/${made.id}/finalise`, 'POST', { sha256: sha(bytes) }))).status).toBe(200);
  return made.id;
}
const thread = async (title: string) => (await store.createThread(alpha, { title, text: 'Start', origin: 'agent' })).id;

test('a post with a file to a thread that was already merged lands on the target, file included', async () => {
  const a = await thread('A'), b = await thread('B');
  await store.mergeThreads(alpha, a, b, 'agent');
  const id = await upload(Buffer.from('after the merge'), 'late.txt');
  const res = await handle(json(`api/threads/${a}/messages`, 'POST', { text: 'still sending', attachments: [id] }));
  expect(res.status).toBe(201);
  const message = await res.json() as any;
  expect(message.forwarded_to).toBe(b);
  expect(message.attachments).toEqual([expect.objectContaining({ id, name: 'late.txt', by: 'user' })]);
  expect(await readFile(join(alpha, b, 'files', id, 'late.txt'), 'utf8')).toBe('after the merge');
  expect(await exists(join(alpha, a, 'files', id))).toBe(false);
  expect((await handle(new Request(url(`api/threads/${b}/attachments/${id}`)))).status).toBe(200);
  expect(await exists(join(alpha, '_uploads', id))).toBe(false);
});

test('a move to another project brings the files, and a redacted message keeps its vault files under the new key', async () => {
  const id = await thread('Mover');
  const open = await upload(Buffer.from('plain bytes'), 'plain.txt');
  const secret = await upload(Buffer.from('private bytes'), 'private.txt');
  const plain = await (await handle(json(`api/threads/${id}/messages`, 'POST', { text: 'open file', attachments: [open] }))).json() as any;
  const hidden = await (await handle(json(`api/threads/${id}/messages`, 'POST', { text: 'sensitive file', attachments: [secret] }))).json() as any;
  expect((await redactMessage(alpha, id, hidden.id, { by: 'user', vault })).redacted).toBe(true);
  expect(await readFile(join(vault, id, `${hidden.id}.files`, secret, 'private.txt'), 'utf8')).toBe('private bytes');
  const result = await moveThreadToProject({ projects: projects(), from: 'alpha', to: 'beta', thread: id, vault });
  expect(result.moved).toBe(true);
  expect(await readFile(join(beta, id, 'files', open, 'plain.txt'), 'utf8')).toBe('plain bytes');
  expect((await store.summarise(beta, id)).messages.find(m => m.id === plain.id)?.attachments?.[0]?.name).toBe('plain.txt');
  expect(await readFile(join(vault, 'beta', id, `${hidden.id}.files`, secret, 'private.txt'), 'utf8')).toBe('private bytes');
  expect(await exists(join(vault, id, `${hidden.id}.files`))).toBe(false);
  const back = await unredactMessage(beta, id, hidden.id, vault);
  expect(back.restored).toBe(true);
  expect((await store.summarise(beta, id)).messages.find(m => m.id === hidden.id)?.attachments?.[0]?.name).toBe('private.txt');
  expect(await readFile(join(beta, id, 'files', secret, 'private.txt'), 'utf8')).toBe('private bytes');
});
