import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from './server';
import { run } from './cli';
import { loadSecretTarget, loadVaultDir } from './config';
import { validateVault } from './sensitive';
import * as store from './store';
import { secretUrl, secretStatusLine } from './inbox/secret.js';

let dir: string, vault: string, base: string;
let handle: ReturnType<typeof createHandler>;
const SECRET = 'sk-or-v1-THIS-IS-A-FAKE-KEY-9f8e7d6c';
const TEXT = 'my card number is 4111 1111 1111 1111';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const call = (method: string, path: string, data?: unknown) => handle(new Request(`http://local/__feedback/api/${path}`, {
  method, ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) }));
const get = async (path: string) => (await call('GET', path)).json();
const env = () => ({ FEEDBACK_VAULT_DIR: vault });
const cli = (...args: string[]) => run(args, dir, undefined, env());
const start = async (title = 'T', text = 'hello') => (await store.createThread(dir, { title, text, origin: 'user' })).id;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'feedback-rf6-'));
  dir = join(base, 'data'); vault = join(base, 'vault');
  await mkdir(dir, { recursive: true });
  handle = createHandler(dir, undefined, { secretTarget: '/api/keys/{name}', vaultDir: vault });
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); });
const everyFile = async (root: string): Promise<string[]> => (await readdir(root, { withFileTypes: true, recursive: true })).filter(e => e.isFile()).map(e => join(e.parentPath, e.name));
async function textOfTree(root: string): Promise<string> { return (await Promise.all((await everyFile(root)).map(f => readFile(f, 'latin1')))).join('\n'); }

// ---- the key box
test('ask-secret posts a key request and stores no value', async () => {
  const id = await start();
  const out = await cli('ask-secret', id, '--name', 'openrouter', '--label', 'OpenRouter API key', '--help-url', 'https://openrouter.ai/keys');
  expect(out).toContain('openrouter');
  const m = (await get(`threads/${id}`)).messages.at(-1);
  expect(m.kind).toBe('secret_request');
  expect(m.secret).toEqual({ name: 'openrouter', label: 'OpenRouter API key', help_url: 'https://openrouter.ai/keys' });
  expect(m.flag).toBe('needs_you');
  expect((await get('threads')).find((t: { id: string }) => t.id === id).waiting).toBe('you');
});

test('ask-secret refuses a bad name, a non-https help link, a read-only thread, and the user asking', async () => {
  const id = await start();
  await expect(cli('ask-secret', id, '--name', '../x', '--label', 'L')).rejects.toThrow(/key name/);
  await expect(cli('ask-secret', id, '--name', 'a', '--label', 'L', '--help-url', 'http://example.com')).rejects.toThrow(/https/);
  await expect(cli('ask-secret', id, '--name', 'a', '--label', 'L', '--help-url', 'javascript:alert(1)')).rejects.toThrow(/https/);
  await expect(cli('ask-secret', id, '--name', 'a')).rejects.toThrow(/--label/);
  await expect(store.appendMessage(dir, id, { author: 'user', text: 'x', secret: { name: 'a', label: 'L' } })).rejects.toThrow(/Only the agent/);
  const ro = (await store.createThread(dir, { title: 'RO', text: 'updates', origin: 'agent', readOnly: true })).id;
  await expect(cli('ask-secret', ro, '--name', 'a', '--label', 'L')).rejects.toThrow(/read-only/);
});

test('/config tells the inbox the target and whether redaction is on; unset means off', async () => {
  expect(await get('config')).toEqual({ secret_target: '/api/keys/{name}', redact: true });
  const off = createHandler(dir, undefined, { secretTarget: null, vaultDir: null });
  expect(await (await off(new Request('http://local/__feedback/api/config'))).json()).toEqual({ secret_target: null, redact: false });
});

test('the target must be a relative path with {name}; absolute and protocol-relative ones are refused', () => {
  expect(loadSecretTarget({})).toBeNull();
  expect(loadSecretTarget({ FEEDBACK_SECRET_TARGET: '  ' })).toBeNull();
  expect(loadSecretTarget({ FEEDBACK_SECRET_TARGET: '/api/keys/{name}' })).toBe('/api/keys/{name}');
  for (const bad of ['https://evil.example/{name}', 'http://x/{name}', '//evil.example/{name}', 'api/keys/{name}', '/api/keys/x', '/a/../{name}', '/api\\keys/{name}', '/api/{name}?x=https://e', 'javascript:{name}'])
    expect(() => loadSecretTarget({ FEEDBACK_SECRET_TARGET: bad })).toThrow(/relative path/);
  expect(loadVaultDir({ FEEDBACK_VAULT_DIR: ' /v ' })).toBe('/v');
});

