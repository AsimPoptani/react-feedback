// The on-disk thread format, shared by the HTTP server and the agent CLI.
// Each item folder holds `thread.jsonl` (append-only messages) and `msg-<n>.<ext>` images.
import { appendFile, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { KEY } from './inbox/areas.js';
import { asideGroups, isAside, isAsideRoot, mainMessages } from './inbox/aside.js';
import { filterRows, groupRows } from './inbox/tracker.js';

export const ID = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
export const STATUSES = ['open', 'done'] as const;
// Old stored values: both `new` and `seen` meant open. `seen` stays an accepted alias for callers.
const LEGACY_OPEN = ['new', 'seen'];
export type Status = (typeof STATUSES)[number];
export type Author = 'user' | 'agent';
export const MAX_TEXT = 10000;
export const MAX_TITLE = 200;
export const MAX_IMAGES = 5;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_REQUEST = 25 * 1024 * 1024;
export const EXTENSIONS = ['png', 'jpg', 'webp'] as const;
export type Extension = (typeof EXTENSIONS)[number];
export const MESSAGE_IMAGE = /^msg-\d+\.(png|jpg|webp)$/;
export const MIME: Record<Extension, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

export class Invalid extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export interface QuestionOption { id: string; label: string; description?: string }
export interface QuestionWithdrawal { at: string; reason?: string }
export interface Question { id: string; prompt: string; options: QuestionOption[]; multi: boolean; allow_other: boolean; withdrawn?: QuestionWithdrawal; reasked?: true }
export interface Answer { question_id: string; option_ids: string[]; other_text?: string }
export const FLAGS = ['needs_you', 'done', 'fyi'] as const;
export type Flag = (typeof FLAGS)[number];
export const checkFlag = (value: unknown): Flag => {
  if (typeof value !== 'string' || !(FLAGS as readonly string[]).includes(value)) throw new Invalid('flag must be needs_you, done or fyi');
  return value as Flag;
};
// `reply_to` is the id of an earlier message in the same thread that this one quotes. It is only metadata: it changes nothing about who is waiting or what is unread.
export interface Message { id: string; author: Author; text: string; images: string[]; created_at: string; flag?: Flag; divider?: boolean; question?: Question; answer?: Answer; reply_to?: string;
  // A side question (`/btw`): `aside` marks it and its answers; an answer's `reply_to` is the aside's id. `added_items` and `ticked_items` are the checklist items this message added or ticked.
  aside?: true; added_items?: string[]; ticked_items?: string[];
  // `moved_to` (a thread id) marks the stub left where a message was moved away; `moved_from` (`<thread>/<message>`) marks a copy that arrived by a move, so an interrupted move can tell what it already did.
  moved_to?: string; moved_from?: string;
  // `kind: 'secret_request'` is the agent asking for a key: `secret` holds what to ask for and, once the user has saved it (straight to the app, never here), a non-secret `status` and `hint`.
  // `redacted` replaces a sensitive message's text and images, which live in the vault; `key` says which vault file.
  kind?: 'secret_request' | 'share_notice'; secret?: SecretRequest; redacted?: Redaction; share_id?: string; artifact_id?: string;
  // `client_id` is the id the inbox gave a message it may send more than once (an offline queue), so a retry never posts twice; `written_at` is when the user wrote it, if that was earlier than it was sent (`created_at` stays the time it arrived).
  client_id?: string; written_at?: string;
  // `agent_name`: which agent wrote an agent message, when it is not the default one (an MCP client's FEEDBACK_AGENT_NAME). Absent means the inbox's agent profile.
  agent_name?: string;
  // Set only on the object handed back when a post to a merged-away thread was written on the target instead. It is not stored.
  forwarded_to?: string }
export interface SecretRequest { name: string; label: string; help_url?: string; status?: 'saved'; hint?: string; saved_at?: string; check?: 'works' | 'rejected' }
export interface Redaction { at: string; by: Author; reason?: string; key: string }
export const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const MAX_HINT = 8;
export function checkHelpUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 500) throw new Invalid('help_url must be an https URL of up to 500 characters');
  let url: URL;
  try { url = new URL(value); } catch { throw new Invalid('help_url must be an https URL'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Invalid('help_url must be an https URL without a login');
  return url.href;
}
export function checkSecretRequest(input: unknown): SecretRequest {
  if (!isObject(input)) throw new Invalid('A secret request needs a name and a label');
  if (typeof input.name !== 'string' || !SECRET_NAME.test(input.name)) throw new Invalid('The key name must be 1–64 letters, digits, - or _, starting with a letter or digit');
  if (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 120) throw new Invalid('The key label must be 1–120 characters');
  const help_url = checkHelpUrl(input.help_url);
  return { name: input.name, label: input.label.trim(), ...(help_url ? { help_url } : {}) };
}
export interface Image { bytes: Buffer; ext: Extension }
export type ItemData = Record<string, unknown>;

const isObject = (value: unknown): value is ItemData => !!value && typeof value === 'object' && !Array.isArray(value);
const isStatus = (value: unknown): value is Status => typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;

export function sniff(bytes: Buffer): Extension | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}
export function checkedImage(bytes: Buffer): Image {
  if (bytes.length > MAX_IMAGE_BYTES) throw new Invalid('Image exceeds 10 MB', 413);
  const ext = sniff(bytes);
  if (!ext) throw new Invalid('Images must be PNG, JPEG or WebP');
  return { bytes, ext };
}
const DATA_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const DECLARED: Record<string, Extension> = { png: 'png', jpeg: 'jpg', webp: 'webp' };
export function dataUrlImage(value: unknown): Image {
  const match = typeof value === 'string' ? DATA_URL.exec(value) : null;
  if (!match) throw new Invalid('Expected a PNG, JPEG or WebP data URL');
  const image = checkedImage(Buffer.from(match[2]!, 'base64'));
  if (image.ext !== DECLARED[match[1]!]) throw new Invalid('Image does not match its declared type');
  return image;
}
export function dataUrlImages(value: unknown): Image[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_IMAGES) throw new Invalid(`At most ${MAX_IMAGES} images per message`);
  return value.map(dataUrlImage);
}
export function messageText(value: unknown, hasImages: boolean): string {
  if (value == null && hasImages) return '';
  if (typeof value !== 'string' || value.length > MAX_TEXT || (!value.trim() && !hasImages)) throw new Invalid('Text must be 1–10000 characters');
  return value;
}
export function threadTitle(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TITLE) throw new Invalid('Title must be 1–200 characters');
  return value.trim();
}
export function checkStatus(value: unknown): Status {
  if (typeof value === 'string' && LEGACY_OPEN.includes(value)) return 'open';
  if (!isStatus(value)) throw new Invalid('Invalid status');
  return value;
}
export const normaliseStatus = (value: unknown): Status | null => { try { return checkStatus(value); } catch { return null; } };

export async function optional(path: string): Promise<string | null> {
  try { if (!(await lstat(path)).isFile()) return null; return await readFile(path, 'utf8'); }
  catch (error) { if (code(error) === 'ENOENT') return null; throw error; }
}
export async function itemDir(dir: string, id: string): Promise<string> {
  if (!ID.test(id)) throw new Invalid('Invalid id', 404);
  const path = join(dir, id);
  try { if (!(await lstat(path)).isDirectory()) throw new Invalid('Not found', 404); }
  catch (error) { if (code(error) === 'ENOENT') throw new Invalid('Not found', 404); throw error; }
  return path;
}
export function newId(now = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{6})$/, '$1-$2');
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}
// feedback.md of a capture: the note first, then the mode, target and context. Rebuilt when a redaction blanks the note.
export function captureSummary(item: ItemData): string {
  const context = item.context as ItemData;
  const target = item.target as ItemData | undefined;
  const lines = [String(item.note), '', `Mode: ${item.mode}`];
  if (target?.selector) lines.push(`Selector: \`${target.selector}\``, `Components: ${Array.isArray(target.components) ? target.components.join(' < ') : ''}`);
  if (target?.rect) lines.push(`Rect: ${JSON.stringify(target.rect)}`);
  if (item.mode === 'page' && target) lines.push(`Page size: ${target.width} × ${target.height}`);
  lines.push(`URL: ${context.url ?? ''}`, `Viewport: ${JSON.stringify(context.viewport)}`, '');
  const logs = context.console;
  if (Array.isArray(logs) && logs.length) lines.push('Console:', ...logs.map(log => `- ${log.level}: ${log.message}`), '');
  const fetches = context.failedFetches;
  if (Array.isArray(fetches) && fetches.length) lines.push('Failed fetches:', ...fetches.map(request => `- ${request.method} ${request.url}: ${request.status ?? request.error}`), '');
  for (const key of ['image', 'annotated', 'context_image']) if (item[key]) lines.push(`[${key}](${item[key]})`);
  return `${lines.join('\n')}\n`;
}
export async function makeItemFolder(dir: string): Promise<{ id: string; path: string; created_at: string }> {
  await mkdir(dir, { recursive: true });
  const now = new Date();
  const id = newId(now);
  const path = join(dir, id);
  await mkdir(path); // exclusive: never overwrite an existing item
  return { id, path, created_at: now.toISOString() };
}
export async function readItem(path: string): Promise<ItemData> {
  const raw = await optional(join(path, 'item.json'));
  let item: unknown;
  try { item = raw === null ? null : JSON.parse(raw); } catch { item = null; }
  if (!isObject(item) || typeof item.created_at !== 'string' || typeof item.mode !== 'string') throw new Invalid('Not found', 404);
  return item;
}

export const MAX_OPTIONS = 9;
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
export const MAX_NAME = 40;
const str = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

// Questions are written by the agent only. Option ids are o1..on, assigned here.
export interface QuestionInput { prompt: unknown; options: { label: string; description?: string }[]; multi?: boolean; allow_other?: boolean }
export function buildQuestion(id: string, input: QuestionInput): Question {
  if (!str(input.prompt, 1000)) throw new Invalid('A question needs a prompt of 1–1000 characters');
  if (!Array.isArray(input.options) || input.options.length < 1 || input.options.length > MAX_OPTIONS) throw new Invalid(`A question needs 1–${MAX_OPTIONS} options`);
  const options = input.options.map((o, i) => {
    if (!o || !str(o.label, 100) || (o.description !== undefined && (typeof o.description !== 'string' || o.description.length > 300))) throw new Invalid('Option labels are 1–100 characters and descriptions up to 300');
    return { id: `o${i + 1}`, label: o.label.trim(), ...(o.description?.trim() ? { description: o.description.trim() } : {}) };
  });
  return { id, prompt: (input.prompt as string).trim(), options, multi: input.multi === true, allow_other: input.allow_other !== false };
}
function parseQuestion(q: unknown): Question | undefined {
  if (!isObject(q) || typeof q.id !== 'string' || typeof q.prompt !== 'string' || !Array.isArray(q.options)) return undefined;
  const options = q.options.filter((o): o is QuestionOption => isObject(o) && typeof o.id === 'string' && typeof o.label === 'string')
    .map(o => ({ id: o.id, label: o.label, ...(typeof o.description === 'string' ? { description: o.description } : {}) }));
  const withdrawn = isObject(q.withdrawn) && typeof q.withdrawn.at === 'string'
    ? { at: q.withdrawn.at, ...(typeof q.withdrawn.reason === 'string' && q.withdrawn.reason ? { reason: q.withdrawn.reason.slice(0, 200) } : {}) } : undefined;
  return { id: q.id, prompt: q.prompt, options, multi: q.multi === true, allow_other: q.allow_other !== false, ...(withdrawn ? { withdrawn } : {}), ...(q.reasked === true ? { reasked: true as const } : {}) };
}
// A question still waiting on the person: not withdrawn, not replaced by a re-ask.
const questionLive = (q: Question | undefined): q is Question => !!q && !q.withdrawn && !q.reasked;
// The answer line in `read` and in `_events.jsonl`: the question id, a short prompt, and the choice.
export function answerLine(qid: string, prompt: string, labels: string[]): string {
  const flat = prompt.trim().replace(/\s+/g, ' ');
  const short = flat.length > 40 ? `${flat.slice(0, 39)}…` : flat;
  return `${qid} (${short}): ${labels.join(', ')}`;
}
function parseAnswer(a: unknown): Answer | undefined {
  if (!isObject(a) || typeof a.question_id !== 'string' || !Array.isArray(a.option_ids)) return undefined;
  return { question_id: a.question_id, option_ids: a.option_ids.filter((x): x is string => typeof x === 'string'), ...(typeof a.other_text === 'string' ? { other_text: a.other_text } : {}) };
}
export function openQuestions(messages: Message[]): Question[] {
  const answered = new Set(messages.flatMap(m => (m.answer ? [m.answer.question_id] : [])));
  return messages.flatMap(m => (m.author === 'agent' && questionLive(m.question) && !answered.has(m.question.id) ? [m.question] : []));
}
// Checks an answer against the thread's open questions; returns the readable text.
export function checkAnswer(messages: Message[], raw: unknown): { answer: Answer; text: string; labels: string[] } {
  if (!isObject(raw) || typeof raw.question_id !== 'string') throw new Invalid('Answer needs a question_id');
  const asked = messages.find(m => m.author === 'agent' && m.question?.id === raw.question_id)?.question;
  if (!asked) throw new Invalid('No such question', 404);
  if (asked.withdrawn) throw new Invalid('That question was withdrawn', 409);
  if (asked.reasked) throw new Invalid('That question was re-asked', 409);
  if (!openQuestions(messages).some(q => q.id === asked.id)) throw new Invalid('That question is already answered', 409);
  const ids = raw.option_ids ?? [];
  if (!Array.isArray(ids) || ids.some(i => typeof i !== 'string') || new Set(ids).size !== ids.length) throw new Invalid('option_ids must be a list of distinct ids');
  const chosen = (ids as string[]).map(i => asked.options.find(o => o.id === i) ?? null);
  if (chosen.some(o => !o)) throw new Invalid('Unknown option');
  if (!asked.multi && ids.length > 1) throw new Invalid('Only one option can be chosen');
  const other = raw.other_text == null ? undefined : raw.other_text;
  if (other !== undefined && (typeof other !== 'string' || other.length > 1000 || (other.trim() === '' && ids.length === 0))) throw new Invalid('Other text must be 1–1000 characters');
  if (typeof other === 'string' && other.trim() && !asked.allow_other) throw new Invalid('This question does not take another answer');
  const otherText = typeof other === 'string' && other.trim() ? other.trim() : undefined;
  if (!ids.length && !otherText) throw new Invalid('Choose an option or write an answer');
  const labels = (chosen as QuestionOption[]).map(o => o.label);
  const text = `Chose: ${[...labels, ...(otherText ? [`Other: ${otherText}`] : [])].join(', ')}`;
  return { answer: { question_id: asked.id, option_ids: ids as string[], ...(otherText ? { other_text: otherText } : {}) }, text, labels: [...labels, ...(otherText ? [otherText] : [])] };
}

