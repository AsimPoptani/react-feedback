import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './cli';
import * as store from './store';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'feedback-rf091-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const threadFile = (id: string) => join(dir, id, 'thread.jsonl');
const readThread = (id: string) => store.summarise(dir, id);
const ask = (id: string, prompt: string) => store.appendMessage(dir, id, { author: 'agent', text: prompt, question: { prompt, options: [{ label: 'A' }] } });

// The answer is stored above its question, which is what a map built during the copy (rather than as each message is visited) has to get right.
async function swap(id: string, a: string, b: string) {
  const raw = await readFile(threadFile(id), 'utf8');
  const lines = raw.split('\n');
  const at = (messageId: string) => lines.findIndex(line => { try { return JSON.parse(line).id === messageId; } catch { return false; } });
  const i = at(a), j = at(b);
  const left = lines[i]!, right = lines[j]!;
  lines[i] = right; lines[j] = left;
  await writeFile(threadFile(id), lines.join('\n'));
}

test('merging an answered question keeps it answered, remaps reply_to, and does not leave it waiting', async () => {
  const into = (await store.createThread(dir, { title: 'Main', text: 'tgt hello', origin: 'user' })).id;
  await store.appendMessage(dir, into, { author: 'agent', text: 'tgt noted', flag: 'fyi' });
  await store.addChecklistItem(dir, into, { owner: 'agent', text: 'already there', by: 'agent' });
  const from = (await store.createThread(dir, { title: 'Side', text: 'src hello', origin: 'user' })).id;
  await store.appendMessage(dir, from, { author: 'agent', text: 'src quote', flag: 'fyi', reply_to: 'm1' });
  // fyi, so an answered question does not keep the thread waiting just because its flag says needs_you. The answer is stored above the question.
  await store.appendMessage(dir, from, { author: 'agent', text: 'Which project?', flag: 'fyi', question: { prompt: 'Which project?', options: [{ label: 'A' }] } });
  await store.appendMessage(dir, from, { author: 'user', text: '', answer: { question_id: 'q3', option_ids: ['o1'] } });
  await swap(from, 'm3', 'm4');
  await store.appendMessage(dir, from, { author: 'agent', text: 'src noted', flag: 'fyi', add_items: [{ owner: 'agent', text: 'follow up' }] });
  expect((await readThread(from)).summary.waiting).toBe('idle');
  expect((await readThread(into)).summary.waiting).toBe('idle');

  await store.mergeThreads(dir, from, into, 'agent');
  const { messages, summary } = await readThread(into);
  const question = messages.find(m => m.question?.prompt === 'Which project?')!;
  const answer = messages.find(m => m.answer)!;
  expect(question.question!.id).not.toBe('q3');
  expect(answer.answer!.question_id).toBe(question.question!.id);
  expect(messages.find(m => m.text === 'src quote')!.reply_to).toBe(messages.find(m => m.text === 'src hello')!.id);
  expect(messages.find(m => m.text === 'src noted')!.added_items).toEqual(['c2']);
  expect(store.openQuestions(messages)).toEqual([]);
  expect(summary.open_question).toBe(false);
  expect(summary.waiting).toBe('idle');
  expect(await run(['list', '--waiting'], dir)).not.toContain(into);
  const note = JSON.parse(await readFile(join(dir, from, 'merged.json'), 'utf8'));
  expect(note.map.questions.q3).toBe(question.question!.id);
  expect((await readThread(from)).messages.find(m => m.answer)!.answer!.question_id).toBe('q3');
});

