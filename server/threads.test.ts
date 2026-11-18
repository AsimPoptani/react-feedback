import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from './server';
import { run } from './cli';
import * as store from './store';

let dir: string;
let handle: ReturnType<typeof createHandler>;
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const jpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3]).toString('base64')}`;
const webp = `data:image/webp;base64,${Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]).toString('base64')}`;
const api = (path: string, data?: unknown) => new Request(`http://local/__feedback/api/${path}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const capture = () => ({ note: 'Spacing is off\nMore', mode: 'element', image: png, context: { url: 'http://local/x', viewport: { width: 1, height: 1 } } });
const events = async () => (await readFile(join(dir, '_events.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'feedback-threads-')); handle = createHandler(dir); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test('a capture starts a thread with the note; user and agent messages round-trip through server and CLI', async () => {
  const { id } = await (await handle(api('items', capture()))).json();
  let detail = await (await handle(api(`threads/${id}`))).json();
  expect(detail.messages).toMatchObject([{ id: 'm1', author: 'user', text: 'Spacing is off\nMore' }]);
  expect(detail.files).toEqual({ image: true, annotated: false, context: false });
  expect(detail.url).toBe('http://local/x');

  const sent = await handle(api(`threads/${id}/messages`, { text: 'Look at this', images: [png, jpeg, webp] }));
  expect(sent.status).toBe(201);
  expect((await sent.json()).images).toEqual(['msg-1.png', 'msg-2.jpg', 'msg-3.webp']);
  const image = await handle(api(`items/${id}/msg-2.jpg`));
  expect(image.status).toBe(200); expect(image.headers.get('content-type')).toBe('image/jpeg');

  const picture = join(dir, 'pic.png'); await writeFile(picture, Buffer.from(png.split(',')[1]!, 'base64'));
  expect(await run(['reply', id, 'Here is a proposal', '--image', picture], dir)).toContain(`Replied to ${id}`);
  detail = await (await handle(api(`threads/${id}`))).json();
  expect(detail.messages.map((m: { author: string; text: string }) => [m.author, m.text])).toEqual([['user', 'Spacing is off\nMore'], ['user', 'Look at this'], ['agent', 'Here is a proposal']]);
  expect(detail.messages[2].images).toEqual(['msg-4.png']);
  expect((await handle(api(`items/${id}/msg-4.png`))).status).toBe(200);
  // The file on disk is plain jsonl a human can read.
  const lines = (await readFile(join(dir, id, 'thread.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  expect(Object.keys(lines[2]).sort()).toEqual(['author', 'created_at', 'flag', 'id', 'images', 'text']);
});

test('reply.md migrates to one agent message dated from its mtime, without rewriting files', async () => {
  const { id } = await (await handle(api('items', capture()))).json();
  await rm(join(dir, id, 'thread.jsonl')); // an old item, from before threads
  const old = JSON.parse(await readFile(join(dir, id, 'item.json'), 'utf8')); old.created_at = '2026-11-17T09:00:00.000Z';
  await writeFile(join(dir, id, 'item.json'), JSON.stringify(old));
  await writeFile(join(dir, id, 'reply.md'), 'Fixed.\n');
  await utimes(join(dir, id, 'reply.md'), new Date('2026-11-17T10:00:00Z'), new Date('2026-11-17T10:00:00Z'));
  const detail = await (await handle(api(`threads/${id}`))).json();
  expect(detail.messages.map((m: { author: string; created_at: string }) => [m.author, m.created_at.slice(0, 10)])).toEqual([['user', '2026-11-17'], ['agent', '2026-11-17']]);
  expect(detail.messages[1].text).toBe('Fixed.');
  expect((await readdir(join(dir, id))).includes('thread.jsonl')).toBe(false); // read does not write
  await run(['reply', id, 'Another thing'], dir);
  const after = await (await handle(api(`threads/${id}`))).json();
  expect(after.messages.map((m: { text: string }) => m.text)).toEqual(['Spacing is off\nMore', 'Fixed.', 'Another thing']);
  expect(await readFile(join(dir, id, 'reply.md'), 'utf8')).toBe('Fixed.\n');
});

test('new threads from the inbox and from the agent', async () => {
  const user = await (await handle(api('threads', { title: 'Colours', text: 'Too loud', images: [png] }))).json();
  const item = JSON.parse(await readFile(join(dir, user.id, 'item.json'), 'utf8'));
  expect(item).toMatchObject({ mode: 'thread', title: 'Colours', origin: 'user' });
  expect((await readdir(join(dir, user.id))).includes('image.png')).toBe(false);
  const out = await run(['new', 'Idea', 'What about this?', '--needs-you'], dir);
  const agentId = out.replace('Started ', '');
  const list = await (await handle(api('threads'))).json();
  expect(list.map((t: { title: string; origin: string; last_author: string }) => [t.title, t.origin, t.last_author]).sort()).toEqual([['Colours', 'user', 'user'], ['Idea', 'agent', 'agent']]);
  expect(list.find((t: { id: string }) => t.id === agentId).unread_for_user).toBe(true);
  // thread-mode items never appear in the widget's list
  expect(await (await handle(api('items'))).json()).toEqual([]);
});

test('validation rejects bad input', async () => {
  const { id } = await (await handle(api('items', capture()))).json();
  const bad = [
    { text: '' }, { text: '   ' }, { text: 1 }, { text: 'a'.repeat(10001) }, { text: 'x', images: 'no' },
    { text: 'x', images: [png, png, png, png, png, png] },
    { text: 'x', images: ['data:image/gif;base64,R0lGODlh'] },
    { text: 'x', images: [`data:image/png;base64,${Buffer.from('not a png at all').toString('base64')}`] },
    { text: 'x', images: [jpeg.replace('jpeg', 'png')] },
    { text: 'x', images: ['data:image/png;base64,***'] },
  ];
  for (const data of bad) expect((await handle(api(`threads/${id}/messages`, data))).status).toBe(400);
  expect((await handle(api(`threads/${id}/messages`, { text: '', images: [png] }))).status).toBe(201); // image-only is fine
  for (const data of [{ title: '', text: 'x' }, { title: 'a'.repeat(201), text: 'x' }, { title: 'T', text: '' }, { title: 5, text: 'x' }]) expect((await handle(api('threads', data))).status).toBe(400);
  for (const status of ['bad', null, 3]) expect((await handle(api(`threads/${id}/status`, { status }))).status).toBe(400);
  expect((await handle(api(`threads/${id}/status`, { status: 'done' }))).status).toBe(200);
  expect((await handle(api('threads/20990101-000000-ffff'))).status).toBe(404);
  expect((await handle(api('threads/nope/messages', { text: 'x' }))).status).toBe(404);
  const big = `data:image/png;base64,${Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(10 * 1024 * 1024)]).toString('base64')}`;
  expect((await handle(api(`threads/${id}/messages`, { text: 'x', images: [big] }))).status).toBe(413);
  expect((await handle(new Request(`http://local/__feedback/api/threads/${id}/messages`, { method: 'POST', body: '{}' }))).status).toBe(415);
  expect((await handle(api('threads', { title: 'a', text: 'b'.repeat(26 * 1024 * 1024) }))).status).toBe(413);
});

test('the file allowlist grows to msg-<n>.<ext> only, and traversal is refused', async () => {
  const { id } = await (await handle(api('items', capture()))).json();
  await handle(api(`threads/${id}/messages`, { text: 'x', images: [png] }));
  await writeFile(join(dir, id, 'msg-9.gif'), 'x'); await writeFile(join(dir, id, 'thread.jsonl.bak'), 'x');
  for (const name of ['msg-1.png']) expect((await handle(api(`items/${id}/${name}`))).status).toBe(200);
  for (const name of ['msg-9.gif', 'thread.jsonl', 'read.json', 'msg-1.png.bak', 'msg-.png', '..%2Fitem.json', 'MSG-1.png']) expect((await handle(api(`items/${id}/${name}`))).status).toBe(404);
  for (const path of [`items/${id}/..%2F..%2Fsecret`, 'items/..%2F../msg-1.png', 'threads/..%2F..', 'threads/%2e%2e']) expect((await handle(api(path))).status).toBe(404);
});

test('_events.jsonl records user messages and threads only', async () => {
  const { id } = await (await handle(api('items', capture()))).json();
  await handle(api(`threads/${id}/messages`, { text: 'Second line\nmore' }));
  await handle(api('threads', { title: 'Topic', text: 'Hello' }));
  await run(['reply', id, 'agent words'], dir); await run(['new', 'Agent topic', 'x'], dir); await run(['status', id, 'done'], dir);
  await handle(api(`threads/${id}/status`, { status: 'seen' })); await handle(api(`threads/${id}/read`, {}));
  const lines = await events();
  expect(lines.map(l => [l.kind, l.author, l.first_line])).toEqual([['thread', 'user', 'Spacing is off'], ['message', 'user', 'Second line'], ['thread', 'user', 'Topic: Hello']]);
  expect(lines[0]).toMatchObject({ id }); expect(typeof lines[0].ts).toBe('string');
});

test('unread logic: agent spoke last and the user has not opened it since', async () => {
  const { id } = await (await handle(api('items', capture()))).json();
  const unread = async () => (await (await handle(api('threads'))).json())[0].unread_for_user;
  expect(await unread()).toBe(false);
  await run(['reply', id, 'fyi only'], dir);
  expect(await unread()).toBe(false); // an fyi never makes a thread unread
  await run(['reply', id, 'hi', '--needs-you'], dir);
  expect(await unread()).toBe(true);
  await new Promise(r => setTimeout(r, 5));
  expect((await handle(api(`threads/${id}/read`, {}))).status).toBe(200);
  expect(await unread()).toBe(false);
  await new Promise(r => setTimeout(r, 5));
  await run(['reply', id, 'again', '--needs-you'], dir);
  expect(await unread()).toBe(true);
  await new Promise(r => setTimeout(r, 5));
  await handle(api(`threads/${id}/messages`, { text: 'ok' }));
  expect(await unread()).toBe(false);
});

test('status is open or done, the inbox shows who is waiting, newest activity sorts first, and CLI list --waiting shows user-last threads', async () => {
  const a = await (await handle(api('items', capture()))).json();
  await new Promise(r => setTimeout(r, 5));
  const b = await (await handle(api('threads', { title: 'Second', text: 'b' }))).json();
  await new Promise(r => setTimeout(r, 5));
  await run(['reply', a.id, 'answer', '--needs-you'], dir);
  expect((await store.listThreads(dir)).map(t => t.id)).toEqual([a.id, b.id]);
  expect((await store.listThreads(dir))[0]).toMatchObject({ status: 'open', waiting: 'you' }); // the agent spoke last
  expect((await store.listThreads(dir))[1]).toMatchObject({ status: 'open', waiting: 'agent' });
  await run(['status', a.id, 'done'], dir);
  await handle(api(`threads/${a.id}/messages`, { text: 'reopen please' }));
  expect(await (await handle(api(`threads/${a.id}`))).json()).toMatchObject({ status: 'open', waiting: 'agent' }); // a user message reopens
  const out = await run(['list', '--waiting'], dir);
  expect(await run(['list', '--unread'], dir)).toBe(out); // old flag, same list
  expect(out).toContain(a.id); expect(out).toContain(b.id);
  await run(['reply', b.id, 'done here'], dir); await run(['status', a.id, 'done'], dir);
  expect(await run(['list', '--waiting'], dir)).toBe('Nothing is waiting for the agent.');
  await run(['status', a.id, 'seen'], dir); // an alias for open
  expect((await store.listThreads(dir)).find(t => t.id === a.id)!.status).toBe('open');
  await writeFile(join(dir, a.id, 'status.json'), JSON.stringify({ status: 'seen' })); // old stored values migrate on read
  expect((await store.listThreads(dir)).find(t => t.id === a.id)!.status).toBe('open');
  await writeFile(join(dir, a.id, 'status.json'), JSON.stringify({ status: 'new' }));
  expect((await store.listThreads(dir)).find(t => t.id === a.id)!.status).toBe('open');
  expect(await run(['list'], dir)).toContain('Second');
});

test('CLI rejects bad usage and bad images', async () => {
  const { id } = await (await handle(api('items', capture()))).json();
  await mkdir(join(dir, 'x'));
  await writeFile(join(dir, 'x', 'bad.png'), 'not an image'); await writeFile(join(dir, 'x', 'ok.png'), Buffer.from(png.split(',')[1]!, 'base64'));
  for (const argv of [[], ['nope'], ['reply', id], ['status', id, 'bad'], ['status', id, 'new-ish'], ['reply', id, 'x', '--image', join(dir, 'x', 'bad.png')], ['reply', id, 'x', '--image', join(dir, 'x', 'missing.png')], ['reply', 'bad-id', 'x']]) {
    await expect(run(argv, dir)).rejects.toBeInstanceOf(store.Invalid);
  }
  const six = Array.from({ length: 6 }, () => ['--image', join(dir, 'x', 'ok.png')]).flat();
  await expect(run(['reply', id, 'x', ...six], dir)).rejects.toBeInstanceOf(store.Invalid);
});

test('inbox is served with the right types, and unknown inbox files are 404', async () => {
  const html = await handle(new Request('http://local/__feedback/inbox/'));
  expect(html.status).toBe(200); expect(html.headers.get('content-type')).toContain('text/html'); expect(html.headers.get('cache-control')).toBe('no-store');
  const js = await handle(new Request('http://local/__feedback/inbox/app.js'));
  expect(js.headers.get('content-type')).toContain('text/javascript');
  expect((await handle(new Request('http://local/__feedback/inbox'))).status).toBe(308);
  for (const name of ['../server.ts', 'store.ts', '..%2Fserver.ts', 'x.html']) expect((await handle(new Request(`http://local/__feedback/inbox/${name}`))).status).toBe(404);
});
