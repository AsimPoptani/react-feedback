import { readdir, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import * as store from './store';
import { computeMetrics, checkWindow } from './metrics';
import { loadAreas, loadReplayDays, loadSecretTarget, loadVaultDir } from './config';
import { packageVersion } from './version';
import * as reminders from './reminders';
import { redactMessage, recordSecretSaved, validateVault } from './sensitive';
import { DEFAULT_AREAS, type AreasConfig } from './inbox/areas.js';
import { Invalid, ID, MESSAGE_IMAGE, MIME, MAX_REQUEST, itemDir, optional } from './store';
import * as artifacts from './artifacts';
import * as shares from './shares';
import { checkIcons, loadProjects, projectById, readProjectIcon, type Project } from './projects';
import { moveThreadToProject } from './move-project';
import * as files from './files';
import * as replay from './replay';
import { shellPage, withCapture } from './shell';
import { ByteBudget, Limiter, clientKey, type ServerLike } from './limits';
import { pairRoutes, type ExtraRoute } from './pair-routes';
import { pairingFor } from './pair';
import { hostAllowed, hostRefusal } from './hosts';

const PREFIX = '/__feedback';
const FILE = /^(image\.png|annotated\.png|context\.png|feedback\.md)$/;
const LIMIT = MAX_REQUEST;
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
type ObjectData = Record<string, unknown>;
function object(value: unknown): ObjectData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Invalid('Expected an object');
  return value as ObjectData;
}
const MODES = ['region', 'element', 'section', 'page'];
function note(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 10000) throw new Invalid('Note must be 1–10000 characters');
  return value;
}
function mode(value: unknown): string {
  if (typeof value !== 'string' || !MODES.includes(value)) throw new Invalid('Invalid capture mode');
  return value;
}
function png(value: unknown): Buffer | null {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Invalid('Expected a PNG data URL');
  const bytes = Buffer.from(value.slice('data:image/png;base64,'.length), 'base64');
  if (!bytes.subarray(0, 8).equals(SIGNATURE)) throw new Invalid('Invalid PNG signature');
  return bytes;
}
export async function body(req: Request): Promise<ObjectData> {
  if (req.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new Invalid('JSON only', 415);
  if (Number(req.headers.get('content-length')) > LIMIT) throw new Invalid('Body exceeds 25 MB', 413);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body?.getReader();
  if (!reader) throw new Invalid('Missing body');
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > LIMIT) { await reader.cancel(); throw new Invalid('Body exceeds 25 MB', 413); }
    chunks.push(value);
  }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch { throw new Invalid('Invalid JSON object'); }
}
const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
function clientId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !CLIENT_ID.test(value)) throw new Invalid('Invalid client_id');
  return value;
}
function validate(data: ObjectData) {
  const image = png(data.image);
  if (!image) throw new Invalid('Image is required');
  return { note: note(data.note), mode: mode(data.mode), target: data.target === undefined ? undefined : object(data.target),
    image, annotated: png(data.annotated), context_image: png(data.context_image), context: object(data.context), client_id: clientId(data.client_id) };
}
type Valid = ReturnType<typeof validate>;
// A repeated client_id (the widget resending after a lost reply) returns the item it already made.
const writing = new Map<string, Promise<{ id: string; fresh: boolean }>>();
async function existingId(dir: string, client_id: string): Promise<string | null> {
  let entries: string[];
  try { entries = await readdir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  for (const id of entries.filter(entry => ID.test(entry)).sort().reverse()) {
    const raw = await optional(join(dir, id, 'item.json')).catch(() => null);
    try { if (raw && (JSON.parse(raw) as ObjectData).client_id === client_id) return id; } catch { /* a broken item cannot match */ }
  }
  return null;
}
async function create(dir: string, data: ObjectData) {
  const valid = validate(data);
  if (!valid.client_id) return json({ id: await write(dir, valid) }, 201);
  const key = `${dir}\0${valid.client_id}`;
  let job = writing.get(key);
  if (!job) {
    const client_id = valid.client_id;
    job = (async () => { const old = await existingId(dir, client_id); return old ? { id: old, fresh: false } : { id: await write(dir, valid), fresh: true }; })();
    writing.set(key, job);
    void job.then(() => writing.delete(key), () => writing.delete(key));
  }
  const { id, fresh } = await job;
  return json({ id }, fresh ? 201 : 200);
}
async function write(dir: string, valid: Valid): Promise<string> {
  const { id, path, created_at } = await store.makeItemFolder(dir);
  try {
    const save = async (name: string, bytes: Buffer | null) => {
      if (!bytes) return null;
      await writeFile(join(path, name), bytes, { flag: 'wx' });
      return name;
    };
    const item = { id, created_at, ...(valid.client_id ? { client_id: valid.client_id } : {}), note: valid.note, mode: valid.mode, target: valid.target, context: valid.context,
      image: await save('image.png', valid.image),
      ...(valid.annotated ? { annotated: await save('annotated.png', valid.annotated) } : {}),
      ...(valid.context_image ? { context_image: await save('context.png', valid.context_image) } : {}) };
    await writeFile(join(path, 'item.json'), JSON.stringify(item, null, 2));
    await writeFile(join(path, 'status.json'), JSON.stringify({ status: 'open' }));
    await writeFile(join(path, 'feedback.md'), store.captureSummary(item));
    await store.startCaptureThread(dir, id, valid.note, created_at);
  } catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
  await store.logEvent(dir, { id, kind: 'thread', text: valid.note }); // only a fresh write gets here, inside the coalesced job
  return id;
}
function storedItem(raw: string): ObjectData | null {
  try {
    const item = object(JSON.parse(raw));
    note(item.note); mode(item.mode); object(item.context);
    if (typeof item.created_at !== 'string' || typeof (item.context as ObjectData).url !== 'string' || item.image !== 'image.png') return null;
    if (item.target !== undefined) object(item.target);
    return item;
  } catch { return null; }
}
async function listedItem(dir: string, id: string) {
  try {
    const path = join(dir, id);
    if (!(await lstat(path)).isDirectory()) return null;
    const raw = await optional(join(path, 'item.json'));
    const item = raw ? storedItem(raw) : null;
    if (!item) return null;
    const status = object(JSON.parse(await optional(join(path, 'status.json')) ?? 'null')).status;
    const stored = store.normaliseStatus(status);
    if (!stored) return null;
    const reply = await optional(join(path, 'reply.md'));
    const lastAuthor = stored === 'open' ? (await store.summarise(dir, id)).summary.last_author : null;
    return { id, created_at: item.created_at as string, url: (item.context as ObjectData).url,
      mode: item.mode, note_first_line: (item.note as string).split('\n')[0], status: stored === 'open' ? (lastAuthor === 'agent' ? 'seen' : 'new') : stored, reply }; // the widget's list keeps its old vocabulary
  } catch { return null; } // A broken item must not hide the rest of the feedback.
}
async function list(dir: string) {
  let entries: string[];
  try { entries = await readdir(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return json([]); throw error; }
  const items = [];
  for (const id of entries.filter(id => ID.test(id))) {
    const item = await listedItem(dir, id);
    if (item) items.push(item);
  }
  items.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  return json(items);
}
async function itemRoute(req: Request, dir: string, id: string, file: string) {
  const path = await itemDir(dir, id);
  if (req.method === 'POST' && file === 'status') {
    const data = await body(req);
    const next = store.checkStatus(data.status);
    const statusPath = join(path, 'status.json');
    const stat = await lstat(statusPath);
    if (!stat.isFile()) throw new Invalid('Invalid status file');
    await writeFile(statusPath, JSON.stringify({ status: next }));
    return json({ status: next });
  }
  if (req.method !== 'GET' || !(FILE.test(file) || MESSAGE_IMAGE.test(file))) return json({ kind: 'not_found' }, 404);
  const target = join(path, file);
  try {
    if (!(await lstat(target)).isFile()) return json({ kind: 'not_found' }, 404);
    return new Response(await readFile(target), { headers: { 'Content-Type': file.endsWith('.md') ? 'text/markdown; charset=utf-8' : MIME[file.slice(file.lastIndexOf('.') + 1) as keyof typeof MIME], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'" } });
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return json({ kind: 'not_found' }, 404); throw error; }
}
const INBOX = resolve(import.meta.dir, 'inbox');
const INBOX_FILES: Record<string, string> = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'areas.js': 'text/javascript; charset=utf-8', 'quote.js': 'text/javascript; charset=utf-8', 'donut.js': 'text/javascript; charset=utf-8', 'aside.js': 'text/javascript; charset=utf-8', 'tracker.js': 'text/javascript; charset=utf-8', 'markdown.js': 'text/javascript; charset=utf-8', 'secret.js': 'text/javascript; charset=utf-8', 'outbox.js': 'text/javascript; charset=utf-8', 'sha256.js': 'text/javascript; charset=utf-8', 'uploader.js': 'text/javascript; charset=utf-8', 'presence.js': 'text/javascript; charset=utf-8', 'replays.js': 'text/javascript; charset=utf-8', 'shot.js': 'text/javascript; charset=utf-8', 'version.js': 'text/javascript; charset=utf-8', 'pair.js': 'text/javascript; charset=utf-8', 'qr.js': 'text/javascript; charset=utf-8', 'sw.js': 'text/javascript; charset=utf-8' };
// The drop-in widget bundle (built to dist/embed.js), served so any page can load it from the feedback server itself.
const EMBED = resolve(import.meta.dir, '../dist/embed.js');
async function embedRoute(req: Request, path: string): Promise<Response | null> {
  if (path !== `${PREFIX}/embed.js` || (req.method !== 'GET' && req.method !== 'HEAD')) return null;
  try {
    return new Response(await readFile(EMBED), { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return json({ kind: 'not_found', detail: 'dist/embed.js is not built' }, 404); throw error; }
}
// The replay assets (built to dist/): the recorder the inbox loads when its owner records their own sessions, and the player page the Replays tab frames.
const REPLAY_ASSETS: Record<string, { file: string; type: string }> = {
  'recorder.js': { file: '../dist/recorder.js', type: 'text/javascript; charset=utf-8' },
  'player.js': { file: '../dist/player.js', type: 'text/javascript; charset=utf-8' },
  'player.css': { file: '../dist/player.css', type: 'text/css; charset=utf-8' },
};
const PLAYER_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Replay</title>
<link rel="stylesheet" href="player.css"><style>html,body{margin:0;background:#fff;font:14px system-ui,sans-serif}#rf-player{display:flex;flex-direction:column;align-items:center}.rf-live-bar{display:flex;gap:10px;align-items:center;justify-content:center;padding:6px 8px;font-size:13px}.rf-live-badge{background:#c62828;color:#fff;font-weight:700;border-radius:6px;padding:2px 8px;letter-spacing:.06em}.rf-live-badge.rf-ended{background:#5d6d73}.rf-live-note{color:#4a636d}</style></head>
<body><div id="rf-player"></div><script src="player.js"></script></body></html>
`;
// The player page takes recorded events (which anyone with a recording link could have crafted) and draws them. It may run only its own script, make no requests,
// and cannot be framed by or form-post anywhere; rrweb 2.2 rebuilds a recording only inside an iframe that runs no scripts.
const PLAYER_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; media-src 'self' data: blob:; frame-src about: blob: data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
async function replayAssetRoute(req: Request, path: string): Promise<Response | null> {
  const match = path.match(/^\/__feedback\/replay\/([a-z.]+)$/);
  if (!match || (req.method !== 'GET' && req.method !== 'HEAD')) return null;
  const headers = { 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  if (match[1] === 'player') return new Response(PLAYER_PAGE, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PLAYER_CSP } });
  const asset = Object.hasOwn(REPLAY_ASSETS, match[1]!) ? REPLAY_ASSETS[match[1]!] : undefined;
  if (!asset) return json({ kind: 'not_found' }, 404);
  try { return new Response(await readFile(resolve(import.meta.dir, asset.file)), { headers: { ...headers, 'Content-Type': asset.type } }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return json({ kind: 'not_found', detail: 'dist is not built' }, 404); throw error; }
}
// FEEDBACK_INBOX_WIDGET=0 (or off, false, no) leaves the capture widget off the inbox page itself.
const WIDGET_TAG = /<script src="\.\.\/embed\.js"[^>]*><\/script>\n?/;
const foldFyiOn = () => /^(1|on|true|yes)$/i.test(process.env.FEEDBACK_FOLD_FYI?.trim() ?? '');
const inboxWidgetOn = () => !/^(0|off|false|no)$/i.test(process.env.FEEDBACK_INBOX_WIDGET?.trim() ?? '');
// The page remembers the version it was given. A later poll reads the live package version from api/config.
function withVersion(html: string): string {
  const version = packageVersion();
  return html
    .replace(/(<meta name="rf-version" content=")[^"]*(")/, `$1${version}$2`)
    .replace(/(id="app-version">)[^<]*/, `$1react-feedback v${version}`);
}
async function inboxRoute(req: Request, path: string): Promise<Response | null> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  if (path === `${PREFIX}/inbox`) return new Response(null, { status: 308, headers: { Location: `${PREFIX}/inbox/` } });
  const match = path.match(/^\/__feedback\/inbox\/([^/]*)$/);
  if (!match) return null;
  const name = match[1] || 'index.html';
  const type = Object.hasOwn(INBOX_FILES, name) ? INBOX_FILES[name] : undefined;
  if (!type) return json({ kind: 'not_found' }, 404);
  const file = await readFile(join(INBOX, name));
  let html = file.toString('utf8');
  if (name === 'index.html') {
    html = withVersion(html);
    if (!inboxWidgetOn()) html = html.replace(WIDGET_TAG, '');
    if (foldFyiOn()) html = html.replace('<body>', '<body data-fold-fyi>');
  }
  const body = name === 'index.html' ? Buffer.from(html) : file;
  return new Response(body, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
async function threadDetail(dir: string, id: string) {
  const { summary, messages, item } = await store.summarise(dir, id);
  const context = (item.context ?? {}) as ObjectData;
  const path = join(dir, id);
  const has = (name: string) => lstat(join(path, name)).then(s => s.isFile(), () => false);
  const allShares = await shares.readShares(dir);
  const published = (await artifacts.listArtifacts(dir, id)).map(meta => ({ id: meta.id, thread: meta.thread, title: meta.title, latest: meta.latest, updated_at: meta.updated_at,
    versions: meta.versions.map(version => version.n), ...(meta.suggest ? { suggest: true } : {}), ...shares.statsFor(allShares, meta.id) }));
  return { ...summary, url: typeof context.url === 'string' ? context.url : null, viewport: context.viewport ?? null, target: store.cleanTarget(item.target ?? null),
    note: typeof item.note === 'string' ? item.note : '', checklist_items: await store.listChecklist(dir, id), files: { image: await has('image.png'), annotated: await has('annotated.png'), context: await has('context.png') }, messages: store.withExpired(messages),
    reminders_fired: (await reminders.readStored(path)).fired, artifacts: published };
}
async function profileRoute(req: Request, dir: string, path: string, read: (req: Request) => Promise<ObjectData>): Promise<Response | null> {
  const base = `${PREFIX}/api/profile`;
  if (path === base && req.method === 'GET') return json(await store.readProfile(dir));
  if (path === base && req.method === 'POST') { const data = await read(req); return json(await store.updateProfile(dir, { name: data.name, avatar: data.avatar })); }
  const match = path.match(/^\/__feedback\/api\/profile\/avatar\/(user|agent)$/);
  if (!match || req.method !== 'GET') return null;
  const found = await store.avatarBytes(dir, match[1]!);
  if (!found) return json({ kind: 'not_found' }, 404);
  return new Response(found.bytes, { headers: { 'Content-Type': MIME[found.ext], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'" } });
}
// Checklist: the inbox speaks as the user, so it can add, edit its own items, claim and delete its own. It can never tick.
async function checklistRoute(req: Request, dir: string, path: string, read: (req: Request) => Promise<ObjectData>): Promise<Response | null> {
  const match = path.match(/^\/__feedback\/api\/threads\/([^/]+)\/checklist(?:\/([^/]+))?$/);
  if (!match) return null;
  const [, id, itemId] = match;
  if (!itemId) {
    if (req.method === 'GET') return json({ items: await store.listChecklist(dir, id!) });
    if (req.method !== 'POST') return null;
    const data = await read(req);
    return json(await store.addChecklistItem(dir, id!, { owner: data.owner, text: data.text, by: 'user' }), 201);
  }
  if (req.method === 'PATCH') { const data = await read(req); return json(await store.patchChecklistItem(dir, id!, itemId, { text: data.text, done: data.done, claimed: data.claimed }, 'user')); }
  if (req.method === 'DELETE') { await store.deleteChecklistItem(dir, id!, itemId, 'user'); return json({ ok: true }); }
  return null;
}
// Reminders target the agent, so a read-only thread still takes them. The user adds and removes them; a fire is the agent's alone to see (never a notification).
async function remindersRoute(req: Request, dir: string, path: string, read: (req: Request) => Promise<ObjectData>): Promise<Response | null> {
  const match = path.match(/^\/__feedback\/api\/threads\/([^/]+)\/reminders(?:\/([^/]+))?$/);
  if (!match) return null;
  const [, id, rid] = match;
  if (!rid) {
    if (req.method === 'GET') return json(await reminders.listReminders(dir, id!));
    if (req.method !== 'POST') return null;
    const data = await read(req);
    return json(await reminders.addReminder(dir, id!, { kind: data.kind, value: data.value, say: data.say, by: 'user' }), 201);
  }
  if (rid === 'default' && req.method === 'POST') { const data = await read(req); if (typeof data.on !== 'boolean') throw new Invalid('on must be true or false'); await reminders.setDefaultReminder(dir, id!, data.on); return json(await reminders.listReminders(dir, id!)); }
  if (req.method === 'DELETE') { await reminders.removeReminder(dir, id!, rid); return json({ ok: true }); }
  return null;
}
async function pinsRoute(req: Request, dir: string, path: string, read: (req: Request) => Promise<ObjectData>): Promise<Response | null> {
  if (path !== `${PREFIX}/api/pins`) return null;
  if (req.method === 'GET') return json(await store.readPins(dir));
  if (req.method !== 'POST') return null;
  const data = await read(req);
  return json(await store.setPin(dir, { kind: data.kind, id: data.id, pinned: data.pinned }));
}
export interface HandlerOptions { secretTarget?: string | null; vaultDir?: string | null; now?: () => number; projects?: Project[]; files?: files.FilesOptions; extra?: ExtraRoute }
// A chunk is at most 32 MiB; the server accepts that and a little more, and a JSON body is held to LIMIT by body() itself.
const CHUNK_REQUEST = files.CHUNK_BYTES + 1024 * 1024;
const SANDBOX = { 'Content-Security-Policy': 'sandbox allow-scripts allow-popups', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
// The shell page is sandboxed (an opaque origin), so its two POSTs are cross-origin: these answers say any origin may read them. They carry no credentials and no secret.
const CORS = { 'Access-Control-Allow-Origin': '*' };
const SHARE_MISS = { ...SANDBOX, ...CORS, 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex' };
// Revoked, expired and unknown tokens are this one response: same status, same body, same headers.
const shareMiss = () => new Response('Not found\n', { status: 404, headers: SHARE_MISS });
const shareHit = (html: string) => new Response(html, { headers: { ...SANDBOX, 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' } });
const shareJson = (body: unknown, status = 200) => Response.json(body, { status, headers: { ...SANDBOX, ...CORS, 'X-Robots-Tag': 'noindex' } });
const userImageBytes = new ByteBudget(48 * 1024 * 1024, 60e3); // decoded picture bytes posted as the user, per thread a minute
const MAX_NOTE_BODY = 16 * 1024;
// A note that carries a screenshot (the client says so with ?image=1 on the same path, so a note without one keeps its small cap): 2 MB of image is about 2.8 MB as base64.
const MAX_IMAGE_BODY = Math.ceil(store.VIEWER_IMAGE_BYTES / 3) * 4 + 64 * 1024;
const VIEWER_IMAGE_DAILY_BYTES = 20 * 1024 * 1024; // per link, decoded
const MAX_REPLAY_BODY = replay.REPLAY_MAX_BYTES + 1024 * 1024;
// A small JSON body from a viewer. `text/plain` is accepted so the sandboxed shell can send it without a preflight (the token is the credential here, not a cookie).
async function viewerBody(req: Request, limit: number): Promise<ObjectData> {
  const type = req.headers.get('content-type')?.split(';')[0]?.trim();
  if (type !== 'application/json' && type !== 'text/plain') throw new Invalid('JSON only', 415);
  if (Number(req.headers.get('content-length')) > limit) throw new Invalid('Body is too large', 413);
  const reader = req.body?.getReader();
  if (!reader) throw new Invalid('Missing body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw new Invalid('Body is too large', 413); }
    chunks.push(value);
  }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { throw new Invalid('Invalid JSON object'); }
}
// What the public share endpoints remember, in memory only: how often a link and a caller used them. Never written to disk.
interface ShareLimits { feedbackLink: Limiter; feedbackCaller: Limiter; feedbackImages: ByteBudget; replayChunks: Limiter; replaySessions: Limiter }
const newLimits = (): ShareLimits => ({
  feedbackLink: new Limiter([{ windowMs: 60e3, max: 5 }, { windowMs: 864e5, max: 50 }]),
  feedbackCaller: new Limiter([{ windowMs: 60e3, max: 5 }]),
  feedbackImages: new ByteBudget(VIEWER_IMAGE_DAILY_BYTES, 864e5),
  replayChunks: new Limiter([{ windowMs: 60e3, max: 120 }]),
  replaySessions: new Limiter([{ windowMs: 864e5, max: 50 }]),
});
function dataDirOf(req: Request, fallback: string, projects?: Project[]): string {
  if (!projects) return fallback; // single-project mode: ?project= is ignored and every URL is the one it has always been
  const id = new URL(req.url).searchParams.get('project');
  if (!id) return projects[0]?.dir ?? fallback;
  return projectById(projects, id).dir;
}
async function projectList(projects: Project[], fallback: string): Promise<{ id: string; name: string; unread: number; has_icon?: true }[]> {
  const list = projects.length ? projects : [{ id: 'default', name: 'Feedback', dir: fallback }];
  const out: { id: string; name: string; unread: number; has_icon?: true }[] = [];
  for (const project of list) {
    let unread = 0;
    try { unread = (await store.listThreads(project.dir)).filter(thread => thread.unread_for_user).length; } catch { unread = 0; }
    out.push({ id: project.id, name: project.name, unread, ...(project.icon ? { has_icon: true as const } : {}) }); // absent means no picture: the existing list shape is unchanged for a project without one
  }
  return out;
}
// Uploads: any file, in chunks of at most 32 MiB, resumable. The bytes go to disk as they arrive.
async function uploadsRoute(req: Request, dir: string, path: string, read: (req: Request) => Promise<ObjectData>, options: HandlerOptions): Promise<Response | null> {
  const opts = { ...options.files, ...(options.now ? { now: options.now } : {}) };
  if (path === `${PREFIX}/api/uploads` && req.method === 'POST') {
    const data = await read(req);
    return json(await files.createUpload(dir, { name: data.name, size: data.size, sha256: data.sha256, by: 'user' }, opts), 201);
  }
  const match = path.match(/^\/__feedback\/api\/uploads\/([^/]+)(?:\/(finalise))?$/);
  if (!match) return null;
  const [, id, action] = match;
  if (!action && req.method === 'GET') return json(await files.uploadStatus(dir, id));
  if (!action && req.method === 'DELETE') { await files.cancelUpload(dir, id); return json({ ok: true }); }
  if (!action && req.method === 'PUT') {
    if (req.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/octet-stream') throw new Invalid('A chunk is sent as application/octet-stream', 415);
    const offset = Number(new URL(req.url).searchParams.get('offset'));
    const length = req.headers.get('content-length');
    return json(await files.appendChunk(dir, id, offset, req.body, length === null ? undefined : Number(length), opts));
  }
  if (action === 'finalise' && req.method === 'POST') { const data = await read(req); return json(await files.finaliseUpload(dir, id, data.sha256)); }
  return null;
}
// A file in a thread. Only a file that a message in that thread still lists is served: a redacted message's files are in the vault. See files.downloadHeaders.
async function attachmentRoute(req: Request, dir: string, path: string): Promise<Response | null> {
  const match = path.match(/^\/__feedback\/api\/threads\/([^/]+)\/attachments\/(u[0-9a-f]{16})$/);
  if (!match || (req.method !== 'GET' && req.method !== 'HEAD')) return null;
  const folder = await itemDir(dir, match[1]!);
  const found = (await store.readMessages(folder, await store.readItem(folder))).flatMap(m => (m.redacted ? [] : m.attachments ?? [])).find(a => a.id === match[2]);
  const target = found ? files.attachmentPath(folder, found) : null;
  if (!found || !target) return json({ kind: 'not_found' }, 404);
  try { if (!(await lstat(target)).isFile()) return json({ kind: 'not_found' }, 404); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return json({ kind: 'not_found' }, 404); throw error; }
  const headers = files.downloadHeaders(found, new URL(req.url).searchParams.get('inline') === '1');
  return new Response(req.method === 'HEAD' ? null : Bun.file(target), { headers }); // streamed from disk, never read into memory
}
async function artifactRoute(req: Request, dir: string, path: string, read: (req: Request) => Promise<ObjectData>, now: number): Promise<Response | null> {
  if (path === `${PREFIX}/api/artifacts` && req.method === 'GET') {
    const thread = new URL(req.url).searchParams.get('thread') ?? undefined;
    const [list, all] = [await artifacts.listArtifacts(dir, thread || undefined), await shares.readShares(dir)];
    return json(list.map(meta => ({ ...meta, ...shares.statsFor(all, meta.id, now) })));
  }
  if (path === `${PREFIX}/api/shares` && req.method === 'GET') {
    const [all, metas] = [await shares.readShares(dir), await artifacts.listArtifacts(dir)];
    const titles = new Map(metas.map(meta => [meta.id, meta.title]));
    return json(all.filter(share => shares.isActive(share, now)).map(share => ({ ...shares.publicShare(share, now), title: titles.get(share.artifact) ?? '' })));
  }
  const one = path.match(/^\/__feedback\/api\/artifacts\/(a[0-9a-f]{12})$/);
  if (one && req.method === 'GET') {
    const meta = await artifacts.readArtifact(dir, one[1]!);
    if (!meta) return json({ kind: 'not_found' }, 404);
    const all = await shares.readShares(dir);
    return json({ ...meta, ...shares.statsFor(all, meta.id, now), shares: all.filter(share => share.artifact === meta.id && shares.isActive(share, now)).map(share => shares.publicShare(share, now)) });
  }
  const sharePost = path.match(/^\/__feedback\/api\/artifacts\/(a[0-9a-f]{12})\/share$/);
  if (sharePost && req.method === 'POST') {
    const data = await read(req);
    const expires = data.expires;
    if (expires !== '1d' && expires !== '7d' && expires !== '30d' && expires !== 'none') throw new Invalid('Expiry is 1 day, 7 days, 30 days or none');
    if (data.record !== undefined && typeof data.record !== 'boolean') throw new Invalid('record must be true or false');
    const created = await shares.createShare(dir, { artifact: sharePost[1]!, expires, latest: data.latest === true, by: 'you', agent: false, confirm: data.confirm === true, now, record: data.record === true });
    return json({ id: created.share.id, url: created.path, expires_at: created.share.expires_at, version: created.share.version, created_by: 'you', record: created.share.record === true }, 201);
  }
  const revoke = path.match(/^\/__feedback\/api\/shares\/(s[0-9a-f]{8})\/revoke$/);
  if (revoke && req.method === 'POST') { await read(req); return json(await shares.revokeShare(dir, revoke[1]!, { user: true }, now)); }
  // The owner's recording switch for one link. Only the inbox has this: no CLI command or MCP tool reaches it.
  const record = path.match(/^\/__feedback\/api\/shares\/(s[0-9a-f]{8})\/record$/);
  if (record && req.method === 'POST') {
    const data = await read(req);
    if (typeof data.on !== 'boolean') throw new Invalid('on must be true or false');
    return json(shares.publicShare(await shares.setRecording(dir, record[1]!, data.on, now), now));
  }
  return null;
}
// The list of an artifact's (or the inbox's own) sessions, each with whether a chunk arrived in the last ~20 s ("Live"). The owner's endpoints only: a viewer has no read path.
async function listWithLive(dir: string, scope: string, now: number) {
  return (await replay.listReplays(dir, scope)).map(row => ({ ...row, live: replay.isLive(row, now) }));
}
// One session: all of it, or with ?after=<n> only the events after the first n (a live view polls this with the cursor it was given).
async function readSession(req: Request, dir: string, scope: string, session: string, now: number): Promise<Response> {
  const raw = new URL(req.url).searchParams.get('after');
  if (raw === null) { const found = await replay.readReplay(dir, scope, session); return found ? json(found) : json({ kind: 'not_found' }, 404); }
  const after = /^\d{1,9}$/.test(raw) ? Number(raw) : -1;
  if (after < 0) throw new Invalid('after must be a whole number of events');
  const found = await replay.readReplayAfter(dir, scope, session, after, now);
  return found ? json(found) : json({ kind: 'not_found' }, 404);
}
// Session replays, for the owner. A link's recordings sit under its artifact; the owner's own inbox sessions have their own list and a setting that is off until switched on.
async function replayRoute(req: Request, dir: string, path: string, read: (req: Request) => Promise<ObjectData>, now: number): Promise<Response | null> {
  const mine = path.match(/^\/__feedback\/api\/artifacts\/(a[0-9a-f]{12})\/(replays|heatmap)(?:\/([A-Za-z0-9_-]+))?$/);
  if (mine) {
    const [, id, what, session] = mine;
    if (what === 'heatmap' && !session && req.method === 'GET') {
      const v = new URL(req.url).searchParams.get('version');
      const version = v === null || v === '' ? null : Number(v);
      if (version !== null && (!Number.isInteger(version) || version < 1)) throw new Invalid('Invalid version');
      return json(await replay.heatmap(dir, id!, version));
    }
    if (what !== 'replays') return null;
    if (!session && req.method === 'GET') return json(await listWithLive(dir, id!, now));
    if (session && req.method === 'GET') return await readSession(req, dir, id!, session, now);
    if (session && req.method === 'DELETE') return await replay.deleteReplay(dir, id!, session) ? json({ deleted: true }) : json({ kind: 'not_found' }, 404);
    return null;
  }
  if (path === `${PREFIX}/api/replay-settings`) {
    if (req.method === 'GET') return json({ record_inbox: await replay.readInboxSetting(dir) });
    if (req.method !== 'POST') return null;
    const data = await read(req);
    if (typeof data.record_inbox !== 'boolean') throw new Invalid('record_inbox must be true or false');
    return json({ record_inbox: await replay.setInboxSetting(dir, data.record_inbox) });
  }
  const own = path.match(/^\/__feedback\/api\/replays(?:\/([A-Za-z0-9_-]+))?$/);
  if (!own) return null;
  const session = own[1];
  if (!session && req.method === 'GET') return json(await listWithLive(dir, replay.INBOX_SCOPE, now));
  if (!session && req.method === 'POST') {
    if (!(await replay.readInboxSetting(dir))) return json({ kind: 'recording_off' }, 403);
    const data = await read(req);
    return json({ ok: true, ...(await replay.appendChunk(dir, { scope: replay.INBOX_SCOPE, link: null, version: null }, { session: data.session, seq: data.seq, events: data.events }, now)) });
  }
  if (session && req.method === 'GET') return await readSession(req, dir, replay.INBOX_SCOPE, session, now);
  if (session && req.method === 'DELETE') return await replay.deleteReplay(dir, replay.INBOX_SCOPE, session) ? json({ deleted: true }) : json({ kind: 'not_found' }, 404);
  return null;
}
async function threadRoute(req: Request, dir: string, path: string, read: (req: Request) => Promise<ObjectData>, areas: AreasConfig, options: HandlerOptions): Promise<Response | null> {
  const base = `${PREFIX}/api/threads`;
  const vaultDir = options.vaultDir !== undefined ? options.vaultDir : loadVaultDir();
  const secretTarget = options.secretTarget !== undefined ? options.secretTarget : loadSecretTarget();
  // What the inbox needs to know about this server. The key box is only drawn when a target is set; the Redact action only when a vault is. `version` is this package.
  if (path === `${PREFIX}/api/config` && req.method === 'GET') return json({ secret_target: secretTarget, redact: !!vaultDir, version: packageVersion() });
  // When the user was last here and when each agent last acted: timestamps only.
  if (path === `${PREFIX}/api/presence` && req.method === 'GET') return json(await store.readPresence(dir));
  const sensitive = path.match(/^\/__feedback\/api\/threads\/([^/]+)\/messages\/([^/]+)\/(redact|secret)$/);
  if (sensitive && req.method === 'POST') {
    const [, tid, mid, what] = sensitive;
    await itemDir(dir, tid!);
    const data = await read(req); // JSON only (a cross-site form cannot send it), like every other write
    // The key itself never comes here: only that it was saved, and the target's short hint. A request with anything else is refused.
    if (what === 'secret') return json(await recordSecretSaved(dir, tid!, mid!, data));
    return json(await redactMessage(dir, tid!, mid!, { by: 'user', vault: vaultDir }));
  }
  if (path === base && req.method === 'GET') return json(await store.listThreads(dir, new URL(req.url).searchParams.get('q') ?? undefined));
  if (path === `${PREFIX}/api/metrics` && req.method === 'GET') return json(await computeMetrics(dir, checkWindow(new URL(req.url).searchParams.get('window') ?? '7d'), new Date(), areas));
  if (path === `${PREFIX}/api/areas` && req.method === 'GET') return json(areas); // the one source of truth for how the inbox and the metrics group threads
  const profile = await profileRoute(req, dir, path, read);
  if (profile) return profile;
  if (path === `${PREFIX}/api/tracker` && req.method === 'GET') {
    const q = new URL(req.url).searchParams;
    return json(await store.readTracker(dir, { thread: q.get('thread') ?? undefined, state: q.get('state') ?? undefined, q: q.get('q') ?? undefined }));
  }
  const pins = await pinsRoute(req, dir, path, read);
  if (pins) return pins;
  const checklist = await checklistRoute(req, dir, path, read);
  if (checklist) return checklist;
  const remind = await remindersRoute(req, dir, path, read);
  if (remind) return remind;
  if (path === base && req.method === 'POST') {
    const data = await read(req);
    return json(await store.createThread(dir, { title: data.title, text: data.text, images: store.dataUrlImages(data.images), attachments: data.attachments, origin: 'user' }), 201);
  }
  const downloaded = await attachmentRoute(req, dir, path);
  if (downloaded) return downloaded;
  const match = path.match(/^\/__feedback\/api\/threads\/([^/]+)(?:\/(messages|status|read|answer|merge|move-project))?$/);
  if (!match) return null;
  const [, id, action] = match;
  if (action === 'move-project') {
    if (req.method !== 'POST') return null;
    const projects = options.projects ?? [];
    if (projects.length < 2) throw new Invalid('Moving a thread needs more than one project (set FEEDBACK_PROJECTS)', 409);
    const data = await read(req);
    if (typeof data.project !== 'string' || !data.project.trim()) throw new Invalid('project is required');
    const from = projects.find(project => resolve(project.dir) === resolve(dir));
    if (!from) throw new Invalid('Not found', 404);
    const result = await moveThreadToProject({ projects, from: from.id, to: data.project.trim(), thread: id!, vault: vaultDir });
    return json({ moved: result.moved, id: result.id, project: result.to, from: result.from });
  }
  await itemDir(dir, id!);
  if (!action && req.method === 'GET') return json(await threadDetail(dir, id!));
  if (req.method !== 'POST') return null;
  if (action === 'messages') {
    const data = await read(req);
    // Pictures posted as the user (an artifact's capture, once confirmed) are limited per thread, so no page can fill the disk through the owner's session.
    if (Array.isArray(data.images) && data.images.length) {
      const bytes = data.images.reduce((sum: number, image) => sum + (typeof image === 'string' ? Math.floor(image.length * 3 / 4) : 0), 0);
      if (!userImageBytes.take(`${dir}|${id}`, bytes, options.now?.() ?? Date.now())) throw new Invalid('Too many pictures posted to this thread this minute. Try again shortly.', 429);
    }
    // `aside: true` is a side question; `todo` (a list of texts, `for`: "user" by default or "agent") adds checklist items with the message. Only the agent ticks (`check`), so the user's API refuses it.
    const add = Array.isArray(data.todo) ? data.todo.map(text => ({ owner: data.for ?? 'user', text })) : data.todo;
    const created = await store.appendMessage(dir, id!, { author: 'user', text: data.text, images: store.dataUrlImages(data.images), attachments: data.attachments, reply_to: data.reply_to, quote: data.quote, aside: data.aside, add_items: add, check_items: data.check, client_id: data.client_id, written_at: data.written_at });
    return json(created, store.wasDuplicate(created) ? 200 : 201); // 200: it had already arrived (a retry from the offline queue)
  }
  if (action === 'status') { const status = store.checkStatus((await read(req)).status); await store.setStatus(dir, id!, status); return json({ status }); }
  if (action === 'merge') return json(await store.mergeThreads(dir, id!, (await read(req)).into as string, 'user', options.files));
  if (action === 'answer') return json(await store.appendMessage(dir, id!, { author: 'user', text: undefined, answer: await read(req) }), 201);
  if (action === 'read') {
    const data = await read(req); // JSON only, like the other writes: a sandboxed page cannot mark a thread read with a form post
    await store.markRead(dir, id!, data.seen);
    return json({ ok: true });
  }
  return null;
}
// A share link by its token, looked for in every project. Null is the one miss.
async function findShare(folders: string[], token: string, now: number) {
  for (const folder of folders) {
    const share = await shares.activeShare(folder, token, now);
    if (share) return { folder, share };
  }
  return null;
}
async function viewerFeedback(req: Request, found: { folder: string; share: shares.Share }, caller: string, limits: ShareLimits, now: number): Promise<Response> {
  const { folder, share } = found;
  if (!limits.feedbackCaller.take(caller, now) || !limits.feedbackLink.take(share.id, now)) return shareJson({ kind: 'rate_limited', detail: 'Too many notes just now. Try again in a minute.' }, 429);
  try {
    const withImage = new URL(req.url).searchParams.get('image') === '1';
    const data = await viewerBody(req, withImage ? MAX_IMAGE_BODY : MAX_NOTE_BODY);
    const text = typeof data.note === 'string' ? store.stripControls(data.note).trim() : '';
    if (!text || text.length > store.MAX_VIEWER_NOTE) throw new Invalid(`Note must be 1–${store.MAX_VIEWER_NOTE} characters`);
    const meta = await artifacts.readArtifact(folder, share.artifact);
    if (!meta) return shareMiss();
    const quote = data.quote === undefined ? undefined : store.parseQuote(data.quote);
    // The picture is checked before anything is stored, and counted against the link's daily bytes once it is known to be a real image.
    const image = data.image === undefined || data.image === null ? undefined : store.viewerImage(data.image);
    if (image && !limits.feedbackImages.take(share.id, image.bytes.length, now)) return shareJson({ kind: 'rate_limited', detail: 'Too many screenshots today for this link. Send the note without one.' }, 429);
    try { await store.appendViewerFeedback(folder, meta.thread, { text, shareId: share.id, artifactId: meta.id, label: shares.shareLabel(share, meta.title), ...(quote ? { quote } : {}), ...(image ? { image } : {}) }); }
    catch (error) { if (image) limits.feedbackImages.release(share.id, image.bytes.length); throw error; } // a failed write does not use up the day's bytes
    await shares.countFeedback(folder, share.id);
    return shareJson({ ok: true }, 201);
  } catch (error) {
    if (error instanceof Invalid) return error.status === 404 ? shareMiss() : shareJson({ kind: 'invalid_request', detail: error.message }, error.status);
    throw error;
  }
}
async function viewerReplay(req: Request, found: { folder: string; share: shares.Share }, caller: string, limits: ShareLimits, now: number): Promise<Response> {
  const { folder, share } = found;
  if (!limits.replayChunks.take(`${share.id}|${caller}`, now)) return shareJson({ kind: 'rate_limited' }, 429);
  try {
    const data = await viewerBody(req, MAX_REPLAY_BODY);
    // A viewer who chose "Don't record" asks for this visit's session to be deleted. That works even if the owner has since switched recording off.
    if (data.discard === true) {
      const meta = await artifacts.readArtifact(folder, share.artifact);
      if (!meta) return shareMiss();
      return shareJson({ ok: true, discarded: await replay.discardSession(folder, { scope: meta.id, link: share.id, version: null }, data.session) }, 200);
    }
    // Recording is the owner's switch. A link that does not record takes nothing.
    if (share.record !== true) return shareJson({ kind: 'recording_off' }, 403);
    if (data.seq === 0 && !limits.replaySessions.take(share.id, now)) return shareJson({ kind: 'rate_limited' }, 429);
    const meta = await artifacts.readArtifact(folder, share.artifact);
    if (!meta) return shareMiss();
    const version = share.version === 'latest' ? meta.latest : share.version;
    const done = await replay.appendChunk(folder, { scope: meta.id, link: share.id, version }, { session: data.session, seq: data.seq, events: data.events }, now);
    return shareJson({ ok: true, seq: done.seq }, 200);
  } catch (error) {
    if (error instanceof Invalid) return error.status === 404 ? shareMiss() : shareJson({ kind: 'invalid_request', detail: error.message }, error.status);
    throw error;
  }
}
export function createHandler(directory: string, areas: AreasConfig = DEFAULT_AREAS, options: HandlerOptions = {}) {
  const dir = resolve(directory);
  const limits = newLimits();
  return async (req: Request, server?: ServerLike): Promise<Response> => {
    try {
      const path = new URL(req.url).pathname;
      const now = options.now?.() ?? Date.now();
      // A share link is not the inbox. It looks in every project, and a miss is the same 404 however it failed. Nothing about the request is logged.
      const shared = path.match(/^\/__feedback\/s\/([^/]+)$/);
      if (shared && req.method === 'GET') {
        let token = shared[1]!;
        try { token = decodeURIComponent(token); } catch { return shareMiss(); }
        const folders = options.projects?.length ? options.projects.map(project => project.dir) : [dir];
        for (const folder of folders) {
          const opened = await shares.openShareDetail(folder, token, now);
          if (opened !== null) return shareHit(await shellPage({ html: opened.html, title: opened.title, record: opened.share.record === true }));
        }
        return shareMiss();
      }
      // The two things a viewer can send: a note, and (only when the owner switched it on) the recording. POST only; there is no read path.
      const sharedSend = path.match(/^\/__feedback\/s\/([^/]+)\/(feedback|replay)$/);
      if (sharedSend) {
        let token = sharedSend[1]!;
        try { token = decodeURIComponent(token); } catch { return shareMiss(); }
        if (req.method !== 'POST') return shareMiss();
        const found = await findShare(options.projects?.length ? options.projects.map(project => project.dir) : [dir], token, now);
        if (!found) return shareMiss();
        const caller = clientKey(req, server);
        return sharedSend[2] === 'feedback' ? await viewerFeedback(req, found, caller, limits, now) : await viewerReplay(req, found, caller, limits, now);
      }
      if (path === `${PREFIX}/api/projects` && req.method === 'GET') {
        await store.touchPresence(options.projects?.[0]?.dir ?? dir, 'user', now);
        return json({ projects: await projectList(options.projects ?? [], dir) });
      }
      const iconRoute = path.match(/^\/__feedback\/api\/projects\/([^/]+)\/icon$/);
      if (iconRoute && req.method === 'GET') {
        // Only the file named for that project in FEEDBACK_PROJECTS is ever read; the path is never sent anywhere.
        let id = iconRoute[1]!;
        try { id = decodeURIComponent(id); } catch { /* an undecodable id matches nothing */ }
        const icon = options.projects?.find(project => project.id === id);
        const found = icon ? readProjectIcon(icon) : null;
        if (!found) return new Response('Not found\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
        return new Response(found.bytes, { headers: { 'Content-Type': found.type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
      }
      const dataDir = dataDirOf(req, dir, options.projects);
      const page = path.match(/^\/__feedback\/a\/(a[0-9a-f]{12})\/v(\d+)$/);
      if (page && req.method === 'GET') {
        try {
          // ?capture=1 is the inbox's own view of the page: the same page with the capture script added, so the owner can send a screenshot of it. Without it the page is served as it was published.
          const html = await artifacts.artifactHtml(dataDir, page[1]!, Number(page[2]));
          return new Response(new URL(req.url).searchParams.get('capture') === '1' ? await withCapture(html) : html, { headers: { ...SANDBOX, 'Content-Type': 'text/html; charset=utf-8' } });
        } catch (error) { if (error instanceof Invalid && error.status === 404) return new Response('Not found\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } }); throw error; }
      }
      const extra = await options.extra?.(req, path); // pairing and paired devices (server/pair-routes.ts)
      if (extra) return extra;
      // The user is here when the inbox page loads, polls or sends: the widget's own captures (api/items) and the health check do not count.
      if (path === `${PREFIX}/inbox/` || /^\/__feedback\/api\/(threads|profile|pins|tracker|config|presence|metrics|areas|artifacts|shares|uploads)(\/|$)/.test(path)) await store.touchPresence(dataDir, 'user', now);
      if (req.method === 'GET' && path === `${PREFIX}/healthz`) return json({ status: 'ok' });
      if (path === `${PREFIX}/api/items` && req.method === 'POST') return await create(dataDir, await body(req));
      if (path === `${PREFIX}/api/items` && req.method === 'GET') return await list(dataDir);
      const match = path.match(/^\/__feedback\/api\/items\/([^/]+)\/([^/]+)$/);
      if (match) return await itemRoute(req, dataDir, match[1]!, match[2]!);
      const uploaded = await uploadsRoute(req, dataDir, path, body, options);
      if (uploaded) return uploaded;
      const threads = await threadRoute(req, dataDir, path, body, areas, options);
      if (threads) return threads;
      const published = await artifactRoute(req, dataDir, path, body, now);
      if (published) return published;
      const replays = await replayRoute(req, dataDir, path, body, now);
      if (replays) return replays;
      const embed = await embedRoute(req, path);
      if (embed) return embed;
      const replayAsset = await replayAssetRoute(req, path);
      if (replayAsset) return replayAsset;
      const inbox = await inboxRoute(req, path);
      if (inbox) return inbox;
      return json({ kind: 'not_found' }, 404);
    } catch (error) {
      if (error instanceof Invalid) return json({ kind: 'invalid_request', detail: error.message }, error.status);
      console.error('Feedback storage error', error);
      return json({ kind: 'storage_error' }, 500);
    }
  };
}
export const handle = createHandler(process.env.FEEDBACK_DIR ?? resolve(process.cwd(), 'feedback-data'));
// Reads FEEDBACK_AREAS or FEEDBACK_AREAS_JSON here, so a bad config stops the server at startup with a clear message.
export function serverOptions(env: Record<string, string | undefined> = process.env) {
  const areas = loadAreas(env);
  const secretTarget = loadSecretTarget(env), vaultDir = loadVaultDir(env);
  loadReplayDays(env); // a bad FEEDBACK_REPLAY_DAYS stops the server at startup, like the other settings
  const configured = env.FEEDBACK_PROJECTS?.trim() ? checkIcons(loadProjects(env)) : null;
  const feedbackDir = configured?.[0]?.dir ?? env.FEEDBACK_DIR ?? resolve(process.cwd(), 'feedback-data');
  for (const folder of configured ? configured.map(project => project.dir) : [feedbackDir]) validateVault(folder, vaultDir);
  files.validateLimits(env);
  const fetch = createHandler(feedbackDir, areas, { secretTarget, vaultDir, ...(configured ? { projects: configured } : {}), files: { env }, extra: pairRoutes(pairingFor(feedbackDir), { host: env.FEEDBACK_HOST ?? null, allowedHosts: env.FEEDBACK_ALLOWED_HOSTS ?? '' }) });
  // Only the names we expect (see hosts.ts) reach the handler: a rebinding page cannot talk to the inbox under its own name. The remote listener has its own
  // Host check (remote.ts) and marks the requests it lets through.
  const guarded = async (req: Request, server?: ServerLike) => (hostAllowed(req, env) ? fetch(req, server) : hostRefusal());
  return { hostname: env.FEEDBACK_HOST ?? '127.0.0.1', port: Number(env.PORT ?? 8099), maxRequestBodySize: CHUNK_REQUEST, fetch: guarded };
}
// The data folders this server serves (one, or one per configured project).
export function dataDirs(env: Record<string, string | undefined> = process.env): string[] {
  return env.FEEDBACK_PROJECTS?.trim() ? loadProjects(env).map(project => project.dir) : [env.FEEDBACK_DIR ?? resolve(process.cwd(), 'feedback-data')];
}
// Partial uploads and finished ones no message took are removed after 24 hours: one sweep now, then every hour. Returns a function that stops it.
export function startUploadSweep(dirs: string[], everyMs = 3600e3): () => void {
  const sweep = () => { for (const folder of dirs) void files.cleanStale(folder).catch(() => undefined); };
  sweep();
  const timer = setInterval(sweep, everyMs); timer.unref();
  return () => clearInterval(timer);
}
if (import.meta.main) { startUploadSweep(dataDirs()); Bun.serve(serverOptions()); }
