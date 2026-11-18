// Server configuration read from the environment. Today that is the optional inbox areas.
import { readFileSync } from 'node:fs';
import { DEFAULT_AREAS, parseAreas, type AreasConfig } from './inbox/areas.js';
import { Invalid } from './store';

// FEEDBACK_AREAS is a path to a JSON file, FEEDBACK_AREAS_JSON is the JSON itself. Throws an Invalid with a clear message when it cannot be used.
export function loadAreas(env: Record<string, string | undefined> = process.env): AreasConfig {
  const file = env.FEEDBACK_AREAS?.trim(), inline = env.FEEDBACK_AREAS_JSON?.trim();
  if (file && inline) throw new Invalid('Set only one of FEEDBACK_AREAS (a file path) and FEEDBACK_AREAS_JSON');
  if (!file && !inline) return DEFAULT_AREAS;
  const source = file ? `FEEDBACK_AREAS (${file})` : 'FEEDBACK_AREAS_JSON';
  let text = inline ?? '';
  if (file) {
    try { text = readFileSync(file, 'utf8'); }
    catch (error) { throw new Invalid(`${source}: cannot read the file (${(error as NodeJS.ErrnoException).code ?? 'error'})`); }
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (error) { throw new Invalid(`${source}: not valid JSON (${(error as Error).message})`); }
  try { return parseAreas(raw); } catch (error) { throw new Invalid(`${source}: ${(error as Error).message}`); }
}
