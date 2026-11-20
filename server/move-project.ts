// Move a whole thread from one project to another. The folder (messages, images, checklist, reminders),
// the artifacts and share links that belong to it, and the vault entries for its redacted messages all go together.
// A thread id that is free in the target is kept. One that is taken gets a new id, and every reference is rewritten
// from one map built before anything is written — the same idea as the merge id remap — so quotes, merges and the vault still resolve.
// The copy lands in the target before the source is removed, so a failure leaves the thread where it was. Running it again finishes or changes nothing.
import { cp, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { ART_ID, listArtifacts, readArtifact } from './artifacts';
import { projectById, type Project } from './projects';
import { isActive, readShares, transferShares, type Share } from './shares';
import { checkVault, copyVaultEntry, removeVaultEntry } from './sensitive';
import { ID, Invalid, itemDir, logEvent, materialise, newId, optional, readItem, readPins, setPin, withLock, writeAtomic } from './store';

export interface MoveInput { projects: Project[]; from: string; to: string; thread: string; dryRun?: boolean; vault?: string | null }
export interface MoveProjectResult {
  moved: boolean; dryRun: boolean; id: string; fromId: string; from: string; to: string; fromName: string; toName: string;
  threads: { from: string; to: string }[]; artifacts: { from: string; to: string }[]; shares: number; views: number; redacted: number;
}
interface VaultMove { oldKey: string; newKey: string }
interface Journal {
  to: string; at: string; fromName: string; state: 'copying' | 'committed';
  ids: Record<string, string>; artifacts: Record<string, string>; shares: Record<string, string>; vault: VaultMove[]; events?: boolean;
}
interface Plan {
  journal: Journal; ids: Map<string, string>; arts: Map<string, string>; shareMap: Map<string, string>;
  movingShares: Share[]; views: number; activeShares: number;
}

const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
const isDir = async (path: string) => { try { return (await lstat(path)).isDirectory(); } catch { return false; } };
const movedLine = (name: string) => `Moved from ${name}`;
const journalPath = (dir: string, thread: string) => join(dir, '_moves', `${thread}.json`);

export function describeMove(result: MoveProjectResult): string {
  const where = `${result.toName} (${result.to})`;
  if (result.dryRun) {
    const lines = ['dry run', result.id === result.fromId ? `${result.fromId} → ${where}, same id` : `${result.fromId} → ${where}, id taken, a new id is assigned`];
    for (const thread of result.threads) if (thread.from !== result.fromId) lines.push(`  with ${thread.from}${thread.from === thread.to ? '' : ` as ${thread.to}`} (merged into it)`);
    if (result.artifacts.length) lines.push(`  artifacts: ${result.artifacts.map(item => item.from === item.to ? item.from : `${item.from} as ${item.to}`).join(', ')}`);
    if (result.shares) lines.push(`  shares: ${result.shares} ${result.shares === 1 ? 'link' : 'links'}, viewed ${result.views}×`);
    if (result.redacted) lines.push(`  redacted messages: ${result.redacted}`);
    return lines.join('\n');
  }
  if (!result.moved) return `${result.fromId} is already in ${result.toName}${result.id === result.fromId ? '' : ` as ${result.id}`}`;
  return result.id === result.fromId ? `Moved ${result.id} to ${result.toName}` : `Moved ${result.fromId} to ${result.toName} as ${result.id}`;
}

async function readJournal(dir: string, thread: string): Promise<Journal | null> {
  const raw = await optional(journalPath(dir, thread));
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Journal;
    if (!v || typeof v.to !== 'string' || !v.ids || !v.artifacts || !v.shares || !Array.isArray(v.vault)) return null;
    return v;
  } catch { return null; }
}
async function saveJournal(dir: string, thread: string, journal: Journal): Promise<void> {
  await mkdir(join(dir, '_moves'), { recursive: true });
  await writeAtomic(journalPath(dir, thread), `${JSON.stringify(journal, null, 2)}\n`);
}
async function namesIn(dir: string): Promise<string[]> {
  try { return await readdir(dir); } catch (error) { if (code(error) === 'ENOENT') return []; throw error; }
}
async function mergeParent(dir: string, id: string): Promise<string | null> {
  try {
    const v = JSON.parse(await optional(join(dir, id, 'merged.json')) ?? 'null') as { into?: unknown };
    return typeof v?.into === 'string' && ID.test(v.into) ? v.into : null;
  } catch { return null; }
}
// The thread, plus every thread merged into it (and into those). A merged child moves with the thread it was folded into.
async function movedSet(dir: string, root: string): Promise<string[]> {
  const parent = new Map<string, string>();
  for (const id of (await namesIn(dir)).filter(name => ID.test(name))) {
    const into = await mergeParent(dir, id);
    if (into) parent.set(id, into);
  }
  const want = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, into] of parent) if (want.has(into) && !want.has(id)) { want.add(id); grew = true; }
  }
  return [...want].sort();
}
function allocate(taken: Set<string>, make: () => string): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = make();
    if (!taken.has(id)) { taken.add(id); return id; }
  }
  throw new Invalid('Could not allocate an id');
}
async function hasLine(dir: string, id: string, text: string): Promise<boolean> {
  const raw = await optional(join(dir, id, 'thread.jsonl'));
  if (raw === null) return false;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line) as { divider?: boolean; text?: string };
      if (message.divider === true && message.text === text) return true;
    } catch { /* a torn line */ }
  }
  return false;
}
function remapText(text: string, ids: Map<string, string>): string {
  let out = text;
  for (const [from, to] of ids) if (from !== to) out = out.split(`(#/${from}`).join(`(#/${to}`);
  return out;
}
function vaultMoves(raw: string | null, project: string, thread: string): VaultMove[] {
  const out: VaultMove[] = [];
  for (const line of (raw ?? '').split('\n')) {
    if (!line.includes('"redacted"')) continue;
    try {
      const key = (JSON.parse(line) as { redacted?: { key?: unknown } }).redacted?.key;
      if (typeof key !== 'string') continue;
      const msg = /m\d+$/.exec(key)?.[0];
      if (!msg) continue;
      const next = `${project}/${thread}/${msg}`;
      if (next !== key) out.push({ oldKey: key, newKey: next });
    } catch { /* not a message */ }
  }
  return out;
}
async function withLocks<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
  const sorted = [...new Set(paths)].sort();
  const run = (index: number): Promise<T> => index >= sorted.length ? fn() : withLock(sorted[index]!, () => run(index + 1));
  return run(0);
}
async function placeDir(staged: string, final: string): Promise<void> {
  await mkdir(dirname(final), { recursive: true });
  try { await rename(staged, final); }
  catch (error) {
    if (code(error) !== 'EXDEV') throw error;
    await cp(staged, final, { recursive: true });
    await rm(staged, { recursive: true, force: true });
  }
}
function planResult(from: Project, to: Project, thread: string, plan: Plan, moved: boolean, dryRun: boolean): MoveProjectResult {
  return {
    moved, dryRun, id: plan.ids.get(thread) ?? thread, fromId: thread, from: from.id, to: to.id, fromName: plan.journal.fromName, toName: to.name,
    threads: [...plan.ids].map(([fromId, toId]) => ({ from: fromId, to: toId })),
    artifacts: [...plan.arts].map(([fromId, toId]) => ({ from: fromId, to: toId })),
    shares: plan.activeShares, views: plan.views, redacted: plan.journal.vault.length,
  };
}
function emptyPlan(journal: Journal): Plan {
  return { journal, ids: new Map(Object.entries(journal.ids)), arts: new Map(Object.entries(journal.artifacts)), shareMap: new Map(), movingShares: [], views: 0, activeShares: 0 };
}

