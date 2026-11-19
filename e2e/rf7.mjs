// Browser test for thread reminders and agent names in the inbox. Needs Playwright (PLAYWRIGHT=/path/to/playwright/index.mjs) and a built dist/ (`bun run build`).
// Run: bun e2e/rf7.mjs            (SHOTS=/some/dir also saves screenshots)
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'rf7-e2e-'));
process.env.FEEDBACK_DIR = join(root, 'data');
const DIR = process.env.FEEDBACK_DIR, SHOTS = process.env.SHOTS;
const store = await import('../server/store.ts');
const reminders = await import('../server/reminders.ts');
const { serverOptions } = await import('../server/server.ts');
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');

const { id } = await store.createThread(DIR, { title: 'Reminders test', text: 'Hello there', origin: 'user' });
await reminders.addReminder(DIR, id, { kind: 'idle', value: '1m', say: 'Is the checklist up to date?', by: 'user' });
await reminders.fireThread(DIR, id, { now: Date.now() + 5 * 60e3, armedAt: 0 });
await new Promise(r => setTimeout(r, 20));
await store.appendMessage(DIR, id, { author: 'agent', text: 'Hi from the default agent' });
await store.appendMessage(DIR, id, { author: 'agent', agent_name: 'Codex', text: 'Hi from Codex' });
await store.appendMessage(DIR, id, { author: 'agent', agent_name: 'Claude Desktop', text: 'Hi from Claude Desktop' });
await store.addChecklistItem(DIR, id, { owner: 'agent', text: 'Ship it', by: 'agent' });
const ro = (await store.createThread(DIR, { title: 'Updates only', text: 'News', origin: 'agent', readOnly: true })).id;
await store.appendMessage(DIR, id, { author: 'user', text: 'A later message' });

const server = Bun.serve({ ...serverOptions(), hostname: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${server.port}/__feedback/inbox/#/`;
const browser = await chromium.launch();
let failed = 0;
const check = (name, ok) => { console.log(ok ? 'ok  ' : 'FAIL', name); if (!ok) failed++; };
const shot = (page, name) => SHOTS ? page.screenshot({ path: join(SHOTS, `${name}.png`) }) : null;
try {
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
  const errors = []; phone.on('pageerror', e => errors.push(String(e)));
  await phone.goto(base + id); await phone.waitForSelector('#msgs .msg'); await phone.waitForTimeout(500);
  check('phone: a fired reminder is not drawn in the thread', await phone.locator('.sysline, [data-reminder]').count() === 0 && !(await phone.locator('#msgs').innerText()).includes('Reminder to the agent'));
  const names = await phone.locator('.msg.agent .who strong').allInnerTexts();
  check('phone: agents show their own names', names.join('|').includes('Codex') && names.join('|').includes('Claude Desktop'));
  const colours = await phone.locator('.msg.agent .who .avatar').evaluateAll(a => a.map(x => getComputedStyle(x).backgroundColor));
  check('phone: each agent name has its own avatar colour', colours.length === 3 && new Set(colours).size === 3);
  await shot(phone, 'agents-390');
  await phone.locator('#more').tap();
  check('phone: ⋯ has a Reminders item', (await phone.locator('#popmenu button').allInnerTexts()).includes('Reminders'));
  await phone.locator('#popmenu button', { hasText: 'Reminders' }).tap();
  await phone.waitForSelector('#remind-dialog[open]');
  check('phone: the sheet lists the built-in reminder as on', await phone.locator('#remind-default').isChecked());
  check('phone: the sheet lists the fired reminder with its time', (await phone.locator('#remind-fired').innerText()).includes('Is the checklist up to date?') && await phone.locator('#remind-fired time').count() === 1);
  await shot(phone, 'reminders-sheet-390');
  await phone.selectOption('#remind-kind', 'every');
  await phone.fill('#remind-value', '2h');
  await phone.fill('#remind-say', 'Does the checklist need updating?');
  await phone.locator('#remind-form button[type=submit]').tap();
  await phone.waitForFunction(() => document.querySelectorAll('#remind-list li strong').length === 2);
  check('phone: an added reminder shows in the list', (await phone.locator('#remind-list').innerText()).includes('Every 2h') && (await phone.locator('#remind-list').innerText()).includes('Does the checklist need updating?'));
  await phone.fill('#remind-value', 'soon'); await phone.fill('#remind-say', 'x');
  await phone.locator('#remind-form button[type=submit]').tap();
  await phone.waitForSelector('#remind-error:not([hidden])');
  check('phone: a bad time is refused with a message', (await phone.locator('#remind-error').innerText()).includes('A time is a number'));
  await shot(phone, 'reminders-sheet-added-390');
  const box = await phone.locator('#remind-dialog').boundingBox();
  check('phone: the sheet fits the screen (no sideways scroll, inside the viewport)', box.x >= 0 && box.x + box.width <= 390 && await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('#remind-dialog').scrollWidth <= document.querySelector('#remind-dialog').clientWidth));
  const small = await phone.locator('#remind-dialog button, #remind-dialog input[type=text], #remind-dialog select').evaluateAll(a => a.filter(x => x.offsetParent && x.getBoundingClientRect().height < 40).length);
  check('phone: every control in the sheet is tappable (at least 40 px)', small === 0);
  await phone.locator('#remind-default').uncheck();
  await phone.waitForTimeout(200);
  check('phone: the built-in reminder can be turned off for this thread', (await (await fetch(`http://127.0.0.1:${server.port}/__feedback/api/threads/${id}/reminders`)).json()).default.on === false);
  await phone.locator('#remind-list li button').first().tap();
  await phone.waitForFunction(() => document.querySelectorAll('#remind-list li strong').length === 1);
  await phone.locator('#remind-list li button').first().tap();
  await phone.waitForFunction(() => document.querySelectorAll('#remind-list li strong').length === 0);
  check('phone: Remove deletes it', true);
  await phone.locator('#remind-close').tap();
  check('phone: Close shuts the sheet', !(await phone.locator('#remind-dialog').evaluate(d => d.open)));

  await phone.goto(base + ro); await phone.waitForSelector('#msgs .msg'); await phone.waitForTimeout(300);
  await phone.locator('#more').tap();
  check('phone: a read-only thread still offers Reminders', (await phone.locator('#popmenu button').allInnerTexts()).includes('Reminders'));
  await phone.locator('#popmenu button', { hasText: 'Reminders' }).tap();
  await phone.waitForSelector('#remind-dialog[open]');
  await phone.fill('#remind-value', '1h'); await phone.selectOption('#remind-kind', 'idle'); await phone.fill('#remind-value', '1h'); await phone.fill('#remind-say', 'Anything new?');
  await phone.locator('#remind-form button[type=submit]').tap();
  await phone.waitForSelector('#remind-list li strong');
  check('phone: a read-only thread takes a reminder', (await phone.locator('#remind-list').innerText()).includes('After waiting 1h'));
  check('no page errors', errors.length === 0);

  const wide = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await wide.goto(base + id); await wide.waitForSelector('#msgs .msg');
  check('desktop: a Reminders button sits in the header', await wide.locator('#remind-open').isVisible());
  await wide.locator('#remind-open').click(); await wide.waitForSelector('#remind-dialog[open]');
  await shot(wide, 'reminders-sheet-1280');
} finally { await browser.close(); server.stop(true); }
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);
