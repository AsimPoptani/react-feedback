import { afterEach, beforeEach, expect, test } from 'bun:test';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from './store';
import { agentName, onEnd, onPrompt, onStop, loadProjects as loadOriginMap, ownsCapture, readSession, runClaudeCode, unseen, wait } from './claude-code';
import { injectWidget } from './proxy';
import { areaOf, parseAreas } from './inbox/areas.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'rf-cc-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const S = { session_id: 'sess-1', cwd: '/Users/me/Repo/shop' };
const thread = async () => (await readSession(dir, 'sess-1'))!.thread;
const messages = async () => { const path = await store.itemDir(dir, await thread()); return store.readMessages(path, await store.readItem(path)); };

test('the first prompt makes the thread as you, grouped under the folder', async () => {
  await onPrompt(dir, { ...S, prompt: 'fix the checkout button\nit is broken' });
  const [t] = await store.listThreads(dir);
  expect(t!.title).toBe('fix the checkout button');
  expect(t!.url).toBe('/claude/shop');
  expect(areaOf(t!, parseAreas({ areas: [{ key: 'claude', label: 'Claude', match: '/claude', sub: 1 }] })).area).toBe('claude:shop');
  expect(areaOf({ mode: 'thread', url: null }).area).toBe('conversations');
});

test('a turn-end reply goes in as the folder agent and wants you; later prompts are mirrored', async () => {
  await onPrompt(dir, { ...S, prompt: 'first' });
  await onStop(dir, { ...S, last_assistant_message: 'Done the first thing. Shall I push?' });
  await onPrompt(dir, { ...S, prompt: 'yes push' });
  const ms = await messages();
  expect(ms.map(m => [m.author, m.text])).toEqual([['user', 'first'], ['agent', 'Done the first thing. Shall I push?'], ['user', 'yes push']]);
  expect(ms[1]!.agent_name).toBe('shop');
  expect(ms[1]!.flag).toBe('needs_you');
  expect(ms[2]!.client_id?.startsWith('cc-')).toBe(true);
  expect(await unseen(dir, 'sess-1', await thread())).toBeNull(); // nothing you wrote in the inbox: the mirrored prompts never wake the session
});

test('a message you write in the inbox wakes the waiter once, with images and quotes', async () => {
  await onPrompt(dir, { ...S, prompt: 'first' });
  await onStop(dir, { ...S, last_assistant_message: 'Which colour?' });
  let woke = '';
  const waiting = wait(dir, S, { poll: 20, out: t => { woke = t; } });
  await Bun.sleep(60);
  await store.appendMessage(dir, await thread(), { author: 'user', text: 'blue please', reply_to: 'm2' });
  expect(await waiting).toBe(2);
  expect(woke).toContain('blue please');
  expect(woke).toContain('(quoting agent m2: Which colour?)');
  expect(await unseen(dir, 'sess-1', await thread())).toBeNull();
});

test('a side question is answered as a side answer; the one-shot flag closes the thread', async () => {
  await onPrompt(dir, { ...S, prompt: 'first' });
  await onStop(dir, { ...S, last_assistant_message: 'working' });
  await store.appendMessage(dir, await thread(), { author: 'user', text: 'what port?', aside: true });
  expect(await unseen(dir, 'sess-1', await thread())).toContain('Side question');
  await onStop(dir, { ...S, last_assistant_message: '8099' });
  let ms = await messages();
  expect(ms[ms.length - 1]).toMatchObject({ aside: true, reply_to: 'm3', text: '8099' });
  await runClaudeCode(['flag', 'done'], dir, { CLAUDE_CODE_SESSION_ID: 'sess-1' });
  await onStop(dir, { ...S, last_assistant_message: 'All shipped.' });
  ms = await messages();
  expect(ms[ms.length - 1]!.flag).toBe('done');
  expect((await store.listThreads(dir))[0]!.status).toBe('done');
});

