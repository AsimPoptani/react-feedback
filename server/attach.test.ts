// biome-ignore-all lint/suspicious/noExplicitAny: the tests read loose tool JSON
// 0.9.4: files of any type, uploaded in resumable chunks, with no size cap by default.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHandler, serverOptions } from './server';
import { run, transcript } from './cli';
import { createMcpServer } from './mcp';
import { CHUNK_BYTES, cleanStale, sanitiseName, sniffType, validateLimits } from './files';
import { redactMessage, unredactMessage } from './sensitive';
import * as store from './store';

let dir: string;
let vault: string;
let handle: ReturnType<typeof createHandler>;
const sha = (bytes: Uint8Array | Buffer) => createHash('sha256').update(bytes).digest('hex');
const url = (path: string) => `http://local/__feedback/${path}`;
const json = (path: string, method: string, data?: unknown) => new Request(url(path), { method, headers: { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
const chunk = (id: string, offset: number, bytes: Uint8Array | Buffer) => new Request(url(`api/uploads/${id}?offset=${offset}`), { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes as BodyInit });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'feedback-attach-'));
  vault = await mkdtemp(join(tmpdir(), 'feedback-attach-vault-'));
  handle = createHandler(dir, undefined, { vaultDir: vault });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); await rm(vault, { recursive: true, force: true }); });

const thread = async (title = 'Files') => (await store.createThread(dir, { title, text: 'Start', origin: 'agent' })).id;
// Uploads `bytes` in pieces of the given sizes (the last piece takes the rest) and returns the finalised upload.
async function upload(bytes: Buffer, name: string, pieces: number[] = [bytes.length], h = handle) {
  const made = await (await h(json('api/uploads', 'POST', { name, size: bytes.length }))).json();
  expect(made.offset).toBe(0);
  let at = 0;
  for (const piece of pieces) {
    const end = Math.min(bytes.length, at + piece);
    const res = await h(chunk(made.id, at, bytes.subarray(at, end)));
    expect(res.status).toBe(200);
    at = (await res.json()).offset;
  }
  const done = await h(json(`api/uploads/${made.id}/finalise`, 'POST', { sha256: sha(bytes) }));
  return { id: made.id as string, res: done, body: await done.json() };
}
const post = async (id: string, data: Record<string, unknown>) => handle(json(`api/threads/${id}/messages`, 'POST', data));
const bytesOf = (n: number, seed = 7) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 255; return b; };
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), bytesOf(300)]);

