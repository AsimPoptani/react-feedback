import { afterEach, beforeEach, expect, test } from 'bun:test';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('a message or answer posted on a merged thread is forwarded, and ask is refused', async () => {
  const into = (await store.createThread(dir, { title: 'Main', text: 'tgt hello', origin: 'user' })).id;
  const from = (await store.createThread(dir, { title: 'Side', text: 'src hello', origin: 'user' })).id;
  await ask(from, 'Which project?');
  await store.mergeThreads(dir, from, into, 'agent');
  const before = (await readThread(from)).messages.length;

  const quoted = await store.appendMessage(dir, from, { author: 'user', text: 'about the first note', reply_to: 'm1' });
  expect(quoted.forwarded_to).toBe(into);
  expect(quoted.text).toContain('Sent in Side after the merge');
  expect(quoted.text).toContain('about the first note');
  expect(quoted.reply_to).toBe((await readThread(into)).messages.find(m => m.text === 'src hello')!.id);
  expect((await readThread(from)).messages).toHaveLength(before);

  const answer = await store.appendMessage(dir, from, { author: 'user', text: '', answer: { question_id: 'q2', option_ids: ['o1'] } });
  expect(answer.forwarded_to).toBe(into);
  const target = await readThread(into);
  const question = target.messages.find(m => m.question?.prompt === 'Which project?')!;
  expect(answer.answer!.question_id).toBe(question.question!.id);
  expect(answer.answer!.question_id).not.toBe('q2');
  expect(store.openQuestions(target.messages)).toEqual([]);
  expect(target.summary.open_question).toBe(false);
  expect((await readThread(from)).messages).toHaveLength(before);

  await expect(store.appendMessage(dir, from, { author: 'agent', text: 'More?', question: { prompt: 'More?', options: [{ label: 'A' }] } })).rejects.toThrow(/ask on that thread/);
  await expect(run(['ask', from, 'More?', '--option', 'No'], dir)).rejects.toThrow(/ask on that thread/);
  const cli = await run(['reply', from, 'via the cli'], dir);
  expect(cli).toContain(`Replied to ${into}`);
  expect(cli).toContain(`forwarded from ${from}`);
  expect((await readThread(into)).messages.some(m => m.text.includes('via the cli') && m.text.includes('Sent in Side after the merge'))).toBe(true);
});

test('repair carries a stranded answer and un-withdraws only then; a later Settled withdrawal with no answer stays', async () => {
  const into = (await store.createThread(dir, { title: 'Main', text: 'tgt hello', origin: 'user' })).id;
  const from = (await store.createThread(dir, { title: 'Side', text: 'src hello', origin: 'user' })).id;
  await ask(from, 'Which project?');
  await ask(from, 'Ship it?');
  await store.mergeThreads(dir, from, into, 'agent');
  const note = JSON.parse(await readFile(join(dir, from, 'merged.json'), 'utf8'));
  const source = await readThread(from);
  const stranded = { id: `m${source.messages.length + 1}`, author: 'user', text: 'Chose: A', images: [], created_at: new Date(Date.parse(note.at) + 1000).toISOString(), answer: { question_id: 'q2', option_ids: ['o1'] } };
  await appendFile(threadFile(from), `${JSON.stringify(stranded)}\n`);
  const copied = await readThread(into);
  const which = copied.messages.find(m => m.question?.prompt === 'Which project?')!;
  const ship = copied.messages.find(m => m.question?.prompt === 'Ship it?')!;
  await store.cancelQuestion(dir, into, which.question!.id, 'Answered: looked open');
  await store.cancelQuestion(dir, into, ship.question!.id, 'Settled: shipped on purpose');
  const sourceBefore = await readFile(threadFile(from));

  const dry = await run(['repair-merged', '--dry-run'], dir);
  expect(dry).toContain(`carried ${stranded.id}`);
  expect(dry).toContain('q2 ->');
  expect(dry).toContain(`un-withdrew ${which.question!.id}`);
  expect(dry).toContain('Answered: looked open');
  expect(dry).not.toContain('Settled: shipped on purpose');
  expect(await readFile(threadFile(from))).toEqual(sourceBefore);

  await run(['repair-merged'], dir);
  const after = await readThread(into);
  const carried = after.messages.find(m => m.text.includes('Sent in Side after the merge'))!;
  expect(carried.answer!.question_id).toBe(which.question!.id);
  expect(carried.text).toContain('Chose: A');
  expect(after.messages.find(m => m.question?.prompt === 'Which project?')!.question!.withdrawn).toBeUndefined();
  expect(after.messages.find(m => m.question?.prompt === 'Ship it?')!.question!.withdrawn?.reason).toBe('Settled: shipped on purpose');
  expect(store.openQuestions(after.messages)).toEqual([]);
  expect(JSON.parse(await readFile(join(dir, from, 'merged.json'), 'utf8')).carried[stranded.id]).toBe(carried.id);
  expect(await readFile(threadFile(from))).toEqual(sourceBefore);

  const fixed = await readFile(threadFile(into));
  expect(await run(['repair-merged'], dir)).toContain('nothing to change');
  expect(await run(['repair-merged', '--dry-run'], dir)).toContain('nothing to change');
  expect(await readFile(threadFile(into))).toEqual(fixed);
  expect((await readThread(into)).messages.filter(m => m.answer)).toHaveLength(1);
});

