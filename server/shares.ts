// Secret share links. The token is 32 random bytes, url-safe, and only its sha256 is stored. A revoked, expired or unknown token is the same miss.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactSource, readArtifact, artifactHtml, clearSuggest } from './artifacts';
import { scanForSecrets } from './sensitive';
import { Invalid, appendShareNotice, optional, withLock, writeAtomic } from './store';

export type Expiry = '1d' | '7d' | '30d' | 'none';
const AGENT_EXPIRY = ['1d', '7d', '30d'] as const;
const DAY = 864e5;
const SPAN: Record<Exclude<Expiry, 'none'>, number> = { '1d': DAY, '7d': 7 * DAY, '30d': 30 * DAY };
export const SHARE_ID = /^s[0-9a-f]{8}$/;

export interface Share {
  id: string; artifact: string; version: number | 'latest'; token_hash: string; expires_at: string | null;
  created_at: string; created_by: string; views: number; last_viewed_at: string | null; revoked_at?: string;
  // `record`: the owner switched interaction recording on for this link (only the inbox can). `feedback`: how many notes viewers sent through it.
  record?: true; feedback?: number;
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
// Constant-time compare. A stored hash of the wrong length is a miss; the equal-length compare still runs so the length check is not the only branch.
export function sameHash(stored: string, computed: string): boolean {
  const left = Buffer.from(stored);
  const right = Buffer.from(computed);
  if (left.length !== right.length) { timingSafeEqual(right, right); return false; }
  return timingSafeEqual(left, right);
}
export const isActive = (share: Share, now = Date.now()) => !share.revoked_at && !(share.expires_at && Date.parse(share.expires_at) <= now);

export function sharePill(links: number, views: number): string {
  if (!links) return '';
  return `Shared · ${links} ${links === 1 ? 'link' : 'links'} · viewed ${views}×`;
}

const fileOf = (dir: string) => join(dir, '_shares.json');

function parseShare(value: unknown): Share | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const s = value as Record<string, unknown>;
  if (typeof s.id !== 'string' || !SHARE_ID.test(s.id) || typeof s.artifact !== 'string' || typeof s.token_hash !== 'string') return null;
  if (s.version !== 'latest' && (typeof s.version !== 'number' || !Number.isInteger(s.version))) return null;
  if (typeof s.created_at !== 'string' || typeof s.created_by !== 'string' || typeof s.views !== 'number') return null;
  return { id: s.id, artifact: s.artifact, version: s.version as number | 'latest', token_hash: s.token_hash,
    expires_at: typeof s.expires_at === 'string' ? s.expires_at : null, created_at: s.created_at, created_by: s.created_by,
    views: s.views, last_viewed_at: typeof s.last_viewed_at === 'string' ? s.last_viewed_at : null,
    ...(typeof s.revoked_at === 'string' ? { revoked_at: s.revoked_at } : {}), ...(s.record === true ? { record: true as const } : {}),
    ...(typeof s.feedback === 'number' && Number.isInteger(s.feedback) && s.feedback > 0 ? { feedback: s.feedback } : {}) };
}

export async function readShares(dir: string): Promise<Share[]> {
  const raw = await optional(fileOf(dir));
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as { shares?: unknown };
    return Array.isArray(parsed.shares) ? parsed.shares.flatMap(item => { const share = parseShare(item); return share ? [share] : []; }) : [];
  } catch { return []; }
}

async function updateShares<T>(dir: string, fn: (shares: Share[]) => T): Promise<T> {
  try { if (!(await stat(dir)).isDirectory()) throw new Invalid('Not found', 404); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof Invalid) throw new Invalid('Not found', 404); throw error; }
  await mkdir(dir, { recursive: true });
  return withLock(dir, async () => {
    const shares = await readShares(dir);
    const before = JSON.stringify(shares);
    const result = fn(shares);
    if (JSON.stringify(shares) !== before) await writeAtomic(fileOf(dir), `${JSON.stringify({ shares }, null, 2)}\n`);
    return result;
  });
}

