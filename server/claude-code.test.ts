import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from './store';
import { agentName, onEnd, onPrompt, onStop, readSession, runClaudeCode, unseen, wait } from './claude-code';
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
  expect(await unseen(dir, 'sess-1')).toBeNull(); // nothing you wrote in the inbox: the mirrored prompts never wake the session
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
  expect(await unseen(dir, 'sess-1')).toBeNull();
});

test('a side question is answered as a side answer; the one-shot flag closes the thread', async () => {
  await onPrompt(dir, { ...S, prompt: 'first' });
  await onStop(dir, { ...S, last_assistant_message: 'working' });
  await store.appendMessage(dir, await thread(), { author: 'user', text: 'what port?', aside: true });
  expect(await unseen(dir, 'sess-1')).toContain('Side question');
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
