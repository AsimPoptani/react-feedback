import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from './server';
import { run } from './cli';
import * as store from './store';

let dir: string;
let handle: ReturnType<typeof createHandler>;
const pngOf = (w: number, h: number) => {
  const head = Buffer.alloc(33); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(head);
  head.writeUInt32BE(13, 8); head.write('IHDR', 12); head.writeUInt32BE(w, 16); head.writeUInt32BE(h, 20);
  return head;
};
const url = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`;
const png = url(pngOf(1, 1));
const api = (path: string, data?: unknown) => new Request(`http://local/__feedback/api/${path}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const get = async (path: string) => (await handle(api(path))).json();
const events = async () => (await readFile(join(dir, '_events.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));
const start = async () => (await (await handle(api('threads', { title: 'T', text: 'hello' }))).json()).id as string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'feedback-fb6-')); handle = createHandler(dir); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test('ticks: the CLI read stamps the agent marker without an event, and a reply stamps it implicitly', async () => {
  const id = await start();
  let t = await get(`threads/${id}`);
  expect(t.agent_read_at).toBeNull();
  const before = (await events()).length;
  await run(['read', id], dir);
  t = await get(`threads/${id}`);
  expect(t.agent_read_at).toBe(t.messages[0].created_at);
  expect((await events()).length).toBe(before);
  await handle(api(`threads/${id}/messages`, { text: 'second' }));
  await run(['reply', id, 'answer'], dir);
  t = await get(`threads/${id}`);
  expect(t.agent_read_at).toBe(t.messages[1].created_at); // read past the user's second message
  expect(t.user_read_at).toBeNull();
  await handle(api(`threads/${id}/read`, { seen: t.last_message_at }));
  expect((await get(`threads/${id}`)).user_read_at).toBe(t.last_message_at);
  expect((await run(['read', 'nope'], dir).catch(e => e.status))).toBe(404);
});

test('the read marker takes the time the client saw, so a later message is not marked read unseen', async () => {
  const id = await start();
  await run(['reply', id, 'one'], dir);
  const seen = (await get(`threads/${id}`)).last_message_at;
  await Bun.sleep(5);
  await run(['reply', id, 'two, arrived between GET and POST', '--needs-you'], dir);
  await handle(api(`threads/${id}/read`, { seen }));
  const t = await get(`threads/${id}`);
  expect(t.user_read_at).toBe(seen);
  expect(t.unread_for_user).toBe(true);
  // a client cannot pre-read the future, and the marker never moves back
  await handle(api(`threads/${id}/read`, { seen: '2999-01-01T00:00:00.000Z' }));
  expect((await get(`threads/${id}`)).unread_for_user).toBe(false);
  await handle(api(`threads/${id}/read`, { seen }));
  expect((await get(`threads/${id}`)).unread_for_user).toBe(false);
  expect((await handle(api(`threads/${id}/read`, { seen: 'yesterday' }))).status).toBe(400);
});

test('profile: defaults, name, a square avatar, validation, and the agent avatar from the CLI', async () => {
  expect(await get('profile')).toEqual({ user: { name: 'You' }, agent: { name: 'Agent' } });
  const set = await (await handle(api('profile', { name: '  Sam ', avatar: png }))).json();
  expect(set.user.name).toBe('Sam'); expect(set.user.avatar).toContain('/profile/avatar/user');
  expect((await readdir(join(dir, '_profile'))).sort()).toEqual(['profile.json', 'user-avatar.png']);
  const served = await handle(api('profile/avatar/user'));
  expect(served.headers.get('content-type')).toBe('image/png');
  expect((await handle(api('profile/avatar/agent'))).status).toBe(404);
  for (const bad of [{ name: '' }, { name: 'x'.repeat(41) }, { avatar: url(pngOf(2, 3)) }, { avatar: 'data:image/gif;base64,R0lGODlh' },
    { avatar: `data:image/png;base64,${Buffer.from('nope').toString('base64')}` }, { avatar: `data:image/png;base64,${Buffer.concat([pngOf(1, 1), Buffer.alloc(2 * 1024 * 1024)]).toString('base64')}` }]) {
    expect([400, 413]).toContain((await handle(api('profile', bad))).status);
  }
  expect((await get('profile')).user.name).toBe('Sam');
  await handle(api('profile', { avatar: null }));
  expect((await get('profile')).user.avatar).toBeUndefined();
  const file = join(dir, 'a.png'); await writeFile(file, pngOf(8, 8));
  expect(await run(['profile', 'agent', '--avatar', file], dir)).toBe('Set the agent avatar');
  expect((await get('profile')).agent.avatar).toContain('/profile/avatar/agent');
  await writeFile(file, pngOf(8, 9));
  expect(await run(['profile', 'agent', '--avatar', file], dir).catch(e => e.message)).toContain('square');
});

test('imageSize reads PNG, JPEG and WebP headers', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 20, 0, 30, 1, 1, 0, 0]);
  expect(store.imageSize(jpeg, 'jpg')).toEqual({ width: 30, height: 20 });
  const x = Buffer.alloc(30); x.write('RIFF', 0); x.write('WEBP', 8); x.write('VP8X', 12); x.writeUIntLE(99, 24, 3); x.writeUIntLE(49, 27, 3);
  expect(store.imageSize(x, 'webp')).toEqual({ width: 100, height: 50 });
});

