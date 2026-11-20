// File attachments of any type, with no size cap unless FEEDBACK_MAX_UPLOAD_BYTES says so.
//
// A file arrives as an upload: `_uploads/<id>/` in the data folder holds `meta.json` and the bytes (`part` while chunks arrive, `file` once finalised).
// The client sends chunks of at most 32 MiB (so a proxy's per-request limit never matters), the server writes each straight to disk (never into memory),
// and finalise checks the size and the sha256 before the file is marked ready. A message (or a new thread) then names the ready uploads; the file is
// moved into the thread as `files/<id>/<name>` in one rename. Anything left in `_uploads` is removed after 24 hours.
//
// Nothing here ever serves a file inline except an image or a PDF preview: see `downloadHeaders`.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, constants as fsConstants, mkdir, open, readdir, rename, rm, stat, statfs, writeFile, type FileHandle } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Invalid, type Author } from './store';

export const CHUNK_BYTES = 32 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
export const MAX_NAME_LENGTH = 120;
export const STALE_MS = 24 * 3600e3;
export const DEFAULT_MIN_FREE_BYTES = 20 * 1024 ** 3;
export const TEXT_LIMIT = 1024 * 1024;
export const UPLOAD_ID = /^u[0-9a-f]{16}$/;
const SHA = /^[0-9a-f]{64}$/;
const NOT_ENOUGH = 'Not enough disk space on the server';

export interface Attachment { id: string; name: string; size: number; sha256: string; type: string; by: Author; at: string }
interface UploadMeta { id: string; name: string; size: number; sha256?: string; by: Author; created_at: string; state: 'open' | 'ready'; type?: string }
export interface FilesOptions {
  env?: Record<string, string | undefined>;
  // The free and total bytes of the volume the data lives on. Tests replace it; the default asks the operating system.
  disk?: (dir: string) => Promise<{ free: number; total: number }>;
  now?: () => number;
}

// ---- Limits (environment)
function wholeNumber(value: string | undefined, name: string): number | null {
  const text = value?.trim();
  if (!text) return null;
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Invalid(`${name} must be a whole number of bytes`, 500);
  return Number(text);
}
// FEEDBACK_MAX_UPLOAD_BYTES: unset means no limit at all.
export function maxUploadBytes(env: Record<string, string | undefined> = process.env): number | null {
  const value = wholeNumber(env.FEEDBACK_MAX_UPLOAD_BYTES, 'FEEDBACK_MAX_UPLOAD_BYTES');
  return value === null || value === 0 ? null : value;
}
export function minFreeBytes(env: Record<string, string | undefined> = process.env): number {
  return wholeNumber(env.FEEDBACK_MIN_FREE_BYTES, 'FEEDBACK_MIN_FREE_BYTES') ?? DEFAULT_MIN_FREE_BYTES;
}
// A bad value stops the server at startup instead of failing a later upload.
export function validateLimits(env: Record<string, string | undefined> = process.env): void { maxUploadBytes(env); minFreeBytes(env); }

async function probeDisk(dir: string): Promise<{ free: number; total: number }> {
  await mkdir(dir, { recursive: true });
  const s = await statfs(dir);
  return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
}
// Refuses when taking `need` more bytes would leave less free than the larger of FEEDBACK_MIN_FREE_BYTES and 10% of the volume.
export async function checkDisk(dir: string, need: number, options: FilesOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const { free, total } = await (options.disk ?? probeDisk)(dir);
  const floor = Math.max(minFreeBytes(env), Math.ceil(total * 0.1));
  if (free - need < floor) throw new Invalid(NOT_ENOUGH, 507);
}

