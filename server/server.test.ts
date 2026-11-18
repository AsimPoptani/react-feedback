import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler, serverOptions } from './server';
let dir: string;
let handle: ReturnType<typeof createHandler>;
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const payload = () => ({ note: 'Needs work\nMore detail', mode: 'element', target: { selector: '#thing', tag: 'button', role: 'button', name: 'Hello', components: ['Card'], text: 'Hello', rect: { x: 1, y: 2, width: 3, height: 4 } }, image: png, annotated: png, context_image: png, context: { url: 'http://local/field', viewport: { width: 390, height: 844 }, console: [{ level: 'error', message: 'Oops' }], failedFetches: [{ method: 'GET', url: 'http://local/broken', status: 503 }] } });
const request = (path = '', data?: unknown) => new Request(`http://local/__feedback/api/items${path}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'feedback-')); handle = createHandler(dir); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
test('round trip writes files, lists replies and updates status', async () => {
  const response = await handle(request('', payload()));
  expect(response.status).toBe(201);
  const { id } = await response.json();
  expect(id).toMatch(/^\d{8}-\d{6}-[a-f0-9]{4}$/);
  const stored = JSON.parse(await readFile(join(dir, id, 'item.json'), 'utf8'));
  expect(stored.image).toBe('image.png');
  expect(stored.annotated).toBe('annotated.png'); expect(stored.context_image).toBe('context.png');
  expect(stored.note).toBe(payload().note); expect(stored.mode).toBe('element'); expect(stored.target).toEqual(payload().target);
  expect(stored.context).toEqual(payload().context);
  expect(JSON.stringify(stored)).not.toContain('base64');
  const markdown = await readFile(join(dir, id, 'feedback.md'), 'utf8');
  expect(markdown.startsWith(payload().note)).toBe(true);
  for (const content of ['Card', '#thing', 'Oops', 'GET http://local/broken: 503', '[image](image.png)', '[annotated](annotated.png)', '[context_image](context.png)']) expect(markdown).toContain(content);
  for (const file of ['image.png', 'annotated.png', 'context.png', 'feedback.md']) expect((await handle(request(`/${id}/${file}`))).status).toBe(200);
  await writeFile(join(dir, id, 'reply.md'), 'Fixed the spacing.\nDetails here.');
  expect((await handle(request(`/${id}/status`, { status: 'seen' }))).status).toBe(200);
  const [item] = await (await handle(request())).json();
  expect(item).toEqual({ id, created_at: stored.created_at, url: 'http://local/field', mode: 'element', note_first_line: 'Needs work', status: 'seen', reply: 'Fixed the spacing.\nDetails here.' });
  expect(item.status).toBe('seen'); expect(item.reply).toContain('Fixed the spacing.');
  for (const status of ['bad', ['seen'], null, 2]) expect((await handle(request(`/${id}/status`, { status }))).status).toBe(400);
});
test('newest first, including same-second items', async () => {
  const first = await (await handle(request('', payload()))).json();
  const second = await (await handle(request('', payload()))).json();
  const path = join(dir, first.id, 'item.json');
  const item = JSON.parse(await readFile(path, 'utf8')); item.created_at = '2000-01-01T00:00:00.000Z';
  await writeFile(path, JSON.stringify(item));
  expect((await (await handle(request())).json()).map((i: { id: string }) => i.id)).toEqual([second.id, first.id]);
});
test('rejects invalid images, modes, missing and oversized notes', async () => {
  for (const invalid of [{ image: 'data:image/png;base64,YmFk' }, { annotated: 'data:image/jpeg;base64,AAAA' }, { context_image: 'bad' }, { note: 'a'.repeat(10001) }, { note: '' }, { note: '   ' }, { note: null }, { note: 1 }, { mode: 'pick' }, { mode: null }, { mode: ['element'] }, { image: null }, { context: null }]) {
    expect((await handle(request('', { ...payload(), ...invalid }))).status).toBe(400);
  }
  expect((await handle(request('', { comment: 'old', pins: [], screenshot: png, context: {} }))).status).toBe(400);
});
test('all capture modes round trip with optional images omitted', async () => {
  for (const mode of ['region', 'element', 'section', 'page']) {
    const data = { ...payload(), mode, annotated: undefined, context_image: undefined, target: undefined };
    const response = await handle(request('', data)); expect(response.status).toBe(201);
    const { id } = await response.json();
    const stored = JSON.parse(await readFile(join(dir, id, 'item.json'), 'utf8'));
    expect(stored.mode).toBe(mode); expect(stored.image).toBe('image.png');
    expect(stored.annotated).toBeUndefined(); expect(stored.context_image).toBeUndefined();
    expect((await handle(request(`/${id}/annotated.png`))).status).toBe(404);
  }
});
test('ignores old, malformed and incomplete item folders', async () => {
  const valid = await (await handle(request('', payload()))).json();
  const invalid = [JSON.stringify({ comment: 'old', pins: [], context: { url: 'http://local' } }), '{broken', 'null', JSON.stringify({ note: 'hi', mode: 'bad', context: {} }), JSON.stringify({ note: 'hi', mode: 'page', context: {} })];
  for (let i = 0; i < invalid.length; i++) {
    const path = join(dir, `20261118-100000-000${i}`); await mkdir(path);
    await writeFile(join(path, 'item.json'), invalid[i]!);
  }
  await writeFile(join(dir, '20261118-100000-ffff'), 'not a directory');
  const response = await handle(request()); expect(response.status).toBe(200);
  const items = await response.json(); expect(items.map((item: { id: string }) => item.id)).toEqual([valid.id]);
});
test('binds to loopback despite shell HOST and supports explicit FEEDBACK_HOST', () => {
  expect(serverOptions({}).hostname).toBe('127.0.0.1'); expect(serverOptions({}).port).toBe(8099);
  expect(serverOptions({ HOST: 'lan.example' }).hostname).toBe('127.0.0.1');
  expect(serverOptions({ HOST: 'lan.example', FEEDBACK_HOST: '0.0.0.0', PORT: '9000' })).toMatchObject({ hostname: '0.0.0.0', port: 9000 });
});
for (const file of ['item.json', 'status.json']) {
  test(`skips an item with unreadable ${file} and still lists healthy items`, async () => {
    const healthy = await (await handle(request('', payload()))).json();
    const bad = await (await handle(request('', payload()))).json();
    const path = join(dir, bad.id, file);
    await chmod(path, 0);
    try {
      await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'EACCES' });
      const response = await handle(request()); expect(response.status).toBe(200);
      expect((await response.json()).map((item: { id: string }) => item.id)).toEqual([healthy.id]);
    } finally { await chmod(path, 0o600); }
  });
  for (const raw of ['{broken', 'null', '[]', '{}', '{"status":"unknown"}']) {
    test(`skips malformed ${file}: ${raw}`, async () => {
      const healthy = await (await handle(request('', payload()))).json();
      const bad = await (await handle(request('', payload()))).json();
      await writeFile(join(dir, bad.id, file), raw);
      const response = await handle(request()); expect(response.status).toBe(200);
      expect((await response.json()).map((item: { id: string }) => item.id)).toEqual([healthy.id]);
    });
  }
}
test('skips a non-directory entry matching the item id pattern', async () => {
  const healthy = await (await handle(request('', payload()))).json();
  await writeFile(join(dir, '20261118-100000-ffff'), 'not a directory');
  const response = await handle(request()); expect(response.status).toBe(200);
  expect((await response.json()).map((item: { id: string }) => item.id)).toEqual([healthy.id]);
});
test('caps declared and streamed bodies and requires JSON', async () => {
  expect((await handle(new Request('http://local/__feedback/api/items', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(26 * 1024 * 1024) }, body: '{}' }))).status).toBe(413);
  expect((await handle(request('', { note: 'a'.repeat(26 * 1024 * 1024) }))).status).toBe(413);
  expect((await handle(new Request('http://local/__feedback/api/items', { method: 'POST', body: '{}' }))).status).toBe(415);
});
test('bad ids, traversal, unknown routes and private files are inaccessible', async () => {
  const { id } = await (await handle(request('', payload()))).json();
  await writeFile(join(dir, id, 'reply.md'), 'Private reply');
  expect((await handle(request(`/${id}/image.png`))).status).toBe(200);
  for (const file of ['item.json', 'status.json', 'reply.md']) {
    expect(await readFile(join(dir, id, file), 'utf8')).toBeTruthy();
    expect((await handle(request(`/${id}/${file}`))).status).toBe(404);
  }
  for (const path of ['/bad/shot.png', '/%2e%2e%2f/shot.png', `/${id}/../../secret`]) expect((await handle(request(path))).status).toBe(404);
  expect((await handle(new Request('http://local/__feedback/healthz'))).status).toBe(200);
  expect((await handle(new Request('http://local/nope'))).status).toBe(404);
});
test('a repeated client_id returns the existing item, even when sent at once, and a bad one is a 400', async () => {
  const data = { ...payload(), client_id: 'a1b2c3d4-e5f6' };
  const first = await handle(request('', data));
  expect(first.status).toBe(201);
  const { id } = await first.json();
  const again = await handle(request('', data));
  expect(again.status).toBe(200); expect((await again.json()).id).toBe(id);
  const [x, y] = await Promise.all([handle(request('', { ...data, client_id: 'z9y8x7w6-v5u4' })), handle(request('', { ...data, client_id: 'z9y8x7w6-v5u4' }))]);
  expect((await x.json()).id).toBe((await y.json()).id);
  expect((await (await handle(request())).json())).toHaveLength(2);
  expect(JSON.parse(await readFile(join(dir, id, 'item.json'), 'utf8')).client_id).toBe('a1b2c3d4-e5f6');
  for (const client_id of ['short', 5, 'has space in it!', 'a'.repeat(65)]) expect((await handle(request('', { ...data, client_id }))).status).toBe(400);
  const other = await (await handle(request('', { ...payload(), client_id: 'a1b2c3d4-0000' }))).json();
  expect(other.id).not.toBe(id);
});
test('a repeated client_id makes one folder, one thread message and one _events line, sent in sequence or at once', async () => {
  const lines = async (path: string) => (await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const { readdir } = await import('node:fs/promises');
  const sequential = { ...payload(), client_id: 'seq-client-0001' }, concurrent = { ...payload(), client_id: 'con-client-0002' };
  const first = await (await handle(request('', sequential))).json();
  const again = await (await handle(request('', sequential))).json();
  const pair = await Promise.all([1, 2, 3].map(async () => (await handle(request('', concurrent))).json()));
  expect(again.id).toBe(first.id); expect(new Set(pair.map(item => item.id)).size).toBe(1);
  const folders = (await readdir(dir)).filter(name => /^\d{8}-\d{6}-/.test(name));
  expect(folders).toHaveLength(2);
  for (const id of [first.id, pair[0]!.id]) expect(await lines(join(dir, id, 'thread.jsonl'))).toHaveLength(1);
  const events = (await lines(join(dir, '_events.jsonl'))).map(line => JSON.parse(line));
  expect(events.map(event => event.id).sort()).toEqual([first.id, pair[0]!.id].sort());
});
