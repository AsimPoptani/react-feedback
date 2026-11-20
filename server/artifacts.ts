// Artifacts: an HTML or Markdown page an agent publishes into a thread.
// Files live in <dir>/_artifacts/<id>/v<n>/, with meta.json written atomically beside the versions. Republishing the same id adds v+1.
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ID, Invalid, MAX_TITLE, itemDir, optional, threadTitle, withLock, writeAtomic } from './store';

export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
export const ART_ID = /^a[0-9a-f]{12}$/;
export type ArtifactFormat = 'html' | 'md';
export interface ArtifactVersion { n: number; format: ArtifactFormat; bytes: number; title: string; created_at: string }
export interface ArtifactMeta {
  id: string; thread: string; title: string; created_at: string; updated_at: string; latest: number; versions: ArtifactVersion[]; suggest?: true;
}

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let rendererSource: string | null = null;
async function markdownRuntime(): Promise<string> {
  if (rendererSource !== null) return rendererSource;
  const source = await readFile(join(import.meta.dir, 'inbox', 'markdown.js'), 'utf8');
  rendererSource = source.replace(/^export /gm, '');
  return rendererSource;
}

// Markdown is rendered with the inbox's safe renderer (createElement and textContent, no HTML parsing), inlined so the
// sandboxed page does not have to fetch anything from the inbox origin.
export async function renderMarkdownPage(title: string, markdown: string): Promise<string> {
  const runtime = await markdownRuntime();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; padding: 24px 16px 48px; font: 16px/1.5 system-ui, sans-serif; color: #192f38; background: #fff; }
  .text { max-width: 42rem; margin: 0 auto; }
  .text pre { overflow: auto; padding: 10px 12px; background: #f3f7f5; border-radius: 8px; }
  .text code { font-family: ui-monospace, monospace; font-size: .92em; }
  .text a { color: #00796f; }
  .text table { border-collapse: collapse; }
  .text td, .text th { border: 1px solid #c3d2cc; padding: 4px 8px; vertical-align: top; }
</style>
</head>
<body>
<div id="src" hidden>${escapeHtml(markdown)}</div>
<script>
${runtime}
document.body.append(markdown(document.getElementById('src').textContent));
</script>
</body>
</html>
`;
}

const FULL_DOC = /^\s*(?:<!doctype\s+html|<html[\s>])/i;
function htmlPage(title: string, content: string): string {
  if (FULL_DOC.test(content)) return content;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body>
${content}
</body>
</html>
`;
}

const rootOf = (dir: string) => join(dir, '_artifacts');
const artDir = (dir: string, id: string) => join(rootOf(dir), id);

function parseVersion(value: unknown): ArtifactVersion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.n !== 'number' || !Number.isInteger(v.n) || v.n < 1) return null;
  if (v.format !== 'html' && v.format !== 'md') return null;
  if (typeof v.bytes !== 'number' || typeof v.title !== 'string' || typeof v.created_at !== 'string') return null;
  return { n: v.n, format: v.format, bytes: v.bytes, title: v.title, created_at: v.created_at };
}
export async function readArtifact(dir: string, id: string): Promise<ArtifactMeta | null> {
  if (!ART_ID.test(id)) return null;
  const raw = await optional(join(artDir(dir, id), 'meta.json'));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.id !== 'string' || parsed.id !== id || typeof parsed.thread !== 'string' || !ID.test(parsed.thread)) return null;
    if (typeof parsed.title !== 'string' || typeof parsed.created_at !== 'string' || typeof parsed.updated_at !== 'string') return null;
    if (typeof parsed.latest !== 'number') return null;
    const versions = Array.isArray(parsed.versions) ? parsed.versions.flatMap(item => { const v = parseVersion(item); return v ? [v] : []; }) : [];
    return { id, thread: parsed.thread, title: parsed.title, created_at: parsed.created_at, updated_at: parsed.updated_at, latest: parsed.latest, versions, ...(parsed.suggest === true ? { suggest: true } : {}) };
  } catch { return null; }
}

function newArtId(): string { return `a${randomBytes(6).toString('hex')}`; }