test('a newer waiter takes over; ending the session stops it and leaves a resume note', async () => {
  await onPrompt(dir, { ...S, prompt: 'first' });
  const first = wait(dir, S, { poll: 20, out: () => {} });
  await Bun.sleep(60);
  await onEnd(dir, { ...S, reason: 'prompt_input_exit' }); // in-process the pid matches, so the pid file going is what stops it
  expect(await first).toBe(0);
  const ms = await messages();
  expect(ms[ms.length - 1]!.text).toContain('claude --resume sess-1');
});

test('hooks stay quiet when switched off or headless, and never throw', async () => {
  const stdin = async () => JSON.stringify({ ...S, prompt: 'hi' });
  expect(await runClaudeCode(['prompt'], dir, { REACT_FEEDBACK_CLAUDE: 'off' }, stdin)).toBe(0);
  expect(await runClaudeCode(['prompt'], dir, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, stdin)).toBe(0);
  expect(await store.listThreads(dir)).toEqual([]);
  expect(await runClaudeCode(['stop'], dir, {}, async () => '{"session_id":"../x"}')).toBe(0);
  expect(await runClaudeCode(['prompt'], dir, {}, stdin)).toBe(0);
  expect((await store.listThreads(dir)).length).toBe(1);
});

test('the agent is named after the folder, never a reserved name', () => {
  expect(agentName('/a/hub-569-main')).toBe('hub-569-main');
  expect(agentName('/Users/you')).toBe('Claude');
});

// A capture as the widget's server makes it: item.json, the note as m1, and a `thread` event.
async function capture(url: string, note: string): Promise<string> {
  const { id, path, created_at } = await store.makeItemFolder(dir);
  await Bun.write(join(path, 'item.json'), JSON.stringify({ id, created_at, note, mode: 'region', context: { url }, image: 'image.png' }));
  await Bun.write(join(path, 'status.json'), JSON.stringify({ status: 'open' }));
  await store.startCaptureThread(dir, id, note, created_at);
  await store.logEvent(dir, { id, kind: 'thread', text: note });
  return id;
}
const PROJECTS = { 'http://localhost:5185': '/Users/me/Repo/shop', 'http://localhost:5392': '/Users/me/Repo/hub' };

test('a capture from a project page wakes a session in that folder, once, and the reply goes to the capture', async () => {
  await onPrompt(dir, { ...S, prompt: 'first' });
  await onStop(dir, { ...S, last_assistant_message: 'ok' });
  const H = { session_id: 'sess-2', cwd: '/Users/me/Repo/hub/apps/demo' };
  await onPrompt(dir, { ...H, prompt: 'hub work' });
  await onStop(dir, { ...H, last_assistant_message: 'ok' });
  let shop = '', hub = '';
  const waitingShop = wait(dir, S, { poll: 20, projects: PROJECTS, out: t => { shop = t; } });
  const waitingHub = wait(dir, H, { poll: 20, projects: PROJECTS, out: t => { hub = t; } });
  await Bun.sleep(60);
  const cap = await capture('http://localhost:5392/dashboard', 'the chart overlaps the legend');
  expect(await waitingHub).toBe(2);
  expect(hub).toContain('Feedback capture from http://localhost:5392/dashboard');
  expect(hub).toContain('the chart overlaps the legend');
  expect(hub).toContain(join(dir, cap, 'image.png'));
  expect(shop).toBe('');
  await onStop(dir, { ...H, last_assistant_message: 'Fixed the legend.' });
  const path = await store.itemDir(dir, cap);
  const ms = await store.readMessages(path, await store.readItem(path));
  expect(ms.map(m => [m.author, m.text])).toEqual([['user', 'the chart overlaps the legend'], ['agent', 'Fixed the legend.']]);
  // your reply on the capture wakes the session that took it
  let again = '';
  const next = wait(dir, H, { poll: 20, projects: PROJECTS, out: t => { again = t; } });
  await Bun.sleep(60);
  await store.appendMessage(dir, cap, { author: 'user', text: 'still overlapping on mobile' });
  expect(await next).toBe(2);
  expect(again).toContain('still overlapping on mobile');
  await onEnd(dir, S); await onEnd(dir, H);
  expect(await waitingShop).toBe(0);
});