function parseSecret(m: ItemData): SecretRequest | undefined {
  const s = m.secret;
  if (m.kind !== 'secret_request' || !isObject(s) || typeof s.name !== 'string' || !SECRET_NAME.test(s.name) || typeof s.label !== 'string') return undefined;
  return { name: s.name, label: s.label, ...(typeof s.help_url === 'string' && /^https:\/\//.test(s.help_url) ? { help_url: s.help_url } : {}),
    ...(s.status === 'saved' ? { status: 'saved' as const, ...(typeof s.hint === 'string' && s.hint.length <= MAX_HINT ? { hint: s.hint } : {}), ...(typeof s.saved_at === 'string' ? { saved_at: s.saved_at } : {}), ...(s.check === 'works' || s.check === 'rejected' ? { check: s.check } : {}) } : {}) };
}
function parseRedaction(r: unknown): Redaction | undefined {
  if (!isObject(r) || typeof r.at !== 'string' || (r.by !== 'user' && r.by !== 'agent') || typeof r.key !== 'string') return undefined;
  return { at: r.at, by: r.by, key: r.key, ...(typeof r.reason === 'string' && r.reason ? { reason: r.reason.slice(0, 200) } : {}) };
}
const ids = (v: unknown): string[] | undefined => { const out = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && /^c\d+$/.test(x)) : []; return out.length ? out : undefined; };
function parseMessages(raw: string | null): Message[] {
  const out: Message[] = [];
  for (const line of (raw ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (isObject(m) && typeof m.id === 'string' && (m.author === 'user' || m.author === 'agent') && typeof m.text === 'string'
        && typeof m.created_at === 'string' && Array.isArray(m.images)) {
        const question = m.author === 'agent' ? parseQuestion(m.question) : undefined;
        const answer = m.author === 'user' ? parseAnswer(m.answer) : undefined;
        const flag: Flag | undefined = m.author !== 'agent' || m.divider === true ? undefined : (FLAGS as readonly string[]).includes(m.flag as string) ? m.flag as Flag : question ? 'needs_you' : 'fyi';
        out.push({ id: m.id, author: m.author, text: m.text, images: m.images.filter((f): f is string => typeof f === 'string' && MESSAGE_IMAGE.test(f)), created_at: m.created_at,
          ...(flag ? { flag } : {}), ...(m.divider === true ? { divider: true } : {}), ...(question ? { question } : {}), ...(answer ? { answer } : {}),
          ...(typeof m.reply_to === 'string' && m.reply_to ? { reply_to: m.reply_to } : {}), ...(m.aside === true ? { aside: true as const } : {}),
          ...(typeof m.moved_to === 'string' && ID.test(m.moved_to) ? { moved_to: m.moved_to } : {}), ...(typeof m.moved_from === 'string' && m.moved_from ? { moved_from: m.moved_from } : {}),
          ...(ids(m.added_items) ? { added_items: ids(m.added_items)! } : {}), ...(ids(m.ticked_items) ? { ticked_items: ids(m.ticked_items)! } : {}),
          ...(typeof m.client_id === 'string' && CLIENT_ID.test(m.client_id) ? { client_id: m.client_id } : {}), ...(typeof m.written_at === 'string' && !Number.isNaN(Date.parse(m.written_at)) ? { written_at: m.written_at } : {}),
          ...(m.author === 'agent' && typeof m.agent_name === 'string' && m.agent_name.trim() && m.agent_name.length <= MAX_NAME ? { agent_name: m.agent_name } : {}),
          ...(parseSecret(m) ? { kind: 'secret_request' as const, secret: parseSecret(m)! } : {}),
          ...(m.kind === 'share_notice' && typeof m.share_id === 'string' ? { kind: 'share_notice' as const, share_id: m.share_id, ...(typeof m.artifact_id === 'string' ? { artifact_id: m.artifact_id } : {}) } : {}),
          ...(parseRedaction(m.redacted) ? { redacted: parseRedaction(m.redacted)! } : {}) });
      }
    } catch { /* a torn line must not hide the thread */ }
  }
  return out;
}
// Messages that exist only implicitly: the note of an old capture, and a legacy reply.md.
async function legacyMessages(path: string, item: ItemData, stored: Message[], hasThreadFile: boolean): Promise<Message[]> {
  const out: Message[] = [];
  const next = () => `m${stored.length + out.length + 1}`;
  if (!hasThreadFile && item.mode !== 'thread' && typeof item.note === 'string' && item.note.trim()) {
    out.push({ id: next(), author: 'user', text: item.note, images: [], created_at: item.created_at as string });
  }
  if (!stored.some(m => m.author === 'agent')) {
    const reply = await optional(join(path, 'reply.md'));
    if (reply !== null && reply.trim()) {
      const at = (await stat(join(path, 'reply.md'))).mtime.toISOString();
      out.push({ id: next(), author: 'agent', text: reply.trimEnd(), images: [], created_at: at, flag: 'fyi' });
    }
  }
  return out;
}
// File order is the conversation order: clocks on a VM and the host may disagree.
export async function readMessages(path: string, item: ItemData): Promise<Message[]> {
  const raw = await optional(join(path, 'thread.jsonl'));
  const stored = parseMessages(raw);
  return [...stored, ...await legacyMessages(path, item, stored, raw !== null)];
}
// Writes the implicit messages into thread.jsonl so a later agent message cannot hide them. Old files are not rewritten.
// The first write is exclusive (`wx`): if another writer created the file first, read it again instead of duplicating history.
export async function materialise(path: string, item: ItemData): Promise<Message[]> {
  const file = join(path, 'thread.jsonl');
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await optional(file);
    const stored = parseMessages(raw);
    const extra = await legacyMessages(path, item, stored, raw !== null);
    if (!extra.length) return stored;
    const text = extra.map(m => `${JSON.stringify(m)}\n`).join('');
    if (raw === null) {
      try { await writeFile(file, text, { flag: 'wx' }); return extra; }
      catch (error) { if (code(error) === 'EEXIST') continue; throw error; }
    }
    await appendFile(file, text);
    return [...stored, ...extra];
  }
  throw new Error('thread.jsonl kept changing under us');
}
// An exclusive lock file per thread, so concurrent appends (server and CLI) get distinct ids and image numbers.
export async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(path, '.lock');
  const giveUp = Date.now() + 15000; // later than the 10 s stale age, so a lock left by a crash is cleared first
  for (;;) {
    try { await writeFile(lock, String(process.pid), { flag: 'wx' }); break; }
    catch (error) {
      if (code(error) !== 'EEXIST') throw error;
      try { if (Date.now() - (await stat(lock)).mtimeMs > 10000) await rm(lock, { force: true }); } catch { /* released meanwhile */ }
      if (Date.now() > giveUp) throw new Error('Could not lock the thread');
      await new Promise(r => setTimeout(r, 5 + Math.random() * 10));
    }
  }
  try { return await fn(); } finally { await rm(lock, { force: true }); }
}
export async function saveImages(path: string, images: Image[]): Promise<string[]> {
  let highest = 0;
  for (const name of await readdir(path)) {
    const match = /^msg-(\d+)\./.exec(name);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  const names: string[] = [];
  for (const image of images) {
    const name = `msg-${++highest}.${image.ext}`;
    await writeFile(join(path, name), image.bytes, { flag: 'wx' });
    names.push(name);
  }
  return names;
}
export async function logEvent(dir: string, event: { id: string; kind: 'message' | 'thread' | 'answer' | 'checklist' | 'checklist_claim' | 'merge' | 'move' | 'secret' | 'reminder'; text: string; reply_to?: string; aside?: boolean; author?: Author | 'system'; set_by?: 'agent' | 'user' | 'default'; agent_name?: string }): Promise<void> {
  await mkdir(dir, { recursive: true });
  const first_line = event.text.split('\n')[0]!.slice(0, 200) || '[image]';
  await appendFile(join(dir, '_events.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), id: event.id, author: event.author ?? 'user', kind: event.kind, first_line, ...(event.set_by ? { set_by: event.set_by } : {}), ...(event.agent_name ? { agent_name: event.agent_name } : {}), ...(event.reply_to ? { reply_to: event.reply_to } : {}), ...(event.aside ? { aside: true } : {}) })}\n`);
}
async function writeStatus(path: string, status: Status) { await writeFile(join(path, 'status.json'), JSON.stringify({ status })); }
export async function readStatus(path: string): Promise<Status> {
  try {
    const parsed = JSON.parse(await optional(join(path, 'status.json')) ?? 'null');
    return (isObject(parsed) && normaliseStatus(parsed.status)) || 'open';
  } catch { return 'open'; }
}
export async function setStatus(dir: string, id: string, status: Status): Promise<void> {
  await writeStatus(await itemDir(dir, id), status);
}

// Read markers: `read.json` is the user's, `agent-read.json` the agent's. Each holds the time of the last message read.
// They only move forward.
async function stampRead(path: string, file: string, at: string): Promise<void> {
  const current = await readAt(path, file);
  if (current !== null && current >= at) return;
  await writeAtomic(join(path, file), JSON.stringify({ ...await readMarker(path, file), at })); // keeps `acked_through` in agent-read.json
}
async function readMarker(path: string, file: string): Promise<ItemData> {
  try { const v = JSON.parse(await optional(join(path, file)) ?? 'null'); return isObject(v) ? v : {}; } catch { return {}; }
}
async function readAt(path: string, file: string): Promise<string | null> {
  const v = await readMarker(path, file);
  return typeof v.at === 'string' ? v.at : null;
}
// The default agent's read marker is `agent-read.json`; an agent with its own name (an MCP client) has `agent-read-<name>-<hash>.json`, so each one reads on its own.
// Zero-width and bidi-control characters are removed: they make two different names look alike, or reverse how one reads.
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u00ad\u061c\u180e]/g;
const foldName = (name: string) => name.normalize('NFKC').replace(INVISIBLE, '').trim().toLowerCase();
const RESERVED_NAMES = ['you', 'user', 'system', 'me', 'admin'];
export function checkAgentName(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Invalid(`An agent name is 1–${MAX_NAME} characters with no control characters`);
  const name = value.replace(INVISIBLE, '').trim();
  if (!name || name.length > MAX_NAME || [...name].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new Invalid(`An agent name is 1–${MAX_NAME} characters with no control characters`);
  if (RESERVED_NAMES.includes(foldName(name))) throw new Invalid('That agent name is reserved: it could be mistaken for you or the system');
  return name;
}
// An agent may not take the name the user shows in the inbox either.
async function notTheUser(dir: string, name: string | undefined): Promise<void> {
  if (name && foldName(name) === foldName((await readProfile(dir)).user.name)) throw new Invalid('That agent name is the same as your own name in the inbox');
}
export const agentReadFile = (name?: string): string => (name ? `agent-read-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'agent'}-${createHash('sha1').update(name).digest('hex').slice(0, 6)}.json` : 'agent-read.json');
// When any agent last read the thread: the newest marker of them all (with only the default agent this is `agent-read.json`).
async function readAgentAt(path: string): Promise<string | null> {
  let best: string | null = await readAt(path, 'agent-read.json');
  try {
    for (const name of await readdir(path)) {
      if (!/^agent-read-[a-z0-9-]+\.json$/.test(name)) continue;
      const at = await readAt(path, name);
      if (at !== null && (best === null || at > best)) best = at;
    }
  } catch { /* an unreadable folder shows no read time */ }
  return best;
}
// The agent can acknowledge the user's latest message without replying: `acked_through` in agent-read.json is its time.
async function readAcked(path: string): Promise<string | null> {
  const v = await readMarker(path, 'agent-read.json');
  return typeof v.acked_through === 'string' ? v.acked_through : null;
}
// The newest time in the thread, not the last line's: a merge copies older messages after its divider, and the clock must not go back.
const lastAt = (messages: Message[], item: ItemData) => messages.reduce((hi, m) => (m.created_at > hi ? m.created_at : hi), item.created_at as string);

export const READ_ONLY_NOTE = 'This thread is read-only: it only carries updates from the agent, so you cannot reply here.';
// `aside`: a side question (user) or its answer (agent, with `reply_to` naming the aside). `add_items` and `check_items` ride on the message:
// new checklist items (`owner` says who has to do them) and ids of items the agent ticks.
export interface NewMessage { author: Author; text: unknown; images?: Image[]; question?: QuestionInput; answer?: unknown; flag?: unknown; reply_to?: unknown; aside?: unknown; add_items?: unknown; check_items?: unknown; secret?: unknown; client_id?: unknown; written_at?: unknown; agent_name?: unknown }
// A message that arrived again with the same client_id is the one already stored: it is returned, not written twice.
const duplicates = new WeakSet<Message>();
export const wasDuplicate = (m: Message) => duplicates.has(m);
// When the user wrote a message that waited in an offline queue: ignored when it is unreadable, in the future, or more than 30 days old.
function writtenAt(value: unknown, now = Date.now()): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = Date.parse(value);
  return !Number.isNaN(t) && t <= now + 5 * 60e3 && t >= now - 30 * 86400e3 ? new Date(t).toISOString() : undefined;
}
export interface ItemToAdd { owner: Author; text: string }
// A side question is a root (no quote); an answer is the agent's, quotes an aside root, and takes no flag but FYI. A main message cannot quote an aside.
function checkAside(stored: Message[], input: NewMessage): { aside: boolean; replyTo: unknown } {
  if (input.aside !== undefined && input.aside !== null && typeof input.aside !== 'boolean') throw new Invalid('aside must be true or false');
  const aside = input.aside === true;
  if (!aside) {
    const target = typeof input.reply_to === 'string' ? stored.find(m => m.id === input.reply_to) : undefined;
    if (target && isAside(target)) throw new Invalid('A message in the main thread cannot quote a side question');
    return { aside, replyTo: input.reply_to };
  }
  if (input.question || input.answer !== undefined) throw new Invalid('A side question cannot hold a question or an answer');
  if (input.author === 'user') {
    if (input.reply_to !== undefined && input.reply_to !== null) throw new Invalid('A side question cannot quote a message');
    return { aside, replyTo: undefined };
  }
  const root = typeof input.reply_to === 'string' ? stored.find(m => m.id === input.reply_to) : undefined;
  if (!root || !isAsideRoot(root)) throw new Invalid('An aside answer must name the side question it answers (reply_to)');
  if (input.flag !== undefined && input.flag !== 'fyi') throw new Invalid('A side answer cannot be flagged: it never changes the main thread');
  return { aside, replyTo: root.id };
}
// Validates what rides on a message before anything is written: text and owner of each new item, and that only the agent ticks.
function checkAttached(author: Author, input: NewMessage): { add: ItemToAdd[]; check: string[] } {
  const list = (v: unknown, what: string): unknown[] => { if (v === undefined || v === null) return []; if (!Array.isArray(v)) throw new Invalid(`${what} must be a list`); return v; };
  const add = list(input.add_items, 'todo').map(x => {
    const o = isObject(x) ? x : { owner: undefined, text: x };
    const owner = o.owner === undefined ? author : o.owner; // by default an item is on the author's own list
    if (!isAuthor(owner)) throw new Invalid('owner must be "user" or "agent"');
    return { owner, text: itemText(o.text) };
  });
  const check = list(input.check_items, 'check').map(x => { if (typeof x !== 'string' || !/^c\d+$/.test(x)) throw new Invalid('check takes checklist item ids like c3'); return x; });
  if (check.length && author !== 'agent') throw new Invalid('Only the agent can tick an item.', 403);
  return { add, check: [...new Set(check)] };
}
// A quote must name a message that already exists in this thread. Absent (or null) means a plain message.
export function checkReplyTo(messages: Message[], value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value) throw new Invalid('reply_to must be the id of a message in this thread');
  const target = messages.find(m => m.id === value);
  if (!target || target.divider === true) throw new Invalid('reply_to must be the id of a message in this thread');
  return value;
}
// Only the agent flags messages. A question is `needs_you` unless said otherwise; anything else is `fyi`.
function messageFlag(author: Author, flag: unknown, asking: boolean): Flag | undefined {
  if (author !== 'agent') { if (flag !== undefined) throw new Invalid('Only the agent can flag a message', 403); return undefined; }
  return flag === undefined ? (asking ? 'needs_you' : 'fyi') : checkFlag(flag);
}
// A `done` message closes the thread, unless the user still has open items of their own.
async function closeForDone(path: string): Promise<void> {
  if (!(await readChecklist(path)).some(i => i.owner === 'user' && !i.done)) await writeStatus(path, 'done');
}
// The line a post keeps when it arrives on a thread that had already been merged away.
function quoteSent(title: string, text: string): string {
  const line = `> Sent in ${title} after the merge`;
  return text ? `${line}\n\n${text}` : line;
}
interface Composed { message: Message; eventKind: 'message' | 'answer'; eventText: string; addedItems: ChecklistItem[] }
interface Prepared { flag: Flag | undefined; attached: { add: ItemToAdd[]; check: string[] }; agentName: string | undefined; sentIn?: string }
// Writes one message. The caller holds the thread lock. `sentIn` prefixes a post that was aimed at a thread already merged into this one.
async function compose(path: string, input: NewMessage, prep: Prepared): Promise<Composed> {
  const { flag, attached, agentName, sentIn } = prep;
  const images = input.images ?? [];
  const client_id = input.client_id as string | undefined, written = writtenAt(input.written_at);
  const item = await readItem(path);
  const stored = await materialise(path, item);
  if (client_id) { const again = stored.find(m => m.client_id === client_id && m.author === input.author); if (again) { duplicates.add(again); return { message: again, eventKind: 'message', eventText: '', addedItems: [] }; } }
  if (input.author === 'user' && item.read_only === true) throw new Invalid(READ_ONLY_NOTE, 409);
  if ((input.question || input.secret) && item.read_only === true) throw new Invalid('A read-only thread cannot hold a question or a key request: nobody could answer it', 409);
  const { aside, replyTo } = checkAside(stored, input);
  const quoted = checkReplyTo(stored, replyTo);
  const n = stored.length + 1;
  const secret = input.secret === undefined ? undefined : checkSecretRequest(input.secret);
  let text = input.answer !== undefined || input.question ? '' : secret ? messageText(input.text ?? `Please add ${secret.label}. Paste it in the secure box below; it goes straight to the app and is never saved in this thread.`, false) : messageText(input.text, images.length > 0);
  let extra: Partial<Message> = secret ? { kind: 'secret_request', secret } : {};
  let eventKind: 'message' | 'answer' = 'message';
  let eventText = '';
  if (input.question) { text = messageText(input.text ?? input.question.prompt, false); extra = { question: buildQuestion(`q${n}`, input.question) }; }
  if (input.answer !== undefined) {
    const checked = checkAnswer(stored, input.answer);
    text = checked.text; extra = { answer: checked.answer };
    const asked = stored.find(x => x.question?.id === checked.answer.question_id)?.question;
    eventKind = 'answer'; eventText = answerLine(checked.answer.question_id, asked?.prompt ?? '', checked.labels);
  }
  if (sentIn) text = quoteSent(sentIn, text);
  let added: ChecklistItem[] = [], ticked: string[] = [];
  if (attached.add.length || attached.check.length) {
    const items = await readChecklist(path);
    added = attached.add.map(a => pushItem(items, a.owner, a.text, input.author));
    ticked = attached.check.filter(c => tickItem(items, c));
    await writeAtomic(join(path, 'checklist.json'), JSON.stringify({ items }, null, 2));
  }
  const created: Message = { id: `m${n}`, author: input.author, text, images: await saveImages(path, images), created_at: new Date().toISOString(), ...(client_id ? { client_id } : {}), ...(written ? { written_at: written } : {}), ...(agentName && input.author === 'agent' ? { agent_name: agentName } : {}), ...(flag ? { flag } : {}), ...extra, ...(quoted ? { reply_to: quoted } : {}),
    ...(aside ? { aside: true as const } : {}), ...(added.length ? { added_items: added.map(i => i.id) } : {}), ...(ticked.length ? { ticked_items: ticked } : {}) };
  await appendFile(join(path, 'thread.jsonl'), `${JSON.stringify(created)}\n`);
  if (input.author === 'agent' || stored[stored.length - 1]?.author === 'agent') await stampRead(path, input.author === 'agent' ? agentReadFile(agentName) : 'read.json', lastAt(stored, item));
  if (flag === 'done') await closeForDone(path);
  if (input.author === 'user') await writeStatus(path, 'open');
  return { message: created, eventKind, eventText, addedItems: added };
}
async function recordSide(dir: string, id: string, author: Author, composed: Composed): Promise<void> {
  if (author !== 'user') return;
  const { message, eventKind, eventText, addedItems } = composed;
  await logEvent(dir, { id, kind: eventKind, text: eventKind === 'answer' ? eventText : message.text, ...(message.reply_to ? { reply_to: message.reply_to } : {}), ...(message.aside ? { aside: true } : {}) });
  for (const i of addedItems) await userEvent(dir, id, 'checklist', `add (${i.owner === 'user' ? 'for you' : 'for the agent'}): ${i.text}`);
}
// A post aimed at a thread that has already been merged is written on the target. An ask is refused: a new question has no id there.
function remapForward(input: NewMessage, map: MergeMap | null): NewMessage {
  const next: NewMessage = { ...input };
  if (typeof next.reply_to === 'string' && next.reply_to) {
    const mapped = map?.messages[next.reply_to];
    if (!mapped) throw new Invalid('That message was not copied into the merged thread');
    next.reply_to = mapped;
  }
  if (next.answer !== undefined && next.answer !== null && isObject(next.answer) && typeof next.answer.question_id === 'string') {
    const mapped = map?.questions[next.answer.question_id];
    if (!mapped) throw new Invalid('That question was not copied into the merged thread');
    next.answer = { ...next.answer, question_id: mapped };
  }
  if (Array.isArray(next.check_items) && map) next.check_items = next.check_items.map(id => (typeof id === 'string' && map.items[id]) || id);
  return next;
}
async function deliverForward(dir: string, fromId: string, input: NewMessage, prep: Prepared): Promise<Message> {
  const from = await itemDir(dir, fromId);
  const note = await readMerge(from);
  if (!note || note.state !== 'done') throw new Invalid('That merge did not finish; nothing was posted');
  if (input.question || input.secret !== undefined) throw new Invalid(`That thread was merged into ${note.into}; ask on that thread`);
  const intoId = note.into;
  const into = await itemDir(dir, intoId);
  if (await readMerge(into)) throw new Invalid('The target thread was itself merged into another one', 409);
  const fromItem = await readItem(from);
  if (input.author === 'user' && fromItem.read_only === true) throw new Invalid(READ_ONLY_NOTE, 409);
  const [first, second] = fromId < intoId ? [from, into] : [into, from];
  const composed = await withLock(first, () => withLock(second, async () => {
    const live = await readMerge(from);
    if (!live || live.state !== 'done' || live.into !== intoId) throw new Invalid('That merge did not finish; nothing was posted');
    const map = await resolvedMap(fromId, live, from, into);
    const forwarded = remapForward(input, map);
    const checks = prep.attached.check.map(id => map?.items[id] ?? id);
    return compose(into, forwarded, { ...prep, attached: { add: prep.attached.add, check: checks }, sentIn: titleOf(fromItem, fromId) });
  }));
  if (!wasDuplicate(composed.message)) await recordSide(dir, intoId, input.author, composed);
  composed.message.forwarded_to = intoId;
  return composed.message;
}
export async function appendMessage(dir: string, id: string, input: NewMessage): Promise<Message> {
  const path = await itemDir(dir, id);
  if (input.question && input.author !== 'agent') throw new Invalid('Only the agent can ask questions', 403);
  if (input.answer && input.author !== 'user') throw new Invalid('Only the user can answer', 403);
  if (input.secret !== undefined && input.author !== 'agent') throw new Invalid('Only the agent can ask for a key', 403);
  if (input.secret !== undefined && (input.question || input.answer !== undefined || input.aside || (input.images ?? []).length)) throw new Invalid('A key request is a message of its own: no question, side question or images');
  const secret = input.secret === undefined ? undefined : checkSecretRequest(input.secret);
  if (input.client_id !== undefined && (typeof input.client_id !== 'string' || !CLIENT_ID.test(input.client_id))) throw new Invalid('Invalid client_id');
  if (input.agent_name !== undefined && input.agent_name !== null && input.agent_name !== '' && input.author !== 'agent') throw new Invalid('Only the agent has an agent name', 403);
  const agentName = checkAgentName(input.agent_name);
  await notTheUser(dir, agentName);
  const prep: Prepared = { flag: messageFlag(input.author, input.flag, !!input.question || !!secret), attached: checkAttached(input.author, input), agentName };
  const noted = await readMerge(path);
  if (noted?.state === 'done') return deliverForward(dir, id, input, prep);
  const composed = await withLock(path, async () => {
    // A merge can finish while this post waits for the lock. Write it on the target, not beside the farewell.
    if ((await readMerge(path))?.state === 'done') return null;
    return compose(path, input, prep);
  });
  if (!composed) return deliverForward(dir, id, input, prep);
  if (!wasDuplicate(composed.message)) await recordSide(dir, id, input.author, composed);
  return composed.message;
}
export interface NewThread { title: unknown; text: unknown; images?: Image[]; origin: Author; question?: QuestionInput; flag?: unknown; readOnly?: boolean; agent_name?: unknown }
export async function createThread(dir: string, input: NewThread): Promise<{ id: string }> {
  const images = input.images ?? [];
  const title = threadTitle(input.title);
  if (input.question && input.origin !== 'agent') throw new Invalid('Only the agent can ask questions', 403);
  const text = input.question ? messageText(input.text ?? input.question.prompt, false) : messageText(input.text, images.length > 0);
  if (input.readOnly && input.origin !== 'agent') throw new Invalid('Only the agent can start a read-only thread', 403);
  if (input.readOnly && input.question) throw new Invalid('A read-only thread cannot hold a question: nobody could answer it');
  const flag = messageFlag(input.origin, input.flag, !input.readOnly); // a thread the agent starts wants attention, unless it only carries updates
  if (input.agent_name !== undefined && input.agent_name !== null && input.agent_name !== '' && input.origin !== 'agent') throw new Invalid('Only the agent has an agent name', 403);
  const agentName = checkAgentName(input.agent_name);
  await notTheUser(dir, agentName);
  const { id, path, created_at } = await makeItemFolder(dir);
  try {
    const message: Message = { id: 'm1', author: input.origin, text, images: await saveImages(path, images), created_at, ...(agentName ? { agent_name: agentName } : {}),
      ...(flag ? { flag } : {}), ...(input.question ? { question: buildQuestion('q1', input.question) } : {}) };
    await writeFile(join(path, 'item.json'), JSON.stringify({ id, created_at, mode: 'thread', title, origin: input.origin, note: text, ...(input.readOnly ? { read_only: true } : {}) }, null, 2));
    await writeStatus(path, 'open');
    await writeFile(join(path, 'feedback.md'), `${title}\n\n${text}\n`);
    await writeFile(join(path, 'thread.jsonl'), `${JSON.stringify(message)}\n`);
    if (flag === 'done') await closeForDone(path);
  } catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
  if (input.origin === 'user') await logEvent(dir, { id, kind: 'thread', text: `${title}: ${text}` });
  return { id };
}
// The widget's capture items start with the user's note as the first message.
export async function startCaptureThread(dir: string, id: string, note: string, created_at: string): Promise<void> {
  const message: Message = { id: 'm1', author: 'user', text: note, images: [], created_at };
  await writeFile(join(dir, id, 'thread.jsonl'), `${JSON.stringify(message)}\n`);
}

// Rewrites one JSON line of thread.jsonl and leaves every other line byte for byte. Used when a question is withdrawn or re-asked.
async function mapThreadLine(path: string, qid: string, edit: (message: ItemData) => void): Promise<void> {
  const file = join(path, 'thread.jsonl');
  const raw = await optional(file);
  if (raw === null) throw new Invalid('No such question', 404);
  let found = false;
  const lines = raw.split('\n').map(line => {
    if (!line.trim()) return line;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return line; }
    if (!isObject(parsed) || !isObject(parsed.question) || parsed.question.id !== qid) return line;
    found = true;
    edit(parsed);
    return JSON.stringify(parsed);
  });
  if (!found) throw new Invalid('No such question', 404);
  await writeAtomic(file, `${lines.join('\n').replace(/\n*$/, '')}\n`);
}
const questionMessage = (messages: Message[], qid: string) => messages.find(m => m.author === 'agent' && m.question?.id === qid);
// Withdraws an unanswered question. It stays in the thread, struck through, and no longer waits on the person.
export async function cancelQuestion(dir: string, id: string, qid: string, reason?: unknown): Promise<{ withdrawn: boolean }> {
  if (reason !== undefined && reason !== null && reason !== '' && (typeof reason !== 'string' || reason.trim().length > 300)) throw new Invalid('A reason is at most 300 characters');
  const why = typeof reason === 'string' && reason.trim() ? reason.trim() : undefined;
  const path = await itemDir(dir, id);
  return withLock(path, async () => {
    const stored = await materialise(path, await readItem(path));
    const message = questionMessage(stored, qid);
    if (!message?.question) throw new Invalid('No such question', 404);
    if (stored.some(m => m.answer?.question_id === qid)) throw new Invalid('That question is already answered', 409);
    if (message.question.reasked) throw new Invalid('That question was re-asked; cancel the newer one', 409);
    if (message.question.withdrawn) return { withdrawn: false };
    const at = new Date().toISOString();
    await mapThreadLine(path, qid, parsed => {
      const question = parsed.question as ItemData;
      question.withdrawn = why ? { at, reason: why } : { at };
      if (parsed.flag === 'needs_you') parsed.flag = 'fyi';
    });
    return { withdrawn: true };
  });
}
// Marks the question "re-asked below" and posts the same question again at the end of the thread.
export async function bumpQuestion(dir: string, id: string, qid: string): Promise<{ id: string; question_id: string }> {
  const path = await itemDir(dir, id);
  return withLock(path, async () => {
    const item = await readItem(path);
    if (item.read_only === true) throw new Invalid('A read-only thread cannot hold a question: nobody could answer it', 409);
    const stored = await materialise(path, item);
    const message = questionMessage(stored, qid);
    if (!message?.question) throw new Invalid('No such question', 404);
    if (message.question.withdrawn) throw new Invalid('That question was withdrawn', 409);
    if (message.question.reasked) throw new Invalid('That question was already re-asked', 409);
    if (stored.some(m => m.answer?.question_id === qid)) throw new Invalid('That question is already answered', 409);
    const q = message.question;
    await mapThreadLine(path, qid, parsed => {
      (parsed.question as ItemData).reasked = true;
      if (parsed.flag === 'needs_you') parsed.flag = 'fyi';
    });
    const n = stored.length + 1;
    const question = buildQuestion(`q${n}`, { prompt: q.prompt, options: q.options.map(o => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })), multi: q.multi, allow_other: q.allow_other });
    const created: Message = { id: `m${n}`, author: 'agent', text: q.prompt, images: [], created_at: new Date().toISOString(), flag: 'needs_you', question };
    await appendFile(join(path, 'thread.jsonl'), `${JSON.stringify(created)}\n`);
    return { id: created.id, question_id: question.id };
  });
}
// A system line in the thread when an agent creates a share. A divider, so it does not change who the thread is waiting on. It does count as unread.
export async function appendShareNotice(dir: string, id: string, text: string, shareId: string, artifactId: string): Promise<void> {
  const path = await itemDir(dir, id);
  await withLock(path, async () => {
    const stored = await materialise(path, await readItem(path));
    const message: Message = { id: `m${stored.length + 1}`, author: 'agent', text, images: [], created_at: new Date().toISOString(), divider: true, kind: 'share_notice', share_id: shareId, artifact_id: artifactId };
    await appendFile(join(path, 'thread.jsonl'), `${JSON.stringify(message)}\n`);
  });
}