// ---- Names
// A name is only ever a label: no path parts, no control or direction-changing characters, a capped length. The folder holds an id, so a name cannot escape it.
const hidden = (c: number) => c < 32 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff;
const withoutHidden = (text: string) => [...text].filter(ch => !hidden(ch.codePointAt(0)!)).join('');
export function sanitiseName(raw: unknown): string {
  let name = typeof raw === 'string' ? raw : '';
  name = withoutHidden(name.normalize('NFC'));
  name = name.split(/[\\/]/).pop() ?? ''; // no path parts, from either kind of system
  name = name.replace(/[<>:"|?*]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (name.length > MAX_NAME_LENGTH) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = `${[...name.slice(0, name.length - ext.length)].slice(0, MAX_NAME_LENGTH - ext.length).join('')}${ext}`;
  }
  return name || 'file';
}

// ---- Content type, from the first bytes (never from the name or from what the client said)
const startsWith = (b: Buffer, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Buffer, at: number, text: string) => b.subarray(at, at + text.length).toString('latin1') === text;
function looksLikeText(b: Buffer): boolean {
  if (!b.length) return true;
  if (b.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(b); return true; }
  catch { // a multi-byte character cut by the end of the sample is still text
    const cut = b.length >= 8192 ? b.subarray(0, b.length - 3) : b;
    if (cut === b) return false;
    try { new TextDecoder('utf-8', { fatal: true }).decode(cut); return true; } catch { return false; }
  }
}
export function sniffType(b: Buffer): string {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) return 'image/gif';
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'image/webp';
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE')) return 'audio/wav';
  if (ascii(b, 0, '%PDF-')) return 'application/pdf';
  if (ascii(b, 0, 'PK') && (b[2] === 3 || b[2] === 5) && (b[3] === 4 || b[3] === 6)) return 'application/zip';
  if (startsWith(b, [0x1f, 0x8b])) return 'application/gzip';
  if (startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return 'application/x-7z-compressed';
  if (ascii(b, 0, 'Rar!')) return 'application/vnd.rar';
  if (startsWith(b, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return 'application/x-xz';
  if (ascii(b, 0, 'BZh')) return 'application/x-bzip2';
  if (ascii(b, 257, 'ustar')) return 'application/x-tar';
  if (ascii(b, 4, 'ftyp')) return 'video/mp4';
  if (ascii(b, 0, 'OggS')) return 'audio/ogg';
  if (ascii(b, 0, 'ID3') || startsWith(b, [0xff, 0xfb])) return 'audio/mpeg';
  if (ascii(b, 0, 'SQLite format 3')) return 'application/vnd.sqlite3';
  if (startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'application/x-ole-storage';
  return looksLikeText(b) ? 'text/plain' : 'application/octet-stream';
}
// Only these are ever shown in the page as a picture; the rest of a file is a download.
export const INLINE_IMAGES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const isInlineImage = (type: string) => INLINE_IMAGES.includes(type);

// ---- Disk layout
const uploadsDir = (dir: string) => join(dir, '_uploads');
const uploadDir = (dir: string, id: string) => join(uploadsDir(dir), id);
export const attachmentDir = (threadPath: string, id: string) => join(threadPath, 'files', id);
export const attachmentPath = (threadPath: string, a: Pick<Attachment, 'id' | 'name'>) => join(attachmentDir(threadPath, a.id), a.name);
function checkUploadId(id: unknown): string {
  if (typeof id !== 'string' || !UPLOAD_ID.test(id)) throw new Invalid('No such upload', 404);
  return id;
}
async function writeJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try { await writeFile(tmp, JSON.stringify(value)); await rename(tmp, file); } catch (error) { await rm(tmp, { force: true }); throw error; }
}
async function readMeta(dir: string, id: string): Promise<UploadMeta> {
  try {
    const raw = JSON.parse(await Bun.file(join(uploadDir(dir, id), 'meta.json')).text()) as UploadMeta;
    if (raw && typeof raw.name === 'string' && Number.isSafeInteger(raw.size) && raw.size >= 0) return raw;
  } catch { /* gone or torn */ }
  throw new Invalid('No such upload', 404);
}
// One writer per upload at a time, so two chunks of the same upload cannot interleave.
const chains = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  chains.set(key, tail);
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return run;
}
const newId = () => `u${randomBytes(8).toString('hex')}`;

// ---- Chunked, resumable upload
export interface UploadState { id: string; name: string; size: number; offset: number; chunk: number; state: 'open' | 'ready' }
export async function createUpload(dir: string, input: { name: unknown; size: unknown; sha256?: unknown; by: Author }, options: FilesOptions = {}): Promise<UploadState> {
  const env = options.env ?? process.env;
  const size = input.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) throw new Invalid('size must be the file size in bytes');
  const max = maxUploadBytes(env);
  if (max !== null && size > max) throw new Invalid(`Files are limited to ${max} bytes on this server`, 413);
  let sha256: string | undefined;
  if (input.sha256 !== undefined && input.sha256 !== null) {
    if (typeof input.sha256 !== 'string' || !SHA.test(input.sha256.toLowerCase())) throw new Invalid('sha256 must be 64 hex characters');
    sha256 = input.sha256.toLowerCase();
  }
  await checkDisk(dir, size, options);
  await cleanStale(dir, options.now?.() ?? Date.now());
  const id = newId();
  const folder = uploadDir(dir, id);
  await mkdir(folder, { recursive: true });
  const meta: UploadMeta = { id, name: sanitiseName(input.name), size, ...(sha256 ? { sha256 } : {}), by: input.by, created_at: new Date(options.now?.() ?? Date.now()).toISOString(), state: 'open' };
  await writeFile(join(folder, 'part'), '');
  await writeJson(join(folder, 'meta.json'), meta);
  return { id, name: meta.name, size, offset: 0, chunk: CHUNK_BYTES, state: 'open' };
}
const sizeOf = async (path: string): Promise<number> => { try { return (await stat(path)).size; } catch { return 0; } };
export async function uploadStatus(dir: string, idIn: unknown): Promise<UploadState> {
  const id = checkUploadId(idIn);
  const meta = await readMeta(dir, id);
  const offset = meta.state === 'ready' ? meta.size : await sizeOf(join(uploadDir(dir, id), 'part'));
  return { id, name: meta.name, size: meta.size, offset, chunk: CHUNK_BYTES, state: meta.state };
}
// Writes one chunk at `offset`, which must be exactly what the server already has (a client that is unsure asks uploadStatus). Streams to disk.
export async function appendChunk(dir: string, idIn: unknown, offset: number, body: ReadableStream<Uint8Array> | null, declared: number | undefined, options: FilesOptions = {}): Promise<{ offset: number }> {
  const id = checkUploadId(idIn);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Invalid('offset must be a byte position');
  if (!body) throw new Invalid('Missing body');
  return serial(id, async () => {
    const meta = await readMeta(dir, id);
    if (meta.state !== 'open') throw new Invalid('That upload is already complete', 409);
    const part = join(uploadDir(dir, id), 'part');
    const have = await sizeOf(part);
    if (offset !== have) throw new Invalid(`The server has ${have} bytes of this upload; send from there`, 409);
    const room = meta.size - offset;
    if (declared !== undefined && declared > CHUNK_BYTES) throw new Invalid('A chunk is at most 32 MiB', 413);
    if (declared !== undefined && declared > room) throw new Invalid('That chunk goes past the end of the file', 413);
    await checkDisk(dir, declared ?? Math.min(CHUNK_BYTES, room), options);
    const handle = await open(part, 'r+');
    let written = 0;
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (written + value.length > CHUNK_BYTES) throw new Invalid('A chunk is at most 32 MiB', 413);
        if (written + value.length > room) throw new Invalid('That chunk goes past the end of the file', 413);
        await handle.write(value, 0, value.length, offset + written);
        written += value.length;
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      // A lost connection keeps exactly the bytes that arrived (a resume starts there); a chunk this server refused leaves nothing of itself.
      if (written) await handle.truncate(error instanceof Invalid ? offset : offset + written).catch(() => undefined);
      throw error;
    } finally { await handle.close(); }
    return { offset: offset + written };
  });
}
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
async function headOf(path: string, length = 8192): Promise<Buffer> {
  const handle = await open(path, 'r');
  try { const buffer = Buffer.alloc(length); const { bytesRead } = await handle.read(buffer, 0, length, 0); return buffer.subarray(0, bytesRead); } finally { await handle.close(); }
}
export interface Ready { id: string; name: string; size: number; sha256: string; type: string }
// Checks the size and the sha256, then marks the upload ready (the bytes are renamed from `part` to `file`). A wrong checksum discards the upload.
export async function finaliseUpload(dir: string, idIn: unknown, claimed: unknown): Promise<Ready> {
  const id = checkUploadId(idIn);
  return serial(id, async () => {
    const meta = await readMeta(dir, id);
    const folder = uploadDir(dir, id);
    if (meta.state === 'ready') return { id, name: meta.name, size: meta.size, sha256: meta.sha256!, type: meta.type! };
    const expected = typeof claimed === 'string' && SHA.test(claimed.toLowerCase()) ? claimed.toLowerCase() : meta.sha256;
    if (!expected) throw new Invalid('Send the sha256 of the file to finish the upload');
    const part = join(folder, 'part');
    const have = await sizeOf(part);
    if (have !== meta.size) throw new Invalid(`The upload is incomplete: the server has ${have} of ${meta.size} bytes`, 409);
    const actual = await hashFile(part);
    if (actual !== expected) { await rm(folder, { recursive: true, force: true }); throw new Invalid('The file did not arrive intact (checksum mismatch); upload it again', 422); }
    const type = sniffType(await headOf(part, 8192));
    await rename(part, join(folder, 'file'));
    await writeJson(join(folder, 'meta.json'), { ...meta, sha256: actual, type, state: 'ready' as const });
    return { id, name: meta.name, size: meta.size, sha256: actual, type };
  });
}
export async function cancelUpload(dir: string, idIn: unknown): Promise<void> {
  const id = checkUploadId(idIn);
  await serial(id, () => rm(uploadDir(dir, id), { recursive: true, force: true }));
}
// Removes every upload nobody touched for 24 hours: partial ones and finished ones no message ever took.
export async function cleanStale(dir: string, now = Date.now()): Promise<number> {
  let entries: string[];
  try { entries = await readdir(uploadsDir(dir)); } catch { return 0; }
  let removed = 0;
  for (const name of entries) {
    if (!UPLOAD_ID.test(name)) continue;
    const folder = uploadDir(dir, name);
    let newest = 0;
    try { for (const f of await readdir(folder)) newest = Math.max(newest, (await stat(join(folder, f))).mtimeMs); } catch { continue; }
    if (now - newest > STALE_MS) { await rm(folder, { recursive: true, force: true }); removed++; }
  }
  return removed;
}

