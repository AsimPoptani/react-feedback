import { expect, test } from 'bun:test';
import * as reminders from './reminders';
import type * as store from './store';

// Timestamps are whole milliseconds, so a reply can land in the same ms as the checklist add before it (a fast CLI); it must still count, or the default reminder fires one reply late, depending on timing.
const T0 = Date.parse('2026-11-19T10:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
const reply = (n: number, ms: number): store.Message => ({ id: `m${n}`, author: 'agent', text: 'x', images: [], created_at: at(ms), flag: 'fyi' });
const item = (id: string, ms: number): store.ChecklistItem => ({ id, owner: 'agent', text: id, done: false, created_by: 'agent', created_at: at(ms) });
const user: store.Message = { id: 'm0', author: 'user', text: 'x', images: [], created_at: at(0) };
const stored = (extra: Partial<reminders.Stored> = {}): reminders.Stored => ({ default_off: false, default_fired_at: null, items: [], fired: [], ...extra });
const state = (messages: store.Message[], items: store.ChecklistItem[]): reminders.ThreadState => ({ title: 'Plan', status: 'open', messages, items, waiting: 'idle', lastMessageAt: messages.at(-1)!.created_at });
const ids = (s: reminders.Stored, st: reminders.ThreadState) => reminders.evaluate(s, st, T0 + 3600e3, 0, {}).map(d => d.id);

test('the default reminder counts a reply sent in the same ms as the last checklist add', () => {
  const items = [item('c1', 5), item('c2', 10)];
  expect(ids(stored(), state([user, reply(1, 10), reply(2, 20), reply(3, 30)], items))).toEqual(['default']);
  expect(ids(stored(), state([user, reply(1, 10), reply(2, 20)], items))).toEqual([]);
});
test('a reply in the same ms as the fire is not counted again', () => {
  const items = [item('c1', 5)];
  const s = stored({ default_fired_at: at(30) });
  expect(ids(s, state([user, reply(1, 10), reply(2, 20), reply(3, 30), reply(4, 30), reply(5, 40)], items))).toEqual([]);
  expect(ids(s, state([user, reply(1, 10), reply(2, 20), reply(3, 30), reply(4, 30), reply(5, 40), reply(6, 50), reply(7, 60)], items))).toEqual(['default']);
});
test('a custom after_agent_replies reminder counts a reply in the same ms as a checklist change', () => {
  const r: reminders.Reminder = { id: 'r1', kind: 'after_agent_replies', value: 2, say: 'ping', created_by: 'user', created_at: at(1), last_fired_at: null, enabled: true } as reminders.Reminder;
  expect(ids(stored({ default_off: true, items: [r] }), state([user, reply(1, 10), reply(2, 20)], [item('c1', 10)]))).toEqual(['r1']);
});