test('repair-merged re-points a merge from before the fix, leaves other withdrawals, and is idempotent', async () => {
  const into = (await store.createThread(dir, { title: 'Main', text: 'tgt hello', origin: 'user' })).id;
  await store.appendMessage(dir, into, { author: 'agent', text: 'tgt noted', flag: 'fyi' });
  await ask(into, 'Native?');
  await store.cancelQuestion(dir, into, 'q3', 'Changed my mind');
  await ask(into, 'Also native?');
  await store.cancelQuestion(dir, into, 'q4', 'Settled: keep');
  await store.appendMessage(dir, into, { author: 'agent', text: 'tgt done', flag: 'fyi' });
  const from = (await store.createThread(dir, { title: 'Side', text: 'src hello', origin: 'user' })).id;
  await store.appendMessage(dir, from, { author: 'agent', text: 'src quote', flag: 'fyi', reply_to: 'm1' });
  await ask(from, 'Which project?');
  await store.appendMessage(dir, from, { author: 'user', text: '', answer: { question_id: 'q3', option_ids: ['o1'] } });
  await ask(from, 'Ship it?');
  await store.cancelQuestion(dir, from, 'q5', 'Settled: shipped');
  await ask(from, 'Replay?');
  await store.cancelQuestion(dir, from, 'q6', 'Re-asked below (Projects)');
  await store.appendMessage(dir, from, { author: 'agent', text: 'src noted', flag: 'fyi' });
  await store.mergeThreads(dir, from, into, 'agent');

  // The shape left by the old merge: the question was renumbered, the answer and the quote were not, and the question was withdrawn because it looked open.
  const merged = await readFile(threadFile(into), 'utf8');
  const broken = merged.split('\n').map(line => {
    if (!line.trim()) return line;
    const row = JSON.parse(line);
    if (row.text === 'src quote') row.reply_to = 'm1';
    if (row.answer) row.answer.question_id = 'q3';
    return JSON.stringify(row);
  }).join('\n');
  await writeFile(threadFile(into), broken);
  const note = JSON.parse(await readFile(join(dir, from, 'merged.json'), 'utf8'));
  delete note.map;
  await writeFile(join(dir, from, 'merged.json'), JSON.stringify(note));
  const sourceBefore = await readFile(threadFile(from));
  expect(store.openQuestions((await readThread(into)).messages).map(q => q.prompt)).toEqual(['Which project?']);
  const withWorkaround = (await readFile(threadFile(into), 'utf8')).split('\n').map(line => {
    if (!line.trim()) return line;
    const row = JSON.parse(line);
    if (row.text === 'Which project?') row.question.withdrawn = { at: '2026-11-20T12:00:00.000Z', reason: 'Answered: looked open' };
    return JSON.stringify(row);
  }).join('\n');
  await writeFile(threadFile(into), withWorkaround);
  const before = await readFile(threadFile(into));

  const dry = await run(['repair-merged', '--dry-run'], dir);
  expect(dry.startsWith('dry run\n')).toBe(true);
  expect(dry).toContain(`${into}  from ${from}:`);
  expect(dry).toContain('q3 ->');
  expect(dry).toContain('m1 ->');
  expect(dry).toContain('un-withdrew');
  expect(dry).toContain('Answered: looked open');
  expect(dry).toContain('Settled: shipped');
  expect(dry).not.toContain('Changed my mind');
  expect(dry).not.toContain('Settled: keep');
  expect(dry).not.toContain('Re-asked below');
  expect(await readFile(threadFile(into))).toEqual(before);

  const applied = await run(['repair-merged'], dir);
  expect(applied).toContain('q3 ->');
  expect(applied).not.toContain('dry run');
  const { messages, summary } = await readThread(into);
  const question = messages.find(m => m.question?.prompt === 'Which project?')!;
  const shipped = messages.find(m => m.question?.prompt === 'Ship it?')!;
  const replay = messages.find(m => m.question?.prompt === 'Replay?')!;
  const native = messages.find(m => m.question?.prompt === 'Native?')!;
  const also = messages.find(m => m.question?.prompt === 'Also native?')!;
  expect(messages.find(m => m.answer)!.answer!.question_id).toBe(question.question!.id);
  expect(question.question!.withdrawn).toBeUndefined();
  expect(shipped.question!.withdrawn).toBeUndefined();
  expect(replay.question!.withdrawn?.reason).toBe('Re-asked below (Projects)');
  expect(native.question!.withdrawn?.reason).toBe('Changed my mind');
  expect(also.question!.withdrawn?.reason).toBe('Settled: keep');
  expect(messages.find(m => m.text === 'src quote')!.reply_to).toBe(messages.find(m => m.text === 'src hello')!.id);
  expect(store.openQuestions(messages).map(q => q.prompt)).toEqual(['Ship it?']);
  expect(summary.open_question).toBe(true);
  expect(summary.waiting).not.toBe('agent');
  expect(await readFile(threadFile(from))).toEqual(sourceBefore);

  const fixed = await readFile(threadFile(into));
  expect(await run(['repair-merged'], dir)).toContain('nothing to change');
  expect(await run(['repair-merged', '--dry-run'], dir)).toContain('nothing to change');
  expect(await readFile(threadFile(into))).toEqual(fixed);
});

test('repair-merged does nothing when the old ids cannot be recovered', async () => {
  expect(await run(['repair-merged'], dir)).toBe('Nothing to repair.');
  const from = (await store.createThread(dir, { title: 'Side', text: 'src hello', origin: 'user' })).id;
  const into = (await store.createThread(dir, { title: 'Main', text: 'tgt hello', origin: 'user' })).id;
  const gone = '20260101-000000-abcd';
  await writeFile(join(dir, from, 'merged.json'), JSON.stringify({ into: gone, at: '2026-11-20T12:00:00.000Z', state: 'done', base: 0, await_agent: false }));
  const other = (await store.createThread(dir, { title: 'Half', text: 'hello', origin: 'user' })).id;
  await writeFile(join(dir, other, 'merged.json'), JSON.stringify({ into, at: '2026-11-20T12:00:00.000Z', state: 'copying', base: 0, await_agent: false }));
  const before = await readFile(threadFile(into));
  const sourceBefore = await readFile(threadFile(from));
  const out = await run(['repair-merged', '--dry-run'], dir);
  expect(out).toContain(`${gone}  from ${from}: mapping is not recoverable; nothing changed`);
  expect(out).toContain(`${into}  from ${other}: merge did not finish; nothing changed`);
  expect(await readFile(threadFile(into))).toEqual(before);
  expect(await readFile(threadFile(from))).toEqual(sourceBefore);
});
