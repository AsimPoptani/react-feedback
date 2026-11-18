// Which area of the app a thread belongs to. Shared by the inbox sidebar (browser) and the metrics (server), so both group the same way.
// With no config an area is the first segment of the page path ("/" is Home, "/billing/plans" is Billing). A host can configure areas
// (see parseAreas): the first rule that matches the path wins and anything unmatched falls back to the first-segment rule.
// A group key is `key` or, for a sub-group, `key:sub` (for example `projects:p1`).
export const CONVERSATIONS = 'conversations';
export const HOME = 'home';
export const DEFAULT_AREAS = Object.freeze({ areas: Object.freeze([]), conversations: 'Conversations' });
export const KEY = /^[a-z0-9_][a-z0-9_-]{0,39}$/;
const slug = raw => raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const decode = s => { try { return decodeURIComponent(s); } catch { return s; } }; // a bad escape, like /100%, keeps the raw text
const segmentsOf = path => path.split('/').filter(Boolean).map(decode);
const capitalise = key => key.charAt(0).toUpperCase() + key.slice(1).replace(/[-_]+/g, ' ');

// Validate a host's area config: an array of rules, or { areas, conversations } to also rename the "Conversations" group.
// Throws an Error with a message that says which rule is wrong.
export function parseAreas(raw) {
  const fail = message => { throw new Error(`Invalid areas config: ${message}`); };
  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  let list = raw, conversations = DEFAULT_AREAS.conversations;
  if (isObject(raw)) {
    for (const k of Object.keys(raw)) if (k !== 'areas' && k !== 'conversations') fail(`unknown top-level field "${k}"`);
    list = raw.areas ?? [];
    if (raw.conversations !== undefined) {
      if (typeof raw.conversations !== 'string' || !raw.conversations.trim() || raw.conversations.length > 80) fail('"conversations" must be a label of 1 to 80 characters');
      conversations = raw.conversations;
    }
  }
  if (!Array.isArray(list)) fail('expected an array of areas, or an object with an "areas" array');
  const seen = new Set();
  const areas = list.map((a, i) => {
    const at = `area ${i + 1}`;
    if (!isObject(a)) fail(`${at} must be an object`);
    for (const k of Object.keys(a)) if (!['key', 'label', 'match', 'exact', 'sub'].includes(k)) fail(`${at} has an unknown field "${k}"`);
    if (typeof a.key !== 'string' || !KEY.test(a.key)) fail(`${at}: "key" must be 1 to 40 characters of a-z, 0-9, "_" or "-" (lower case, not starting with "-")`);
    if (a.key === CONVERSATIONS) fail(`${at}: "${CONVERSATIONS}" is reserved for threads without a capture (rename it with "conversations")`);
    if (seen.has(a.key)) fail(`${at}: duplicate key "${a.key}"`);
    seen.add(a.key);
    if (typeof a.label !== 'string' || !a.label.trim() || a.label.length > 80) fail(`area "${a.key}": "label" must be 1 to 80 characters`);
    if (typeof a.match !== 'string' || !a.match.startsWith('/') || /[?#]/.test(a.match)) fail(`area "${a.key}": "match" must be a path prefix starting with "/" (no query or fragment)`);
    if (a.exact !== undefined && typeof a.exact !== 'boolean') fail(`area "${a.key}": "exact" must be true or false`);
    if (a.sub !== undefined && (!Number.isInteger(a.sub) || a.sub < 1 || a.sub > 10)) fail(`area "${a.key}": "sub" must be a whole number from 1 to 10`);
    if (a.exact && a.sub !== undefined) fail(`area "${a.key}": "exact" and "sub" cannot be combined`);
    return { key: a.key, label: a.label, match: a.match, ...(a.exact ? { exact: true } : {}), ...(a.sub !== undefined ? { sub: a.sub } : {}) };
  });
  return { areas, conversations };
}

// The path segments left after the rule's prefix, or null when the rule does not match.
function rest(rule, segs) {
  const prefix = segmentsOf(rule.match).map(s => s.toLowerCase());
  if (prefix.length > segs.length || (rule.exact && prefix.length !== segs.length)) return null;
  return prefix.every((p, i) => segs[i].toLowerCase() === p) ? segs.slice(prefix.length) : null;
}
export function areaOf(t, config = DEFAULT_AREAS) {
  if (t.mode === 'thread') return { area: CONVERSATIONS };
  let path = '/';
  try { path = new URL(t.url || '/', 'http://x').pathname; } catch { /* unparseable */ }
  const segs = segmentsOf(path);
  for (const rule of config.areas) {
    const left = rest(rule, segs);
    if (!left) continue;
    const sub = rule.sub ? left[rule.sub - 1] : undefined;
    return { area: sub === undefined ? rule.key : `${rule.key}:${slug(sub) || 'other'}` };
  }
  if (!segs[0]) return { area: HOME };
  return { area: slug(segs[0]) || 'other' };
}
export function areaLabel(key, config = DEFAULT_AREAS) {
  if (key === CONVERSATIONS) return config.conversations;
  const [base, sub] = key.split(':');
  const rule = config.areas.find(a => a.key === base);
  if (rule) return sub === undefined ? rule.label : `${rule.label} / ${sub}`;
  return key === HOME ? 'Home' : capitalise(key);
}
// Display order: configured areas in config order (sub-groups alphabetical), then the rest with Home first, then Conversations last.
export function sortAreas(keys, config = DEFAULT_AREAS) {
  const unique = [...new Set(keys)];
  const index = key => config.areas.findIndex(a => a.key === key.split(':')[0]);
  const configured = unique.filter(k => k !== CONVERSATIONS && index(k) >= 0).sort((a, b) => index(a) - index(b) || (a < b ? -1 : a > b ? 1 : 0));
  const rest = unique.filter(k => k !== HOME && k !== CONVERSATIONS && index(k) < 0).sort();
  const home = unique.includes(HOME) && index(HOME) < 0 ? [HOME] : [];
  return [...configured, ...home, ...rest, ...(unique.includes(CONVERSATIONS) ? [CONVERSATIONS] : [])];
}
