// One-time secret links: the server stores ciphertext only, one view cannot be taken twice, and a miss is one message.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler, serverOptions, startUploadSweep } from './server';
import { hostAllowed } from './hosts';
import { padSecret, unpadSecret } from './inbox/secret.js';
import { Pairing } from './pair';
import { createRemoteHandler, isSecretRoute } from './remote';
import { GONE } from './secrets';

const PLAIN = 'plaintext-SECRETLINK-9f3c1a';
const PUBLIC = 'https://phone.example.test';
let dir: string;
let now: number;
let handle: ReturnType<typeof createHandler>;
let ip = 1;
const logs: unknown[][] = [];
const orig = { error: console.error, log: console.log, warn: console.warn, info: console.info };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'feedback-secrets-'));
  now = Date.parse('2026-11-20T12:00:00Z');
  ip = 1;
  handle = createHandler(dir, undefined, { now: () => now });
  logs.length = 0;
  console.error = (...a: unknown[]) => { logs.push(a); };
  console.log = (...a: unknown[]) => { logs.push(a); };
  console.warn = (...a: unknown[]) => { logs.push(a); };
  console.info = (...a: unknown[]) => { logs.push(a); };
});
afterEach(async () => {
  console.error = orig.error; console.log = orig.log; console.warn = orig.warn; console.info = orig.info;
  await chmod(dir, 0o700).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

const srv = (address = `203.0.113.${ip++}`) => ({ requestIP: () => ({ address }) });
const post = (body: unknown, query = '') => new Request(`http://local/__feedback/api/secret-links${query}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const openReq = (id: string) => new Request(`http://local/__feedback/x/${id}/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
async function seal(text: string) {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)));
  return { ciphertext: Buffer.from(cipher).toString('base64'), iv: Buffer.from(iv).toString('base64'), fragment: Buffer.from(keyBytes).toString('base64url'), key };
}
async function treeHas(root: string, needle: string): Promise<boolean> {
  const want = Buffer.from(needle);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) { if (await treeHas(path, needle)) return true; }
    else if ((await readFile(path)).includes(want)) return true;
  }
  return false;
}
async function decrypt(packed: { ciphertext: string; iv: string }, fragment: string) {
  const keyBytes = Buffer.from(fragment, 'base64url');
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(packed.iv, 'base64') }, key, Buffer.from(packed.ciphertext, 'base64'));
  return new TextDecoder().decode(plain);
}
function logged(): string { return JSON.stringify(logs); }