async function buildPlan(from: Project, to: Project, thread: string, journal: Journal | null): Promise<Plan> {
  await itemDir(from.dir, thread);
  const threads = await movedSet(from.dir, thread);
  const ids = new Map<string, string>(Object.entries(journal?.ids ?? {}));
  const taken = new Set((await namesIn(to.dir)).filter(name => ID.test(name)));
  for (const id of ids.values()) taken.add(id);
  const line = movedLine(journal?.fromName || from.name);
  for (const fromId of threads) {
    if (ids.has(fromId)) continue;
    const ours = taken.has(fromId) && await hasLine(to.dir, fromId, line);
    if (!taken.has(fromId) || ours) { ids.set(fromId, fromId); taken.add(fromId); continue; }
    ids.set(fromId, allocate(taken, newId));
  }
  const idSet = new Set(threads);
  const arts = new Map<string, string>(Object.entries(journal?.artifacts ?? {}));
  const artTaken = new Set((await namesIn(join(to.dir, '_artifacts'))).filter(name => ART_ID.test(name)));
  for (const id of arts.values()) artTaken.add(id);
  for (const meta of await listArtifacts(from.dir)) {
    if (!idSet.has(meta.thread) || arts.has(meta.id)) continue;
    const owner = ids.get(meta.thread) ?? meta.thread;
    const existing = await readArtifact(to.dir, meta.id);
    if (!existing || existing.thread === owner) arts.set(meta.id, meta.id);
    else arts.set(meta.id, allocate(artTaken, () => `a${randomBytes(6).toString('hex')}`));
  }
  const sourceShares = await readShares(from.dir);
  const targetShares = await readShares(to.dir);
  const shareIds = new Map<string, string>(Object.entries(journal?.shares ?? {}));
  const usedShare = new Set([...targetShares.map(share => share.id), ...shareIds.values()]);
  const movingShares: Share[] = [];
  for (const share of sourceShares) {
    if (!arts.has(share.artifact)) continue;
    const artifact = arts.get(share.artifact)!;
    const have = targetShares.find(item => item.token_hash === share.token_hash);
    if (have) { shareIds.set(share.id, have.id); movingShares.push({ ...have, artifact }); continue; }
    let id = shareIds.get(share.id);
    if (id === undefined) {
      if (usedShare.has(share.id)) id = allocate(usedShare, () => `s${randomBytes(4).toString('hex')}`);
      else { id = share.id; usedShare.add(id); }
      shareIds.set(share.id, id);
    }
    movingShares.push({ ...share, id, artifact });
  }
  const shareMap = new Map<string, string>();
  for (const [fromId, toId] of shareIds) if (fromId !== toId) shareMap.set(fromId, toId);
  const active = movingShares.filter(share => isActive(share));
  const vault: VaultMove[] = [];
  const seen = new Set((journal?.vault ?? []).map(item => item.oldKey));
  const stored = journal?.vault?.length ? [...journal.vault] : [];
  if (!stored.length) {
    for (const fromId of threads) {
      for (const item of vaultMoves(await optional(join(from.dir, fromId, 'thread.jsonl')), to.id, ids.get(fromId)!)) {
        if (seen.has(item.oldKey)) continue;
        seen.add(item.oldKey); vault.push(item);
      }
    }
  }
  const next: Journal = {
    to: to.id, at: journal?.at ?? new Date().toISOString(), fromName: journal?.fromName || from.name,
    state: journal?.state === 'committed' ? 'committed' : 'copying',
    ids: Object.fromEntries(ids), artifacts: Object.fromEntries(arts), shares: Object.fromEntries(shareIds),
    vault: stored.length ? stored : vault, ...(journal?.events ? { events: true } : {}),
  };
  return { journal: next, ids, arts, shareMap, movingShares, views: active.reduce((sum, share) => sum + share.views, 0), activeShares: active.length };
}

