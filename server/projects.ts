// One feedback server can hold several projects. FEEDBACK_PROJECTS is a JSON list of {id, name, dir}.
// Unset, there is one project: FEEDBACK_DIR, and every URL is the one the server has always served.
import { resolve } from 'node:path';
import { Invalid } from './store';

export interface Project { id: string; name: string; dir: string }

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
    const extra = Object.keys(rec).filter(key => key !== 'id' && key !== 'name' && key !== 'dir');
    if (extra.length) throw new Invalid(`Unknown project field "${extra[0]}"`);
    if (typeof rec.id !== 'string' || !ID.test(rec.id)) throw new Invalid('A project id is 1–40 characters of a-z, 0-9, _ or -, starting with a letter or digit');
    if (typeof rec.name !== 'string' || !rec.name.trim() || rec.name.length > 80) throw new Invalid('A project name is 1–80 characters');
    if (typeof rec.dir !== 'string' || !rec.dir.trim()) throw new Invalid(`Project "${rec.id}" needs a dir`);
    if (ids.has(rec.id)) throw new Invalid(`Duplicate project id "${rec.id}"`);
    const dir = resolve(rec.dir.trim());
    if (dirs.has(dir)) throw new Invalid(`Two projects use the same directory`);
    ids.add(rec.id); dirs.add(dir);
    out.push({ id: rec.id, name: rec.name.trim(), dir });
  }
  return out;
}

export function projectById(projects: Project[], id: string): Project {
  const found = projects.find(project => project.id === id);
  if (!found) throw new Invalid(`Unknown project "${id}"`, 404);
  return found;
}