test('a create stores only ciphertext, at mode 0600, and the plaintext is nowhere on disk', async () => {
  const sealed = await seal(PLAIN);
  const response = await handle(post({ ciphertext: sealed.ciphertext, iv: sealed.iv, expires: '1h', views: 1 }), srv());
  expect(response.status).toBe(201);
  const created = await response.json() as { id: string; url: string; views_left: number; expires_at: string };
  expect(created.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(created.url).toBe(`/__feedback/x/${created.id}`);
  expect(created.views_left).toBe(1);
  expect(JSON.stringify(created)).not.toContain(PLAIN);
  expect(JSON.stringify(created)).not.toContain(sealed.fragment);
  const file = join(dir, '_secrets', `${created.id}.json`);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect((await stat(join(dir, '_secrets'))).mode & 0o777).toBe(0o700);
  const stored = JSON.parse(await readFile(file, 'utf8')) as { ciphertext: string; iv: string; views_left: number };
  expect(stored.ciphertext).toBe(sealed.ciphertext);
  expect(stored.iv).toBe(sealed.iv);
  expect(Object.keys(stored).sort()).toEqual(['ciphertext', 'created_at', 'expires_at', 'id', 'iv', 'views_left']);
  expect(await treeHas(dir, PLAIN)).toBe(false);
  expect(await treeHas(dir, sealed.fragment)).toBe(false);
  const opened = await (await handle(openReq(created.id), srv())).json() as { ciphertext: string; iv: string };
  expect(await decrypt(opened, sealed.fragment)).toBe(PLAIN);
  expect(logged()).not.toContain(PLAIN);
  expect(logged()).not.toContain(created.id);
  expect(logged()).not.toContain(sealed.ciphertext);
  expect(logged()).not.toContain(sealed.iv);
});

test('defaults are one view and one hour, and a plaintext field is refused and not stored', async () => {
  const sealed = await seal(PLAIN);
  const created = await (await handle(post({ ciphertext: sealed.ciphertext, iv: sealed.iv }))).json() as { views_left: number; expires_at: string };
  expect(created.views_left).toBe(1);
  expect(Date.parse(created.expires_at) - now).toBe(3_600_000);
  const bad = await handle(post({ ciphertext: sealed.ciphertext, iv: sealed.iv, secret: PLAIN }));
  expect(bad.status).toBe(400);
  expect(await treeHas(dir, PLAIN)).toBe(false);
  expect((await handle(post({ ciphertext: sealed.ciphertext, iv: sealed.iv, views: 4 }))).status).toBe(400);
  expect((await handle(post({ ciphertext: sealed.ciphertext, iv: sealed.iv, expires: '7d' }))).status).toBe(400);
});

test('expired, used up, revoked and unknown are the same message, and the file is gone', async () => {
  const unknown = await handle(openReq('A'.repeat(43)), srv());
  const unknownBody = await unknown.text();
  expect(unknown.status).toBe(404);
  expect(unknownBody).toContain(GONE);
  expect(unknown.headers.get('cache-control')).toBe('no-store');

  const lived = await seal('used-up-secret');
  const used = await (await handle(post({ ciphertext: lived.ciphertext, iv: lived.iv, views: 1 }), srv())).json() as { id: string };
  expect((await handle(openReq(used.id), srv())).status).toBe(200);
  const usedAgain = await handle(openReq(used.id), srv());
  expect(usedAgain.status).toBe(404);
  expect(await usedAgain.text()).toBe(unknownBody);
  await expect(stat(join(dir, '_secrets', `${used.id}.json`))).rejects.toThrow();

  const soon = await seal('expires-soon');
  const expiring = await (await handle(post({ ciphertext: soon.ciphertext, iv: soon.iv, expires: '10m' }), srv())).json() as { id: string };
  now += 11 * 60 * 1000;
  const expired = await handle(openReq(expiring.id), srv());
  expect(expired.status).toBe(404);
  expect(await expired.text()).toBe(unknownBody);

  now = Date.parse('2026-11-20T12:00:00Z');
  const kept = await seal('revoke-me');
  const row = await (await handle(post({ ciphertext: kept.ciphertext, iv: kept.iv }), srv())).json() as { id: string };
  expect((await handle(new Request(`http://local/__feedback/api/secret-links/${row.id}/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }))).status).toBe(200);
  const revoked = await handle(openReq(row.id), srv());
  expect(revoked.status).toBe(404);
  expect(await revoked.text()).toBe(unknownBody);
  expect(unknownBody).not.toMatch(/unknown|revok|used up/i);
});

test('two opens cannot both take the last view', async () => {
  const sealed = await seal('only-once');
  const created = await (await handle(post({ ciphertext: sealed.ciphertext, iv: sealed.iv, views: 1 }), srv())).json() as { id: string };
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => handle(openReq(created.id), srv(`198.51.100.${i + 1}`))));
  const bodies = await Promise.all(results.map(r => r.json() as Promise<{ ciphertext?: string; detail?: string }>));
  expect(bodies.filter(body => body.ciphertext === sealed.ciphertext)).toHaveLength(1);
  expect(results.filter(r => r.status === 200)).toHaveLength(1);
  await expect(stat(join(dir, '_secrets', `${created.id}.json`))).rejects.toThrow();
});

test('three views work, then the same miss, and the list shows views left without the secret', async () => {
  const sealed = await seal(PLAIN);
  const created = await (await handle(post({ ciphertext: sealed.ciphertext, iv: sealed.iv, views: 3, expires: '1d' }), srv())).json() as { id: string };
  const list = await (await handle(new Request('http://local/__feedback/api/secret-links'))).json() as { links: { id: string; views_left: number; ciphertext?: string; iv?: string }[] };
  expect(list.links.map(link => link.id)).toEqual([created.id]);
  expect(list.links[0]!.views_left).toBe(3);
  expect(JSON.stringify(list)).not.toContain(sealed.ciphertext);
  expect(JSON.stringify(list)).not.toContain(PLAIN);
  expect((await handle(openReq(created.id), srv())).status).toBe(200);
  const after = await (await handle(new Request('http://local/__feedback/api/secret-links'))).json() as { links: { views_left: number }[] };
  expect(after.links[0]!.views_left).toBe(2);
  expect((await handle(openReq(created.id), srv())).status).toBe(200);
  expect((await handle(openReq(created.id), srv())).status).toBe(200);
  expect((await handle(openReq(created.id), srv())).status).toBe(404);
});

test('opens are rate limited per caller and per id, and the address is not stored', async () => {
  const header = process.env.FEEDBACK_CLIENT_IP_HEADER;
  process.env.FEEDBACK_CLIENT_IP_HEADER = 'cf-connecting-ip';
  try {
    const sealed = await seal(PLAIN);
    const created = await (await handle(post({ ciphertext: sealed.ciphertext, iv: sealed.iv, views: 3 }))).json() as { id: string };
    const call = (address: string, id = created.id) => handle(new Request(`http://local/__feedback/x/${id}/open`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': address }, body: '{}',
    }));
    for (let i = 0; i < 5; i++) expect((await call('203.0.113.9', 'B'.repeat(43))).status).toBe(404);
    expect((await call('203.0.113.9', 'C'.repeat(43))).status).toBe(429);
    expect((await call('203.0.113.10', 'C'.repeat(43))).status).toBe(404);
    for (let i = 0; i < 5; i++) await call(`203.0.113.${20 + i}`);
    expect((await call('203.0.113.40')).status).toBe(429);
    expect(await treeHas(dir, '203.0.113.9')).toBe(false);
    expect(await treeHas(dir, PLAIN)).toBe(false);
  } finally {
    if (header === undefined) delete process.env.FEEDBACK_CLIENT_IP_HEADER; else process.env.FEEDBACK_CLIENT_IP_HEADER = header;
  }
});

test('the recipient page is static, and a storage error does not log the id', async () => {
  const sealed = await seal(PLAIN);
  const created = await (await handle(post({ ciphertext: sealed.ciphertext, iv: sealed.iv, views: 2 }), srv())).json() as { id: string };
  const page = await handle(new Request(`http://local/__feedback/x/${created.id}`));
  expect(page.status).toBe(200);
  const html = await page.text();
  const csp = page.headers.get('content-security-policy') ?? '';
  expect(page.headers.get('cache-control')).toBe('no-store');
  expect(page.headers.get('referrer-policy')).toBe('no-referrer');
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9_-]+'/);
  expect(html).toContain('Reveal');
  expect(html).toContain('history.replaceState');
  expect(html).not.toContain('app.js');
  expect(html).not.toContain(sealed.ciphertext);
  expect(html).not.toContain(PLAIN);
  const unknown = await handle(new Request(`http://local/__feedback/x/${'D'.repeat(43)}`));
  expect(unknown.status).toBe(200);
  const strip = (page: string) => page.replace(/nonce="[^"]*"/g, 'nonce=""');
  expect(strip(await unknown.text())).toBe(strip(html));
  const file = join(dir, '_secrets', `${created.id}.json`);
  await chmod(file, 0o000);
  logs.length = 0;
  const broken = await handle(openReq(created.id), srv());
  const flat = logged();
  expect(flat).not.toContain(created.id);
  expect(flat).not.toContain(sealed.ciphertext);
  expect(flat).not.toContain(sealed.iv);
  expect(flat).not.toContain(PLAIN);
  if (broken.status === 500) expect(flat).toContain(created.id.slice(0, 6));
  await chmod(file, 0o600);
});

