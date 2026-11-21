// Browser test for 0.8.2: the version in the footer, and a banner when the server is newer. Reload must load the new shell.
// Needs Playwright (PLAYWRIGHT=/path/to/playwright/index.mjs). Run: bun e2e/rf9.mjs   (SHOTS=/some/dir also saves screenshots)
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'rf9-e2e-'));
process.env.FEEDBACK_DIR = join(root, 'data');
const SHOTS = process.env.SHOTS;
if (SHOTS) await mkdir(SHOTS, { recursive: true });
const store = await import('../server/store.ts');
const { serverOptions } = await import('../server/server.ts');
const { packageVersion } = await import('../server/version.ts');
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');

const VERSION = packageVersion(), NEXT = '9.9.9';
const { id } = await store.createThread(process.env.FEEDBACK_DIR, { title: 'Version check', text: 'Hello from the inbox', origin: 'user' });
let newer = false, shell = false;
const options = serverOptions();
const server = Bun.serve({ ...options, hostname: '127.0.0.1', port: 0, fetch: async req => {
  const url = new URL(req.url);
  if (newer && url.pathname === '/__feedback/api/config') {
    const body = await (await options.fetch(req)).json();
    return Response.json({ ...body, version: NEXT }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (shell && (url.pathname === '/__feedback/inbox/' || url.pathname === '/__feedback/inbox/index.html')) {
    let html = await (await options.fetch(req)).text();
    html = html.replaceAll(`content="${VERSION}"`, `content="${NEXT}"`).replaceAll(`react-feedback v${VERSION}`, `react-feedback v${NEXT}`).replace('<html', '<html data-shell="next"');
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
  if (shell && url.pathname === '/__feedback/inbox/sw.js') {
    const js = (await (await options.fetch(req)).text()).replaceAll(`fb-inbox-${VERSION}`, `fb-inbox-${NEXT}`);
    return new Response(js, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
  return options.fetch(req);
} });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch();
let failed = 0;
const check = (name, ok) => { console.log(ok ? 'ok  ' : 'FAIL', name); if (!ok) failed++; };
const shot = (page, name) => SHOTS ? page.screenshot({ path: join(SHOTS, `${name}.png`) }) : null;
const shotOf = (locator, name) => SHOTS ? locator.screenshot({ path: join(SHOTS, `${name}.png`) }) : null;

async function ready(page) {
  await page.waitForSelector('#app-version', { state: 'attached' });
  await page.evaluate(async () => { try { await navigator.serviceWorker?.ready; } catch { /* no worker in this browser */ } });
}
async function showBanner(page) {
  newer = true; shell = false;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForSelector('#update-banner:not([hidden])');
}

try {
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
  const errors = []; phone.on('pageerror', e => errors.push(String(e)));
  newer = false; shell = false;
  await phone.goto(`${origin}/__feedback/inbox/#/`);
  await ready(phone);
  check('phone: Tracker stays in the footer; the version text is kept for More', (await phone.locator('#app-version').textContent()) === `react-feedback v${VERSION}` && await phone.locator('#tracker-link').isVisible());
  await phone.locator('#foot-more').tap();
  check('phone: More shows the loaded version', (await phone.locator('#popmenu .ver').innerText()) === `react-feedback v${VERSION}`);
  await phone.keyboard.press('Escape');
  check('phone: no banner while the page matches the server', await phone.locator('#update-banner').isHidden());
  await shotOf(phone.locator('.me-panel'), 'footer-390');
  await phone.goto(`${origin}/__feedback/inbox/#/${id}`);
  await phone.waitForSelector('#msgs .msg');
  await showBanner(phone);
  check('phone: the banner names the new version', (await phone.locator('#update-text').innerText()) === `A new version (v${NEXT}) is ready. Reload to update`);
  check('phone: the banner fits without sideways scroll', await phone.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  const gap = await phone.evaluate(() => {
    const b = document.getElementById('update-banner').getBoundingClientRect();
    const c = document.getElementById('composer').getBoundingClientRect();
    return { banner: b.width <= document.documentElement.clientWidth && b.bottom <= c.top + 1, composer: c.height > 0 && c.bottom <= innerHeight + 1 };
  });
  check('phone: the banner stays above the composer', gap.banner && gap.composer);
  await shot(phone, 'banner-390');
  await phone.locator('#more').tap();
  await phone.waitForSelector('#popmenu .ver');
  check('phone: the ⋯ menu footer shows the loaded version', (await phone.locator('#popmenu .ver').innerText()) === `react-feedback v${VERSION}`);
  await shotOf(phone.locator('#popmenu'), 'menu-390');
  shell = true;
  await phone.locator('#update-reload').tap();
  await phone.waitForSelector('html[data-shell="next"]');
  await phone.waitForFunction(version => document.getElementById('app-version')?.textContent === `react-feedback v${version}`, NEXT);
  check('phone: Reload loads the new shell', await phone.locator('html').getAttribute('data-shell') === 'next');
  check('phone: the new shell shows its own version and drops the banner', (await phone.locator('#app-version').textContent()) === `react-feedback v${NEXT}` && await phone.locator('#update-banner').isHidden());
  await phone.goto(`${origin}/__feedback/inbox/#/`);
  await phone.waitForSelector('#foot-more', { state: 'visible' });
  check('phone: the reloaded footer shows the new version', (await phone.locator('#app-version').textContent()) === `react-feedback v${NEXT}`);
  check('no page errors', errors.length === 0);

  const wide = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  newer = false; shell = false;
  await wide.goto(`${origin}/__feedback/inbox/#/${id}`);
  await wide.waitForSelector('#msgs .msg');
  await ready(wide);
  check('desktop: the footer shows the loaded version next to Tracker', (await wide.locator('#app-version').innerText()) === `react-feedback v${VERSION}` && await wide.evaluate(() => !!document.getElementById('app-version').parentElement.querySelector('#tracker-link')));
  await showBanner(wide);
  check('desktop: the banner names the new version', (await wide.locator('#update-text').innerText()).includes(`v${NEXT}`));
  check('desktop: the banner stays above the composer', await wide.evaluate(() => {
    const b = document.getElementById('update-banner').getBoundingClientRect();
    const c = document.getElementById('composer').getBoundingClientRect();
    return b.bottom <= c.top + 1 && document.documentElement.scrollWidth <= document.documentElement.clientWidth;
  }));
  await shot(wide, 'banner-1280');
  await shotOf(wide.locator('.me-panel'), 'footer-1280');
  shell = true;
  await wide.locator('#update-reload').click();
  await wide.waitForSelector('html[data-shell="next"]');
  await wide.waitForFunction(version => document.getElementById('app-version')?.textContent === `react-feedback v${version}`, NEXT);
  await wide.waitForSelector('#msgs .msg');
  check('desktop: Reload loads the new shell', (await wide.locator('#app-version').textContent()) === `react-feedback v${NEXT}` && await wide.locator('#update-banner').isHidden() && await wide.locator('html').getAttribute('data-shell') === 'next');
} finally { await browser.close(); server.stop(true); }
console.log(failed ? `${failed} FAILED` : 'all ok');
if (SHOTS) console.log('shots', SHOTS);
process.exit(failed ? 1 : 0);
