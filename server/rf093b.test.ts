import { afterEach, beforeEach, expect, test } from 'bun:test';
import { appendFile, cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishArtifact } from './artifacts';
import { moveThreadToProject } from './move-project';
import * as store from './store';

let root: string, alpha: string, beta: string, _env: Record<string, string | undefined>;
const projects = () => [{ id: 'alpha', name: 'Alpha', dir: alpha }, { id: 'beta', name: 'Beta', dir: beta }];
const exists = (path: string) => lstat(path).then(() => true, () => false);
const text = async (dir: string, id: string) => readFile(join(dir, id, 'thread.jsonl'), 'utf8');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rf093b-'));
  alpha = join(root, 'alpha'); beta = join(root, 'beta');
  await mkdir(alpha); await mkdir(beta);
  _env = { FEEDBACK_PROJECTS: JSON.stringify(projects()), FEEDBACK_DIR: alpha };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test('a move that fails after the threads are placed leaves the target clean, and a retry carries a later message', async () => {
  const id = (await store.createThread(alpha, { title: 'Atomic', text: 'First', origin: 'user' })).id;
  await publishArtifact(alpha, { thread: id, title: 'Notes', content: '<p>Notes</p>', format: 'html' });
  await mkdir(join(beta, '_artifacts'), { recursive: true });
  await writeFile(join(beta, '_artifacts', '.incoming'), 'in the way');
  await expect(moveThreadToProject({ projects: projects(), from: 'alpha', to: 'beta', thread: id })).rejects.toThrow();
  expect(await exists(join(beta, id))).toBe(false);
  expect((await readdir(join(beta, '_artifacts'))).filter(name => name !== '.incoming')).toEqual([]);
  expect(await text(alpha, id)).toContain('First');
  expect(await text(alpha, id)).not.toContain('Moved from');
  await store.appendMessage(alpha, id, { author: 'user', text: 'Posted in between', });
  await rm(join(beta, '_artifacts', '.incoming'), { force: true });
  const result = await moveThreadToProject({ projects: projects(), from: 'alpha', to: 'beta', thread: id });
  expect(result.moved).toBe(true);
  expect(await text(beta, id)).toContain('Posted in between');
  expect(await exists(join(alpha, id))).toBe(false);
  expect((await readdir(join(beta, '_artifacts'))).length).toBe(1);
});

test('a stale target copy from an interrupted attempt is replaced from the source, not trusted', async () => {
  const id = (await store.createThread(alpha, { title: 'Stale', text: 'First', origin: 'user' })).id;
  await cp(join(alpha, id), join(beta, id), { recursive: true });
  await appendFile(join(beta, id, 'thread.jsonl'), `${JSON.stringify({ id: 'm9', author: 'agent', text: 'Moved from Alpha', images: [], created_at: new Date().toISOString(), divider: true })}\n`);
  await store.appendMessage(alpha, id, { author: 'user', text: 'Posted after the copy' });
  await moveThreadToProject({ projects: projects(), from: 'alpha', to: 'beta', thread: id });
  const raw = await text(beta, id);
  expect(raw).toContain('Posted after the copy');
  expect(raw.split('\n').filter(line => line.includes('Moved from Alpha')).length).toBe(1);
  expect(await exists(join(alpha, id))).toBe(false);
});
