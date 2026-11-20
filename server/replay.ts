// Session replays (rrweb events). One session is `<dir>/_replays/<scope>/<session>.jsonl.gz` (gzip members appended chunk by chunk, so it stays valid
// at every step) and `<session>.json` (metadata). The scope is an artifact id for a shared link, or `_inbox` for the owner's own inbox sessions.
// Nothing about the person (no address, no user agent) is stored: only the link id, version, times and counts.
import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Invalid, optional, withLock, writeAtomic } from './store';
import { ART_ID } from './artifacts';

export const REPLAY_MAX_BYTES = 5 * 1024 * 1024; // uncompressed event bytes per session
export const REPLAY_MAX_MS = 30 * 60 * 1000; // event time per session
export const REPLAY_MAX_EVENTS_PER_CHUNK = 20000;
export const REPLAY_MAX_SESSIONS = 500; // per artifact
export const MAX_CLICK_POINTS = 1000;
export const SESSION_ID = /^[A-Za-z0-9_-]{16,64}$/;
export const INBOX_SCOPE = '_inbox';
export type Scope = string; // an artifact id, or INBOX_SCOPE

export interface ClickPoint { x: number; y: number; w: number }
export interface ReplayMeta {
  session: string; scope: Scope; link: string | null; version: number | null; started_at: string; last_at: string;
  duration_ms: number; clicks: number; events: number; bytes: number; seq: number; first_ts: number; last_ts: number;
  viewport: { w: number; h: number } | null; points: ClickPoint[]; scroll_y: number;
}
export interface Chunk { session: unknown; seq: unknown; events: unknown }
export interface Origin { scope: Scope; link: string | null; version: number | null }

const root = (dir: string) => join(dir, '_replays');
const folder = (dir: string, scope: Scope) => join(root(dir), scope);
const validScope = (scope: string) => scope === INBOX_SCOPE || ART_ID.test(scope);

function parseMeta(raw: string | null): ReplayMeta | null {
  if (raw === null) return null;
  try {
    const m = JSON.parse(raw) as Record<string, unknown>;
    if (typeof m.session !== 'string' || !SESSION_ID.test(m.session) || typeof m.scope !== 'string' || !validScope(m.scope)) return null;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const viewport = m.viewport && typeof m.viewport === 'object' && num((m.viewport as { w?: unknown }).w) > 0 && num((m.viewport as { h?: unknown }).h) > 0 ? { w: num((m.viewport as { w: number }).w), h: num((m.viewport as { h: number }).h) } : null;
    const points = Array.isArray(m.points) ? m.points.flatMap((p: unknown) => (p && typeof p === 'object' && num((p as ClickPoint).w) > 0 ? [{ x: num((p as ClickPoint).x), y: num((p as ClickPoint).y), w: num((p as ClickPoint).w) }] : [])) : [];
    return { session: m.session, scope: m.scope, link: typeof m.link === 'string' ? m.link : null, version: typeof m.version === 'number' ? m.version : null,
      started_at: typeof m.started_at === 'string' ? m.started_at : '', last_at: typeof m.last_at === 'string' ? m.last_at : '', duration_ms: num(m.duration_ms), clicks: num(m.clicks),
      events: num(m.events), bytes: num(m.bytes), seq: typeof m.seq === 'number' ? m.seq : -1, first_ts: num(m.first_ts), last_ts: num(m.last_ts), viewport, points, scroll_y: num(m.scroll_y) };
  } catch { return null; }
}

interface Event { type: number; timestamp: number; data?: unknown; [key: string]: unknown }
function checkEvents(value: unknown): Event[] {
  if (!Array.isArray(value) || !value.length) throw new Invalid('events must be a non-empty list');
  if (value.length > REPLAY_MAX_EVENTS_PER_CHUNK) throw new Invalid('Too many events in one chunk', 413);
  for (const event of value) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Invalid('Invalid event');
    const e = event as Record<string, unknown>;
    if (!Number.isInteger(e.type) || (e.type as number) < 0 || (e.type as number) > 6 || typeof e.timestamp !== 'number' || !Number.isFinite(e.timestamp) || e.timestamp < 0) throw new Invalid('Invalid event');
  }
  return value as Event[];
}

// What a chunk adds to the totals: the viewport (a Meta event), the window scroll, and each click with where it landed on the page.
function scan(events: Event[], meta: ReplayMeta, room: number): { clicks: number; points: ClickPoint[]; viewport: ReplayMeta['viewport']; scrollY: number } {
  let viewport = meta.viewport, scrollY = meta.scroll_y, clicks = 0;
  const points: ClickPoint[] = [];
  for (const event of events) {
    const data = event.data as Record<string, unknown> | undefined;
    if (event.type === 4 && data && typeof data.width === 'number' && typeof data.height === 'number' && data.width > 0) viewport = { w: data.width, h: data.height as number };
    if (event.type !== 3 || !data) continue;
    if (data.source === 3 && data.id === 1 && typeof data.y === 'number') scrollY = data.y;
    if (data.source === 2 && data.type === 2) {
      clicks++;
      if (points.length < room && viewport && typeof data.x === 'number' && typeof data.y === 'number') points.push({ x: Math.round(data.x), y: Math.round(data.y + scrollY), w: viewport.w });
    }
  }
  return { clicks, points, viewport, scrollY };
}