export interface PublishInput { thread: string; title: unknown; content: string; format: ArtifactFormat; id?: string }
export async function publishArtifact(dir: string, input: PublishInput): Promise<ArtifactMeta> {
  if (!ID.test(input.thread)) throw new Invalid('Invalid id', 404);
  await itemDir(dir, input.thread);
  const title = threadTitle(input.title);
  if (title.length > MAX_TITLE) throw new Invalid('Title must be 1–200 characters');
  if (typeof input.content !== 'string' || !input.content.trim()) throw new Invalid('An artifact needs some content');
  const bytes = Buffer.byteLength(input.content);
  if (bytes > MAX_ARTIFACT_BYTES) throw new Invalid('An artifact is at most 5 MB', 413);
  if (input.format !== 'html' && input.format !== 'md') throw new Invalid('An artifact is HTML or Markdown');
  let id = input.id;
  if (id !== undefined && !ART_ID.test(id)) throw new Invalid('Invalid artifact id');
  await mkdir(rootOf(dir), { recursive: true });
  if (!id) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = newArtId();
      if (!(await readArtifact(dir, candidate))) { id = candidate; break; }
    }
    if (!id) throw new Invalid('Could not allocate an artifact id');
  }
  const folder = artDir(dir, id);
  await mkdir(folder, { recursive: true });
  return withLock(folder, async () => {
    const existing = await readArtifact(dir, id!);
    if (input.id && !existing) throw new Invalid('No such artifact', 404);
    if (existing && existing.thread !== input.thread) throw new Invalid('That artifact belongs to another thread', 409);
    const n = (existing?.latest ?? 0) + 1;
    const created_at = new Date().toISOString();
    const html = input.format === 'md' ? await renderMarkdownPage(title, input.content) : htmlPage(title, input.content);
    const tmp = join(rootOf(dir), `.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
    await mkdir(tmp);
    try {
      await writeFile(join(tmp, 'body.html'), html);
      await writeFile(join(tmp, input.format === 'md' ? 'source.md' : 'source.html'), input.content);
      await writeFile(join(tmp, 'meta.json'), JSON.stringify({ n, format: input.format, bytes, title, created_at }));
      await rename(tmp, join(folder, `v${n}`));
    } catch (error) { await rm(tmp, { recursive: true, force: true }); throw error; }
    const version: ArtifactVersion = { n, format: input.format, bytes, title, created_at };
    const meta: ArtifactMeta = existing
      ? { ...existing, title, updated_at: created_at, latest: n, versions: [...existing.versions, version] }
      : { id: id!, thread: input.thread, title, created_at, updated_at: created_at, latest: n, versions: [version] };
    await writeAtomic(join(folder, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
    return meta;
  });
}

export async function listArtifacts(dir: string, thread?: string): Promise<ArtifactMeta[]> {
  let names: string[] = [];
  try { names = await readdir(rootOf(dir)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const out: ArtifactMeta[] = [];
  for (const name of names) {
    if (!ART_ID.test(name)) continue;
    const meta = await readArtifact(dir, name);
    if (!meta || (thread && meta.thread !== thread)) continue;
    out.push(meta);
  }
  return out.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id));
}

export async function suggestShare(dir: string, id: string): Promise<ArtifactMeta> {
  if (!ART_ID.test(id)) throw new Invalid('No such artifact', 404);
  const folder = artDir(dir, id);
  return withLock(folder, async () => {
    const meta = await readArtifact(dir, id);
    if (!meta) throw new Invalid('No such artifact', 404);
    const next: ArtifactMeta = { ...meta, suggest: true };
    await writeAtomic(join(folder, 'meta.json'), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export async function clearSuggest(dir: string, id: string): Promise<void> {
  const folder = artDir(dir, id);
  const meta = await readArtifact(dir, id);
  if (!meta?.suggest) return;
  await withLock(folder, async () => {
    const current = await readArtifact(dir, id);
    if (!current?.suggest) return;
    const next: ArtifactMeta = { id: current.id, thread: current.thread, title: current.title, created_at: current.created_at, updated_at: current.updated_at, latest: current.latest, versions: current.versions };
    await writeAtomic(join(folder, 'meta.json'), `${JSON.stringify(next, null, 2)}\n`);
  });
}

export function formatOfName(name: string): ArtifactFormat {
  if (/\.(md|markdown)$/i.test(name)) return 'md';
  if (/\.html?$/i.test(name)) return 'html';
  throw new Invalid('Publish an .html or .md file');
}

export function versionNumber(meta: ArtifactMeta, version: number | 'latest'): number {
  const n = version === 'latest' ? meta.latest : version;
  if (!meta.versions.some(item => item.n === n)) throw new Invalid('Not found', 404);
  return n;
}

export async function artifactHtml(dir: string, id: string, version: number | 'latest'): Promise<string> {
  const meta = await readArtifact(dir, id);
  if (!meta) throw new Invalid('Not found', 404);
  const n = versionNumber(meta, version);
  const text = await optional(join(artDir(dir, id), `v${n}`, 'body.html'));
  if (text === null) throw new Invalid('Not found', 404);
  return text;
}

// The original bytes the agent published (Markdown source, or the HTML before it was wrapped). The secret scan reads this, not the shell.
export async function artifactSource(dir: string, id: string, version: number | 'latest'): Promise<string> {
  const meta = await readArtifact(dir, id);
  if (!meta) throw new Invalid('Not found', 404);
  const n = versionNumber(meta, version);
  const folder = join(artDir(dir, id), `v${n}`);
  const source = (await optional(join(folder, 'source.md'))) ?? (await optional(join(folder, 'source.html')));
  if (source === null) throw new Invalid('Not found', 404);
  return source;
}
