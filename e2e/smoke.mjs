// Browser smoke test for the inbox checklist panel and the draggable launcher. Needs Playwright (`bun add -d playwright` or PLAYWRIGHT=/path/to/playwright/index.mjs) and a built dist/ (`bun run build`).
// Run: bun e2e/smoke.mjs
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FEEDBACK_DIR = await mkdtemp(join(tmpdir(), 'rf-e2e-'));
const store = await import('../server/store.ts');
const { serverOptions } = await import('../server/server.ts');
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');

const { id } = await store.createThread(process.env.FEEDBACK_DIR, { title: 'Smoke thread', text: 'Hello', origin: 'user' });
await store.appendMessage(process.env.FEEDBACK_DIR, id, { author: 'agent', text: 'Hi there', flag: 'fyi' });
const items = [];
for (const [owner, text] of [['user', 'Retry the run'], ['agent', 'Run the flow'], ['agent', 'Check the map'], ['agent', 'Write it up']]) items.push(await store.addChecklistItem(process.env.FEEDBACK_DIR, id, { owner, text, by: owner }));
await store.patchChecklistItem(process.env.FEEDBACK_DIR, id, items[1].id, { done: true }, 'agent');
const server = Bun.serve({ ...serverOptions(), hostname: '127.0.0.1', port: 0 });
const url = `http://127.0.0.1:${server.port}/__feedback/inbox/#/${id}`;
const browser = await chromium.launch();
let failed = 0;
const check = (name, ok) => { console.log(ok ? 'ok  ' : 'FAIL', name); if (!ok) failed++; };
try {
  const wide = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await wide.goto(url); await wide.waitForSelector('#msgs .msg');
  check('wide: panel open beside the messages', await wide.locator('#checklist').isVisible() && !(await wide.locator('#cl-btn').isVisible()));
  const [panel, composer] = await Promise.all([wide.locator('#checklist').boundingBox(), wide.locator('#composer').boundingBox()]);
  check('wide: composer is left of the panel', composer.x + composer.width <= panel.x + 1);
  await wide.keyboard.press('l');
  check('wide: L hides it, the slim tab shows', !(await wide.locator('#checklist').isVisible()) && await wide.locator('#cl-tab').isVisible());
  await wide.reload(); await wide.waitForSelector('#msgs .msg');
  check('wide: hidden state is remembered', !(await wide.locator('#checklist').isVisible()));
  await wide.locator('#cl-tab').click();
  check('wide: the tab reopens it', await wide.locator('#checklist').isVisible());
  const launcher = wide.locator('.fb-launcher'), before = await launcher.boundingBox();
  await wide.mouse.move(before.x + 20, before.y + 10); await wide.mouse.down(); await wide.mouse.move(before.x + 20, before.y - 200, { steps: 8 }); await wide.mouse.up();
  const after = await launcher.boundingBox();
  check('wide: the launcher dragged up and did not open', after.y < before.y - 100 && (await launcher.getAttribute('aria-expanded')) === 'false');

  const narrow = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
  await narrow.goto(url); await narrow.waitForSelector('#msgs .msg');
  check('narrow: a Checklist button, no column', await narrow.locator('#cl-btn').isVisible() && !(await narrow.locator('#checklist').isVisible()));
  await narrow.locator('#cl-btn').click();
  check('narrow: the sheet opens as a dialog', await narrow.locator('#checklist[role=dialog]').isVisible());
  await narrow.keyboard.press('Escape');
  check('narrow: Esc closes it and focus returns to the button', !(await narrow.locator('#checklist').isVisible()) && await narrow.evaluate(() => document.activeElement?.id === 'cl-btn'));
} finally { await browser.close(); server.stop(true); }
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