// `seen` is the last_message_at the client actually displayed; it is clamped to the newest message so it cannot pre-read later ones.
export async function markRead(dir: string, id: string, seen?: unknown): Promise<void> {
  const path = await itemDir(dir, id);
  const item = await readItem(path);
  const latest = lastAt(await readMessages(path, item), item);
  let at = latest;
  if (seen !== undefined) {
    const parsed = typeof seen === 'string' ? Date.parse(seen) : NaN;
    if (!Number.isFinite(parsed)) throw new Invalid('seen must be a timestamp');
    const iso = new Date(parsed).toISOString();
    at = iso < latest ? iso : latest;
  }
  await stampRead(path, 'read.json', at);
}
export async function markAgentRead(dir: string, id: string, agent?: string): Promise<string> {
  const path = await itemDir(dir, id);
  return withLock(path, async () => {
    const item = await readItem(path);
    const at = lastAt(await readMessages(path, item), item);
    await stampRead(path, agentReadFile(agent), at);
    return at;
  });
}
// The agent has seen the user's latest message and has nothing to say: it stops waiting for the agent and shows two ticks.
// A later user message is newer than `acked_through`, so the thread waits again. Not a user event, so nothing is logged.
export async function ackThread(dir: string, id: string, agent?: string): Promise<{ acked_through: string }> {
  const path = await itemDir(dir, id);
  return withLock(path, async () => {
    const item = await readItem(path);
    const messages = await readMessages(path, item);
    const users = messages.filter(m => m.author === 'user');
    if (!users.length) throw new Invalid('There is no message from the user to acknowledge', 409);
    const newest = users.reduce((hi, m) => (m.created_at > hi ? m.created_at : hi), '');
    const old = await readMarker(path, 'agent-read.json');
    const acked = typeof old.acked_through === 'string' && old.acked_through > newest ? old.acked_through : newest;
    const read = lastAt(messages, item);
    const at = typeof old.at === 'string' && old.at > read ? old.at : read;
    await writeAtomic(join(path, 'agent-read.json'), JSON.stringify({ ...old, at, acked_through: acked })); // an ack is the thread's, whichever agent gave it
    if (agent) await stampRead(path, agentReadFile(agent), read);
    return { acked_through: acked };
  });
}
// A read-only thread carries updates from the agent: the user cannot post, and it never waits for anyone.
export async function setReadOnly(dir: string, id: string, on: boolean): Promise<void> {
  const path = await itemDir(dir, id);
  await withLock(path, async () => {
    const item = await readItem(path);
    if (on) item.read_only = true; else delete item.read_only;
    await writeAtomic(join(path, 'item.json'), JSON.stringify(item, null, 2));
  });
}

