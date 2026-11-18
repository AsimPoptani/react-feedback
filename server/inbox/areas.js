// Which area of the app a thread belongs to: the first segment of the page path the note was taken on
// ("/" is Home, "/billing/plans" is Billing). Shared by the inbox sidebar and the metrics (server), so both group the same way.
export const CONVERSATIONS = 'conversations';
export const HOME = 'home';
const label = key => (key === HOME ? 'Home' : key === CONVERSATIONS ? 'Conversations' : key.charAt(0).toUpperCase() + key.slice(1).replace(/[-_]+/g, ' '));
export function areaLabel(key) { return label(key); }
// Areas are open-ended now, so a list of the ones present is built from the threads (see areasOf).
export function areaOf(t) {
  if (t.mode === 'thread') return { area: CONVERSATIONS };
  let path = '/';
  try { path = new URL(t.url || '/', 'http://x').pathname; } catch { /* unparseable */ }
  const first = path.split('/').filter(Boolean)[0];
  if (!first) return { area: HOME };
  let raw = first;
  try { raw = decodeURIComponent(first); } catch { /* a bad escape, like /100%, keeps the raw text */ }
  const key = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return { area: key || 'other' };
}
// The area keys in display order: Home first, Conversations last, the rest alphabetical.
export function sortAreas(keys) {
  const rest = [...new Set(keys)].filter(k => k !== HOME && k !== CONVERSATIONS).sort();
  return [...(keys.includes(HOME) ? [HOME] : []), ...rest, ...(keys.includes(CONVERSATIONS) ? [CONVERSATIONS] : [])];
}