// Adds one chunk to a session. Chunks arrive in order (`seq` 0, 1, 2 ...); one that already arrived is acknowledged and ignored, so a retry never doubles it.
// Throws Invalid 413 once the session is at its size or time cap.
export async function appendChunk(dir: string, origin: Origin, chunk: Chunk, now = Date.now()): Promise<{ seq: number; stored: boolean }> {
  if (!validScope(origin.scope)) throw new Invalid('Not found', 404);
  if (typeof chunk.session !== 'string' || !SESSION_ID.test(chunk.session)) throw new Invalid('Invalid session id');
  if (!Number.isInteger(chunk.seq) || (chunk.seq as number) < 0 || (chunk.seq as number) > 100000) throw new Invalid('Invalid seq');
  const events = checkEvents(chunk.events);
  const seq = chunk.seq as number;
  const session = chunk.session;
  const text = `${events.map(event => JSON.stringify(event)).join('\n')}\n`;
  const size = Buffer.byteLength(text);
  const where = folder(dir, origin.scope);
  await mkdir(where, { recursive: true });
  return withLock(where, async () => {
    const file = join(where, `${session}.json`);
    const old = parseMeta(await optional(file));
    if (old && (old.link !== origin.link || old.scope !== origin.scope)) throw new Invalid('Not found', 404); // a session id belongs to one link
    if (old && seq <= old.seq) return { seq: old.seq, stored: false };
    if (old ? seq !== old.seq + 1 : seq !== 0) throw new Invalid('Chunks must arrive in order', 409);
    if (!old && origin.scope !== INBOX_SCOPE && (await readdir(where)).filter(name => name.endsWith('.json')).length >= REPLAY_MAX_SESSIONS) throw new Invalid('This page has as many recordings as it keeps', 413);
    const meta: ReplayMeta = old ?? { session, scope: origin.scope, link: origin.link, version: origin.version, started_at: new Date(now).toISOString(), last_at: '', duration_ms: 0, clicks: 0, events: 0, bytes: 0, seq: -1,
      first_ts: Math.min(...events.map(e => e.timestamp)), last_ts: 0, viewport: null, points: [], scroll_y: 0 };
    if (meta.bytes + size > REPLAY_MAX_BYTES) throw new Invalid('This recording is at its size limit', 413);
    const high = Math.max(...events.map(e => e.timestamp)), low = Math.min(...events.map(e => e.timestamp));
    if (high - Math.min(meta.first_ts, low) > REPLAY_MAX_MS) throw new Invalid('This recording is at its time limit', 413);
    const seen = scan(events, meta, MAX_CLICK_POINTS - meta.points.length);
    const next: ReplayMeta = { ...meta, first_ts: Math.min(meta.first_ts, low), last_ts: Math.max(meta.last_ts, high), seq, last_at: new Date(now).toISOString(), events: meta.events + events.length, bytes: meta.bytes + size,
      clicks: meta.clicks + seen.clicks, points: [...meta.points, ...seen.points], viewport: seen.viewport, scroll_y: seen.scrollY };
    next.duration_ms = Math.max(0, next.last_ts - next.first_ts);
    await appendFile(join(where, `${session}.jsonl.gz`), gzipSync(text));
    await writeAtomic(file, JSON.stringify(next));
    return { seq, stored: true };
  });
}