test('a stranded answer to a question the target already answers is carried as a plain message', async () => {
  const into = (await store.createThread(dir, { title: 'Main', text: 'tgt hello', origin: 'user' })).id;
  const from = (await store.createThread(dir, { title: 'Side', text: 'src hello', origin: 'user' })).id;
  await ask(from, 'Which project?');
  await store.mergeThreads(dir, from, into, 'agent');
  const note = JSON.parse(await readFile(join(dir, from, 'merged.json'), 'utf8'));
  const target = await readThread(into);
  const qid = target.messages.find(m => m.question?.prompt === 'Which project?')!.question!.id;
  await store.appendMessage(dir, into, { author: 'user', text: '', answer: { question_id: qid, option_ids: ['o1'] } });
  const source = await readThread(from);
  const stranded = { id: `m${source.messages.length + 1}`, author: 'user', text: 'Chose: A', images: [], created_at: new Date(Date.parse(note.at) + 1000).toISOString(), answer: { question_id: 'q2', option_ids: ['o1'] } };
  await appendFile(threadFile(from), `${JSON.stringify(stranded)}\n`);

  expect(await run(['repair-merged', '--dry-run'], dir)).toContain('as a plain message');
  await run(['repair-merged'], dir);
  const after = await readThread(into);
  const carried = after.messages.find(m => m.text.includes('Sent in Side after the merge'))!;
  expect(carried.answer).toBeUndefined();
  expect(carried.text).toContain('Chose: A');
  expect(after.messages.filter(m => m.answer?.question_id === qid)).toHaveLength(1);
  const fixed = await readFile(threadFile(into));
  expect(await run(['repair-merged'], dir)).toContain('nothing to change');
  expect(await readFile(threadFile(into))).toEqual(fixed);
});

test('forwarding an answer to a question the target already answers is refused with a 409', async () => {
  const into = (await store.createThread(dir, { title: 'Main', text: 'tgt hello', origin: 'user' })).id;
  const from = (await store.createThread(dir, { title: 'Side', text: 'src hello', origin: 'user' })).id;
  await ask(from, 'Which project?');
  await store.mergeThreads(dir, from, into, 'agent');
  const qid = (await readThread(into)).messages.find(m => m.question?.prompt === 'Which project?')!.question!.id;
  await store.appendMessage(dir, into, { author: 'user', text: '', answer: { question_id: qid, option_ids: ['o1'] } });
  const err = (await store.appendMessage(dir, from, { author: 'user', text: '', answer: { question_id: 'q2', option_ids: ['o1'] } }).catch((e: unknown) => e)) as { message: string; status: number };
  expect(err.message).toMatch(/already answered/);
  expect(err.status).toBe(409);
  expect((await readThread(into)).messages.filter(m => m.answer)).toHaveLength(1);
});