test('the inbox builds the key URL from the template, only ever on its own origin', () => {
  expect(secretUrl('/api/keys/{name}', 'openrouter', 'https://app.example')).toBe('/api/keys/openrouter');
  expect(secretUrl('/api/keys/{name}', 'a b', 'https://app.example')).toBe('/api/keys/a%20b');
  for (const bad of ['https://evil.example/{name}', '//evil.example/{name}', '\\\\evil.example\\{name}', '/x', '', null, undefined, 42, '/a/../{name}'])
    expect(secretUrl(bad as string, 'k', 'https://app.example')).toBeNull();
  expect(secretStatusLine({ status: 'saved', hint: '…abcd' })).toBe('Saved ✓ · ends …abcd');
  expect(secretStatusLine({ status: 'saved' })).toBe('Saved ✓');
});

test('recording a saved key keeps only a status and a short hint, refuses anything else, and drops the needs-you flag', async () => {
  const id = await start();
  await cli('ask-secret', id, '--name', 'openrouter', '--label', 'OpenRouter API key');
  const mid = (await get(`threads/${id}`)).messages.at(-1).id;
  for (const bad of [{ status: 'saved', value: SECRET }, { status: 'saved', hint: SECRET }, { status: 'nope' }, { status: 'saved', hint: 'a\nb' }, { value: SECRET }])
    expect((await call('POST', `threads/${id}/messages/${mid}/secret`, bad)).status).toBe(400);
  const ok = await call('POST', `threads/${id}/messages/${mid}/secret`, { status: 'saved', hint: '…abcd' });
  expect(ok.status).toBe(200);
  const m = (await get(`threads/${id}`)).messages.at(-1);
  expect(m.secret.status).toBe('saved'); expect(m.secret.hint).toBe('…abcd'); expect(m.flag).toBe('fyi');
  expect((await call('POST', `threads/${id}/messages/m1/secret`, { status: 'saved' })).status).toBe(404); // not a key request
  expect(await readFile(join(dir, '_events.jsonl'), 'utf8')).toContain('openrouter saved');
  expect(await cli('read', id)).toContain('saved, ends …abcd');
});

test('the key value never reaches the feedback server: not in any request it accepts, any file, event or log', async () => {
  const logs = [spyOn(console, 'log'), spyOn(console, 'error'), spyOn(console, 'warn')];
  const id = await start();
  await cli('ask-secret', id, '--name', 'openrouter', '--label', 'OpenRouter API key');
  const mid = (await get(`threads/${id}`)).messages.at(-1).id;
  // The browser sends the key to the app, not here. What it sends here is the record, and the server refuses a record that carries a value.
  await call('POST', `threads/${id}/messages/${mid}/secret`, { status: 'saved', value: SECRET });
  await call('POST', `threads/${id}/messages`, { text: 'no key in this one' });
  await call('POST', `threads/${id}/messages/${mid}/secret`, { status: 'saved', hint: '…9f8e'.slice(0, 5) });
  expect(await textOfTree(dir)).not.toContain(SECRET);
  expect(JSON.stringify(await get(`threads/${id}`))).not.toContain(SECRET);
  expect(JSON.stringify(logs.map(l => l.mock.calls))).not.toContain(SECRET);
  for (const l of logs) l.mockRestore();
});

// ---- redaction
async function withSensitive() {
  const id = await start('Cards', 'hello');
  const up = await call('POST', `threads/${id}/messages`, { text: TEXT, images: [`data:image/png;base64,${png.toString('base64')}`] });
  const m = await up.json();
  await call('POST', `threads/${id}/messages`, { text: 'how are you', reply_to: m.id });
  await call('POST', `threads/${id}/messages`, { text: 'asking about card' });
  return { id, mid: m.id as string, img: m.images[0] as string };
}

