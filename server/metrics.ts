// Inbox metrics: velocity, response times, workload and a breakdown by area. Computed on request from the thread folders
// and `_events.jsonl`, read once per call, with no cache. Days and hours are UTC.
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import * as store from './store';
import { areaLabel, areaOf, DEFAULT_AREAS, sortAreas, type AreasConfig } from './inbox/areas.js';

export const WINDOWS = { '24h': 24 * 3600e3, '7d': 7 * 86400e3, all: null } as const;
export type Window = keyof typeof WINDOWS;
export const checkWindow = (value: unknown): Window => {
  if (typeof value !== 'string' || !Object.hasOwn(WINDOWS, value)) throw new store.Invalid('window must be 24h, 7d or all');
  return value as Window;
};
const MAX_DAYS = 90; // the all-time daily chart shows at most this many days

export interface Stats { count: number; median: number | null; mean: number | null; p90: number | null; p99: number | null }
// Percentiles use linear interpolation between the two nearest values (the usual "type 7"), so the median of an even count is the mean of the middle two.
export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}
export function stats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, median: percentile(sorted, 50), mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    p90: percentile(sorted, 90), p99: percentile(sorted, 99) };
}

interface Sample { ms: number; area: string }
export interface DayRow { day: string; user: number; agent: number; opened: number; closed: number }
export interface HourRow { hour: string; user: number; agent: number }
export interface AreaRow {
  area: string; label: string; threads: number; open: number; waiting_agent: number; waiting_you: number;
  messages_user: number; messages_agent: number; agent_response: Stats; user_response: Stats;
}
export interface Metrics {
  window: Window; generated_at: string; since: string | null;
  velocity: { per_day: DayRow[]; per_hour: HourRow[]; messages: { user: number; agent: number }; opened: number; closed: number };
  response: { agent: Stats; user: Stats };
  workload: {
    threads: number; open: number; waiting_agent: number; waiting_you: number; read_only: number;
    oldest_waiting: { id: string; title: string; waiting: 'agent' | 'you'; since: string; age_ms: number } | null;
    checklist: { open: number; claimed: number; ticked: number };
  };
  areas: AreaRow[];
  events: { count: number; by_kind: Record<string, number>; last_at: string | null };
}

