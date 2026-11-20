import { afterEach, beforeEach, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { run } from './cli';
import { createMcpServer } from './mcp';
import { moveThreadToProject } from './move-project';
import { createHandler } from './server';
import * as store from './store';

let root: string, alpha: string, beta: string, env: Record<string, string | undefined>;
const projects = () => [{ id: 'alpha', name: 'Alpha', dir: alpha }, { id: 'beta', name: 'Beta', dir: beta }];
const exists = (path: string) => lstat(path).then(() => true, () => false);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rf093c-'));
  alpha = join(root, 'alpha'); beta = join(root, 'beta');
  await mkdir(alpha); await mkdir(beta);
  env = { FEEDBACK_PROJECTS: JSON.stringify(projects()), FEEDBACK_DIR: alpha };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test('a merged child cannot be moved alone: CLI, MCP and HTTP refuse', async () => {
  const parent = (await store.createThread(alpha, { title: 'The parent', text: 'Keep', origin: 'user' })).id;
  const child = (await store.createThread(alpha, { title: 'The child', text: 'Fold', origin: 'user' })).id;
  await store.mergeThreads(alpha, child, parent, 'agent');
  await expect(run(['move-project', child, 'beta'], alpha, undefined, env)).rejects.toThrow(/merged into The parent; move that one instead/);
  const server = createMcpServer({ dir: alpha, env });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(left), client.connect(right)]);
  const refused = await client.callTool({ name: 'move_project', arguments: { id: child, project: 'beta' } }) as { isError?: boolean; content?: { text?: string }[] };
  expect(refused.isError).toBe(true);
  expect(refused.content?.[0]?.text).toContain('move that one instead');
  await client.close();
  const handle = createHandler(alpha, undefined, { projects: projects() });
  const res = await handle(new Request(`http://local/__feedback/api/threads/${child}/move-project`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'beta' }) }));
  expect(res.status).toBe(409);
  expect(JSON.stringify(await res.json())).toContain('move that one instead');
  expect(await exists(join(beta, child))).toBe(false);
  expect((await moveThreadToProject({ projects: projects(), from: 'alpha', to: 'beta', thread: parent })).moved).toBe(true);
  expect(await exists(join(beta, child))).toBe(true);
});