// ---- Checklists: <thread>/checklist.json holds two lists in one array (`owner`: who has to do it).
// Only the agent ticks (`done`). The user can claim an item is done; the agent then checks it, or unclaims it with a note.
export const MAX_ITEMS = 50;
export const MAX_ITEM_TEXT = 300;
export interface ChecklistItem {
  id: string; owner: Author; text: string; done: boolean; done_by?: 'agent'; done_at?: string; created_by: Author; created_at: string;
  claimed_by_user_at?: string; unclaim_note?: string; unclaimed_at?: string;
}
export interface ChecklistCounts { total: number; done: number; claimed: number }
const isAuthor = (v: unknown): v is Author => v === 'user' || v === 'agent';
function parseChecklist(raw: string | null): ChecklistItem[] {
  let data: unknown;
  try { data = raw === null ? null : JSON.parse(raw); } catch { return []; }
  if (!isObject(data) || !Array.isArray(data.items)) return [];
  const out: ChecklistItem[] = [];
  for (const i of data.items) {
    if (!isObject(i) || typeof i.id !== 'string' || !isAuthor(i.owner) || typeof i.text !== 'string' || typeof i.created_at !== 'string') continue;
    const done = i.done === true;
    out.push({ id: i.id, owner: i.owner, text: i.text, done, ...(done ? { done_by: 'agent' as const, ...(typeof i.done_at === 'string' ? { done_at: i.done_at } : {}) } : {}),
      created_by: isAuthor(i.created_by) ? i.created_by : i.owner, created_at: i.created_at,
      ...(typeof i.claimed_by_user_at === 'string' ? { claimed_by_user_at: i.claimed_by_user_at } : {}),
      ...(typeof i.unclaim_note === 'string' ? { unclaim_note: i.unclaim_note } : {}), ...(typeof i.unclaimed_at === 'string' ? { unclaimed_at: i.unclaimed_at } : {}) });
  }
  return out;
}
// Write a temp file beside the target, then rename it over: a reader sees the old file or the new one, never half of one.
export async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try { await writeFile(tmp, text, { flag: 'wx' }); await rename(tmp, file); }
  catch (error) { await rm(tmp, { force: true }); throw error; }
}
export async function readChecklist(path: string): Promise<ChecklistItem[]> { return parseChecklist(await optional(join(path, 'checklist.json'))); }
export function checklistCounts(items: ChecklistItem[]): ChecklistCounts {
  return { total: items.length, done: items.filter(i => i.done).length, claimed: items.filter(i => !i.done && i.claimed_by_user_at).length };
}
export async function listChecklist(dir: string, id: string): Promise<ChecklistItem[]> { return readChecklist(await itemDir(dir, id)); }
async function changeChecklist<T>(dir: string, id: string, by: Author, fn: (items: ChecklistItem[]) => T, agent?: string): Promise<T> {
  const path = await itemDir(dir, id);
  return withLock(path, async () => {
    if (by === 'user' && (await readItem(path)).read_only === true) throw new Invalid(READ_ONLY_NOTE, 409);
    const items = await readChecklist(path);
    const result = fn(items);
    await writeAtomic(join(path, 'checklist.json'), JSON.stringify({ items }, null, 2));
    if (by === 'agent') { const item = await readItem(path); await stampRead(path, agentReadFile(agent), lastAt(await readMessages(path, item), item)); } // acting on the thread means the agent has seen it
    return result;
  });
}
function itemText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_ITEM_TEXT) throw new Invalid(`Item text must be 1–${MAX_ITEM_TEXT} characters`);
  return value.trim();
}
const find = (items: ChecklistItem[], itemId: string) => items.find(i => i.id === itemId) ?? (() => { throw new Invalid('No such item', 404); })();
const userEvent = (dir: string, id: string, kind: 'checklist' | 'checklist_claim', text: string) => logEvent(dir, { id, kind, text });
// Adds one item to a list already read (and about to be written back by the caller).
function pushItem(items: ChecklistItem[], owner: Author, text: string, by: Author): ChecklistItem {
  if (items.length >= MAX_ITEMS) throw new Invalid(`A checklist holds at most ${MAX_ITEMS} items`);
  const n = items.reduce((m, i) => Math.max(m, Number(/^c(\d+)$/.exec(i.id)?.[1] ?? 0)), 0);
  const created: ChecklistItem = { id: `c${n + 1}`, owner, text, done: false, created_by: by, created_at: new Date().toISOString() };
  items.push(created);
  return created;
}
// Ticks an item in a list already read. Only the agent ticks; an item that is already ticked is left alone.
function tickItem(items: ChecklistItem[], itemId: string): boolean {
  const it = find(items, itemId);
  if (it.done) return false;
  it.done = true; it.done_by = 'agent'; it.done_at = new Date().toISOString();
  return true;
}
export async function addChecklistItem(dir: string, id: string, input: { owner: unknown; text: unknown; by: Author; agent?: string }): Promise<ChecklistItem> {
  if (!isAuthor(input.owner)) throw new Invalid('owner must be "user" or "agent"');
  const text = itemText(input.text);
  const item = await changeChecklist(dir, id, input.by, items => pushItem(items, input.owner as Author, text, input.by), input.agent);
  if (input.by === 'user') await userEvent(dir, id, 'checklist', `add (${item.owner === 'user' ? 'for you' : 'for the agent'}): ${item.text}`);
  return item;
}
export interface ChecklistPatch { text?: unknown; done?: unknown; claimed?: unknown; note?: unknown }
// The user may edit the text of their own items and claim or withdraw a claim on any item; they can never set `done`.
// The agent may tick, untick, edit anything, and unclaim (with a note saying what is missing).
export async function patchChecklistItem(dir: string, id: string, itemId: string, patch: ChecklistPatch, by: Author, agent?: string): Promise<ChecklistItem> {
  if (by === 'user' && patch.done !== undefined) throw new Invalid('Only the agent can tick an item. Use claimed: true to say you have done it.', 403);
  if (patch.done !== undefined && typeof patch.done !== 'boolean') throw new Invalid('done must be true or false');
  if (patch.claimed !== undefined && typeof patch.claimed !== 'boolean') throw new Invalid('claimed must be true or false');
  if (patch.text === undefined && patch.done === undefined && patch.claimed === undefined) throw new Invalid('Nothing to change');
  const text = patch.text === undefined ? undefined : itemText(patch.text);
  const note = patch.note === undefined ? undefined : itemText(patch.note);
  const at = new Date().toISOString();
  let kind: 'checklist' | 'checklist_claim' = 'checklist';
  const item = await changeChecklist(dir, id, by, items => {
    const it = find(items, itemId);
    if (text !== undefined) {
      if (by === 'user' && it.created_by !== 'user') throw new Invalid('You can only edit items you added', 403);
      it.text = text;
    }
    if (patch.claimed === true) {
      if (by !== 'user') throw new Invalid('Only the user can claim an item');
      if (it.done) throw new Invalid('The agent has already ticked that item', 409);
      it.claimed_by_user_at = at; delete it.unclaim_note; delete it.unclaimed_at; kind = 'checklist_claim';
    }
    if (patch.claimed === false && it.claimed_by_user_at) {
      if (by === 'agent' && note === undefined) throw new Invalid('Unclaiming needs a note saying what is still missing');
      delete it.claimed_by_user_at;
      if (by === 'agent') { it.unclaim_note = note; it.unclaimed_at = at; }
    }
    if (patch.done === true) { it.done = true; it.done_by = 'agent'; it.done_at = at; }
    if (patch.done === false) { it.done = false; delete it.done_by; delete it.done_at; }
    return { ...it };
  }, agent);
  if (by === 'user') await userEvent(dir, id, kind, `${(kind as string) === 'checklist_claim' ? 'claimed done' : 'edit'}: ${item.text}`);
  return item;
}
export async function deleteChecklistItem(dir: string, id: string, itemId: string, by: Author): Promise<void> {
  const gone = await changeChecklist(dir, id, by, items => {
    const it = find(items, itemId);
    if (by === 'user' && it.created_by !== 'user') throw new Invalid('You can only delete items you added', 403);
    items.splice(items.indexOf(it), 1);
    return it;
  });
  if (by === 'user') await userEvent(dir, id, 'checklist', `delete: ${gone.text}`);
}
// ---- Tracker: every checklist item across the threads that were not merged away, read once. Filters and grouping are in inbox/tracker.js.
export interface TrackerRow { thread: string; title: string; read_only: boolean; item: ChecklistItem }
export interface Tracker { generated_at: string; counts: ChecklistCounts; threads: { id: string; title: string; open: number }[]; you: TrackerRow[]; agent: TrackerRow[]; done_recent: TrackerRow[] }
export async function readTracker(dir: string, filter: { thread?: string; state?: string; q?: string } = {}, now = new Date()): Promise<Tracker> {
  let entries: string[] = [];
  try { entries = (await readdir(dir)).filter(e => ID.test(e)); } catch (error) { if (code(error) !== 'ENOENT') throw error; }
  const rows: TrackerRow[] = [], threads: Tracker['threads'] = [];
  for (const id of entries.sort()) {
    try {
      const path = join(dir, id);
      if ((await readMerge(path))?.state === 'done') continue;
      const items = await readChecklist(path);
      if (!items.length) continue;
      const item = await readItem(path);
      const title = titleOf(item, id), read_only = item.read_only === true;
      threads.push({ id, title, open: items.filter(i => !i.done).length });
      for (const i of items) rows.push({ thread: id, title, read_only, item: i });
    } catch { /* a broken folder must not hide the rest */ }
  }
  const groups = groupRows(filterRows(rows, filter), now.getTime());
  return { generated_at: now.toISOString(), counts: checklistCounts(rows.map(r => r.item)), threads, ...groups };
}
export interface OpenItem { thread: string; title: string; item: ChecklistItem }
// Items across every thread: `mine` = open items for the agent; `claimed` = items the user says are done and the agent has not checked.
export async function openItems(dir: string, filter: 'mine' | 'claimed' | 'all'): Promise<OpenItem[]> {
  const out: OpenItem[] = [];
  for (const t of await listThreads(dir)) {
    for (const item of await readChecklist(join(dir, t.id))) {
      if (item.done) continue;
      if (filter === 'mine' ? item.owner === 'agent' : filter === 'claimed' ? !!item.claimed_by_user_at : true) out.push({ thread: t.id, title: t.title, item });
    }
  }
  return out;
}

