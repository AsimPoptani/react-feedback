// Pairing: how a phone becomes a trusted device for the remote listener.
// A one-time CODE (128 random bits, kept only as a sha256 in memory, valid 5 minutes, single use, at most 5 open) is turned into a DEVICE: a random token handed to the phone as a
// cookie, and kept on disk only as a sha256 (`_devices.json`, mode 0600). A device is listed, can be revoked at once, and expires 30 days after it was last renewed.
// Nothing here is reachable by an agent: there is no MCP tool for it.
import { randomBytes } from 'node:crypto';
import { stat, writeFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hashToken, sameHash } from './shares';
import { Invalid, optional, withLock } from './store';

export const CODE_TTL_MS = 5 * 60e3;
export const MAX_OPEN_CODES = 5;
export const DEVICE_TTL_MS = 30 * 864e5;
export const SEEN_EVERY_MS = 5 * 60e3; // last-seen (and the sliding renewal) is written at most this often per device
export const CODE_SHAPE = /^[A-Za-z0-9_-]{22}$/; // 16 random bytes, base64url
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
export const DEVICE_ID = /^d[0-9a-f]{8}$/;
export const COOKIE_NAME = 'rf_device';

export interface Device { id: string; token_hash: string; name: string; created_at: string; last_seen_at: string; expires_at: string }
export type PublicDevice = Omit<Device, 'token_hash'>;
export interface RemoteInfo { on: boolean; publicUrl: string | null; source: 'env' | 'tunnel' | null }

const fileOf = (dir: string) => join(dir, '_devices.json');
const publicOf = ({ token_hash: _hash, ...rest }: Device): PublicDevice => rest;

