import { readdir, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import * as store from './store';
import { computeMetrics, checkWindow } from './metrics';
import { loadAreas, loadSecretTarget, loadVaultDir } from './config';
import { redactMessage, recordSecretSaved, validateVault } from './sensitive';
import { DEFAULT_AREAS, type AreasConfig } from './inbox/areas.js';
import { Invalid, ID, MESSAGE_IMAGE, MIME, MAX_REQUEST, itemDir, optional } from './store';

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
    return new Response(await readFile(target), { headers: { 'Content-Type': file.endsWith('.md') ? 'text/markdown; charset=utf-8' : MIME[file.slice(file.lastIndexOf('.') + 1) as keyof typeof MIME], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return json({ kind: 'not_found' }, 404); throw error; }
}
const INBOX = resolve(import.meta.dir, 'inbox');
const INBOX_FILES: Record<string, string> = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'areas.js': 'text/javascript; charset=utf-8', 'quote.js': 'text/javascript; charset=utf-8', 'donut.js': 'text/javascript; charset=utf-8', 'aside.js': 'text/javascript; charset=utf-8', 'tracker.js': 'text/javascript; charset=utf-8', 'markdown.js': 'text/javascript; charset=utf-8', 'secret.js': 'text/javascript; charset=utf-8', 'outbox.js': 'text/javascript; charset=utf-8', 'sw.js': 'text/javascript; charset=utf-8' };
// The drop-in widget bundle (built to dist/embed.js), served so any page can load it from the feedback server itself.
const EMBED = resolve(import.meta.dir, '../dist/embed.js');
async function embedRoute(req: Request, path: string): Promise<Response | null> {
  if (path !== `${PREFIX}/embed.js` || (req.method !== 'GET' && req.method !== 'HEAD')) return null;
  try {
    return new Response(await readFile(EMBED), { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return json({ kind: 'not_found', detail: 'dist/embed.js is not built' }, 404); throw error; }
}
// FEEDBACK_INBOX_WIDGET=0 (or off, false, no) leaves the capture widget off the inbox page itself.
const WIDGET_TAG = /<script src="\.\.\/embed\.js"[^>]*><\/script>\n?/;
const foldFyiOn = () => /^(1|on|true|yes)$/i.test(process.env.FEEDBACK_FOLD_FYI?.trim() ?? '');
const inboxWidgetOn = () => !/^(0|off|false|no)$/i.test(process.env.FEEDBACK_INBOX_WIDGET?.trim() ?? '');
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
  return { ...summary, url: typeof context.url === 'string' ? context.url : null, viewport: context.viewport ?? null, target: item.target ?? null,
    note: typeof item.note === 'string' ? item.note : '', checklist_items: await store.listChecklist(dir, id), files: { image: await has('image.png'), annotated: await has('annotated.png'), context: await has('context.png') }, messages };
}
async function profileRoute(req: Request, dir: string, path: string, read: (req: Request) => Promise<ObjectData>): Promise<Response | null> {
  const base = `${PREFIX}/api/profile`;
  if (path === base && req.method === 'GET') return json(await store.readProfile(dir));
  if (path === base && req.method === 'POST') { const data = await read(req); return json(await store.updateProfile(dir, { name: data.name, avatar: data.avatar })); }
  const match = path.match(/^\/__feedback\/api\/profile\/avatar\/(user|agent)$/);
  if (!match || req.method !== 'GET') return null;
  const found = await store.avatarBytes(dir, match[1]!);
  if (!found) return json({ kind: 'not_found' }, 404);
  return new Response(found.bytes, { headers: { 'Content-Type': MIME[found.ext], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
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
async function pinsRoute(req: Request, dir: string, path: string, read: (req: Request) => Promise<ObjectData>): Promise<Response | null> {
  if (path !== `${PREFIX}/api/pins`) return null;
  if (req.method === 'GET') return json(await store.readPins(dir));
  if (req.method !== 'POST') return null;
  const data = await read(req);
  return json(await store.setPin(dir, { kind: data.kind, id: data.id, pinned: data.pinned }));
}
export interface HandlerOptions { secretTarget?: string | null; vaultDir?: string | null }
async function threadRoute(req: Request, dir: string, path: string, read: (req: Request) => Promise<ObjectData>, areas: AreasConfig, options: HandlerOptions): Promise<Response | null> {
  const base = `${PREFIX}/api/threads`;
  const vaultDir = options.vaultDir !== undefined ? options.vaultDir : loadVaultDir();
  const secretTarget = options.secretTarget !== undefined ? options.secretTarget : loadSecretTarget();
  // What the inbox needs to know about this server. The key box is only drawn when a target is set; the Redact action only when a vault is.
  if (path === `${PREFIX}/api/config` && req.method === 'GET') return json({ secret_target: secretTarget, redact: !!vaultDir });
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
  if (path === base && req.method === 'POST') {
    const data = await read(req);
    return json(await store.createThread(dir, { title: data.title, text: data.text, images: store.dataUrlImages(data.images), origin: 'user' }), 201);
  }
  const match = path.match(/^\/__feedback\/api\/threads\/([^/]+)(?:\/(messages|status|read|answer|merge))?$/);
  if (!match) return null;
  const [, id, action] = match;
  await itemDir(dir, id!);
  if (!action && req.method === 'GET') return json(await threadDetail(dir, id!));
  if (req.method !== 'POST') return null;
  if (action === 'messages') {
    const data = await read(req);
    // `aside: true` is a side question; `todo` (a list of texts, `for`: "user" by default or "agent") adds checklist items with the message. Only the agent ticks (`check`), so the user's API refuses it.
    const add = Array.isArray(data.todo) ? data.todo.map(text => ({ owner: data.for ?? 'user', text })) : data.todo;
    const created = await store.appendMessage(dir, id!, { author: 'user', text: data.text, images: store.dataUrlImages(data.images), reply_to: data.reply_to, aside: data.aside, add_items: add, check_items: data.check, client_id: data.client_id, written_at: data.written_at });
    return json(created, store.wasDuplicate(created) ? 200 : 201); // 200: it had already arrived (a retry from the offline queue)
  }
  if (action === 'status') { const status = store.checkStatus((await read(req)).status); await store.setStatus(dir, id!, status); return json({ status }); }
  if (action === 'merge') return json(await store.mergeThreads(dir, id!, (await read(req)).into as string, 'user'));
  if (action === 'answer') return json(await store.appendMessage(dir, id!, { author: 'user', text: undefined, answer: await read(req) }), 201);
  if (action === 'read') {
    const data = req.headers.get('content-type') ? await read(req) : {};
    await store.markRead(dir, id!, data.seen);
    return json({ ok: true });
  }
  return null;
}
export function createHandler(directory: string, areas: AreasConfig = DEFAULT_AREAS, options: HandlerOptions = {}) {
  const dir = resolve(directory);
  return async (req: Request): Promise<Response> => {
    try {
      const path = new URL(req.url).pathname;
      if (req.method === 'GET' && path === `${PREFIX}/healthz`) return json({ status: 'ok' });
      if (path === `${PREFIX}/api/items` && req.method === 'POST') return await create(dir, await body(req));
      if (path === `${PREFIX}/api/items` && req.method === 'GET') return await list(dir);
      const match = path.match(/^\/__feedback\/api\/items\/([^/]+)\/([^/]+)$/);
      if (match) return await itemRoute(req, dir, match[1]!, match[2]!);
      const threads = await threadRoute(req, dir, path, body, areas, options);
      if (threads) return threads;
      const embed = await embedRoute(req, path);
      if (embed) return embed;
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
  const feedbackDir = env.FEEDBACK_DIR ?? resolve(process.cwd(), 'feedback-data');
  validateVault(feedbackDir, vaultDir);
  const fetch = createHandler(feedbackDir, areas, { secretTarget, vaultDir });
  return { hostname: env.FEEDBACK_HOST ?? '127.0.0.1', port: Number(env.PORT ?? 8099), maxRequestBodySize: LIMIT, fetch };
}
if (import.meta.main) Bun.serve(serverOptions());
