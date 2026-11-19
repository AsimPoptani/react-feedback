// Thread reminders: nudges that land in the agent's event feed (`_events.jsonl`) so it keeps a thread up to date.
// <thread>/reminders.json holds `{ default_off?, default?: { last_fired_at }, items: Reminder[], fired: Fired[] }`, written atomically like checklist.json.
// A reminder is evaluated by `fireDue` (the server's 60 s tick, and a check after each agent reply); a fire is stored under the thread's lock, so a restart or a second process cannot fire it twice.
import { join } from 'node:path';
import * as store from './store';
import type { Author } from './store';

export const KINDS = ['every', 'after_agent_replies', 'idle'] as const;
export type Kind = (typeof KINDS)[number];
export const MAX_REMINDERS = 10;
export const MAX_SAY = 500;
const MAX_FIRED = 30;
export const DEFAULT_ID = 'default';
export const DEFAULT_EVERY_MS = 6 * 3600e3;
export const DEFAULT_AFTER = 3;
// No reminder fires twice within this long, so a reply that answers one cannot set the next one off.
export const COOLDOWN_MS = 15 * 60e3;
export const MIN_AFTER_REPLIES = 2;

// `agent_name` is the MCP agent that set the reminder, when it was one. A fire records who set it (`set_by`: agent, user or default).
export interface Reminder { id: string; kind: Kind; value: string | number; say: string; created_by: Author; agent_name?: string; created_at: string; last_fired_at: string | null; enabled: boolean }
export type SetBy = 'agent' | 'user' | 'default';
export interface Fired { id: string; at: string; text: string; set_by: SetBy; agent_name?: string }
export interface Stored { default_off: boolean; default_fired_at: string | null; items: Reminder[]; fired: Fired[] }

const UNITS: Record<string, number> = { m: 60e3, h: 3600e3, d: 86400e3 };
// "30m", "2h", "1d": one to 30 days, at least a minute.
export function parseDuration(value: unknown): number {
  const m = typeof value === 'string' ? /^(\d{1,4})([mhd])$/.exec(value.trim()) : null;
  const ms = m ? Number(m[1]) * UNITS[m[2]!]! : NaN;
  if (!Number.isFinite(ms) || ms < 60e3 || ms > 30 * 86400e3) throw new store.Invalid('A time is a number and a unit, like 30m, 2h or 1d (1 minute to 30 days)');
  return ms;
}
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isAuthor = (v: unknown): v is Author => v === 'user' || v === 'agent';

export function parseStored(raw: string | null): Stored {
  let data: unknown;
  try { data = raw === null ? null : JSON.parse(raw); } catch { data = null; }
  const d = isObject(data) ? data : {};
  const items: Reminder[] = [];
  for (const r of Array.isArray(d.items) ? d.items : []) {
    if (!isObject(r) || typeof r.id !== 'string' || !(KINDS as readonly string[]).includes(r.kind as string) || typeof r.say !== 'string' || typeof r.created_at !== 'string') continue;
    const value = r.kind === 'after_agent_replies' ? Number(r.value) : String(r.value);
    if (r.kind === 'after_agent_replies' ? !Number.isInteger(value) : (() => { try { parseDuration(value); return false; } catch { return true; } })()) continue;
    items.push({ id: r.id, kind: r.kind as Kind, value, say: r.say, created_by: isAuthor(r.created_by) ? r.created_by : 'agent', ...(typeof r.agent_name === 'string' && r.agent_name ? { agent_name: r.agent_name } : {}), created_at: r.created_at,
      last_fired_at: typeof r.last_fired_at === 'string' ? r.last_fired_at : null, enabled: r.enabled !== false });
  }
  const fired = (Array.isArray(d.fired) ? d.fired : []).flatMap((f): Fired[] => (isObject(f) && typeof f.id === 'string' && typeof f.at === 'string' && typeof f.text === 'string'
    ? [{ id: f.id, at: f.at, text: f.text, set_by: f.set_by === 'user' || f.set_by === 'agent' ? f.set_by : 'default', ...(typeof f.agent_name === 'string' && f.agent_name ? { agent_name: f.agent_name } : {}) }] : []));
  const def = isObject(d.default) && typeof d.default.last_fired_at === 'string' ? d.default.last_fired_at : null;
  return { default_off: d.default_off === true, default_fired_at: def, items, fired };
}
export const serialise = (s: Stored) => JSON.stringify({ ...(s.default_off ? { default_off: true } : {}), default: { last_fired_at: s.default_fired_at }, items: s.items, fired: s.fired.slice(-MAX_FIRED) }, null, 2);
export async function readStored(path: string): Promise<Stored> { return parseStored(await store.optional(join(path, 'reminders.json'))); }
const change = <T>(dir: string, id: string, fn: (s: Stored) => T): Promise<T> => store.itemDir(dir, id).then(path => store.withLock(path, async () => {
  const s = await readStored(path), result = fn(s);
  await store.writeAtomic(join(path, 'reminders.json'), serialise(s));
  return result;
}));