test('a capture that came in while nobody waited goes to the next session in the folder; a typed prompt sends the reply home', async () => {
  const cap = await capture('http://localhost:5185/cart', 'button is grey');
  await onPrompt(dir, { ...S, prompt: 'first' });
  let woke = '';
  expect(await wait(dir, S, { poll: 20, projects: PROJECTS, out: t => { woke = t; } })).toBe(2);
  expect(woke).toContain('button is grey');
  await onPrompt(dir, { ...S, prompt: 'actually do something else' });
  await onStop(dir, { ...S, last_assistant_message: 'Doing the other thing.' });
  const path = await store.itemDir(dir, cap);
  expect((await store.readMessages(path, await store.readItem(path))).length).toBe(1);
  expect((await messages()).at(-1)!.text).toBe('Doing the other thing.');
});

test('capture ownership is by page origin and folder', () => {
  expect(ownsCapture(PROJECTS, '/Users/me/Repo/hub', 'http://localhost:5392/x')).toBe(true);
  expect(ownsCapture(PROJECTS, '/Users/me/Repo/hubby', 'http://localhost:5392/x')).toBe(false);
  expect(ownsCapture(PROJECTS, '/Users/me/Repo/hub', 'http://localhost:5185/x')).toBe(false);
  expect(ownsCapture(PROJECTS, '/Users/me/Repo/hub', 'not a url')).toBe(false);
});

test('the proxy puts the widget before </body>', () => {
  expect(injectWidget('<html><body><div id="root"></div></body></html>')).toBe('<html><body><div id="root"></div><script src="/__feedback/embed.js" data-endpoint="/__feedback"></script></body></html>');
  expect(injectWidget('<p>x', 'bottom-right')).toContain('data-position="bottom-right"');
});

test('a message merged into another followed thread does not wake the session twice', async () => {
  const a = await capture('http://localhost:5185/a', 'first capture');
  const b = await capture('http://localhost:5185/b', 'second capture');
  await onPrompt(dir, { ...S, prompt: 'first' });
  const outs: string[] = [];
  expect(await wait(dir, S, { poll: 20, projects: PROJECTS, out: t => outs.push(t) })).toBe(2);
  expect(await wait(dir, S, { poll: 20, projects: PROJECTS, out: t => outs.push(t) })).toBe(2);
  await store.appendMessage(dir, a, { author: 'user', text: 'merge these please', client_id: 'inbox-abcdef12' });
  expect(await unseen(dir, 'sess-1', a)).toContain('merge these please');
  await store.mergeThreads(dir, a, b, 'agent');
  expect(await unseen(dir, 'sess-1', b)).toBeNull();
});

// Both captures are followed (the first two waits claim them); `a` is merged into `b` by the tests below.
async function followTwo(): Promise<{ a: string; b: string }> {
  const a = await capture('http://localhost:5185/a', 'first capture');
  const b = await capture('http://localhost:5185/b', 'second capture');
  await onPrompt(dir, { ...S, prompt: 'first' });
  expect(await wait(dir, S, { poll: 20, projects: PROJECTS, out: () => {} })).toBe(2);
  expect(await wait(dir, S, { poll: 20, projects: PROJECTS, out: () => {} })).toBe(2);
  return { a, b };
}

test('0.9.2: a post to a merged-away thread is written on the target and wakes the session once', async () => {
  const { a, b } = await followTwo();
  await store.mergeThreads(dir, a, b, 'agent');
  // with and without a client_id (the CLI and the MCP tools send none)
  const withId = await store.appendMessage(dir, a, { author: 'user', text: 'forwarded with id', client_id: 'inbox-fwd00001' });
  const bare = await store.appendMessage(dir, a, { author: 'user', text: 'forwarded bare' });
  expect(withId.forwarded_to).toBe(b);
  expect(bare.forwarded_to).toBe(b);
  const woke = await unseen(dir, 'sess-1', b);
  expect(woke).toContain('forwarded with id');
  expect(woke).toContain('forwarded bare');
  expect(await unseen(dir, 'sess-1', b)).toBeNull();
  expect(await unseen(dir, 'sess-1', a)).toBeNull(); // nothing was written on the source
});