test('redacting a message removes its text and images from the thread and every served route', async () => {
  const { id, mid, img } = await withSensitive();
  expect(await textOfTree(dir)).toContain(TEXT);
  const r = await call('POST', `threads/${id}/messages/${mid}/redact`, {});
  expect(r.status).toBe(200);
  expect(await textOfTree(dir)).not.toContain(TEXT);
  expect(await textOfTree(dir)).not.toContain('4111');
  expect((await readdir(join(dir, id))).includes(img)).toBe(false);
  expect((await call('GET', `items/${id}/${img}`)).status).toBe(404);
  const detail = await get(`threads/${id}`);
  const red = detail.messages.find((m: { id: string }) => m.id === mid);
  expect(red.text).toBe(''); expect(red.images).toEqual([]);
  expect(red.redacted.by).toBe('user'); expect(typeof red.redacted.at).toBe('string');
  for (const route of ['threads', `threads/${id}`, 'tracker', 'metrics?window=all', 'items']) expect(JSON.stringify(await get(route))).not.toContain('4111');
  expect(await cli('read', id)).not.toContain('4111');
  expect(await cli('read', id)).toContain('Redacted (sensitive)');
  expect(await cli('list')).not.toContain('4111');
  // the quote of it, and search
  expect(detail.messages.find((m: { reply_to?: string }) => m.reply_to === mid)).toBeDefined();
  expect(await cli('read', id)).toContain('"🔒 Redacted"');
  expect((await get('threads?q=card%20number')).length).toBe(0);
  expect((await get('threads?q=4111')).length).toBe(0);
  expect((await call('POST', `threads/${id}/messages/${mid}/redact`, {})).status).toBe(200); // again: nothing more to do
});

test('the events log does not keep the text, and keeps every line the same length', async () => {
  const { id, mid } = await withSensitive();
  const before = await readFile(join(dir, '_events.jsonl'), 'utf8');
  expect(before).toContain('card number');
  await call('POST', `threads/${id}/messages/${mid}/redact`, {});
  const after = await readFile(join(dir, '_events.jsonl'), 'utf8');
  expect(after).not.toContain('card number');
  expect(after.length).toBe(before.length);
  expect(after.split('\n').map(l => l.length)).toEqual(before.split('\n').map(l => l.length));
  expect(after.split('\n').filter(Boolean).every(l => JSON.parse(l))).toBe(true);
});

test('the vault is outside the data folder, 0700 and 0600, holds the original, and is never served', async () => {
  const { id, mid } = await withSensitive();
  await call('POST', `threads/${id}/messages/${mid}/redact`, {});
  expect((await stat(vault)).mode & 0o777).toBe(0o700);
  expect((await stat(join(vault, id))).mode & 0o777).toBe(0o700);
  const file = join(vault, id, `${mid}.json`);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(file, 'utf8')).message.text).toBe(TEXT);
  expect((await readdir(join(vault, id))).filter(f => f.endsWith('.tmp'))).toEqual([]);
  for (const path of [`/__feedback/${id}/${mid}.json`, `/__feedback/vault/${id}/${mid}.json`, `/__feedback/api/vault/${id}/${mid}`, `/__feedback/api/items/${id}/${mid}.json`, `/__feedback/inbox/${mid}.json`])
    expect((await handle(new Request(`http://local${path}`))).status).toBe(404);
});

test('a vault inside the data folder (or the other way round) is refused, and no vault means no redaction', async () => {
  expect(() => validateVault(dir, join(dir, 'vault'))).toThrow(/outside/);
  expect(() => validateVault(dir, dir)).toThrow(/outside/);
  expect(() => validateVault(join(base, 'vault', 'data'), vault)).toThrow(/outside/);
  expect(() => validateVault(dir, vault)).not.toThrow();
  const { id, mid } = await withSensitive();
  const inside = createHandler(dir, undefined, { vaultDir: join(dir, 'vault') });
  expect((await inside(new Request(`http://local/__feedback/api/threads/${id}/messages/${mid}/redact`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }))).status).toBe(409);
  const none = createHandler(dir, undefined, { vaultDir: null });
  expect((await none(new Request(`http://local/__feedback/api/threads/${id}/messages/${mid}/redact`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }))).status).toBe(409);
  await expect(run(['redact', id, mid], dir, undefined, {})).rejects.toThrow(/FEEDBACK_VAULT_DIR/);
  expect(await textOfTree(dir)).toContain(TEXT); // nothing was lost or removed
});

