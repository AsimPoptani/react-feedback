// Browser test for one-time secret links, at 390 and 1280: create a link, reveal it in a second browser, then a second open fails.
// Needs Playwright (PLAYWRIGHT=/path/to/playwright/index.mjs, or NODE_PATH). Run: bun e2e/rf-secrets.mjs
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'rf-secrets-e2e-'));
process.env.FEEDBACK_DIR = join(root, 'data');
delete process.env.FEEDBACK_PROJECT;
delete process.env.FEEDBACK_PROJECTS;
const store = await import('../server/store.ts');
const { serverOptions } = await import('../server/server.ts');
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');

const PLAIN = 'correct-horse-battery-staple';
const seen = [];
const options = serverOptions();
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0, maxRequestBodySize: options.maxRequestBodySize,
  async fetch(req, bunServer) {
    const body = req.method === 'POST' ? await req.clone().text().catch(() => '') : '';
    seen.push({ url: req.url, body });
    return options.fetch(req, bunServer);
  },
});
const base = `http://127.0.0.1:${server.port}`;
const { id } = await store.createThread(process.env.FEEDBACK_DIR, { title: 'Handover', text: 'Send the login separately', origin: 'user' });
await store.appendMessage(process.env.FEEDBACK_DIR, id, { author: 'agent', text: 'Ready when you are.', flag: 'fyi' });

const browser = await chromium.launch();
let failed = 0;
const check = (name, ok) => { console.log(ok ? 'ok  ' : 'FAIL', name); if (!ok) failed++; };
const noSideways = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

async function walk(width, mobile) {
  const desk = await browser.newContext({ viewport: { width, height: 800 }, ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
  const page = await desk.newPage();
  await page.goto(`${base}/__feedback/inbox/#/${id}`);
  await page.waitForSelector('#msgs .msg');
  if (mobile) {
    await page.locator('#more').click();
    await page.locator('#popmenu button', { hasText: 'Share a secret' }).click();
  } else {
    await page.locator('#secret-open').click();
  }
  await page.locator('#secret-dialog').waitFor({ state: 'visible' });
  await page.fill('#secret-text', PLAIN);
  await page.locator('#secret-create').click();
  await page.waitForFunction(() => { const node = document.querySelector('#secret-url'); return node && !node.hidden && node.value.includes('#'); });
  const link = await page.inputValue('#secret-url');
  check(`${width}: the link is this server, with the key only in the fragment`, link.startsWith(`${base}/__feedback/x/`) && link.includes('#') && !link.includes(PLAIN));
  check(`${width}: the note says to send it in a different channel`, (await page.locator('#secret-note').innerText()).includes('Anyone with this link can read it once') && (await page.locator('#secret-note').innerText()).includes('different channel'));
  check(`${width}: the dialog warns that a thread may be read by an agent`, (await page.locator('#secret-dialog').innerText()).includes('agent'));
  check(`${width}: no sideways scroll`, await noSideways(page));

  const other = await browser.newContext({ viewport: { width, height: 800 }, ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
  const recv = await other.newPage();
  const asked = [];
  recv.on('request', request => asked.push(request.url()));
  await recv.goto(link);
  await recv.waitForSelector('#reveal');
  check(`${width}: Reveal does not fetch before it is clicked`, asked.every(url => !url.includes('/open')));
  await recv.locator('#reveal').click();
  await recv.waitForSelector('#secret:not([hidden])');
  check(`${width}: the secret is revealed`, (await recv.locator('#secret').innerText()) === PLAIN);
  check(`${width}: the fragment is wiped`, new URL(recv.url()).hash === '');
  check(`${width}: the key was not on a request URL`, asked.every(url => !url.includes('#') && !url.includes(PLAIN)));
  await recv.locator('#copy').click();
  check(`${width}: Copy is offered`, (await recv.locator('#copy').innerText()).includes('Copied') || (await recv.locator('#copy').innerText()) === 'Copy');

  const third = await browser.newContext({ viewport: { width, height: 800 }, ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
  const again = await third.newPage();
  await again.goto(link);
  await again.locator('#reveal').click();
  await again.waitForSelector('#msg:not([hidden])');
  check(`${width}: a second open fails with the one message`, (await again.locator('#msg').innerText()).includes('This link has expired or was already used'));
  check(`${width}: the second page also wipes the fragment`, new URL(again.url()).hash === '');
  await desk.close(); await other.close(); await third.close();
}

try {
  await walk(1280, false);
  await walk(390, true);
  check('the plaintext never reached the server', seen.every(hit => !hit.url.includes(PLAIN) && !hit.body.includes(PLAIN) && !hit.url.includes('#')));
} finally {
  await browser.close();
  server.stop(true);
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
