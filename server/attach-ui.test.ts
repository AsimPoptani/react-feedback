// The inbox's uploader and its streaming sha256, run against the real server handler.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from './server';
import { createSha256 } from './inbox/sha256.js';
import { UploadError, uploadFile } from './inbox/uploader.js';
import * as store from './store';

let dir: string;
let handle: ReturnType<typeof createHandler>;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'feedback-attach-ui-')); handle = createHandler(dir); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const route = (path: string) => `/__feedback/api/${path}`;
const send = (url: string, init?: RequestInit) => handle(new Request(new URL(url, 'http://local'), init));
const putVia = (log: string[], failAt: number[] = []) => async (url: string, blob: Blob) => {
  log.push(url);
  if (failAt.includes(log.length)) throw new UploadError('down', { network: true });
  const res = await send(url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(await blob.arrayBuffer()) }); // (a sliced Blob handed straight to an in-process Request reads past its end in Bun)
  return { status: res.status, body: await res.json().catch(() => null) };
};
const file = (bytes: Buffer, name = 'f.bin') => new File([bytes as BlobPart], name);

test('the streaming sha256 matches the real one for any length and any split', () => {
  for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 100_003]) {
    const data = randomBytes(n);
    const whole = createSha256(); whole.update(new Uint8Array(data));
    expect(whole.digest()).toBe(createHash('sha256').update(data).digest('hex'));
    const parts = createSha256();
    for (let at = 0; at < n; at += 37) parts.update(new Uint8Array(data.subarray(at, Math.min(n, at + 37))));
    expect(parts.digest()).toBe(createHash('sha256').update(data).digest('hex'));
  }
});
test('the uploader sends a file in chunks, reports progress, and finishes with the checksum', async () => {
  const data = randomBytes(3500);
  const log: string[] = [], seen: number[] = [];
  const done = await uploadFile({ file: file(data, 'a.bin'), route, fetch: send, put: putVia(log), chunk: 1000, onProgress: n => seen.push(n) });
  expect(log.map(u => u.split('offset=')[1])).toEqual(['0', '1000', '2000', '3000']);
  expect(seen.at(-1)).toBe(3500);
  expect(done).toMatchObject({ name: 'a.bin', size: 3500 });
  const { id } = await store.createThread(dir, { title: 't', text: 'x', origin: 'agent' });
  await store.appendMessage(dir, id, { author: 'user', text: 'f', attachments: [done.id] });
  expect(Buffer.compare(await readFile(join(dir, id, 'files', done.id, 'a.bin')), data)).toBe(0);
});
test('an interrupted upload resumes from the server\'s offset, not from the start', async () => {
  const data = randomBytes(4000);
  const log: string[] = [];
  let id = '';
  await expect(uploadFile({ file: file(data), route, fetch: send, put: putVia(log, [3, 4, 5, 6, 7, 8]), chunk: 1000, backoff: [0], wait: async () => {}, onId: x => { id = x; } })).rejects.toMatchObject({ network: true });
  expect(id).toMatch(/^u[0-9a-f]{16}$/);
  const where = await (await send(route(`uploads/${id}`))).json();
  expect(where.offset).toBe(2000);
  const log2: string[] = [];
  const done = await uploadFile({ file: file(data), route, fetch: send, put: putVia(log2), chunk: 1000, uploadId: id });
  expect(log2.map(u => u.split('offset=')[1])).toEqual(['2000', '3000']);
  expect(done.id).toBe(id);
});
test('the uploader surfaces the server\'s reason when it refuses', async () => {
  const refusing = createHandler(dir, undefined, { files: { env: { FEEDBACK_MAX_UPLOAD_BYTES: '10' } } });
  const via = (url: string, init?: RequestInit) => refusing(new Request(new URL(url, 'http://local'), init));
  await expect(uploadFile({ file: file(randomBytes(100)), route, fetch: via, put: async () => ({ status: 500, body: null }) })).rejects.toMatchObject({ status: 413 });
  const full = createHandler(dir, undefined, { files: { env: {}, disk: async () => ({ free: 1, total: 1e12 }) } });
  const viaFull = (url: string, init?: RequestInit) => full(new Request(new URL(url, 'http://local'), init));
  await expect(uploadFile({ file: file(randomBytes(100)), route, fetch: viaFull })).rejects.toThrow('Not enough disk space on the server');
});
test('cancelling stops an upload', async () => {
  const controller = new AbortController();
  const put = async (url: string, blob: Blob) => { controller.abort(); return putVia([])(url, blob); };
  await expect(uploadFile({ file: file(randomBytes(3000)), route, fetch: send, put, chunk: 1000, signal: controller.signal })).rejects.toMatchObject({ cancelled: true });
});