test('unredact (CLI only) puts the text and images back from the vault', async () => {
  const { id, mid } = await withSensitive();
  await cli('redact', id, mid, '--reason', 'card number');
  const detail = await get(`threads/${id}`);
  expect(detail.messages.find((m: { id: string }) => m.id === mid).redacted.reason).toBe('card number');
  expect((await call('POST', `threads/${id}/messages/${mid}/unredact`, {})).status).toBe(404); // no such route over HTTP
  expect(await cli('unredact', id, mid)).toContain('Restored');
  const back = (await get(`threads/${id}`)).messages.find((m: { id: string }) => m.id === mid);
  expect(back.text).toBe(TEXT); expect(back.redacted).toBeUndefined(); expect(back.images.length).toBe(1);
  expect((await call('GET', `items/${id}/${back.images[0]}`)).status).toBe(200);
  expect(await cli('unredact', id, mid)).toContain('not redacted');
  expect((await readdir(join(vault, id))).length).toBe(0);
});

test('the user can redact only their own messages; the agent can redact any, including on a read-only thread', async () => {
  const id = await start();
  const reply = await store.appendMessage(dir, id, { author: 'agent', text: 'the password is hunter2' });
  expect((await call('POST', `threads/${id}/messages/${reply.id}/redact`, {})).status).toBe(403);
  expect(await cli('redact', id, reply.id)).toContain('Redacted');
  expect(await textOfTree(dir)).not.toContain('hunter2');
  expect((await call('POST', `threads/${id}/messages/m99/redact`, {})).status).toBe(404);
  const ro = (await store.createThread(dir, { title: 'RO', text: 'token abc123xyz', origin: 'agent', readOnly: true })).id;
  expect(await cli('redact', ro, 'm1')).toContain('Redacted');
  expect(await textOfTree(dir)).not.toContain('abc123xyz');
  expect((await get(`threads/${ro}`)).read_only).toBe(true);
  expect(await cli('unredact', ro, 'm1')).toContain('Restored');
  expect(await textOfTree(dir)).toContain('abc123xyz');
});

test('a redacted first message is also gone from item.json and feedback.md', async () => {
  const id = await start('Keys', 'first message with sk-live-ZZZ');
  expect(await textOfTree(join(dir, id))).toContain('sk-live-ZZZ');
  await cli('redact', id, 'm1');
  expect(await textOfTree(dir)).not.toContain('sk-live-ZZZ');
  expect((await get(`threads/${id}`)).title).toBe('Keys');
  await cli('unredact', id, 'm1');
  expect(await textOfTree(join(dir, id))).toContain('sk-live-ZZZ');
});

// A capture, as the widget writes it: its title is the first line of its note.
async function capture(note: string): Promise<string> {
  const { id, path, created_at } = await store.makeItemFolder(dir);
  const item = { id, created_at, note, mode: 'region', target: { selector: 'main' }, context: { url: '/page', viewport: { w: 1, h: 1 } }, image: 'image.png' };
  await writeFile(join(path, 'item.json'), JSON.stringify(item, null, 2)); await writeFile(join(path, 'status.json'), JSON.stringify({ status: 'open' }));
  await writeFile(join(path, 'feedback.md'), store.captureSummary(item)); await store.startCaptureThread(dir, id, note, created_at);
  return id;
}
const pause = () => new Promise(r => setTimeout(r, 1100)); // thread ids are per second

test('chained merges: a copy two merges away is redacted too, from either end, and search finds nothing', async () => {
  for (const redactIn of ['first', 'last'] as const) {
    const a = await start('A', 'a'); await pause(); const b = await start('B', 'b'); await pause(); const c = await start('C', 'c');
    const m = await store.appendMessage(dir, a, { author: 'user', text: `chain ${redactIn} ${TEXT}` });
    await store.mergeThreads(dir, a, b, 'user'); await store.mergeThreads(dir, b, c, 'user');
    const where = redactIn === 'first' ? { t: a, id: m.id } : { t: c, id: (await get(`threads/${c}`)).messages.find((x: { text: string }) => x.text.includes('chain last')).id };
    await cli('redact', where.t, where.id);
    expect(await textOfTree(dir)).not.toContain('4111');
    expect((await get(`threads?q=chain%20${redactIn}`)).length).toBe(0);
    await pause();
  }
}, 30000);