export async function listReplays(dir: string, scope: Scope): Promise<Omit<ReplayMeta, 'points'>[]> {
  if (!validScope(scope)) return [];
  let names: string[];
  try { names = await readdir(folder(dir, scope)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const out: Omit<ReplayMeta, 'points'>[] = [];
  for (const name of names.filter(n => n.endsWith('.json'))) {
    const meta = parseMeta(await optional(join(folder(dir, scope), name)).catch(() => null));
    if (meta) { const { points: _points, ...rest } = meta; out.push(rest); }
  }
  return out.sort((a, b) => b.started_at.localeCompare(a.started_at) || b.session.localeCompare(a.session));
}

export async function readReplay(dir: string, scope: Scope, session: string): Promise<{ meta: Omit<ReplayMeta, 'points'>; events: unknown[] } | null> {
  if (!validScope(scope) || !SESSION_ID.test(session)) return null;
  const meta = parseMeta(await optional(join(folder(dir, scope), `${session}.json`)));
  if (!meta) return null;
  const file = Bun.file(join(folder(dir, scope), `${session}.jsonl.gz`));
  if (!(await file.exists())) return null;
  const lines = gunzipSync(Buffer.from(await file.arrayBuffer())).toString('utf8').split('\n');
  const events: unknown[] = [];
  for (const line of lines) { if (!line) continue; try { events.push(JSON.parse(line)); } catch { /* a torn line */ } }
  const { points: _points, ...rest } = meta;
  return { meta: rest, events };
}

export async function deleteReplay(dir: string, scope: Scope, session: string): Promise<boolean> {
  if (!validScope(scope) || !SESSION_ID.test(session)) return false;
  const where = folder(dir, scope);
  return withLock(where, async () => {
    const had = (await optional(join(where, `${session}.json`))) !== null;
    await rm(join(where, `${session}.json`), { force: true });
    await rm(join(where, `${session}.jsonl.gz`), { force: true });
    return had;
  }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; });
}

// A viewer who opts out: removes their session if it belongs to this link. Another link's session is refused (404); one that was never stored is a quiet no.
export async function discardSession(dir: string, origin: Origin, session: unknown): Promise<boolean> {
  if (!validScope(origin.scope)) throw new Invalid('Not found', 404);
  if (typeof session !== 'string' || !SESSION_ID.test(session)) throw new Invalid('Invalid session id');
  const where = folder(dir, origin.scope);
  return withLock(where, async () => {
    const old = parseMeta(await optional(join(where, `${session}.json`)));
    if (!old) {
      await rm(join(where, `${session}.jsonl.gz`), { force: true }); // a chunk file without metadata (an interrupted write) is no one's: it goes too
      return false;
    }
    if (old.link !== origin.link || old.scope !== origin.scope) throw new Invalid('Not found', 404);
    await rm(join(where, `${session}.json`), { force: true });
    await rm(join(where, `${session}.jsonl.gz`), { force: true });
    return true;
  }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; });
}

// Click positions across an artifact's sessions of one version, as fractions of the page width: left = x / w, top = y / w (of the width it was recorded at).
export async function heatmap(dir: string, artifact: string, version: number | null): Promise<{ sessions: number; clicks: { x: number; y: number }[] }> {
  if (!ART_ID.test(artifact)) return { sessions: 0, clicks: [] };
  let names: string[];
  try { names = await readdir(folder(dir, artifact)); } catch { return { sessions: 0, clicks: [] }; }
  const clicks: { x: number; y: number }[] = [];
  let sessions = 0;
  for (const name of names.filter(n => n.endsWith('.json'))) {
    const meta = parseMeta(await optional(join(folder(dir, artifact), name)).catch(() => null));
    if (!meta || (version !== null && meta.version !== version)) continue;
    sessions++;
    for (const p of meta.points) clicks.push({ x: Math.round((p.x / p.w) * 10000) / 10000, y: Math.round((p.y / p.w) * 10000) / 10000 });
  }
  return { sessions, clicks };
}

// Removes sessions not written to for `days` days (by the server's clock). Safe to run any time. Returns how many it removed.
export async function cleanupReplays(dir: string, days: number, now = Date.now()): Promise<number> {
  const cutoff = now - days * 864e5;
  let removed = 0;
  let scopes: string[];
  try { scopes = await readdir(root(dir)); } catch { return 0; }
  for (const scope of scopes.filter(validScope)) {
    let names: string[];
    try { names = await readdir(folder(dir, scope)); } catch { continue; }
    for (const name of names.filter(n => n.endsWith('.json'))) {
      const session = name.slice(0, -5);
      const meta = parseMeta(await optional(join(folder(dir, scope), name)).catch(() => null));
      const at = meta ? Date.parse(meta.last_at || meta.started_at) : (await stat(join(folder(dir, scope), name)).then(s => s.mtimeMs, () => now));
      if (Number.isFinite(at) && at < cutoff && SESSION_ID.test(session)) { if (await deleteReplay(dir, scope, session)) removed++; }
    }
  }
  return removed;
}
// A pass at start and then once a day. The timer does not keep the process alive.
export function startReplayCleanup(dir: string, days: number, everyMs = 864e5): () => void {
  const pass = async () => { try { await cleanupReplays(dir, days); } catch (error) { console.error('Replay cleanup failed', error); } };
  const timer = setInterval(pass, everyMs);
  timer.unref?.();
  void pass();
  return () => clearInterval(timer);
}

// The owner's own inbox recording: off until the owner switches it on.
export async function readInboxSetting(dir: string): Promise<boolean> {
  try { return (JSON.parse(await optional(join(root(dir), '_settings.json')) ?? 'null') as { record_inbox?: unknown } | null)?.record_inbox === true; } catch { return false; }
}
export async function setInboxSetting(dir: string, on: boolean): Promise<boolean> {
  await mkdir(root(dir), { recursive: true });
  await writeAtomic(join(root(dir), '_settings.json'), JSON.stringify({ record_inbox: on }));
  return on;
}
