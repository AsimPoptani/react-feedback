// Sensitive messages: redaction into a vault, restore, and the non-secret record of a saved key.
// The vault (FEEDBACK_VAULT_DIR) lives outside FEEDBACK_DIR, is never served over HTTP, and holds one file per redacted message
// (directory 0700, files 0600, written atomically). A key's value is never handled here: the inbox sends it straight to the app.
import { realpathSync } from 'node:fs';
import { chmod, mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as store from './store';
import { Invalid, ID, MAX_HINT, type Author, type Message, type Redaction } from './store';

const REDACTED = '[redacted]';
const KEY = /^(\d{8}-\d{6}-[0-9a-f]{4})\/(m\d+)$/;

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
  const [thread] = key.split('/') as [string, string];
  const folder = join(vault, thread);
  await mkdir(vault, { recursive: true, mode: 0o700 });
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(vault, 0o700); await chmod(folder, 0o700);
  const file = join(vault, `${key}.json`), tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  } catch (error) { await rm(tmp, { force: true }); throw error; }
}
async function readVault(vault: string, key: string): Promise<{ message: Message; images: { name: string; data: string }[]; item_note?: string } | null> {
  if (!KEY.test(key)) return null;
  try { return JSON.parse(await readFile(join(vault, `${key}.json`), 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

// The user's `_events.jsonl` lines hold a message's first line. Blank it in place and keep every line's byte length, so anything following the file by offset stays in step.
async function scrubEvents(dir: string, thread: string, firstLines: Set<string>): Promise<void> {
  const file = join(dir, '_events.jsonl');
  let raw: Buffer;
  try { raw = await readFile(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const patches: { at: number; bytes: Buffer }[] = [];
  let offset = 0;
  for (const line of raw.toString('utf8').split('\n')) {
    const length = Buffer.byteLength(line);
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      if (e.id === thread && typeof e.first_line === 'string' && firstLines.has(e.first_line) && e.first_line !== REDACTED) {
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
const firstLine = (text: string) => text.split('\n')[0]!.slice(0, 200) || '[image]';

async function redactLocked(dir: string, id: string, msgId: string, vault: string, by: Author, reason: string | undefined): Promise<{ done: boolean; original?: Message }> {
  const path = await store.itemDir(dir, id);
  return store.withLock(path, async () => {
    const item = await store.readItem(path);
    const stored = await store.materialise(path, item);
    const m = stored.find(x => x.id === msgId);
    if (!m) throw new Invalid(`No message ${msgId} in that thread`, 404);
    if (m.divider || m.moved_to) throw new Invalid(`${msgId} is a divider and cannot be redacted`);
    if (m.redacted) return { done: false };
    if (by === 'user' && m.author !== 'user') throw new Invalid('You can only redact your own messages', 403);
    const key = `${id}/${msgId}`;
    const images: { name: string; data: string }[] = [];
    for (const name of m.images) { try { images.push({ name, data: (await readFile(join(path, name))).toString('base64') }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    const note = typeof item.note === 'string' && item.note === m.text && m.text !== '' ? item.note : undefined;
    await writeVault(vault, key, { thread: id, message: m, images, reason, by, at: new Date().toISOString(), ...(note !== undefined ? { item_note: note } : {}) });
    const redacted: Redaction = { at: new Date().toISOString(), by, key, ...(reason ? { reason: reason.slice(0, 200) } : {}) };
    const blank: Message = { ...m, text: '', images: [], redacted };
    if (m.question) blank.question = { ...m.question, prompt: REDACTED, options: m.question.options.map(o => ({ id: o.id, label: REDACTED })) };
    if (m.answer?.other_text) blank.answer = { ...m.answer, other_text: REDACTED };
    delete blank.secret; delete blank.kind;
    await store.writeAtomic(join(path, 'thread.jsonl'), stored.map(x => `${JSON.stringify(x === m ? blank : x)}\n`).join(''));
    for (const name of m.images) await rm(join(path, name), { force: true });
    if (note !== undefined) { // a thread that started with this message repeats it in item.json and feedback.md
      await store.writeAtomic(join(path, 'item.json'), JSON.stringify({ ...item, note: REDACTED }, null, 2));
      const title = typeof item.title === 'string' ? item.title : '';
      await store.writeAtomic(join(path, 'feedback.md'), item.mode === 'thread' ? `${title}\n\n${REDACTED}\n` : `${REDACTED}\n`);
    }
    const lines = new Set([firstLine(m.text), firstLine(`${typeof item.title === 'string' ? item.title : ''}: ${m.text}`)]);
    await scrubEvents(dir, id, lines);
    return { done: true, original: m };
  });
}

// A merge copies messages into the target and leaves the source readable: redact the other copy too (same author, time and text).
async function sweepCopies(dir: string, id: string, original: Message, vault: string, by: Author, reason: string | undefined): Promise<void> {
  const here = await store.itemDir(dir, id);
  const targets = new Set<string>();
  const merged = await store.optional(join(here, 'merged.json'));
  try { const v = merged ? JSON.parse(merged) : null; if (v && typeof v.into === 'string' && ID.test(v.into)) targets.add(v.into); } catch { /* ignore */ }
  for (const entry of await readdir(dir)) {
    if (!ID.test(entry) || entry === id) continue;
    try { const v = JSON.parse(await store.optional(join(dir, entry, 'merged.json')) ?? 'null'); if (v && v.into === id) targets.add(entry); } catch { /* ignore */ }
  }
  for (const other of targets) {
    try {
      const path = await store.itemDir(dir, other);
      const copy = (await store.readMessages(path, await store.readItem(path))).find(m => !m.redacted && !m.divider && m.author === original.author && m.created_at === original.created_at && m.text === original.text);
      if (copy) await redactLocked(dir, other, copy.id, vault, by, reason);
    } catch { /* a broken or missing neighbour must not undo the redaction */ }
  }
}

// Moves a message's text and images into the vault and leaves a marker. `by: 'user'` may only redact the user's own messages. Idempotent.
export async function redactMessage(dir: string, id: string, msgId: string, opts: { by: Author; reason?: unknown; vault: string | null | undefined }): Promise<{ redacted: boolean }> {
  const vault = await checkVault(dir, opts.vault);
  if (opts.reason !== undefined && opts.reason !== null && (typeof opts.reason !== 'string' || opts.reason.length > 200)) throw new Invalid('A reason is up to 200 characters');
  const reason = typeof opts.reason === 'string' && opts.reason.trim() ? opts.reason.trim() : undefined;
  const result = await redactLocked(dir, id, msgId, vault, opts.by, reason);
  if (result.done && result.original) await sweepCopies(dir, id, result.original, vault, opts.by, reason);
  return { redacted: result.done };
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
    if (saved.message.question && m.question) back.question = { ...saved.message.question, id: m.question.id };
    if (saved.message.answer && m.answer) back.answer = { ...saved.message.answer, question_id: m.answer.question_id };
    if (saved.message.secret) { back.kind = 'secret_request'; back.secret = saved.message.secret; }
    await store.writeAtomic(join(path, 'thread.jsonl'), stored.map(x => `${JSON.stringify(x === m ? back : x)}\n`).join(''));
    if (saved.item_note !== undefined && item.note === REDACTED) {
      await store.writeAtomic(join(path, 'item.json'), JSON.stringify({ ...item, note: saved.item_note }, null, 2));
      const title = typeof item.title === 'string' ? item.title : '';
      await store.writeAtomic(join(path, 'feedback.md'), item.mode === 'thread' ? `${title}\n\n${saved.item_note}\n` : `${saved.item_note}\n`);
    }
    await rm(join(vault, `${m.redacted.key}.json`), { force: true });
    return { restored: true };
  });
}

// The inbox saved a key straight to the app and reports only that, plus the app's hint ("…abcd"). Anything else is refused, so a value cannot ride along.
export async function recordSecretSaved(dir: string, id: string, msgId: string, data: Record<string, unknown>): Promise<{ status: 'saved'; hint?: string }> {
  for (const k of Object.keys(data)) if (k !== 'status' && k !== 'hint') throw new Invalid('Only status and hint can be recorded');
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
    const saved = { ...m.secret, status: 'saved' as const, saved_at: new Date().toISOString(), ...(hint ? { hint } : {}) };
    if (!hint) delete saved.hint;
    const next: Message = { ...m, secret: saved, ...(m.flag === 'needs_you' ? { flag: 'fyi' as const } : {}) }; // it no longer needs the user
    await store.writeAtomic(join(path, 'thread.jsonl'), stored.map(x => `${JSON.stringify(x === m ? next : x)}\n`).join(''));
    return m.secret.name;
  });
  await store.logEvent(dir, { id, kind: 'secret', text: `${name} saved`, author: 'user' });
  return { status: 'saved', ...(hint ? { hint } : {}) };
}
