import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler, serverOptions } from './server';
import { loadAreas } from './config';
import { run } from './cli';
import { computeMetrics } from './metrics';
import { areaLabel, areaOf, parseAreas, sortAreas, subHeading, DEFAULT_AREAS } from './inbox/areas.js';

const RULES = [
  { key: 'home', label: 'Start page', match: '/', exact: true },
  { key: 'billing', label: 'Billing desk', match: '/billing' },
  { key: 'projects', label: 'Project pages', match: '/projects/', sub: 1 },
];
const config = parseAreas(RULES);
const at = (url: string, mode = 'element') => areaOf({ mode, url }, config).area;

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'feedback-areas-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test('matching: a prefix matches its own path and anything below it, never a longer first segment', () => {
  expect(at('http://x/billing')).toBe('billing');
  expect(at('http://x/billing/')).toBe('billing');
  expect(at('http://x/billing/invoices/3?tab=1#top')).toBe('billing');
  expect(at('http://x/BILLING/Invoices')).toBe('billing'); // case-insensitive
  expect(at('http://x/billingx')).toBe('billingx'); // not under /billing: falls back to the path-segment rule
});

test('exact: matches only that path', () => {
  expect(at('http://x/')).toBe('home');
  expect(at('http://x')).toBe('home');
  expect(at('/')).toBe('home');
  expect(at('http://x/about')).toBe('about'); // "/" is exact, so it does not swallow everything
});

test('sub-groups: the nth segment after the prefix; no such segment means the plain area', () => {
  expect(at('http://x/projects/p1')).toBe('projects:p1');
  expect(at('http://x/projects/P1/tasks/9')).toBe('projects:p1');
  expect(at('http://x/projects/a%20b')).toBe('projects:a-b');
  expect(at('http://x/projects/100%')).toBe('projects:100');
  expect(at('http://x/projects')).toBe('projects');
  const second = parseAreas([{ key: 'ws', label: 'Workspace', match: '/w', sub: 2 }]);
  expect(areaOf({ url: '/w/acme/board/7' }, second).area).toBe('ws:board');
  expect(areaOf({ url: '/w/acme' }, second).area).toBe('ws');
});

test('first match wins, then the v0.1.0 fallback; threads without a capture are Conversations', () => {
  const ordered = parseAreas([{ key: 'one', label: 'One', match: '/a/b' }, { key: 'two', label: 'Two', match: '/a' }]);
  expect(areaOf({ url: '/a/b/c' }, ordered).area).toBe('one');
  expect(areaOf({ url: '/a/z' }, ordered).area).toBe('two');
  expect(areaOf({ url: '/other/x' }, ordered).area).toBe('other');
  expect(areaOf({ url: '/_admin/x' }, ordered).area).toBe('_admin');
  expect(areaOf({ url: '/100%/x' }, DEFAULT_AREAS).area).toBe('100');
  expect(areaOf({ mode: 'thread', url: '' }, config).area).toBe('conversations');
  expect(areaOf({ url: '/billing' })).toEqual({ area: 'billing' }); // no config: the old rule
  expect(areaOf({ url: '/' })).toEqual({ area: 'home' });
});

test('labels and order: configured areas in config order, then Home and the rest, Conversations last', () => {
  expect(areaLabel('billing', config)).toBe('Billing desk');
  expect(areaLabel('projects:p1', config)).toBe('Project pages / p1');
  expect(areaLabel('about', config)).toBe('About');
  expect(areaLabel('conversations', config)).toBe('Conversations');
  const renamed = parseAreas({ areas: RULES, conversations: 'Chats' });
  expect(areaLabel('conversations', renamed)).toBe('Chats');
  expect(sortAreas(['conversations', 'zeta', 'projects:p2', 'home', 'billing', 'projects:p1', 'alpha'], config))
    .toEqual(['home', 'billing', 'projects:p1', 'projects:p2', 'alpha', 'zeta', 'conversations']);
  expect(sortAreas(['conversations', 'zeta', 'home', 'alpha'])).toEqual(['home', 'alpha', 'zeta', 'conversations']);
});

