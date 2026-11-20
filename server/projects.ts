// One feedback server can hold several projects. FEEDBACK_PROJECTS is a JSON list of {id, name, dir}.
// Unset, there is one project: FEEDBACK_DIR, and every URL is the one the server has always served.
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Invalid, MIME, sniff, type Extension } from './store';

// `icon` is the resolved path of an optional PNG, JPEG or WebP picture for the project. It is never sent to a browser.
// `match` lists URL prefixes or globs (`*` matches anything): a capture whose page address matches goes to this project. `inbox: true` marks the project that owns the inbox itself, so a capture
// taken on the inbox's own pages lands there.
export interface Project { id: string; name: string; dir: string; icon?: string; match?: string[]; inbox?: true }
export const ICON_MAX_BYTES = 1024 * 1024;

const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MAX = 50;

// The single project used when FEEDBACK_PROJECTS is unset. Its id is only for the inbox; the API ignores ?project=.
export function implicitProject(env: Record<string, string | undefined> = process.env): Project {
  const dir = env.FEEDBACK_DIR?.trim() ? resolve(env.FEEDBACK_DIR.trim()) : resolve(process.cwd(), 'feedback-data');
  return { id: 'default', name: 'Feedback', dir };
}

// Throws an Invalid with a clear message when the list cannot be used. An empty value means "not set".
export function loadProjects(env: Record<string, string | undefined> = process.env): Project[] {
  const raw = env.FEEDBACK_PROJECTS?.trim();
  if (!raw) return [implicitProject(env)];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) { throw new Invalid(`FEEDBACK_PROJECTS is not valid JSON (${(error as Error).message})`); }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX) throw new Invalid(`FEEDBACK_PROJECTS must be a JSON list of 1–${MAX} projects, each {id, name, dir}`);
  const out: Project[] = [];
  const ids = new Set<string>(), dirs = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Invalid('Each project needs an id, a name and a dir');
    const rec = item as Record<string, unknown>;
    const extra = Object.keys(rec).filter(key => key !== 'id' && key !== 'name' && key !== 'dir' && key !== 'icon' && key !== 'match' && key !== 'inbox');
    if (extra.length) throw new Invalid(`Unknown project field "${extra[0]}"`);
    if (typeof rec.id !== 'string' || !ID.test(rec.id)) throw new Invalid('A project id is 1–40 characters of a-z, 0-9, _ or -, starting with a letter or digit');
    if (typeof rec.name !== 'string' || !rec.name.trim() || rec.name.length > 80) throw new Invalid('A project name is 1–80 characters');
    if (typeof rec.dir !== 'string' || !rec.dir.trim()) throw new Invalid(`Project "${rec.id}" needs a dir`);
    if (ids.has(rec.id)) throw new Invalid(`Duplicate project id "${rec.id}"`);
    const dir = resolve(rec.dir.trim());
    if (dirs.has(dir)) throw new Invalid(`Two projects use the same directory`);
    if (rec.icon !== undefined && (typeof rec.icon !== 'string' || !rec.icon.trim())) throw new Invalid(`Project "${rec.id}" has an icon that is not a path`);
    const match = checkMatch(rec.id, rec.match);
    if (rec.inbox !== undefined && typeof rec.inbox !== 'boolean') throw new Invalid(`Project "${rec.id}" has an inbox that is not true or false`);
    if (rec.inbox === true && out.some(p => p.inbox)) throw new Invalid('Only one project can set inbox: true');
    ids.add(rec.id); dirs.add(dir);
    out.push({ id: rec.id, name: rec.name.trim(), dir, ...(typeof rec.icon === 'string' ? { icon: resolve(rec.icon.trim()) } : {}), ...(match ? { match } : {}), ...(rec.inbox === true ? { inbox: true as const } : {}) });
  }
  return out;
}

export function projectById(projects: Project[], id: string): Project {
  const found = projects.find(project => project.id === id);
  if (!found) throw new Invalid(`Unknown project "${id}"`, 404);
  return found;
}