// ---- Pins: which threads and which area groups sit in the Pinned section. One file, so they follow the user between devices.
// An area key is what inbox/areas.js derives: a configured key or the first path segment of the page, lower-cased ('home' and 'conversations' too),
// optionally with a sub-group after a colon (`key:sub`). The same KEY pattern validates both, so anything the inbox derives can be pinned.
const AREA_KEY = new RegExp(`^${KEY.source.slice(1, -1)}(?::${KEY.source.slice(1, -1)})?$`);
export const isAreaKey = (value: unknown): value is string => typeof value === 'string' && AREA_KEY.test(value);
export interface Pins { threads: string[]; areas: string[] }
export async function readPins(dir: string): Promise<Pins> {
  let v: unknown = null;
  try { v = JSON.parse(await optional(join(dir, '_profile', 'pins.json')) ?? 'null'); } catch { /* start empty */ }
  const list = (x: unknown, ok: (s: string) => boolean) => (isObject(v) && Array.isArray((v as ItemData)[x as string]) ? ((v as ItemData)[x as string] as unknown[]).filter((s): s is string => typeof s === 'string' && ok(s)) : []);
  return { threads: list('threads', s => ID.test(s)), areas: list('areas', isAreaKey) };
}
let pinQueue: Promise<unknown> = Promise.resolve();
// `pinned` omitted toggles. Changes run one at a time, and the file is replaced atomically.
export function setPin(dir: string, input: { kind: unknown; id: unknown; pinned?: unknown }): Promise<Pins> {
  const run = async (): Promise<Pins> => {
    if (input.kind !== 'thread' && input.kind !== 'area') throw new Invalid('kind must be "thread" or "area"');
    if (typeof input.id !== 'string' || !(input.kind === 'thread' ? ID.test(input.id) : isAreaKey(input.id))) throw new Invalid('Unknown thread or area');
    if (input.pinned !== undefined && typeof input.pinned !== 'boolean') throw new Invalid('pinned must be true or false');
    const pins = await readPins(dir);
    const list = input.kind === 'thread' ? pins.threads : pins.areas;
    const has = list.includes(input.id);
    const want = input.pinned ?? !has;
    if (want && !has) list.push(input.id); else if (!want && has) list.splice(list.indexOf(input.id), 1);
    await mkdir(join(dir, '_profile'), { recursive: true });
    await writeAtomic(join(dir, '_profile', 'pins.json'), JSON.stringify(pins));
    return pins;
  };
  const result = pinQueue.then(run, run);
  pinQueue = result.catch(() => undefined);
  return result;
}