async function rewriteThread(path: string, plan: Plan, fromId: string, line: string): Promise<void> {
  const file = join(path, 'thread.jsonl');
  if (!(await optional(file)) && await optional(join(path, 'item.json'))) {
    try { await materialise(path, await readItem(path)); } catch { /* the folder still gets the system line */ }
  }
  const raw = await optional(file);
  const out: string[] = [];
  let has = false, max = 0;
  const toThread = plan.ids.get(fromId)!;
  for (const lineText of (raw ?? '').split('\n')) {
    if (!lineText.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(lineText); } catch { out.push(lineText); continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { out.push(lineText); continue; }
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.text === 'string') rec.text = remapText(rec.text, plan.ids);
    if (typeof rec.moved_to === 'string' && plan.ids.has(rec.moved_to)) rec.moved_to = plan.ids.get(rec.moved_to);
    if (typeof rec.moved_from === 'string') {
      const slash = rec.moved_from.indexOf('/');
      const owner = slash > 0 ? rec.moved_from.slice(0, slash) : '';
      if (owner && plan.ids.has(owner)) rec.moved_from = `${plan.ids.get(owner)}${rec.moved_from.slice(slash)}`;
    }
    if (typeof rec.artifact_id === 'string' && plan.arts.has(rec.artifact_id)) rec.artifact_id = plan.arts.get(rec.artifact_id);
    if (typeof rec.share_id === 'string' && plan.shareMap.has(rec.share_id)) rec.share_id = plan.shareMap.get(rec.share_id);
    if (rec.redacted && typeof rec.redacted === 'object' && !Array.isArray(rec.redacted)) {
      const red = rec.redacted as Record<string, unknown>;
      const msg = typeof red.key === 'string' ? /m\d+$/.exec(red.key)?.[0] : undefined;
      if (msg) red.key = `${plan.journal.to}/${toThread}/${msg}`;
    }
    if (typeof rec.id === 'string') { const n = Number(/^m(\d+)$/.exec(rec.id)?.[1] ?? 0); if (n > max) max = n; }
    if (rec.divider === true && rec.text === line) has = true;
    out.push(JSON.stringify(rec));
  }
  if (!has) out.push(JSON.stringify({ id: `m${max + 1}`, author: 'agent', text: line, images: [], created_at: plan.journal.at, divider: true }));
  await writeAtomic(file, `${out.join('\n')}\n`);
  await rewriteNote(join(path, 'merged.json'), note => { if (typeof note.into === 'string' && plan.ids.has(note.into)) note.into = plan.ids.get(note.into); });
  await rewriteNote(join(path, 'awaiting-agent.json'), note => { if (typeof note.from === 'string' && plan.ids.has(note.from)) note.from = plan.ids.get(note.from); });
}
async function rewriteNote(file: string, edit: (note: Record<string, unknown>) => void): Promise<void> {
  const raw = await optional(file);
  if (raw === null) return;
  try {
    const note = JSON.parse(raw) as Record<string, unknown>;
    edit(note);
    await writeAtomic(file, JSON.stringify(note));
  } catch { /* a torn note stays as it was */ }
}
// While the move is still copying and the source exists, the source is the truth: a target copy left by an earlier attempt may be stale, so it is removed and copied again.
// Returns whether this call placed the folder.
async function ensureThread(from: Project, to: Project, fromId: string, plan: Plan): Promise<boolean> {
  const toId = plan.ids.get(fromId)!;
  const line = movedLine(plan.journal.fromName);
  const final = join(to.dir, toId);
  const sourceThere = await isDir(join(from.dir, fromId));
  if (await isDir(final)) {
    if (!(await hasLine(to.dir, toId, line))) throw new Invalid(`Thread id ${toId} is already used in the target project`, 409);
    if (!sourceThere || plan.journal.state !== 'copying') return false;
    await rm(final, { recursive: true, force: true });
  }
  if (!sourceThere) throw new Invalid('Not found', 404);
  const staged = join(to.dir, '_incoming', toId);
  await rm(staged, { recursive: true, force: true });
  await cp(join(from.dir, fromId), staged, { recursive: true });
  await rm(join(staged, '.lock'), { force: true });
  await rewriteThread(staged, plan, fromId, line);
  await placeDir(staged, final);
  return true;
}
async function ensureArtifact(from: Project, to: Project, fromId: string, toId: string, thread: string, plan: Plan): Promise<boolean> {
  const final = join(to.dir, '_artifacts', toId);
  const sourceThere = await isDir(join(from.dir, '_artifacts', fromId));
  if (await isDir(final)) {
    const meta = await readArtifact(to.dir, toId);
    if (meta?.thread !== thread) throw new Invalid(`Artifact id ${toId} is already used in the target project`, 409);
    if (!sourceThere || plan.journal.state !== 'copying') return false;
    await rm(final, { recursive: true, force: true });
  }
  if (!sourceThere) return false;
  const staged = join(to.dir, '_artifacts', '.incoming', toId);
  await rm(staged, { recursive: true, force: true });
  await mkdir(dirname(staged), { recursive: true });
  await cp(join(from.dir, '_artifacts', fromId), staged, { recursive: true });
  const raw = await optional(join(staged, 'meta.json'));
  if (raw !== null) {
    const meta = JSON.parse(raw) as Record<string, unknown>;
    meta.id = toId; meta.thread = thread;
    await writeAtomic(join(staged, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  }
  await placeDir(staged, final);
  return true;
}
async function movePins(from: Project, to: Project, ids: Map<string, string>): Promise<void> {
  const pins = await readPins(from.dir);
  for (const [fromId, toId] of ids) {
    if (!pins.threads.includes(fromId)) continue;
    await setPin(from.dir, { kind: 'thread', id: fromId, pinned: false });
    await setPin(to.dir, { kind: 'thread', id: toId, pinned: true });
  }
}
async function writeEvents(from: Project, to: Project, thread: string, plan: Plan): Promise<void> {
  if (plan.journal.events) return;
  const id = plan.ids.get(thread) ?? thread;
  await logEvent(from.dir, { id: thread, kind: 'moved', text: `Moved ${thread} to ${to.name}`, author: 'system' });
  await logEvent(to.dir, { id, kind: 'moved', text: `Moved ${id} from ${plan.journal.fromName}`, author: 'system' });
  plan.journal.events = true;
  await saveJournal(from.dir, thread, plan.journal);
}
async function removeSources(from: Project, to: Project, plan: Plan): Promise<void> {
  for (const [fromId, toId] of plan.arts) {
    if (await isDir(join(to.dir, '_artifacts', toId))) await rm(join(from.dir, '_artifacts', fromId), { recursive: true, force: true });
  }
  for (const fromId of plan.ids.keys()) await rm(join(from.dir, fromId), { recursive: true, force: true });
}
async function shiftVault(vault: string, moves: VaultMove[], removeOld: boolean): Promise<void> {
  for (const item of moves) {
    if (!removeOld) await copyVaultEntry(vault, item.oldKey, item.newKey, item.newKey.split('/')[1] ?? '');
    else await removeVaultEntry(vault, item.oldKey);
  }
}
async function leftoverShares(from: Project, plan: Plan): Promise<Share[]> {
  const arts = plan.arts;
  return (await readShares(from.dir)).flatMap(share => {
    if (!arts.has(share.artifact)) return [];
    return [{ ...share, id: plan.journal.shares[share.id] ?? share.id, artifact: arts.get(share.artifact)! }];
  });
}
async function commit(from: Project, to: Project, thread: string, plan: Plan, vault: string | null): Promise<void> {
  await mkdir(to.dir, { recursive: true });
  const line = movedLine(plan.journal.fromName);
  const placedThreads: string[] = [], placedArts: string[] = [];
  let vaultCopied = false;
  try {
    for (const [fromId, toId] of plan.ids) {
      if (!(await isDir(join(from.dir, fromId))) && await hasLine(to.dir, toId, line)) continue;
      if (await ensureThread(from, to, fromId, plan)) placedThreads.push(toId);
    }
    for (const [fromId, toId] of plan.arts) {
      const meta = await readArtifact(from.dir, fromId);
      const threadId = meta ? (plan.ids.get(meta.thread) ?? meta.thread) : (plan.ids.get(thread) ?? thread);
      if (!meta && await isDir(join(to.dir, '_artifacts', toId))) continue;
      if (await ensureArtifact(from, to, fromId, toId, threadId, plan)) placedArts.push(toId);
    }
    if (vault && plan.journal.vault.length) { vaultCopied = true; await shiftVault(vault, plan.journal.vault, false); }
    plan.journal.state = 'committed';
    try { await saveJournal(from.dir, thread, plan.journal); } catch (error) { plan.journal.state = 'copying'; throw error; }
  } catch (error) {
    // Not committed: take back what this attempt placed, so the target shows no half-moved thread and the source stays the only copy.
    if (plan.journal.state !== 'committed') {
      for (const id of placedThreads) await rm(join(to.dir, id), { recursive: true, force: true }).catch(() => {});
      for (const id of placedArts) await rm(join(to.dir, '_artifacts', id), { recursive: true, force: true }).catch(() => {});
      if (vault && vaultCopied) for (const item of plan.journal.vault) await removeVaultEntry(vault, item.newKey).catch(() => {});
    }
    throw error;
  }
  const shares = plan.movingShares.length ? plan.movingShares : await leftoverShares(from, plan);
  if (shares.length) await transferShares(from.dir, to.dir, shares);
  await movePins(from, to, plan.ids);
  await removeSources(from, to, plan);
  if (vault && plan.journal.vault.length) await shiftVault(vault, plan.journal.vault, true);
  await writeEvents(from, to, thread, plan);
}
// The thread is already in the target. Drop leftovers (a share, an old vault key, the source folder) and do not copy again.
async function finishCommitted(from: Project, to: Project, thread: string, plan: Plan, vault: string | null): Promise<void> {
  const shares = await leftoverShares(from, plan);
  if (shares.length) await transferShares(from.dir, to.dir, shares);
  await movePins(from, to, plan.ids);
  await removeSources(from, to, plan);
  if (vault) await shiftVault(vault, plan.journal.vault, true);
  await writeEvents(from, to, thread, plan);
}

export async function moveThreadToProject(input: MoveInput): Promise<MoveProjectResult> {
  if (input.projects.length < 2) throw new Invalid('Moving a thread needs more than one project (set FEEDBACK_PROJECTS)', 409);
  const from = projectById(input.projects, input.from);
  if (input.to === from.id) throw new Invalid('A thread is already in that project', 409);
  const to = projectById(input.projects, input.to);
  if (!ID.test(input.thread)) throw new Invalid('Not found', 404);
  const existing = await readJournal(from.dir, input.thread);
  if (existing && existing.to !== to.id && await isDir(join(from.dir, input.thread))) throw new Invalid('That thread is already being moved to another project', 409);
  if (!(await isDir(join(from.dir, input.thread)))) {
    if (existing?.state === 'committed' && existing.to === to.id) {
      const plan = emptyPlan(existing);
      if (!input.dryRun) {
        const vault = input.vault ? await checkVault(from.dir, input.vault).catch(() => null) : null;
        await finishCommitted(from, to, input.thread, plan, vault);
      }
      return planResult(from, to, input.thread, plan, false, input.dryRun === true);
    }
    throw new Invalid('Not found', 404);
  }
  if (input.dryRun) return planResult(from, to, input.thread, await buildPlan(from, to, input.thread, existing), false, true);
  const paths = (await movedSet(from.dir, input.thread)).map(id => join(from.dir, id));
  return withLocks(paths, async () => {
    if (!(await isDir(join(from.dir, input.thread)))) {
      const again = await readJournal(from.dir, input.thread);
      if (again?.state === 'committed' && again.to === to.id) return planResult(from, to, input.thread, emptyPlan(again), false, false);
      throw new Invalid('Not found', 404);
    }
    const prior = await readJournal(from.dir, input.thread);
    const plan = await buildPlan(from, to, input.thread, prior);
    let vault: string | null = null;
    if (plan.journal.vault.length) {
      if (!input.vault) throw new Invalid('A redacted message needs FEEDBACK_VAULT_DIR so its vault entry can move with the thread', 409);
      vault = await checkVault(from.dir, input.vault);
      await checkVault(to.dir, vault);
    }
    await saveJournal(from.dir, input.thread, plan.journal);
    try {
      await commit(from, to, input.thread, plan, vault);
    } finally {
      await rm(join(to.dir, '_incoming'), { recursive: true, force: true });
      await rm(join(to.dir, '_artifacts', '.incoming'), { recursive: true, force: true });
    }
    return planResult(from, to, input.thread, plan, !(await isDir(join(from.dir, input.thread))), false);
  });
}