test('0.9.2: a forwarded answer wakes once, and the source thread stays quiet', async () => {
  const { a, b } = await followTwo();
  await store.appendMessage(dir, a, { author: 'agent', text: 'Which one?', question: { prompt: 'Which one?', options: [{ label: 'X' }] } });
  await store.mergeThreads(dir, a, b, 'agent');
  const q = (await store.summarise(dir, a)).messages.find(m => m.question)!.question!.id;
  const answered = await store.appendMessage(dir, a, { author: 'user', text: '', answer: { question_id: q, option_ids: ['o1'] } });
  expect(answered.forwarded_to).toBe(b);
  expect(await unseen(dir, 'sess-1', b)).toContain('Answer');
  expect(await unseen(dir, 'sess-1', b)).toBeNull();
  expect(await unseen(dir, 'sess-1', a)).toBeNull();
});

test('0.9.2: a message written before a merge and woken on the source does not wake again on the target', async () => {
  const { a, b } = await followTwo();
  await store.appendMessage(dir, a, { author: 'user', text: 'before the merge' }); // no client_id
  expect(await unseen(dir, 'sess-1', a)).toContain('before the merge');
  await store.mergeThreads(dir, a, b, 'agent');
  expect(await unseen(dir, 'sess-1', b)).toBeNull();
  // and the other order: merged first, woken on the target, then the source is read
  const c = await capture('http://localhost:5185/c', 'third capture');
  const d = await capture('http://localhost:5185/d', 'fourth capture');
  await store.appendMessage(dir, c, { author: 'user', text: 'merged before any wake' });
  await onEnd(dir, S);
  await onPrompt(dir, { ...S, prompt: 'again' });
  expect(await wait(dir, S, { poll: 20, projects: PROJECTS, out: () => {} })).toBe(2);
  await store.mergeThreads(dir, c, d, 'agent');
  const once = [await unseen(dir, 'sess-1', d), await unseen(dir, 'sess-1', c)].filter(Boolean);
  expect(once.length).toBeLessThanOrEqual(1);
});

for (const withClientId of [true, false]) {
  test(`0.9.2: repair-merged carrying a stranded answer to the target does not wake the session again (client_id ${withClientId})`, async () => {
    const { a, b } = await followTwo();
    await store.appendMessage(dir, a, { author: 'agent', text: 'Which one?', question: { prompt: 'Which one?', options: [{ label: 'X' }] } });
    await store.mergeThreads(dir, a, b, 'agent');
    const note = JSON.parse(await Bun.file(join(dir, a, 'merged.json')).text());
    const src = (await store.summarise(dir, a)).messages;
    // what an older server did: the post landed on the source after the merge
    const stranded = { id: `m${src.length + 1}`, author: 'user', text: 'Chose: X', images: [], created_at: new Date(Date.parse(note.at) + 1000).toISOString(), ...(withClientId ? { client_id: 'inbox-strand01' } : {}), answer: { question_id: src.find(m => m.question)!.question!.id, option_ids: ['o1'] } };
    await appendFile(join(dir, a, 'thread.jsonl'), `${JSON.stringify(stranded)}\n`);
    expect(await unseen(dir, 'sess-1', a)).toContain('Chose: X'); // woken on the source
    const out = await store.repairMerged(dir);
    expect(out.some(r => r.status === 'repaired')).toBe(true);
    const copy = (await store.summarise(dir, b)).messages.find(m => m.text.includes('Sent in') && m.text.includes('Chose: X'));
    expect(copy).toBeDefined();
    expect(await unseen(dir, 'sess-1', b)).toBeNull(); // the carried copy is the same message
    expect(await unseen(dir, 'sess-1', a)).toBeNull();
    await store.repairMerged(dir); // a second run adds nothing, so nothing wakes
    expect(await unseen(dir, 'sess-1', b)).toBeNull();
  });
}

