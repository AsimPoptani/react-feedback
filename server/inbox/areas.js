// Which area of the app a thread belongs to. Shared by the inbox sidebar (browser) and the metrics (server), so both group the same way.
// With no config an area is the first segment of the page path ("/" is Home, "/billing/plans" is Billing). A host can configure areas
// (see parseAreas): the first rule that matches the path wins and anything unmatched falls back to the first-segment rule, or to one
// configured fallback group.
// A group key is `key` or, for a sub-group, `key:sub` (for example `projects:p1`).
export const CONVERSATIONS = 'conversations';
export const HOME = 'home';
export const DEFAULT_AREAS = Object.freeze({ areas: Object.freeze([]), conversations: 'Conversations' });
export const KEY = /^[a-z0-9_][a-z0-9_-]{0,39}$/;
const slug = raw => raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const decode = s => { try { return decodeURIComponent(s); } catch { return s; } }; // a bad escape, like /100%, keeps the raw text
const segmentsOf = path => path.split('/').filter(Boolean).map(decode);
const capitalise = key => key.charAt(0).toUpperCase() + key.slice(1).replace(/[-_]+/g, ' ');

// Validate a host's area config: an array of rules, or { areas, conversations, fallback, order }. Throws an Error that says which rule is wrong.
const MAX_PATH = 2000; // longer paths are cut before a prefix or suffix looks at them

