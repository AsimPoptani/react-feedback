// Sensitive messages: redaction into a vault, restore, and the non-secret record of a saved key.
// The vault (FEEDBACK_VAULT_DIR) lives outside FEEDBACK_DIR, is never served over HTTP, and holds one file per redacted message
// (directory 0700, files 0600, written atomically). A key's value is never handled here: the inbox sends it straight to the app.
import { realpathSync } from 'node:fs';
import { chmod, mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as store from './store';
import { copyVaultFiles, filesFromVault, filesToVault, removeVaultFiles } from './files';
import { readStored, serialise } from './reminders';
import { Invalid, ID, MAX_HINT, isMessageQuote, type Author, type Message, type Redaction } from './store';

const REDACTED = '[redacted]';

// Secret-like text. Used before an agent share, and by the inbox to warn before a person shares. The match itself is never returned.
const SECRET_SHAPES: { name: string; re: RegExp }[] = [
  { name: 'an API key', re: /\bsk-(?:live|test|or-v1|ant|proj)-[A-Za-z0-9_-]{8,}\b/ },
  { name: 'an API key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'a private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'an access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'a token', re: /\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{16,}\b/ },
  { name: 'a token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'a password or token', re: /(?:\bapi[_-]?key\b|\bsecret\b|\bpassword\b|\bpasswd\b|\btoken\b)\s*[:=]\s*['"]?[A-Za-z0-9/+_.=-]{8,}/i },
];
// The kind of secret, or null. Callers refuse an agent share, or warn a person, without echoing the text.
export function scanForSecrets(text: string): string | null {
  for (const shape of SECRET_SHAPES) if (shape.re.test(text)) return shape.name;
  return null;
}
// A vault file is `<thread>/<message>`, or `<project>/<thread>/<message>` once the thread has moved to that project.
const KEY = /^(?:[a-z0-9][a-z0-9_-]{0,39}\/)?\d{8}-\d{6}-[0-9a-f]{4}\/m\d+$/;

// The real path of something that may not exist yet: its nearest existing parent, resolved, plus the rest.
async function real(path: string): Promise<string> {
  const abs = resolve(path);
  try { return await realpath(abs); } catch { const parent = dirname(abs); return parent === abs ? abs : join(await real(parent), basename(abs)); }
}
const inside = (parent: string, child: string) => { const r = relative(parent, child); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };

// FEEDBACK_VAULT_DIR, or null when it is unset. It must sit outside FEEDBACK_DIR (and FEEDBACK_DIR outside it), or the inbox data could include it.
export async function checkVault(dir: string, vault: string | null | undefined): Promise<string> {
  if (!vault) throw new Invalid('Redaction is not set up on this server: set FEEDBACK_VAULT_DIR', 409);
  const [v, d] = await Promise.all([real(vault), real(dir)]);
  if (inside(d, v) || inside(v, d)) throw new Invalid('FEEDBACK_VAULT_DIR must be outside FEEDBACK_DIR', 409);
  return v;
}
const realSync = (path: string): string => { const abs = resolve(path); try { return realpathSync(abs); } catch { const parent = dirname(abs); return parent === abs ? abs : join(realSync(parent), basename(abs)); } };
// Startup check: throws on a vault inside the data folder (or the data folder inside it), so a bad config stops the server.
export function validateVault(dir: string, vault: string | null | undefined): void {
  if (!vault) return;
  const [v, d] = [realSync(vault), realSync(dir)];
  if (inside(d, v) || inside(v, d)) throw new Invalid('FEEDBACK_VAULT_DIR must be outside FEEDBACK_DIR');
}

async function writeVault(vault: string, key: string, data: unknown): Promise<void> {
  if (!KEY.test(key)) throw new Invalid('Invalid vault key');
  const file = join(vault, `${key}.json`);
  const folder = dirname(file);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const root = resolve(vault);
  for (let dir = folder; ; dir = dirname(dir)) {
    await chmod(dir, 0o700);
    if (resolve(dir) === root) break;
    if (dirname(dir) === dir) break;
  }
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  } catch (error) { await rm(tmp, { force: true }); throw error; }
}
// Copies one vault entry to the key it will have in the target project. The old file stays until the move has committed.
export async function copyVaultEntry(vault: string, oldKey: string, newKey: string, thread: string): Promise<void> {
  if (!KEY.test(oldKey) || !KEY.test(newKey)) throw new Invalid('Invalid vault key');
  if (oldKey === newKey) return;
  const from = join(vault, `${oldKey}.json`), to = join(vault, `${newKey}.json`);
  let raw: string;
  try { raw = await readFile(from, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try { await readFile(to); return; } catch { throw new Invalid(`The vault has no entry at ${oldKey}`, 404); }
  }
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new Invalid(`The vault entry ${oldKey} is unreadable`); }
  if (data && typeof data === 'object' && !Array.isArray(data)) (data as Record<string, unknown>).thread = thread;
  await writeVault(vault, newKey, data);
  await copyVaultFiles(vault, oldKey, newKey); // the files of a redacted attachment follow their entry
}
export async function removeVaultEntry(vault: string, key: string): Promise<void> {
  if (!KEY.test(key)) return;
  const file = join(vault, `${key}.json`);
  await rm(file, { force: true });
  await removeVaultFiles(vault, key);
  const root = resolve(vault);
  for (let dir = dirname(file); resolve(dir) !== root; dir = dirname(dir)) {
    try { await rm(dir); } catch { break; }
    if (dirname(dir) === dir) break;
  }
}
async function readVault(vault: string, key: string): Promise<{ message: Message; images: { name: string; data: string }[]; item_note?: string } | null> {
  if (!KEY.test(key)) return null;
  try { return JSON.parse(await readFile(join(vault, `${key}.json`), 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

// The user's `_events.jsonl` lines hold a message's first line. Blank it in place and keep every line's byte length, so anything following the file by offset stays in step.
async function scrubEvents(dir: string, thread: string, firstLines: Set<string>, answerPrefix?: string | string[]): Promise<void> {
  const file = join(dir, '_events.jsonl');
  let raw: Buffer;
  try { raw = await readFile(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const patches: { at: number; bytes: Buffer }[] = [];
  let offset = 0;
  for (const line of raw.toString('utf8').split('\n')) {
    const length = Buffer.byteLength(line);
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      const prefixes = answerPrefix === undefined ? [] : (Array.isArray(answerPrefix) ? answerPrefix : [answerPrefix]);
      if (e.id === thread && typeof e.first_line === 'string' && (firstLines.has(e.first_line) || (e.kind === 'answer' && prefixes.some(prefix => (e.first_line as string).startsWith(prefix)))) && e.first_line !== REDACTED) {
        let blank = e.first_line.length < REDACTED.length ? '*'.repeat(e.first_line.length) : REDACTED;
        let next = JSON.stringify({ ...e, first_line: blank });
        while (Buffer.byteLength(next) < length) { blank += ' '; next = JSON.stringify({ ...e, first_line: blank }); }
        if (Buffer.byteLength(next) === length) patches.push({ at: offset, bytes: Buffer.from(next) });
      }
    } catch { /* not a JSON line */ }
    offset += length + 1;
  }
  if (!patches.length) return;
  const handle = await open(file, 'r+');
  try { for (const p of patches) await handle.write(p.bytes, 0, p.bytes.length, p.at); } finally { await handle.close(); }
}
// A reminder repeats words the user may have written (a `say` that quotes a message), in the thread's reminders.json and as events in _events.jsonl.
// Every line of the redacted text (4 characters or more) is blanked wherever it appears there, with stars of the same length, so event lines keep their byte length.
const needlesOf = (text: string) => [...new Set(text.split('\n').map(l => l.trim()).filter(l => l.length >= 4))].sort((a, b) => b.length - a.length);
function blankNeedles(text: string, needles: string[], truncated = false): string {
  let out = text;
  for (const n of needles) {
    out = out.split(n).join('*'.repeat(n.length));
    if (truncated) for (let k = Math.min(n.length - 1, out.length); k >= 4; k--) if (out.endsWith(n.slice(0, k))) { out = out.slice(0, out.length - k) + '*'.repeat(k); break; } // an event line cut the text short
  }
  return out;
}
async function scrubReminders(dir: string, path: string, thread: string, text: string): Promise<void> {
  const needles = needlesOf(text);
  if (!needles.length) return;
  const stored = await readStored(path);
  let changed = false;
  for (const r of stored.items) { const say = blankNeedles(r.say, needles); if (say !== r.say) { r.say = say; changed = true; } }
  for (const f of stored.fired) { const t = blankNeedles(f.text, needles); if (t !== f.text) { f.text = t; changed = true; } }
  if (changed) await store.writeAtomic(join(path, 'reminders.json'), serialise(stored));
  const file = join(dir, '_events.jsonl');
  let raw: Buffer;
  try { raw = await readFile(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const patches: { at: number; bytes: Buffer }[] = [];
  let offset = 0;
  for (const line of raw.toString('utf8').split('\n')) {
    const length = Buffer.byteLength(line);
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      if (e.id === thread && e.kind === 'reminder' && typeof e.first_line === 'string') {
        const blank = blankNeedles(e.first_line, needles, true);
        if (blank !== e.first_line) {
          let first = blank, next = JSON.stringify({ ...e, first_line: first });
          while (Buffer.byteLength(next) < length) { first += ' '; next = JSON.stringify({ ...e, first_line: first }); }
          while (Buffer.byteLength(next) > length && first.length) { first = first.slice(0, -1); next = JSON.stringify({ ...e, first_line: first }); }
          if (Buffer.byteLength(next) === length) patches.push({ at: offset, bytes: Buffer.from(next) });
        }
      }
    } catch { /* not a JSON line */ }
    offset += length + 1;
  }
  if (!patches.length) return;
  const handle = await open(file, 'r+');
  try { for (const p of patches) await handle.write(p.bytes, 0, p.bytes.length, p.at); } finally { await handle.close(); }
}
// feedback.md for an item: a thread-mode item is its title and note; a capture is the capture summary.
const feedbackFor = (item: Record<string, unknown>): string => (item.mode === 'thread' ? `${typeof item.title === 'string' ? item.title : ''}\n\n${String(item.note)}\n` : store.captureSummary(item));
const firstLine = (text: string) => text.split('\n')[0]!.slice(0, 200) || '[image]';

async function redactLocked(dir: string, id: string, msgId: string, vault: string, by: Author, reason: string | undefined): Promise<{ done: boolean; original?: Message; oldTitle?: string }> {
  const path = await store.itemDir(dir, id);
  return store.withLock(path, async () => {
    const item = await store.readItem(path);
    const stored = await store.materialise(path, item);
    const m = stored.find(x => x.id === msgId);
    if (!m) throw new Invalid(`No message ${msgId} in that thread`, 404);
    if (m.divider || m.moved_to) throw new Invalid(`${msgId} is a divider and cannot be redacted`);
    if (m.redacted) return { done: false, original: (await readVault(vault, m.redacted.key))?.message };
    if (by === 'user' && m.author !== 'user') throw new Invalid('You can only redact your own messages', 403);
    const key = `${id}/${msgId}`;
    const images: { name: string; data: string }[] = [];
    for (const name of m.images) { try { images.push({ name, data: (await readFile(join(path, name))).toString('base64') }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    const note = typeof item.note === 'string' && item.note === m.text && m.text !== '' ? item.note : undefined;
    await writeVault(vault, key, { thread: id, message: m, images, reason, by, at: new Date().toISOString(), ...(note !== undefined ? { item_note: note } : {}) });
    if (m.attachments?.length) await filesToVault(path, vault, key, m.attachments); // the files leave the thread: they are not served from the inbox again
    const redacted: Redaction = { at: new Date().toISOString(), by, key, ...(reason ? { reason: reason.slice(0, 200) } : {}) };
    const blank: Message = { ...m, text: '', images: [], redacted };
    if (m.question) blank.question = { ...m.question, prompt: REDACTED, options: m.question.options.map(o => ({ id: o.id, label: REDACTED })) };
    if (m.answer?.other_text) blank.answer = { ...m.answer, other_text: REDACTED };
    delete blank.secret; delete blank.kind; delete blank.attachments;
    if (isMessageQuote(m.quote)) delete blank.quote; // the words the user selected are part of what is being hidden
    await store.writeAtomic(join(path, 'thread.jsonl'), stored.map(x => `${JSON.stringify(x === m ? blank : x)}\n`).join(''));
    for (const name of m.images) await rm(join(path, name), { force: true });
    let oldTitle: string | undefined;
    if (note !== undefined) { // a thread that started with this message repeats it in item.json, feedback.md and (for a capture) its title
      const blanked = { ...item, note: REDACTED };
      await store.writeAtomic(join(path, 'item.json'), JSON.stringify(blanked, null, 2));
      await store.writeAtomic(join(path, 'feedback.md'), feedbackFor(blanked));
      if (typeof item.title !== 'string' || !item.title) oldTitle = note.split('\n')[0] || undefined; // a capture's title is its note's first line
    }
    const lines = new Set([firstLine(m.text), firstLine(`${typeof item.title === 'string' ? item.title : ''}: ${m.text}`)]);
    if (m.answer) { // an answer's event line is "q1: <labels>, <other text>"
      const asked = stored.find(x => x.question?.id === m.answer!.question_id)?.question;
      const labels = (m.answer.option_ids ?? []).flatMap(o => asked?.options.find(x => x.id === o)?.label ?? []);
      const parts = [...labels, ...(m.answer.other_text ? [m.answer.other_text] : [])];
      lines.add(firstLine(`${m.answer.question_id}: ${parts.join(', ')}`)); // lines written before the prompt was included
      lines.add(firstLine(store.answerLine(m.answer.question_id, asked?.prompt ?? '', parts)));
    }
    if (m.question) lines.add(firstLine(`${m.question.id} expired: ${m.question.prompt}`)); // an expired question's event repeats its prompt
    await scrubEvents(dir, id, lines, m.answer ? [`${m.answer.question_id}: `, `${m.answer.question_id} (`] : undefined);
    await scrubReminders(dir, path, id, m.text);
    return { done: true, original: m, oldTitle };
  });
}

// Which threads share copies of a message: a merge joins source and target (a later merge joins the target on, so chains form), and a move
// leaves a stub in the source and a copy in the target. One pass over the folder builds the graph; edges go both ways.
async function copyGraph(dir: string, entries: string[]): Promise<Map<string, Set<string>>> {
  const edges = new Map<string, Set<string>>();
  const link = (x: string, y: string) => { if (x === y || !ID.test(y)) return; for (const [p, q] of [[x, y], [y, x]] as const) { if (!edges.has(p)) edges.set(p, new Set()); edges.get(p)!.add(q); } };
  for (const t of entries) {
    try { const v = JSON.parse(await store.optional(join(dir, t, 'merged.json')) ?? 'null'); if (v && typeof v.into === 'string') link(t, v.into); } catch { /* not a merge note */ }
    for (const line of (await store.optional(join(dir, t, 'thread.jsonl')) ?? '').split('\n')) {
      if (!line.includes('moved_')) continue;
      try { const m = JSON.parse(line); if (typeof m.moved_to === 'string') link(t, m.moved_to); if (typeof m.moved_from === 'string' && m.moved_from.includes('/')) link(t, m.moved_from.split('/')[0]); } catch { /* a torn line */ }
    }
  }
  return edges;
}
export interface Swept { failed: string[] }
// A merge copies messages into the target and leaves the source readable, a later merge copies the copies on, and a move carries one away: walk every joined thread
// (visited set, both directions) and redact the copy (same author, time and text). A thread that cannot be redacted is reported, never ignored.
async function sweepCopies(dir: string, id: string, original: Message, vault: string, by: Author, reason: string | undefined, titles: string[]): Promise<Swept> {
  const entries = (await readdir(dir)).filter(e => ID.test(e));
  const graph = await copyGraph(dir, entries);
  const seen = new Set([id]), queue = [id], failed: string[] = [];
  while (queue.length) {
    for (const other of graph.get(queue.shift()!) ?? []) {
      if (seen.has(other)) continue;
      seen.add(other); queue.push(other);
      try {
        const path = await store.itemDir(dir, other);
        const copy = (await store.readMessages(path, await store.readItem(path))).find(m => !m.redacted && !m.divider && m.author === original.author && m.created_at === original.created_at && m.text === original.text);
        if (copy) { const r = await redactLocked(dir, other, copy.id, vault, by, reason); if (r.oldTitle) titles.push(r.oldTitle); }
      } catch (error) { failed.push(`${other}: ${error instanceof Error ? error.message : String(error)}`); console.error(`redact: could not redact the copy in ${other}`, error); }
    }
  }
  return { failed };
}
// A capture's title is its note's first line; the dividers and stubs a merge or move wrote carry it. Blank it there (exact title only).
async function scrubTitles(dir: string, titles: string[]): Promise<string[]> {
  const failed: string[] = [];
  const wanted = [...new Set(titles.filter(Boolean))];
  if (!wanted.length) return failed;
  for (const t of (await readdir(dir)).filter(e => ID.test(e))) {
    try {
      const path = join(dir, t);
      if (!(await store.optional(join(path, 'thread.jsonl')))) continue;
      await store.withLock(path, async () => {
        const raw = await store.optional(join(path, 'thread.jsonl')) ?? '';
        let changed = false;
        const lines = raw.split('\n').map(line => {
          if (!line.trim()) return line;
          try {
            const m = JSON.parse(line) as Record<string, unknown>;
            if (typeof m.text !== 'string') return line;
            let text = m.text;
            for (const title of wanted) {
              for (const prefix of ['Merged from: ', 'Moved from: ']) if (text === `${prefix}${title}`) text = `${prefix}${REDACTED}`;
              text = text.split(`[${title}](#/`).join(`[${REDACTED}](#/`);
            }
            if (text === m.text) return line;
            changed = true; return JSON.stringify({ ...m, text });
          } catch { return line; }
        });
        if (changed) await store.writeAtomic(join(path, 'thread.jsonl'), lines.join('\n'));
      });
    } catch (error) { failed.push(`${t}: ${error instanceof Error ? error.message : String(error)}`); console.error(`redact: could not rewrite the divider titles in ${t}`, error); }
  }
  return failed;
}

// Moves a message's text and images into the vault and leaves a marker. `by: 'user'` may only redact the user's own messages. Idempotent, and running it again retries the copies.
// `failed` lists any other thread whose copy could not be redacted; it is empty when everything was.
export async function redactMessage(dir: string, id: string, msgId: string, opts: { by: Author; reason?: unknown; vault: string | null | undefined }): Promise<{ redacted: boolean; failed: string[] }> {
  const vault = await checkVault(dir, opts.vault);
  if (opts.reason !== undefined && opts.reason !== null && (typeof opts.reason !== 'string' || opts.reason.length > 200)) throw new Invalid('A reason is up to 200 characters');
  const reason = typeof opts.reason === 'string' && opts.reason.trim() ? opts.reason.trim() : undefined;
  const result = await redactLocked(dir, id, msgId, vault, opts.by, reason);
  const titles = result.oldTitle ? [result.oldTitle] : [];
  const swept = result.original ? await sweepCopies(dir, id, result.original, vault, opts.by, reason, titles) : { failed: [] };
  return { redacted: result.done, failed: [...swept.failed, ...await scrubTitles(dir, titles)] };
}

// CLI only: reads the original back from the vault. Images come back under new numbers.
export async function unredactMessage(dir: string, id: string, msgId: string, vaultDir: string | null | undefined): Promise<{ restored: boolean }> {
  const vault = await checkVault(dir, vaultDir);
  const path = await store.itemDir(dir, id);
  return store.withLock(path, async () => {
    const item = await store.readItem(path);
    const stored = await store.materialise(path, item);
    const m = stored.find(x => x.id === msgId);
    if (!m) throw new Invalid(`No message ${msgId} in that thread`, 404);
    if (!m.redacted) return { restored: false };
    const saved = await readVault(vault, m.redacted.key);
    if (!saved) throw new Invalid(`The vault has no entry for ${msgId} (${m.redacted.key})`, 404);
    const names = await store.saveImages(path, saved.images.map(i => ({ bytes: Buffer.from(i.data, 'base64'), ext: i.name.slice(i.name.lastIndexOf('.') + 1) as store.Extension })));
    const back: Message = { ...m, text: saved.message.text, images: names };
    delete back.redacted;
    if (saved.message.attachments?.length) { await filesFromVault(path, vault, m.redacted.key, saved.message.attachments); back.attachments = saved.message.attachments; }
    if (saved.message.question && m.question) back.question = { ...saved.message.question, id: m.question.id };
    if (saved.message.answer && m.answer) back.answer = { ...saved.message.answer, question_id: m.answer.question_id };
    if (saved.message.secret) { back.kind = 'secret_request'; back.secret = saved.message.secret; }
    if (isMessageQuote(saved.message.quote)) back.quote = saved.message.quote;
    await store.writeAtomic(join(path, 'thread.jsonl'), stored.map(x => `${JSON.stringify(x === m ? back : x)}\n`).join(''));
    if (saved.item_note !== undefined && item.note === REDACTED) {
      await store.writeAtomic(join(path, 'item.json'), JSON.stringify({ ...item, note: saved.item_note }, null, 2));
      await store.writeAtomic(join(path, 'feedback.md'), feedbackFor({ ...item, note: saved.item_note }));
    }
    await rm(join(vault, `${m.redacted.key}.json`), { force: true });
    return { restored: true };
  });
}

// The inbox saved a key straight to the app and reports only that, plus the app's hint ("…abcd"). Anything else is refused, so a value cannot ride along.
export async function recordSecretSaved(dir: string, id: string, msgId: string, data: Record<string, unknown>): Promise<{ status: 'saved'; hint?: string; check?: 'works' | 'rejected' }> {
  for (const k of Object.keys(data)) if (k !== 'status' && k !== 'hint' && k !== 'check') throw new Invalid('Only status, hint and check can be recorded');
  if (data.check !== undefined && data.check !== null && data.check !== 'works' && data.check !== 'rejected') throw new Invalid('check must be "works" or "rejected"');
  const check: 'works' | 'rejected' | undefined = data.check === 'works' || data.check === 'rejected' ? data.check : undefined; // the app's own free test of the key, when it ran one
  if (data.status !== 'saved') throw new Invalid('status must be "saved"');
  let hint: string | undefined;
  if (data.hint !== undefined && data.hint !== null && data.hint !== '') {
    if (typeof data.hint !== 'string' || data.hint.length > MAX_HINT || [...data.hint].some(c => c.charCodeAt(0) < 32)) throw new Invalid(`hint is up to ${MAX_HINT} characters`);
    hint = data.hint;
  }
  const path = await store.itemDir(dir, id);
  const name = await store.withLock(path, async () => {
    const stored = await store.materialise(path, await store.readItem(path));
    const m = stored.find(x => x.id === msgId);
    if (!m || m.kind !== 'secret_request' || !m.secret) throw new Invalid('That message is not a key request', 404);
    const saved = { ...m.secret, status: 'saved' as const, saved_at: new Date().toISOString(), ...(hint ? { hint } : {}), ...(check ? { check } : {}) };
    if (!hint) delete saved.hint;
    const next: Message = { ...m, secret: saved, ...(m.flag === 'needs_you' ? { flag: 'fyi' as const } : {}) }; // it no longer needs the user
    await store.writeAtomic(join(path, 'thread.jsonl'), stored.map(x => `${JSON.stringify(x === m ? next : x)}\n`).join(''));
    return m.secret.name;
  });
  await store.logEvent(dir, { id, kind: 'secret', text: `${name} saved${check === 'rejected' ? ' (rejected by the provider)' : ''}`, author: 'user' });
  return { status: 'saved', ...(hint ? { hint } : {}), ...(check ? { check } : {}) };
}