test('the host guard and the remote listener allow only the exact secret paths', async () => {
  const id = 'E'.repeat(43);
  expect(hostAllowed(new Request(`http://attacker.example/__feedback/x/${id}`, { headers: { host: 'attacker.example' } }), {})).toBe(true);
  expect(hostAllowed(new Request('http://attacker.example/__feedback/api/secret-links', { headers: { host: 'attacker.example' } }), {})).toBe(false);
  expect(isSecretRoute(`/__feedback/x/${id}`, 'GET')).toBe(true);
  expect(isSecretRoute(`/__feedback/x/${id}/open`, 'POST')).toBe(true);
  expect(isSecretRoute(`/__feedback/x/${id}`, 'POST')).toBe(false);
  expect(isSecretRoute(`/__feedback/x/${id}/open`, 'GET')).toBe(false);
  expect(isSecretRoute(`/__feedback/x/${'E'.repeat(42)}`, 'GET')).toBe(false);
  expect(isSecretRoute(`/__feedback/x/${id}/open/extra`, 'POST')).toBe(false);
  const opts = serverOptions({ FEEDBACK_DIR: dir });
  expect((await opts.fetch(new Request('http://attacker.example/__feedback/api/secret-links', { headers: { host: 'attacker.example' } }))).status).toBe(403);
  expect((await opts.fetch(new Request(`http://attacker.example/__feedback/x/${id}`, { headers: { host: 'attacker.example' } }))).status).toBe(200);
  // A dot segment is resolved before routing, so a secret-looking prefix cannot reach the API under an unexpected Host.
  const sneak = await opts.fetch(new Request('http://attacker.example/__feedback/x/%2e%2e/api/threads', { headers: { host: 'attacker.example' } }));
  expect(sneak.status).toBe(403);
  expect(await sneak.text()).not.toContain('"id"');
  const pairing = new Pairing(dir);
  const remote = createRemoteHandler(handle, pairing, { publicUrl: () => PUBLIC, now: () => now });
  expect((await remote(new Request(`${PUBLIC}/__feedback/x/${id}`))).status).toBe(200);
  expect((await remote(new Request(`${PUBLIC}/__feedback/x/${id}/open`, { method: 'POST', body: '{}' }))).status).toBe(404);
  expect((await remote(new Request(`${PUBLIC}/__feedback/api/secret-links`))).status).toBe(401);
  expect((await remote(new Request(`${PUBLIC}/__feedback/x/${id}/../../api/threads`))).status).toBe(401);
  expect((await remote(new Request(`${PUBLIC}/__feedback/x/%2e%2e/api/threads`))).status).toBe(401);
  expect((await remote(new Request(`${PUBLIC}/__feedback/x/${id}`, { method: 'POST', headers: { Origin: PUBLIC }, body: '{}' }))).status).toBe(401);
});

