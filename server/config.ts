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

// FEEDBACK_SECRET_TARGET: where the inbox's key box sends a pasted key, a path on the same site with `{name}` in it (for example /api/keys/{name}).
// It must be relative: an absolute or protocol-relative URL would let the browser send a key to another origin. Unset or empty means the key box is off.
const SECRET_TARGET = /^\/(?!\/)[A-Za-z0-9/_.~%-]*\{name\}[A-Za-z0-9/_.~%-]*$/;
export function loadSecretTarget(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.FEEDBACK_SECRET_TARGET?.trim();
  if (!value) return null;
  if (!SECRET_TARGET.test(value) || value.split('/').includes('..')) throw new Invalid('FEEDBACK_SECRET_TARGET must be a relative path starting with a single / and containing {name}, for example /api/keys/{name}');
  return value;
}
// FEEDBACK_VAULT_DIR: where redacted messages are kept. Unset means redaction is off. Whether it sits outside FEEDBACK_DIR is checked by validateVault.
export const loadVaultDir = (env: Record<string, string | undefined> = process.env): string | null => env.FEEDBACK_VAULT_DIR?.trim() || null;
