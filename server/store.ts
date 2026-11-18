// The on-disk thread format, shared by the HTTP server and the agent CLI.
// Each item folder holds `thread.jsonl` (append-only messages) and `msg-<n>.<ext>` images.
import { appendFile, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { KEY } from './inbox/areas.js';

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
export interface Question { id: string; prompt: string; options: QuestionOption[]; multi: boolean; allow_other: boolean }
export interface Answer { question_id: string; option_ids: string[]; other_text?: string }
export const FLAGS = ['needs_you', 'done', 'fyi'] as const;
export type Flag = (typeof FLAGS)[number];
export const checkFlag = (value: unknown): Flag => {
  if (typeof value !== 'string' || !(FLAGS as readonly string[]).includes(value)) throw new Invalid('flag must be needs_you, done or fyi');
  return value as Flag;
};
export interface Message { id: string; author: Author; text: string; images: string[]; created_at: string; flag?: Flag; divider?: boolean; question?: Question; answer?: Answer }
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
  return { id: q.id, prompt: q.prompt, options, multi: q.multi === true, allow_other: q.allow_other !== false };
}
function parseAnswer(a: unknown): Answer | undefined {
  if (!isObject(a) || typeof a.question_id !== 'string' || !Array.isArray(a.option_ids)) return undefined;
  return { question_id: a.question_id, option_ids: a.option_ids.filter((x): x is string => typeof x === 'string'), ...(typeof a.other_text === 'string' ? { other_text: a.other_text } : {}) };
}
export function openQuestions(messages: Message[]): Question[] {
  const answered = new Set(messages.flatMap(m => (m.answer ? [m.answer.question_id] : [])));
  return messages.flatMap(m => (m.author === 'agent' && m.question && !answered.has(m.question.id) ? [m.question] : []));
}
// Checks an answer against the thread's open questions; returns the readable text.
export function checkAnswer(messages: Message[], raw: unknown): { answer: Answer; text: string; labels: string[] } {
  if (!isObject(raw) || typeof raw.question_id !== 'string') throw new Invalid('Answer needs a question_id');
  const asked = messages.find(m => m.author === 'agent' && m.question?.id === raw.question_id)?.question;
  if (!asked) throw new Invalid('No such question', 404);
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
          ...(flag ? { flag } : {}), ...(m.divider === true ? { divider: true } : {}), ...(question ? { question } : {}), ...(answer ? { answer } : {}) });
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
async function materialise(path: string, item: ItemData): Promise<Message[]> {
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
async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
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
async function saveImages(path: string, images: Image[]): Promise<string[]> {
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
export async function logEvent(dir: string, event: { id: string; kind: 'message' | 'thread' | 'answer' | 'checklist' | 'checklist_claim' | 'merge'; text: string }): Promise<void> {
  await mkdir(dir, { recursive: true });
  const first_line = event.text.split('\n')[0]!.slice(0, 200) || '[image]';
  await appendFile(join(dir, '_events.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), id: event.id, author: 'user', kind: event.kind, first_line })}\n`);
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
// The agent can acknowledge the user's latest message without replying: `acked_through` in agent-read.json is its time.
async function readAcked(path: string): Promise<string | null> {
  const v = await readMarker(path, 'agent-read.json');
  return typeof v.acked_through === 'string' ? v.acked_through : null;
}
// The newest time in the thread, not the last line's: a merge copies older messages after its divider, and the clock must not go back.
const lastAt = (messages: Message[], item: ItemData) => messages.reduce((hi, m) => (m.created_at > hi ? m.created_at : hi), item.created_at as string);

export const READ_ONLY_NOTE = 'This thread is read-only: it only carries updates from the agent, so you cannot reply here.';
export interface NewMessage { author: Author; text: unknown; images?: Image[]; question?: QuestionInput; answer?: unknown; flag?: unknown }
// Only the agent flags messages. A question is `needs_you` unless said otherwise; anything else is `fyi`.
function messageFlag(author: Author, flag: unknown, asking: boolean): Flag | undefined {
  if (author !== 'agent') { if (flag !== undefined) throw new Invalid('Only the agent can flag a message', 403); return undefined; }
  return flag === undefined ? (asking ? 'needs_you' : 'fyi') : checkFlag(flag);
}
// A `done` message closes the thread, unless the user still has open items of their own.
async function closeForDone(path: string): Promise<void> {
  if (!(await readChecklist(path)).some(i => i.owner === 'user' && !i.done)) await writeStatus(path, 'done');
}
export async function appendMessage(dir: string, id: string, input: NewMessage): Promise<Message> {
  const images = input.images ?? [];
  const path = await itemDir(dir, id);
  if (input.question && input.author !== 'agent') throw new Invalid('Only the agent can ask questions', 403);
  if (input.answer && input.author !== 'user') throw new Invalid('Only the user can answer', 403);
  const flag = messageFlag(input.author, input.flag, !!input.question);
  let eventKind: 'message' | 'answer' = 'message';
  let eventText = '';
  const message = await withLock(path, async () => {
    const item = await readItem(path);
    if (input.author === 'user' && item.read_only === true) throw new Invalid(READ_ONLY_NOTE, 409);
    if (input.question && item.read_only === true) throw new Invalid('A read-only thread cannot hold a question: nobody could answer it', 409);
    const stored = await materialise(path, item);
    const n = stored.length + 1;
    let text = input.answer !== undefined || input.question ? '' : messageText(input.text, images.length > 0);
    let extra: Partial<Message> = {};
    if (input.question) { text = messageText(input.text ?? input.question.prompt, false); extra = { question: buildQuestion(`q${n}`, input.question) }; }
    if (input.answer !== undefined) {
      const checked = checkAnswer(stored, input.answer);
      text = checked.text; extra = { answer: checked.answer };
      eventKind = 'answer'; eventText = `${checked.answer.question_id}: ${checked.labels.join(', ')}`;
    }
    const created: Message = { id: `m${n}`, author: input.author, text, images: await saveImages(path, images), created_at: new Date().toISOString(), ...(flag ? { flag } : {}), ...extra };
    await appendFile(join(path, 'thread.jsonl'), `${JSON.stringify(created)}\n`);
    // replying means that side read everything before it
    if (input.author === 'agent' || stored[stored.length - 1]?.author === 'agent') await stampRead(path, input.author === 'agent' ? 'agent-read.json' : 'read.json', lastAt(stored, item));
    if (flag === 'done') await closeForDone(path);
    if (input.author === 'user') await writeStatus(path, 'open'); // a user message reopens a done thread
    return created;
  });
  if (input.author === 'user') {
    await logEvent(dir, { id, kind: eventKind, text: (eventKind as string) === 'answer' ? eventText : message.text });
  }
  return message;
}
export interface NewThread { title: unknown; text: unknown; images?: Image[]; origin: Author; question?: QuestionInput; flag?: unknown; readOnly?: boolean }
export async function createThread(dir: string, input: NewThread): Promise<{ id: string }> {
  const images = input.images ?? [];
  const title = threadTitle(input.title);
  if (input.question && input.origin !== 'agent') throw new Invalid('Only the agent can ask questions', 403);
  const text = input.question ? messageText(input.text ?? input.question.prompt, false) : messageText(input.text, images.length > 0);
  if (input.readOnly && input.origin !== 'agent') throw new Invalid('Only the agent can start a read-only thread', 403);
  if (input.readOnly && input.question) throw new Invalid('A read-only thread cannot hold a question: nobody could answer it');
  const flag = messageFlag(input.origin, input.flag, !input.readOnly); // a thread the agent starts wants attention, unless it only carries updates
  const { id, path, created_at } = await makeItemFolder(dir);
  try {
    const message: Message = { id: 'm1', author: input.origin, text, images: await saveImages(path, images), created_at,
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
export async function markAgentRead(dir: string, id: string): Promise<string> {
  const path = await itemDir(dir, id);
  return withLock(path, async () => {
    const item = await readItem(path);
    const at = lastAt(await readMessages(path, item), item);
    await stampRead(path, 'agent-read.json', at);
    return at;
  });
}
// The agent has seen the user's latest message and has nothing to say: it stops waiting for the agent and shows two ticks.
// A later user message is newer than `acked_through`, so the thread waits again. Not a user event, so nothing is logged.
export async function ackThread(dir: string, id: string): Promise<{ acked_through: string }> {
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
    await writeAtomic(join(path, 'agent-read.json'), JSON.stringify({ ...old, at, acked_through: acked }));
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
async function changeChecklist<T>(dir: string, id: string, by: Author, fn: (items: ChecklistItem[]) => T): Promise<T> {
  const path = await itemDir(dir, id);
  return withLock(path, async () => {
    if (by === 'user' && (await readItem(path)).read_only === true) throw new Invalid(READ_ONLY_NOTE, 409);
    const items = await readChecklist(path);
    const result = fn(items);
    await writeAtomic(join(path, 'checklist.json'), JSON.stringify({ items }, null, 2));
    return result;
  });
}
function itemText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_ITEM_TEXT) throw new Invalid(`Item text must be 1–${MAX_ITEM_TEXT} characters`);
  return value.trim();
}
const find = (items: ChecklistItem[], itemId: string) => items.find(i => i.id === itemId) ?? (() => { throw new Invalid('No such item', 404); })();
const userEvent = (dir: string, id: string, kind: 'checklist' | 'checklist_claim', text: string) => logEvent(dir, { id, kind, text });
export async function addChecklistItem(dir: string, id: string, input: { owner: unknown; text: unknown; by: Author }): Promise<ChecklistItem> {
  if (!isAuthor(input.owner)) throw new Invalid('owner must be "user" or "agent"');
  const text = itemText(input.text);
  const item = await changeChecklist(dir, id, input.by, items => {
    if (items.length >= MAX_ITEMS) throw new Invalid(`A checklist holds at most ${MAX_ITEMS} items`);
    let n = items.reduce((m, i) => Math.max(m, Number(/^c(\d+)$/.exec(i.id)?.[1] ?? 0)), 0);
    const created: ChecklistItem = { id: `c${++n}`, owner: input.owner as Author, text, done: false, created_by: input.by, created_at: new Date().toISOString() };
    items.push(created);
    return created;
  });
  if (input.by === 'user') await userEvent(dir, id, 'checklist', `add (${item.owner === 'user' ? 'for you' : 'for the agent'}): ${item.text}`);
  return item;
}
export interface ChecklistPatch { text?: unknown; done?: unknown; claimed?: unknown; note?: unknown }
// The user may edit the text of their own items and claim or withdraw a claim on any item; they can never set `done`.
// The agent may tick, untick, edit anything, and unclaim (with a note saying what is missing).
export async function patchChecklistItem(dir: string, id: string, itemId: string, patch: ChecklistPatch, by: Author): Promise<ChecklistItem> {
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
  });
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
interface MergeNote { into: string; at: string; state: 'copying' | 'done'; base: number; await_agent: boolean }
async function readMerge(path: string): Promise<MergeNote | null> {
  try {
    const v = JSON.parse(await optional(join(path, 'merged.json')) ?? 'null');
    if (!isObject(v) || typeof v.into !== 'string' || typeof v.at !== 'string') return null;
    return { into: v.into, at: v.at, state: v.state === 'copying' ? 'copying' : 'done', base: typeof v.base === 'number' ? v.base : 0, await_agent: v.await_agent === true };
  } catch { return null; }
}
// On the target: a merge brought in something the agent has not answered. Only an agent message after `at` clears it.
async function readAwait(path: string): Promise<string | null> {
  try { const v = JSON.parse(await optional(join(path, 'awaiting-agent.json')) ?? 'null'); return isObject(v) && typeof v.at === 'string' ? v.at : null; } catch { return null; }
}
const titleOf = (item: ItemData, id: string) => (typeof item.title === 'string' && item.title ? item.title : String(item.note ?? '').split('\n')[0] || id);
async function readOrNull(path: string): Promise<Buffer | null> {
  try { return await readFile(path); } catch (error) { if (code(error) === 'ENOENT') return null; throw error; }
}
async function copyMessages(from: string, into: string, source: Message[], target: Message[], at: string, divider: string): Promise<void> {
  // Images are copied under new numbers (the target's msg-<n> names), then every reference is rewritten.
  const wanted = [...new Set(source.flatMap(m => m.images))];
  const loaded = (await Promise.all(wanted.map(async f => ({ f, bytes: await readOrNull(join(from, f)) })))).filter((x): x is { f: string; bytes: Buffer } => x.bytes !== null);
  const names = await saveImages(into, loaded.map(x => ({ bytes: x.bytes, ext: x.f.slice(x.f.lastIndexOf('.') + 1) as Extension })));
  const renamed = new Map(loaded.map((x, i) => [x.f, names[i]!]));
  let n = target.length;
  const lines: Message[] = [{ id: `m${++n}`, author: 'agent', text: divider, images: [], created_at: at, divider: true }];
  const questions = new Map<string, string>();
  for (const m of source) {
    const id = `m${++n}`;
    const copy: Message = { ...m, id, images: m.images.flatMap(f => (renamed.has(f) ? [renamed.get(f)!] : [])) };
    if (m.question) { questions.set(m.question.id, `q${n}`); copy.question = { ...m.question, id: `q${n}` }; }
    if (m.answer) copy.answer = { ...m.answer, question_id: questions.get(m.answer.question_id) ?? m.answer.question_id };
    lines.push(copy);
  }
  await appendFile(join(into, 'thread.jsonl'), lines.map(m => `${JSON.stringify(m)}\n`).join(''));
}
async function moveChecklist(from: string, into: string): Promise<void> {
  const moving = await readChecklist(from);
  if (!moving.length) return;
  const existing = await readChecklist(into);
  const same = (a: ChecklistItem, b: ChecklistItem) => a.owner === b.owner && a.created_at === b.created_at && a.text === b.text; // already moved by an earlier attempt
  const fresh = moving.filter(i => !existing.some(e => same(e, i)));
  if (existing.length + fresh.length > MAX_ITEMS) throw new Invalid(`The merged checklist would hold more than ${MAX_ITEMS} items`);
  let c = existing.reduce((hi, i) => Math.max(hi, Number(/^c(\d+)$/.exec(i.id)?.[1] ?? 0)), 0);
  await writeAtomic(join(into, 'checklist.json'), JSON.stringify({ items: [...existing, ...fresh.map(i => ({ ...i, id: `c${++c}` }))] }, null, 2));
  await writeAtomic(join(from, 'checklist.json'), JSON.stringify({ items: [] }, null, 2));
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
  const copied = target[note.base]?.divider === true && target[note.base]!.text === divider;
  if (!copied) await copyMessages(from, into, source, target.slice(0, note.base), note.at, divider);
  await moveChecklist(from, into);
  if (note.await_agent) {
    await writeAtomic(join(into, 'awaiting-agent.json'), JSON.stringify({ at: note.at, from: fromId }));
    await writeStatus(into, 'open');
  }
  const farewellText = `Merged into [${titleOf(intoItem, intoId)}](#/${intoId})`;
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
  open_question: boolean; waiting: 'agent' | 'you' | 'idle' | 'done';
  last_flag: Flag | null; checklist: ChecklistCounts; open_for_you: number; merged_into: string | null; read_only: boolean; acked_through: string | null;
}
// A thread is unread for the user only when a message that needs them (a `needs_you` flag or an unanswered question) arrived after they last read.
const needsUser = (m: Message, answered: Set<string>) => m.author === 'agent' && (m.flag === 'needs_you' || (!!m.question && !answered.has(m.question.id)));
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
  const last = messages[messages.length - 1];
  const created_at = item.created_at as string;
  const last_author: Author = last?.author ?? 'user';
  const last_message_at = lastAt(messages, item);
  const read = await readAt(path, 'read.json');
  const items = await readChecklist(path);
  const answered = new Set(messages.flatMap(m => (m.answer ? [m.answer.question_id] : [])));
  const lastAgent = [...messages].reverse().find(m => m.author === 'agent');
  const title = typeof item.title === 'string' && item.title ? item.title : String(item.note ?? '').split('\n')[0] || id;
  const context = isObject(item.context) ? item.context : {};
  const readOnly = item.read_only === true;
  const acked = await readAcked(path);
  const summary: Summary = { id, title, origin: item.origin === 'agent' ? 'agent' : 'user', mode: item.mode as string, status: await readStatus(path),
    created_at, url: typeof context.url === 'string' ? context.url : null, last_message_at, last_author,
    unread_for_user: messages.some(m => (readOnly ? m.author === 'agent' && !m.divider : needsUser(m, answered)) && (read === null || m.created_at > read)), user_read_at: read, // a read-only thread's updates all count
    agent_read_at: await readAt(path, 'agent-read.json'), open_question: openQuestions(messages).length > 0, waiting: 'done',
    last_flag: lastAgent?.flag ?? null, checklist: checklistCounts(items), open_for_you: items.filter(i => i.owner === 'user' && !i.done && !i.claimed_by_user_at).length,
    merged_into: (await readMerge(path))?.state === 'done' ? (await readMerge(path))!.into : null, read_only: readOnly, acked_through: acked };
  summary.waiting = waitingOn(summary.status, messages, items, await readAwait(path), readOnly, acked);
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