test('a secret created in another project still opens', async () => {
  const alpha = join(dir, 'alpha'); const beta = join(dir, 'beta');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(alpha); await mkdir(beta);
  const multi = createHandler(alpha, undefined, { now: () => now, projects: [{ id: 'alpha', name: 'Alpha', dir: alpha }, { id: 'beta', name: 'Beta', dir: beta }] });
  const sealed = await seal('project-secret');
  const created = await (await multi(post({ ciphertext: sealed.ciphertext, iv: sealed.iv }, '?project=beta'))).json() as { id: string };
  expect(await treeHas(beta, sealed.ciphertext)).toBe(true);
  expect(await treeHas(alpha, sealed.ciphertext)).toBe(false);
  const opened = await (await multi(openReq(created.id))).json() as { ciphertext: string };
  expect(opened.ciphertext).toBe(sealed.ciphertext);
});

test('padding hides the length inside a 64-byte bucket and an old unpadded secret still decodes', () => {
  const short = padSecret('a');
  const medium = padSecret('a'.repeat(20));
  expect(short.length).toBe(64);
  expect(medium.length).toBe(64);
  expect(new TextDecoder().decode(unpadSecret(short))).toBe('a');
  expect(padSecret('a'.repeat(61)).length).toBe(128);
  const legacy = new TextEncoder().encode('horse battery staple');
  expect(new TextDecoder().decode(unpadSecret(legacy))).toBe('horse battery staple');
  const block = new Uint8Array(64);
  block.fill(0x61);
  expect(new TextDecoder().decode(unpadSecret(block))).toBe('a'.repeat(64));
  const almost = padSecret('keep');
  almost[10] = 1;
  expect(unpadSecret(almost)).toBe(almost);
});