// ---- A file already on this machine (CLI, MCP): streamed into the same staging, so the same checks apply and nothing is held in memory.
export async function stageHandle(dir: string, handle: FileHandle, name: string, by: Author, options: FilesOptions = {}): Promise<Ready> {
  const info = await handle.stat();
  if (!info.isFile()) throw new Invalid('That is not a regular file');
  const max = maxUploadBytes(options.env ?? process.env);
  if (max !== null && info.size > max) throw new Invalid(`Files are limited to ${max} bytes on this server`, 413);
  await checkDisk(dir, info.size, options);
  const id = newId();
  const folder = uploadDir(dir, id);
  await mkdir(folder, { recursive: true });
  try {
    const hash = createHash('sha256');
    const out = await open(join(folder, 'file'), 'wx');
    let size = 0;
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead)); await out.write(buffer, 0, bytesRead, size); size += bytesRead;
        if (size > info.size + CHUNK_BYTES) throw new Invalid('The file kept growing while it was copied');
      }
    } finally { await out.close(); }
    const sha256 = hash.digest('hex');
    const type = sniffType(await headOf(join(folder, 'file'), 8192));
    await writeJson(join(folder, 'meta.json'), { id, name: sanitiseName(name), size, sha256, by, created_at: new Date(options.now?.() ?? Date.now()).toISOString(), state: 'ready', type } satisfies UploadMeta);
    return { id, name: sanitiseName(name), size, sha256, type };
  } catch (error) { await rm(folder, { recursive: true, force: true }); throw error; }
}
export async function stagePath(dir: string, path: string, by: Author, options: FilesOptions = {}): Promise<Ready> {
  let handle: FileHandle;
  try { handle = await open(path, 'r'); } catch { throw new Invalid(`Cannot read ${path}`); }
  try { return await stageHandle(dir, handle, basename(path), by, options); } finally { await handle.close(); }
}

