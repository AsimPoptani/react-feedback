// Remote mode and pairing: the security rules. Every request on the remote listener needs a paired device, except the exact exemptions.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from './server';
import { run } from './cli';
import { CODE_TTL_MS, DEVICE_TTL_MS, MAX_OPEN_CODES, Pairing, deviceName } from './pair';
import { pairRoutes } from './pair-routes';
import { createRemoteHandler, findTunnelUrl, isShareRoute, loadPublicUrl, loadRemotePort, pairPage, startRemote, startTunnel } from './remote';

const PUBLIC = 'https://phone.example.test';
const SHARE = 'A'.repeat(43);
let dir: string;
let pairing: Pairing;
let clock: number;
let local: ReturnType<typeof createHandler>;
let remote: ReturnType<typeof createRemoteHandler>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'feedback-remote-'));
  pairing = new Pairing(dir);
  pairing.remote = { on: true, publicUrl: PUBLIC, source: 'env' };
  clock = Date.parse('2026-11-20T10:00:00Z');
  local = createHandler(dir, undefined, { extra: pairRoutes(pairing), now: () => clock });
  remote = createRemoteHandler(local, pairing, { now: () => clock, publicUrl: () => PUBLIC });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const url = (path: string) => `${PUBLIC}${path}`;
const json = (path: string, body: unknown, headers: Record<string, string> = {}, method = 'POST') => new Request(url(path), { method, headers: { 'Content-Type': 'application/json', Origin: PUBLIC, ...headers }, body: JSON.stringify(body) });
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
async function pairOnce(ua = UA_IPHONE, headers: Record<string, string> = {}) {
  const { code } = pairing.createCode(clock);
  const response = await remote(json('/__feedback/api/pair/exchange', { code }, { 'User-Agent': ua, ...headers }));
  const cookie = response.headers.get('set-cookie');
  return { response, code, cookie, token: cookie?.match(/rf_device=([^;]+)/)?.[1] ?? '' };
}
const withCookie = (token: string, path: string, init: RequestInit = {}) => new Request(url(path), { ...init, headers: { Cookie: `rf_device=${token}`, ...(init.headers as Record<string, string>) } });

describe('the remote listener refuses everything without a device', () => {
  const cases: [string, string][] = [
    ['GET', '/__feedback/api/threads'], ['POST', '/__feedback/api/threads'], ['GET', '/__feedback/api/config'], ['GET', '/__feedback/api/profile'], ['GET', '/__feedback/healthz'],
    ['GET', '/__feedback/embed.js'], ['GET', '/__feedback/inbox/app.js'], ['GET', '/__feedback/inbox/sw.js'], ['GET', '/__feedback/api/items'], ['POST', '/__feedback/api/items'],
    ['PUT', '/__feedback/api/uploads/x'], ['DELETE', '/__feedback/api/devices/d00000000'], ['POST', '/__feedback/api/pair/codes'], ['GET', '/__feedback/api/devices'],
    ['POST', '/__feedback/api/devices/revoke-all'], ['GET', '/__feedback/api/pair/status'], ['GET', '/__feedback/api/pair/me'], ['GET', '/__feedback/a/a0123456789ab/v1'], ['GET', '/__feedback/replay/player.js'],
    ['GET', '/__feedback/api/projects'], ['GET', '/__feedback/api/shares'], ['OPTIONS', '/__feedback/api/threads'], ['GET', '/__feedback/s'], ['GET', '/__feedback/s/'], ['POST', '/__feedback/s/short/feedback'],
    ['GET', `/__feedback/s/${SHARE}/feedback`], ['POST', `/__feedback/s/${SHARE}`], ['GET', `/__feedback/s/${SHARE}/replay`], ['GET', '/'], ['GET', '/other'],
    // a dot segment is resolved before routing, so a share-looking prefix cannot reach the API
    ['GET', `/__feedback/s/${SHARE}/../../api/threads`], ['GET', '/__feedback/s/%2e%2e/api/threads'], ['GET', `/__feedback/s/${SHARE}/%2e%2e/%2e%2e/api/threads`], ['POST', '/__feedback/s/../api/threads'],
  ];
  for (const [method, path] of cases) {
    test(`${method} ${path}`, async () => {
      const response = await remote(new Request(url(path), { method, headers: { Origin: PUBLIC } }));
      expect([401, 404, 405]).toContain(response.status);
      if (path.startsWith('/__feedback/api') || path.startsWith('/__feedback/inbox/') || path === '/__feedback/healthz') expect(response.status).toBe(401);
      expect(await response.text()).not.toContain('"threads"');
    });
  }
  test('a loopback caller is not trusted: the socket address changes nothing', async () => {
    const response = await remote(new Request('http://127.0.0.1:8100/__feedback/api/threads'), { requestIP: () => ({ address: '127.0.0.1' }) });
    expect(response.status).toBe(401);
    const forged = await remote(new Request(url('/__feedback/api/threads'), { headers: { 'X-Forwarded-For': '127.0.0.1', 'X-Rf-Remote': '1', 'X-Rf-Device': 'd00000000', Host: 'localhost' } }));
    expect(forged.status).toBe(401);
  });
  test('a made-up or malformed cookie is refused, and cleared', async () => {
    for (const token of ['x', 'a'.repeat(43), 'a'.repeat(300), '../../etc']) {
      const response = await remote(withCookie(token, '/__feedback/api/threads'));
      expect(response.status).toBe(401);
      expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    }
  });
  test('the unpaired answer says nothing about the inbox', async () => {
    const body = await (await remote(new Request(url('/__feedback/api/threads')))).json();
    expect(body.kind).toBe('unpaired');
  });
});

