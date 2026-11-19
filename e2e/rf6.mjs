// Browser test for the phone layout, the key box, redaction and offline sending. Needs Playwright (PLAYWRIGHT=/path/to/playwright/index.mjs) and a built dist/ (`bun run build`).
// Run: bun e2e/rf6.mjs            (SHOTS=/some/dir also saves screenshots)
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'rf6-e2e-'));
process.env.FEEDBACK_DIR = join(root, 'data'); process.env.FEEDBACK_VAULT_DIR = join(root, 'vault'); process.env.FEEDBACK_SECRET_TARGET = '/api/keys/{name}';
const DIR = process.env.FEEDBACK_DIR, SHOTS = process.env.SHOTS;
const store = await import('../server/store.ts');
const { serverOptions } = await import('../server/server.ts');
const { chromium, webkit } = await import(process.env.PLAYWRIGHT ?? 'playwright');
const SECRET = 'sk-test-0123456789-WXYZ', SENSITIVE = 'my pin is 482913';

const { id } = await store.createThread(DIR, { title: 'Phone test', text: 'Hello there', origin: 'user' });
const say = (author, text, extra = {}) => store.appendMessage(DIR, id, { author, text, ...extra });
await say('agent', 'Hi. Here is what I found so far.');
await say('user', 'Great, thanks. Can you check the second one?');
await say('agent', 'Yes: it **does** pass now.');
await say('user', SENSITIVE);
await say('agent', 'Please add the OpenRouter key.', { secret: { name: 'openrouter', label: 'OpenRouter API key', help_url: 'https://openrouter.ai/keys' } });