// ---- Taking uploads into a thread
// Validates every id first (ready, uploaded by this author, listed once), then renames each file into `<thread>/files/<id>/<name>`. `undo` puts them back.
export function checkAttachmentIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) throw new Invalid(`At most ${MAX_ATTACHMENTS} files per message`);
  const ids = value.map(checkUploadId);
  if (new Set(ids).size !== ids.length) throw new Invalid('Name each file once');
  return ids;
}
export async function claimUploads(dir: string, threadPath: string, ids: string[], by: Author): Promise<{ attachments: Attachment[]; undo: () => Promise<void> }> {
  const planned: { meta: UploadMeta; from: string }[] = [];
  for (const id of ids) {
    let meta: UploadMeta;
    try { meta = await readMeta(dir, id); } catch { throw new Invalid('One of the files is no longer on the server; attach it again', 404); }
    if (meta.state !== 'ready' || meta.by !== by) throw new Invalid('One of the files is not ready; attach it again', 409);
    planned.push({ meta, from: join(uploadDir(dir, id), 'file') });
  }
  const done: { from: string; to: string; folder: string }[] = [];
  const undo = async () => { for (const m of done.reverse()) { await rename(m.to, m.from).catch(() => undefined); await rm(m.folder, { recursive: true, force: true }); } };
  const attachments: Attachment[] = [];
  try {
    for (const { meta, from } of planned) {
      const folder = attachmentDir(threadPath, meta.id);
      await mkdir(folder, { recursive: true });
      const to = join(folder, meta.name);
      await rename(from, to);
      done.push({ from, to, folder });
      attachments.push({ id: meta.id, name: meta.name, size: meta.size, sha256: meta.sha256!, type: meta.type!, by: meta.by, at: new Date().toISOString() });
    }
  } catch (error) { await undo(); throw error; }
  for (const id of ids) await rm(uploadDir(dir, id), { recursive: true, force: true });
  return { attachments, undo: async () => { await undo(); } };
}
// Parses the `attachments` field of a stored message; anything malformed is dropped.
export function parseAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return [];
  const out: Attachment[] = [];
  for (const a of value as Record<string, unknown>[]) {
    if (a && typeof a === 'object' && typeof a.id === 'string' && UPLOAD_ID.test(a.id) && typeof a.name === 'string' && a.name && !/[\\/]/.test(a.name) && a.name !== '.' && a.name !== '..'
      && typeof a.size === 'number' && typeof a.sha256 === 'string' && typeof a.type === 'string' && (a.by === 'user' || a.by === 'agent') && typeof a.at === 'string') {
      out.push({ id: a.id, name: a.name, size: a.size, sha256: a.sha256, type: a.type, by: a.by, at: a.at });
    }
  }
  return out;
}

