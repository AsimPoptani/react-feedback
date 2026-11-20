// Browser test for 0.12.0 at 390 (a phone with touch) and 1280 wide: the full Feedback capture on a share link and in the owner's view, a live recording, and typing in a merged-away thread.
// Needs Playwright (PLAYWRIGHT=/path/to/playwright/index.mjs, or NODE_PATH). Run: bun e2e/rf0120.mjs   (SHOTS=/some/dir saves the screenshots there)
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'rf0120-e2e-'));
const data = join(root, 'data');
await mkdir(data);
process.env.FEEDBACK_DIR = data;
delete process.env.FEEDBACK_PROJECTS; delete process.env.FEEDBACK_PROJECT;
const SHOTS = process.env.SHOTS ?? join(root, 'shots');
await mkdir(SHOTS, { recursive: true });
const store = await import('../server/store.ts');
const artifacts = await import('../server/artifacts.ts');
const { serverOptions } = await import('../server/server.ts');
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');

const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Checkout page</title><style>body{font:16px system-ui;margin:0;padding:16px}button{min-height:44px;padding:8px 16px}</style></head><body>
<h1 id="title">Checkout page</h1><p>Review your order and pay.</p>
<button id="go">Pay now</button> <button id="stay">Back</button>
<p data-rf-private id="private">Private account number 4417 1234</p>
<div style="height:600px"></div><p id="end">The end</p>
</body></html>`;
const { id: thread } = await store.createThread(data, { title: 'Checkout page', text: 'Here is the page to review.', origin: 'user' });
const art = await artifacts.publishArtifact(data, { thread, title: 'Checkout page', content: PAGE, format: 'html' });
const sideThread = (await store.createThread(data, { title: 'Side thread', text: 'A side topic', origin: 'user' })).id;
const mainThread = (await store.createThread(data, { title: 'Main thread', text: 'The main topic', origin: 'user' })).id;

const server = Bun.serve({ ...serverOptions(), hostname: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch();
let failed = 0;
const check = (name, ok) => { console.log(ok ? 'ok  ' : 'FAIL', name); if (!ok) failed++; };
const post = (path, body) => fetch(`${origin}/__feedback/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const get = path => fetch(`${origin}/__feedback/api/${path}`).then(r => r.json());
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await new Promise(r => setTimeout(r, 250)); } };
const noSideways = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });

// A touch drag (a real touch pointer, not a mouse) through the browser's own input channel.
async function touchDrag(page, [x1, y1], [x2, y2]) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await touch('touchStart', x1, y1);
  for (let i = 1; i <= 8; i++) await touch('touchMove', x1 + ((x2 - x1) * i) / 8, y1 + ((y2 - y1) * i) / 8);
  await touch('touchEnd', x2, y2);
}
// The screenshot lands in the note a moment after it opens; if it never does, say what the note says instead.
async function preview(frame, page, name) {
  try { await frame.locator('.fb-preview').waitFor({ timeout: 25000 }); }
  catch (error) { await shot(page, `${name}-nopreview`); console.log('no preview:', await frame.locator('.fb-preview-pending').allInnerTexts()); throw error; }
}
async function tapAt(page, x, y, tap) { if (tap) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y); }
const box = async locator => { const b = await locator.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };

async function walk(width, tap) {
  const height = width < 600 ? 844 : 800;
  const tag = String(width);
  const opts = { viewport: { width, height }, hasTouch: tap, isMobile: tap };
  const act = tap ? 'tap' : 'click';
  const links = await post(`artifacts/${art.id}/share`, { expires: '7d' });
  const linkPath = links.url.replace(origin, '');

  // ---- 1. A share link: Feedback -> Region -> a note -> the thread shows the viewer's picture
  const viewerCtx = await browser.newContext(opts);
  const viewer = await viewerCtx.newPage();
  const errors = []; viewer.on('pageerror', e => errors.push(String(e)));
  await viewer.goto(`${origin}${linkPath}`);
  const frame = viewer.frameLocator('#art');
  await frame.locator('#go').waitFor();
  await viewer.locator('#fb-open')[act]();
  await viewer.waitForSelector('#fb-dialog[open]');
  await viewer.locator('#fb-capture:not([hidden])').waitFor();
  check(`${tag}: the share dialog offers Region, Element, Section and Full page once the page's capture script is ready`, (await viewer.locator('#fb-capture button').allInnerTexts()).join('|') === 'Region|Element|Section|Full page');
  check(`${tag}: no sideways scroll in the share page with the dialog open`, await noSideways(viewer));
  await shot(viewer, `share-dialog-${tag}`);
  await viewer.locator('[data-capture="region"]')[act]();
  await viewer.waitForSelector('#fb-dialog:not([open])', { state: 'attached' });
  check(`${tag}: the page's own Feedback button steps aside while capturing`, await viewer.locator('#fb-open').isHidden());
  await frame.locator('.fb-region').waitFor();
  const dragFrom = [30, 150], dragTo = [Math.min(width - 30, 320), 300]; // below the Cancel bar at the top left
  if (tap) await touchDrag(viewer, dragFrom, dragTo); else { await viewer.mouse.move(...dragFrom); await viewer.mouse.down(); await viewer.mouse.move(...dragTo, { steps: 8 }); await viewer.mouse.up(); }
  await frame.getByRole('button', { name: /Write note/ }).waitFor();
  await shot(viewer, `share-region-${tag}`);
  await frame.getByRole('button', { name: /Write note/ })[act]();
  const note = frame.getByRole('textbox', { name: 'Note' });
  await note.waitFor();
  await preview(frame, viewer, `share-${tag}`);
  await note.fill(`The heading and the intro are too close together (${tag})`);
  await shot(viewer, `share-note-${tag}`);
  await frame.getByRole('button', { name: 'Send' })[act]();
  const sent = await until(async () => (await get(`threads/${thread}`)).messages.find(m => m.author === 'viewer' && m.text.includes(`too close together (${tag})`)));
  check(`${tag}: the viewer's note arrives with a picture, flagged for you, as a region capture`, !!sent && sent.images.length === 1 && sent.flag === 'needs_you' && sent.quote?.mode === 'region' && Array.isArray(sent.quote.box));
  await viewer.waitForFunction(() => document.getElementById('fb-toast').textContent.startsWith('Thanks'));
  check(`${tag}: the page said thanks, and the Feedback button is back`, (await viewer.locator('#fb-toast').innerText()).startsWith('Thanks') && !(await viewer.locator('#fb-open').isHidden()));
  const image = await fetch(`${origin}/__feedback/api/items/${thread}/${sent.images[0]}`);
  const bytes = new Uint8Array(await image.arrayBuffer());
  check(`${tag}: the stored picture is a real PNG or JPEG`, image.ok && ((bytes[0] === 0x89 && bytes[1] === 0x50) || (bytes[0] === 0xff && bytes[1] === 0xd8)) && bytes.length > 500 && bytes.length <= 2 * 1024 * 1024);
  check(`${tag}: the picture comes from the artifact itself, not a blank frame (it is not tiny)`, bytes.length > 2000);

  // The picture shows in the thread, marked as the viewer's
  const owner = await (await browser.newContext(opts)).newPage();
  owner.on('pageerror', e => errors.push(String(e)));
  await owner.goto(`${origin}/__feedback/inbox/#/${thread}`);
  await owner.waitForSelector('#msgs .msg img');
  const viewerMsg = owner.locator('#msgs .msg', { hasText: `too close together (${tag})` });
  check(`${tag}: the thread shows the viewer's image under their note`, (await viewerMsg.locator('img').count()) === 1 && (await viewerMsg.innerText()).includes('Viewer feedback'));
  check(`${tag}: no sideways scroll in the thread`, await noSideways(owner));
  await shot(owner, `thread-viewer-image-${tag}`);

  // Private content gives no words, even when it is picked
  await viewer.locator('#fb-open')[act]();
  await viewer.locator('#fb-capture:not([hidden])').waitFor();
  await viewer.locator('[data-capture="element"]')[act]();
  await frame.locator('#private').waitFor();
  const p = await box(frame.locator('#private'));
  await tapAt(viewer, p.x, p.y, tap);
  await frame.getByRole('button', { name: /Write note/ }).waitFor();
  await frame.getByRole('button', { name: /Write note/ })[act]();
  await frame.getByRole('textbox', { name: 'Note' }).fill(`This part is private (${tag})`);
  await preview(frame, viewer, `share-${tag}`);
  await frame.getByRole('button', { name: 'Send' })[act]();
  const priv = await until(async () => (await get(`threads/${thread}`)).messages.find(m => m.author === 'viewer' && m.text.includes(`This part is private (${tag})`)));
  check(`${tag}: a data-rf-private element is captured with no text of its own`, !!priv && priv.quote?.mode === 'element' && priv.quote.text === '' && !JSON.stringify(priv).includes('4417'));
  await viewerCtx.close();

  // ---- 2. The owner's own view: Feedback -> Element -> a note -> the thread shows the user's picture
  await owner.goto(`${origin}/__feedback/inbox/#/artifact/${art.id}`);
  await owner.waitForSelector('#artifact-frame');
  const oframe = owner.frameLocator('#artifact-frame');
  await oframe.locator('#go').waitFor();
  await owner.locator('#artifact-capture:not([hidden])').waitFor();
  await owner.locator('#artifact-capture')[act]();
  await owner.locator('#cap-modes:not([hidden])').waitFor();
  check(`${tag}: no sideways scroll on the artifact page with the capture menu open`, await noSideways(owner));
  await shot(owner, `owner-menu-${tag}`);
  await owner.locator('#cap-modes [data-capture="element"]')[act]();
  await oframe.locator('.fb-pick-hint, .fb-highlight').first().waitFor().catch(() => {});
  const g = await box(oframe.locator('#go'));
  await tapAt(owner, g.x, g.y, tap);
  await oframe.getByRole('button', { name: /Write note/ }).waitFor();
  await shot(owner, `owner-element-${tag}`);
  await oframe.getByRole('button', { name: /Write note/ })[act]();
  await oframe.getByRole('textbox', { name: 'Note' }).fill(`Make the Pay now button stand out (${tag})`);
  await preview(oframe, owner, `owner-${tag}`);
  await oframe.getByRole('button', { name: 'Send' })[act]();
  const mine = await until(async () => (await get(`threads/${thread}`)).messages.find(m => m.author === 'user' && m.text.includes(`stand out (${tag})`)));
  check(`${tag}: the owner's capture is a message from you, with a picture, naming the artifact and the element`, !!mine && mine.images.length === 1 && mine.text.includes('Checkout page v1 · Element') && mine.text.includes('#go'));
  await owner.waitForFunction(() => document.getElementById('toast') && !document.getElementById('toast').hidden && document.getElementById('toast').textContent.startsWith('Sent to this artifact'));
  await shot(owner, `owner-sent-${tag}`);
  await owner.goto(`${origin}/__feedback/inbox/#/${thread}`);
  await owner.waitForSelector('#msgs .msg.user img');
  check(`${tag}: the thread shows the user's image`, (await owner.locator('#msgs .msg.user', { hasText: `stand out (${tag})` }).locator('img').count()) === 1);
  await shot(owner, `thread-user-image-${tag}`);

  // ---- 3. Typing in a merged-away thread
  const [s, m] = [await store.createThread(data, { title: `Side ${tag}`, text: 'Side', origin: 'user' }), await store.createThread(data, { title: `Main ${tag}`, text: 'Main', origin: 'user' })];
  await post(`threads/${s.id}/merge`, { into: m.id });
  await owner.goto(`${origin}/__feedback/inbox/#/${s.id}`);
  await owner.waitForSelector('#merged-note:not([hidden])');
  await owner.waitForFunction(name => document.getElementById('merged-note').textContent.includes(name), `Main ${tag}`); // the target's title arrives with the thread list
  check(`${tag}: a note above the composer says where a send goes`, (await owner.locator('#merged-note').innerText()).replace(/\s+/g, ' ') === `This thread was merged into Main ${tag}. What you send goes there. · Open`);
  check(`${tag}: the composer is open`, await owner.locator('#text').isEnabled() && await owner.locator('#send').isEnabled());
  await shot(owner, `merged-note-${tag}`);
  await owner.locator('#text').fill('Typed in the merged-away thread');
  await owner.locator('#send')[act]();
  await owner.waitForFunction(id => location.hash === `#/${id}`, m.id);
  check(`${tag}: it lands in the target (and the target opens)`, !!(await until(async () => (await get(`threads/${m.id}`)).messages.find(x => x.author === 'user' && x.text.includes('Typed in the merged-away thread')))));
  check(`${tag}: a toast names the target`, (await owner.locator('#toast').innerText()) === `Sent to Main ${tag}`);
  await shot(owner, `merged-sent-${tag}`);

  check(`${tag}: no page errors`, errors.length === 0);
  if (errors.length) console.log(errors);

  // ---- 4. Live: a recording that is still coming in
  const rec = await post(`artifacts/${art.id}/share`, { expires: '7d', record: true });
  const live = await (await browser.newContext(opts)).newPage();
  await live.goto(`${origin}${rec.url.replace(origin, '')}`);
  await live.frameLocator('#art').locator('#go').waitFor();
  let moving = true;
  const mover = (async () => { let n = 0; while (moving) { await live.mouse.move(40 + (n % 6) * 40, 120 + (n % 4) * 30).catch(() => {}); n++; await new Promise(r => setTimeout(r, 400)); } })();
  const watcher = await owner.context().newPage();
  const polls = [];
  watcher.on('request', r => { if (r.url().includes('?after=')) polls.push(r.url()); });
  await watcher.setViewportSize({ width, height });
  await watcher.goto(`${origin}/__feedback/inbox/#/artifact/${art.id}`);
  await watcher.locator('#tab-replays')[act]();
  const liveRow = watcher.locator('.replay-row', { has: watcher.locator('.live-tag') });
  await liveRow.first().waitFor({ timeout: 45000 }).catch(() => {});
  check(`${tag}: a session with a recent chunk shows Live and Watch live`, (await liveRow.count()) >= 1 && (await liveRow.first().locator('button').first().innerText()) === 'Watch live');
  check(`${tag}: no sideways scroll on the Replays tab`, await noSideways(watcher));
  await shot(watcher, `replays-live-${tag}`);
  await liveRow.first().locator('button', { hasText: 'Watch live' })[act]();
  await watcher.waitForSelector('#replay-dialog[open]');
  const player = watcher.frameLocator('#replay-frame');
  await player.locator('.rf-live-badge').waitFor({ timeout: 20000 });
  check(`${tag}: the player shows a LIVE badge`, (await player.locator('.rf-live-badge').innerText()) === 'LIVE');
  const seen = polls.length;
  await until(async () => polls.length >= seen + 2, 20000);
  check(`${tag}: the inbox polls with a cursor and feeds the player (the player makes no requests)`, polls.length >= seen + 2 && polls.every(u => /after=\d+/.test(u)));
  const inner = player.frameLocator('iframe').locator('body');
  const page = await until(async () => (await inner.innerText().catch(() => '')).includes('Checkout page'), 20000);
  check(`${tag}: the page being recorded is drawn in the live view`, !!page);
  await shot(watcher, `live-player-${tag}`);
  check(`${tag}: no sideways scroll with the player open`, await noSideways(watcher));
  await watcher.locator('#replay-close')[act]();
  const after = polls.length;
  await watcher.waitForTimeout(2500);
  check(`${tag}: closing the player stops the polling`, polls.length === after);
  moving = false; await mover;
}

try {
  await walk(390, true);
  await walk(1280, false);
} finally { await browser.close(); server.stop(true); }
console.log(`screenshots: ${SHOTS}`);
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log('all checks passed');