const day = (iso: string) => iso.slice(0, 10);
const hour = (iso: string) => iso.slice(0, 13);
const ms = (iso: string) => Date.parse(iso);
function addDays(isoDay: string, n: number): string { return new Date(Date.parse(`${isoDay}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10); }
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

// When a waiting thread started waiting: the first message of the user's last streak, or the first message that asked for the user.
function waitingSince(messages: store.Message[], waiting: 'agent' | 'you', fallback: string): string {
  const real = messages.filter(m => !m.divider);
  if (waiting === 'agent') {
    if (real[real.length - 1]?.author !== 'user') return fallback; // waiting on a claim or a merge, not on a message
    let i = real.length - 1;
    while (i > 0 && real[i - 1]!.author === 'user') i--;
    return real[i]!.created_at;
  }
  const lastUser = real.map(m => m.author).lastIndexOf('user');
  const answered = new Set(real.flatMap(m => (m.answer ? [m.answer.question_id] : [])));
  return real.slice(lastUser + 1).find(m => m.author === 'agent' && (m.flag === 'needs_you' || (!!m.question && !answered.has(m.question.id))))?.created_at ?? fallback;
}

async function readEvents(dir: string): Promise<{ ts: string; kind: string }[]> {
  const raw = await store.optional(join(dir, '_events.jsonl')).catch(() => null);
  const out: { ts: string; kind: string }[] = [];
  for (const line of (raw ?? '').split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && typeof e.ts === 'string' && typeof e.kind === 'string') out.push({ ts: e.ts, kind: e.kind }); } catch { /* a torn line */ }
  }
  return out;
}

export async function computeMetrics(dir: string, window: Window = '7d', now = new Date(), areas: AreasConfig = DEFAULT_AREAS): Promise<Metrics> {
  const span = WINDOWS[window];
  const sinceMs = span === null ? null : now.getTime() - span;
  const since = sinceMs === null ? null : new Date(sinceMs).toISOString();
  const nowIso = now.toISOString();
  const inWindow = (iso: string) => (sinceMs === null || ms(iso) >= sinceMs) && ms(iso) <= now.getTime();

  let entries: string[] = [];
  try { entries = (await readdir(dir)).filter(e => store.ID.test(e)); } catch { /* no folder yet */ }
  const hours = new Map<string, HourRow>();
  const lastHours: string[] = [];
  for (let i = 23; i >= 0; i--) { const h = hour(new Date(now.getTime() - i * 3600e3).toISOString()); lastHours.push(h); hours.set(h, { hour: `${h}:00:00Z`, user: 0, agent: 0 }); }
  const days = new Map<string, DayRow>();
  const dayRow = (d: string) => days.get(d) ?? days.set(d, { day: d, user: 0, agent: 0, opened: 0, closed: 0 }).get(d)!;

  const areaRows = new Map<string, AreaRow & { _agent: number[]; _user: number[] }>();
  const areaRow = (area: string) => areaRows.get(area) ?? areaRows.set(area, { area, label: areaLabel(area, areas), threads: 0, open: 0, waiting_agent: 0, waiting_you: 0, messages_user: 0, messages_agent: 0,
    agent_response: stats([]), user_response: stats([]), _agent: [], _user: [] }).get(area)!;
  const agentSamples: Sample[] = [], userSamples: Sample[] = [];
  const workload: Metrics['workload'] = { threads: 0, open: 0, waiting_agent: 0, waiting_you: 0, read_only: 0, oldest_waiting: null, checklist: { open: 0, claimed: 0, ticked: 0 } };
  let oldest: { since: number; value: NonNullable<Metrics['workload']['oldest_waiting']> } | null = null;
  const totals = { user: 0, agent: 0, opened: 0, closed: 0 };
  let firstSeen = nowIso;

  for (const id of entries) {
    let s: Awaited<ReturnType<typeof store.summarise>>;
    try { s = await store.summarise(dir, id); } catch { continue; } // a broken folder must not hide the rest
    const { summary, messages, path } = s;
    if (summary.merged_into) continue; // its messages live on in the thread it was merged into
    const area = areaRow(areaOf({ mode: summary.mode, url: summary.url }, areas).area);
    const real = messages.filter(m => !m.divider);
    if (summary.created_at < firstSeen) firstSeen = summary.created_at;

    // Workload now: it does not depend on the window.
    workload.threads++; area.threads++;
    if (summary.status !== 'done') { workload.open++; area.open++; }
    if (summary.read_only) workload.read_only++;
    if (summary.waiting === 'agent' || summary.waiting === 'you') {
      workload[summary.waiting === 'agent' ? 'waiting_agent' : 'waiting_you']++;
      area[summary.waiting === 'agent' ? 'waiting_agent' : 'waiting_you']++;
      const since_ = waitingSince(messages, summary.waiting, summary.last_message_at);
      if (!oldest || ms(since_) < oldest.since) oldest = { since: ms(since_), value: { id, title: summary.title, waiting: summary.waiting, since: since_, age_ms: Math.max(0, now.getTime() - ms(since_)) } };
    }
    for (const i of await store.readChecklist(path)) { if (i.done) workload.checklist.ticked++; else if (i.claimed_by_user_at) workload.checklist.claimed++; else workload.checklist.open++; }

    // Velocity: messages by author, threads opened, threads closed (a done thread closed when its status file last changed).
    for (const m of real) {
      if (m.created_at < firstSeen) firstSeen = m.created_at;
      if (inWindow(m.created_at)) {
        totals[m.author]++; area[m.author === 'user' ? 'messages_user' : 'messages_agent']++;
        dayRow(day(m.created_at))[m.author]++;
      }
      const h = hours.get(hour(m.created_at));
      if (h && ms(m.created_at) <= now.getTime()) h[m.author]++;
    }
    if (inWindow(summary.created_at)) { totals.opened++; dayRow(day(summary.created_at)).opened++; }
    if (summary.status === 'done') {
      const at = await stat(join(path, 'status.json')).then(st => st.mtime.toISOString(), () => summary.last_message_at);
      if (inWindow(at)) { totals.closed++; dayRow(day(at)).closed++; }
    }

    // Response times. A run of messages by one side counts from its first message to the other side's next message,
    // dated by when the answer arrived. Messages are taken in time order so a merged thread's copied history interleaves correctly.
    // Read-only threads have no user replies to time.
    const ordered = [...real].sort((a, b) => a.created_at.localeCompare(b.created_at));
    let runStart: store.Message | null = null, prev: store.Message | null = null;
    for (const m of ordered) {
      if (!prev) runStart = m;
      else if (prev.author !== m.author) {
        const delta = ms(m.created_at) - ms(runStart!.created_at);
        if (delta >= 0 && inWindow(m.created_at) && (m.author === 'agent' || !summary.read_only)) {
          (m.author === 'agent' ? agentSamples : userSamples).push({ ms: delta, area: areaOf({ mode: summary.mode, url: summary.url }, areas).area });
        }
        runStart = m;
      }
      prev = m;
    }
  }

  for (const sample of agentSamples) areaRow(sample.area)._agent.push(sample.ms);
  for (const sample of userSamples) areaRow(sample.area)._user.push(sample.ms);

  // Daily rows: every day the window touches, oldest first; all time is capped to the last MAX_DAYS.
  const today = day(nowIso);
  const first = since === null ? [day(firstSeen), addDays(today, 1 - MAX_DAYS)].reduce((a, b) => (a > b ? a : b)) : day(since);
  const per_day = daysBetween(first, today).map(d => days.get(d) ?? { day: d, user: 0, agent: 0, opened: 0, closed: 0 });

  const events = (await readEvents(dir)).filter(e => inWindow(e.ts));
  const by_kind: Record<string, number> = {};
  for (const e of events) by_kind[e.kind] = (by_kind[e.kind] ?? 0) + 1;
  workload.oldest_waiting = oldest ? oldest.value : null;

  return {
    window, generated_at: nowIso, since,
    velocity: { per_day, per_hour: lastHours.map(h => hours.get(h)!), messages: { user: totals.user, agent: totals.agent }, opened: totals.opened, closed: totals.closed },
    response: { agent: stats(agentSamples.map(x => x.ms)), user: stats(userSamples.map(x => x.ms)) },
    workload,
    areas: sortAreas([...areaRows.keys()], areas).map(k => areaRows.get(k)!).filter(a => a.threads > 0 || a._agent.length || a._user.length).map(({ _agent, _user, ...a }) => ({ ...a, agent_response: stats(_agent), user_response: stats(_user) })),
    events: { count: events.length, by_kind, last_at: events.reduce<string | null>((hi, e) => (hi === null || e.ts > hi ? e.ts : hi), null) },
  };
}

// ---- Text for the CLI.
export function duration(value: number | null): string {
  if (value === null) return '-';
  const s = Math.round(value / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}
const statLine = (label: string, s: Stats) => `  ${label.padEnd(8)} n=${String(s.count).padEnd(4)} median ${duration(s.median).padEnd(8)} mean ${duration(s.mean).padEnd(8)} p90 ${duration(s.p90).padEnd(8)} p99 ${duration(s.p99)}`;
export function formatMetrics(m: Metrics): string {
  const w = m.workload;
  const lines = [
    `Window: ${m.window === 'all' ? 'all time' : m.window === '24h' ? 'last 24 hours' : 'last 7 days'} (days are UTC)`,
    '', 'Velocity',
    `  messages  you ${m.velocity.messages.user}, agent ${m.velocity.messages.agent}`,
    `  threads   opened ${m.velocity.opened}, closed ${m.velocity.closed}`,
    `  last 24h  you ${m.velocity.per_hour.reduce((a, h) => a + h.user, 0)}, agent ${m.velocity.per_hour.reduce((a, h) => a + h.agent, 0)} messages`,
    '', 'Response times (from a message to the other side\'s next one)',
    statLine('agent', m.response.agent), statLine('you', m.response.user),
    '', 'Workload now',
    `  open threads ${w.open} of ${w.threads}, waiting for agent ${w.waiting_agent}, waiting on you ${w.waiting_you}, read-only ${w.read_only}`,
    w.oldest_waiting ? `  oldest waiting: ${w.oldest_waiting.title} (${w.oldest_waiting.id}), waiting for ${w.oldest_waiting.waiting === 'agent' ? 'the agent' : 'you'} for ${duration(w.oldest_waiting.age_ms)}` : '  oldest waiting: none',
    `  checklist items open ${w.checklist.open}, claimed ${w.checklist.claimed}, ticked ${w.checklist.ticked}`,
    '', 'By area',
    ...m.areas.map(a => `  ${a.label.padEnd(24)} threads ${String(a.threads).padEnd(3)} open ${String(a.open).padEnd(3)} waiting agent ${String(a.waiting_agent).padEnd(2)} you ${String(a.waiting_you).padEnd(2)} msgs ${a.messages_user}/${a.messages_agent}  agent median ${duration(a.agent_response.median)}`),
  ];
  return lines.join('\n');
}
