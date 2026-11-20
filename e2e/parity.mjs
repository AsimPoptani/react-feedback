// Parity check: the API and the CLI of two source trees (an older release and this one) read the same data and must say exactly the same thing.
// It copies the data folder twice into scratch space, so neither tree (and nothing in the folder you name) is written to.
// Run: bun e2e/parity.mjs <older-source-tree> <data-folder>
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [oldTree, source] = process.argv.slice(2).map(p => p && resolve(p));
if (!oldTree || !source) { console.error('Usage: bun e2e/parity.mjs <older-source-tree> <data-folder>'); process.exit(2); }
const here = resolve(import.meta.dir, '..');
// One fixed clock for both trees, so a relative time ("5 min ago") cannot differ between two runs a few seconds apart.
const FIXED = Date.now(), RealDate = Date;
globalThis.Date = class extends RealDate { constructor(...args) { if (args.length === 0) super(FIXED); else super(...args); } static now() { return FIXED; } };
const scratch = await mkdtemp(join(tmpdir(), 'parity-'));
async function capture(tree, label) {
  const dir = join(scratch, label);
  await cp(source, dir, { recursive: true, preserveTimestamps: true });
  const { createHandler } = await import(join(tree, 'server/server.ts'));
  const { run } = await import(join(tree, 'server/cli.ts'));
  const handle = createHandler(dir);
  const out = {};
  const get = async path => {
    const res = await handle(new Request(`http://local/__feedback/api/${path}`));
    const text = await res.text();
    let body = text; try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body };
  };
  const list = await get('threads');
  out['threads'] = list;
  for (const t of Array.isArray(list.body) ? list.body : []) out[`threads/${t.id}`] = await get(`threads/${t.id}`);
  for (const path of ['metrics?window=all', 'tracker', 'profile', 'pins', 'areas', 'artifacts', 'shares', 'items']) out[path] = await get(path);
  const ids = Array.isArray(list.body) ? list.body.map(t => t.id) : [];
  const quiet = () => {};
  for (const command of [['list'], ['tracker'], ['todos'], ...ids.map(id => ['read', id])]) {
    try { out[`cli ${command.join(' ')}`] = await run(command, dir, undefined, {}, quiet); } catch (error) { out[`cli ${command.join(' ')}`] = `error: ${error.message}`; }
  }
  return out;
}
// Clock-dependent fields are not part of the comparison.
const volatile = new Set(['generated_at', 'version']);
const clean = value => JSON.parse(JSON.stringify(value, (key, v) => (volatile.has(key) ? undefined : v)));
try {
  const before = clean(await capture(oldTree, 'old'));
  const after = clean(await capture(here, 'new'));
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const diffs = keys.filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  const threads = keys.filter(k => k.startsWith('threads/')).length;
  console.log(`${keys.length} responses compared (${threads} threads, ${(await readdir(source)).length} entries in the folder)`);
  for (const k of diffs) console.log('DIFF', k);
  console.log(diffs.length ? `${diffs.length} diffs` : 'zero diffs');
  process.exitCode = diffs.length ? 1 : 0;
} finally { await rm(scratch, { recursive: true, force: true }); }
