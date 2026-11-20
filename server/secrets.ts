// One-time secret links. The browser encrypts; this file only ever holds ciphertext, the IV, an expiry and how many views remain.
// The key is not here. A miss (unknown, expired, used up, revoked) is just a miss: callers must not learn which.
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Invalid, optional, withLock } from './store';

export const SECRET_ID = /^[A-Za-z0-9_-]{43}$/;
export const GONE = 'This link has expired or was already used';
const EXPIRY_MS = { '10m': 600_000, '1h': 3_600_000, '1d': 86_400_000 } as const;
export type SecretExpiry = keyof typeof EXPIRY_MS;
const MIN_CIPHER = 17; // one byte of plaintext plus the 16-byte GCM tag
const MAX_CIPHER = 48 * 1024;
const IV_BYTES = 12;
const FIELDS = new Set(['ciphertext', 'iv', 'expires', 'views']);

export interface SecretRecord {
  id: string; ciphertext: string; iv: string; expires_at: string; views_left: number; created_at: string;
}
export interface SecretInfo { id: string; created_at: string; expires_at: string; views_left: number }

const folderOf = (dir: string) => join(dir, '_secrets');
const fileOf = (dir: string, id: string) => join(folderOf(dir), `${id}.json`);

// A short prefix is the only piece of an id that may be logged. Ciphertext and IVs are never logged.
export const secretPrefix = (id: string) => (SECRET_ID.test(id) ? id.slice(0, 6) : '------');

function decodeBase64(value: unknown, min: number, max: number): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Invalid('Expected base64');
  const buf = Buffer.from(value, 'base64');
  if (buf.length < min || buf.length > max) throw new Invalid('That is the wrong size');
  const canon = buf.toString('base64');
  if (canon.replace(/=+$/, '') !== value.replace(/=+$/, '')) throw new Invalid('Expected base64');
  return canon;
}

function parseRecord(raw: string): SecretRecord | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (typeof value.id !== 'string' || !SECRET_ID.test(value.id)) return null;
    if (typeof value.ciphertext !== 'string' || typeof value.iv !== 'string') return null;
    if (typeof value.expires_at !== 'string' || typeof value.created_at !== 'string') return null;
    if (typeof value.views_left !== 'number' || !Number.isInteger(value.views_left)) return null;
    return { id: value.id, ciphertext: value.ciphertext, iv: value.iv, expires_at: value.expires_at, views_left: value.views_left, created_at: value.created_at };
  } catch { return null; }
}

async function ensureFolder(dir: string): Promise<string> {
  const folder = folderOf(dir);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700); // owner can enter it; the files inside are 0600
  return folder;
}

async function writeSecretFile(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, text, { flag: 'wx', mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
    await chmod(file, 0o600);
  } catch (error) { await rm(tmp, { force: true }); throw error; }
}

function expiryOf(value: unknown): SecretExpiry {
  if (value === undefined) return '1h';
  if (value === '10m' || value === '1h' || value === '1d') return value;
  throw new Invalid('Expiry is 10 min, 1 hour or 1 day');
}
function viewsOf(value: unknown): number {
  if (value === undefined) return 1;
  if (value === 1 || value === 2 || value === 3) return value;
  throw new Invalid('Views must be 1, 2 or 3');
}

export async function createSecret(dir: string, input: Record<string, unknown>, now = Date.now()): Promise<{ id: string; path: string; expires_at: string; views_left: number; created_at: string }> {
  for (const key of Object.keys(input)) if (!FIELDS.has(key)) throw new Invalid('Unexpected field');
  const ciphertext = decodeBase64(input.ciphertext, MIN_CIPHER, MAX_CIPHER);
  const iv = decodeBase64(input.iv, IV_BYTES, IV_BYTES);
  const views = viewsOf(input.views);
  const expires = expiryOf(input.expires);
  const id = randomBytes(32).toString('base64url');
  const created_at = new Date(now).toISOString();
  const expires_at = new Date(now + EXPIRY_MS[expires]).toISOString();
  const record: SecretRecord = { id, ciphertext, iv, expires_at, views_left: views, created_at };
  await ensureFolder(dir);
  await writeSecretFile(fileOf(dir, id), `${JSON.stringify(record)}\n`);
  return { id, path: `/__feedback/x/${id}`, expires_at, views_left: views, created_at };
}

async function folderReady(dir: string): Promise<boolean> {
  try { return (await stat(folderOf(dir))).isDirectory(); } catch { return false; }
}

// Takes one view and deletes the file when none remain. Unknown, expired and used up are all null. The lock makes the last view single-use.
export async function openSecret(dir: string, id: string, now = Date.now()): Promise<{ ciphertext: string; iv: string } | null> {
  if (!SECRET_ID.test(id) || !(await folderReady(dir))) return null;
  const file = fileOf(dir, id);
  try { if (!(await stat(file)).isFile()) return null; } catch { return null; }
  return withLock(folderOf(dir), async () => {
    const raw = await optional(file);
    if (raw === null) return null;
    const rec = parseRecord(raw);
    if (!rec || rec.id !== id || Date.parse(rec.expires_at) <= now || rec.views_left <= 0) {
      await rm(file, { force: true });
      return null;
    }
    const out = { ciphertext: rec.ciphertext, iv: rec.iv };
    rec.views_left -= 1;
    if (rec.views_left <= 0) await rm(file, { force: true });
    else await writeSecretFile(file, `${JSON.stringify(rec)}\n`);
    return out;
  });
}

export async function revokeSecret(dir: string, id: string): Promise<{ revoked: true }> {
  if (!SECRET_ID.test(id) || !(await folderReady(dir))) throw new Invalid('No such secret link', 404);
  return withLock(folderOf(dir), async () => {
    const file = fileOf(dir, id);
    try { if (!(await stat(file)).isFile()) throw new Invalid('No such secret link', 404); } catch (error) { if (error instanceof Invalid) throw error; throw new Invalid('No such secret link', 404); }
    await rm(file, { force: true });
    return { revoked: true as const };
  });
}

export async function listSecrets(dir: string, now = Date.now()): Promise<SecretInfo[]> {
  if (!(await folderReady(dir))) return [];
  let names: string[] = [];
  try { names = await readdir(folderOf(dir)); } catch { return []; }
  const out: SecretInfo[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (!SECRET_ID.test(id)) continue;
    const raw = await optional(fileOf(dir, id));
    if (raw === null) continue;
    const rec = parseRecord(raw);
    if (!rec || Date.parse(rec.expires_at) <= now || rec.views_left <= 0) continue;
    out.push({ id: rec.id, created_at: rec.created_at, expires_at: rec.expires_at, views_left: rec.views_left });
  }
  out.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return out;
}