test('0.9.2: a stranded answer repaired before the session saw it wakes it once, not twice', async () => {
  const { a, b } = await followTwo();
  await store.appendMessage(dir, a, { author: 'agent', text: 'Which one?', question: { prompt: 'Which one?', options: [{ label: 'X' }] } });
  await store.mergeThreads(dir, a, b, 'agent');
  const note = JSON.parse(await Bun.file(join(dir, a, 'merged.json')).text());
  const src = (await store.summarise(dir, a)).messages;
  const stranded = { id: `m${src.length + 1}`, author: 'user', text: 'Chose: X', images: [], created_at: new Date(Date.parse(note.at) + 1000).toISOString(), answer: { question_id: src.find(m => m.question)!.question!.id, option_ids: ['o1'] } };
  await appendFile(join(dir, a, 'thread.jsonl'), `${JSON.stringify(stranded)}\n`);
  await store.repairMerged(dir);
  const wakes = [await unseen(dir, 'sess-1', b), await unseen(dir, 'sess-1', a)].filter(Boolean);
  expect(wakes.length).toBe(1);
  expect(await unseen(dir, 'sess-1', b)).toBeNull();
  expect(await unseen(dir, 'sess-1', a)).toBeNull();
});

test('saving a key in the key box wakes the session that asked for it', async () => {
  await onPrompt(dir, { ...S, prompt: 'first' });
  let woke = '';
  const waiting = wait(dir, S, { poll: 20, projects: PROJECTS, out: t => { woke = t; } });
  await Bun.sleep(60);
  await store.logEvent(dir, { id: await thread(), kind: 'secret', text: 'elevenlabs saved' });
  expect(await waiting).toBe(2);
  expect(woke).toContain('elevenlabs saved');
});

test('with conversations on, a conversation you start in the inbox goes to the waiting session; Claude session threads never do', async () => {
  await onPrompt(dir, { ...S, prompt: 'first' });
  const H = { session_id: 'sess-2', cwd: '/Users/me/Repo/hub' };
  await onPrompt(dir, { ...H, prompt: 'other session' });
  let woke = '';
  const waiting = wait(dir, S, { poll: 20, projects: PROJECTS, conversations: true, out: t => { woke = t; } });
  await Bun.sleep(60);
  const { id: conv } = await store.createThread(dir, { title: 'Investigate this user', text: 'please look', origin: 'user' });
  expect(await waiting).toBe(2);
  expect(woke).toContain('please look');
  expect(woke).toContain(conv);
  let off = '';
  const quiet = wait(dir, { session_id: 'sess-2', cwd: H.cwd }, { poll: 20, projects: PROJECTS, out: t => { off = t; } });
  await Bun.sleep(60);
  await store.createThread(dir, { title: 'another', text: 'no listener with conversations off', origin: 'user' });
  await Bun.sleep(80);
  expect(off).toBe('');
  await onEnd(dir, { session_id: 'sess-2', cwd: H.cwd });
  expect(await quiet).toBe(0);
});

test('FEEDBACK_ORIGIN_MAP is the bridge origin map; FEEDBACK_PROJECTS (the server project list) is never read as one', () => {
  const list = '[{"id":"a","name":"A","dir":"/tmp/a"}]';
  const map = join(dir, 'map.json');
  Bun.write(map, JSON.stringify({ 'http://localhost:5185': '/Users/me/Repo/shop' }));
  const shop = { 'http://localhost:5185': '/Users/me/Repo/shop' };
  expect(loadOriginMap({ FEEDBACK_ORIGIN_MAP: map })).toEqual(shop);
  expect(loadOriginMap({ FEEDBACK_ORIGIN_MAP: map, FEEDBACK_PROJECTS: list })).toEqual(shop);
  expect(loadOriginMap({ FEEDBACK_PROJECTS: list })).toEqual({});
  expect(loadOriginMap({ FEEDBACK_PROJECTS: map })).toEqual({});
  expect(loadOriginMap({})).toEqual({});
});