test('a file goes up in several chunks, is checked, and becomes part of the message', async () => {
  const id = await thread();
  const data = bytesOf(10_000);
  const up = await upload(data, 'notes.bin', [4000, 4000, 4000]);
  expect(up.res.status).toBe(200);
  expect(up.body).toMatchObject({ id: up.id, name: 'notes.bin', size: 10_000, sha256: sha(data), type: 'application/octet-stream' });
  const sent = await post(id, { text: 'Here you go', attachments: [up.id] });
  expect(sent.status).toBe(201);
  const message = await sent.json();
  expect(message.attachments).toEqual([expect.objectContaining({ id: up.id, name: 'notes.bin', size: 10_000, sha256: sha(data), by: 'user' })]);
  const stored = await readFile(join(dir, id, 'files', up.id, 'notes.bin'));
  expect(sha(stored)).toBe(sha(data));
  expect(await readdir(join(dir, '_uploads'))).toEqual([]); // the staging folder went with the claim
  const detail = await (await handle(new Request(url(`api/threads/${id}`)))).json();
  expect(detail.messages.at(-1).attachments[0].id).toBe(up.id);
});
test('a message of only files is allowed, and the event log does not name the file', async () => {
  const id = await thread();
  const up = await upload(bytesOf(50), 'secret-plan.txt');
  expect((await post(id, { attachments: [up.id] })).status).toBe(201);
  const events = await readFile(join(dir, '_events.jsonl'), 'utf8');
  expect(events).toContain('[file]');
  expect(events).not.toContain('secret-plan');
});
test('an upload resumes where the server stopped: a broken connection keeps the bytes that arrived', async () => {
  const data = bytesOf(9000);
  const made = await (await handle(json('api/uploads', 'POST', { name: 'big.dat', size: data.length }))).json();
  let sent = false;
  const broken = new ReadableStream<Uint8Array>({ pull(controller) { if (!sent) { sent = true; controller.enqueue(data.subarray(0, 3500)); } else controller.error(new Error('connection lost')); } });
  const lost = await handle(new Request(url(`api/uploads/${made.id}?offset=0`), { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: broken, duplex: 'half' } as RequestInit)).catch(() => null);
  expect(lost === null || lost.status >= 400).toBe(true);
  const where = await (await handle(new Request(url(`api/uploads/${made.id}`)))).json();
  expect(where.offset).toBe(3500); // what arrived is kept, so the client carries on from there
  expect((await handle(chunk(made.id, where.offset, data.subarray(where.offset)))).status).toBe(200);
  const done = await handle(json(`api/uploads/${made.id}/finalise`, 'POST', { sha256: sha(data) }));
  expect(done.status).toBe(200);
});
test('a chunk that does not start where the server is, a chunk past the end, and an incomplete finish are refused', async () => {
  const data = bytesOf(1000);
  const made = await (await handle(json('api/uploads', 'POST', { name: 'a.dat', size: 1000 }))).json();
  expect((await handle(chunk(made.id, 10, data.subarray(0, 100)))).status).toBe(409); // not at the server's offset
  expect((await handle(chunk(made.id, 0, bytesOf(1001)))).status).toBe(413); // past the end of the file
  expect((await handle(chunk(made.id, 0, data.subarray(0, 600)))).status).toBe(200);
  const early = await handle(json(`api/uploads/${made.id}/finalise`, 'POST', { sha256: sha(data) }));
  expect(early.status).toBe(409);
  expect((await early.json()).detail).toContain('600 of 1000');
  expect((await handle(chunk(made.id, 600, data.subarray(600)))).status).toBe(200);
  expect((await handle(json(`api/uploads/${made.id}/finalise`, 'POST', { sha256: sha(data) }))).status).toBe(200);
  expect((await handle(chunk(made.id, 1000, bytesOf(1)))).status).toBe(409); // finished
});
test('a chunk over 32 MiB is refused', async () => {
  const size = CHUNK_BYTES + 10;
  const made = await (await handle(json('api/uploads', 'POST', { name: 'huge.dat', size }))).json();
  const res = await handle(chunk(made.id, 0, Buffer.alloc(CHUNK_BYTES + 1)));
  expect(res.status).toBe(413);
  expect((await (await handle(new Request(url(`api/uploads/${made.id}`)))).json()).offset).toBe(0);
});
test('a checksum that does not match is rejected and the upload is discarded', async () => {
  const data = bytesOf(500);
  const made = await (await handle(json('api/uploads', 'POST', { name: 'x.dat', size: 500 }))).json();
  await handle(chunk(made.id, 0, data));
  const bad = await handle(json(`api/uploads/${made.id}/finalise`, 'POST', { sha256: sha(Buffer.from('other')) }));
  expect(bad.status).toBe(422);
  expect((await bad.json()).detail).toContain('checksum');
  expect((await handle(new Request(url(`api/uploads/${made.id}`)))).status).toBe(404);
  expect(await readdir(join(dir, '_uploads'))).toEqual([]);
  const none = await handle(json(`api/uploads/${made.id}/finalise`, 'POST', {}));
  expect(none.status).toBe(404);
});
test('finalising puts the finished file in one rename: it is never visible half written, and nothing partial is left', async () => {
  const data = bytesOf(2000);
  const made = await (await handle(json('api/uploads', 'POST', { name: 'one.dat', size: 2000 }))).json();
  await handle(chunk(made.id, 0, data));
  const before = await readdir(join(dir, '_uploads', made.id));
  expect(before).toContain('part'); expect(before).not.toContain('file');
  await handle(json(`api/uploads/${made.id}/finalise`, 'POST', { sha256: sha(data) }));
  const after = (await readdir(join(dir, '_uploads', made.id))).sort();
  expect(after).toEqual(['file', 'meta.json']);
  expect(sha(await readFile(join(dir, '_uploads', made.id, 'file')))).toBe(sha(data));
  // Finalising again is the same answer, and cancelling removes everything.
  expect((await handle(json(`api/uploads/${made.id}/finalise`, 'POST', { sha256: sha(data) }))).status).toBe(200);
  expect((await handle(new Request(url(`api/uploads/${made.id}`), { method: 'DELETE' }))).status).toBe(200);
  expect(await readdir(join(dir, '_uploads'))).toEqual([]);
});
test('the disk guard refuses a new upload and a chunk when free space would fall below the floor', async () => {
  const GiB = 1024 ** 3;
  let free = 500 * GiB;
  const guarded = createHandler(dir, undefined, { files: { env: {}, disk: async () => ({ free, total: 1000 * GiB }) } });
  // The floor is the larger of 20 GiB and 10% of the volume (100 GiB here).
  const ok = await guarded(json('api/uploads', 'POST', { name: 'a', size: 300 * GiB }));
  expect(ok.status).toBe(201);
  const refused = await guarded(json('api/uploads', 'POST', { name: 'b', size: 401 * GiB }));
  expect(refused.status).toBe(507);
  expect((await refused.json()).detail).toBe('Not enough disk space on the server');
  const made = await (await guarded(json('api/uploads', 'POST', { name: 'c', size: 100 }))).json();
  free = 100 * GiB + 50; // something else filled the disk meanwhile
  const chunkRefused = await guarded(chunk(made.id, 0, bytesOf(100)));
  expect(chunkRefused.status).toBe(507);
  free = 20 * GiB;
  const small = createHandler(dir, undefined, { files: { env: { FEEDBACK_MIN_FREE_BYTES: String(20 * GiB) }, disk: async () => ({ free, total: 100 * GiB }) } });
  expect((await small(json('api/uploads', 'POST', { name: 'd', size: 1 }))).status).toBe(507); // 10% of 100 GiB is 10 GiB, but the floor is 20 GiB and this byte would cross it
  free = 20 * GiB + 1;
  expect((await small(json('api/uploads', 'POST', { name: 'd', size: 1 }))).status).toBe(201);
});
test('FEEDBACK_MAX_UPLOAD_BYTES caps a file when set, and there is no cap when it is not', async () => {
  const capped = createHandler(dir, undefined, { files: { env: { FEEDBACK_MAX_UPLOAD_BYTES: '1000' }, disk: async () => ({ free: 1e15, total: 1e15 }) } });
  expect((await capped(json('api/uploads', 'POST', { name: 'a', size: 1000 }))).status).toBe(201);
  expect((await capped(json('api/uploads', 'POST', { name: 'a', size: 1001 }))).status).toBe(413);
  const open = createHandler(dir, undefined, { files: { env: {}, disk: async () => ({ free: 1e15, total: 1e15 }) } });
  expect((await open(json('api/uploads', 'POST', { name: 'a', size: 5 * 1024 ** 4 }))).status).toBe(201); // five terabytes: accepted, nothing is read into memory
  expect(() => validateLimits({ FEEDBACK_MAX_UPLOAD_BYTES: 'lots' })).toThrow('FEEDBACK_MAX_UPLOAD_BYTES');
  expect(() => validateLimits({ FEEDBACK_MIN_FREE_BYTES: '-1' })).toThrow('FEEDBACK_MIN_FREE_BYTES');
  expect(() => serverOptions({ FEEDBACK_DIR: dir, FEEDBACK_MAX_UPLOAD_BYTES: 'x' })).toThrow();
  expect(serverOptions({ FEEDBACK_DIR: dir }).maxRequestBodySize).toBeGreaterThan(CHUNK_BYTES);
});
test('names are only labels: no path, no control characters, a capped length', async () => {
  expect(sanitiseName('../../etc/passwd')).toBe('passwd');
  expect(sanitiseName('..\\..\\windows\\system32\\evil.dll')).toBe('evil.dll');
  expect(sanitiseName('/abs/path/report.pdf')).toBe('report.pdf');
  expect(sanitiseName('a\u0000b\u001fc‮.txt')).toBe('abc.txt');
  expect(sanitiseName('..')).toBe('file');
  expect(sanitiseName('.hidden')).toBe('hidden');
  expect(sanitiseName('')).toBe('file');
  expect(sanitiseName(undefined)).toBe('file');
  expect(sanitiseName('   ')).toBe('file');
  const long = sanitiseName(`${'x'.repeat(300)}.tar.gz`);
  expect(long.length).toBeLessThanOrEqual(120);
  expect(long.endsWith('.gz')).toBe(true);
  // Through the API: the file lands inside the thread's files folder, whatever the name said.
  const id = await thread();
  const up = await upload(bytesOf(10), '../../../../tmp/pwned.txt');
  expect(up.body.name).toBe('pwned.txt');
  await post(id, { text: 'x', attachments: [up.id] });
  expect((await readdir(join(dir, id, 'files', up.id)))).toEqual(['pwned.txt']);
  await expect(stat(join(dir, '..', 'pwned.txt'))).rejects.toThrow();
});
test('types come from the first bytes, never from the name', async () => {
  expect(sniffType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe('image/png');
  expect(sniffType(PDF)).toBe('application/pdf');
  expect(sniffType(Buffer.from('PK\x03\x04rest'))).toBe('application/zip');
  expect(sniffType(Buffer.from('<html><script>alert(1)</script>'))).toBe('text/plain');
  expect(sniffType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'))).toBe('text/plain');
  expect(sniffType(Buffer.from([0, 1, 2, 3, 255, 254]))).toBe('application/octet-stream');
});
test('every download is an attachment in a sandbox with no cookies; html and svg are never served inline', async () => {
  const id = await thread();
  const html = await upload(Buffer.from('<html><body><script>alert(document.domain)</script></body></html>'), 'page.html');
  const svg = await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'pic.svg');
  const zip = await upload(Buffer.concat([Buffer.from('PK\x03\x04'), bytesOf(100)]), 'bundle.zip');
  const png = await upload(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), bytesOf(40)]), 'shot.png');
  const lie = await upload(Buffer.from('<script>alert(1)</script>'), 'fake.png'); // a name that claims to be an image
  await post(id, { text: 'files', attachments: [html.id, svg.id, zip.id, png.id, lie.id] });
  for (const up of [html, svg, zip, lie]) {
    const res = await handle(new Request(url(`api/threads/${id}/attachments/${up.id}`)));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toStartWith('attachment;');
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
    expect(res.headers.get('Set-Cookie')).toBeNull();
    await res.arrayBuffer();
    const forced = await handle(new Request(url(`api/threads/${id}/attachments/${up.id}?inline=1`)));
    expect(forced.headers.get('Content-Disposition')).toStartWith('attachment;'); // inline is for a PDF preview only
    expect(forced.headers.get('Content-Type')).toBe('application/octet-stream');
    await forced.arrayBuffer();
  }
  const image = await handle(new Request(url(`api/threads/${id}/attachments/${png.id}`)));
  expect(image.headers.get('Content-Type')).toBe('image/png'); // a real image shows in the thread, still as an attachment
  expect(image.headers.get('Content-Disposition')).toStartWith('attachment;');
  await image.arrayBuffer();
  expect((await handle(new Request(url(`api/threads/${id}/attachments/${html.id}`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }))).status).toBe(404);
  expect((await handle(new Request(url(`api/threads/${id}/attachments/u0000000000000000`)))).status).toBe(404);
});
test('a PDF preview is the one inline response, and it is sandboxed', async () => {
  const id = await thread();
  const pdf = await upload(PDF, 'paper.pdf');
  expect(pdf.body.type).toBe('application/pdf');
  await post(id, { text: 'paper', attachments: [pdf.id] });
  const download = await handle(new Request(url(`api/threads/${id}/attachments/${pdf.id}`)));
  expect(download.headers.get('Content-Disposition')).toStartWith('attachment;');
  expect(download.headers.get('Content-Type')).toBe('application/octet-stream');
  await download.arrayBuffer();
  const preview = await handle(new Request(url(`api/threads/${id}/attachments/${pdf.id}?inline=1`)));
  expect(preview.headers.get('Content-Disposition')).toStartWith('inline;');
  expect(preview.headers.get('Content-Type')).toBe('application/pdf');
  expect(preview.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
  expect(preview.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(Buffer.from(await preview.arrayBuffer()).equals(PDF)).toBe(true);
});
test('a file can be taken by the message of whoever uploaded it, once, and at most ten per message', async () => {
  const id = await thread();
  const mine = await upload(bytesOf(20), 'mine.txt');
  const wrong = await store.appendMessage(dir, id, { author: 'agent', text: 'stolen', attachments: [mine.id] }).catch((e: store.Invalid) => e);
  expect(wrong).toBeInstanceOf(store.Invalid);
  expect((wrong as store.Invalid).status).toBe(409);
  expect((await post(id, { text: 'ok', attachments: [mine.id] })).status).toBe(201);
  const again = await post(id, { text: 'twice', attachments: [mine.id] });
  expect(again.status).toBe(404); // already taken
  expect((await post(id, { text: 'dup', attachments: ['u0123456789abcdef', 'u0123456789abcdef'] })).status).toBe(400);
  expect((await post(id, { text: 'many', attachments: Array.from({ length: 11 }, (_, i) => `u${String(i).padStart(16, '0')}`) })).status).toBe(400);
  expect((await post(id, { text: 'bad', attachments: ['../../etc/passwd'] })).status).toBe(404);
  expect((await post(id, { text: 'bad', attachments: 'u0123456789abcdef' })).status).toBe(400);
});
test('a retry of the same message does not take a file twice', async () => {
  const id = await thread();
  const up = await upload(bytesOf(20), 'once.txt');
  const first = await post(id, { text: 'with a file', attachments: [up.id], client_id: 'client-0001' });
  expect(first.status).toBe(201);
  const retry = await post(id, { text: 'with a file', attachments: [up.id], client_id: 'client-0001' });
  expect(retry.status).toBe(200);
  expect((await retry.json()).attachments).toHaveLength(1);
});
test('a new thread can start with a file', async () => {
  const up = await upload(bytesOf(30), 'start.txt');
  const made = await handle(json('api/threads', 'POST', { title: 'With file', text: 'see attached', attachments: [up.id] }));
  expect(made.status).toBe(201);
  const { id } = await made.json();
  const detail = await (await handle(new Request(url(`api/threads/${id}`)))).json();
  expect(detail.messages[0].attachments[0].name).toBe('start.txt');
});
test('partial uploads and uploads nobody took are removed after 24 hours; claimed files stay', async () => {
  const id = await thread();
  const old = await (await handle(json('api/uploads', 'POST', { name: 'old.dat', size: 10 }))).json();
  const fresh = await (await handle(json('api/uploads', 'POST', { name: 'fresh.dat', size: 10 }))).json();
  const kept = await upload(bytesOf(10), 'kept.dat');
  await post(id, { text: 'kept', attachments: [kept.id] });
  const longAgo = new Date(Date.now() - 25 * 3600e3);
  for (const f of await readdir(join(dir, '_uploads', old.id))) await utimes(join(dir, '_uploads', old.id, f), longAgo, longAgo);
  expect(await cleanStale(dir)).toBe(1);
  expect((await readdir(join(dir, '_uploads'))).sort()).toEqual([fresh.id]);
  expect(await readFile(join(dir, id, 'files', kept.id, 'kept.dat'))).toHaveLength(10);
  expect(await cleanStale(dir, Date.now() + 25 * 3600e3)).toBe(1); // a day later the fresh one goes too
});
test('redacting a message moves its files into the vault: they are not served any more, and unredact brings them back', async () => {
  const id = await thread();
  const up = await upload(Buffer.from('private notes'), 'private.txt');
  const message = await (await post(id, { text: 'sensitive', attachments: [up.id] })).json();
  const served = await handle(new Request(url(`api/threads/${id}/attachments/${up.id}`)));
  expect(served.status).toBe(200); await served.arrayBuffer();
  const gone = await handle(json(`api/threads/${id}/messages/${message.id}/redact`, 'POST', {}));
  expect(gone.status).toBe(200);
  expect((await handle(new Request(url(`api/threads/${id}/attachments/${up.id}`)))).status).toBe(404);
  await expect(stat(join(dir, id, 'files', up.id))).rejects.toThrow();
  expect(await readFile(join(vault, id, `${message.id}.files`, up.id, 'private.txt'), 'utf8')).toBe('private notes');
  const detail = await (await handle(new Request(url(`api/threads/${id}`)))).json();
  const redacted = detail.messages.find((m: store.Message) => m.id === message.id);
  expect(redacted.attachments).toBeUndefined();
  expect(redacted.text).toBe('');
  const back = await unredactMessage(dir, id, message.id, vault);
  expect(back.restored).toBe(true);
  expect(await readFile(join(dir, id, 'files', up.id, 'private.txt'), 'utf8')).toBe('private notes');
  const again = await handle(new Request(url(`api/threads/${id}/attachments/${up.id}`)));
  expect(again.status).toBe(200); await again.arrayBuffer();
  expect((await redactMessage(dir, id, message.id, { by: 'user', vault })).redacted).toBe(true);
});
test('files are not reachable from a share link', async () => {
  const id = await thread();
  const up = await upload(bytesOf(10), 'inside.txt');
  await post(id, { text: 'x', attachments: [up.id] });
  for (const path of [`s/${up.id}`, `s/${id}`, `s/${id}%2Fattachments%2F${up.id}`, `s/${encodeURIComponent(`../api/threads/${id}/attachments/${up.id}`)}`]) {
    const res = await handle(new Request(url(path)));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not found\n');
  }
});
test('a merge and a move carry a message\'s files along', async () => {
  const a = await thread('A'), b = await thread('B');
  const up = await upload(bytesOf(12), 'carry.txt');
  const sent = await (await post(a, { text: 'with file', attachments: [up.id] })).json();
  await store.moveMessages(dir, a, [sent.id], b);
  const moved = (await store.summarise(dir, b)).messages.find(m => m.attachments?.length)!;
  expect(await readFile(join(dir, b, 'files', up.id, 'carry.txt'))).toHaveLength(12);
  expect(moved.attachments![0]!.id).toBe(up.id);
  await expect(stat(join(dir, a, 'files', up.id))).rejects.toThrow(); // the original left with the message
  const c = await thread('C');
  await store.mergeThreads(dir, b, c, 'agent');
  expect(await readFile(join(dir, c, 'files', up.id, 'carry.txt'))).toHaveLength(12);
  expect(await readFile(join(dir, b, 'files', up.id, 'carry.txt'))).toHaveLength(12); // the source stays readable
});

// ---- CLI and MCP
test('CLI reply --file attaches files of any type, and read lists them with absolute paths', async () => {
  const id = await thread();
  const src = await mkdtemp(join(tmpdir(), 'feedback-src-'));
  try {
    await writeFile(join(src, 'log.txt'), 'line one\nline two\n');
    await writeFile(join(src, 'data.bin'), bytesOf(5000));
    const out = await run(['reply', id, 'Two files', '--file', join(src, 'log.txt'), '--file', join(src, 'data.bin')], dir, undefined, {}, () => {});
    expect(out).toContain('files log.txt, data.bin');
    const read = await run(['read', id], dir, undefined, {}, () => {});
    const logPath = join(dir, id, 'files');
    expect(read).toContain('[file] log.txt (18 B, text/plain, from agent) ');
    expect(read).toContain('[file] data.bin (4.9 KB, application/octet-stream, from agent) ');
    const line = read.split('\n').find(l => l.includes('[file] log.txt'))!;
    const abs = line.slice(line.lastIndexOf(' ') + 1);
    expect(abs.startsWith('/')).toBe(true);
    expect(abs.startsWith(logPath)).toBe(true);
    expect(await readFile(abs, 'utf8')).toBe('line one\nline two\n');
    await expect(run(['reply', id, 'x', '--file', join(src, 'missing.txt')], dir, undefined, {}, () => {})).rejects.toThrow('Cannot read');
    expect(await readdir(join(dir, '_uploads'))).toEqual([]); // nothing staged is left behind by a failure
    expect(transcript((await store.summarise(dir, id)).messages)).toContain('[file] log.txt'); // without a folder, no path is printed
  } finally { await rm(src, { recursive: true, force: true }); }
});
test('CLI reply --file refuses when the disk is short on space', async () => {
  const id = await thread();
  const src = await mkdtemp(join(tmpdir(), 'feedback-src-'));
  try {
    await writeFile(join(src, 'a.txt'), 'abc');
    await expect(run(['reply', id, 'x', '--file', join(src, 'a.txt')], dir, undefined, { FEEDBACK_MIN_FREE_BYTES: '9000000000000000' }, () => {})).rejects.toThrow('Not enough disk space on the server');
  } finally { await rm(src, { recursive: true, force: true }); }
});
async function connect(name: string, env: Record<string, string>) {
  const server = createMcpServer({ dir, agentName: name, env });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const tool = async (n: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name: n, arguments: args }) as { isError?: boolean; structuredContent?: any; content: { text: string }[] };
    return { error: r.isError === true, data: r.structuredContent, text: r.content[0]!.text };
  };
  return { tool, close: () => client.close() };
}
test('MCP: reply with files, read_thread lists them, get_attachment returns text or a path', async () => {
  const id = await thread();
  const src = await mkdtemp(join(tmpdir(), 'feedback-mcp-src-'));
  try {
    await writeFile(join(src, 'notes.md'), '# Notes\nhello');
    await writeFile(join(src, 'pack.bin'), bytesOf(3000));
    await writeFile(join(src, 'big.txt'), 'a'.repeat(1024 * 1024 + 1));
    const off = await connect('Codex', {});
    const refused = await off.tool('reply', { id, text: 'x', files: [join(src, 'notes.md')] });
    expect(refused.error).toBe(true);
    expect(refused.text).toContain('FEEDBACK_FILE_DIR');
    await off.close();
    const { tool, close } = await connect('Codex', { FEEDBACK_FILE_DIR: src });
    const outside = await tool('reply', { id, text: 'x', files: ['/etc/hosts'] });
    expect(outside.error).toBe(true);
    const posted = await tool('reply', { id, text: 'Three files', files: [join(src, 'notes.md'), join(src, 'pack.bin'), join(src, 'big.txt')] });
    expect(posted.error).toBe(false);
    expect(posted.data.posted.attachments.map((a: { name: string }) => a.name)).toEqual(['notes.md', 'pack.bin', 'big.txt']);
    const read = await tool('read_thread', { id });
    const withFiles = read.data.messages.find((m: { attachments?: unknown[] }) => m.attachments)!;
    expect(withFiles.attachments[0]).toMatchObject({ name: 'notes.md', size: 13, type: 'text/plain', by: 'agent' });
    expect(withFiles.attachments[0].path.startsWith('/')).toBe(true);
    expect(read.data.notice).toContain('contents of an attached file');
    const [notes, bin, big] = withFiles.attachments as { id: string; path: string }[];
    const text = await tool('get_attachment', { id, attachment: notes!.id });
    expect(text.data.text).toBe('# Notes\nhello');
    expect(text.data.attachment.path).toBe(notes!.path);
    const binary = await tool('get_attachment', { id, attachment: bin!.id });
    expect(binary.data.text).toBeUndefined();
    expect(binary.data.attachment.path).toBe(bin!.path);
    const large = await tool('get_attachment', { id, attachment: big!.id });
    expect(large.data.text).toBeUndefined(); // over 1 MB: the path only
    expect(large.data.attachment.path).toBe(big!.path);
    expect((await tool('get_attachment', { id, attachment: 'u0000000000000000' })).error).toBe(true);
    await close();
  } finally { await rm(src, { recursive: true, force: true }); }
});
test('the data folder keeps working when it has files in it: thread lists skip the upload staging folder', async () => {
  const id = await thread();
  await mkdir(join(dir, '_uploads', 'u0000000000000001'), { recursive: true });
  const list = await (await handle(new Request(url('api/threads')))).json();
  expect(list.map((t: { id: string }) => t.id)).toEqual([id]);
});