export function statsFor(shares: Share[], artifactId: string, now = Date.now()): { links: number; views: number } {
  const active = shares.filter(share => share.artifact === artifactId && isActive(share, now));
  return { links: active.length, views: active.reduce((sum, share) => sum + share.views, 0) };
}

// What the inbox may see. The token and its hash stay on disk.
export function publicShare(share: Share, now = Date.now()) {
  return { id: share.id, artifact: share.artifact, version: share.version, expires_at: share.expires_at, created_at: share.created_at,
    created_by: share.created_by, views: share.views, last_viewed_at: share.last_viewed_at, active: isActive(share, now), record: share.record === true, feedback: share.feedback ?? 0 };
}

export interface NewShare { artifact: string; expires?: Expiry; latest?: boolean; by: string; agent: boolean; confirm?: boolean; now?: number; record?: boolean }
function expiryOf(input: NewShare, now: number): string | null {
  const expires = input.expires ?? (input.agent ? '7d' : '7d');
  if (input.agent) {
    if (expires === 'none' || !(AGENT_EXPIRY as readonly string[]).includes(expires)) throw new Invalid('An agent share expires in 1 day, 7 days or 30 days (the default is 7). A link with no expiry is only created from the inbox.');
    return new Date(now + SPAN[expires]).toISOString();
  }
  if (expires !== '1d' && expires !== '7d' && expires !== '30d' && expires !== 'none') throw new Invalid('Expiry is 1 day, 7 days, 30 days or none');
  return expires === 'none' ? null : new Date(now + SPAN[expires]).toISOString();
}
const whenText = (at: string | null) => (at ? at.slice(0, 10) : 'never');

export async function createShare(dir: string, input: NewShare): Promise<{ share: Share; token: string; path: string }> {
  const meta = await readArtifact(dir, input.artifact);
  if (!meta) throw new Invalid('No such artifact', 404);
  const now = input.now ?? Date.now();
  const expiresAt = expiryOf(input, now);
  // An agent link is pinned to the version that exists now. A later publish would otherwise skip the scan.
  if (input.agent && input.latest) throw new Invalid('An agent share is pinned to the current version. A link that follows later versions is only created from the inbox.');
  const version: number | 'latest' = input.latest ? 'latest' : meta.latest;
  const source = await artifactSource(dir, meta.id, version === 'latest' ? meta.latest : version);
  const hit = scanForSecrets(source);
  if (hit && input.agent) throw new Invalid(`This artifact looks like it contains ${hit}. It was not shared. The person can still share it from the inbox after a warning.`);
  if (hit && !input.confirm) throw new Invalid(`This artifact looks like it contains ${hit}. Share it only if you mean to.`, 409);
  // Recording is the owner's choice. An agent's link never records, whatever the input says.
  const record = input.record === true && !input.agent;
  const token = randomBytes(32).toString('base64url');
  const share: Share = { id: `s${randomBytes(4).toString('hex')}`, artifact: meta.id, version, token_hash: hashToken(token), expires_at: expiresAt,
    created_at: new Date(now).toISOString(), created_by: input.by, views: 0, last_viewed_at: null, ...(record ? { record: true as const } : {}) };
  await updateShares(dir, shares => { shares.push(share); });
  try {
    if (input.agent) await appendShareNotice(dir, meta.thread, `${input.by} shared '${meta.title}' · expires ${whenText(expiresAt)} · Revoke`, share.id, meta.id);
    await clearSuggest(dir, meta.id);
  } catch (error) {
    await updateShares(dir, shares => { const row = shares.find(item => item.id === share.id); if (row && !row.revoked_at) row.revoked_at = new Date().toISOString(); });
    throw error;
  }
  return { share, token, path: `/__feedback/s/${token}` };
}