function parseDevice(value: unknown): Device | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const d = value as Record<string, unknown>;
  if (typeof d.id !== 'string' || !DEVICE_ID.test(d.id) || typeof d.token_hash !== 'string' || !/^[0-9a-f]{64}$/.test(d.token_hash)) return null;
  if (typeof d.name !== 'string' || typeof d.created_at !== 'string' || typeof d.last_seen_at !== 'string' || typeof d.expires_at !== 'string') return null;
  return { id: d.id, token_hash: d.token_hash, name: d.name.slice(0, 60), created_at: d.created_at, last_seen_at: d.last_seen_at, expires_at: d.expires_at };
}
async function readDevices(dir: string): Promise<Device[]> {
  const raw = await optional(fileOf(dir));
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as { devices?: unknown };
    return Array.isArray(parsed.devices) ? parsed.devices.flatMap(item => { const d = parseDevice(item); return d ? [d] : []; }) : [];
  } catch { return []; }
}
async function saveDevices(dir: string, devices: Device[]): Promise<void> {
  const file = fileOf(dir), tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try { await writeFile(tmp, `${JSON.stringify({ devices }, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); await rename(tmp, file); }
  catch (error) { await rm(tmp, { force: true }); throw error; }
}

// The device's name is the family of the browser and system, taken from the user agent. The user agent itself is never stored.
export function deviceName(userAgent: string | null | undefined): string {
  const ua = userAgent ?? '';
  const system = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const browser = /EdgA?\/|Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return `${system} · ${browser}`;
}

// Direct file operations, shared by the server and the CLI (the CLI is another process, so every change takes the folder lock and reads fresh).
export async function listDevices(dir: string): Promise<PublicDevice[]> { return (await readDevices(dir)).map(publicOf); }
export async function revokeDevice(dir: string, id: string): Promise<boolean> {
  if (!DEVICE_ID.test(id)) return false;
  return withLock(dir, async () => {
    const all = await readDevices(dir), kept = all.filter(d => d.id !== id);
    if (kept.length === all.length) return false;
    await saveDevices(dir, kept);
    return true;
  });
}
export async function revokeAllDevices(dir: string): Promise<number> {
  return withLock(dir, async () => { const all = await readDevices(dir); if (all.length) await saveDevices(dir, []); return all.length; });
}
export function devicesText(devices: PublicDevice[], now = Date.now()): string {
  if (!devices.length) return 'No paired devices.';
  return devices.map(d => `${d.id}  ${d.name}  paired ${d.created_at.slice(0, 16).replace('T', ' ')}  last seen ${d.last_seen_at.slice(0, 16).replace('T', ' ')}${Date.parse(d.expires_at) <= now ? '  (expired)' : ''}`).join('\n');
}
// react-feedback devices list | revoke <id> | revoke-all
export async function devicesCommand(dir: string, words: string[]): Promise<string> {
  const [action = 'list', id] = words;
  if (action === 'list' && words.length <= 1) return devicesText(await listDevices(dir));
  if (action === 'revoke' && id && words.length === 2) return (await revokeDevice(dir, id)) ? `Revoked ${id}` : `No paired device ${id}`;
  if (action === 'revoke-all' && words.length === 1) { const n = await revokeAllDevices(dir); return `Revoked ${n} device${n === 1 ? '' : 's'}`; }
  throw new Invalid('Usage: react-feedback devices list | revoke <id> | revoke-all');
}

interface OpenCode { id: string; hash: string; expires: number }
export class Pairing {
  // What the server knows about remote mode, for the inbox's "Open on phone" box. Set by startRemote.
  remote: RemoteInfo = { on: false, publicUrl: null, source: null };
  private codes: OpenCode[] = [];
  private cache: { sig: string; devices: Device[] } | null = null;
  constructor(readonly dir: string) {}

  // ---- Codes (memory only; a restart forgets them, which is what a 5-minute code should do)
  createCode(now = Date.now()): { id: string; code: string; expires_at: string } {
    this.codes = this.codes.filter(c => c.expires > now);
    const code = randomBytes(16).toString('base64url'), hash = hashToken(code);
    const open: OpenCode = { id: hash.slice(0, 8), hash, expires: now + CODE_TTL_MS };
    this.codes.push(open);
    while (this.codes.length > MAX_OPEN_CODES) this.codes.shift(); // the oldest is dropped: never more than five open
    return { id: open.id, code, expires_at: new Date(open.expires).toISOString() };
  }
  revokeCode(id: string): boolean { const before = this.codes.length; this.codes = this.codes.filter(c => c.id !== id); return this.codes.length !== before; }
  openCodes(now = Date.now()): number { this.codes = this.codes.filter(c => c.expires > now); return this.codes.length; }
  // True once, for a live code. The comparison runs against every open code in constant time per code and does not stop at a hit.
  redeem(code: unknown, now = Date.now()): boolean {
    this.codes = this.codes.filter(c => c.expires > now);
    const hash = hashToken(typeof code === 'string' && CODE_SHAPE.test(code) ? code : '');
    let hit = -1;
    this.codes.forEach((c, i) => { if (sameHash(c.hash, hash)) hit = i; });
    if (hit < 0 || typeof code !== 'string' || !CODE_SHAPE.test(code)) return false;
    this.codes.splice(hit, 1); // single use
    return true;
  }

  // ---- Devices (on disk). Re-read whenever the file changed, so a revoke made by the CLI is seen on the next request.
  private async devices(): Promise<Device[]> {
    let sig = 'none';
    try { const s = await stat(fileOf(this.dir)); sig = `${s.mtimeMs}:${s.size}:${s.ino}`; } catch { /* no file yet */ }
    if (this.cache?.sig === sig) return this.cache.devices;
    const devices = await readDevices(this.dir);
    this.cache = { sig, devices };
    return devices;
  }
  async list(): Promise<PublicDevice[]> { return (await this.devices()).map(publicOf); }
  async create(name: string, now = Date.now()): Promise<{ token: string; device: PublicDevice }> {
    const token = randomBytes(32).toString('base64url');
    const device: Device = { id: `d${randomBytes(4).toString('hex')}`, token_hash: hashToken(token), name: name.slice(0, 60), created_at: new Date(now).toISOString(), last_seen_at: new Date(now).toISOString(), expires_at: new Date(now + DEVICE_TTL_MS).toISOString() };
    await withLock(this.dir, async () => { await saveDevices(this.dir, [...(await readDevices(this.dir)).filter(d => Date.parse(d.expires_at) > now), device]); });
    this.cache = null;
    return { token, device: publicOf(device) };
  }
  // The device a token belongs to, if it is still paired and not expired. `renewed` is true when the sliding window was moved on (the caller then sends a fresh cookie).
  async authenticate(token: string | null | undefined, now = Date.now()): Promise<{ device: PublicDevice; renewed: boolean } | null> {
    if (!token || !TOKEN_SHAPE.test(token)) return null;
    const hash = hashToken(token);
    let found: Device | null = null;
    for (const d of await this.devices()) if (sameHash(d.token_hash, hash)) found = d;
    if (!found || Date.parse(found.expires_at) <= now) return null;
    if (now - Date.parse(found.last_seen_at) < SEEN_EVERY_MS) return { device: publicOf(found), renewed: false };
    const id = found.id;
    const updated = await withLock(this.dir, async () => {
      const all = await readDevices(this.dir), me = all.find(d => d.id === id);
      if (!me) return null; // revoked while we waited: no resurrection
      me.last_seen_at = new Date(now).toISOString(); me.expires_at = new Date(now + DEVICE_TTL_MS).toISOString();
      await saveDevices(this.dir, all);
      return { ...me };
    });
    this.cache = null;
    return updated ? { device: publicOf(updated), renewed: true } : null;
  }
  revoke(id: string): Promise<boolean> { this.cache = null; return revokeDevice(this.dir, id); }
  revokeAll(): Promise<number> { this.cache = null; return revokeAllDevices(this.dir); }
}

// One Pairing per data folder in this process, so the local and the remote listener share the same open codes.
const registry = new Map<string, Pairing>();
export function pairingFor(dir: string): Pairing {
  const key = resolve(dir);
  let pairing = registry.get(key);
  if (!pairing) { pairing = new Pairing(key); registry.set(key, pairing); }
  return pairing;
}