test('a bad config is rejected with a message that names the problem', () => {
  const bad = (raw: unknown, message: string) => expect(() => parseAreas(raw)).toThrow(message);
  bad('nope', 'expected an array');
  bad([1], 'area 1 must be an object');
  bad([{ key: 'A b', label: 'x', match: '/x' }], '"key" must be');
  bad([{ key: 'conversations', label: 'x', match: '/x' }], 'reserved');
  bad([{ key: 'a', label: 'x', match: '/x' }, { key: 'a', label: 'y', match: '/y' }], 'duplicate key "a"');
  bad([{ key: 'a', label: '', match: '/x' }], '"label"');
  bad([{ key: 'a', label: 'x', match: 'x' }], '"match" must be a path prefix');
  bad([{ key: 'a', label: 'x', match: '/x?q=1' }], '"match" must be a path prefix');
  bad([{ key: 'a', label: 'x', match: '/x', sub: 0 }], '"sub"');
  bad([{ key: 'a', label: 'x', match: '/x', exact: 'yes' }], '"exact"');
  bad([{ key: 'a', label: 'x', match: '/x', exact: true, sub: 1 }], 'cannot be combined');
  bad([{ key: 'a', label: 'x', match: '/x', color: 'red' }], 'unknown field "color"');
  bad({ areas: [], extra: 1 }, 'unknown top-level field');
  bad({ conversations: '  ' }, '"conversations"');
});

test('the server loads the config from a file or inline JSON and fails clearly on a bad one', async () => {
  expect(loadAreas({})).toBe(DEFAULT_AREAS);
  expect(loadAreas({ FEEDBACK_AREAS_JSON: JSON.stringify(RULES) }).areas.map(a => a.key)).toEqual(['home', 'billing', 'projects']);
  const file = join(dir, 'areas.json');
  await writeFile(file, JSON.stringify({ areas: RULES, conversations: 'Chats' }));
  expect(loadAreas({ FEEDBACK_AREAS: file }).conversations).toBe('Chats');
  expect(() => loadAreas({ FEEDBACK_AREAS: file, FEEDBACK_AREAS_JSON: '[]' })).toThrow('only one');
  expect(() => loadAreas({ FEEDBACK_AREAS: join(dir, 'missing.json') })).toThrow('cannot read the file');
  expect(() => loadAreas({ FEEDBACK_AREAS_JSON: '[{' })).toThrow('FEEDBACK_AREAS_JSON: not valid JSON');
  expect(() => loadAreas({ FEEDBACK_AREAS_JSON: '[{"key":"a"}]' })).toThrow('FEEDBACK_AREAS_JSON: Invalid areas config: area "a"');
  await writeFile(file, '[{"key":"Bad","label":"x","match":"/x"}]');
  expect(() => serverOptions({ FEEDBACK_AREAS: file })).toThrow(`FEEDBACK_AREAS (${file})`); // startup fails before listening
});

test('the server serves the effective area list: the default, or the configured one', async () => {
  const get = async (h: ReturnType<typeof createHandler>) => (await h(new Request('http://local/__feedback/api/areas'))).json();
  expect(await get(createHandler(dir))).toEqual({ areas: [], conversations: 'Conversations' });
  expect(await get(createHandler(dir, config))).toEqual({ areas: RULES, conversations: 'Conversations' });
});

test('pins work for configured keys, sub-groups and keys that start with an underscore', async () => {
  const handle = createHandler(dir, config);
  const pin = async (id: string) => handle(new Request('http://local/__feedback/api/pins', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'area', id, pinned: true }) }));
  for (const id of ['billing', 'projects:p1', 'projects:a-b', '_admin', 'conversations', areaOf({ url: '/_admin/x' }, config).area, areaOf({ url: '/projects/a%20b/x' }, config).area]) expect((await pin(id)).status).toBe(200);
  const pins = await (await handle(new Request('http://local/__feedback/api/pins'))).json();
  expect(pins.areas).toEqual(['billing', 'projects:p1', 'projects:a-b', '_admin', 'conversations']);
  for (const id of ['projects:', ':p1', 'a:b:c', 'Projects:P1', '-x', 'projects:-x']) expect((await pin(id)).status).toBe(400);
});

