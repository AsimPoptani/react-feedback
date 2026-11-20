// Browser test for 0.10: feedback on a shared page, session replay (opt-in per link, notice and opt-out), the Replays tab, the heatmap, and the inbox recording itself.
// Needs Playwright (PLAYWRIGHT=/path/to/playwright/index.mjs). Run: bun e2e/rf0100.mjs   (SHOTS=/some/dir also saves screenshots)
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'rf0100-e2e-'));
const data = join(root, 'data');
process.env.FEEDBACK_DIR = data;
delete process.env.FEEDBACK_PROJECTS;
delete process.env.FEEDBACK_PROJECT;
const SHOTS = process.env.SHOTS ?? join(root, 'shots');
await mkdir(SHOTS, { recursive: true });
const store = await import('../server/store.ts');
const artifacts = await import('../server/artifacts.ts');
const { serverOptions } = await import('../server/server.ts');
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');

const PAGE = `<!doctype html><html><head><title>Options</title><style>body{font:16px system-ui;margin:0;padding:16px}button{min-height:44px;padding:8px 16px}</style></head><body>
<h1>Options for review</h1><p>Pick the option you like.</p>
<button id="go">Go</button> <button id="stay">Stay</button>
<p><label>Your email <input id="email" type="text"></label></p>
<p data-rf-private id="private">Private account number 4417 1234</p>
<div style="height:900px"></div><p id="end">The end</p>
</body></html>`;
const { id: thread } = await store.createThread(data, { title: 'Options for review', text: 'Three ways to ship this.', origin: 'user' });
const art = await artifacts.publishArtifact(data, { thread, title: 'Options for review', content: PAGE, format: 'html' });