export function parseAreas(raw) {
  const fail = message => { throw new Error(`Invalid areas config: ${message}`); };
  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const checkLabel = (at, label) => { if (typeof label !== 'string' || !label.trim() || label.length > 80) fail(`${at}: "label" must be 1 to 80 characters`); };
  let list = raw, conversations = DEFAULT_AREAS.conversations, fallbackRaw, orderRaw;
  if (isObject(raw)) {
    for (const k of Object.keys(raw)) if (!['areas', 'conversations', 'fallback', 'order'].includes(k)) fail(`unknown top-level field "${k}"`);
    list = raw.areas ?? [];
    fallbackRaw = raw.fallback;
    orderRaw = raw.order;
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
    for (const k of Object.keys(a)) if (!['key', 'label', 'match', 'exact', 'sub', 'subHeading', 'suffix', 'prefix'].includes(k)) fail(`${at} has an unknown field "${k}"`);
    if (typeof a.key !== 'string' || !KEY.test(a.key)) fail(`${at}: "key" must be 1 to 40 characters of a-z, 0-9, "_" or "-" (lower case, not starting with "-")`);
    if (a.key === CONVERSATIONS) fail(`${at}: "${CONVERSATIONS}" is reserved for threads without a capture (rename it with "conversations")`);
    if (seen.has(a.key)) fail(`${at}: duplicate key "${a.key}"`);
    seen.add(a.key);
    const name = `area "${a.key}"`;
    checkLabel(name, a.label);
    if (a.match === undefined && a.suffix === undefined && a.prefix === undefined) fail(`${name}: give at least one of "match", "suffix" or "prefix"`);
    if (a.match !== undefined && (typeof a.match !== 'string' || !a.match.startsWith('/') || /[?#]/.test(a.match))) fail(`${name}: "match" must be a path prefix starting with "/" (no query or fragment)`);
    if (a.suffix !== undefined && (typeof a.suffix !== 'string' || !a.suffix || a.suffix.length > 80 || /[?#]/.test(a.suffix))) fail(`${name}: "suffix" must be 1 to 80 characters of path text (no query or fragment)`);
    if (a.prefix !== undefined && (typeof a.prefix !== 'string' || !a.prefix || a.prefix.length > 80 || /[?#]/.test(a.prefix))) fail(`${name}: "prefix" must be 1 to 80 characters of path text (no query or fragment)`);
    if (a.exact !== undefined && typeof a.exact !== 'boolean') fail(`${name}: "exact" must be true or false`);
    if (a.sub !== undefined && (!Number.isInteger(a.sub) || a.sub < 1 || a.sub > 10)) fail(`${name}: "sub" must be a whole number from 1 to 10`);
    if ((a.exact !== undefined || a.sub !== undefined) && a.match === undefined) fail(`${name}: "exact" and "sub" go with "match"`);
    if (a.exact && a.sub !== undefined) fail(`${name}: "exact" and "sub" cannot be combined`);
    if (a.subHeading !== undefined) {
      if (a.sub === undefined) fail(`${name}: "subHeading" needs "sub"`);
      if (typeof a.subHeading !== 'string' || !a.subHeading.includes('{sub}') || a.subHeading.length > 80) fail(`${name}: "subHeading" must be a heading of up to 80 characters that contains {sub}`);
    }
    return { key: a.key, label: a.label, ...(a.match !== undefined ? { match: a.match } : {}), ...(a.exact ? { exact: true } : {}), ...(a.sub !== undefined ? { sub: a.sub } : {}),
      ...(a.subHeading !== undefined ? { subHeading: a.subHeading } : {}), ...(a.suffix !== undefined ? { suffix: a.suffix } : {}), ...(a.prefix !== undefined ? { prefix: a.prefix } : {}) };
  });
  let fallback;
  if (fallbackRaw !== undefined) {
    if (!isObject(fallbackRaw)) fail('"fallback" must be an object with a "key" and a "label"');
    for (const k of Object.keys(fallbackRaw)) if (k !== 'key' && k !== 'label') fail(`"fallback" has an unknown field "${k}"`);
    if (typeof fallbackRaw.key !== 'string' || !KEY.test(fallbackRaw.key)) fail('"fallback": "key" must be 1 to 40 characters of a-z, 0-9, "_" or "-" (lower case, not starting with "-")');
    if (fallbackRaw.key === CONVERSATIONS) fail(`"fallback": "${CONVERSATIONS}" is reserved for threads without a capture`);
    if (seen.has(fallbackRaw.key)) fail(`"fallback": the key "${fallbackRaw.key}" is already used by an area`);
    checkLabel('"fallback"', fallbackRaw.label);
    fallback = { key: fallbackRaw.key, label: fallbackRaw.label };
  }
  let order;
  if (orderRaw !== undefined) {
    if (!Array.isArray(orderRaw)) fail('"order" must be an array of group keys');
    const known = new Set([...seen, CONVERSATIONS, HOME, ...(fallback ? [fallback.key] : [])]);
    const listed = new Set();
    for (const k of orderRaw) {
      if (typeof k !== 'string' || !known.has(k)) fail(`"order" lists "${String(k)}", which is not a group key`);
      if (listed.has(k)) fail(`"order" lists "${k}" twice`);
      listed.add(k);
    }
    order = [...orderRaw];
  }
  return { areas, conversations, ...(fallback ? { fallback } : {}), ...(order ? { order } : {}) };
}

// The path segments left after the rule's prefix, or null when the rule does not match.
function rest(rule, segs) {
  const prefix = segmentsOf(rule.match).map(s => s.toLowerCase());
  if (prefix.length > segs.length || (rule.exact && prefix.length !== segs.length)) return null;
  return prefix.every((p, i) => segs[i].toLowerCase() === p) ? segs.slice(prefix.length) : null;
}
// Whether a rule matches, and the path segments left after its prefix (empty when a suffix or prefix matched). A rule matches when any matcher it lists does.
function matches(rule, segs, path) {
  if (rule.match !== undefined) { const left = rest(rule, segs); if (left) return { left, byPrefix: true }; }
  if (rule.suffix !== undefined && path.toLowerCase().endsWith(rule.suffix.toLowerCase())) return { left: [], byPrefix: false };
  if (rule.prefix !== undefined && path.startsWith(rule.prefix)) return { left: [], byPrefix: false };
  return null;
}
// { area } for the group a thread belongs to; { area, sub } when the rule shows sub-values as headings inside one group (subHeading).
export function areaOf(t, config = DEFAULT_AREAS) {
  if (t.mode === 'thread') return { area: CONVERSATIONS };
  let path = '/';
  try { path = new URL(t.url || '/', 'http://x').pathname; } catch { /* unparseable */ }
  path = path.slice(0, MAX_PATH);
  const segs = segmentsOf(path);
  for (const rule of config.areas) {
    const hit = matches(rule, segs, path);
    if (!hit) continue;
    const sub = rule.sub && hit.byPrefix ? hit.left[rule.sub - 1] : undefined;
    if (sub === undefined) return { area: rule.key };
    return rule.subHeading ? { area: rule.key, sub } : { area: `${rule.key}:${slug(sub) || 'other'}` };
  }
  if (config.fallback) return { area: config.fallback.key };
  if (!segs[0]) return { area: HOME };
  return { area: slug(segs[0]) || 'other' };
}
// The heading above one sub-value inside a group, for rules with a subHeading ("field {sub}").
export function subHeading(key, sub, config = DEFAULT_AREAS) {
  const rule = config.areas.find(a => a.key === key && a.subHeading);
  return rule ? rule.subHeading.split('{sub}').join(sub) : null;
}
export function areaLabel(key, config = DEFAULT_AREAS) {
  if (key === CONVERSATIONS) return config.conversations;
  const [base, sub] = key.split(':');
  const rule = config.areas.find(a => a.key === base);
  if (rule) return sub === undefined ? rule.label : `${rule.label} / ${sub}`;
  if (config.fallback && config.fallback.key === base) return config.fallback.label;
  return key === HOME ? 'Home' : capitalise(key);
}
// Display order: groups named in "order" first, as listed; then configured areas in config order (sub-groups alphabetical), the fallback group,
// Home, the rest alphabetically, and Conversations last. Without "order" that last sequence is all there is.
export function sortAreas(keys, config = DEFAULT_AREAS) {
  const unique = [...new Set(keys)];
  const ruleIndex = base => config.areas.findIndex(a => a.key === base);
  const rank = key => {
    const base = key.split(':')[0];
    const listed = config.order ? config.order.indexOf(base) : -1;
    if (listed >= 0) return [0, listed];
    if (base === CONVERSATIONS) return [5, 0];
    if (ruleIndex(base) >= 0) return [1, ruleIndex(base)];
    if (config.fallback && config.fallback.key === base) return [2, 0];
    if (base === HOME) return [3, 0];
    return [4, 0];
  };
  return unique.sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1] || (a < b ? -1 : a > b ? 1 : 0); });
}