test('metrics group by the configured areas, with their labels, and the CLI uses the same config', async () => {
  const seed = async (id: string, url: string | null) => {
    await mkdir(join(dir, id), { recursive: true });
    const item = url === null ? { id, created_at: '2026-11-18T10:00:00.000Z', mode: 'thread', title: id, origin: 'user', note: 'n' } : { id, created_at: '2026-11-18T10:00:00.000Z', mode: 'element', note: 'n', context: { url }, image: 'image.png' };
    await writeFile(join(dir, id, 'item.json'), JSON.stringify(item));
    await writeFile(join(dir, id, 'status.json'), JSON.stringify({ status: 'open' }));
    await writeFile(join(dir, id, 'thread.jsonl'), `${JSON.stringify({ id: 'm1', author: 'user', text: 'hi', images: [], created_at: '2026-11-18T10:00:00.000Z' })}\n`);
  };
  await seed('20261118-100000-aaaa', '/');
  await seed('20261118-100001-aaab', '/billing/x');
  await seed('20261118-100002-aaac', '/projects/p2/t');
  await seed('20261118-100003-aaad', '/projects/p1');
  await seed('20261118-100004-aaae', '/projects/p1/t');
  await seed('20261118-100005-aaaf', '/zeta');
  await seed('20261118-100006-aaa0', null);
  const m = await computeMetrics(dir, 'all', new Date('2026-11-18T12:00:00.000Z'), parseAreas({ areas: RULES, conversations: 'Chats' }));
  expect(m.areas.map(a => [a.area, a.label, a.threads])).toEqual([
    ['home', 'Start page', 1], ['billing', 'Billing desk', 1], ['projects:p1', 'Project pages / p1', 2], ['projects:p2', 'Project pages / p2', 1], ['zeta', 'Zeta', 1], ['conversations', 'Chats', 1],
  ]);
  const plain = await computeMetrics(dir, 'all', new Date('2026-11-18T12:00:00.000Z'));
  expect(plain.areas.map(a => a.area)).toEqual(['home', 'billing', 'projects', 'zeta', 'conversations']);
  const text = await run(['metrics', '--window', 'all'], dir, parseAreas({ areas: RULES }));
  expect(text).toContain('Project pages / p1');
  // the HTTP endpoint agrees
  const body = await (await createHandler(dir, config)(new Request('http://local/__feedback/api/metrics?window=all'))).json();
  expect(body.areas.map((a: { label: string }) => a.label)).toContain('Billing desk');
});

// A config that uses every 0.3.0 feature: suffix, prefix, subHeading, a fallback group and an explicit order.
const RICH = parseAreas({
  areas: [
    { key: 'start', label: 'Start', match: '/', exact: true },
    { key: 'admin', label: 'Admin desk', match: '/admin' },
    { key: 'setup', label: 'Set-up', match: '/setup', suffix: '/wizard' },
    { key: 'spaces', label: 'Spaces', match: '/spaces', sub: 1, subHeading: 'space {sub}' },
    { key: 'reports', label: 'Reports', prefix: '/report' },
  ],
  fallback: { key: 'misc', label: 'Everything else' },
  conversations: 'Chats',
  order: ['start', 'admin', 'spaces', 'reports', 'setup', 'misc', 'conversations'],
});
const rich = (url: string, mode = 'element') => areaOf({ mode, url }, RICH);

test('suffix: a path ending with it matches, before later rules, case-insensitively, ignoring the query', () => {
  expect(rich('http://x/spaces/s1/wizard').area).toBe('setup'); // the setup rule is listed before spaces, so its suffix wins
  const ahead = parseAreas([{ key: 'setup', label: 'Set-up', suffix: '/wizard' }, { key: 'spaces', label: 'Spaces', match: '/spaces', sub: 1 }]);
  expect(areaOf({ url: 'http://x/spaces/s1/wizard?step=2#top' }, ahead).area).toBe('setup');
  expect(areaOf({ url: 'http://x/spaces/s1/WIZARD' }, ahead).area).toBe('setup');
  expect(areaOf({ url: 'http://x/spaces/s1/wizards' }, ahead).area).toBe('spaces:s1');
  expect(rich('http://x/setup').area).toBe('setup');
  expect(rich('http://x/anything/wizard').area).toBe('setup');
});