// ---- Merging: one thread folded into another. The source stays readable, marked done, with a link to the target.
// `merged.json` on the source is written first as an intent (state "copying", with the target's length) and flipped to "done" last,
// so an interrupted merge can be retried: every step checks whether it already happened.
// `map` is the old→new id table for that copy (message ids, question ids, checklist ids). A later repair reads it back;
// merges from before it was stored are recovered by lining the source up with the copy instead.
interface MergeMap { messages: Record<string, string>; questions: Record<string, string>; items: Record<string, string> }
interface MergeNote { into: string; at: string; state: 'copying' | 'done'; base: number; await_agent: boolean; map?: MergeMap; carried?: Record<string, string> }
const idRecord = (value: unknown): Record<string, string> | null => {
  if (!isObject(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) if (typeof item === 'string' && item) out[key] = item;
  return out;
};
async function readMerge(path: string): Promise<MergeNote | null> {
  try {
    const v = JSON.parse(await optional(join(path, 'merged.json')) ?? 'null');
    if (!isObject(v) || typeof v.into !== 'string' || typeof v.at !== 'string') return null;
    const messages = isObject(v.map) ? idRecord(v.map.messages) : null;
    const questions = isObject(v.map) ? idRecord(v.map.questions) : null;
    const items = isObject(v.map) ? idRecord(v.map.items) : null;
    const map = messages && questions && items ? { messages, questions, items } : undefined;
    const carried = idRecord(v.carried);
    return { into: v.into, at: v.at, state: v.state === 'copying' ? 'copying' : 'done', base: typeof v.base === 'number' ? v.base : 0, await_agent: v.await_agent === true, ...(map ? { map } : {}), ...(carried && Object.keys(carried).length ? { carried } : {}) };
  } catch { return null; }
}
// The id table stored with the merge, or the same table rebuilt by lining the source up after the divider.
async function resolvedMap(fromId: string, note: MergeNote, from: string, into: string): Promise<MergeMap | null> {
  if (note.map) return note.map;
  const source = await readMessages(from, await readItem(from));
  const target = await readMessages(into, await readItem(into));
  const pairs = pairsFromBase(source, target, note.base, note.into);
  if (!pairs) return null;
  const span = spanOf(fromId, note.into, pairs, undefined);
  return { messages: asRecord(span.messages), questions: asRecord(span.questions), items: asRecord(span.items) };
}
// On the target: a merge brought in something the agent has not answered. Only an agent message after `at` clears it.
async function readAwait(path: string): Promise<string | null> {
  try { const v = JSON.parse(await optional(join(path, 'awaiting-agent.json')) ?? 'null'); return isObject(v) && typeof v.at === 'string' ? v.at : null; } catch { return null; }
}
const titleOf = (item: ItemData, id: string) => (typeof item.title === 'string' && item.title ? item.title : String(item.note ?? '').split('\n')[0] || id);
async function readOrNull(path: string): Promise<Buffer | null> {
  try { return await readFile(path); } catch (error) { if (code(error) === 'ENOENT') return null; throw error; }
}
// The divider takes the next id after the target, then each source message takes the one after that. Question ids follow the new message number.
// Built in full before anything is written, so a reference is remapped even when it sits above the thing it names.
function carryPlan(source: Message[], targetLength: number, items: Map<string, string>): { messages: Map<string, string>; questions: Map<string, string>; items: Map<string, string> } {
  const messages = new Map<string, string>(), questions = new Map<string, string>();
  source.forEach((m, i) => {
    const n = targetLength + 2 + i;
    messages.set(m.id, `m${n}`);
    if (m.question) questions.set(m.question.id, `q${n}`);
  });
  return { messages, questions, items };
}
const asRecord = (map: Map<string, string>): Record<string, string> => Object.fromEntries(map);
// Rewrites every id this copy carries: the quote, the checklist items it added or ticked, the question's own id, and the answer's question.
// A quote of a message that was not copied is dropped. `reasked` is a flag, not an id; the re-asked copy is its own message and is remapped with the rest.
function applyCarry(m: Message, copy: Message, messages: Map<string, string>, questions: Map<string, string>, items: Map<string, string>): void {
  delete copy.reply_to; delete copy.added_items; delete copy.ticked_items;
  if (m.reply_to && messages.has(m.reply_to)) copy.reply_to = messages.get(m.reply_to)!;
  for (const key of ['added_items', 'ticked_items'] as const) {
    const mapped = (m[key] ?? []).flatMap(id => (items.has(id) ? [items.get(id)!] : []));
    if (mapped.length) copy[key] = mapped;
  }
  if (m.question) copy.question = { ...m.question, id: questions.get(m.question.id) ?? m.question.id };
  if (m.answer) copy.answer = { ...m.answer, question_id: questions.get(m.answer.question_id) ?? m.answer.question_id };
}
async function copyMessages(from: string, into: string, source: Message[], target: Message[], at: string, divider: string, carried: { messages: Map<string, string>; questions: Map<string, string>; items: Map<string, string> }): Promise<void> {
  // Images are copied under new numbers (the target's msg-<n> names), then every reference is rewritten from the one map.
  const wanted = [...new Set(source.flatMap(m => m.images))];
  const loaded = (await Promise.all(wanted.map(async f => ({ f, bytes: await readOrNull(join(from, f)) })))).filter((x): x is { f: string; bytes: Buffer } => x.bytes !== null);
  const names = await saveImages(into, loaded.map(x => ({ bytes: x.bytes, ext: x.f.slice(x.f.lastIndexOf('.') + 1) as Extension })));
  const renamed = new Map(loaded.map((x, i) => [x.f, names[i]!]));
  const lines: Message[] = [{ id: `m${target.length + 1}`, author: 'agent', text: divider, images: [], created_at: at, divider: true }];
  for (const m of source) {
    const copy: Message = { ...m, id: carried.messages.get(m.id)!, images: m.images.flatMap(f => (renamed.has(f) ? [renamed.get(f)!] : [])) };
    applyCarry(m, copy, carried.messages, carried.questions, carried.items);
    lines.push(copy);
  }
  await appendFile(join(into, 'thread.jsonl'), lines.map(m => `${JSON.stringify(m)}\n`).join(''));
}
// Where each of the source's items ends up in the target: moved ones get the next free ids, and one an earlier attempt already moved keeps its new id.
interface ChecklistMove { moving: ChecklistItem[]; staying: ChecklistItem[]; existing: ChecklistItem[]; fresh: ChecklistItem[]; ids: Map<string, string> }
async function planChecklistMove(from: string, into: string, only?: Set<string>): Promise<ChecklistMove> {
  const all = await readChecklist(from), existing = await readChecklist(into);
  const moving = only ? all.filter(i => only.has(i.id)) : all, staying = only ? all.filter(i => !only.has(i.id)) : [];
  const same = (a: ChecklistItem, b: ChecklistItem) => a.owner === b.owner && a.created_at === b.created_at && a.text === b.text;
  let c = existing.reduce((hi, i) => Math.max(hi, Number(/^c(\d+)$/.exec(i.id)?.[1] ?? 0)), 0);
  const ids = new Map<string, string>(), fresh: ChecklistItem[] = [];
  for (const i of moving) {
    const done = existing.find(e => same(e, i));
    if (done) ids.set(i.id, done.id); else { const id = `c${++c}`; ids.set(i.id, id); fresh.push({ ...i, id }); }
  }
  return { moving, staying, existing, fresh, ids };
}
// Advances `into`'s read marker to what `from` had read, stopping short of the target's own oldest message (by the other side) that is still unread.
async function carryRead(from: string, into: string, targetMessages: Message[], file: string, unreadable: (m: Message) => boolean): Promise<void> {
  const theirs = await readAt(from, file);
  if (theirs === null) return;
  const mine = await readAt(into, file);
  const blocked = targetMessages.filter(m => unreadable(m) && !m.divider && (mine === null || m.created_at > mine)).map(m => m.created_at).sort()[0];
  let to = theirs;
  if (blocked !== undefined && blocked <= to) to = new Date(Date.parse(blocked) - 1).toISOString();
  if (mine !== null && to <= mine) return;
  await stampRead(into, file, to);
}
async function moveChecklist(from: string, into: string, plan: ChecklistMove): Promise<void> {
  if (!plan.moving.length) return;
  if (plan.existing.length + plan.fresh.length > MAX_ITEMS) throw new Invalid(`The merged checklist would hold more than ${MAX_ITEMS} items`);
  await writeAtomic(join(into, 'checklist.json'), JSON.stringify({ items: [...plan.existing, ...plan.fresh] }, null, 2));
  await writeAtomic(join(from, 'checklist.json'), JSON.stringify({ items: plan.staying }, null, 2));
}
// Runs with both thread locks held. Returns false when this exact merge was already completed.
async function mergeLocked(dir: string, from: string, into: string, fromId: string, intoId: string): Promise<boolean> {
  const prior = await readMerge(from);
  if (prior && prior.into !== intoId) throw new Invalid('That thread was already merged into another one', 409);
  if (prior?.state === 'done') return false;
  if (await readMerge(into)) throw new Invalid('The target thread was itself merged into another one', 409);
  const fromItem = await readItem(from), intoItem = await readItem(into);
  if (!prior && intoItem.read_only === true) throw new Invalid('Cannot merge into a read-only thread', 409);
  const source = await materialise(from, fromItem), target = await materialise(into, intoItem);
  const tail = (await readChecklist(from)).length + (await readChecklist(into)).length;
  if (!prior && tail > MAX_ITEMS) throw new Invalid(`The merged checklist would hold more than ${MAX_ITEMS} items`);
  let note = prior;
  if (!note) {
    // Anything the user said that the agent has not answered, in either thread, stays waiting for the agent after the merge.
    const [a, b] = [(await summarise(dir, fromId)).summary, (await summarise(dir, intoId)).summary];
    note = { into: intoId, at: new Date().toISOString(), state: 'copying', base: target.length, await_agent: a.waiting === 'agent' || b.waiting === 'agent' };
    await writeAtomic(join(from, 'merged.json'), JSON.stringify(note));
  }
  const divider = `Merged from: ${titleOf(fromItem, fromId)}`;
  const farewellText = `Merged into [${titleOf(intoItem, intoId)}](#/${intoId})`;
  const copied = target[note.base]?.divider === true && target[note.base]!.text === divider;
  const plan = await planChecklistMove(from, into);
  // The farewell is written after the copy, so a retry must not number it as one of the copied messages.
  const copying = source.filter(m => !(m.author === 'agent' && m.text === farewellText));
  const carried = carryPlan(copying, note.base, plan.ids);
  if (!note.map) {
    note = { ...note, map: { messages: asRecord(carried.messages), questions: asRecord(carried.questions), items: asRecord(carried.items) } };
    await writeAtomic(join(from, 'merged.json'), JSON.stringify(note));
  }
  if (!copied) await copyMessages(from, into, copying, target.slice(0, note.base), note.at, divider, carried);
  await moveChecklist(from, into, plan);
  // What either side had already read in the source stays read in the target (ticks), but never past a message of the target they have not read.
  await carryRead(from, into, target.slice(0, note.base), 'agent-read.json', m => m.author === 'user');
  await carryRead(from, into, target.slice(0, note.base), 'read.json', m => m.author === 'agent');
  if (note.await_agent) {
    await writeAtomic(join(into, 'awaiting-agent.json'), JSON.stringify({ at: note.at, from: fromId }));
    await writeStatus(into, 'open');
  }
  if (!source.some(m => m.author === 'agent' && m.text === farewellText)) {
    const farewell: Message = { id: `m${source.length + 1}`, author: 'agent', text: farewellText, images: [], created_at: new Date().toISOString(), flag: 'done' };
    await appendFile(join(from, 'thread.jsonl'), `${JSON.stringify(farewell)}\n`);
  }
  await writeStatus(from, 'done');
  await writeAtomic(join(from, 'merged.json'), JSON.stringify({ ...note, state: 'done' }));
  return true;
}
// Both threads are locked in id order, so two merges touching the same pair can never wait on each other.
export async function mergeThreads(dir: string, fromId: string, intoId: string, by: Author): Promise<{ merged: boolean; into: string }> {
  if (fromId === intoId) throw new Invalid('A thread cannot be merged into itself');
  const from = await itemDir(dir, fromId), into = await itemDir(dir, intoId);
  const [first, second] = fromId < intoId ? [from, into] : [into, from];
  const merged = await withLock(first, () => withLock(second, () => mergeLocked(dir, from, into, fromId, intoId)));
  if (merged) {
    const pins = await readPins(dir);
    if (pins.threads.includes(fromId)) { await setPin(dir, { kind: 'thread', id: fromId, pinned: false }); await setPin(dir, { kind: 'thread', id: intoId, pinned: true }); }
    if (by === 'user') await logEvent(dir, { id: intoId, kind: 'merge', text: `${fromId} into ${intoId}` });
  }
  return { merged, into: intoId };
}

// ---- Repairing a merge from before answers were remapped.
// The source keeps its original ids. The copy renumbers them. A merge that only renumbered the question, not the answer, is repaired from that pair.
// When the old→new table is not on the merge note, it is rebuilt by lining the source up after the divider (`base` messages, then the divider, then the copy).
// If that cannot be checked, the thread is left untouched.
const WORKAROUND_REASON = /^(?:Answered:|Settled:)/;
export interface MergeRepair { into: string; from: string; status: 'repaired' | 'unchanged' | 'skipped'; detail: string }
interface RepairSpan { from: string; into: string; pairs: { src: Message; copy: Message }[]; messages: Map<string, string>; questions: Map<string, string>; items: Map<string, string> }
interface RepairEdit { answer?: string; replyTo?: string; added?: string[]; ticked?: string[]; unwithdraw?: string }
const copiedBeforeFarewell = (messages: Message[], intoId: string): Message[] => {
  const cut = messages.findIndex(m => m.author === 'agent' && m.text.startsWith('Merged into [') && m.text.includes(`(#/${intoId})`));
  return cut === -1 ? messages : messages.slice(0, cut);
};
function pairsFromMap(source: Message[], target: Message[], map: MergeMap): { src: Message; copy: Message }[] | null {
  const pairs: { src: Message; copy: Message }[] = [];
  for (const [oldId, newId] of Object.entries(map.messages)) {
    const src = source.find(m => m.id === oldId), copy = target.find(m => m.id === newId);
    if (!src || !copy || src.author !== copy.author || src.created_at !== copy.created_at) return null;
    pairs.push({ src, copy });
  }
  return pairs;
}
function pairsFromBase(source: Message[], target: Message[], base: number, intoId: string): { src: Message; copy: Message }[] | null {
  if (!Number.isInteger(base) || base < 0 || base >= target.length) return null;
  const divider = target[base];
  if (!divider?.divider || !divider.text.startsWith('Merged from:')) return null;
  const copying = copiedBeforeFarewell(source, intoId);
  if (base + copying.length >= target.length) return null;
  const pairs: { src: Message; copy: Message }[] = [];
  for (let i = 0; i < copying.length; i++) {
    const src = copying[i]!, copy = target[base + 1 + i]!;
    if (src.author !== copy.author || src.created_at !== copy.created_at || src.text !== copy.text) return null;
    pairs.push({ src, copy });
  }
  return pairs;
}
function spanOf(from: string, into: string, pairs: { src: Message; copy: Message }[], items: Record<string, string> | undefined): RepairSpan {
  const messages = new Map<string, string>(), questions = new Map<string, string>();
  for (const { src, copy } of pairs) {
    messages.set(src.id, copy.id);
    if (src.question && copy.question) questions.set(src.question.id, copy.question.id);
  }
  return { from, into, pairs, messages, questions, items: new Map(Object.entries(items ?? {})) };
}
// An answer may still name a question id from a thread that was merged into the source, and then into this one. Follow only that chain.
function questionOn(spans: RepairSpan[], thread: string, qid: string, guard = new Set<string>()): string {
  const mark = `${thread}\0${qid}`;
  if (guard.has(mark)) return qid;
  guard.add(mark);
  for (const span of spans.filter(s => s.into === thread)) {
    if (span.questions.has(qid)) return span.questions.get(qid)!;
    const lifted = questionOn(spans, span.from, qid, guard);
    if (lifted !== qid && span.questions.has(lifted)) return span.questions.get(lifted)!;
  }
  return qid;
}
function wantedQuestion(span: RepairSpan, src: Message, spans: RepairSpan[]): string | undefined {
  const qid = src.answer?.question_id;
  if (!qid) return undefined;
  if (span.questions.has(qid)) return span.questions.get(qid);
  const lifted = questionOn(spans, span.from, qid);
  return lifted !== qid && span.questions.has(lifted) ? span.questions.get(lifted) : undefined;
}
function editsFor(span: RepairSpan, spans: RepairSpan[]): Map<string, RepairEdit> {
  const edits = new Map<string, RepairEdit>();
  const edit = (id: string): RepairEdit => edits.get(id) ?? edits.set(id, {}).get(id)!;
  for (const { src, copy } of span.pairs) {
    const wanted = copy.answer ? wantedQuestion(span, src, spans) : undefined;
    if (wanted && copy.answer!.question_id !== wanted) edit(copy.id).answer = wanted;
    if (src.reply_to && span.messages.has(src.reply_to)) {
      const next = span.messages.get(src.reply_to)!;
      if (copy.reply_to !== next) edit(copy.id).replyTo = next;
    }
    for (const key of ['added_items', 'ticked_items'] as const) {
      const had = src[key] ?? [];
      if (!had.length || !had.every(id => span.items.has(id))) continue;
      const next = had.map(id => span.items.get(id)!);
      const got = copy[key] ?? [];
      if (next.join() !== got.join()) edit(copy.id)[key === 'added_items' ? 'added' : 'ticked'] = next;
    }
  }
  for (const [id, change] of edits) if (!change.answer && !change.replyTo && !change.added && !change.ticked) edits.delete(id);
  return edits;
}
// A "Settled:" or "Answered:" withdrawal that travelled with the copy is the old "this looked unanswered" mark, so it is cleared.
// One dated after the merge is a real decision: it comes off only when an answer in the target (including one this repair carries) names the question.
function addUnwithdraw(span: RepairSpan, edits: Map<string, RepairEdit>, answered: Set<string>, mergeAt: string): void {
  const edit = (id: string): RepairEdit => edits.get(id) ?? edits.set(id, {}).get(id)!;
  for (const { copy } of span.pairs) {
    const withdrawn = copy.question?.withdrawn;
    const reason = withdrawn?.reason ?? '';
    if (!withdrawn || !WORKAROUND_REASON.test(reason)) continue;
    const after = withdrawn.at > mergeAt;
    if ((after && answered.has(copy.question!.id)) || !after) edit(copy.id).unwithdraw = reason;
  }
  for (const [id, change] of edits) if (!change.answer && !change.replyTo && !change.added && !change.ticked && !change.unwithdraw) edits.delete(id);
}
function answeredAfter(messages: Message[], edits: Map<string, RepairEdit>): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) if (m.answer) ids.add(edits.get(m.id)?.answer ?? m.answer.question_id);
  return ids;
}
function strandedAnswers(messages: Message[], mergeAt: string, intoId: string): Message[] {
  const cut = messages.findIndex(m => m.author === 'agent' && m.text.startsWith('Merged into [') && m.text.includes(`(#/${intoId})`));
  return (cut === -1 ? messages : messages.slice(cut + 1)).filter(m => !!m.answer && m.created_at > mergeAt);
}
function alreadyCarried(target: Message[], src: Message): boolean {
  return target.some(m => m.author === src.author && m.created_at === src.created_at && m.text.includes('Sent in ') && m.text.includes('after the merge'));
}
interface CarryPlan { from: string; src: Message; copyId: string; fromQ: string; toQ: string; title: string; span: RepairSpan; skipped?: string; plain?: boolean }
function describeCarry(plans: CarryPlan[]): string {
  return plans.map(plan => plan.skipped ? `left ${plan.src.id}: ${plan.skipped}` : plan.plain ? `carried ${plan.src.id} -> ${plan.copyId} as a plain message (${plan.fromQ} -> ${plan.toQ} is already answered in the target)` : `carried ${plan.src.id} -> ${plan.copyId} (${plan.fromQ} -> ${plan.toQ})`).join('; ');
}
async function strandedCopy(from: string, into: string, plan: CarryPlan): Promise<Message> {
  const src = plan.src;
  const wanted = [...new Set(src.images)];
  const loaded = (await Promise.all(wanted.map(async f => ({ f, bytes: await readOrNull(join(from, f)) })))).filter((x): x is { f: string; bytes: Buffer } => x.bytes !== null);
  const names = await saveImages(into, loaded.map(x => ({ bytes: x.bytes, ext: x.f.slice(x.f.lastIndexOf('.') + 1) as Extension })));
  const renamed = new Map(loaded.map((x, i) => [x.f, names[i]!]));
  const copy: Message = { ...src, id: plan.copyId, images: src.images.flatMap(f => (renamed.has(f) ? [renamed.get(f)!] : [])), text: quoteSent(plan.title, src.text) };
  if (plan.plain) delete copy.answer; else copy.answer = { ...src.answer!, question_id: plan.toQ };
  if (src.reply_to && plan.span.messages.has(src.reply_to)) copy.reply_to = plan.span.messages.get(src.reply_to)!;
  else delete copy.reply_to;
  return copy;
}
async function recordCarried(fromPath: string, carried: Record<string, string>): Promise<void> {
  const file = join(fromPath, 'merged.json');
  const raw = JSON.parse(await optional(file) ?? 'null');
  if (!isObject(raw)) return;
  raw.carried = { ...(isObject(raw.carried) ? raw.carried : {}), ...carried };
  await writeAtomic(file, JSON.stringify(raw));
}
function describeEdits(span: RepairSpan, edits: Map<string, RepairEdit>): string {
  const parts: string[] = [];
  for (const { copy } of span.pairs) {
    const change = edits.get(copy.id);
    if (!change) continue;
    if (change.answer) parts.push(`answer ${copy.id} ${copy.answer!.question_id} -> ${change.answer}`);
    if (change.replyTo) parts.push(`reply_to ${copy.id} ${copy.reply_to ?? '(none)'} -> ${change.replyTo}`);
    if (change.added) parts.push(`added_items ${copy.id} ${(copy.added_items ?? []).join(',') || '(none)'} -> ${change.added.join(',')}`);
    if (change.ticked) parts.push(`ticked_items ${copy.id} ${(copy.ticked_items ?? []).join(',') || '(none)'} -> ${change.ticked.join(',')}`);
    if (change.unwithdraw) parts.push(`un-withdrew ${copy.question!.id} (${change.unwithdraw})`);
  }
  return parts.join('; ') || 'nothing to change';
}
async function patchThread(path: string, edits: Map<string, RepairEdit>): Promise<void> {
  const file = join(path, 'thread.jsonl');
  const raw = await optional(file);
  if (raw === null || !edits.size) return;
  let changed = false;
  const lines = raw.split('\n').map(line => {
    if (!line.trim()) return line;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return line; }
    if (!isObject(parsed) || typeof parsed.id !== 'string') return line;
    const change = edits.get(parsed.id);
    if (!change) return line;
    let touched = false;
    if (change.answer && isObject(parsed.answer) && parsed.answer.question_id !== change.answer) { parsed.answer.question_id = change.answer; touched = true; }
    if (change.replyTo && parsed.reply_to !== change.replyTo) { parsed.reply_to = change.replyTo; touched = true; }
    if (change.added && isObject(parsed)) { parsed.added_items = change.added; touched = true; }
    if (change.ticked) { parsed.ticked_items = change.ticked; touched = true; }
    if (change.unwithdraw && isObject(parsed.question)) { delete parsed.question.withdrawn; touched = true; }
    if (!touched) return line;
    changed = true;
    return JSON.stringify(parsed);
  });
  if (changed) await writeAtomic(file, `${lines.join('\n').replace(/\n*$/, '')}\n`);
}
// One line per merge. Idempotent: a second run finds the ids already pointing at the copy and the workaround withdrawals already gone.
export async function repairMerged(dir: string, opts: { dryRun?: boolean } = {}): Promise<MergeRepair[]> {
  let entries: string[] = [];
  try { entries = (await readdir(dir)).filter(e => ID.test(e)); } catch (error) { if (code(error) !== 'ENOENT') throw error; }
  const notes: { from: string; note: MergeNote }[] = [];
  for (const from of entries.sort()) {
    const note = await readMerge(join(dir, from));
    if (note) notes.push({ from, note });
  }
  const spans: RepairSpan[] = [];
  const results: MergeRepair[] = [];
  const pending: { from: string; note: MergeNote; source: Message[]; title: string }[] = [];
  for (const { from, note } of notes) {
    if (note.state !== 'done') { results.push({ into: note.into, from, status: 'skipped', detail: 'merge did not finish; nothing changed' }); continue; }
    let source: Message[] | null = null, target: Message[] | null = null, title = from;
    try {
      const item = await readItem(join(dir, from));
      title = titleOf(item, from);
      source = await readMessages(join(dir, from), item);
      target = await readMessages(join(dir, note.into), await readItem(join(dir, note.into)));
    } catch { /* the source or the target is gone */ }
    const pairs = source && target ? (note.map ? pairsFromMap(source, target, note.map) : null) ?? pairsFromBase(source, target, note.base, note.into) : null;
    if (!source || !target || !pairs) { results.push({ into: note.into, from, status: 'skipped', detail: 'mapping is not recoverable; nothing changed' }); continue; }
    spans.push(spanOf(from, note.into, pairs, note.map?.items));
    pending.push({ from, note, source, title });
  }
  const byInto = new Map<string, RepairSpan[]>();
  for (const span of spans) {
    const list = byInto.get(span.into) ?? [];
    list.push(span);
    byInto.set(span.into, list);
  }
  for (const [into, group] of byInto) {
    const path = join(dir, into);
    const described: { span: RepairSpan; edits: Map<string, RepairEdit>; plans: CarryPlan[] }[] = [];
    const apply = async () => {
      const fresh = await readMessages(path, await readItem(path));
      const plans: CarryPlan[] = [];
      let n = fresh.length;
      for (const span of group) {
        const row = pending.find(p => p.from === span.from);
        if (!row) continue;
        for (const src of strandedAnswers(row.source, row.note.at, span.into)) {
          const qid = src.answer!.question_id;
          const mapped = span.questions.get(qid);
          if (!mapped) { plans.push({ from: span.from, src, copyId: '', fromQ: qid, toQ: '', title: row.title, span, skipped: `${qid} was asked after the merge` }); continue; }
          const known = row.note.carried?.[src.id];
          if ((known && fresh.some(m => m.id === known)) || alreadyCarried(fresh, src)) continue;
          plans.push({ from: span.from, src, copyId: `m${++n}`, fromQ: qid, toQ: mapped, title: row.title, span });
        }
      }
      const ref: { span: RepairSpan; edits: Map<string, RepairEdit> }[] = [];
      for (const span of group) {
        const source = pending.find(p => p.from === span.from)?.source;
        const pairs = source ? pairsFromIds(source, fresh, span) ?? span.pairs : span.pairs;
        const live = { ...span, pairs };
        ref.push({ span: live, edits: editsFor(live, spans) });
      }
      const seeded = new Map<string, RepairEdit>();
      for (const { edits } of ref) for (const [id, change] of edits) seeded.set(id, change);
      // An answer to a question the target already answers would be a second answer: it is carried as a plain message instead.
      const taken = answeredAfter(fresh, seeded);
      for (const plan of plans) { if (plan.skipped) continue; if (taken.has(plan.toQ)) plan.plain = true; else taken.add(plan.toQ); }
      const projected: Message[] = [...fresh, ...plans.filter(plan => !plan.skipped).map(plan => ({ id: plan.copyId, author: plan.src.author, text: quoteSent(plan.title, plan.src.text), images: [], created_at: plan.src.created_at, ...(plan.plain ? {} : { answer: { ...plan.src.answer!, question_id: plan.toQ } }) }))];
      const answered = answeredAfter(projected, seeded);
      for (const { span, edits } of ref) {
        addUnwithdraw(span, edits, answered, pending.find(p => p.from === span.from)?.note.at ?? '');
        described.push({ span, edits, plans: plans.filter(plan => plan.from === span.from) });
      }
      if (opts.dryRun) return;
      const copies: Message[] = [];
      for (const plan of plans) if (!plan.skipped) copies.push(await strandedCopy(join(dir, plan.from), path, plan));
      if (copies.length) await appendFile(join(path, 'thread.jsonl'), copies.map(m => `${JSON.stringify(m)}\n`).join(''));
      const merged = new Map<string, RepairEdit>();
      for (const { edits } of described) for (const [id, change] of edits) merged.set(id, change);
      await patchThread(path, merged);
      const byFrom = new Map<string, Record<string, string>>();
      for (const plan of plans) {
        if (plan.skipped) continue;
        const rec = byFrom.get(plan.from) ?? {};
        rec[plan.src.id] = plan.copyId;
        byFrom.set(plan.from, rec);
      }
      for (const [from, rec] of byFrom) await recordCarried(join(dir, from), rec);
    };
    try { await withLock(path, apply); }
    catch { results.push({ into, from: group[0]?.from ?? into, status: 'skipped', detail: 'mapping is not recoverable; nothing changed' }); continue; }
    for (const { span, edits, plans } of described) {
      const carry = describeCarry(plans);
      const edited = describeEdits(span, edits);
      const detail = [carry, edited === 'nothing to change' ? '' : edited].filter(Boolean).join('; ') || 'nothing to change';
      results.push({ into: span.into, from: span.from, status: edits.size || plans.some(plan => !plan.skipped) ? 'repaired' : 'unchanged', detail });
    }
  }
  return results.sort((a, b) => a.into.localeCompare(b.into) || a.from.localeCompare(b.from) || a.detail.localeCompare(b.detail));
}
function pairsFromIds(source: Message[], target: Message[], span: RepairSpan): { src: Message; copy: Message }[] | null {
  const pairs: { src: Message; copy: Message }[] = [];
  for (const [oldId, newId] of span.messages) {
    const src = source.find(m => m.id === oldId), copy = target.find(m => m.id === newId);
    if (!src || !copy) return null;
    pairs.push({ src, copy });
  }
  return pairs;
}