test('an expired secret file is removed by a list and by a create', async () => {
  const sealed = await seal('expires-on-disk');
  const listed = await (await handle(post({ ciphertext: sealed.ciphertext, iv: sealed.iv, expires: '10m' }))).json() as { id: string };
  now += 11 * 60 * 1000;
  const list = await handle(new Request('http://local/__feedback/api/secret-links'));
  expect(list.status).toBe(200);
  expect((await list.json() as { links: unknown[] }).links).toEqual([]);
  await expect(stat(join(dir, '_secrets', `${listed.id}.json`))).rejects.toThrow();

  now = Date.parse('2026-11-20T12:00:00Z');
  const stale = await (await handle(post({ ciphertext: sealed.ciphertext, iv: sealed.iv, expires: '10m' }))).json() as { id: string };
  now += 11 * 60 * 1000;
  const fresh = await (await handle(post({ ciphertext: sealed.ciphertext, iv: sealed.iv, expires: '1h' }))).json() as { id: string };
  await expect(stat(join(dir, '_secrets', `${stale.id}.json`))).rejects.toThrow();
  expect((await stat(join(dir, '_secrets', `${fresh.id}.json`))).isFile()).toBe(true);
  const after = await (await handle(new Request('http://local/__feedback/api/secret-links'))).json() as { links: { id: string }[] };
  expect(after.links.map(link => link.id)).toEqual([fresh.id]);
});

test('the hourly sweep deletes an expired secret and leaves a live one', async () => {
  const sealed = await seal('sweep-me');
  const dead = await (await handle(post({ ciphertext: sealed.ciphertext, iv: sealed.iv, expires: '1d' }))).json() as { id: string };
  const live = await (await handle(post({ ciphertext: sealed.ciphertext, iv: sealed.iv, expires: '1d' }))).json() as { id: string };
  const deadFile = join(dir, '_secrets', `${dead.id}.json`);
  const liveFile = join(dir, '_secrets', `${live.id}.json`);
  const stamp = async (file: string, expires_at: string) => {
    const rec = JSON.parse(await readFile(file, 'utf8')) as { expires_at: string };
    rec.expires_at = expires_at;
    await writeFile(file, `${JSON.stringify(rec)}\n`);
  };
  await stamp(deadFile, '2000-01-01T00:00:00.000Z');
  await stamp(liveFile, '2099-01-01T00:00:00.000Z');
  const stop = startUploadSweep([dir]);
  try {
    let gone = false;
    for (let i = 0; i < 50 && !gone; i++) {
      try { await stat(deadFile); } catch { gone = true; }
      if (!gone) await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(gone).toBe(true);
    expect((await stat(liveFile)).isFile()).toBe(true);
  } finally { stop(); }
});

test('a list skips an unreadable or corrupt secret and logs only a prefix', async () => {
  const sealed = await seal(PLAIN);
  const good = await (await handle(post({ ciphertext: sealed.ciphertext, iv: sealed.iv, views: 2 }))).json() as { id: string };
  const hidden = await (await handle(post({ ciphertext: sealed.ciphertext, iv: sealed.iv, views: 2 }))).json() as { id: string };
  const corruptId = 'C'.repeat(43);
  await writeFile(join(dir, '_secrets', `${corruptId}.json`), '{not-json');
  await chmod(join(dir, '_secrets', `${hidden.id}.json`), 0o000);
  logs.length = 0;
  try {
    const response = await handle(new Request('http://local/__feedback/api/secret-links'));
    expect(response.status).toBe(200);
    const body = await response.json() as { links: { id: string }[] };
    const ids = body.links.map(link => link.id);
    expect(ids).toContain(good.id);
    expect(ids).not.toContain(corruptId);
    const flat = logged();
    expect(flat).not.toContain(corruptId);
    expect(flat).toContain(corruptId.slice(0, 6));
    expect(flat).not.toContain(hidden.id);
    expect(flat).not.toContain(sealed.ciphertext);
    if (!ids.includes(hidden.id)) expect(flat).toContain(hidden.id.slice(0, 6));
    expect((await stat(join(dir, '_secrets', `${corruptId}.json`))).isFile()).toBe(true);
  } finally {
    await chmod(join(dir, '_secrets', `${hidden.id}.json`), 0o600);
  }
});

test('a self-started tunnel rate-limits secret opens by cf-connecting-ip', async () => {
  const header = process.env.FEEDBACK_CLIENT_IP_HEADER;
  delete process.env.FEEDBACK_CLIENT_IP_HEADER;
  try {
    const sealed = await seal(PLAIN);
    const created = await (await handle(post({ ciphertext: sealed.ciphertext, iv: sealed.iv, views: 3 }))).json() as { id: string };
    const remote = createRemoteHandler(handle, new Pairing(dir), { publicUrl: () => PUBLIC, now: () => now, clientIpHeader: 'cf-connecting-ip' });
    const server = { requestIP: () => ({ address: '127.0.0.1' }) };
    let seq = 0;
    const call = (ip: string, id = `B${String(seq++).padStart(2, '0')}${'C'.repeat(40)}`) => remote(new Request(`${PUBLIC}/__feedback/x/${id}/open`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip }, body: '{}',
    }), server);
    for (let i = 0; i < 5; i++) expect((await call('203.0.113.9')).status).toBe(404);
    expect((await call('203.0.113.9')).status).toBe(429);
    expect((await call('203.0.113.10')).status).toBe(404);
    expect((await call('203.0.113.11', created.id)).status).toBe(200);
  } finally {
    if (header === undefined) delete process.env.FEEDBACK_CLIENT_IP_HEADER; else process.env.FEEDBACK_CLIENT_IP_HEADER = header;
  }
});