// ---- 0.9.4 review fixes
test('createUpload cleans stale partials before the disk check, so a full volume cannot lock itself out', async () => {
  const GiB = 1024 ** 3;
  const stale = await (await handle(json('api/uploads', 'POST', { name: 'stale.dat', size: 10 }))).json();
  const longAgo = new Date(Date.now() - 25 * 3600e3);
  for (const f of await readdir(join(dir, '_uploads', stale.id))) await utimes(join(dir, '_uploads', stale.id, f), longAgo, longAgo);
  // Free space sits at the floor while the stale partial is there, and is plentiful once it is gone.
  const disk = async () => ({ free: (await readdir(join(dir, '_uploads'))).includes(stale.id) ? 20 * GiB : 60 * GiB, total: 100 * GiB });
  const small = createHandler(dir, undefined, { files: { env: { FEEDBACK_MIN_FREE_BYTES: String(20 * GiB) }, disk } });
  const res = await small(json('api/uploads', 'POST', { name: 'new.dat', size: 10 }));
  expect(res.status).toBe(201);
  expect((await readdir(join(dir, '_uploads'))).includes(stale.id)).toBe(false);
});
test('starting through the bin serve path sweeps a 48 hour old partial upload', async () => {
  const old = join(dir, '_uploads', 'u0123456789abcdef');
  await mkdir(old, { recursive: true });
  await writeFile(join(old, 'part'), 'half'); await writeFile(join(old, 'meta.json'), '{}');
  const longAgo = new Date(Date.now() - 48 * 3600e3);
  for (const f of ['part', 'meta.json']) await utimes(join(old, f), longAgo, longAgo);
  const proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'bin', 'react-feedback.ts'), 'serve'], { env: { ...process.env, FEEDBACK_DIR: dir, PORT: '0', FEEDBACK_REMINDERS: '0' }, stdout: 'ignore', stderr: 'ignore' });
  try {
    let gone = false;
    for (let i = 0; i < 100 && !gone; i++) { gone = !(await stat(old).then(() => true, () => false)); if (!gone) await Bun.sleep(100); }
    expect(gone).toBe(true);
  } finally { proc.kill(); await proc.exited; }
});
const inode = async (path: string) => (await stat(path)).ino;
test('a merge and a move hard-link the files: no extra space, and no disk check', async () => {
  const a = await thread('A'), b = await thread('B'), c = await thread('C');
  const up = await upload(bytesOf(12), 'link.txt');
  const sent = await (await post(a, { text: 'with file', attachments: [up.id] })).json();
  const refuse = { env: { FEEDBACK_MIN_FREE_BYTES: '9000000000000000' } };
  await store.mergeThreads(dir, a, b, 'agent', refuse);
  expect(await inode(join(dir, b, 'files', up.id, 'link.txt'))).toBe(await inode(join(dir, a, 'files', up.id, 'link.txt')));
  await store.moveMessages(dir, b, [(await store.summarise(dir, b)).messages.find(m => m.attachments?.length)!.id], c, 'agent', refuse);
  expect(await readFile(join(dir, c, 'files', up.id, 'link.txt'))).toHaveLength(12);
  await expect(stat(join(dir, b, 'files', up.id))).rejects.toThrow();
  expect(sent.id).toBeTruthy();
});
test('when a link cannot be made, a merge copies only if the disk guard allows it', async () => {
  const a = await thread('A'), b = await thread('B');
  const up = await upload(bytesOf(12), 'copy.txt');
  await post(a, { text: 'with file', attachments: [up.id] });
  const noLink = async () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); };
  await expect(store.mergeThreads(dir, a, b, 'agent', { link: noLink, env: { FEEDBACK_MIN_FREE_BYTES: '9000000000000000' } })).rejects.toThrow('Not enough disk space on the server');
  await expect(stat(join(dir, b, 'files', up.id, 'copy.txt'))).rejects.toThrow();
  await store.mergeThreads(dir, a, b, 'agent', { link: noLink }); // the retry, with room
  expect(await readFile(join(dir, b, 'files', up.id, 'copy.txt'))).toHaveLength(12);
  expect(await inode(join(dir, b, 'files', up.id, 'copy.txt'))).not.toBe(await inode(join(dir, a, 'files', up.id, 'copy.txt')));
});
test('redacting a message also takes the linked copies out of the merged thread and into the vault', async () => {
  const a = await thread('A'), b = await thread('B');
  const up = await upload(Buffer.from('private notes'), 'private.txt');
  const sent = await (await post(a, { text: 'sensitive', attachments: [up.id] })).json();
  await store.mergeThreads(dir, a, b, 'agent');
  expect(await inode(join(dir, b, 'files', up.id, 'private.txt'))).toBe(await inode(join(dir, a, 'files', up.id, 'private.txt')));
  expect((await redactMessage(dir, a, sent.id, { by: 'user', vault })).failed).toEqual([]);
  for (const t of [a, b]) {
    expect((await handle(new Request(url(`api/threads/${t}/attachments/${up.id}`)))).status).toBe(404);
    await expect(stat(join(dir, t, 'files', up.id))).rejects.toThrow();
    expect(await readFile(join(vault, t, `${(await store.summarise(dir, t)).messages.find(m => m.redacted)!.id}.files`, up.id, 'private.txt'), 'utf8')).toBe('private notes');
  }
});