describe('what stays open', () => {
  test('a share link is passed to the handler (a miss there is its own 404, not the device 401)', async () => {
    const page = await remote(new Request(url(`/__feedback/s/${SHARE}`)));
    expect(page.status).toBe(404);
    const sent = await remote(new Request(url(`/__feedback/s/${SHARE}/feedback`), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"note":"x"}' }));
    expect(sent.status).toBe(404);
    const replay = await remote(new Request(url(`/__feedback/s/${SHARE}/replay`), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }));
    expect(replay.status).toBe(404);
    expect(isShareRoute(`/__feedback/s/${SHARE}`, 'GET')).toBe(true);
    expect(isShareRoute(`/__feedback/s/${SHARE}`, 'POST')).toBe(false);
    expect(isShareRoute(`/__feedback/s/${SHARE}/feedback`, 'GET')).toBe(false);
    expect(isShareRoute('/__feedback/s/a/b/c', 'GET')).toBe(false);
  });
  test('the inbox address is a small pairing page, never the inbox', async () => {
    const response = await remote(new Request(url('/__feedback/inbox/')));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('This inbox is private');
    expect(html).not.toContain('id="groups"');
    expect(html).not.toContain('app.js');
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'nonce-[\w-]{20,}'/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const redirect = await remote(new Request(url('/__feedback/inbox')));
    expect(redirect.status).toBe(308);
    expect((await remote(new Request(url('/__feedback/inbox/'), { method: 'HEAD' }))).status).toBe(200);
    expect((await remote(new Request(url('/__feedback/inbox/'), { method: 'POST', headers: { Origin: PUBLIC } }))).status).toBe(401);
  });
  test('the pairing page takes the code from the fragment and wipes it before anything is sent', () => {
    const html = pairPage('n0nce');
    expect(html).toContain('location.hash');
    expect(html.indexOf('history.replaceState')).toBeGreaterThan(0);
    expect(html.indexOf('history.replaceState')).toBeLessThan(html.indexOf('fetch('));
    expect(html).not.toMatch(/location\.search\.[a-z]*code/i);
    expect(html).toContain('nonce="n0nce"');
  });
});