const server = Bun.serve({ ...serverOptions(), hostname: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch();
let failed = 0;
const check = (name, ok) => { console.log(ok ? 'ok  ' : 'FAIL', name); if (!ok) failed++; };
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
const post = (path, body) => fetch(`${origin}/__feedback/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const get = path => fetch(`${origin}/__feedback/api/${path}`).then(r => r.json());
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await new Promise(r => setTimeout(r, 250)); } };

async function walk(width, tap) {
  const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 800 }, hasTouch: tap, isMobile: tap });
  const owner = await context.newPage();
  const errors = [];
  owner.on('pageerror', error => { errors.push(String(error)); if (process.env.DEBUG_E2E) console.log('PAGEERROR', String(error), error.stack); });
  if (process.env.DEBUG_E2E) owner.on('console', m => console.log('CONSOLE', m.type(), m.text()));
  const act = tap ? 'tap' : 'click';

  // ---- The owner makes a link with recording on, from the share dialog
  await owner.goto(`${origin}/__feedback/inbox/#/artifact/${art.id}`);
  await owner.waitForSelector('#artifact-frame');
  await owner.locator('#artifact-share')[act]();
  await owner.waitForSelector('#share-dialog[open]');
  check(`${width}: Record interactions is off by default in the share dialog`, !(await owner.locator('#share-record').isChecked()));
  await owner.locator('#share-record').check();
  await shot(owner, `share-dialog-${width}`);
  await owner.locator('#share-create')[act]();
  await owner.waitForSelector('#share-url:not([hidden])');
  const link = (await owner.locator('#share-url').innerText()).replace(origin, '');
  await owner.locator('#share-cancel')[act]();
  const before = (await get(`artifacts/${art.id}/replays`)).length;

  // ---- A viewer opens it: notice, then interacts
  const viewerCtx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 800 }, hasTouch: tap, isMobile: tap });
  const viewer = await viewerCtx.newPage();
  const verrors = [];
  viewer.on('pageerror', error => verrors.push(String(error)));
  const uploads = [];
  viewer.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/replay')) uploads.push(request.postData() ?? ''); });
  await viewer.goto(`${origin}${link}`);
  await viewer.waitForSelector('#notice:not([hidden])');
  const notice = await viewer.locator('#notice').innerText();
  check(`${width}: the viewer sees the recording notice and the opt-out`, notice.includes('This page records clicks and mouse movement to help the author.') && notice.includes("Don't record"));
  await shot(viewer, `notice-${width}`);
  const frame = viewer.frameLocator('#art');
  await frame.locator('#go').waitFor();
  const probe = await viewer.frames().find(f => f !== viewer.mainFrame())?.evaluate(() => { try { return String(parent.document.title); } catch (e) { return 'blocked'; } });
  check(`${width}: the artifact cannot reach the shell's DOM (opaque origin)`, probe === 'blocked');
  await viewer.mouse.move(width / 2, 200); await viewer.mouse.move(width / 2 + 60, 260, { steps: 6 });
  await frame.locator('#email').fill('hunter2-secret@example.com');
  await frame.locator('#go').click();
  await frame.locator('#stay').click();
  const shown = await viewer.evaluate(() => document.getElementById('art').getAttribute('sandbox'));
  check(`${width}: the artifact frame is sandboxed without allow-same-origin`, shown === 'allow-scripts allow-popups');

  // ---- Forged messages are ignored: only the iframe is believed
  await viewer.evaluate(() => window.postMessage({ rf: 'pick', text: 'FORGED', path: 'x', box: null }, '*'));
  await viewer.waitForTimeout(300);
  check(`${width}: a message from anything but the iframe is ignored`, (await viewer.locator('#fb-dialog[open]').count()) === 0);

  // ---- Feedback with "point at it"
  await viewer.locator('#fb-open')[act]();
  await viewer.waitForSelector('#fb-dialog[open]');
  await viewer.locator('#fb-note').fill('The Go button is too close to Stay');
  await viewer.locator('#fb-point')[act]();
  await viewer.waitForSelector('#fb-hint:not([hidden])');
  await frame.locator('#go').click();
  await viewer.waitForSelector('#fb-dialog[open]');
  check(`${width}: pointing reports what was clicked`, (await viewer.locator('#fb-quote').innerText()).includes('Go'));
  check(`${width}: the typed note survives pointing`, (await viewer.locator('#fb-note').inputValue()) === 'The Go button is too close to Stay');
  await shot(viewer, `feedback-dialog-${width}`);
  await viewer.locator('#fb-send')[act]();
  await viewer.waitForFunction(() => document.getElementById('fb-status').textContent.startsWith('Thanks'));
  const detail = await get(`threads/${thread}`);
  const note = detail.messages.find(m => m.author === 'viewer' && m.text.includes('too close'));
  check(`${width}: the note lands in the artifact's thread as viewer feedback, flagged for you`, !!note && note.flag === 'needs_you' && note.quote?.text === 'Go' && /link s[0-9a-f]{8}/.test(note.label));
  check(`${width}: the thread waits on you`, detail.waiting === 'you');
  await viewer.locator('#fb-cancel')[act]();

  // ---- The recording reaches the server in batches
  const stored = await until(async () => { const rows = await get(`artifacts/${art.id}/replays`); return rows.length > before && rows[0].clicks >= 2 ? rows[0] : null; });
  check(`${width}: a replay is listed with clicks and a duration`, !!stored && stored.clicks >= 2 && stored.duration_ms > 0 && stored.version === 1);
  if (stored) {
    const full = await get(`artifacts/${art.id}/replays/${stored.session}`);
    const text = JSON.stringify(full.events);
    if (process.env.DEBUG_E2E) await Bun.write(join(root, 'events.json'), text);
    check(`${width}: typed input is masked in what was stored`, !text.includes('hunter2') && !text.includes('secret@example.com'));
    check(`${width}: data-rf-private content is blocked`, !text.includes('4417 1234'));
  }

  // ---- Don't record: nothing more is sent
  const declined = await (await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 800 }, hasTouch: tap, isMobile: tap })).newPage();
  const sent = [];
  declined.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/replay')) sent.push(request.url()); });
  await declined.goto(`${origin}${link}`);
  await declined.waitForSelector('#notice:not([hidden])');
  await declined.locator('#norec')[act]();
  const dframe = declined.frameLocator('#art');
  await dframe.locator('#go').click();
  await dframe.locator('#email').fill('nothing leaves');
  await declined.mouse.move(100, 200); await declined.mouse.move(180, 260, { steps: 5 });
  await declined.waitForTimeout(6500);
  check(`${width}: after Don't record nothing is uploaded`, sent.length === 0 && (await declined.locator('#notice').innerText()).includes('Not recording'));
  await shot(declined, `declined-${width}`);
  const rows = await get(`artifacts/${art.id}/replays`);
  check(`${width}: the declined visit left no recording`, rows.length === before + 1);

  // ---- A link with recording off: no notice, no recorder
  const plain = await post(`artifacts/${art.id}/share`, { expires: '7d' });
  const off = await (await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 800 }, hasTouch: tap, isMobile: tap })).newPage();
  const offSent = [];
  off.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/replay')) offSent.push(1); });
  await off.goto(`${origin}${plain.url}`);
  await off.waitForSelector('#art');
  await off.frameLocator('#art').locator('#go').click();
  await off.waitForTimeout(5000);
  check(`${width}: a link with the switch off shows no notice and records nothing`, (await off.locator('#notice').isHidden()) && offSent.length === 0 && (await off.evaluate(() => typeof window.RFRecorder)) === 'undefined');

  // ---- The owner: Manage, the Replays tab, Play, Delete, Heatmap
  await owner.reload();
  await owner.waitForSelector('#artifact-pill:not([hidden])');
  await owner.locator('#artifact-pill')[act]();
  await owner.waitForSelector('#manage-dialog[open]');
  const manage = await owner.locator('#manage-list').innerText();
  check(`${width}: Manage shows a Record interactions switch and the feedback count`, manage.includes('Record interactions') && /Feedback from viewers: 1/.test(manage));
  await shot(owner, `manage-${width}`);
  await owner.locator('#manage-close')[act]();
  await owner.locator('#artifact-heat')[act]();
  await owner.waitForSelector('#heatmap .dot');
  check(`${width}: the heatmap overlays click positions`, (await owner.locator('#heatmap .dot').count()) >= 2 && (await owner.locator('#heatmap-note').innerText()).includes('click'));
  await shot(owner, `heatmap-${width}`);
  await owner.locator('#artifact-heat')[act]();
  // Anyone with the link can send crafted events. Playing them must run nothing in the inbox.
  const hostile = 'HostileSession0000000001', now = Date.now();
  const evil = [{ type: 4, timestamp: now, data: { href: 'x', width: 400, height: 300 } },
    { type: 2, timestamp: now + 1, data: { node: { id: 1, type: 0, childNodes: [{ id: 2, type: 1, name: 'html', publicId: '', systemId: '' }, { id: 3, type: 2, tagName: 'html', attributes: { onload: 'top.__pwned=1' }, childNodes: [{ id: 4, type: 2, tagName: 'body', attributes: { onload: 'top.__pwned=1' }, childNodes: [
      { id: 5, type: 2, tagName: 'img', attributes: { src: 'x:x', onerror: 'top.__pwned=1;parent.__pwned=1' }, childNodes: [] },
      { id: 6, type: 2, tagName: 'script', attributes: {}, childNodes: [{ id: 7, type: 3, textContent: 'top.__pwned=1;parent.__pwned=1' }] },
      { id: 8, type: 2, tagName: 'a', attributes: { href: 'javascript:top.__pwned=1' }, childNodes: [{ id: 9, type: 3, textContent: 'x' }] }] }] }] }, initialOffset: { left: 0, top: 0 } } },
    { type: 3, timestamp: now + 300, data: { source: 2, type: 2, id: 8, x: 5, y: 5 } }];
  const crafted = await fetch(`${origin}${link}/replay`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ session: hostile, seq: 0, events: evil }) });
  check(`${width}: a crafted recording is accepted as data`, crafted.status === 200);
  await owner.locator('#tab-replays')[act]();
  await owner.waitForSelector(`.replay-row[data-session="${hostile}"]`);
  await owner.locator(`.replay-row[data-session="${hostile}"] button.primary`)[act]();
  await owner.waitForSelector('#replay-dialog[open]');
  await owner.frameLocator('#replay-frame').locator('.rr-controller').waitFor({ timeout: 20000 });
  await owner.frameLocator('#replay-frame').locator('.rr-controller button').first().click().catch(() => {});
  await owner.waitForTimeout(1500);
  check(`${width}: playing a crafted recording runs no script in the inbox`, (await owner.evaluate(() => window.__pwned)) === undefined);
  await owner.locator('#replay-close')[act]();
  await owner.evaluate(async id => { await fetch(`${location.pathname.replace(/inbox\/.*$/, '')}api/artifacts/${id.art}/replays/${id.session}`, { method: 'DELETE' }); }, { art: art.id, session: hostile });
  await owner.locator('#tab-page')[act]();
  await owner.locator('#tab-replays')[act]();
  await owner.waitForSelector('.replay-row');

  const row = await owner.locator('.replay-row').first().innerText();
  check(`${width}: the Replays tab lists date, duration, clicks and version`, /\d:\d\d/.test(row) && /clicks?/.test(row) && /v1/.test(row));
  await shot(owner, `replays-${width}`);
  await owner.locator('.replay-row button.primary').first()[act]();
  await owner.waitForSelector('#replay-dialog[open]');
  const player = owner.frameLocator('#replay-frame');
  await player.locator('.rr-controller').waitFor({ timeout: 20000 }).catch(async error => { for (const f of owner.frames()) if (f.url().includes('replay/player')) console.log('CHILDREN', await f.evaluate(() => [...document.querySelector('.rr-player').children].map(c => c.className + '|' + c.tagName)), await f.evaluate(() => typeof RFPlayer + ' ' + document.querySelectorAll('*').length)); for (const f of owner.frames()) console.log('FRAME', f.url(), (await f.content().catch(() => '')).slice(f.url().includes('replay/player') ? 400 : 0, f.url().includes('replay/player') ? 2600 : 100)); throw error; });
  check(`${width}: Play opens rrweb-player with a timeline`, (await player.locator('.rr-progress').count()) === 1);
  await player.locator('.rr-progress div[title="click"]').first().waitFor({ state: 'attached', timeout: 8000 }).catch(() => {});
  check(`${width}: the timeline has click markers`, (await player.locator('.rr-progress div[title="click"]').count()) >= 1);
  await player.locator('.rr-controller button').first().click().catch(() => {});
  await owner.waitForTimeout(800);
  await shot(owner, `replay-player-${width}`);
  await owner.locator('#replay-close')[act]();
  const del = owner.locator('.replay-row button', { hasText: 'Delete' }).first();
  await del[act]();
  check(`${width}: Delete asks again before it deletes`, (await owner.locator('.replay-row button', { hasText: 'Confirm delete' }).count()) === 1 && (await get(`artifacts/${art.id}/replays`)).length === before + 1);
  await owner.locator('.replay-row button', { hasText: 'Confirm delete' }).first()[act]();
  await until(async () => (await get(`artifacts/${art.id}/replays`)).length === before);
  check(`${width}: a confirmed delete removes the recording`, (await get(`artifacts/${art.id}/replays`)).length === before);

  check(`${width}: no page errors (owner, viewer)`, errors.length === 0 && verrors.length === 0);
  await context.close(); await viewerCtx.close();
}