test('a capture\'s title is its note\'s first line: redacting the note blanks it in dividers, stubs and the farewell too', async () => {
  const SEC = 'secret-title-9931';
  const a = await capture(`${SEC} first line\nmore`); await pause(); const b = await start('B', 'b'); await pause(); const c = await start('C', 'c');
  await store.mergeThreads(dir, a, b, 'user');
  await store.moveMessages(dir, b, ['m3'], c, 'agent'); // m3 is the copy of the capture's note, now carried to C with a "Moved from" divider
  expect(await textOfTree(dir)).toContain(SEC);
  await cli('redact', a, 'm1');
  expect(await textOfTree(dir)).not.toContain(SEC);
  expect((await get(`threads/${a}`)).title).toBe('[redacted]');
  const dividers = [...(await get(`threads/${b}`)).messages, ...(await get(`threads/${c}`)).messages].filter((m: { divider?: boolean }) => m.divider).map((m: { text: string }) => m.text);
  expect(dividers.some((t: string) => t.includes('[redacted]'))).toBe(true);
}, 15000);

test('a sweep that cannot reach a copy says so (and logs it); running redact again finishes the job', async () => {
  const err = spyOn(console, 'error').mockImplementation(() => {});
  const a = await start('A', 'a'); await pause(); const b = await start('B', 'b');
  const m = await store.appendMessage(dir, a, { author: 'user', text: `needs retry ${TEXT}` });
  await store.mergeThreads(dir, a, b, 'user');
  await chmod(join(dir, b), 0o500); // the copy's thread cannot be written
  const out = await cli('redact', a, m.id);
  await chmod(join(dir, b), 0o700);
  expect(out).toContain('WARNING'); expect(out).toContain(b); expect(err).toHaveBeenCalled();
  expect(await textOfTree(join(dir, b))).toContain('4111');
  expect(await cli('redact', a, m.id)).not.toContain('WARNING'); // already redacted here, the copy is retried
  expect(await textOfTree(dir)).not.toContain('4111');
  err.mockRestore();
}, 15000);

