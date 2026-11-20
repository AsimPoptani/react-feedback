// 0.12.0: a screenshot with a viewer's note, the owner's capture, the live read of a recording, and typing in a merged-away thread.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHandler } from './server';
import { run } from './cli';
import { createMcpServer } from './mcp';
import { publishArtifact } from './artifacts';
import { LIVE_MAX_EVENTS, appendChunk, readReplayAfter } from './replay';
import { shellPage, shellScript } from './shell';
import { parseShot } from './inbox/shot.js';
import * as store from './store';

let dir: string;
let handle: ReturnType<typeof createHandler>;
let clock = Date.parse('2026-11-20T12:00:00.000Z');
const withClientIpHeader = (body: () => Promise<void>) => async () => {
  const saved = process.env.FEEDBACK_CLIENT_IP_HEADER;
  process.env.FEEDBACK_CLIENT_IP_HEADER = 'x-forwarded-for';
  try { await body(); } finally { if (saved === undefined) delete process.env.FEEDBACK_CLIENT_IP_HEADER; else process.env.FEEDBACK_CLIENT_IP_HEADER = saved; }
};
const SESSION = 'AbCdEfGhIjKlMnOpQrStUvWx';
const api = (path: string, data?: unknown, method?: string) => new Request(`http://local/__feedback/${path}`, data === undefined && !method ? {} : { method: method ?? 'POST', headers: { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
const viewer = (token: string, what: 'feedback' | 'replay', data: unknown, init: { ip?: string; query?: string } = {}) => handle(new Request(`http://local/__feedback/s/${token}/${what}${init.query ?? ''}`, {
  method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Forwarded-For': init.ip ?? '203.0.113.7' }, body: typeof data === 'string' ? data : JSON.stringify(data) }));
const withShot = (token: string, data: unknown, ip?: string) => viewer(token, 'feedback', data, { query: '?image=1', ...(ip ? { ip } : {}) });
const textOf = (path: string) => handle(new Request(`http://local${path}`));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'feedback-0120-'));
  clock = Date.parse('2026-11-20T12:00:00.000Z');
  handle = createHandler(dir, undefined, { now: () => clock });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

// A real PNG (its checksums are right) and a minimal JPEG (a frame header and a scan), enough for the server to read their structure.
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { let c = (crc ^ byte) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
const chunk = (type: string, data: Buffer) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
function png(width = 4, height = 4, padding = 0): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 0;
  const rows = Buffer.alloc(Math.min(height, 8) * (Math.min(width, 8) + 1), 0x7f);
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), ...(padding ? [chunk('tEXt', Buffer.alloc(padding, 0x61))] : []), chunk('IEND', Buffer.alloc(0))];
  return Buffer.concat(parts);
}
function jpeg(width = 4, height = 4): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x01, 0x01, 0x11, 0x00]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, sos, Buffer.from([0xff, 0xd9])]);
}
const dataUrl = (bytes: Buffer, type = 'png') => `data:image/${type};base64,${bytes.toString('base64')}`;

async function setup() {
  const { id } = await store.createThread(dir, { title: 'Checkout page', text: 'Here is the page', origin: 'agent' });
  const art = await publishArtifact(dir, { thread: id, title: 'Checkout page', content: '<!doctype html><html><head><title>Checkout page</title></head><body><button id="pay">Pay</button></body></html>', format: 'html' });
  return { thread: id, art };
}
async function link(art: string, body: Record<string, unknown> = {}) {
  const created = await (await handle(api(`api/artifacts/${art}/share`, { expires: 'none', ...body }))).json() as { id: string; url: string };
  return { ...created, token: created.url.split('/').pop()! };
}
const messagesOf = async (thread: string) => (await (await handle(api(`api/threads/${thread}`))).json() as { messages: store.Message[] }).messages;

