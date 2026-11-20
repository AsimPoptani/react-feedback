// The small pure parts of the 0.15 inbox: kept drafts, the typing pinger and the new-topic nudge.
import { expect, test } from 'bun:test';
import { DRAFT_KEY, composerKey, createDrafts, questionKey, typingPinger } from './inbox/drafts.js';
import { suggestTitle, topicNudge } from './inbox/nudge.js';

const memory = () => { const data = new Map<string, string>(); return { getItem: (k: string) => data.get(k) ?? null, removeItem: (k: string) => { data.delete(k); }, setItem: (k: string, v: string) => { data.set(k, v); }, data }; };

test('drafts are kept per project, thread and question, cleared when empty, and capped', () => {
  const store = memory();
  const drafts = createDrafts(() => store as unknown as Storage);
  drafts.set(composerKey('a', 't1'), 'hello');
  drafts.set(questionKey('a', 't1', 'q2'), 'my answer');
  drafts.set(composerKey('b', 't1'), 'other project');
  expect(drafts.get(composerKey('a', 't1'))).toBe('hello');
  expect(drafts.questions('a', 't1')).toEqual([{ qid: 'q2', text: 'my answer' }]);
  drafts.set(composerKey('a', 't1'), '   '); // blank clears it
  expect(drafts.get(composerKey('a', 't1'))).toBe('');
  drafts.move({ project: 'a', thread: 't1' }, { project: 'b', thread: 't9' });
  expect(drafts.questions('b', 't9')).toEqual([{ qid: 'q2', text: 'my answer' }]);
  expect(drafts.get(composerKey('b', 't1'))).toBe('other project');
  for (let i = 0; i < 260; i++) drafts.set(`p|t${i}|c`, `text ${i}`);
  expect(Object.keys(JSON.parse(store.data.get(DRAFT_KEY)!)).length).toBeLessThanOrEqual(200);
});
test('a browser that blocks or garbles storage never throws', () => {
  const blocked = createDrafts(() => { throw new Error('blocked'); });
  expect(() => { blocked.set('k', 'v'); blocked.clear('k'); blocked.questions('a', 'b'); blocked.move({ thread: 'a' }, { thread: 'b' }); }).not.toThrow();
  expect(blocked.get('k')).toBe('');
  const garbled = createDrafts(() => ({ getItem: () => '[1,2', setItem: () => { throw new Error('full'); } }) as unknown as Storage);
  expect(() => garbled.set('k', 'v')).not.toThrow();
  expect(garbled.get('k')).toBe('');
});
test('the typing pinger waits a moment, then pings at most once per gap, and stop says done only if it said typing', () => {
  let clock = 0; const timers: (() => void)[] = []; const sent: boolean[] = [];
  const pinger = typingPinger({ send: on => sent.push(on), gap: 5000, now: () => clock, setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer: () => { timers.length = 0; } });
  pinger.stop(); expect(sent).toEqual([]);
  pinger.note(); pinger.note(); expect(timers.length).toBe(1);
  timers.shift()!(); expect(sent).toEqual([true]);
  clock = 2000; pinger.note(); expect(timers.length).toBe(0); // inside the gap
  clock = 5001; pinger.note(); timers.shift()!(); expect(sent).toEqual([true, true]);
  pinger.stop(); expect(sent).toEqual([true, true, false]);
});
test('the nudge fires on an opener, or on a long message that shares almost nothing with the title', () => {
  expect(topicNudge('Also, can the logo be bigger? It is small.', 'Billing page')).toEqual({ reason: 'opener', title: 'Can the logo be bigger?' });
  expect(topicNudge('Another thing: the footer.', 'x')?.reason).toBe('opener');
  expect(topicNudge('Separately we should plan the offsite', 'x')?.reason).toBe('opener');
  expect(topicNudge('Yes, that works for me.', 'Billing page')).toBeNull();
  expect(topicNudge('/btw also what is this', 'Billing')).toBeNull();
  const long = `${'The marketing team wants the photography schedule moved to spring because the venue is closed during winter. '.repeat(3)}`;
  expect(topicNudge(long, 'Billing invoices export')?.reason).toBe('unrelated');
  expect(topicNudge(long, 'Photography schedule venue')).toBeNull();
  expect(suggestTitle('Also,   a very long first sentence that keeps going and going well past the seventy character limit for titles. More.').length).toBeLessThanOrEqual(71);
});

test('"stopped" goes to the thread the typing was in, even after the page moved on, and a new thread stops the old one first', () => {
  let clock = 0; const timers: (() => void)[] = []; const sent: [boolean, string | undefined][] = [];
  const pinger = typingPinger({ send: (on: boolean, id?: string) => sent.push([on, id]), gap: 5000, now: () => clock, setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer: () => { timers.length = 0; } });
  pinger.note('A'); timers.shift()!();
  pinger.stop();
  expect(sent).toEqual([[true, 'A'], [false, 'A']]);
  sent.length = 0; clock = 10_000;
  pinger.note('A'); timers.shift()!();
  pinger.note('B'); // moved to another thread while typing: A is told first
  expect(sent).toEqual([[true, 'A'], [false, 'A']]);
  timers.shift()!(); pinger.stop();
  expect(sent.slice(2)).toEqual([[true, 'B'], [false, 'B']]);
});
test('a draft lapses after 14 days, and wipe forgets them all', () => {
  const store = memory(); let clock = 1_000_000;
  const drafts = createDrafts(() => store as unknown as Storage, () => clock);
  drafts.set('p|t|c', 'kept'); drafts.set('p|t|q:q1', 'answer');
  clock += 13 * 864e5; expect(drafts.get('p|t|c')).toBe('kept');
  clock += 2 * 864e5; expect(drafts.get('p|t|c')).toBe(''); expect(drafts.questions('p', 't')).toEqual([]);
  drafts.set('p|t|c', 'new'); drafts.wipe();
  expect(drafts.get('p|t|c')).toBe(''); expect(store.data.has(DRAFT_KEY)).toBe(false);
  expect(() => createDrafts(() => { throw new Error('blocked'); }).wipe()).not.toThrow();
});
