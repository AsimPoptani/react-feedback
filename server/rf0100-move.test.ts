// 0.10 on top of 0.9.3: a project move carries an artifact's session recordings (`_replays/<artifact>`) with it, atomically like the rest of the move.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishArtifact } from './artifacts';
import { moveThreadToProject } from './move-project';
import { appendChunk, heatmap, listReplays, readReplay, setInboxSetting } from './replay';
import { createShare, readShares } from './shares';
import * as store from './store';

let root: string, alpha: string, beta: string;
const projects = () => [{ id: 'alpha', name: 'Alpha', dir: alpha }, { id: 'beta', name: 'Beta', dir: beta }];
const exists = (path: string) => lstat(path).then(() => true, () => false);
const A = 'AbCdEfGhIjKlMnOpQrStUvWx', B = 'ZyXwVuTsRqPoNmLkJiHgFeDc';
const meta = (t: number) => ({ type: 4, timestamp: t, data: { href: 'about:srcdoc', width: 800, height: 600 } });
const snap = (t: number) => ({ type: 2, timestamp: t, data: { node: { id: 1, type: 0, childNodes: [] }, initialOffset: { left: 0, top: 0 } } });
const click = (t: number, x: number, y: number) => ({ type: 3, timestamp: t, data: { source: 2, type: 2, id: 7, x, y } });
const t0 = 1_700_000_000_000;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rf0100-move-'));
  alpha = join(root, 'alpha'); beta = join(root, 'beta');
  await mkdir(alpha); await mkdir(beta);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function recorded() {
  const { id } = await store.createThread(alpha, { title: 'Options', text: 'Pick one', origin: 'agent' });
  const art = await publishArtifact(alpha, { thread: id, title: 'Options', content: '<p>Options</p>', format: 'html' });
  const { share } = await createShare(alpha, { artifact: art.id, expires: 'none', by: 'You', agent: false, record: true });
  for (const [session, x] of [[A, 100], [B, 300]] as const) {
    await appendChunk(alpha, { scope: art.id, link: share.id, version: 1 }, { session, seq: 0, events: [meta(t0), snap(t0 + 1), click(t0 + 500, x, 40)] }, t0);
  }
  return { thread: id, art, share };
}

test('a move carries the artifact\'s recordings: the same sessions in the new project, pointing at the artifact and link there, the source emptied, the link still recording', async () => {
  const { thread, art, share } = await recorded();
  await setInboxSetting(alpha, true); // the inbox's own recording belongs to the project, not to the thread
  await appendChunk(alpha, { scope: '_inbox', link: null, version: null }, { session: A, seq: 0, events: [meta(t0), snap(t0 + 1)] }, t0);
  const before = await readReplay(alpha, art.id, A);
  const result = await moveThreadToProject({ projects: projects(), from: 'alpha', to: 'beta', thread });
  expect(result.moved).toBe(true);
  expect(await exists(join(alpha, '_replays', art.id))).toBe(false);
  const there = await listReplays(beta, art.id);
  expect(there.map(item => item.session).sort()).toEqual([A, B]);
  expect(there.every(item => item.scope === art.id && item.link === share.id && item.version === 1)).toBe(true);
  expect(await readReplay(beta, art.id, A)).toEqual(before!);
  expect((await heatmap(beta, art.id, null)).clicks.length).toBe(2);
  expect((await readdir(join(beta, '_replays', art.id))).filter(name => name.endsWith('.jsonl.gz')).length).toBe(2);
  expect(await exists(join(beta, '_replays', '.incoming'))).toBe(false);
  // The link kept its switch, and the inbox's own recordings and switch stayed in the source project.
  expect((await readShares(beta)).find(item => item.id === share.id)?.record).toBe(true);
  expect(await exists(join(alpha, '_replays', '_inbox'))).toBe(true);
  expect(await exists(join(beta, '_replays', '_inbox'))).toBe(false);
  expect(JSON.parse(await readFile(join(alpha, '_replays', '_settings.json'), 'utf8')).record_inbox).toBe(true);
  expect(await exists(join(beta, '_replays', '_settings.json'))).toBe(false);
  // A moved link goes on recording into the moved folder.
  await appendChunk(beta, { scope: art.id, link: share.id, version: 1 }, { session: A, seq: 1, events: [click(t0 + 900, 5, 5)] }, t0);
  expect((await readReplay(beta, art.id, A))!.meta.clicks).toBe(2);
});

