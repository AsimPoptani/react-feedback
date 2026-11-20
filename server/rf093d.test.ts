import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moveThreadToProject } from './move-project';
import * as store from './store';

let root: string, alpha: string, beta: string;
const projects = () => [{ id: 'alpha', name: 'Alpha', dir: alpha }, { id: 'beta', name: 'Beta', dir: beta }];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rf093d-'));
  alpha = join(root, 'alpha'); beta = join(root, 'beta');
  await mkdir(alpha); await mkdir(beta);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test('a move changes neither last_message_at nor the list flag', async () => {
  const id = (await store.createThread(alpha, { title: 'Quiet', text: 'Start', origin: 'user' })).id;
  await store.appendMessage(alpha, id, { author: 'agent', text: 'Need a look', flag: 'needs_you' });
  await new Promise(resolve => setTimeout(resolve, 15));
  const before = (await store.summarise(alpha, id)).summary;
  await moveThreadToProject({ projects: projects(), from: 'alpha', to: 'beta', thread: id });
  const after = (await store.summarise(beta, id)).summary;
  expect(after.last_message_at).toBe(before.last_message_at);
  expect(after.last_flag).toBe(before.last_flag);
  expect(after.last_flag).toBe('needs_you');
  expect(after.waiting).toBe(before.waiting);
});