describe('codes', () => {
  test('a code works once', async () => {
    const first = await pairOnce();
    expect(first.response.status).toBe(200);
    const again = await remote(json('/__feedback/api/pair/exchange', { code: first.code }));
    expect(again.status).toBe(401);
  });
  test('bad, used, expired and malformed codes all answer alike', async () => {
    const used = await pairOnce();
    const old = pairing.createCode(clock - CODE_TTL_MS - 1000);
    const answers = [];
    for (const code of ['A'.repeat(22), used.code, old.code, 'short', '', 5, null, { a: 1 }, 'a'.repeat(5000)]) {
      clock += 20e3; // inside the rate limit
      const response = await remote(json('/__feedback/api/pair/exchange', { code }));
      answers.push([response.status, await response.text(), response.headers.get('set-cookie')]);
    }
    expect(answers.every(a => a[0] === 401 && a[1] === answers[0]![1] && a[2] === null)).toBe(true);
    clock += 61e3;
    expect((await remote(json('/__feedback/api/pair/exchange', 'not an object'))).status).toBe(401);
    const broken = await remote(new Request(url('/__feedback/api/pair/exchange'), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: PUBLIC }, body: '{nope' }));
    expect(broken.status).toBe(401);
  });
  test('a code expires after five minutes', () => {
    const { code } = pairing.createCode(1000);
    expect(pairing.redeem(code, 1000 + CODE_TTL_MS - 1)).toBe(true);
    const second = pairing.createCode(1000);
    expect(pairing.redeem(second.code, 1000 + CODE_TTL_MS)).toBe(false);
    expect(CODE_TTL_MS).toBe(300000);
  });
  test('codes are 128 bits, and only their hash is kept', () => {
    const made = pairing.createCode(clock);
    expect(Buffer.from(made.code, 'base64url').length).toBe(16);
    const kept = JSON.stringify((pairing as unknown as { codes: unknown }).codes);
    expect(kept).not.toContain(made.code);
    expect(kept).toMatch(/[0-9a-f]{64}/);
    expect(new Set(Array.from({ length: 20 }, () => pairing.createCode(clock).code)).size).toBe(20);
  });
  test('at most five codes are open: the oldest is dropped', () => {
    const codes = Array.from({ length: MAX_OPEN_CODES + 3 }, () => pairing.createCode(clock));
    expect(pairing.openCodes(clock)).toBe(MAX_OPEN_CODES);
    expect(pairing.redeem(codes[0]!.code, clock)).toBe(false);
    expect(pairing.redeem(codes.at(-1)!.code, clock)).toBe(true);
  });
  test('a code can be withdrawn by its id', () => {
    const made = pairing.createCode(clock);
    expect(pairing.revokeCode(made.id)).toBe(true);
    expect(pairing.redeem(made.code, clock)).toBe(false);
    expect(pairing.revokeCode(made.id)).toBe(false);
  });
  test('creating one is refused from the remote listener without a device, and allowed with one', async () => {
    expect((await remote(json('/__feedback/api/pair/codes', {}))).status).toBe(401);
    const { token } = await pairOnce();
    const made = await remote(withCookie(token, '/__feedback/api/pair/codes', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: PUBLIC }, body: '{}' }));
    expect(made.status).toBe(201);
    const body = await made.json();
    expect(body.code).toMatch(/^[\w-]{22}$/);
    expect(body.ttl_seconds).toBe(300);
  });
  test('on the local listener it works, and is refused when remote mode is off', async () => {
    const made = await local(new Request('http://127.0.0.1:8099/__feedback/api/pair/codes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
    expect(made.status).toBe(201);
    pairing.remote = { on: false, publicUrl: null, source: null };
    expect((await local(new Request('http://127.0.0.1:8099/__feedback/api/pair/codes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }))).status).toBe(409);
    expect(await (await local(new Request('http://127.0.0.1:8099/__feedback/api/pair/status'))).json()).toMatchObject({ remote: false });
  });
  test('the exchange is rate limited per client', async () => {
    const results: number[] = [];
    for (let i = 0; i < 7; i++) results.push((await remote(json('/__feedback/api/pair/exchange', { code: 'B'.repeat(22) }))).status);
    expect(results.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(results.slice(5)).toEqual([429, 429]);
    // a real code is refused too while the client is limited
    const { code } = pairing.createCode(clock);
    expect((await remote(json('/__feedback/api/pair/exchange', { code }))).status).toBe(429);
    clock += 61e3;
    expect((await remote(json('/__feedback/api/pair/exchange', { code }))).status).toBe(200);
  });
  test('callers are told apart by the configured header, not by anything a client can write freely', async () => {
    const separate = createRemoteHandler(local, pairing, { now: () => clock, publicUrl: () => PUBLIC, clientIpHeader: 'cf-connecting-ip' });
    for (let i = 0; i < 5; i++) await separate(json('/__feedback/api/pair/exchange', { code: 'B'.repeat(22) }, { 'Cf-Connecting-Ip': '203.0.113.1' }));
    expect((await separate(json('/__feedback/api/pair/exchange', { code: 'B'.repeat(22) }, { 'Cf-Connecting-Ip': '203.0.113.1' }))).status).toBe(429);
    expect((await separate(json('/__feedback/api/pair/exchange', { code: 'B'.repeat(22) }, { 'Cf-Connecting-Ip': '203.0.113.2' }))).status).toBe(401);
  });
});

describe('the device cookie', () => {
  test('flags, name, and what is stored', async () => {
    const { response, cookie, token } = await pairOnce();
    expect(response.status).toBe(200);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/__feedback/');
    expect(cookie).toContain(`Max-Age=${DEVICE_TTL_MS / 1000}`);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(token).toMatch(/^[\w-]{43}$/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.device.name).toBe('iPhone · Safari');
    const file = join(dir, '_devices.json');
    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain(token);
    expect(raw).not.toContain('Mozilla');
    expect(raw).not.toContain('AppleWebKit');
    expect(JSON.parse(raw).devices[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
  test('the cookie opens the inbox, and the pairing page is not served to a paired device', async () => {
    const { token } = await pairOnce();
    expect((await remote(withCookie(token, '/__feedback/api/threads'))).status).toBe(200);
    const inbox = await (await remote(withCookie(token, '/__feedback/inbox/'))).text();
    expect(inbox).toContain('id="groups"');
    const me = await (await remote(withCookie(token, '/__feedback/api/pair/me'))).json();
    expect(me.device.name).toBe('iPhone · Safari');
  });
  test('a revoked device is refused at once, by the API, the CLI and revoke-all', async () => {
    const a = await pairOnce(), b = await pairOnce(), c = await pairOnce();
    for (const t of [a, b, c]) expect((await remote(withCookie(t.token, '/__feedback/api/threads'))).status).toBe(200);
    const list = await (await local(new Request('http://127.0.0.1:8099/__feedback/api/devices'))).json();
    expect(list.devices.length).toBe(3);
    expect(JSON.stringify(list)).not.toContain(a.token);
    expect(JSON.stringify(list)).not.toContain('token_hash');
    const id = list.devices[0].id;
    const gone = await local(new Request(`http://127.0.0.1:8099/__feedback/api/devices/${id}`, { method: 'DELETE' }));
    expect(gone.status).toBe(200);
    expect((await remote(withCookie(a.token, '/__feedback/api/threads'))).status).toBe(401);
    expect((await remote(withCookie(b.token, '/__feedback/api/threads'))).status).toBe(200);
    // the CLI is another process: it writes the file, and the server sees it on the next request
    const cli = new Pairing(dir);
    const second = (await cli.list())[0]!.id;
    expect(await run(['devices', 'revoke', second], dir)).toBe(`Revoked ${second}`);
    expect((await remote(withCookie(b.token, '/__feedback/api/threads'))).status).toBe(401);
    expect((await remote(withCookie(c.token, '/__feedback/api/threads'))).status).toBe(200);
    expect(await run(['devices', 'revoke-all'], dir)).toBe('Revoked 1 device');
    expect((await remote(withCookie(c.token, '/__feedback/api/threads'))).status).toBe(401);
    expect(await run(['devices', 'list'], dir)).toBe('No paired devices.');
    expect(await run(['devices', 'revoke', 'd00000000'], dir)).toBe('No paired device d00000000');
    await expect(run(['devices', 'revoke'], dir)).rejects.toThrow('Usage');
  });
  test('revoke-all from the API, and a device that revokes itself has its cookie cleared', async () => {
    const a = await pairOnce(), b = await pairOnce();
    const self = await remote(withCookie(a.token, '/__feedback/api/devices', {}));
    const me = (await self.json()).devices.find((d: { current?: boolean }) => d.current);
    expect(me).toBeTruthy();
    const out = await remote(withCookie(a.token, `/__feedback/api/devices/${me.id}`, { method: 'DELETE', headers: { Origin: PUBLIC } }));
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await remote(withCookie(a.token, '/__feedback/api/threads'))).status).toBe(401);
    const all = await remote(withCookie(b.token, '/__feedback/api/devices/revoke-all', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: PUBLIC }, body: '{}' }));
    expect(await all.json()).toEqual({ revoked: 1 });
    expect((await remote(withCookie(b.token, '/__feedback/api/threads'))).status).toBe(401);
  });
  test('an expired cookie is refused', async () => {
    const { token } = await pairOnce();
    clock += DEVICE_TTL_MS - 1000;
    // inside the window the request is fine; it also moves the window on
    expect((await remote(withCookie(token, '/__feedback/api/threads'))).status).toBe(200);
    const stale = await pairOnce();
    clock += DEVICE_TTL_MS + 1000;
    expect((await remote(withCookie(stale.token, '/__feedback/api/threads'))).status).toBe(401);
  });
  test('the 30 days slide: use renews the cookie, idleness does not', async () => {
    const { token } = await pairOnce();
    clock += 20 * 864e5;
    const used = await remote(withCookie(token, '/__feedback/api/threads'));
    expect(used.status).toBe(200);
    expect(used.headers.get('set-cookie')).toContain(`Max-Age=${DEVICE_TTL_MS / 1000}`);
    clock += 20 * 864e5; // 40 days after pairing, 20 after the last use
    expect((await remote(withCookie(token, '/__feedback/api/threads'))).status).toBe(200);
    const seen = (await pairing.list())[0]!;
    expect(Date.parse(seen.last_seen_at)).toBe(clock);
    clock += 31 * 864e5;
    expect((await remote(withCookie(token, '/__feedback/api/threads'))).status).toBe(401);
  });
  test('last seen is written at most every few minutes', async () => {
    const { token } = await pairOnce();
    const before = (await pairing.list())[0]!.last_seen_at;
    clock += 60e3;
    const quiet = await remote(withCookie(token, '/__feedback/api/threads'));
    expect(quiet.headers.get('set-cookie')).toBeNull();
    expect((await pairing.list())[0]!.last_seen_at).toBe(before);
  });
  test('a revoke is not undone by a renewal that was waiting', async () => {
    const { token } = await pairOnce();
    clock += 10 * 60e3;
    const id = (await pairing.list())[0]!.id;
    const [renew] = await Promise.all([remote(withCookie(token, '/__feedback/api/threads')), new Pairing(dir).revoke(id)]);
    expect([200, 401]).toContain(renew.status);
    expect((await pairing.list()).length).toBe(0);
  });
});

describe('CSRF on the remote listener', () => {
  test('a write needs the public origin, a JSON body, and the cookie', async () => {
    const { token } = await pairOnce();
    const body = JSON.stringify({ title: 'From the phone', text: 'Hello' });
    const send = (headers: Record<string, string>) => remote(withCookie(token, '/__feedback/api/threads', { method: 'POST', headers, body }));
    expect((await send({ 'Content-Type': 'application/json', Origin: PUBLIC })).status).toBe(201);
    expect((await send({ 'Content-Type': 'application/json', Origin: 'https://evil.example' })).status).toBe(403);
    expect((await send({ 'Content-Type': 'application/json', Origin: 'null' })).status).toBe(403);
    expect((await send({ 'Content-Type': 'application/json' })).status).toBe(403);
    expect((await send({ 'Content-Type': 'application/json', Origin: `${PUBLIC}.evil.example` })).status).toBe(403);
    expect((await send({ 'Content-Type': 'application/json', Origin: 'http://phone.example.test' })).status).toBe(403);
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) expect((await send({ ...(type ? { 'Content-Type': type } : {}), Origin: PUBLIC })).status).toBe(415);
    expect((await remote(json('/__feedback/api/threads', { title: 'x', text: 'y' }, { Origin: 'https://evil.example' }))).status).toBe(401);
  });
  test('a cross-origin pairing exchange is refused', async () => {
    const { code } = pairing.createCode(clock);
    const response = await remote(json('/__feedback/api/pair/exchange', { code }, { Origin: 'https://evil.example' }));
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect((await remote(new Request(url('/__feedback/api/pair/exchange'), { method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: PUBLIC }, body: JSON.stringify({ code }) }))).status).toBe(415);
    expect(pairing.redeem(code, clock)).toBe(true); // the refused attempts did not spend it
  });
  test('with no public address set, the origin host must be the host the request was sent to', async () => {
    const open = createRemoteHandler(local, pairing, { now: () => clock });
    const { code } = pairing.createCode(clock);
    const wrong = await open(new Request('https://anything.example.test/__feedback/api/pair/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Host: 'anything.example.test' }, body: JSON.stringify({ code }) }));
    expect(wrong.status).toBe(403);
    const right = await open(new Request('https://anything.example.test/__feedback/api/pair/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://anything.example.test', Host: 'anything.example.test' }, body: JSON.stringify({ code }) }));
    expect(right.status).toBe(200);
  });
  test('the local listener refuses a cross-site write to the pairing routes too', async () => {
    const response = await local(new Request('http://127.0.0.1:8099/__feedback/api/pair/codes', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Host: '127.0.0.1:8099' }, body: '{}' }));
    expect(response.status).toBe(403);
    const form = await local(new Request('http://127.0.0.1:8099/__feedback/api/devices/revoke-all', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }));
    expect(form.status).toBe(415);
  });
  test('headers meant for the inside are not believed from outside', async () => {
    const { token } = await pairOnce();
    const other = await pairOnce();
    const id = (await pairing.list()).find(d => d.name)!.id;
    const listed = await (await remote(withCookie(token, '/__feedback/api/devices', { headers: { 'X-Rf-Device': id } }))).json();
    expect(listed.devices.filter((d: { current?: boolean }) => d.current).length).toBe(1);
    expect(other.token).not.toBe(token);
  });
});

