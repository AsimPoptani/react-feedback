// One feedback server can hold several projects. FEEDBACK_PROJECTS is a JSON list of {id, name, dir}.
// Unset, there is one project: FEEDBACK_DIR, and every URL is the one the server has always served.
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Invalid, MIME, sniff, type Extension } from './store';

// `icon` is the resolved path of an optional PNG, JPEG or WebP picture for the project. It is never sent to a browser.
export interface Project { id: string; name: string; dir: string; icon?: string }
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
    const extra = Object.keys(rec).filter(key => key !== 'id' && key !== 'name' && key !== 'dir' && key !== 'icon');
    if (extra.length) throw new Invalid(`Unknown project field "${extra[0]}"`);
    if (typeof rec.id !== 'string' || !ID.test(rec.id)) throw new Invalid('A project id is 1–40 characters of a-z, 0-9, _ or -, starting with a letter or digit');
    if (typeof rec.name !== 'string' || !rec.name.trim() || rec.name.length > 80) throw new Invalid('A project name is 1–80 characters');
    if (typeof rec.dir !== 'string' || !rec.dir.trim()) throw new Invalid(`Project "${rec.id}" needs a dir`);
    if (ids.has(rec.id)) throw new Invalid(`Duplicate project id "${rec.id}"`);
    const dir = resolve(rec.dir.trim());
    if (dirs.has(dir)) throw new Invalid(`Two projects use the same directory`);
    if (rec.icon !== undefined && (typeof rec.icon !== 'string' || !rec.icon.trim())) throw new Invalid(`Project "${rec.id}" has an icon that is not a path`);
    ids.add(rec.id); dirs.add(dir);
    out.push({ id: rec.id, name: rec.name.trim(), dir, ...(typeof rec.icon === 'string' ? { icon: resolve(rec.icon.trim()) } : {}) });
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