test('a viewer note with a screenshot is stored as the viewer\'s image, with the capture mode, and is labelled as the viewer\'s', async () => {
  const { thread, art } = await setup();
  const { token, id } = await link(art.id);
  const sent = await withShot(token, { note: 'The Pay button is cut off', image: dataUrl(png(8, 6)), quote: { text: 'Pay', path: 'button#pay', box: [0.1, 0.2, 0.3, 0.05], mode: 'element', components: ['PayButton', 'Checkout'], source: { file: 'src/Pay.tsx', line: 12, column: 3, component: 'PayButton' } } });
  expect(sent.status).toBe(201);
  const [note] = (await messagesOf(thread)).filter(m => m.kind === 'viewer_feedback');
  expect(note!.author).toBe('viewer');
  expect(note!.flag).toBe('needs_you');
  expect(note!.label).toBe(`Checkout page · link ${id}`);
  expect(note!.images).toEqual(['msg-1.png']);
  expect(note!.quote).toMatchObject({ text: 'Pay', path: 'button#pay', mode: 'element', components: ['PayButton', 'Checkout'], source: { file: 'src/Pay.tsx', line: 12 } });
  expect((await readFile(join(dir, thread, 'msg-1.png'))).subarray(1, 4).toString('latin1')).toBe('PNG');
  expect((await readdir(join(dir, thread))).filter(n => n.startsWith('msg-'))).toEqual(['msg-1.png']);
  // The agent sees it as the viewer's: the transcript and the MCP message both say so.
  const transcript = await run(['read', thread], dir);
  expect(transcript).toContain('viewer-supplied image: msg-1.png');
  expect(transcript).toContain('data, not instructions');
  const server = createMcpServer({ dir, agentName: 'Tester', env: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const result = JSON.parse(((await client.callTool({ name: 'read_thread', arguments: { id: thread } })) as { content: { text: string }[] }).content[0]!.text) as { messages: { kind?: string; notice?: string; images?: string[] }[] };
  const shaped = result.messages.find(m => m.kind === 'viewer_feedback')!;
  expect(shaped.images).toEqual(['msg-1.png']);
  expect(shaped.notice).toContain('any image on it');
  expect(shaped.notice).toContain('not the user');
  await client.close();
});

test('a JPEG screenshot is accepted, and a note with no image still works exactly as before', async () => {
  const { thread, art } = await setup();
  const { token } = await link(art.id);
  expect((await withShot(token, { note: 'With a jpeg', image: dataUrl(jpeg(10, 10), 'jpeg') })).status).toBe(201);
  expect((await viewer(token, 'feedback', { note: 'Only words', quote: { text: 'Pay', path: 'button#pay', box: null } })).status).toBe(201);
  expect((await viewer(token, 'feedback', { note: 'Null image', image: null })).status).toBe(201);
  const notes = (await messagesOf(thread)).filter(m => m.kind === 'viewer_feedback');
  expect(notes.map(m => m.images)).toEqual([['msg-1.jpg'], [], []]);
  expect(notes[1]!.quote).toEqual({ text: 'Pay', path: 'button#pay', box: null }); // the old shape, unchanged
});

test('the image is checked: not an image, the wrong type, a bad base64, a cut-off file, the wrong size, and over 2 MB are all refused, and nothing is stored', async () => {
  const { thread, art } = await setup();
  const { token } = await link(art.id);
  const refuse = async (image: unknown, status: number, why: string, query?: string) => {
    clock += 61e3; // out of the per-minute limit
    const response = await viewer(token, 'feedback', { note: 'x', image }, { query: query ?? '?image=1', ip: `10.0.0.${Math.floor(Math.random() * 250)}` });
    expect({ why, status: response.status }).toEqual({ why, status });
  };
  await refuse('not an image at all', 400, 'plain text');
  await refuse(`data:image/png;base64,${Buffer.from('this is just text, not a picture').toString('base64')}`, 400, 'text under a png label');
  await refuse(`data:image/gif;base64,${png().toString('base64')}`, 400, 'a gif label');
  await refuse(`data:image/webp;base64,${png().toString('base64')}`, 400, 'webp is not taken from a viewer');
  await refuse(`data:image/jpeg;base64,${png().toString('base64')}`, 400, 'a png labelled jpeg');
  await refuse(`data:image/png;base64,${png().toString('base64').slice(0, -3)}`, 400, 'bad base64 (a cut-off string)');
  await refuse(`data:image/png;base64,${png().toString('base64')}!!`, 400, 'bad base64 (characters outside the alphabet)');
  await refuse(`data:image/png;base64,${png().toString('base64').replace(/=+$/, '').slice(0, -1)}A`, 400, 'base64 that does not round trip');
  await refuse(dataUrl(png().subarray(0, 40)), 400, 'a png with no end');
  await refuse(dataUrl(Buffer.concat([png(), Buffer.from('trailing')])), 400, 'a png with bytes after its end');
  await refuse(dataUrl(jpeg().subarray(0, 14), 'jpeg'), 400, 'a jpeg that stops before its end');
  await refuse(dataUrl(png(5000, 100)), 400, 'a png wider than 4096');
  await refuse(dataUrl(png(100, 17000)), 400, 'a png taller than 16384');
  await refuse(dataUrl(png(0, 5)), 400, 'a png with no width');
  await refuse(dataUrl(png(8, 8, 2 * 1024 * 1024)), 413, 'a png over 2 MB');
  expect((await messagesOf(thread)).filter(m => m.kind === 'viewer_feedback')).toHaveLength(0);
  expect((await readdir(join(dir, thread))).filter(n => n.startsWith('msg-'))).toHaveLength(0);
});

test('a note that carries an image without ?image=1 is held to the small body cap, and an image under it is read', async () => {
  const { art } = await setup();
  const { token } = await link(art.id);
  const big = await viewer(token, 'feedback', { note: 'x', image: dataUrl(png(8, 8, 200 * 1024)) });
  expect(big.status).toBe(413);
  expect((await withShot(token, { note: 'x', image: dataUrl(png(8, 8, 200 * 1024)) }, '10.1.1.1')).status).toBe(201);
  clock += 61e3;
  // The larger body is for an image only: a note far past the cap is refused even with the flag.
  expect((await withShot(token, { note: 'x', pad: 'z'.repeat(4 * 1024 * 1024) }, '10.1.1.2')).status).toBe(413);
});

test('each link may receive 20 MB of screenshots a day, then the picture is refused (429) while a note alone still goes through', withClientIpHeader(async () => {
  const { thread, art } = await setup();
  const { token } = await link(art.id);
  const other = await link(art.id);
  const image = dataUrl(png(8, 8, 1800 * 1024)); // just under the 2 MB each
  let accepted = 0, refused = 0, n = 0;
  for (let i = 0; i < 14; i++) {
    if (i % 4 === 0) clock += 61e3;
    const status = (await withShot(token, { note: `shot ${i}`, image }, `192.0.2.${++n}`)).status;
    if (status === 201) accepted++; else { expect(status).toBe(429); refused++; }
  }
  expect(accepted).toBe(11); // 11 x 1.8 MB = 19.8 MB; the 12th would pass 20 MB
  expect(refused).toBe(3);
  clock += 61e3;
  expect((await viewer(token, 'feedback', { note: 'a note alone is still taken' }, { ip: '192.0.2.200' })).status).toBe(201);
  expect((await withShot(other.token, { note: 'another link has its own budget', image }, '192.0.2.201')).status).toBe(201);
  clock += 25 * 3600e3; // a day later the budget is back
  expect((await withShot(token, { note: 'next day', image }, '192.0.2.202')).status).toBe(201);
  expect((await readdir(join(dir, thread))).filter(n => n.startsWith('msg-')).length).toBe(11 + 1 + 1);
}));

test('a revoked or unknown link is the same 404 for a screenshot as for a note', async () => {
  const { art } = await setup();
  const { token, id } = await link(art.id);
  await handle(api(`api/shares/${id}/revoke`, {}));
  const shape = async (response: Response) => ({ status: response.status, body: await response.text(), type: response.headers.get('content-type') });
  const note = await shape(await viewer(token, 'feedback', { note: 'x' }));
  const shot = await shape(await withShot(token, { note: 'x', image: dataUrl(png()) }, '10.2.2.2'));
  const unknown = await shape(await withShot('not-a-real-token-at-all', { note: 'x', image: dataUrl(png()) }, '10.2.2.3'));
  expect(note.status).toBe(404);
  expect(shot).toEqual(note);
  expect(unknown).toEqual(note);
});

test('a capture mode and components on a quote are kept only when they are real', async () => {
  const { thread, art } = await setup();
  const { token } = await link(art.id);
  await viewer(token, 'feedback', { note: 'one', quote: { text: '', path: '', box: [0.1, 0.1, 0.5, 0.5], mode: 'region' } });
  clock += 61e3;
  await viewer(token, 'feedback', { note: 'two', quote: { text: 'x', path: 'p', box: null, mode: 'bogus', components: [1, 'Ok', 'x'.repeat(200)], source: { file: 5, line: 1 } } }, { ip: '10.3.3.3' });
  clock += 61e3;
  await viewer(token, 'feedback', { note: 'three', quote: { mode: 'page' } }, { ip: '10.3.3.4' });
  const notes = (await messagesOf(thread)).filter(m => m.kind === 'viewer_feedback');
  expect(notes[0]!.quote).toEqual({ text: '', path: '', box: [0.1, 0.1, 0.5, 0.5], mode: 'region' });
  expect(notes[1]!.quote).toEqual({ text: 'x', path: 'p', box: null, components: ['Ok', 'x'.repeat(80)] });
  expect(notes[2]!.quote).toEqual({ text: '', path: '', box: null, mode: 'page' });
});

test('the share page carries the capture script and a Feedback button with the capture modes; the plain artifact page is unchanged; ?capture=1 adds only the script', async () => {
  const { art } = await setup();
  const { token } = await link(art.id);
  const html = await (await textOf(`/__feedback/s/${token}`)).text();
  if (!html.includes('data-react-feedback-root')) return; // dist/capture.js is not built here
  expect(html).toContain('data-capture="region"');
  expect(html).toContain('data-capture="page"');
  expect(html).toContain('event.source !== frame.contentWindow');
  expect(html).not.toMatch(/<script[^>]+src=/);
  expect(html).not.toContain('/__feedback/api');
  expect(html).not.toMatch(/parent\.(document|localStorage|sessionStorage|cookie)/);
  // The owner's view: the same capture script, only with ?capture=1; without it the page is the one that was published.
  const plain = await (await textOf(`/__feedback/a/${art.id}/v1`)).text();
  const owner = await textOf(`/__feedback/a/${art.id}/v1?capture=1`);
  expect(plain).not.toContain('data-react-feedback-root');
  const body = await owner.text();
  expect(body).toContain('data-react-feedback-root');
  expect(body).toContain('<button id="pay">Pay</button>');
  expect(owner.headers.get('content-security-policy')).toBe('sandbox allow-scripts allow-popups');
  expect(body).not.toContain('/__feedback/api');
});

test('the owner\'s capture is an ordinary message from the user, with the image, on the artifact\'s thread', async () => {
  const { thread, art } = await setup();
  const sent = await handle(api(`api/threads/${thread}/messages`, { text: 'The header overlaps the form\n\n— Checkout page v1 · Region', images: [dataUrl(png(30, 20))] }));
  expect(sent.status).toBe(201);
  const last = (await messagesOf(thread)).at(-1)!;
  expect(last.author).toBe('user');
  expect(last.images).toEqual(['msg-1.png']);
  expect(last.text).toContain('Checkout page v1');
  expect((await readFile(join(dir, thread, 'msg-1.png'))).length).toBeGreaterThan(20);
  expect(art.id).toBeTruthy();
});

test('the shell page says what is sent, and holds the parse function it believes the artifact with', async () => {
  const html = await shellPage({ html: '<html><body>x</body></html>', title: 't', record: false });
  expect(html).toContain('Only your note, your screenshot and what you point at are sent');
  expect(html).toContain('function parseShot');
  expect(html).toContain("feedback' + (withImage ? '?image=1' : '')");
});

// ---- Live: the cursor read of a recording that is still coming in
const snap = (t: number) => ({ type: 2, timestamp: t, data: { node: { id: 1, type: 0, childNodes: [] }, initialOffset: { left: 0, top: 0 } } });
const move = (t: number) => ({ type: 3, timestamp: t, data: { source: 1, positions: [{ x: 1, y: 2, id: 3, timeOffset: 0 }] } });
const click = (t: number) => ({ type: 3, timestamp: t, data: { source: 2, type: 2, id: 7, x: 40, y: 20 } });
const t0 = 1_700_000_000_000;

test('the cursor read returns only the events after the cursor, and a new cursor, for an artifact\'s session', async () => {
  const { art } = await setup();
  const { token } = await link(art.id, { record: true });
  const send = (seq: number, events: unknown[]) => viewer(token, 'replay', { session: SESSION, seq, events });
  expect((await send(0, [snap(t0), move(t0 + 10)])).status).toBe(200);
  const read = async (after: number | string) => (await handle(api(`api/artifacts/${art.id}/replays/${SESSION}?after=${after}`))).json() as Promise<{ events: { timestamp: number }[]; cursor: number; live: boolean; meta: { events: number } }>;
  const first = await read(0);
  expect(first.events.map(e => e.timestamp)).toEqual([t0, t0 + 10]);
  expect(first.cursor).toBe(2);
  expect(first.live).toBe(true);
  expect((await send(1, [click(t0 + 20), move(t0 + 30), move(t0 + 40)])).status).toBe(200);
  expect((await send(2, [move(t0 + 50)])).status).toBe(200);
  const next = await read(first.cursor);
  expect(next.events.map(e => e.timestamp)).toEqual([t0 + 20, t0 + 30, t0 + 40, t0 + 50]);
  expect(next.cursor).toBe(6);
  expect((await read(4)).events.map(e => e.timestamp)).toEqual([t0 + 40, t0 + 50]); // a cursor in the middle of a chunk
  const caughtUp = await read(6);
  expect(caughtUp.events).toEqual([]);
  expect(caughtUp.cursor).toBe(6);
  expect((await read(99)).cursor).toBe(6); // past the end: nothing, and the true cursor
  // Without ?after the old whole-session read is unchanged.
  const whole = await (await handle(api(`api/artifacts/${art.id}/replays/${SESSION}`))).json() as { events: unknown[]; meta: Record<string, unknown> };
  expect(whole.events).toHaveLength(6);
  expect(whole.meta).not.toHaveProperty('idx');
  // It has not been live for 30 s: ended.
  clock += 31e3;
  expect((await read(6)).live).toBe(false);
  expect((await (await handle(api(`api/artifacts/${art.id}/replays/${SESSION}?after=abc`))).text())).toContain('after must be');
  expect((await handle(api(`api/artifacts/${art.id}/replays/${SESSION}?after=-1`))).status).toBe(400);
  expect((await handle(api(`api/artifacts/${art.id}/replays/ZyXwVuTsRqPoNmLkJiHgFeDc?after=0`))).status).toBe(404);
});

test('the list marks a session live while a chunk is under 20 s old, and the cursor read works for a recording from before the index existed', async () => {
  const { art } = await setup();
  const { token } = await link(art.id, { record: true });
  await viewer(token, 'replay', { session: SESSION, seq: 0, events: [snap(t0), move(t0 + 5)] });
  await viewer(token, 'replay', { session: SESSION, seq: 1, events: [move(t0 + 9), move(t0 + 12)] });
  const rows = async () => (await (await handle(api(`api/artifacts/${art.id}/replays`))).json()) as { session: string; live: boolean }[];
  expect((await rows())[0]!.live).toBe(true);
  clock += 19e3;
  expect((await rows())[0]!.live).toBe(true);
  clock += 2e3;
  expect((await rows())[0]!.live).toBe(false);
  // A session written by 0.11 has no chunk table: the read starts from the beginning and gets the same answer.
  const file = join(dir, '_replays', art.id, `${SESSION}.json`);
  const meta = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  expect(Array.isArray(meta.idx)).toBe(true);
  delete meta.idx; delete meta.gz;
  await writeFile(file, JSON.stringify(meta));
  const old = await (await handle(api(`api/artifacts/${art.id}/replays/${SESSION}?after=3`))).json() as { events: { timestamp: number }[]; cursor: number };
  expect(old.events.map(e => e.timestamp)).toEqual([t0 + 12]);
  expect(old.cursor).toBe(4);
  // And the next chunk of that session indexes itself from where the file ends.
  await viewer(token, 'replay', { session: SESSION, seq: 2, events: [move(t0 + 20)] });
  const after = await (await handle(api(`api/artifacts/${art.id}/replays/${SESSION}?after=4`))).json() as { events: { timestamp: number }[]; cursor: number };
  expect(after.events.map(e => e.timestamp)).toEqual([t0 + 20]);
  expect(after.cursor).toBe(5);
});

test('one cursor read returns at most LIVE_MAX_EVENTS and the cursor to continue from', async () => {
  const { art } = await setup();
  const events = Array.from({ length: LIVE_MAX_EVENTS + 1200 }, (_, i) => move(t0 + i));
  await appendChunk(dir, { scope: art.id, link: null, version: 1 }, { session: SESSION, seq: 0, events }, clock);
  const first = (await readReplayAfter(dir, art.id, SESSION, 0, clock))!;
  expect(first.events).toHaveLength(LIVE_MAX_EVENTS);
  expect(first.cursor).toBe(LIVE_MAX_EVENTS);
  const second = (await readReplayAfter(dir, art.id, SESSION, first.cursor, clock))!;
  expect(second.events).toHaveLength(1200);
  expect(second.cursor).toBe(LIVE_MAX_EVENTS + 1200);
});

test('the live read is the owner\'s: it needs the inbox API, and a share link has no way to it', async () => {
  const { art } = await setup();
  const { token } = await link(art.id, { record: true });
  await viewer(token, 'replay', { session: SESSION, seq: 0, events: [snap(t0), move(t0 + 5)] });
  const miss = await handle(new Request(`http://local/__feedback/s/${token}/replay?after=0`));
  expect(miss.status).toBe(404);
  expect((await handle(new Request(`http://local/__feedback/s/${token}/replays/${SESSION}?after=0`))).status).toBe(404);
  expect((await handle(new Request(`http://local/__feedback/s/${token}/replay`, { method: 'GET' }))).status).toBe(404);
  const text = await (await handle(new Request(`http://local/__feedback/s/${token}`))).text();
  expect(text).not.toContain('/__feedback/api'); // the viewer's page has no way to the owner's reads
  // The owner's own inbox sessions have the same read.
  await handle(api('api/replay-settings', { record_inbox: true }));
  const own = await handle(api('api/replays', { session: 'OwnSession0123456789abc', seq: 0, events: [snap(t0), move(t0 + 5)] }));
  expect(own.status).toBe(200);
  const read = await (await handle(api('api/replays/OwnSession0123456789abc?after=1'))).json() as { events: unknown[]; cursor: number; live: boolean };
  expect(read.events).toHaveLength(1);
  expect(read.cursor).toBe(2);
  expect(read.live).toBe(true);
  const list = await (await handle(api('api/replays'))).json() as { live: boolean }[];
  expect(list[0]!.live).toBe(true);
});

test('typing in a merged-away thread: the send is forwarded to the target, with the line saying where it was sent from', async () => {
  const source = await store.createThread(dir, { title: 'Side thread', text: 'Side', origin: 'user' });
  const target = await store.createThread(dir, { title: 'Main thread', text: 'Main', origin: 'user' });
  expect((await handle(api(`api/threads/${source.id}/merge`, { into: target.id }))).status).toBe(200);
  const sent = await handle(api(`api/threads/${source.id}/messages`, { text: 'Sent after the merge', images: [dataUrl(png(10, 10))] }));
  expect(sent.status).toBe(201);
  const body = await sent.json() as store.Message;
  expect(body.forwarded_to).toBe(target.id);
  expect(body.images).toHaveLength(1);
  const last = (await messagesOf(target.id)).at(-1)!;
  expect(last.text).toContain('Sent after the merge');
  expect(last.text).toContain('Side thread');
  expect(last.images).toHaveLength(1);
  // A question is not forwarded: it stays read-only in the merged-away thread.
  const answer = await handle(api(`api/threads/${source.id}/answer`, { question_id: 'q1', option_ids: ['o1'] }));
  expect(answer.status).toBeGreaterThanOrEqual(400);
});

test('the shell script declares each name once (a function and a variable of one name shadow each other silently, and broke recording once)', () => {
  const whole = shellScript();
  const code = whole.replace(parseShot.toString(), ''); // its own function has its own names
  new Function(whole.replace(/^\(function \(\) \{/, '(function () { return;')); // it parses
  const declared = [...code.matchAll(/\bfunction ([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]!);
  const vars = [...code.matchAll(/\bvar ([A-Za-z_$][\w$]*)\b/g)].map(m => m[1]!);
  const clashes = declared.filter(name => vars.includes(name)).concat(declared.filter((name, i) => declared.indexOf(name) !== i));
  expect(clashes).toEqual([]);
});