describe('the local listener is as it was', () => {
  test('no cookie, no origin rules, no pairing page', async () => {
    expect((await local(new Request('http://127.0.0.1:8099/__feedback/api/threads'))).status).toBe(200);
    expect((await local(new Request('http://127.0.0.1:8099/__feedback/inbox/'))).status).toBe(200);
    expect((await local(new Request('http://127.0.0.1:8099/__feedback/api/pair/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }))).status).toBe(404);
    const created = await local(new Request('http://127.0.0.1:8099/__feedback/api/threads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'A', text: 'B' }) }));
    expect(created.status).toBe(201);
  });
  test('a handler built without pairing has no pairing routes', async () => {
    const plain = createHandler(dir);
    expect((await plain(new Request('http://x/__feedback/api/pair/status'))).status).toBe(404);
    expect((await plain(new Request('http://x/__feedback/api/devices'))).status).toBe(404);
  });
});

describe('names, settings and the tunnel', () => {
  test('a device name is a family, not a user agent', () => {
    expect(deviceName(UA_IPHONE)).toBe('iPhone · Safari');
    expect(deviceName('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36')).toBe('Android · Chrome');
    expect(deviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15')).toBe('Mac · Safari');
    expect(deviceName('Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/120.0')).toBe('Windows · Firefox');
    expect(deviceName('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120')).toBe('Windows · Edge');
    expect(deviceName(null)).toBe('Device · browser');
    expect(deviceName('x'.repeat(5000)).length).toBeLessThan(40);
  });
  test('FEEDBACK_PUBLIC_URL is an https origin (or this machine)', () => {
    expect(loadPublicUrl({})).toBeNull();
    expect(loadPublicUrl({ FEEDBACK_PUBLIC_URL: 'https://phone.example.test/some/path?x=1' })).toBe(PUBLIC);
    expect(loadPublicUrl({ FEEDBACK_PUBLIC_URL: 'http://127.0.0.1:8100' })).toBe('http://127.0.0.1:8100');
    expect(() => loadPublicUrl({ FEEDBACK_PUBLIC_URL: 'http://phone.example.test' })).toThrow('https');
    expect(() => loadPublicUrl({ FEEDBACK_PUBLIC_URL: 'phone.example.test' })).toThrow('full URL');
  });
  test('the remote port defaults to PORT+1 and must differ', () => {
    expect(loadRemotePort({ PORT: '9000' })).toBe(9001);
    expect(loadRemotePort({}, 8099)).toBe(8100);
    expect(loadRemotePort({ FEEDBACK_REMOTE_PORT: '9500' }, 8099)).toBe(9500);
    expect(() => loadRemotePort({ FEEDBACK_REMOTE_PORT: '8099' }, 8099)).toThrow('differ');
    expect(() => loadRemotePort({ FEEDBACK_REMOTE_PORT: 'abc' }, 8099)).toThrow('port number');
    expect(() => loadRemotePort({ FEEDBACK_REMOTE_PORT: '70000' }, 8099)).toThrow('port number');
  });
  test('the tunnel address is found in cloudflared output', () => {
    const output = ['2026-11-20T10:00:00Z INF Thank you for trying Tunnel. See https://www.example.test/terms for details', '2026-11-20T10:00:01Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):', '2026-11-20T10:00:01Z INF |  https://alpha-beta-gamma-delta.tunnel.example.test', '2026-11-20T10:00:02Z INF Registered tunnel connection'].join('\n');
    expect(findTunnelUrl(output)).toBe('https://alpha-beta-gamma-delta.tunnel.example.test');
    expect(findTunnelUrl('INF see https://developers.example.test/docs')).toBeNull();
    expect(findTunnelUrl('')).toBeNull();
    expect(findTunnelUrl('https://one-two-three.tunnel.example.test')).toBe('https://one-two-three.tunnel.example.test');
  });
  test('no cloudflared on the path: no tunnel', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'feedback-nopath-'));
    expect(await startTunnel(1234, { PATH: empty })).toBeNull();
    await rm(empty, { recursive: true });
  });
  test('a fake cloudflared is started, its address is read, and it is stopped', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'feedback-fakebin-'));
    const args = join(bin, 'args.txt');
    const script = `#!/bin/sh\necho "$@" > "${args}"\necho "INF |  Your quick Tunnel has been created! Visit it at:" >&2\necho "INF |  https://one-two-three-four.tunnel.example.test" >&2\nexec sleep 30\n`;
    await writeFile(join(bin, 'cloudflared'), script);
    await chmod(join(bin, 'cloudflared'), 0o755);
    const tunnel = await startTunnel(4567, { PATH: `${bin}:/bin:/usr/bin` }, 10000);
    expect(tunnel?.url).toBe('https://one-two-three-four.tunnel.example.test');
    expect(await readFile(args, 'utf8')).toContain('--url http://127.0.0.1:4567');
    tunnel?.stop();
    await rm(bin, { recursive: true, force: true });
  });
});

describe('a real remote listener', () => {
  test('binds 127.0.0.1 only, and a loopback caller still needs a device', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'feedback-nopath-'));
    await mkdir(join(dir, 'data'));
    const port = 20000 + Math.floor(Math.random() * 20000);
    const lines: string[] = [];
    const localServer = createHandler(dir, undefined, { extra: pairRoutes(new Pairing(dir)) });
    const started = await startRemote({ fetch: localServer, maxRequestBodySize: 1 << 20, port: 1 }, dir, { FEEDBACK_REMOTE_PORT: String(port), PATH: bare, FEEDBACK_PUBLIC_URL: PUBLIC }, line => lines.push(line));
    try {
      expect(started.server.hostname).toBe('127.0.0.1');
      expect(lines.join('\n')).toContain('Public address: https://phone.example.test');
      const refused = await fetch(`http://127.0.0.1:${started.port}/__feedback/api/threads`);
      expect(refused.status).toBe(401);
      const page = await fetch(`http://127.0.0.1:${started.port}/__feedback/inbox/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('This inbox is private');
    } finally { started.stop(); await rm(bare, { recursive: true, force: true }); }
  });
  test('with nothing set, it says what to do', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'feedback-nopath-'));
    const lines: string[] = [];
    const started = await startRemote({ fetch: createHandler(dir), maxRequestBodySize: 1 << 20, port: 1 }, dir, { FEEDBACK_REMOTE_PORT: String(20000 + Math.floor(Math.random() * 20000)), PATH: bare }, line => lines.push(line));
    try { expect(lines.join('\n')).toMatch(/install cloudflared.*FEEDBACK_PUBLIC_URL/); } finally { started.stop(); await rm(bare, { recursive: true, force: true }); }
  });
});
