// The global tracker, the part that needs no DOM: which group a checklist item belongs to, and the filters. Shared by the server, the CLI and the inbox page.
export const RECENT_MS = 7 * 24 * 3600e3; // ticked items stay under "Done recently" for a week
export const STATES = ['open', 'claimed', 'done'];
export const stateOf = item => (item.done ? 'done' : item.claimed_by_user_at ? 'claimed' : 'open');
const when = row => Date.parse(row.item.done_at ?? row.item.created_at) || 0;

// rows: { thread, title, read_only, item }. Filters: `thread` (id), `state` ('open' | 'claimed' | 'done'), `q` (text of the item, case-insensitive).
export function filterRows(rows, { thread, state, q } = {}) {
  const needle = String(q ?? '').trim().toLowerCase();
  return rows.filter(r => (!thread || r.thread === thread) && (!state || stateOf(r.item) === state) && (!needle || r.item.text.toLowerCase().includes(needle)));
}
// For you, For the agent (both: not ticked, oldest first), then Done recently (ticked within a week, newest first). Older ticked items are not listed.
export function groupRows(rows, now = Date.now()) {
  const open = rows.filter(r => !r.item.done).sort((a, b) => a.item.created_at.localeCompare(b.item.created_at));
  const recent = rows.filter(r => r.item.done && now - when(r) <= RECENT_MS).sort((a, b) => when(b) - when(a));
  return { you: open.filter(r => r.item.owner === 'user'), agent: open.filter(r => r.item.owner === 'agent'), done_recent: recent };
}
// "3 d" style age for an ISO time; the page and the CLI both use it.
export function ageOf(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 129600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}
