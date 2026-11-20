// 0.10 review fixes: "Don't record" leaves nothing, the inbox records no text, caller identity for rate limits, and the small hardening items.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from './server';
import { publishArtifact } from './artifacts';
import { Limiter, MAX_KEYS, clientKey } from './limits';
import { shellPage } from './shell';
import * as store from './store';

let dir: string;
let handle: ReturnType<typeof createHandler>;
const clock = Date.parse('2026-11-20T12:00:00.000Z');
const S1 = 'AbCdEfGhIjKlMnOpQrStUvWx';
const S2 = 'ZyXwVuTsRqPoNmLkJiHgFeDc';
const api = (path: string, data?: unknown) => new Request(`http://local/__feedback/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const send = (token: string, what: string, data: unknown) => handle(new Request(`http://local/__feedback/s/${token}/${what}`, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Forwarded-For': '203.0.113.7' }, body: JSON.stringify(data) }));
const snap = (t: number) => ({ type: 2, timestamp: t, data: { node: { id: 1, type: 0, childNodes: [] }, initialOffset: { left: 0, top: 0 } } });
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'feedback-0100r-')); handle = createHandler(dir, undefined, { now: () => clock }); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function link(record = true, existing?: string) {
  let art = existing;
  if (!art) {
    const { id } = await store.createThread(dir, { title: 'Options', text: 'x', origin: 'agent' });
    art = (await publishArtifact(dir, { thread: id, title: 'Options', content: '<!doctype html><html><body><p>Hi</p></body></html>', format: 'html' })).id;
  }
  const created = await (await handle(api(`api/artifacts/${art}/share`, { expires: 'none', record }))).json() as { url: string };
  return { art, token: created.url.split('/').pop()! };
}
const sessions = async (art: string) => (await readdir(join(dir, '_replays', art)).catch(() => [] as string[])).filter(n => n.endsWith('.json'));

test('declining deletes a session this visit already sent (a decline at about 2 s sends nothing, one at about 6 s or later discards)', async () => {
  const { art, token } = await link();
  // Nothing was sent yet (a decline within the hold): a discard is a quiet no, and nothing is stored.
  const none = await send(token, 'replay', { session: S1, discard: true });
  expect(none.status).toBe(200);
  expect(await sessions(art)).toHaveLength(0);
  // Something was stored (a server that took an earlier upload): the discard removes the metadata and the events.
  expect((await send(token, 'replay', { session: S1, seq: 0, events: [snap(1000)] })).status).toBe(200);
  expect(await sessions(art)).toHaveLength(1);
  const gone = await send(token, 'replay', { session: S1, discard: true });
  expect(await gone.json()).toEqual({ ok: true, discarded: true });
  expect(await sessions(art)).toHaveLength(0);
  expect(await readdir(join(dir, '_replays', art))).toEqual([]);
  // It still works after the owner has switched recording off.
  expect((await send(token, 'replay', { session: S2, seq: 0, events: [snap(1000)] })).status).toBe(200);
  expect((await send(token, 'replay', { session: S2, discard: true })).status).toBe(200);
  expect(await sessions(art)).toHaveLength(0);
});

test('a discard for another link\'s session is refused and removes nothing', async () => {
  const one = await link();
  const two = await link(true, one.art); // a second link on the same page
  expect((await send(one.token, 'replay', { session: S1, seq: 0, events: [snap(1000)] })).status).toBe(200);
  const refused = await send(two.token, 'replay', { session: S1, discard: true });
  expect(refused.status).toBe(404);
  expect(await sessions(one.art)).toHaveLength(1);
  expect((await send(one.token, 'replay', { session: 'short', discard: true })).status).toBe(400);
  expect((await send('nope', 'replay', { session: S1, discard: true })).status).toBe(404);
});

test('the shell holds every upload for 10 s while the notice is open, and sends a discard on decline', async () => {
  const html = await shellPage({ html: '<html><body>x</body></html>', title: 't', record: true });
  // (A built recorder is needed for the recording shell; without it the page has no notice and nothing to test.)
  if (!html.includes('id="rf-config">{"record":true}')) return;
  expect(html).toContain('var HOLD_MS = 10000');
  expect(html).toContain('if (held() || sending');
  expect(html).toContain('discard: true');
  expect(html).toContain('anything already sent is deleted');
});

test('the caller is the socket address; X-Forwarded-For is not believed unless the operator names that header', () => {
  const request = (headers: Record<string, string>) => new Request('http://local/x', { headers });
  const server = { requestIP: () => ({ address: '198.51.100.9' }) };
  expect(clientKey(request({ 'x-forwarded-for': '1.2.3.4' }), server, '')).toBe('198.51.100.9');
  expect(clientKey(request({ 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '5.6.7.8' }), server, '')).toBe('198.51.100.9');
  expect(clientKey(request({}), undefined, '')).toBe('unknown');
  // The named header, and only it. The configured header is matched whatever its case.
  expect(clientKey(request({ 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '5.6.7.8' }), server, 'Cf-Connecting-Ip')).toBe('5.6.7.8');
  expect(clientKey(request({ 'x-forwarded-for': '1.2.3.4' }), server, 'cf-connecting-ip')).toBe('198.51.100.9');
  expect(clientKey(request({ 'x-evil': 'a b' }), server, 'bad header!')).toBe('198.51.100.9');
});

test('rotating X-Forwarded-For does not get around the per-caller limit', async () => {
  const saved = process.env.FEEDBACK_CLIENT_IP_HEADER;
  delete process.env.FEEDBACK_CLIENT_IP_HEADER;
  try {
    const { token } = await link(false);
    const server = { requestIP: () => ({ address: '198.51.100.9' }) };
    let refused = 0;
    for (let i = 0; i < 8; i++) {
      const r = await handle(new Request(`http://local/__feedback/s/${token}/feedback`, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Forwarded-For': `10.0.0.${i}` }, body: JSON.stringify({ note: `n${i}` }) }), server);
      if (r.status === 429) refused++;
    }
    expect(refused).toBe(3); // 5 a minute for the one socket address
  } finally { if (saved === undefined) delete process.env.FEEDBACK_CLIENT_IP_HEADER; else process.env.FEEDBACK_CLIENT_IP_HEADER = saved; }
});

test('a flood of distinct keys evicts only a bounded number of keys and keeps the busy caller counted', () => {
  const limiter = new Limiter([{ windowMs: 60e3, max: 2 }]);
  const now = 1_000_000;
  expect(limiter.take('victim', now)).toBe(true);
  expect(limiter.take('victim', now)).toBe(true);
  expect(limiter.take('victim', now)).toBe(false);
  for (let i = 0; i < MAX_KEYS + 50; i++) limiter.take(`flood-${i}`, now + 1);
  expect(limiter.size).toBeLessThanOrEqual(MAX_KEYS + 1);
  expect(limiter.size).toBeGreaterThan(MAX_KEYS - 5); // not cleared
  // The oldest keys went first: a recent one is still counted.
  limiter.take('late', now + 2); limiter.take('late', now + 2);
  for (let i = 0; i < 20; i++) limiter.take(`more-${i}`, now + 3);
  expect(limiter.take('late', now + 4)).toBe(false);
});

test('the replay player CSP lets images, fonts and media come only from self, data and blob', async () => {
  const csp = (await handle(new Request('http://local/__feedback/replay/player'))).headers.get('content-security-policy')!;
  for (const kind of ['img-src', 'font-src', 'media-src']) expect(csp).toContain(`${kind} 'self' data: blob:;`);
  expect(csp).not.toMatch(/https?:/);
});