test('prefix: plain text at the start of the raw path, case-sensitive, no segment boundary', () => {
  expect(rich('/reports').area).toBe('reports');
  expect(rich('/reportsx/1').area).toBe('reports'); // not a segment match: /report also takes /reportsx
  expect(rich('/report').area).toBe('reports');
  expect(rich('/Reports').area).toBe('misc'); // case-sensitive
  expect(rich('/a/reports').area).toBe('misc');
  expect(rich('http://x/reports/1?q=2#h').area).toBe('reports'); // query and fragment are not part of the path
  const lone = parseAreas([{ key: 'a', label: 'A', prefix: '/a(b+)+' }]); // regex characters are plain text
  expect(areaOf({ url: '/a(b+)+/x' }, lone).area).toBe('a');
  expect(areaOf({ url: '/abbb' }, lone).area).toBe('abbb');
});

test('a rule with several matchers matches when any of them does; sub only comes from the prefix', () => {
  expect(rich('/setup/step1').area).toBe('setup');
  expect(rich('/elsewhere/wizard').area).toBe('setup');
  const both = parseAreas([{ key: 'w', label: 'W', match: '/w', sub: 1, suffix: '/edit' }]);
  expect(areaOf({ url: '/w/a1/x' }, both).area).toBe('w:a1');
  expect(areaOf({ url: '/q/edit' }, both).area).toBe('w');
});

test('subHeading keeps one group and reports the sub-value for the inbox to put under a heading', () => {
  expect(rich('/spaces/s1/board')).toEqual({ area: 'spaces', sub: 's1' });
  expect(rich('/spaces/a%20b')).toEqual({ area: 'spaces', sub: 'a b' }); // decoded, not slugged
  expect(rich('/spaces/100%')).toEqual({ area: 'spaces', sub: '100%' });
  expect(rich('/spaces')).toEqual({ area: 'spaces' });
  expect(subHeading('spaces', 's1', RICH)).toBe('space s1');
  expect(subHeading('admin', 's1', RICH)).toBeNull();
});

test('fallback: every unmatched path goes to one group, with its label', () => {
  expect(rich('/nowhere/deep').area).toBe('misc');
  expect(rich('http://x/%E0%A4%A').area).toBe('misc');
  expect(rich('', 'element').area).toBe('start');
  expect(rich('').area).toBe('start');
  expect(areaLabel('misc', RICH)).toBe('Everything else');
  expect(areaOf({ mode: 'thread', url: '' }, RICH).area).toBe('conversations');
  expect(areaLabel('conversations', RICH)).toBe('Chats');
  expect(areaOf({ url: '/nowhere' }, parseAreas([{ key: 'a', label: 'A', match: '/a' }])).area).toBe('nowhere'); // without a fallback: v0.2.0
});

test('order: the sidebar and metrics follow the listed order, with Conversations where it is put', () => {
  const keys = ['conversations', 'misc', 'setup', 'reports', 'spaces', 'admin', 'start'];
  expect(sortAreas(keys, RICH)).toEqual(['start', 'admin', 'spaces', 'reports', 'setup', 'misc', 'conversations']);
  const early = parseAreas({ areas: [{ key: 'a', label: 'A', match: '/a' }, { key: 'b', label: 'B', match: '/b', sub: 1 }], order: ['conversations', 'b'] });
  expect(sortAreas(['a', 'b:y', 'b:x', 'conversations', 'zeta', 'home'], early)).toEqual(['conversations', 'b:x', 'b:y', 'a', 'home', 'zeta']);
  const unlisted = parseAreas({ areas: [{ key: 'a', label: 'A', match: '/a' }], fallback: { key: 'o', label: 'O' } });
  expect(sortAreas(['conversations', 'o', 'zeta', 'a'], unlisted)).toEqual(['a', 'o', 'zeta', 'conversations']);
});

