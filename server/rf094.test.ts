import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneAttachments, copyVaultFiles, stagePath } from './files';
import * as store from './store';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'rf094-')); });
afterEach(async () => { await chmod(root, 0o755).catch(() => undefined); await rm(root, { recursive: true, force: true }); });

const exists = async (p: string) => { try { await stat(p); return true; } catch { return false; } };
async function staged(name = 'a.txt'): Promise<string> {
  const src = join(root, name);
  await writeFile(src, 'hello');
  return (await stagePath(root, src, 'user')).id;
}

test('a failed append puts the upload back, meta and all, and the same id can be sent again', async () => {
  const id = (await store.createThread(root, { title: 'T', text: 'x', origin: 'user' })).id;
  const up = await staged();
  const log = join(root, id, 'thread.jsonl');
  await chmod(log, 0o444);
  await expect(store.appendMessage(root, id, { author: 'user', text: 'with file', attachments: [up] })).rejects.toThrow();
  await chmod(log, 0o644);
  expect(await exists(join(root, '_uploads', up, 'file'))).toBe(true);
  expect(await exists(join(root, '_uploads', up, 'meta.json'))).toBe(true);
  expect(await exists(join(root, id, 'files', up))).toBe(false);
  const sent = await store.appendMessage(root, id, { author: 'user', text: 'again', attachments: [up] });
  expect(sent.attachments?.[0]?.id).toBe(up);
  expect(await readFile(join(root, id, 'files', up, 'a.txt'), 'utf8')).toBe('hello');
  expect(await exists(join(root, '_uploads', up))).toBe(false);
});

test('a failure while saving images strands no file and keeps the upload', async () => {
  const id = (await store.createThread(root, { title: 'T', text: 'x', origin: 'user' })).id;
  const up = await staged();
  await expect(store.appendMessage(root, id, { author: 'user', text: 'pic', attachments: [up], images: [{ ext: 'x/y', bytes: Buffer.from('p') }] as never })).rejects.toThrow();
  expect(await exists(join(root, '_uploads', up, 'meta.json'))).toBe(true);
  expect(await exists(join(root, id, 'files'))).toBe(false);
  expect((await readdir(join(root, id))).filter(n => n.startsWith('msg-'))).toEqual([]);
});

test('the vault copy links when it can and redoes a leftover partial file', async () => {
  const vault = join(root, 'vault');
  await mkdir(join(vault, 'old.files', 'id1'), { recursive: true });
  await writeFile(join(vault, 'old.files', 'id1', 'f.bin'), 'complete content');
  const links: string[] = [];
  await copyVaultFiles(vault, 'old', 'new', { link: async (from, to) => { links.push(to); await (await import('node:fs/promises')).link(from, to); } });
  expect(links).toEqual([join(vault, 'new.files', 'id1', 'f.bin')]);
  expect(await readFile(join(vault, 'new.files', 'id1', 'f.bin'), 'utf8')).toBe('complete content');

  // An interrupted run left a partial; the link is refused so the copy path runs.
  await rm(join(vault, 'new.files'), { recursive: true });
  await mkdir(join(vault, 'new.files', 'id1'), { recursive: true });
  await writeFile(join(vault, 'new.files', 'id1', 'f.bin.part'), 'compl');
  const refuse = async () => { throw new Error('EXDEV'); };
  await copyVaultFiles(vault, 'old', 'new', { link: refuse });
  expect(await readFile(join(vault, 'new.files', 'id1', 'f.bin'), 'utf8')).toBe('complete content');
  expect(await readdir(join(vault, 'new.files', 'id1'))).toEqual(['f.bin']);

  // A stale .part beside a finished file is cleaned and the finished file is kept.
  await writeFile(join(vault, 'new.files', 'id1', 'f.bin.part'), 'junk');
  await copyVaultFiles(vault, 'old', 'new', { link: refuse });
  expect(await readdir(join(vault, 'new.files', 'id1'))).toEqual(['f.bin']);
});

test('cloneAttachments copies through a .part file and redoes a leftover one', async () => {
  const from = join(root, 'a'), to = join(root, 'b');
  const att = { id: 'abcdefabcdefabcdefabcdefabcdefab', name: 'n.txt', size: 4, sha256: 'x', type: 'text/plain', by: 'user' as const, at: '' };
  await mkdir(join(from, 'files', att.id), { recursive: true });
  await writeFile(join(from, 'files', att.id, att.name), 'full');
  await mkdir(join(to, 'files', att.id), { recursive: true });
  await writeFile(join(to, 'files', att.id, `${att.name}.part`), 'fu');
  await cloneAttachments(from, to, [att], { link: async () => { throw new Error('EXDEV'); }, disk: async () => ({ free: 1e12, total: 2e12 }) });
  expect(await readFile(join(to, 'files', att.id, att.name), 'utf8')).toBe('full');
  expect(await readdir(join(to, 'files', att.id))).toEqual([att.name]);
});
