// Browser test for "continue on your phone": a desktop inbox shows a QR code, a phone opens the link, pairs, lands on the thread, the devices page lists it, and a revoke shuts it out.
// Needs Playwright (PLAYWRIGHT=/path/to/playwright/index.mjs, or NODE_PATH). Run: bun e2e/rfqr.mjs   (SHOTS=/some/dir saves the screenshots there)
// Two real listeners on 127.0.0.1: the ordinary one (the desktop) and the remote one (the phone). No tunnel is started.
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'rfqr-e2e-'));
const dir = join(root, 'data');
await mkdir(dir);
delete process.env.FEEDBACK_PROJECT; delete process.env.FEEDBACK_PROJECTS;
process.env.FEEDBACK_DIR = dir;
const SHOTS = process.env.SHOTS ?? join(root, 'shots');
await mkdir(SHOTS, { recursive: true });
const store = await import('../server/store.ts');
const { serverOptions } = await import('../server/server.ts');
const { pairingFor } = await import('../server/pair.ts');
const { createRemoteHandler } = await import('../server/remote.ts');
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');

const options = serverOptions();
const localServer = Bun.serve({ ...options, hostname: '127.0.0.1', port: 0 });
const local = `http://127.0.0.1:${localServer.port}`;
// Every request the remote listener sees, as the server saw it: the request line, the referrer and the cookie header. This is what a proxy or a log would hold.
const seen = [];
let publicUrl = null;
const pairing = pairingFor(dir);
const inner = createRemoteHandler(options.fetch, pairing, { publicUrl: () => publicUrl });
const remoteServer = Bun.serve({ hostname: '127.0.0.1', port: 0, maxRequestBodySize: options.maxRequestBodySize, async fetch(req, server) {
  const body = req.method === 'POST' ? await req.clone().text().catch(() => '') : '';
  seen.push({ method: req.method, url: req.url, referer: req.headers.get('referer') ?? '', cookie: req.headers.get('cookie') ?? '', body });
  return inner(req, server);
} });
const remote = `http://127.0.0.1:${remoteServer.port}`;
publicUrl = remote;
pairing.remote = { on: true, publicUrl: remote, source: 'env' };

const talk = (await store.createThread(dir, { title: 'Cache plan', text: 'How does the cache get rebuilt?', origin: 'user' })).id;
await store.appendMessage(dir, talk, { author: 'agent', text: 'The cache is rebuilt nightly and on every deploy. A manual rebuild is possible from the admin page.', flag: 'fyi' });
const other = (await store.createThread(dir, { title: 'Release notes', text: 'Draft the notes for Friday', origin: 'user' })).id;

const browser = await chromium.launch();
let failed = 0;
const check = (name, ok) => { console.log(ok ? 'ok  ' : 'FAIL', name); if (!ok) failed++; };
const noSideways = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const inside = (page, selector) => page.locator(selector).evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight + 1; });