// The picture of a project, or null when it is missing, too big or not a PNG, JPEG or WebP (SVG is never served). Only the configured file is ever read.
export function readProjectIcon(project: Project): { bytes: Buffer; type: string } | null {
  if (!project.icon) return null;
  try {
    const info = statSync(project.icon);
    if (!info.isFile() || info.size > ICON_MAX_BYTES) return null;
    const bytes = readFileSync(project.icon);
    const ext: Extension | null = bytes.length > ICON_MAX_BYTES ? null : sniff(bytes);
    return ext ? { bytes, type: MIME[ext] } : null;
  } catch { return null; }
}
// At startup: a project whose icon cannot be used loses it (the badge is drawn instead) and one warning says why.
export function checkIcons(projects: Project[], warn: (message: string) => void = message => console.warn(message)): Project[] {
  return projects.map(project => {
    if (!project.icon || readProjectIcon(project)) return project;
    warn(`Project "${project.id}": its icon is missing, over ${ICON_MAX_BYTES / 1024 / 1024} MB or not a PNG, JPEG or WebP file; the generated badge is used instead`);
    const { icon: _icon, ...rest } = project;
    return rest;
  });
}

// ---- Routing a capture to a project by the page it was taken on.
const MAX_MATCH = 20;
function checkMatch(id: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MATCH) throw new Invalid(`Project "${id}": match is a list of 1-${MAX_MATCH} URL prefixes or globs`);
  const out = value.map(item => {
    if (typeof item !== 'string' || !item.trim() || item.length > 300) throw new Invalid(`Project "${id}": each match is a URL prefix or glob of up to 300 characters`);
    return item.trim();
  });
  return out;
}
const lower = (text: string) => text.toLowerCase();
// The part of a URL a rule is about: no fragment.
const withoutFragment = (url: string) => { const at = url.indexOf('#'); return at < 0 ? url : url.slice(0, at); };
// A pattern with `*` is a glob over the start of the address (it too ends at a segment); any other is a prefix that must end at a segment ("http://app.test:5173" matches "http://app.test:5173/billing" but not ":51730").
function patternMatches(pattern: string, url: string): boolean {
  const p = lower(pattern), u = lower(withoutFragment(url));
  if (p.includes('*')) return new RegExp(`^${p.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}(?:$|[/?])`).test(u);
  if (!u.startsWith(p)) return false;
  const next = u.charAt(p.length);
  return p.endsWith('/') || next === '' || next === '/' || next === '?';
}
// Longer patterns are more specific: the longest one that matches wins (ties go to the earlier project).
const specificity = (pattern: string) => pattern.replace(/\*/g, '').length;
export const INBOX_PATH = /^\/__feedback\/inbox(?:\/|$)/;
function isInboxUrl(url: string): boolean { try { return INBOX_PATH.test(new URL(url).pathname); } catch { return false; } }
// The project a capture taken on `url` belongs to, or null when no rule matches. The inbox's own pages go to the project with `inbox: true`.
export function matchProject(projects: Project[], url: string): Project | null {
  if (typeof url !== 'string' || !url) return null;
  if (isInboxUrl(url)) { const owner = projects.find(project => project.inbox); if (owner) return owner; }
  let best: { project: Project; score: number } | null = null;
  for (const project of projects) for (const pattern of project.match ?? []) {
    if (!patternMatches(pattern, url)) continue;
    const score = specificity(pattern);
    if (!best || score > best.score) best = { project, score };
  }
  return best?.project ?? null;
}
// Whether routing is configured at all: only then is a capture "unmatched".
export const routesByUrl = (projects: Project[] | undefined): boolean => !!projects && projects.length > 1 && projects.some(project => project.match?.length || project.inbox);
const originOf = (text: string): string => { try { return new URL(text.replace(/\*/g, 'x')).origin.toLowerCase(); } catch { return ''; } };
// The project that looks closest to a page no rule matched: the one with a rule on the same site (the same origin), the longest shared start of the address winning.
// Null when nothing is close. `skip` is the project the capture already sits in.
export function closestProject(projects: Project[], url: string, skip?: string): Project | null {
  if (typeof url !== 'string' || !url) return null;
  const site = originOf(url), u = lower(withoutFragment(url));
  let best: { project: Project; score: number } | null = null;
  for (const project of projects) {
    if (project.id === skip) continue;
    for (const pattern of project.match ?? []) {
      if (!site || originOf(pattern) !== site) continue;
      const p = lower(pattern).replace(/\*.*$/, '');
      let shared = 0;
      while (shared < p.length && shared < u.length && p[shared] === u[shared]) shared += 1;
      if (!best || shared > best.score) best = { project, score: shared };
    }
  }
  return best?.project ?? null;
}