// The global switch: FEEDBACK_DEFAULT_REMINDER=off (or 0, false, no) turns the built-in reminder off everywhere.
export const defaultAllowed = (env: Record<string, string | undefined> = process.env) => !/^(0|off|false|no)$/i.test(env.FEEDBACK_DEFAULT_REMINDER?.trim() ?? '');

export interface View { default: { on: boolean; global_off: boolean; every: string; after_replies: number; last_fired_at: string | null }; items: Reminder[]; fired: Fired[] }
export async function listReminders(dir: string, id: string, env: Record<string, string | undefined> = process.env): Promise<View> {
  const s = await readStored(await store.itemDir(dir, id));
  return { default: { on: defaultAllowed(env) && !s.default_off, global_off: !defaultAllowed(env), every: '6h', after_replies: DEFAULT_AFTER, last_fired_at: s.default_fired_at }, items: s.items, fired: s.fired };
}
export interface NewReminder { kind: unknown; value: unknown; say: unknown; by: Author; agent_name?: string }
export async function addReminder(dir: string, id: string, input: NewReminder): Promise<Reminder> {
  if (typeof input.kind !== 'string' || !(KINDS as readonly string[]).includes(input.kind)) throw new store.Invalid('kind must be every, after_agent_replies or idle');
  const kind = input.kind as Kind;
  let value: string | number;
  if (kind === 'after_agent_replies') {
    value = typeof input.value === 'string' && /^\d+$/.test(input.value) ? Number(input.value) : (input.value as number);
    if (!Number.isInteger(value) || value < MIN_AFTER_REPLIES || value > 50) throw new store.Invalid(`after_agent_replies takes a whole number from ${MIN_AFTER_REPLIES} to 50`);
  } else { parseDuration(input.value); value = String(input.value).trim(); }
  if (typeof input.say !== 'string' || !input.say.trim() || input.say.length > MAX_SAY) throw new store.Invalid(`A reminder needs text of 1–${MAX_SAY} characters`);
  const say = input.say.trim();
  return change(dir, id, s => {
    if (s.items.length >= MAX_REMINDERS) throw new store.Invalid(`A thread holds at most ${MAX_REMINDERS} reminders`);
    const n = s.items.reduce((m, r) => Math.max(m, Number(/^r(\d+)$/.exec(r.id)?.[1] ?? 0)), 0);
    const created: Reminder = { id: `r${n + 1}`, kind, value, say, created_by: input.by, ...(input.by === 'agent' && input.agent_name ? { agent_name: input.agent_name } : {}), created_at: new Date().toISOString(), last_fired_at: null, enabled: true };
    s.items.push(created);
    return created;
  });
}
export async function removeReminder(dir: string, id: string, rid: string): Promise<void> {
  await change(dir, id, s => {
    const at = s.items.findIndex(r => r.id === rid);
    if (at < 0) throw new store.Invalid('No such reminder', 404);
    s.items.splice(at, 1);
  });
}
export async function setDefaultReminder(dir: string, id: string, on: boolean): Promise<void> { await change(dir, id, s => { s.default_off = !on; }); }
export async function setReminderEnabled(dir: string, id: string, rid: string, enabled: boolean): Promise<void> {
  await change(dir, id, s => { const r = s.items.find(x => x.id === rid); if (!r) throw new store.Invalid('No such reminder', 404); r.enabled = enabled; });
}