try {
  // ---- 1. The desktop inbox (1280): Open on phone, in the footer and in the thread header
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await desktop.newPage();
  await page.goto(`${local}/__feedback/inbox/#/${talk}`);
  await page.waitForSelector('#msgs .msg');
  check('1280: Open on phone is in the sidebar footer', await page.locator('.foot-links #phone-link').isVisible());
  check('1280: and in the thread header', await page.locator('#phone-open').isVisible());
  await page.locator('#phone-open').click();
  await page.waitForSelector('dialog.pair svg path');
  const link = await page.inputValue('dialog.pair input');
  const code = /#\/pair\/([\w-]{22})/.exec(link)?.[1] ?? '';
  check('1280: a QR code is drawn', (await page.locator('dialog.pair svg path').getAttribute('d')).length > 500);
  check('1280: the link is the public address with the code in the fragment and the thread to open', link === `${remote}/__feedback/inbox/#/pair/${code}?to=${talk}`);
  check('1280: the countdown runs', /^[45]:\d\d$/.test(await page.locator('dialog.pair .count').innerText()));
  check('1280: the dialog fits, with no sideways scroll', (await inside(page, 'dialog.pair')) && (await noSideways(page)));
  await page.screenshot({ path: join(SHOTS, 'open-on-phone-1280.png') });

  // ---- 2. The phone (390) opens the link
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, userAgent: IPHONE });
  const mobile = await phone.newPage();
  await mobile.goto(link);
  await mobile.waitForSelector('#msgs .msg', { timeout: 15000 });
  check('390: paired, and landed on the thread', (await mobile.locator('#title').innerText()) === 'Cache plan' && new URL(mobile.url()).hash === `#/${talk}`);
  check('390: the fragment with the code is gone from the address', !mobile.url().includes(code) && !mobile.url().includes('pair'));
  const cookies = await phone.cookies();
  const device = cookies.find(c => c.name === 'rf_device');
  check('390: the device cookie is HttpOnly, Secure, SameSite=Strict, path /__feedback/', !!device && device.httpOnly && device.secure && device.sameSite === 'Strict' && device.path === '/__feedback/');
  check('390: scripts cannot read it', !(await mobile.evaluate(() => document.cookie)).includes('rf_device'));
  check('390: no sideways scroll', await noSideways(mobile));
  await mobile.screenshot({ path: join(SHOTS, 'phone-thread-390.png') });

  // The fragment never reached the server: not in any request line, referrer or cookie. The code was sent once, in the body of the exchange.
  const leaked = seen.filter(r => r.url.includes(code) || r.referer.includes(code) || r.cookie.includes(code) || r.url.includes('#'));
  check('the code is in no request URL, referrer or cookie the server saw', leaked.length === 0);
  const exchanges = seen.filter(r => r.url.endsWith('/__feedback/api/pair/exchange'));
  check('the code was sent exactly once, in the body of the exchange', exchanges.length === 1 && exchanges[0].body.includes(code) && seen.filter(r => r.body.includes(code)).length === 1);
  check('the pairing page asked for the exchange before any inbox file', seen.findIndex(r => r.url.endsWith('/inbox/app.js')) > seen.findIndex(r => r.url.endsWith('/pair/exchange')));

  // ---- 3. The desktop is told, and lists the device
  await page.waitForSelector('dialog.pair .done', { timeout: 10000 });
  check('1280: the desktop box says the phone paired', (await page.locator('dialog.pair .done').innerText()).includes('iPhone · Safari'));
  await page.screenshot({ path: join(SHOTS, 'paired-1280.png') });
  await page.locator('dialog.pair button', { hasText: 'Paired devices' }).click();
  await page.waitForSelector('.pair-page li');
  check('1280: the devices page lists name, paired and last seen', /iPhone · Safari[\s\S]*Paired[\s\S]*Last seen/.test(await page.locator('.pair-page li').first().innerText()));
  check('1280: no sideways scroll on the devices page', await noSideways(page));
  await page.screenshot({ path: join(SHOTS, 'devices-1280.png') });
  await page.keyboard.press('Escape');

  // ---- 4. The same link cannot be used twice
  const second = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const again = await second.newPage();
  await again.goto(link);
  await again.waitForSelector('#h:has-text("Could not pair")');
  check('390: a used link says so, in one generic line', (await again.locator('#msg').innerText()).includes('expired or was already used'));
  check('390: and the fragment was wiped from the address', !again.url().includes(code));
  check('390: it got no cookie', (await second.cookies()).length === 0);
  await again.screenshot({ path: join(SHOTS, 'link-used-390.png') });
  const direct = await again.evaluate(async origin => (await fetch(`${origin}/__feedback/api/threads`)).status, remote);
  check('390: an unpaired browser is refused by the remote listener', direct === 401);
  await second.close();

  // ---- 5. The phone can work: send a reply, and open the devices page
  await mobile.fill('#text', 'Sent from my phone');
  await mobile.locator('#send').tap();
  await mobile.waitForSelector('#msgs .msg.user >> text=Sent from my phone');
  check('390: a reply from the phone is stored', (await store.summarise(dir, talk)).messages.some(m => m.text === 'Sent from my phone'));
  await mobile.screenshot({ path: join(SHOTS, 'phone-reply-390.png') });
  await mobile.goto('about:blank');
  await mobile.goto(`${remote}/__feedback/inbox/#/`);
  await mobile.waitForSelector('#foot-more');
  const refusedCode = await mobile.evaluate(async () => (await fetch(new URL('../api/pair/codes', location.href), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
  check('390: a paired phone cannot make a code', refusedCode === 403);
  check('390: Open on phone is not in the footer', (await mobile.getByRole('button', { name: 'Open on phone' }).count()) === 0);
  await mobile.locator('#foot-more').tap();
  check('390: More opens Paired devices and not Open on phone', (await mobile.locator('#popmenu').innerText()).includes('Paired devices') && !(await mobile.locator('#popmenu').innerText()).includes('Open on phone') && (await noSideways(mobile)));
  await mobile.screenshot({ path: join(SHOTS, 'open-on-phone-390.png') });
  await mobile.locator('#popmenu button', { hasText: 'Paired devices' }).tap();
  await mobile.waitForSelector('.pair-page li');
  check('390: the phone sees its own device, marked', (await mobile.locator('.pair-page li').first().innerText()).includes('This device'));
  check('390: the devices page fits the phone', await noSideways(mobile));
  await mobile.screenshot({ path: join(SHOTS, 'devices-390.png') });
  await mobile.locator('.pair-page header button', { hasText: 'Back' }).tap();

  // ---- 6. Cross-origin writes are refused by the remote listener, even with the cookie
  const forged = await fetch(`${remote}/__feedback/api/threads`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Cookie: `rf_device=${device.value}` }, body: JSON.stringify({ title: 'x', text: 'y' }) });
  check('a forged cross-origin POST with a valid cookie is refused', forged.status === 403);

  // ---- 7. Revoke on the desktop: the phone is refused at once
  await page.locator('#phone-link').click();
  await page.locator('dialog.pair button', { hasText: 'Paired devices' }).click();
  await page.waitForSelector('.pair-page li');
  const before = await page.locator('.pair-page li').count();
  await page.locator('.pair-page li button', { hasText: 'Revoke' }).first().click();
  await page.waitForSelector('.pair-page li', { state: 'detached' });
  check('1280: revoking removes the device from the list', before === 1 && (await page.locator('.pair-page li').count()) === 0);
  await page.screenshot({ path: join(SHOTS, 'revoked-1280.png') });
  const refused = await mobile.evaluate(async origin => (await fetch(`${origin}/__feedback/api/threads`)).status, remote);
  check('390: the phone is refused immediately', refused === 401);
  await mobile.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await mobile.waitForSelector('.pair-banner');
  check('390: the phone says it is no longer paired', (await mobile.locator('.pair-banner').innerText()).includes('no longer paired'));
  await mobile.screenshot({ path: join(SHOTS, 'phone-revoked-390.png') });
  await mobile.goto('about:blank');
  await mobile.goto(`${remote}/__feedback/inbox/#/${talk}`);
  await mobile.waitForSelector('#h:has-text("private")');
  check('390: opening the inbox again shows the pairing page, not the inbox', (await mobile.locator('#msg').innerText()).includes('QR code') && (await mobile.locator('#groups').count()) === 0);
  await mobile.screenshot({ path: join(SHOTS, 'phone-private-390.png') });
  const stored = JSON.parse(await readFile(join(dir, '_devices.json'), 'utf8'));
  check('the device file is empty after the revoke', stored.devices.length === 0);

  // ---- 8. The ordinary listener is as it was
  check('the local listener needs no device', (await fetch(`${local}/__feedback/api/threads`)).status === 200 && (await fetch(`${local}/__feedback/inbox/`)).status === 200);

  // ---- 9. A new pairing opens a different thread, then Revoke all
  const codeAgain = await (await fetch(`${local}/__feedback/api/pair/codes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const third = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p3 = await third.newPage();
  await p3.goto(`${remote}/__feedback/inbox/#/pair/${codeAgain.code}?to=${other}`);
  await p3.waitForSelector('#msgs .msg');
  check('390: a second pairing opens the thread named in the link', (await p3.locator('#title').innerText()) === 'Release notes');
  await page.reload();
  await page.waitForSelector('#phone-link');
  await page.locator('#phone-link').click();
  await page.locator('dialog.pair button', { hasText: 'Paired devices' }).click();
  await page.waitForSelector('.pair-page li');
  const all = page.locator('.pair-page header button', { hasText: 'Revoke all' });
  await all.click(); await all.click();
  await page.waitForSelector('.pair-page li', { state: 'detached' });
  check('1280: Revoke all empties the list', (await page.locator('.pair-page li').count()) === 0);
  check('390: and that phone is refused too', (await p3.evaluate(async origin => (await fetch(`${origin}/__feedback/api/threads`)).status, remote)) === 401);
  await third.close();
  await phone.close(); await desktop.close();
} finally { await browser.close(); localServer.stop(true); remoteServer.stop(true); }
console.log(`screenshots: ${SHOTS}`);
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log('all checks passed');