test('when the artifact id or the link id is taken in the target, the recordings follow the new ids', async () => {
  const { thread, art, share } = await recorded();
  // The target already has an artifact and a link with these ids, for another thread.
  const other = (await store.createThread(beta, { title: 'Other', text: 'x', origin: 'user' })).id;
  await cp(join(alpha, '_artifacts', art.id), join(beta, '_artifacts', art.id), { recursive: true });
  const metaPath = join(beta, '_artifacts', art.id, 'meta.json');
  await writeFile(metaPath, JSON.stringify({ ...JSON.parse(await readFile(metaPath, 'utf8')), thread: other }));
  await createShare(beta, { artifact: art.id, expires: 'none', by: 'You', agent: false });
  await writeFile(join(beta, '_shares.json'), JSON.stringify({ shares: (await readShares(beta)).map(item => ({ ...item, id: share.id })) }));
  const result = await moveThreadToProject({ projects: projects(), from: 'alpha', to: 'beta', thread });
  const moved = result.artifacts[0]!;
  expect(moved.from).toBe(art.id);
  expect(moved.to).not.toBe(art.id);
  expect(await exists(join(alpha, '_replays', art.id))).toBe(false);
  expect((await listReplays(beta, art.id)).length).toBe(0); // the other artifact's folder was not touched
  const there = await listReplays(beta, moved.to);
  expect(there.map(item => item.session).sort()).toEqual([A, B]);
  const newLink = (await readShares(beta)).find(item => item.artifact === moved.to)!;
  expect(newLink.id).not.toBe(share.id);
  expect(there.every(item => item.scope === moved.to && item.link === newLink.id)).toBe(true);
});

test('a move that fails leaves the recordings where they were and nothing half-placed; a retry carries them, including ones that arrived in between', async () => {
  const { thread, art, share } = await recorded();
  await mkdir(join(beta, '_replays'), { recursive: true });
  await writeFile(join(beta, '_replays', '.incoming'), 'in the way');
  await expect(moveThreadToProject({ projects: projects(), from: 'alpha', to: 'beta', thread })).rejects.toThrow();
  expect(await exists(join(beta, thread))).toBe(false);
  expect(await exists(join(beta, '_artifacts', art.id))).toBe(false);
  expect(await exists(join(beta, '_replays', art.id))).toBe(false);
  expect((await listReplays(alpha, art.id)).length).toBe(2);
  await appendChunk(alpha, { scope: art.id, link: share.id, version: 1 }, { session: A, seq: 1, events: [click(t0 + 800, 7, 7)] }, t0);
  await rm(join(beta, '_replays', '.incoming'), { force: true });
  const result = await moveThreadToProject({ projects: projects(), from: 'alpha', to: 'beta', thread });
  expect(result.moved).toBe(true);
  expect((await readReplay(beta, art.id, A))!.meta.clicks).toBe(2);
  expect(await exists(join(alpha, '_replays', art.id))).toBe(false);
  // Running it again changes nothing.
  expect((await moveThreadToProject({ projects: projects(), from: 'alpha', to: 'beta', thread })).moved).toBe(false);
  expect((await listReplays(beta, art.id)).length).toBe(2);
});

test('staging links the big files and copies them where a link cannot be made; the lock file is never carried; no recordings means nothing staged', async () => {
  const { art } = await recorded();
  const { stageReplays } = await import('./replay');
  const linked = join(root, 'linked'), copied = join(root, 'copied');
  expect(await stageReplays(alpha, art.id, linked, art.id, {})).toBe(true);
  expect((await readdir(linked)).sort()).toEqual([`${A}.json`, `${A}.jsonl.gz`, `${B}.json`, `${B}.jsonl.gz`]);
  expect((await lstat(join(linked, `${A}.jsonl.gz`))).nlink).toBe(2);
  expect(await stageReplays(alpha, art.id, copied, art.id, {}, async () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); })).toBe(true);
  expect((await lstat(join(copied, `${A}.jsonl.gz`))).nlink).toBe(1);
  expect(await readFile(join(copied, `${A}.jsonl.gz`))).toEqual(await readFile(join(alpha, '_replays', art.id, `${A}.jsonl.gz`)));
  expect(await stageReplays(alpha, 'a000000000000', join(root, 'none'), 'a000000000000', {})).toBe(false);
  expect(await exists(join(root, 'none'))).toBe(false);
});