// ---- Moving messages: the agent takes messages (the user's too) out of the wrong thread and into another.
// Each moved message leaves a divider stub with the same id and time ("Moved to <title>") so quotes of it still resolve and nothing shifts.
// Copies in the target carry `moved_from`, so an interrupted move (copies written, stubs not) is finished by running it again.
// Items a message added travel with it (new ids); items it ticked move only if they were added by a moved message, otherwise the reference is dropped.
export async function moveMessages(dir: string, fromId: string, msgIds: string[], toId: string, by: Author = 'agent'): Promise<{ moved: string[]; into: string }> {
  if (fromId === toId) throw new Invalid('Choose a different thread to move into');
  if (!msgIds.length || new Set(msgIds).size !== msgIds.length) throw new Invalid('Name each message to move once');
  const from = await itemDir(dir, fromId), into = await itemDir(dir, toId);
  const [first, second] = fromId < toId ? [from, into] : [into, from];
  const result = await withLock(first, () => withLock(second, () => moveLocked(from, into, fromId, toId, msgIds)));
  if (result.moved.length) await logEvent(dir, { id: fromId, kind: 'move', text: `${result.moved.join(' ')} from ${fromId} into ${toId}`, author: by });
  return { moved: result.moved, into: toId };
}
// Whether any of `moving` is a user message (or side question) the agent has not answered in `source`.
function unansweredUser(source: Message[], moving: Message[]): boolean {
  const gone = new Set(moving.map(m => m.id));
  return moving.some(m => {
    if (m.author !== 'user' || m.answer || m.divider) return false;
    if (isAside(m)) return !source.some(x => isAside(x) && x.author === 'agent' && x.reply_to === m.id);
    return !source.slice(source.indexOf(m) + 1).some(x => x.author === 'agent' && !x.divider && !isAside(x) && !gone.has(x.id));
  });
}
async function moveLocked(from: string, into: string, fromId: string, toId: string, msgIds: string[]): Promise<{ moved: string[] }> {
  if (await readMerge(from) || await readMerge(into)) throw new Invalid('A merged thread cannot take part in a move', 409);
  const fromItem = await readItem(from), intoItem = await readItem(into);
  const source = await materialise(from, fromItem), target = await materialise(into, intoItem);
  const wanted = msgIds.map(id => {
    const m = source.find(x => x.id === id);
    if (!m) throw new Invalid(`No message ${id} in that thread`, 404);
    if (m.moved_to && m.moved_to === toId) return m; // already moved by an earlier attempt
    if (m.divider) throw new Invalid(`${id} is a divider and cannot be moved`);
    return m;
  });
  const already = wanted.filter(m => m.moved_to);
  if (already.some(m => m.moved_to !== toId)) throw new Invalid('One of those messages was already moved to another thread', 409);
  const moving = wanted.filter(m => !m.moved_to);
  const ids = new Set(moving.map(m => m.id));
  if (!moving.length && already.length) return { moved: [] };
  if (intoItem.read_only === true && moving.some(m => m.author === 'user')) throw new Invalid(READ_ONLY_NOTE, 409);
  if (intoItem.read_only === true && moving.some(m => m.question)) throw new Invalid('A read-only thread cannot hold a question: nobody could answer it', 409);
  // A question moves with its answer, and a side question with its answers.
  for (const m of source) {
    const tied = [...(m.answer ? [source.find(x => x.question?.id === m.answer!.question_id)] : []), ...(m.question ? source.filter(x => x.answer?.question_id === m.question!.id) : []),
      ...(m.aside && m.reply_to ? [source.find(x => x.id === m.reply_to)] : []), ...(isAsideRoot(m) ? source.filter(x => isAside(x) && x.reply_to === m.id) : [])];
    if (ids.has(m.id) && tied.some(t => t && !ids.has(t.id) && !t.moved_to)) throw new Invalid(`${m.id} is part of a question or side question: move it together with its answer or question`);
  }
  const copied = new Map(target.flatMap(m => (m.moved_from?.startsWith(`${fromId}/`) ? [[m.moved_from.slice(fromId.length + 1), m.id] as const] : [])));
  const fresh = moving.filter(m => !copied.has(m.id));
  const added = new Set(moving.flatMap(m => m.added_items ?? []));
  const plan = await planChecklistMove(from, into, added);
  if (plan.moving.length && plan.existing.length + plan.fresh.length > MAX_ITEMS) throw new Invalid(`The checklist would hold more than ${MAX_ITEMS} items`);
  const key = `${fromId}/#${moving.map(m => m.id).join(',')}`; // marks this batch's divider, so a retry does not write a second one
  const divider = `Moved from: ${titleOf(fromItem, fromId)}`;
  if (fresh.length) {
    // Images are copied under the target's next numbers; every reference is rewritten.
    const files = [...new Set(fresh.flatMap(m => m.images))];
    const loaded = (await Promise.all(files.map(async f => ({ f, bytes: await readOrNull(join(from, f)) })))).filter((x): x is { f: string; bytes: Buffer } => x.bytes !== null);
    const names = await saveImages(into, loaded.map(x => ({ bytes: x.bytes, ext: x.f.slice(x.f.lastIndexOf('.') + 1) as Extension })));
    const renamed = new Map(loaded.map((x, i) => [x.f, names[i]!]));
    let n = target.length;
    const lines: Message[] = target.some(m => m.divider && m.moved_from === `${key}`) ? [] : [{ id: `m${++n}`, author: 'agent', text: divider, images: [], created_at: new Date().toISOString(), divider: true, moved_from: key }];
    for (const m of fresh) copied.set(m.id, `m${++n}`);
    // The question table covers the whole move, including a question copied on an earlier attempt, before any answer is rewritten.
    const questions = new Map(moving.flatMap(m => (m.question ? [[m.question.id, `q${Number(copied.get(m.id)!.slice(1))}`] as const] : [])));
    for (const m of fresh) {
      const copy: Message = { ...m, id: copied.get(m.id)!, images: m.images.flatMap(f => (renamed.has(f) ? [renamed.get(f)!] : [])), moved_from: `${fromId}/${m.id}` };
      applyCarry(m, copy, copied, questions, plan.ids); // a quote of a message that stayed behind is dropped
      lines.push(copy);
    }
    await appendFile(join(into, 'thread.jsonl'), lines.map(m => `${JSON.stringify(m)}\n`).join(''));
  }
  await moveChecklist(from, into, plan);
  // Commit: the stubs replace the originals in one atomic rewrite of the source's thread file.
  const stubText = `Moved to [${titleOf(intoItem, toId)}](#/${toId})`;
  const stubbed = source.map(m => (ids.has(m.id) ? { id: m.id, author: 'agent' as const, text: stubText, images: [], created_at: m.created_at, divider: true as const, moved_to: toId } : m));
  await writeAtomic(join(from, 'thread.jsonl'), stubbed.map(m => `${JSON.stringify(m)}\n`).join(''));
  // A moved message keeps its old time, so an acknowledgement of the target can wrongly cover it: like a merge, wait for the agent until it answers.
  if (unansweredUser(source, moving)) await writeAtomic(join(into, 'awaiting-agent.json'), JSON.stringify({ at: new Date().toISOString(), from: fromId }));
  if (moving.some(m => m.author === 'user')) await writeStatus(into, 'open');
  return { moved: moving.map(m => m.id) };
}

