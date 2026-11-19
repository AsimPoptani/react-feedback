// Browser test for 0.8.1: fired reminders only in the Reminders sheet, and "last seen" for both sides in the thread header.
// Needs Playwright (PLAYWRIGHT=/path/to/playwright/index.mjs). Run: bun e2e/rf8.mjs   (SHOTS=/some/dir also saves screenshots)
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'rf8-e2e-'));
process.env.FEEDBACK_DIR = join(root, 'data');
const DIR = process.env.FEEDBACK_DIR, SHOTS = process.env.SHOTS;
const store = await import('../server/store.ts');
const reminders = await import('../server/reminders.ts');
const { serverOptions } = await import('../server/server.ts');
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');

const { id } = await store.createThread(DIR, { title: 'Presence test', text: 'Hello there', origin: 'user' });
await reminders.addReminder(DIR, id, { kind: 'idle', value: '1m', say: 'Is the checklist up to date?', by: 'user' });
await reminders.fireThread(DIR, id, { now: Date.now() + 5 * 60e3, armedAt: 0 });
await new Promise(r => setTimeout(r, 20));
await store.appendMessage(DIR, id, { author: 'agent', text: 'Hi from the agent' });
const ro = (await store.createThread(DIR, { title: 'Updates only', text: 'News', origin: 'agent', readOnly: true })).id;
// The agent was last active 2 minutes ago, a second agent three hours ago.
await store.touchPresence(DIR, { agent: undefined }, Date.now() - 120e3);
await store.touchPresence(DIR, { agent: 'Codex' }, Date.now() - 3 * 3600e3);

const server = Bun.serve({ ...serverOptions(), hostname: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.port}`;
const base = `${origin}/__feedback/inbox/#/`;
const browser = await chromium.launch();
let failed = 0;
const check = (name, ok) => { console.log(ok ? 'ok  ' : 'FAIL', name); if (!ok) failed++; };
const shot = (page, name) => SHOTS ? page.screenshot({ path: join(SHOTS, `${name}.png`) }) : null;
const header = async page => { await page.waitForSelector('#presence:not([hidden])'); return page.locator('#presence').innerText(); };
try {
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' })).newPage();
  const errors = []; phone.on('pageerror', e => errors.push(String(e)));
  await phone.goto(base + id); await phone.waitForSelector('#msgs .msg'); await phone.waitForTimeout(400);
  const text = await header(phone);
  check('phone: the header shows the agent as active 2 min ago', /Agent · active 2 min ago/.test(text));
  check('phone: another agent last active hours ago shows a time, not a relative one', /Codex · active \d/.test(text) && !/Codex · active \d+ min ago/.test(text));
  check('phone: the header shows when the user was last here', /You · last seen (just now|\d+ min ago)/.test(text));
  check('phone: no reminder line in the thread', await phone.locator('[data-reminder], .sysline').count() === 0 && !(await phone.locator('#msgs').innerText()).includes('Reminder'));
  check('phone: the presence line does not scroll the page sideways', await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await shot(phone, 'presence-390');
  await phone.locator('#more').tap();
  await phone.locator('#popmenu button', { hasText: 'Reminders' }).tap();
  await phone.waitForSelector('#remind-dialog[open]');
  const fired = await phone.locator('#remind-fired').innerText();
  check('phone: the sheet lists the fired reminder with a time', fired.includes('Is the checklist up to date?') && await phone.locator('#remind-fired time').count() === 1);
  await shot(phone, 'reminders-fired-390');
  await phone.locator('#remind-close').tap();
  await phone.goto(base + ro); await phone.waitForSelector('#msgs .msg'); await phone.waitForTimeout(300);
  check('phone: a read-only thread still shows presence', /Agent · active/.test(await header(phone)) && await phone.locator('#composer').isHidden());
  await shot(phone, 'presence-readonly-390');
  check('no page errors', errors.length === 0);

  const wide = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })).newPage();
  await wide.goto(base + id); await wide.waitForSelector('#msgs .msg');
  check('desktop: the header shows both sides', /Agent · active 2 min ago/.test(await header(wide)) && /You · last seen/.test(await wide.locator('#presence').innerText()));
  check('desktop: no reminder line in the thread', await wide.locator('[data-reminder], .sysline').count() === 0);
  await shot(wide, 'presence-1280');
  await wide.locator('#remind-open').click(); await wide.waitForSelector('#remind-dialog[open]');
  check('desktop: the Reminders button opens the sheet with the Fired list', (await wide.locator('#remind-fired').innerText()).includes('Is the checklist up to date?'));
  await shot(wide, 'reminders-fired-1280');
  await wide.locator('#remind-close').click();
  await wide.goto(base + ro); await wide.waitForSelector('#msgs .msg');
  check('desktop: a read-only thread still shows presence', /Agent · active/.test(await header(wide)));

  // Presence over the API holds timestamps and names only; with no data the line stays hidden.
  const p = await (await fetch(`${origin}/__feedback/api/presence`)).json();
  check('API: presence has only user and agents, with timestamps', Object.keys(p).sort().join() === 'agents,user' && p.agents.every(a => Object.keys(a).every(k => k === 'at' || k === 'name')));
  const fresh = await mkdtemp(join(tmpdir(), 'rf8-empty-'));
  process.env.FEEDBACK_DIR = fresh;
  const empty = Bun.serve({ ...serverOptions(), hostname: '127.0.0.1', port: 0 });
  await store.createThread(fresh, { title: 'Quiet', text: 'x', origin: 'agent', readOnly: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })).newPage();
  await page.route('**/api/presence', route => route.fulfill({ json: { user: null, agents: [] } }));
  await page.goto(`http://127.0.0.1:${empty.port}/__feedback/inbox/#/${(await store.listThreads(fresh))[0].id}`); await page.waitForSelector('#msgs .msg'); await page.waitForTimeout(500);
  check('no data: the presence line is hidden', await page.locator('#presence').isHidden());
  empty.stop(true);
} finally { await browser.close(); server.stop(true); }
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);
