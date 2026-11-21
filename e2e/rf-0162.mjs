// Phone footer for 0.16.2: one short row, the thread list keeps the screen, More holds what moved, desktop stays as it was.
// Needs Playwright (PLAYWRIGHT=/path/to/playwright/index.mjs, or NODE_PATH). Run: bun e2e/rf-0162.mjs
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'rf0162-e2e-'));
process.env.FEEDBACK_DIR = join(root, 'data');
const SHOTS = join(import.meta.dir, '..', '..', 'rf25-shots');
await mkdir(SHOTS, { recursive: true });
const store = await import('../server/store.ts');
const { serverOptions } = await import('../server/server.ts');
const { packageVersion } = await import('../server/version.ts');
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');

const VERSION = packageVersion();
const dir = process.env.FEEDBACK_DIR;
for (const title of ['Shelf notes', 'Ops checklist', 'Field questions', 'Release draft', 'Cache plan']) {
  await store.createThread(dir, { title, text: 'A note for the list.', origin: 'user' });
}
const options = serverOptions();
const server = Bun.serve({ ...options, hostname: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch();
let failed = 0;
const check = (name, ok) => { console.log(ok ? 'ok  ' : 'FAIL', name); if (!ok) failed++; };
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1';

try {
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, userAgent: PHONE_UA })).newPage();
  const errors = [];
  phone.on('pageerror', error => errors.push(String(error)));
  await phone.goto(`${origin}/__feedback/inbox/#/`);
  await phone.waitForSelector('#groups .group, #list-empty');
  await phone.waitForSelector('#foot-more');
  const layout = await phone.evaluate(() => {
    const panel = document.querySelector('.me-panel').getBoundingClientRect();
    const list = document.getElementById('groups').getBoundingClientRect();
    const chips = ['artifacts-link', 'tracker-link', 'metrics-link'].map(id => document.getElementById(id).getBoundingClientRect());
    const me = document.getElementById('me').getBoundingClientRect();
    const more = document.getElementById('foot-more').getBoundingClientRect();
    const row = document.querySelector('.foot-links');
    return {
      panel: panel.height,
      list: list.height / innerHeight,
      sideways: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      chipsOneRow: Math.max(...chips.map(r => r.top)) - Math.min(...chips.map(r => r.top)) < 2,
      avatarFirst: me.right <= chips[0].left + 1 && more.left + 1 >= chips[chips.length - 1].left && row.getBoundingClientRect().width <= panel.width,
    };
  });
  check('390: the bottom panel is at most 64px', layout.panel <= 64);
  check('390: the thread list is at least 60% of the viewport', layout.list >= 0.6);
  check('390: no Open on phone', (await phone.getByRole('button', { name: 'Open on phone' }).count()) === 0);
  check('390: Artifacts, Tracker and Metrics are one row', layout.chipsOneRow && layout.avatarFirst);
  check('390: no sideways scroll on the page', layout.sideways);
  await phone.screenshot({ path: join(SHOTS, 'list-390.png') });
  await phone.locator('.me-panel').screenshot({ path: join(SHOTS, 'footer-390.png') });

  await phone.evaluate(() => { document.getElementById('rec-dot').hidden = false; });
  const recording = await phone.evaluate(() => {
    const panel = document.querySelector('.me-panel').getBoundingClientRect();
    const dot = document.getElementById('rec-dot').getBoundingClientRect();
    return panel.height <= 64 && dot.height > 0 && dot.top >= panel.top - 1 && dot.bottom <= panel.bottom + 1 && dot.left >= panel.left && dot.right <= panel.right + 1;
  });
  check('390: Recording sits inside the row', recording);
  check('390: the chips stay visible while Recording shows', await phone.locator('#artifacts-link').isVisible() && await phone.locator('#tracker-link').isVisible() && await phone.locator('#metrics-link').isVisible());
  await phone.locator('.me-panel').screenshot({ path: join(SHOTS, 'footer-recording-390.png') });
  await phone.evaluate(() => { document.getElementById('rec-dot').hidden = true; });

  await phone.locator('#foot-more').tap();
  await phone.waitForSelector('#popmenu:not([hidden])');
  const menu = await phone.locator('#popmenu').innerText();
  check('390: More contains Secret links and the version', menu.includes('Secret links') && menu.includes(`react-feedback v${VERSION}`));
  check('390: More does not contain Open on phone', !menu.includes('Open on phone'));
  check('390: the menu does not scroll the page sideways', await phone.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  await phone.locator('#popmenu').screenshot({ path: join(SHOTS, 'more-390.png') });
  await phone.keyboard.press('Escape');

  await phone.locator('#me').tap();
  await phone.waitForSelector('#profile-dialog[open]');
  check('390: the avatar opens the profile', await phone.locator('#profile-name').isVisible());
  check('390: the profile dialog does not scroll the page sideways', await phone.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  await phone.screenshot({ path: join(SHOTS, 'profile-390.png') });
  check('390: no page errors', errors.length === 0);

  const wide = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await wide.goto(`${origin}/__feedback/inbox/#/`);
  await wide.waitForSelector('#phone-link');
  check('1280: Open on phone is in the footer', await wide.locator('#phone-link').isVisible());
  check('1280: Secret links and the version stay in the footer', await wide.locator('#secret-links').isVisible() && await wide.locator('#app-version').isVisible());
  check('1280: More is not in the footer', !(await wide.locator('#foot-more').isVisible()));
  check('1280: the profile card still says Edit profile', (await wide.locator('#me').innerText()).includes('Edit profile'));
  await wide.locator('.me-panel').screenshot({ path: join(SHOTS, 'footer-1280.png') });
} finally { await browser.close(); server.stop(true); }
console.log(failed ? `${failed} FAILED` : 'all ok');
console.log('shots', SHOTS);
process.exit(failed ? 1 : 0);