// ---- Profile: names and avatars for both sides, in <dir>/_profile/.
export const AVATAR = /^(user|agent)-avatar\.(png|jpg|webp)$/;
export function imageSize(bytes: Buffer, ext: Extension): { width: number; height: number } | null {
  try {
    if (ext === 'png') return bytes.length >= 24 ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null;
    if (ext === 'jpg') {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) return null;
        const marker = bytes[i + 1]!;
        if (marker === 0xff) { i++; continue; }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
        i += 2 + bytes.readUInt16BE(i + 2);
      }
      return null;
    }
    const kind = bytes.subarray(12, 16).toString('latin1');
    if (kind === 'VP8X') return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (kind === 'VP8L') { const b = bytes.subarray(21, 25); return { width: 1 + (b[0]! | ((b[1]! & 0x3f) << 8)), height: 1 + ((b[1]! >> 6) | (b[2]! << 2) | ((b[3]! & 0xf) << 10)) }; }
    if (kind === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  } catch { /* too short */ }
  return null;
}
function avatarImage(value: unknown): Image {
  const match = typeof value === 'string' ? DATA_URL.exec(value) : null;
  if (!match) throw new Invalid('Expected a PNG, JPEG or WebP data URL');
  const bytes = Buffer.from(match[2]!, 'base64');
  if (bytes.length > MAX_AVATAR_BYTES) throw new Invalid('Avatar exceeds 2 MB', 413);
  const image = checkedImage(bytes);
  if (image.ext !== DECLARED[match[1]!]) throw new Invalid('Image does not match its declared type');
  const size = imageSize(bytes, image.ext);
  if (!size || size.width < 1 || size.width !== size.height) throw new Invalid('Avatar must be a square image');
  return image;
}
export interface Profile { user: { name: string; avatar?: string }; agent: { name: string; avatar?: string } }
async function avatarFile(dir: string, who: 'user' | 'agent'): Promise<{ name: string; mtime: number } | null> {
  try {
    for (const name of await readdir(join(dir, '_profile'))) {
      const m = AVATAR.exec(name);
      if (m && m[1] === who) return { name, mtime: (await stat(join(dir, '_profile', name))).mtimeMs };
    }
  } catch { /* no profile yet */ }
  return null;
}
export async function readProfile(dir: string, prefix = '/__feedback/api'): Promise<Profile> {
  let name = 'You';
  try { const v = JSON.parse(await optional(join(dir, '_profile', 'profile.json')) ?? 'null'); if (isObject(v) && str(v.name, MAX_NAME)) name = (v.name as string).trim(); } catch { /* defaults */ }
  const url = async (who: 'user' | 'agent') => { const f = await avatarFile(dir, who); return f ? { avatar: `${prefix}/profile/avatar/${who}?v=${Math.round(f.mtime)}` } : {}; };
  return { user: { name, ...await url('user') }, agent: { name: process.env.FEEDBACK_AGENT_NAME?.trim() || 'Agent', ...await url('agent') } };
}
async function setAvatar(dir: string, who: 'user' | 'agent', image: Image | null): Promise<void> {
  const folder = join(dir, '_profile');
  await mkdir(folder, { recursive: true });
  for (const old of await readdir(folder)) { const m = AVATAR.exec(old); if (m && m[1] === who) await rm(join(folder, old), { force: true }); }
  if (image) await writeFile(join(folder, `${who}-avatar.${image.ext}`), image.bytes);
}
export async function updateProfile(dir: string, data: { name?: unknown; avatar?: unknown }): Promise<Profile> {
  if (data.name !== undefined && !str(data.name, MAX_NAME)) throw new Invalid(`Name must be 1–${MAX_NAME} characters`);
  const image = data.avatar === undefined || data.avatar === null ? null : avatarImage(data.avatar);
  await mkdir(join(dir, '_profile'), { recursive: true });
  if (data.name !== undefined) await writeFile(join(dir, '_profile', 'profile.json'), JSON.stringify({ name: (data.name as string).trim() }));
  if (data.avatar !== undefined) await setAvatar(dir, 'user', image);
  return readProfile(dir);
}
export async function setAgentAvatar(dir: string, bytes: Buffer): Promise<void> {
  const image = checkedImage(bytes);
  if (bytes.length > MAX_AVATAR_BYTES) throw new Invalid('Avatar exceeds 2 MB');
  const size = imageSize(bytes, image.ext);
  if (!size || size.width !== size.height) throw new Invalid('Avatar must be a square image');
  await setAvatar(dir, 'agent', image);
}
export async function avatarBytes(dir: string, who: string): Promise<{ bytes: Buffer; ext: Extension } | null> {
  if (who !== 'user' && who !== 'agent') return null;
  const f = await avatarFile(dir, who);
  if (!f) return null;
  return { bytes: await readFile(join(dir, '_profile', f.name)), ext: AVATAR.exec(f.name)![2] as Extension };
}

export interface Summary {
  id: string; title: string; origin: Author; mode: string; status: Status; created_at: string; url: string | null;
  last_message_at: string; last_author: Author; unread_for_user: boolean; user_read_at: string | null; agent_read_at: string | null;
  // `waiting` follows the main flow only, except that an unanswered side question makes it 'agent' (unless the main flow waits on you); `waiting_aside` (only present when true) says an aside is waiting.
  open_question: boolean; waiting: 'agent' | 'you' | 'idle' | 'done';
  last_flag: Flag | null; waiting_aside?: true; checklist: ChecklistCounts; open_for_you: number; merged_into: string | null; read_only: boolean; acked_through: string | null;
}
// A thread is unread for the user only when a message that needs them (a `needs_you` flag or an unanswered question) arrived after they last read.
const needsUser = (m: Message, answered: Set<string>) => m.author === 'agent' && !m.question?.withdrawn && !m.question?.reasked && (m.flag === 'needs_you' || (questionLive(m.question) && !answered.has(m.question.id)));
// Waiting on you: a `needs_you` message or unanswered question since you last spoke, or (when you have not just spoken) an open, unclaimed item of yours.
// Waiting for the agent: you spoke last (and the agent has not acknowledged it), you claimed something it has not checked, or a merge left something unanswered (`awaitAgent`) and no agent message has come since.
function waitingOn(status: Status, messages: Message[], items: ChecklistItem[], awaitAgent: string | null, readOnly: boolean, ackedThrough: string | null): Summary['waiting'] {
  if (status === 'done') return 'done';
  if (readOnly) return 'idle';
  const answered = new Set(messages.flatMap(m => (m.answer ? [m.answer.question_id] : [])));
  const lastUser = messages.map(m => m.author).lastIndexOf('user');
  if (messages.slice(lastUser + 1).some(m => needsUser(m, answered))) return 'you';
  const pendingMerge = awaitAgent !== null && !messages.some(m => m.author === 'agent' && !m.divider && m.created_at > awaitAgent);
  const last = messages[messages.length - 1];
  const handled = !!last && last.author === 'user' && ackedThrough !== null && last.created_at <= ackedThrough; // the agent acknowledged it without replying
  if ((last?.author !== 'agent' && !handled) || items.some(i => !i.done && i.claimed_by_user_at) || pendingMerge) return 'agent';
  if (items.some(i => i.owner === 'user' && !i.done && !i.claimed_by_user_at)) return 'you';
  return 'idle';
}
export async function summarise(dir: string, id: string): Promise<{ summary: Summary; messages: Message[]; item: ItemData; path: string }> {
  const path = await itemDir(dir, id);
  const item = await readItem(path);
  const messages = await readMessages(path, item);
  const main = mainMessages(messages).filter(m => !m.moved_to && m.kind !== 'share_notice'); // asides, move stubs and share notices never decide who spoke last
  const last = main[main.length - 1];
  const created_at = item.created_at as string;
  const last_author: Author = last?.author ?? 'user';
  const last_message_at = lastAt(messages, item);
  const read = await readAt(path, 'read.json');
  const items = await readChecklist(path);
  const answered = new Set(messages.flatMap(m => (m.answer ? [m.answer.question_id] : [])));
  const lastAgent = [...main].reverse().find(m => m.author === 'agent');
  const title = typeof item.title === 'string' && item.title ? item.title : String(item.note ?? '').split('\n')[0] || id;
  const context = isObject(item.context) ? item.context : {};
  const readOnly = item.read_only === true;
  const acked = await readAcked(path);
  const summary: Summary = { id, title, origin: item.origin === 'agent' ? 'agent' : 'user', mode: item.mode as string, status: await readStatus(path),
    created_at, url: typeof context.url === 'string' ? context.url : null, last_message_at, last_author,
    unread_for_user: messages.some(m => (m.kind === 'share_notice' || (readOnly ? m.author === 'agent' && !m.divider : needsUser(m, answered))) && (read === null || m.created_at > read)), user_read_at: read, // a read-only thread's updates all count; a share notice does too
    agent_read_at: await readAgentAt(path), open_question: openQuestions(messages).length > 0, waiting: 'done',
    last_flag: lastAgent?.flag ?? null, checklist: checklistCounts(items), open_for_you: items.filter(i => i.owner === 'user' && !i.done && !i.claimed_by_user_at).length,
    merged_into: (await readMerge(path))?.state === 'done' ? (await readMerge(path))!.into : null, read_only: readOnly, acked_through: acked };
  const awaitAt = await readAwait(path);
  summary.waiting = main.length === 0 && messages.some(m => m.moved_to) ? (summary.status === 'done' ? 'done' : 'idle') : waitingOn(summary.status, main, items, awaitAt, readOnly, acked);
  const awaiting = awaitAt !== null && !messages.some(m => m.author === 'agent' && !m.divider && m.created_at > awaitAt); // a merge or move brought something the agent has not answered: an old ack does not cover it
  const asideWaiting = !readOnly && !summary.merged_into && asideGroups(messages, awaiting ? null : acked).some(g => !g.answered);
  if (asideWaiting) { summary.waiting_aside = true; if (summary.waiting !== 'you') summary.waiting = 'agent'; }
  return { summary, messages, item, path };
}
export async function listThreads(dir: string, query?: string): Promise<Summary[]> {
  let entries: string[];
  try { entries = await readdir(dir); }
  catch (error) { if (code(error) === 'ENOENT') return []; throw error; }
  const q = query?.trim().toLowerCase();
  const out: Summary[] = [];
  for (const id of entries.filter(entry => ID.test(entry))) {
    try {
      const { summary, messages } = await summarise(dir, id);
      if (q && !summary.title.toLowerCase().includes(q) && !messages.some(m => m.text.toLowerCase().includes(q))) continue;
      out.push(summary);
    } catch { /* a broken folder must not hide the rest */ }
  }
  return out.sort((a, b) => b.last_message_at.localeCompare(a.last_message_at) || b.id.localeCompare(a.id));
}

// ---- Presence: when the user last had the inbox open and when each agent last did something. Timestamps only (no address, no browser, no thread).
// One small file per writer in <dir>/_presence/, so two writers never overwrite each other: `user.json` and `agent[-<name>-<hash>].json`.
export const PRESENCE_USER_GAP_MS = 60e3;
export const PRESENCE_AGENT_GAP_MS = 5e3;
const MAX_PRESENCE_AGENTS = 20;
export interface Presence { user: { at: string } | null; agents: { name: string | null; at: string }[] }
const presenceFile = (who: { agent: string | undefined } | 'user') => (who === 'user' ? 'user.json' : agentReadFile(who.agent).replace(/^agent-read/, 'agent'));
// Records activity; written at most once per gap (a minute for the user). It never throws: presence is never a reason for a request to fail.
export async function touchPresence(dir: string, who: { agent: string | undefined } | 'user', now: number = Date.now()): Promise<void> {
  try {
    if (!(await stat(dir).then(x => x.isDirectory(), () => false))) return; // never create the data folder: a wrong FEEDBACK_DIR must not leave one behind
    const folder = join(dir, '_presence'), file = join(folder, presenceFile(who));
    const gap = who === 'user' ? PRESENCE_USER_GAP_MS : PRESENCE_AGENT_GAP_MS;
    try { const v = JSON.parse(await optional(file) ?? 'null'); if (isObject(v) && typeof v.at === 'string' && now - Date.parse(v.at) < gap && Date.parse(v.at) <= now) return; } catch { /* rewrite it */ }
    await mkdir(folder, { recursive: true });
    await writeAtomic(file, JSON.stringify({ ...(who !== 'user' && who.agent ? { name: who.agent } : {}), at: new Date(now).toISOString() }));
  } catch { /* best effort */ }
}
export async function readPresence(dir: string): Promise<Presence> {
  const out: Presence = { user: null, agents: [] };
  const read = async (name: string) => { try { const v = JSON.parse(await optional(join(dir, '_presence', name)) ?? 'null'); return isObject(v) && typeof v.at === 'string' && !Number.isNaN(Date.parse(v.at)) ? v : null; } catch { return null; } };
  const user = await read('user.json');
  if (user) out.user = { at: user.at as string };
  let names: string[] = [];
  try { names = await readdir(join(dir, '_presence')); } catch { return out; }
  for (const name of names.filter(n => /^agent(-[a-z0-9-]+)?\.json$/.test(n)).slice(0, MAX_PRESENCE_AGENTS)) {
    const v = await read(name);
    if (v) out.agents.push({ name: typeof v.name === 'string' && v.name && v.name.length <= MAX_NAME ? v.name : null, at: v.at as string });
  }
  out.agents.sort((x, y) => y.at.localeCompare(x.at));
  return out;
}