export async function revokeShare(dir: string, id: string, by: { user: true } | { agent: string }, now = Date.now()): Promise<{ revoked: boolean }> {
  if (!SHARE_ID.test(id)) throw new Invalid('No such share', 404);
  return updateShares(dir, shares => {
    const share = shares.find(item => item.id === id);
    if (!share) throw new Invalid('No such share', 404);
    if (!('user' in by) && share.created_by !== by.agent) throw new Invalid('An agent can only revoke a link it created', 403);
    if (share.revoked_at) return { revoked: false };
    share.revoked_at = new Date(now).toISOString();
    return { revoked: true };
  });
}

// Moves share records onto another project. The token hash is unchanged, so an existing link keeps working and keeps its view count.
// A record the target already has (a retry) is left as it is. The source copies are removed.
export async function transferShares(fromDir: string, toDir: string, moving: Share[]): Promise<void> {
  if (!moving.length) return;
  const hashes = new Set(moving.map(share => share.token_hash));
  await mkdir(toDir, { recursive: true });
  await updateShares(toDir, shares => {
    for (const share of moving) if (!shares.some(item => item.token_hash === share.token_hash)) shares.push(share);
  });
  await updateShares(fromDir, shares => {
    for (let i = shares.length - 1; i >= 0; i--) if (hashes.has(shares[i]!.token_hash)) shares.splice(i, 1);
  });
}

// What a share link serves: the artifact's HTML and the link itself (for the shell page), or null when the token is unknown, revoked or expired.
// Those three are not distinguished. Views count only a page we serve. Nothing about the caller (no address, no user agent) is stored.
export async function openShareDetail(dir: string, token: string, now = Date.now()): Promise<{ html: string; share: Share; title: string } | null> {
  if (!token || token.length > 128) return null;
  const hash = hashToken(token);
  // A miss reads the file and stops. It does not take the lock, and it does not create the data directory or _shares.json.
  const known = (await readShares(dir)).find(share => sameHash(share.token_hash, hash));
  if (!known || !isActive(known, now)) return null;
  let html: string;
  let title = '';
  try { html = await artifactHtml(dir, known.artifact, known.version); title = (await readArtifact(dir, known.artifact))?.title ?? ''; } catch { return null; }
  let served: Share | null = null;
  try {
    await updateShares(dir, shares => {
      const share = shares.find(item => sameHash(item.token_hash, hash));
      if (!share || !isActive(share, now)) return;
      share.views += 1;
      share.last_viewed_at = new Date(now).toISOString();
      served = { ...share };
    });
  } catch { return null; }
  return served ? { html, share: served, title } : null;
}
export async function openShare(dir: string, token: string, now = Date.now()): Promise<string | null> {
  return (await openShareDetail(dir, token, now))?.html ?? null;
}

// A link seen by its token alone, with no side effect: what the feedback and replay endpoints check. Null is the one miss.
export async function activeShare(dir: string, token: string, now = Date.now()): Promise<Share | null> {
  if (!token || token.length > 128) return null;
  const hash = hashToken(token);
  const known = (await readShares(dir)).find(share => sameHash(share.token_hash, hash));
  return known && isActive(known, now) ? known : null;
}

// Counts one viewer note on the link. Quiet when the link has gone.
export async function countFeedback(dir: string, id: string): Promise<void> {
  await updateShares(dir, shares => { const share = shares.find(item => item.id === id); if (share) share.feedback = (share.feedback ?? 0) + 1; });
}

// The owner's switch. Only the inbox calls this: there is no CLI or MCP path to it.
export async function setRecording(dir: string, id: string, on: boolean, now = Date.now()): Promise<Share> {
  if (!SHARE_ID.test(id)) throw new Invalid('No such share', 404);
  return updateShares(dir, shares => {
    const share = shares.find(item => item.id === id);
    if (!share || !isActive(share, now)) throw new Invalid('No such share', 404);
    if (on) share.record = true; else delete share.record;
    return { ...share };
  });
}

// The link's name in a thread: "Viewer feedback · <label>".
export const shareLabel = (share: Share, title: string) => `${title ? `${title.slice(0, 80)} · ` : ''}link ${share.id}`;
