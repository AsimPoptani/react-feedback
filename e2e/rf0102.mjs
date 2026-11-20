// Browser test for 0.10.2: the open thread's title keeps a real width and at most two lines at every width, even with a long title and every header button.
// Needs Playwright (PLAYWRIGHT=/path/to/playwright/index.mjs). Run: bun e2e/rf0102.mjs   (SHOTS=/some/dir saves the screenshots there)
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'rf0102-e2e-'));
const dirs = ['alpha', 'beta'].map(name => join(root, name));
delete process.env.FEEDBACK_PROJECT;
process.env.FEEDBACK_DIR = dirs[0];
process.env.FEEDBACK_PROJECTS = JSON.stringify([{ id: 'alpha', name: 'Alpha', dir: dirs[0] }, { id: 'beta', name: 'Beta', dir: dirs[1] }]);
const SHOTS = process.env.SHOTS ?? join(root, 'shots');
await mkdir(SHOTS, { recursive: true });
const store = await import('../server/store.ts');
const { serverOptions } = await import('../server/server.ts');
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
const longTitle = 'Checkout page copy review with a very long title that keeps going well past two lines so the clamp has to cut it off with an ellipsis';
const { id } = await store.createThread(dirs[0], { title: longTitle, text: 'Hello', origin: 'user' });
await store.appendMessage(dirs[0], id, { author: 'agent', text: 'Hi there', flag: 'fyi' });
const items = [];
for (const text of ['One', 'Two', 'Three', 'Four']) items.push(await store.addChecklistItem(dirs[0], id, { owner: 'agent', text, by: 'agent' }));
await store.patchChecklistItem(dirs[0], id, items[0].id, { done: true }, 'agent');
const server = Bun.serve({ ...serverOptions(), hostname: '127.0.0.1', port: 0 });
const url = `http://127.0.0.1:${server.port}/__feedback/inbox/#/${id}`;
const browser = await chromium.launch();
let failed = 0;
const check = (name, ok) => { console.log(ok ? 'ok  ' : 'FAIL', name); if (!ok) failed++; };
try {
  for (const width of [390, 600, 700, 865, 1024, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForSelector('#msgs .msg');
    await page.waitForSelector('#cl-btn:not([hidden]), #checklist');
    await page.screenshot({ path: join(SHOTS, `thread-head-${width}.png`) });
    const m = await page.evaluate(() => {
      const t = document.getElementById('title'); const r = t.getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(t).lineHeight) || parseFloat(getComputedStyle(t).fontSize) * 1.3;
      return { width: r.width, height: r.height, lh, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
    });
    console.log(`     ${width}: title ${Math.round(m.width)} x ${Math.round(m.height)} (line ${m.lh.toFixed(1)})`);
    check(`${width}: the title is at least 240 px wide`, m.width >= 240 || (width < 760 && m.width >= 140));
    check(`${width}: the title is at most two lines`, m.height <= m.lh * 2 + 2);
    check(`${width}: no sideways scroll`, m.sw <= m.cw);
    if (width >= 760) {
      const ok = await page.evaluate(() => { const t = document.getElementById('title').getBoundingClientRect(); return [...document.querySelectorAll('#open > .thread-head button')].filter(b => b.offsetParent).every(b => { const r = b.getBoundingClientRect(); return r.right <= window.innerWidth + 1 && r.left >= 0 && (r.top >= t.bottom - 1 || r.left >= t.right - 1 || r.bottom <= t.top + 1); }); });
      check(`${width}: the header buttons are on screen and do not overlap the title`, ok);
    }
    await context.close();
  }
  // The sidebar rail: collapsed and expanded at 865 and 1280, with the title still sensible in both.
  for (const width of [865, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForSelector('#msgs .msg');
    const listW = () => page.evaluate(() => document.querySelector('.list').getBoundingClientRect().width);
    const titleBox = () => page.evaluate(() => { const r = document.getElementById('title').getBoundingClientRect(); return { w: r.width, h: r.height }; });
    const open = await listW(), openTitle = await titleBox();
    await page.screenshot({ path: join(SHOTS, `sidebar-expanded-${width}.png`) });
    await page.click('#side-toggle');
    const rail = await listW(), railTitle = await titleBox();
    await page.screenshot({ path: join(SHOTS, `sidebar-collapsed-${width}.png`) });
    check(`${width}: the sidebar collapses to a rail of 48-56 px`, rail >= 48 && rail <= 57 && open > 250);
    check(`${width}: the thread pane takes the freed width`, railTitle.w >= openTitle.w);
    check(`${width}: the title keeps 240 px and two lines when collapsed`, railTitle.w >= 240 && railTitle.h <= 50);
    check(`${width}: the rail shows the badge, New thread and the expand button`, await page.locator('#project-badge').isVisible() && await page.locator('#new-thread').isVisible() && await page.locator('#side-toggle').isVisible() && !(await page.locator('#search').isVisible()));
    check(`${width}: the project menu opens from the rail`, await (async () => { await page.click('#project-button'); await page.waitForSelector('#project-menu:not([hidden])'); const ok = await page.locator('#project-menu').isVisible(); await page.screenshot({ path: join(SHOTS, `sidebar-collapsed-menu-${width}.png`) }); await page.keyboard.press('Escape'); return ok; })());
    await page.reload(); await page.waitForSelector('#msgs .msg');
    check(`${width}: it is remembered across a reload`, (await listW()) <= 57);
    await page.locator('body').click({ position: { x: 700, y: 400 } });
    await page.keyboard.press('[');
    check(`${width}: [ expands it again`, (await listW()) > 250 && (await titleBox()).w >= 240);
    check(`${width}: no sideways scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    await context.close();
  }
  // A phone does not get the control.
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForSelector('#msgs .msg');
    check('390: the sidebar control is not shown', !(await page.locator('#side-toggle').isVisible()));
    await context.close();
  }
} finally { await browser.close(); server.stop(true); }
console.log(`screenshots: ${SHOTS}`);
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log('all checks passed');
