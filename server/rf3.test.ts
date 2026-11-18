import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from './server';
import { run } from './cli';
import * as store from './store';
import { isReplySwipe, resolveQuote, snippetOf } from './inbox/quote.js';

let dir: string;
let handle: ReturnType<typeof createHandler>;
const api = (path: string, data?: unknown) => new Request(`http://local/__feedback/api/${path}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'feedback-rf3-')); handle = createHandler(dir); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const start = async (title = 'T', text = 'first') => (await store.createThread(dir, { title, text, origin: 'user' })).id;
const detail = async (id: string) => (await (await handle(api(`threads/${id}`))).json());

test('a message can quote an earlier one; the API returns reply_to and a plain message has none', async () => {
  const id = await start();
  const sent = await handle(api(`threads/${id}/messages`, { text: 'second', reply_to: 'm1' }));
  expect(sent.status).toBe(201);
  expect((await sent.json()).reply_to).toBe('m1');
  await handle(api(`threads/${id}/messages`, { text: 'plain', reply_to: null }));
  const d = await detail(id);
  expect(d.messages.map((m: { reply_to?: string }) => m.reply_to)).toEqual([undefined, 'm1', undefined]);
  expect('reply_to' in d.messages[0]).toBe(false);
});

test('reply_to must name an existing message of the same thread, else 400 and nothing is stored', async () => {
  const a = await start('A'), b = await start('B');
  await store.appendMessage(dir, b, { author: 'user', text: 'only in B' });
  for (const bad of ['m9', '', 7, 'm2', {}]) {
    const r = await handle(api(`threads/${a}/messages`, { text: 'x', reply_to: bad }));
    expect(r.status).toBe(400);
  }
  expect((await detail(a)).messages).toHaveLength(1);
});

test('the agent can quote the user, through the CLI, and read prints the quoted context', async () => {
  const id = await start('T', 'Which colour?\nsecond line');
  expect(await run(['reply', id, 'Teal.', '--to', 'm1'], dir)).toContain('Replied');
  expect((await detail(id)).messages[1].reply_to).toBe('m1');
  await expect(run(['reply', id, 'x', '--to', 'm7'], dir)).rejects.toThrow('reply_to');
  await expect(run(['reply', id, 'x', '--to'], dir)).rejects.toThrow('--to needs a value');
  await store.appendMessage(dir, id, { author: 'user', text: '', images: [store.dataUrlImage(png)], reply_to: 'm2' });
  const out = await run(['read', id], dir);
  expect(out.split('\n')[0]).toBe(`Marked ${id} read`);
  expect(out).toContain('(replying to m1, user: "Which colour?")');
  expect(out).toContain('(replying to m2, agent: "Teal.")');
  expect(out).toContain('second line');
});

test('a quote changes nothing about waiting or unread', async () => {
  const id = await start();
  await store.appendMessage(dir, id, { author: 'agent', text: 'hi', flag: 'fyi' });
  const before = (await store.summarise(dir, id)).summary.waiting;
  await store.appendMessage(dir, id, { author: 'user', text: 'ok', reply_to: 'm2' });
  expect(before).toBe('idle');
  expect((await store.summarise(dir, id)).summary.waiting).toBe('agent');
  await store.appendMessage(dir, id, { author: 'agent', text: 'done', reply_to: 'm3', flag: 'fyi' });
  expect((await store.summarise(dir, id)).summary.waiting).toBe('idle');
});

test('the user event line carries reply_to only when there is one', async () => {
  const id = await start();
  await store.appendMessage(dir, id, { author: 'user', text: 'a', reply_to: 'm1' });
  await store.appendMessage(dir, id, { author: 'user', text: 'b' });
  const lines = (await readFile(join(dir, '_events.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  expect(lines.map(l => l.reply_to)).toEqual([undefined, 'm1', undefined]);
});

test('a merge keeps reply_to links, remapped to the renumbered ids', async () => {
  const from = await start('From', 'src one');
  await store.appendMessage(dir, from, { author: 'agent', text: 'src two', flag: 'fyi', reply_to: 'm1' });
  await store.appendMessage(dir, from, { author: 'user', text: 'src three', reply_to: 'm2' });
  const into = await start('Into', 'tgt one');
  await store.appendMessage(dir, into, { author: 'user', text: 'tgt two', reply_to: 'm1' });
  await store.mergeThreads(dir, from, into, 'user');
  const msgs = (await detail(into)).messages as { id: string; text: string; reply_to?: string }[];
  expect(msgs.map(m => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
  const by = (t: string) => msgs.find(m => m.text === t)!;
  expect(by('tgt two').reply_to).toBe('m1');
  expect(by('src two').reply_to).toBe(by('src one').id);
  expect(by('src three').reply_to).toBe(by('src two').id);
  expect(by('src one').reply_to).toBeUndefined();
  // and the source thread still has its own links
  expect(((await detail(from)).messages as { text: string; reply_to?: string }[]).find(m => m.text === 'src three')!.reply_to).toBe('m2');
});

test('old threads (no reply_to anywhere) read back exactly as before', async () => {
  const id = await start();
  await store.appendMessage(dir, id, { author: 'agent', text: 'x' });
  expect(JSON.stringify((await detail(id)).messages)).not.toContain('reply_to');
});

test('FYI messages are not folded by default; FEEDBACK_FOLD_FYI=1 marks the page to fold them', async () => {
  const page = async () => (await createHandler(dir)(new Request('http://local/__feedback/inbox/'))).text();
  expect(await page()).not.toContain('data-fold-fyi');
  process.env.FEEDBACK_FOLD_FYI = '1';
  try { expect(await page()).toContain('<body data-fold-fyi>'); } finally { delete process.env.FEEDBACK_FOLD_FYI; }
  const js = await (await handle(new Request('http://local/__feedback/inbox/app.js'))).text();
  expect(js).toContain("const quiet = (d, m) => FOLD_FYI &&");
});

test('the inbox page puts the launcher bottom-right and serves quote.js', async () => {
  const html = await (await handle(new Request('http://local/__feedback/inbox/'))).text();
  expect(html).toContain('data-position="bottom-right"');
  const q = await handle(new Request('http://local/__feedback/inbox/quote.js'));
  expect(q.status).toBe(200); expect(q.headers.get('content-type')).toContain('javascript');
});

test('quote helpers: snippet, missing original, swipe', () => {
  expect(snippetOf({ text: '\n  hello world\nmore', images: [] })).toBe('hello world');
  expect(snippetOf({ text: '', images: ['msg-1.png'] })).toBe('Image');
  expect(snippetOf({ text: 'x'.repeat(500), images: [] })).toHaveLength(120);
  const msgs = [{ id: 'm1', text: 'a', images: [] }, { id: 'm2', text: 'b', images: [], reply_to: 'm1' }, { id: 'm3', text: 'c', images: [], reply_to: 'm9' }, { id: 'm4', text: 'd', images: [] }];
  expect(resolveQuote(msgs, msgs[3]!)).toBeNull();
  expect(resolveQuote(msgs, msgs[1]!)).toMatchObject({ found: true, snippet: 'a' });
  expect(resolveQuote(msgs, msgs[2]!)).toEqual({ found: false, original: null, snippet: 'Original message unavailable' });
  expect(isReplySwipe(80, 4)).toBe(true);
  expect(isReplySwipe(30, 0)).toBe(false);
  expect(isReplySwipe(-80, 0)).toBe(false);
  expect(isReplySwipe(80, 60)).toBe(false);
});