// ---- Firing. `evaluate` is pure: what is due on a thread at `now`. `armedAt` is when this process started: nothing fires on a thread that has had no activity since.
export interface ThreadState { status: 'open' | 'done'; messages: store.Message[]; items: store.ChecklistItem[]; waiting: string; lastMessageAt: string }
const t = (iso: string) => Date.parse(iso);
const mainAgent = (m: store.Message) => m.author === 'agent' && !m.divider && !m.aside && !m.moved_to;
// The newest add, tick or unclaim on the checklist.
function lastChecklistChange(items: store.ChecklistItem[]): string {
  return items.reduce((hi, i) => [i.created_at, i.done_at, i.unclaimed_at].reduce<string>((h, x) => (x && x > h ? x : h), hi), '');
}
const repliesSince = (state: ThreadState, cutoff: string) => state.messages.filter(m => mainAgent(m) && !m.added_items?.length && !m.ticked_items?.length && m.created_at > cutoff).length;
const lastAgentAt = (state: ThreadState) => state.messages.filter(mainAgent).reduce((hi, m) => (m.created_at > hi ? m.created_at : hi), '');
export interface Due { id: string; text: string; set_by: SetBy; agent_name?: string }
const cooling = (last: string | null, now: number) => last !== null && now - t(last) < COOLDOWN_MS;
// The newest message from the user: an agent's own replies are not activity (they would keep a reminder going on its own answers).
const lastUserAt = (state: ThreadState) => state.messages.filter(m => m.author === 'user' && !m.divider && !m.aside && !m.moved_to).reduce((hi, m) => (m.created_at > hi ? m.created_at : hi), '');
function dueReminder(r: Reminder, state: ThreadState, now: number, armedAt: number): boolean {
  if (!r.enabled || state.status === 'done' || cooling(r.last_fired_at, now)) return false;
  const base = r.last_fired_at ?? r.created_at;
  if (r.kind === 'every') return now - t(base) >= parseDuration(r.value) && t(lastUserAt(state) || '1970') > Math.max(t(base), armedAt);
  if (r.kind === 'after_agent_replies') return t(lastAgentAt(state) || '1970') > armedAt && repliesSince(state, [r.last_fired_at ?? '', lastChecklistChange(state.items), r.created_at].reduce((h, x) => (x > h ? x : h), '')) >= Number(r.value);
  return state.waiting === 'agent' && now - t(state.lastMessageAt) >= parseDuration(r.value) && (r.last_fired_at === null || r.last_fired_at < state.lastMessageAt);
}
// The built-in reminder: only while the agent has open items of its own. After 3 agent replies with no add or tick, or 6 h after the last fire (or the oldest open item) when the thread has had activity.
function dueDefault(s: Stored, state: ThreadState, now: number, armedAt: number): Due | null {
  const open = state.items.filter(i => i.owner === 'agent' && !i.done);
  if (!open.length || state.status === 'done' || cooling(s.default_fired_at, now)) return null;
  const base = s.default_fired_at ?? open.reduce((lo, i) => (i.created_at < lo ? i.created_at : lo), open[0]!.created_at);
  const byReplies = t(lastAgentAt(state) || '1970') > armedAt && repliesSince(state, [s.default_fired_at ?? '', lastChecklistChange(state.items)].reduce((h, x) => (x > h ? x : h), '')) >= DEFAULT_AFTER;
  const byTime = now - t(base) >= DEFAULT_EVERY_MS && t(lastUserAt(state) || '1970') > Math.max(t(base), armedAt);
  if (!byReplies && !byTime) return null;
  // No title in the text: a title can be a capture's note, and redacting it must not leave it here.
  return { id: DEFAULT_ID, set_by: 'default', text: `This thread has ${open.length} open agent item${open.length === 1 ? '' : 's'}: is the checklist up to date? Tick what shipped, add what's new.` };
}
export function evaluate(s: Stored, state: ThreadState, now: number, armedAt: number, env: Record<string, string | undefined> = process.env): Due[] {
  const due: Due[] = s.items.filter(r => dueReminder(r, state, now, armedAt)).map(r => ({ id: r.id, text: r.say, set_by: r.created_by, ...(r.agent_name ? { agent_name: r.agent_name } : {}) }));
  if (defaultAllowed(env) && !s.default_off) { const d = dueDefault(s, state, now, armedAt); if (d) due.push(d); }
  return due;
}
export const PROCESS_START = Date.now();
async function stateOf(dir: string, id: string): Promise<ThreadState> {
  const { summary, messages, path } = await store.summarise(dir, id);
  return { status: summary.status, messages, items: await store.readChecklist(path), waiting: summary.waiting, lastMessageAt: summary.last_message_at };
}
export interface FireOptions { now?: number; armedAt?: number; env?: Record<string, string | undefined> }
// Checks one thread and fires what is due: stored under the lock first (last_fired_at, the line shown in the thread), then one event each in `_events.jsonl` (author "system").
export async function fireThread(dir: string, id: string, options: FireOptions = {}): Promise<Due[]> {
  const now = options.now ?? Date.now(), armedAt = options.armedAt ?? PROCESS_START, env = options.env ?? process.env;
  const path = await store.itemDir(dir, id);
  if (!await store.optional(join(path, 'reminders.json')) && !defaultAllowed(env)) return [];
  const fired = await store.withLock(path, async () => {
    const s = await readStored(path);
    const due = evaluate(s, await stateOf(dir, id), now, armedAt, env);
    if (!due.length) return [];
    const at = new Date(now).toISOString();
    for (const d of due) {
      if (d.id === DEFAULT_ID) s.default_fired_at = at; else { const r = s.items.find(x => x.id === d.id); if (r) r.last_fired_at = at; }
      s.fired.push({ id: d.id, at, text: d.text, set_by: d.set_by, ...(d.agent_name ? { agent_name: d.agent_name } : {}) });
    }
    await store.writeAtomic(join(path, 'reminders.json'), serialise(s));
    return due;
  });
  for (const d of fired) await store.logEvent(dir, { id, kind: 'reminder', text: d.text, author: 'system', set_by: d.set_by, agent_name: d.agent_name });
  return fired;
}
// Every thread, once. A broken thread must not stop the rest.
export async function fireAll(dir: string, options: FireOptions = {}): Promise<{ id: string; due: Due[] }[]> {
  const out: { id: string; due: Due[] }[] = [];
  for (const row of await store.listThreads(dir)) {
    if (row.merged_into || row.status === 'done') continue;
    try { const due = await fireThread(dir, row.id, options); if (due.length) out.push({ id: row.id, due }); } catch { /* skip it */ }
  }
  return out;
}
// The server's scheduler: a pass every 60 s (and one at start). The timer does not keep the process alive.
export function startScheduler(dir: string, everyMs = 60e3, options: FireOptions = {}): () => void {
  let running = false;
  const pass = async () => { if (running) return; running = true; try { await fireAll(dir, options); } catch (error) { console.error('Reminder pass failed', error); } finally { running = false; } };
  const timer = setInterval(pass, everyMs);
  timer.unref?.();
  void pass();
  return () => clearInterval(timer);
}
// A reminder never throws into a reply: the check after an agent reply is best effort.
export async function checkAfterReply(dir: string, id: string): Promise<void> { try { await fireThread(dir, id); } catch { /* the reply already succeeded */ } }
// How many open agent items a thread has, for the CLI's hint after a reply.
export async function openAgentItems(dir: string, id: string): Promise<store.ChecklistItem[]> { return (await store.listChecklist(dir, id)).filter(i => i.owner === 'agent' && !i.done); }