async function inboxRecording(width, tap) {
  await post('replay-settings', { record_inbox: false });
  const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 800 }, hasTouch: tap, isMobile: tap });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const act = tap ? 'tap' : 'click';
  await page.goto(`${origin}/__feedback/inbox/#/`);
  await page.waitForSelector('#me');
  check(`${width}: no recording indicator while the setting is off`, await page.locator('#rec-dot').isHidden());
  await page.locator('#me')[act]();
  await page.waitForSelector('#profile-dialog[open]');
  check(`${width}: Record my inbox sessions is off by default`, !(await page.locator('#profile-record').isChecked()));
  await page.locator('#profile-record').check();
  await shot(page, `inbox-recording-toggle-${width}`);
  await page.locator('#profile-form button.primary')[act]();
  await page.waitForSelector('#rec-dot:not([hidden])');
  check(`${width}: a Recording indicator shows while the inbox records`, (await page.locator('#rec-dot').innerText()).includes('Recording'));
  await shot(page, `inbox-recording-on-${width}`);
  await page.locator(`a[href="#/${thread}"]`).first()[act]().catch(() => {});
  await page.mouse.move(100, 200); await page.mouse.move(200, 300, { steps: 5 });
  await page.waitForTimeout(500);
  const mine = await until(async () => { const rows = await get('replays'); return rows.length ? rows : null; }, 15000);
  check(`${width}: the inbox session reaches the server under its own scope`, !!mine && mine[0].link === null);
  await page.goto(`${origin}/__feedback/inbox/#/metrics`);
  await page.waitForSelector('#my-sessions .replay-row', { timeout: 15000 });
  check(`${width}: Metrics lists My sessions`, (await page.locator('#my-sessions .replay-row').count()) >= 1);
  await page.locator('#my-sessions').scrollIntoViewIfNeeded();
  await shot(page, `my-sessions-${width}`);
  await page.locator('#my-sessions .replay-row button.primary').first()[act]();
  await page.waitForSelector('#replay-dialog[open]');
  await page.frameLocator('#replay-frame').locator('.rr-controller').waitFor({ timeout: 20000 });
  check(`${width}: an inbox session plays`, true);
  await page.locator('#replay-close')[act]();
  // Switching it off stops the recording.
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForSelector('#me', { state: 'visible' });
  await page.locator('#me')[act]();
  await page.waitForSelector('#profile-dialog[open]');
  await page.locator('#profile-record').uncheck();
  await page.locator('#profile-form button.primary')[act]();
  await page.waitForSelector('#rec-dot', { state: 'hidden' });
  check(`${width}: switching it off hides the indicator`, true);
  check(`${width}: no page errors (inbox)`, errors.length === 0);
  await context.close();
}

try {
  await walk(390, true);
  await inboxRecording(390, true);
  await walk(1280, false);
  await inboxRecording(1280, false);
} finally { await browser.close(); server.stop(true); }
console.log(failed ? `${failed} FAILED` : 'all ok');
console.log('shots', SHOTS);
process.exit(failed ? 1 : 0);