test('an answer\'s Other text is gone from _events.jsonl as well', async () => {
  const t = (await store.createThread(dir, { title: 'Q', text: 'ask', origin: 'agent', question: { prompt: 'Which key?', options: [{ label: 'none' }], allow_other: true } })).id;
  const ans = await store.appendMessage(dir, t, { author: 'user', text: undefined, answer: { question_id: 'q1', option_ids: [], other_text: 'here is sk-LIVE-77' } });
  expect(await readFile(join(dir, '_events.jsonl'), 'utf8')).toContain('sk-LIVE-77');
  await cli('redact', t, ans.id);
  expect(await textOfTree(dir)).not.toContain('sk-LIVE-77');
  const ev = (await readFile(join(dir, '_events.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  expect(ev.every(e => typeof e.ts === 'string')).toBe(true);
});

test('redacting a capture\'s note keeps feedback.md a proper summary, and unredact puts the original back', async () => {
  const id = await capture('pin is 9876');
  const before = await readFile(join(dir, id, 'feedback.md'), 'utf8');
  expect(before).toContain('Mode: region');
  await cli('redact', id, 'm1');
  const during = await readFile(join(dir, id, 'feedback.md'), 'utf8');
  expect(during).toContain('Mode: region'); expect(during).toContain('URL: /page'); expect(during).not.toContain('9876'); expect(during.startsWith('[redacted]')).toBe(true);
  await cli('unredact', id, 'm1');
  expect(await readFile(join(dir, id, 'feedback.md'), 'utf8')).toBe(before);
});

test('redact and secret need a JSON body, like every other write (a cross-site form cannot send one)', async () => {
  const { id, mid } = await withSensitive();
  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', undefined]) {
    const r = await handle(new Request(`http://local/__feedback/api/threads/${id}/messages/${mid}/redact`, { method: 'POST', ...(contentType ? { headers: { 'Content-Type': contentType }, body: 'x=1' } : {}) }));
    expect(r.status).toBe(415);
  }
  expect(await textOfTree(dir)).toContain(TEXT);
});

test('a recorded save can carry the app\'s check; "rejected" is kept and shown to the agent, anything else is refused', async () => {
  const id = await start();
  await cli('ask-secret', id, '--name', 'openrouter', '--label', 'OpenRouter API key');
  const mid = (await get(`threads/${id}`)).messages.at(-1).id;
  expect((await call('POST', `threads/${id}/messages/${mid}/secret`, { status: 'saved', check: 'maybe' })).status).toBe(400);
  expect((await call('POST', `threads/${id}/messages/${mid}/secret`, { status: 'saved', hint: '…abcd', check: 'rejected' })).status).toBe(200);
  expect((await get(`threads/${id}`)).messages.at(-1).secret.check).toBe('rejected');
  expect(await cli('read', id)).toContain('the provider rejected it');
  expect(secretStatusLine({ status: 'saved', hint: '…abcd', check: 'rejected' })).toBe('Saved, but the provider rejected it · ends …abcd');
});

test('a merge copies messages, so redacting one redacts the other copy as well', async () => {
  const from = await start('From', 'src');
  await call('POST', `threads/${from}/messages`, { text: TEXT });
  const into = await start('Into', 'tgt');
  await store.mergeThreads(dir, from, into, 'user');
  expect(await textOfTree(dir)).toContain(TEXT);
  const copy = (await get(`threads/${into}`)).messages.find((m: { text: string }) => m.text === TEXT);
  await cli('redact', into, copy.id);
  expect(await textOfTree(dir)).not.toContain(TEXT);
});

test('redacting a question hides the prompt and the options; a message that is a key request can be redacted too', async () => {
  const id = await start();
  await cli('ask', id, 'which secret word?', '--option', 'plum|a', '--option', 'quince');
  await cli('redact', id, 'm2');
  const q = (await get(`threads/${id}`)).messages.find((m: { id: string }) => m.id === 'm2');
  expect(JSON.stringify(q)).not.toContain('plum'); expect(JSON.stringify(q)).not.toContain('secret word');
  await cli('unredact', id, 'm2');
  expect(JSON.stringify((await get(`threads/${id}`)).messages.find((m: { id: string }) => m.id === 'm2').question)).toContain('plum');
});

// ---- offline sends: the same message arriving twice is stored once, and keeps when the user wrote it
const send = (id: string, body: Record<string, unknown>) => call('POST', `threads/${id}/messages`, body);
test('a message with a client_id is stored once however often it is sent', async () => {
  const id = await start();
  const first = await send(id, { text: 'from the train', client_id: 'cid-aaaaaaaa1' });
  const again = await send(id, { text: 'from the train', client_id: 'cid-aaaaaaaa1' });
  expect(first.status).toBe(201); expect(again.status).toBe(200);
  expect((await again.json()).id).toBe((await first.json()).id);
  expect((await get(`threads/${id}`)).messages.filter((m: { text: string }) => m.text === 'from the train').length).toBe(1);
  expect((await readFile(join(dir, '_events.jsonl'), 'utf8')).split('\n').filter(l => l.includes('from the train')).length).toBe(1);
  expect((await send(id, { text: 'x', client_id: 'short' })).status).toBe(400);
  expect((await send(id, { text: 'other', client_id: 'cid-bbbbbbbb2' })).status).toBe(201);
});

test('concurrent retries with one client_id make one message; images are saved once', async () => {
  const id = await start();
  const img = `data:image/png;base64,${png.toString('base64')}`;
  const rs = await Promise.all([1, 2, 3].map(() => send(id, { text: 'pic', images: [img], client_id: 'cid-cccccccc3' })));
  expect(rs.every(r => r.ok)).toBe(true);
  expect((await get(`threads/${id}`)).messages.filter((m: { text: string }) => m.text === 'pic').length).toBe(1);
  expect((await readdir(join(dir, id))).filter(f => f.startsWith('msg-')).length).toBe(1);
});

test('written_at keeps when the user wrote it; created_at stays the arrival time so reads and acks stay right', async () => {
  const id = await start();
  const wrote = new Date(Date.now() - 3600e3).toISOString();
  const m = await (await send(id, { text: 'offline one', written_at: wrote, client_id: 'cid-dddddddd4' })).json();
  expect(m.written_at).toBe(wrote);
  expect(Date.parse(m.created_at)).toBeGreaterThan(Date.parse(wrote));
  expect(await cli('read', id)).toContain('sent offline');
  for (const bad of ['nonsense', new Date(Date.now() + 86400e3).toISOString(), new Date(Date.now() - 90 * 86400e3).toISOString(), 5]) {
    const x = await (await send(id, { text: `bad ${String(bad).slice(0, 6)}`, written_at: bad })).json();
    expect(x.written_at).toBeUndefined();
  }
});

test('a queued message sent to a thread that has become read-only is refused (409), not stored', async () => {
  const id = await start();
  await cli('readonly', id, 'on');
  expect((await send(id, { text: 'late', client_id: 'cid-eeeeeeee5' })).status).toBe(409);
  expect((await get(`threads/${id}`)).messages.length).toBe(1);
});