test('the new fields are checked, with messages that name the problem', () => {
  const bad = (raw: unknown, message: string) => expect(() => parseAreas(raw)).toThrow(message);
  bad([{ key: 'a', label: 'x' }], 'at least one of "match", "suffix" or "prefix"');
  bad([{ key: 'a', label: 'x', suffix: '' }], '"suffix"');
  bad([{ key: 'a', label: 'x', suffix: '/x?y' }], '"suffix"');
  bad([{ key: 'a', label: 'x', prefix: '' }], '"prefix"');
  bad([{ key: 'a', label: 'x', prefix: '/x#y' }], '"prefix"');
  bad([{ key: 'a', label: 'x', prefix: 'x'.repeat(81) }], '"prefix"');
  bad([{ key: 'a', label: 'x', pattern: '^/x' }], 'unknown field "pattern"');
  bad([{ key: 'a', label: 'x', prefix: '/x', sub: 1 }], 'go with "match"');
  bad([{ key: 'a', label: 'x', prefix: '/x', exact: true }], 'go with "match"');
  bad([{ key: 'a', label: 'x', match: '/x', subHeading: 'y {sub}' }], '"subHeading" needs "sub"');
  bad([{ key: 'a', label: 'x', match: '/x', sub: 1, subHeading: 'no placeholder' }], 'contains {sub}');
  bad({ areas: [], fallback: 'other' }, '"fallback" must be an object');
  bad({ areas: [], fallback: { key: 'o', label: 'O', x: 1 } }, 'unknown field "x"');
  bad({ areas: [], fallback: { key: 'Bad', label: 'O' } }, '"fallback": "key"');
  bad({ areas: [], fallback: { key: 'conversations', label: 'O' } }, 'reserved');
  bad({ areas: [], fallback: { key: 'o', label: '' } }, '"label"');
  bad({ areas: [{ key: 'o', label: 'x', match: '/x' }], fallback: { key: 'o', label: 'O' } }, 'already used by an area');
  bad({ areas: [], order: 'a' }, '"order" must be an array');
  bad({ areas: [{ key: 'a', label: 'x', match: '/x' }], order: ['a', 'zz'] }, '"order" lists "zz"');
  bad({ areas: [{ key: 'a', label: 'x', match: '/x' }], order: ['a', 'a'] }, 'twice');
});

test('the server serves the fallback and order, and the metrics use them', async () => {
  const body = await (await createHandler(dir, RICH)(new Request('http://local/__feedback/api/areas'))).json();
  expect(body.fallback).toEqual({ key: 'misc', label: 'Everything else' });
  expect(body.order).toEqual(['start', 'admin', 'spaces', 'reports', 'setup', 'misc', 'conversations']);
  expect(loadAreas({ FEEDBACK_AREAS_JSON: JSON.stringify(body) })).toEqual(RICH);
  for (const [id, url] of [['20261118-100000-aaaa', '/nowhere'], ['20261118-100001-aaab', '/spaces/s1']] as const) {
    await mkdir(join(dir, id), { recursive: true });
    await writeFile(join(dir, id, 'item.json'), JSON.stringify({ id, created_at: '2026-11-18T10:00:00.000Z', mode: 'element', note: 'n', context: { url }, image: 'image.png' }));
    await writeFile(join(dir, id, 'status.json'), JSON.stringify({ status: 'open' }));
    await writeFile(join(dir, id, 'thread.jsonl'), `${JSON.stringify({ id: 'm1', author: 'user', text: 'hi', images: [], created_at: '2026-11-18T10:00:00.000Z' })}\n`);
  }
  const m = await computeMetrics(dir, 'all', new Date('2026-11-18T12:00:00.000Z'), RICH);
  expect(m.areas.map(a => [a.area, a.label])).toEqual([['spaces', 'Spaces'], ['misc', 'Everything else']]);
});

test('the inbox page carries the widget script unless FEEDBACK_INBOX_WIDGET turns it off', async () => {
  const page = async () => (await createHandler(dir)(new Request('http://local/__feedback/inbox/'))).text();
  expect(await page()).toContain('embed.js');
  process.env.FEEDBACK_INBOX_WIDGET = '0';
  try {
    const off = await page();
    expect(off).not.toContain('embed.js');
    expect(off).toContain('app.js');
  } finally { delete process.env.FEEDBACK_INBOX_WIDGET; }
});

test('--help prints the usage', async () => {
  for (const flag of ['--help', '-h', 'help']) expect(await run([flag], dir)).toContain('Usage:');
});