test('two first writes racing on a legacy item keep history once', async () => {
  const { id } = await (await handle(api('threads', { title: 'Old', text: 'note' }))).json();
  await rm(join(dir, id, 'thread.jsonl'));
  await writeFile(join(dir, id, 'item.json'), JSON.stringify({ id, created_at: '2026-11-01T00:00:00.000Z', mode: 'element', note: 'old note', context: { url: 'http://x/' } }));
  await Promise.all([1, 2, 3, 4].map(n => store.appendMessage(dir, id, { author: 'user', text: `racer ${n}` })));
  const lines = (await readFile(join(dir, id, 'thread.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  expect(lines.filter(m => m.text === 'old note').length).toBe(1);
  expect(lines.length).toBe(5);
});

test('ids and image numbers stay unique under concurrent appends from server and CLI', async () => {
  const id = await start();
  await Promise.all(Array.from({ length: 24 }, (_, n) => n % 2 ? store.appendMessage(dir, id, { author: 'agent', text: `a${n}`, images: [store.checkedImage(pngOf(1, 1))] })
    : handle(api(`threads/${id}/messages`, { text: `u${n}`, images: [png] }))));
  const t = await get(`threads/${id}`);
  const ids = t.messages.map((m: { id: string }) => m.id);
  expect(new Set(ids).size).toBe(25);
  const imgs = t.messages.flatMap((m: { images: string[] }) => m.images);
  expect(new Set(imgs).size).toBe(24);
  expect((await readdir(join(dir, id))).includes('.lock')).toBe(false);
});

test('messages are read in file order, not sorted by created_at', async () => {
  const id = await start();
  const line = (n: number, at: string) => `${JSON.stringify({ id: `m${n}`, author: 'agent', text: `t${n}`, images: [], created_at: at })}\n`;
  const file = join(dir, id, 'thread.jsonl');
  await writeFile(file, line(1, '2026-11-18T10:00:00.000Z') + line(2, '2026-11-18T09:00:00.000Z'));
  expect((await get(`threads/${id}`)).messages.map((m: { id: string }) => m.id)).toEqual(['m1', 'm2']);
});

test('search finds titles and message text', async () => {
  const a = await start();
  await handle(api('threads', { title: 'Other', text: 'nothing' }));
  await run(['reply', a, 'The Quokka is here'], dir);
  expect((await get('threads?q=quokka')).map((t: { id: string }) => t.id)).toEqual([a]);
  expect((await get('threads?q=OTHER')).length).toBe(1);
  expect((await get('threads')).length).toBe(2);
});

test('ask: the CLI appends a question, the answer is a user message with an event, and the card locks', async () => {
  const id = await start();
  const out = await run(['ask', id, 'Which colour?', '--option', 'Teal|calm', '--option', 'Berry', '--option', 'Ochre'], dir);
  expect(out).toContain('question q2');
  let t = await get(`threads/${id}`);
  expect(t.open_question).toBe(true);
  expect(t.messages[1]).toMatchObject({ author: 'agent', text: 'Which colour?', question: { id: 'q2', multi: false, allow_other: true,
    options: [{ id: 'o1', label: 'Teal', description: 'calm' }, { id: 'o2', label: 'Berry' }, { id: 'o3', label: 'Ochre' }] } });
  const bad = [{ question_id: 'q9', option_ids: ['o1'] }, { question_id: 'q2', option_ids: ['o9'] }, { question_id: 'q2', option_ids: ['o1', 'o2'] },
    { question_id: 'q2', option_ids: [] }, { question_id: 'q2', option_ids: ['o1', 'o1'] }, { question_id: 'q1', option_ids: ['o1'] }, { option_ids: ['o1'] }];
  for (const data of bad) expect([400, 404]).toContain((await handle(api(`threads/${id}/answer`, data))).status);
  const ok = await handle(api(`threads/${id}/answer`, { question_id: 'q2', option_ids: ['o2'] }));
  expect(ok.status).toBe(201);
  const msg = await ok.json();
  expect(msg).toMatchObject({ author: 'user', text: 'Chose: Berry', answer: { question_id: 'q2', option_ids: ['o2'] } });
  const last = (await events()).pop();
  expect(last).toMatchObject({ kind: 'answer', author: 'user', first_line: 'q2 (Which colour?): Berry' });
  t = await get(`threads/${id}`);
  expect(t.open_question).toBe(false);
  expect((await handle(api(`threads/${id}/answer`, { question_id: 'q2', option_ids: ['o1'] }))).status).toBe(409); // locked
  expect(t).toMatchObject({ status: 'open', waiting: 'agent' });
});

test('multi questions, Other, --no-other, and ask-new', async () => {
  const id = await start();
  await run(['ask', id, 'Pick any', '--option', 'A', '--option', 'B', '--multi'], dir);
  const r = await handle(api(`threads/${id}/answer`, { question_id: 'q2', option_ids: ['o1', 'o2'], other_text: 'and C' }));
  expect((await r.json()).text).toBe('Chose: A, B, Other: and C');
  expect((await events()).pop().first_line).toBe('q2 (Pick any): A, B, and C');
  await run(['ask', id, 'Strict', '--option', 'Yes', '--no-other'], dir);
  expect((await handle(api(`threads/${id}/answer`, { question_id: 'q4', option_ids: [], other_text: 'maybe' }))).status).toBe(400);
  const out = await run(['ask-new', 'Direction', 'Left or right?', '--option', 'Left', '--option', 'Right'], dir);
  const nid = /Started (\S+)/.exec(out)![1]!;
  const list = await get('threads');
  expect(list.find((x: { id: string }) => x.id === nid)).toMatchObject({ open_question: true, origin: 'agent' });
  const other = await handle(api(`threads/${nid}/answer`, { question_id: 'q1', option_ids: [], other_text: 'up' }));
  expect((await other.json()).text).toBe('Chose: Other: up');
  expect((await run(['ask', id, 'x'], dir).catch(e => e.message))).toContain('1–9 options');
});

test('only the agent can ask', async () => {
  const id = await start();
  const m = await handle(api(`threads/${id}/messages`, { text: 'hi', question: { prompt: 'q', options: [{ label: 'a' }] } }));
  expect((await m.json()).question).toBeUndefined();
  await expect(store.appendMessage(dir, id, { author: 'user', text: 'x', question: { prompt: 'q', options: [{ label: 'a' }] } })).rejects.toThrow();
});

test('waiting: agent spoke last or an unanswered question means waiting on you; done wins; a user message reopens', async () => {
  const id = await start();
  const w = async () => (await get(`threads/${id}`)).waiting;
  expect(await w()).toBe('agent');
  await run(['reply', id, 'hi'], dir); expect(await w()).toBe('idle'); // an fyi asks nothing of the user
  await run(['reply', id, 'hi again', '--needs-you'], dir); expect(await w()).toBe('you');
  await handle(api(`threads/${id}/messages`, { text: 'ok' })); expect(await w()).toBe('agent');
  await run(['ask', id, 'q?', '--option', 'a'], dir); expect(await w()).toBe('you');
  await handle(api(`threads/${id}/messages`, { text: 'ignoring the question' })); expect(await w()).toBe('agent'); // the user spoke last, even with the question unanswered
  expect((await get(`threads/${id}`)).open_question).toBe(true);
  expect(await run(['list', '--waiting'], dir)).toContain(id);
  await handle(api(`threads/${id}/status`, { status: 'done' })); expect(await w()).toBe('done');
  await run(['reply', id, 'late note'], dir); expect(await w()).toBe('done'); // an agent message does not reopen
  await handle(api(`threads/${id}/messages`, { text: 'one more thing' })); expect((await get(`threads/${id}`)).status).toBe('open');
  expect((await handle(api(`threads/${id}/status`, { status: 'seen' }))).status).toBe(200); // alias
});

test('the inbox groups a capture from a URL with a bad escape instead of throwing', () => {
  const src = readFileSync(join(import.meta.dir, 'inbox/areas.js'), 'utf8');
  const body = src.replace(/^export /gm, '');
  const areaOf = new Function(`${body}; return areaOf;`)() as (t: { mode: string; url: string }) => { area: string };
  expect(areaOf({ mode: 'element', url: 'http://x/100%/x' })).toEqual({ area: '100' });
  expect(areaOf({ mode: 'element', url: 'http://x/a%20b/c' })).toEqual({ area: 'a-b' });
  expect(areaOf({ mode: 'element', url: 'http://x/' })).toEqual({ area: 'home' });
  expect(areaOf({ mode: 'thread', url: '' })).toEqual({ area: 'conversations' });
});

test('the widget list shows seen when the agent spoke last, new when the user did; CLI status prints open', async () => {
  const { id } = await (await handle(api('items', { note: 'n', mode: 'element', image: png, context: { url: 'http://local/x', viewport: { width: 1, height: 1 } } }))).json();
  const status = async () => (await (await handle(new Request('http://local/__feedback/api/items'))).json())[0].status;
  expect(await status()).toBe('new');
  await run(['reply', id, 'hi'], dir); expect(await status()).toBe('seen');
  await handle(api(`threads/${id}/messages`, { text: 'again' })); expect(await status()).toBe('new');
  expect(await run(['status', id, 'seen'], dir)).toBe(`${id} open`);
});