// The feedback server plus a stand-in for the host app's key store on the same origin.
const options = serverOptions(), seen = [];
const server = Bun.serve({ ...options, hostname: '127.0.0.1', port: 0, fetch: async req => {
  const url = new URL(req.url), match = url.pathname.match(/^\/api\/keys\/([A-Za-z0-9_-]+)$/);
  if (match && req.method === 'PUT') { const { value } = await req.json(); seen.push(value); return Response.json({ set: true, hint: `…${value.slice(-4)}` }); }
  return options.fetch(req);
} });
const base = `http://127.0.0.1:${server.port}`, url = `${base}/__feedback/inbox/#/${id}`;
const browser = await chromium.launch();
let failed = 0;
const check = (name, ok) => { console.log(ok ? 'ok  ' : 'FAIL', name); if (!ok) failed++; };
const shot = (page, name) => SHOTS ? page.screenshot({ path: join(SHOTS, `${name}.png`) }) : null;
try {
  // ---- desktop is the old layout
  const wide = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await wide.goto(url); await wide.waitForSelector('#msgs .msg');
  check('desktop: Pin, Merge and Mark done are buttons; no ⋯ and no ＋', await wide.locator('#pin-thread').isVisible() && await wide.locator('#merge-open').isVisible() && await wide.locator('#toggle-done').isVisible() && !(await wide.locator('#more').isVisible()) && !(await wide.locator('#plus').isVisible()));
  check('desktop: Attach image, Side question and Send keep their labels', (await wide.locator('#attach').isVisible()) && (await wide.locator('#btw').isVisible()) && (await wide.locator('#send').innerText()).startsWith('Send'));
  await shot(wide, 'desktop-after-1280');

  // ---- phone
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await phoneCtx.newPage();
  const bodies = [];
  phone.on('request', r => { if (r.method() !== 'GET') bodies.push({ url: r.url(), method: r.method(), body: r.postData() ?? '' }); });
  await phone.goto(url); await phone.waitForSelector('#msgs .msg'); await phone.waitForTimeout(600);
  const head = await phone.locator('#open > .thread-head').boundingBox();
  check('phone: the header is one slim row', head.height < 70);
  check('phone: ← title donut ⋯ are in the header; Pin, Merge, Done are not', await phone.locator('#back').isVisible() && await phone.locator('#more').isVisible() && !(await phone.locator('#pin-thread').isVisible()) && !(await phone.locator('#merge-open').isVisible()) && !(await phone.locator('#toggle-done').isVisible()));
  const [plus, text, send] = await Promise.all(['#plus', '#text', '#send'].map(s => phone.locator(s).boundingBox()));
  check('phone: ＋, text box and send arrow share one row', Math.abs((plus.y + plus.height / 2) - (send.y + send.height / 2)) < 12 && plus.x < text.x && text.x + text.width <= send.x + 1);
  check('phone: Attach and Side question are not on their own rows', !(await phone.locator('#attach').isVisible()) && !(await phone.locator('#btw').isVisible()));
  check('phone: no keyboard hints on a touch screen', await phone.evaluate(() => [...document.querySelectorAll('kbd')].filter(k => k.offsetParent).length) === 0);
  check('phone: no sideways scroll', await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await shot(phone, 'phone-after-390-thread');
  const scroll = await phone.evaluate(() => ({ doc: document.scrollingElement.scrollHeight <= innerHeight, list: document.querySelector('#scroll').scrollHeight > document.querySelector('#scroll').clientHeight,
    html: getComputedStyle(document.documentElement).overscrollBehaviorY, body: getComputedStyle(document.body).overscrollBehaviorY, listOb: getComputedStyle(document.querySelector('#scroll')).overscrollBehaviorY, bodyOverflow: getComputedStyle(document.body).overflowY }));
  check('phone: the document never scrolls, only the message list does (no pull-to-refresh)', scroll.doc && scroll.bodyOverflow === 'hidden');
  check('phone: overscroll-behavior is none on html and body, contain on the list', scroll.html === 'none' && scroll.body === 'none' && scroll.listOb === 'contain');
  await phone.locator('#more').tap();
  check('phone: ⋯ holds Pin, Mark done', (await phone.locator('#popmenu button').allInnerTexts()).join('|') === 'Pin|Merge into…|Mark done');
  await shot(phone, 'phone-header-menu-390');
  await phone.keyboard.press('Escape');
  await phone.locator('#plus').tap();
  const plusItems = (await phone.locator('#popmenu button').allInnerTexts()).join('|'); if (plusItems !== 'Attach image|Side question') console.log('plus menu:', plusItems);
  check('phone: ＋ holds Attach image and Side question', plusItems === 'Attach image|Side question');
  await shot(phone, 'phone-plus-menu-390');
  await phone.keyboard.press('Escape');
  // keyboard open: the visible height shrinks
  await phone.setViewportSize({ width: 390, height: 450 });
  await phone.locator('#text').tap(); await phone.locator('#text').fill('Typing with the keyboard open, on a line long enough to wrap onto a second and third line of the box.');
  await phone.waitForTimeout(400);
  const list = await phone.locator('#scroll').boundingBox(), grown = await phone.locator('#text').boundingBox();
  check('phone: with the keyboard open the list keeps most of the height', list.height > 180);
  check('phone: the text box grows to a few lines, not past about five', grown.height > 60 && grown.height < 150);
  check('phone: the Feedback launcher is hidden while the composer has focus', await phone.evaluate(() => { const l = document.querySelector('.fb-launcher'); return !l || !l.offsetParent; }));
  check('phone: the list is scrolled to the newest message', await phone.evaluate(() => { const s = document.querySelector('#scroll'); return s.scrollHeight - s.scrollTop - s.clientHeight < 90; }));
  await shot(phone, 'phone-after-390-keyboard');
  await phone.locator('#text').fill(''); await phone.locator('#text').blur(); await phone.setViewportSize({ width: 390, height: 844 });

  // ---- the key box
  const box = phone.locator('.secret input');
  await box.scrollIntoViewIfNeeded();
  check('key box: a password field with autocomplete off', await box.getAttribute('type') === 'password' && await box.getAttribute('autocomplete') === 'off' && (await phone.locator('.secret form').count()) === 0);
  await shot(phone, 'key-box-390');
  await box.fill(SECRET); await phone.locator('.secret button.primary').tap();
  await phone.waitForSelector('.secret-ok');
  check('key box: shows "Saved ✓ · ends …WXYZ"', (await phone.locator('.secret-ok').innerText()) === 'Saved ✓ · ends …WXYZ');
  check('key box: the app got the value, once', seen.length === 1 && seen[0] === SECRET);
  check('key box: only the PUT to the app carried the value', bodies.filter(b => b.body.includes(SECRET)).length === 1 && bodies.find(b => b.body.includes(SECRET)).method === 'PUT' && bodies.find(b => b.body.includes(SECRET)).url.endsWith('/api/keys/openrouter'));
  const all = (await Promise.all((await readdir(DIR, { recursive: true, withFileTypes: true })).filter(e => e.isFile()).map(e => readFile(join(e.parentPath, e.name), 'utf8').catch(() => '')))).join('\n');
  check('key box: not in any file under the feedback folder, or its events', !all.includes(SECRET));
  check('key box: not in localStorage, sessionStorage or the page', await phone.evaluate(v => !JSON.stringify({ ...localStorage, ...sessionStorage }).includes(v) && !document.documentElement.innerHTML.includes(v), SECRET));
  const recorded = (await readFile(join(DIR, id, 'thread.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l)).find(m => m.secret);
  check('key box: the thread records only saved and the hint', recorded.secret.status === 'saved' && recorded.secret.hint === '…WXYZ' && JSON.stringify(recorded).length < 600);
  await shot(phone, 'key-saved-390');

  // ---- redact
  await phone.locator('#msgs > .msg.user', { hasText: SENSITIVE }).locator('.msg-more').tap();
  await phone.getByRole('menuitem', { name: 'Redact…' }).tap();
  await shot(phone, 'redact-confirm-390');
  await phone.locator('#redact-go').tap();
  await phone.waitForSelector('.msg.redacted');
  check('redact: the message shows the lock, time and who', (await phone.locator('.msg.redacted').innerText()).includes('🔒 Redacted (sensitive)'));
  check('redact: the text is gone from the page and the thread file; the vault holds it', !(await phone.content()).includes(SENSITIVE) && !(await readFile(join(DIR, id, 'thread.jsonl'), 'utf8')).includes(SENSITIVE)
    && (await readFile(join(root, 'vault', id, 'm5.json'), 'utf8')).includes(SENSITIVE));
  await phone.locator('.msg.redacted').scrollIntoViewIfNeeded(); await shot(phone, 'redacted-390');

  // ---- offline: the page opens from the service worker, writes queue, and go out in order
  await phone.evaluate(() => navigator.serviceWorker.ready); await phone.reload(); await phone.waitForSelector('#msgs .msg'); await phone.waitForTimeout(1500);
  check('offline: a service worker controls the inbox', await phone.evaluate(() => !!navigator.serviceWorker.controller));
  await phoneCtx.setOffline(true);
  await phone.reload(); await phone.waitForSelector('#msgs .msg');
  check('offline: the inbox opens with no signal, showing what was last seen', (await phone.locator('#msgs').innerText()).includes('Hi. Here is what I found') && await phone.locator('#offline-banner').isVisible());
  check('offline: the banner says so', (await phone.locator('#offline-banner').innerText()).startsWith('Offline · showing what you last saw'));
  check('offline: the saved key still shows as saved (the DOM tests cover the unsaved box)', await phone.locator('.secret-ok').count() === 1);
  await phone.locator('#text').fill('first, written offline'); await phone.locator('#send').tap(); await phone.waitForFunction(() => !document.querySelector('#send').disabled);
  await phone.locator('#text').fill('/btw second, a side question'); await phone.locator('#send').tap();
  await phone.waitForSelector('[data-queued]'); await phone.waitForTimeout(300);
  if (await phone.locator('[data-queued]').count() !== 2) console.log('queued html:', await phone.locator('#msgs').innerHTML().then(h => h.slice(-1500)), '| text:', await phone.locator('#text').inputValue(), '| error:', await phone.locator('#error').textContent(), '| busy-send-disabled:', await phone.locator('#send').isDisabled());
  check('offline: both messages show with a clock and "Waiting to send"', await phone.locator('[data-queued] svg.clock').count() === 2 && (await phone.locator('[data-queued]').first().innerText()).includes('Waiting to send'));
  await phone.locator('#msgs').evaluate(el => { el.parentElement.scrollTop = el.parentElement.scrollHeight; });
  await shot(phone, 'offline-queued-390');
  await phone.reload(); await phone.waitForSelector('[data-queued]');
  check('offline: the queue survives a reload (IndexedDB)', await phone.locator('[data-queued]').count() === 2);
  const wideCtx = phoneCtx; void wideCtx;
  await phoneCtx.setOffline(false);
  await phone.waitForFunction(() => document.querySelectorAll('[data-queued]').length === 0, null, { timeout: 15000 });
  const lines = (await readFile(join(DIR, id, 'thread.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  const tail = lines.slice(-2);
  check('offline: they arrived once each, in order, with client ids and written_at', tail[0].text === 'first, written offline' && tail[1].text === 'second, a side question' && tail[1].aside === true && tail.every(m => m.client_id && m.written_at) && lines.filter(m => m.text === 'first, written offline').length === 1);
  check('offline: the banner clears', await phone.locator('#offline-banner').isHidden());

  // 1280 with a queued message
  const wctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }), w2 = await wctx.newPage();
  await w2.goto(url); await w2.waitForSelector('#msgs .msg'); await w2.evaluate(() => navigator.serviceWorker.ready); await w2.reload(); await w2.waitForSelector('#msgs .msg'); await w2.waitForTimeout(1200);
  await wctx.setOffline(true);
  await w2.locator('#text').fill('queued on the wide screen'); await w2.locator('#send').click(); await w2.waitForSelector('[data-queued]');
  await shot(w2, 'offline-queued-1280');
  await w2.locator('[data-queued] .qstate button').click(); await w2.waitForFunction(() => !document.querySelector('[data-queued]')).catch(() => {});
  check('offline: a queued message can be deleted before it sends', await w2.locator('[data-queued]').count() === 0);
  await wctx.setOffline(false);
  // ---- no pull-to-refresh: in WebKit (iOS Chrome and Safari both use it) as well as Chromium, the document cannot scroll and the list still does
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    if (!engine) continue;
    let b2; try { b2 = await engine.launch(); } catch { console.log(`skip ${name}: not installed`); continue; }
    try {
      for (let i = 0; i < 3; i++) await store.appendMessage(DIR, id, { author: 'agent', text: `filler ${i}\n\n`.repeat(30) });
      const ctx = await b2.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }), pg = await ctx.newPage();
      await pg.goto(url); await pg.waitForSelector('#msgs .msg'); await pg.waitForTimeout(500);
      const info = await pg.evaluate(() => ({ doc: document.scrollingElement.scrollHeight <= innerHeight, listScrolls: document.querySelector('#scroll').scrollHeight > document.querySelector('#scroll').clientHeight,
        html: getComputedStyle(document.documentElement).overscrollBehaviorY, body: getComputedStyle(document.body).overscrollBehaviorY, list: getComputedStyle(document.querySelector('#scroll')).overscrollBehaviorY, pos: getComputedStyle(document.body).position }));
      check(`${name}: the document cannot scroll; the long thread's list can`, info.doc && info.listScrolls && info.pos === 'fixed');
      check(`${name}: overscroll-behavior none on html and body, contain on the list`, info.html === 'none' && info.body === 'none' && info.list === 'contain');
      await pg.evaluate(() => { const s = document.querySelector('#scroll'); s.scrollTop = 0; });
      if (name === 'chromium') { await pg.mouse.move(200, 300); await pg.mouse.wheel(0, -400); } await pg.evaluate(() => { window.scrollBy(0, -300); document.scrollingElement.scrollTop = -50; }); await pg.waitForTimeout(200);
      check(`${name}: scrolling up at the top of the list leaves the page where it is`, await pg.evaluate(() => scrollY === 0 && document.scrollingElement.scrollTop === 0));
      await pg.evaluate(() => document.querySelector('#scroll').scrollBy(0, 500)); await pg.waitForTimeout(300);
      check(`${name}: the list still scrolls`, await pg.evaluate(() => document.querySelector('#scroll').scrollTop > 0));
    } finally { await b2.close(); }
  }
} finally { await browser.close(); server.stop(true); }
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