// ---- Copying and moving files between threads, and into the vault
export async function moveFile(from: string, to: string): Promise<void> {
  await mkdir(join(to, '..'), { recursive: true });
  try { await rename(from, to); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await copyFile(from, to); await rm(from, { force: true }); // another volume: copy, then remove
  }
}
const present = async (path: string) => { try { await stat(path); return true; } catch { return false; } };
// A copy in another thread (a merge or a move). Cheap on a file system that can clone. Already there means done.
export async function cloneAttachments(fromThread: string, toThread: string, list: Attachment[]): Promise<void> {
  for (const a of list) {
    const to = attachmentPath(toThread, a);
    if (await present(to)) continue;
    const from = attachmentPath(fromThread, a);
    if (!(await present(from))) continue;
    await mkdir(attachmentDir(toThread, a.id), { recursive: true });
    await copyFile(from, to, fsConstants.COPYFILE_FICLONE);
  }
}
export async function removeAttachments(threadPath: string, list: Attachment[]): Promise<void> {
  for (const a of list) await rm(attachmentDir(threadPath, a.id), { recursive: true, force: true });
}
const vaultFiles = (vault: string, key: string) => join(vault, `${key}.files`);
// Redaction: the files leave the thread for the vault (never served again). Running it again finishes whatever was left.
export async function filesToVault(threadPath: string, vault: string, key: string, list: Attachment[]): Promise<void> {
  for (const a of list) {
    const from = attachmentPath(threadPath, a), to = join(vaultFiles(vault, key), a.id, a.name);
    if (await present(from)) { await mkdir(join(vaultFiles(vault, key), a.id), { recursive: true, mode: 0o700 }); await moveFile(from, to); }
    await rm(attachmentDir(threadPath, a.id), { recursive: true, force: true });
  }
}
export async function filesFromVault(threadPath: string, vault: string, key: string, list: Attachment[]): Promise<void> {
  for (const a of list) {
    const from = join(vaultFiles(vault, key), a.id, a.name);
    if (await present(from)) { await mkdir(attachmentDir(threadPath, a.id), { recursive: true }); await moveFile(from, attachmentPath(threadPath, a)); }
  }
  await rm(vaultFiles(vault, key), { recursive: true, force: true });
}

// ---- Serving
// Every download is an attachment, in a sandbox with nothing allowed, with no cookie set and no way to guess its type. An image is served with its own (image) type so a picture can show;
// everything else is application/octet-stream. `inline` is only for a PDF preview inside a sandboxed frame: the one response that is not a download.
const FRAMED_OFF = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'private, no-store' };
const quote = (name: string) => `"${name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')}"`;
export function downloadHeaders(a: Attachment, inline = false): Record<string, string> {
  const preview = inline && a.type === 'application/pdf';
  const type = isInlineImage(a.type) ? a.type : preview ? 'application/pdf' : 'application/octet-stream';
  const disposition = preview ? 'inline' : 'attachment';
  return { ...FRAMED_OFF, 'Content-Type': type, 'Content-Length': String(a.size), 'Content-Disposition': `${disposition}; filename=${quote(a.name)}; filename*=UTF-8''${encodeURIComponent(a.name)}` };
}
// The text of a small text-like file, for an agent. Anything else (or anything over 1 MB) is null: the agent gets the path.
export async function readTextIfSmall(path: string, a: Attachment): Promise<string | null> {
  if (a.type !== 'text/plain' || a.size > TEXT_LIMIT) return null;
  const bytes = Buffer.from(await Bun.file(path).arrayBuffer());
  return looksLikeText(bytes) ? bytes.toString('utf8') : null;
}