test('an unexpected host is allowed only the exact secret page and open', async () => {
  const id = 'E'.repeat(43);
  const ask = (path: string, method = 'GET') => hostAllowed(new Request(`http://attacker.example${path}`, { method, headers: { host: 'attacker.example' } }), {});
  expect(ask(`/__feedback/x/${id}`, 'GET')).toBe(true);
  expect(ask(`/__feedback/x/${id}`, 'HEAD')).toBe(true);
  expect(ask(`/__feedback/x/${id}/open`, 'POST')).toBe(true);
  expect(ask(`/__feedback/x/${id}/open`, 'GET')).toBe(false);
  expect(ask(`/__feedback/x/${id}`, 'POST')).toBe(false);
  expect(ask(`/__feedback/x/${id}/`, 'GET')).toBe(false);
  expect(ask('/__feedback/x/', 'GET')).toBe(false);
  expect(ask(`/__feedback/x/${'E'.repeat(42)}`, 'GET')).toBe(false);
  expect(ask(`/__feedback/x/${id}E`, 'GET')).toBe(false);
  expect(isSecretRoute(`/__feedback/x/${id}`, 'HEAD')).toBe(true);
  expect(ask(`/__feedback/s/${'a'.repeat(20)}`, 'POST')).toBe(true);
  const opts = serverOptions({ FEEDBACK_DIR: dir });
  expect((await opts.fetch(new Request(`http://attacker.example/__feedback/x/${id}/open`, { headers: { host: 'attacker.example' } }))).status).toBe(403);
  expect((await opts.fetch(new Request(`http://attacker.example/__feedback/x/${id}`, { method: 'HEAD', headers: { host: 'attacker.example' } }))).status).toBe(200);
  expect((await opts.fetch(new Request(`http://attacker.example/__feedback/x/${id}/open`, { method: 'POST', headers: { host: 'attacker.example', 'Content-Type': 'application/json' }, body: '{}' }))).status).toBe(404);
});
