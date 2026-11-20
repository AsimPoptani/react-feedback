// Browser test for 0.11.0 at 390 (a phone with touch) and 1280 wide: the source chip of a capture, quoting selected text, and an expired question.
// Needs Playwright (PLAYWRIGHT=/path/to/playwright/index.mjs, or NODE_PATH). Run: bun e2e/rf0110.mjs   (SHOTS=/some/dir saves the screenshots there)
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'rf0110-e2e-'));
const dir = join(root, 'data');
await mkdir(dir);
delete process.env.FEEDBACK_PROJECT; delete process.env.FEEDBACK_PROJECTS;
process.env.FEEDBACK_DIR = dir;
const SHOTS = process.env.SHOTS ?? join(root, 'shots');
await mkdir(SHOTS, { recursive: true });
const store = await import('../server/store.ts');
const { serverOptions } = await import('../server/server.ts');
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

const server = Bun.serve({ ...serverOptions(), hostname: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.port}`;
const post = (path, data) => fetch(`${origin}/__feedback/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(r => r.json());
const browser = await chromium.launch();
let failed = 0;
const check = (name, ok) => { console.log(ok ? 'ok  ' : 'FAIL', name); if (!ok) failed++; };

const captured = (await post('items', { note: 'The save button looks off', mode: 'element', image: png,
  target: { selector: '[data-testid="save"]', tag: 'button', role: 'button', name: 'Save', text: 'Save', components: ['SaveButton', 'Toolbar', 'EditorPage'], rect: { x: 10, y: 10, width: 90, height: 32 },
    source: { file: 'src/features/editor/toolbar/SaveButton.tsx', line: 42, column: 7, component: 'SaveButton', runtime: true } },
  context: { url: 'http://localhost:5173/editor', viewport: { width: 1280, height: 800 } } })).id;
const talk = (await store.createThread(dir, { title: 'Cache plan', text: 'How does the cache get rebuilt?', origin: 'user' })).id;
const agent = await store.appendMessage(dir, talk, { author: 'agent', text: 'The cache is rebuilt nightly and on every deploy. A manual rebuild is also possible from the admin page, and it takes about ten minutes.', flag: 'fyi' });
const stale = await store.createThread(dir, { title: 'Release question', text: 'Ship it on Friday?', origin: 'agent', question: { prompt: 'Ship it on Friday?', options: [{ label: 'Yes' }, { label: 'No, Monday' }], expires: '1h' } });
await store.expireQuestions(dir, stale.id, { qid: 'q1' });

const noSideways = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
async function select(page, mid, part) {
  await page.evaluate(([id, text]) => {
    const node = document.querySelector(`#msgs .msg[data-mid="${id}"]`);
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const at = (t.textContent || '').indexOf(text);
      if (at < 0) continue;
      const range = document.createRange(); range.setStart(t, at); range.setEnd(t, at + text.length);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      return;
    }
    throw new Error(`no ${text}`);
  }, [mid, part]);
}

async function walk(width, height, tap) {
  const context = await browser.newContext({ viewport: { width, height }, ...(tap ? { hasTouch: true, isMobile: true } : {}) });
  const page = await context.newPage();
  const tag = String(width);

  // 1. The source chip in the capture view
  await page.goto(`${origin}/__feedback/inbox/#/${captured}`);
  await page.waitForSelector('#capture .src-chip');
  const chip = await page.locator('#capture .src-chip').innerText();
  check(`${tag}: the chip shows the shortened source and line`, chip === 'src/…/toolbar/SaveButton.tsx:42');
  check(`${tag}: it says the position is runtime, not source-mapped`, (await page.locator('#capture .src-row').innerText()).includes('runtime, not source-mapped'));
  check(`${tag}: no sideways scroll on the capture`, await noSideways(page));
  await page.locator('#capture').screenshot({ path: join(SHOTS, `source-chip-${tag}.png`) });

  // 2. Quote a bit of the agent's reply
  await page.goto(`${origin}/__feedback/inbox/#/${talk}`);
  await page.waitForSelector(`#msgs .msg[data-mid="${agent.id}"]`);
  await select(page, agent.id, 'rebuilt nightly and on every deploy');
  await page.waitForSelector('#qpop:not([hidden])');
  const docked = await page.locator('#qpop').evaluate(node => node.classList.contains('dock'));
  check(`${tag}: the popover appears on a selection (${tap ? 'docked at the foot of the screen' : 'beside the selection'})`, docked === tap);
  check(`${tag}: the popover stays inside the screen`, await page.locator('#qpop').evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }));
  await page.fill('#qpop-note', 'Can the nightly run be skipped?');
  await page.screenshot({ path: join(SHOTS, `quote-popover-${tag}.png`) });
  await page.locator('#qpop-go')[tap ? 'tap' : 'click']();
  const text = await page.inputValue('#text');
  check(`${tag}: Quote puts the block and the note in the composer`, text === '> rebuilt nightly and on every deploy\n\nCan the nightly run be skipped?');
  check(`${tag}: the popover goes away`, await page.locator('#qpop').isHidden());
  await page.screenshot({ path: join(SHOTS, `quote-composer-${tag}.png`) });
  await page.locator('#send')[tap ? 'tap' : 'click']();
  await page.waitForSelector('#msgs .msg.user .quote');
  const sentQuote = page.locator('#msgs .msg.user .quote').last();
  check(`${tag}: the sent message shows the linked quote, once`, (await sentQuote.innerText()).includes('rebuilt nightly and on every deploy') && (await page.locator('#msgs .msg.user blockquote').count()) === 0);
  const stored = (await store.summarise(dir, talk)).messages.at(-1);
  check(`${tag}: the server stored quote { message_id, text }`, stored.quote?.message_id === agent.id && stored.quote?.text === 'rebuilt nightly and on every deploy');
  await sentQuote[tap ? 'tap' : 'click']();
  check(`${tag}: tapping the quote jumps to the source message`, await page.locator(`#msgs .msg[data-mid="${agent.id}"]`).evaluate(node => node.classList.contains('flash') || document.activeElement === node));
  check(`${tag}: no sideways scroll in the thread`, await noSideways(page));
  await page.screenshot({ path: join(SHOTS, `quote-sent-${tag}.png`) });
  // Esc on the popover, and a collapsed selection, take it away again
  await select(page, agent.id, 'manual rebuild');
  await page.waitForSelector('#qpop:not([hidden])');
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.waitForSelector('#qpop', { state: 'hidden' });
  check(`${tag}: the popover goes when the selection does`, true);

  // 3. An expired question
  await page.goto(`${origin}/__feedback/inbox/#/${stale.id}`);
  await page.waitForSelector('.qcard.expired');
  check(`${tag}: the expired question is one muted line saying Expired`, (await page.locator('.qclosed').innerText()).startsWith('Expired · Ship it on Friday?'));
  check(`${tag}: it is not in the pinned bar and has no options`, (await page.locator('#waiting-bar').isHidden()) && (await page.locator('#msgs .qopt').count()) === 0);
  check(`${tag}: no sideways scroll`, await noSideways(page));
  await page.screenshot({ path: join(SHOTS, `expired-${tag}.png`) });
  const row = await page.locator(`#groups a[href="#/${stale.id}"]`).first().innerText().catch(() => '');
  check(`${tag}: its row does not say it is waiting for an answer`, !/question|waiting for you/i.test(row.replace(/Release question/, '')));
  await context.close();
}

try {
  const detail = await (await fetch(`${origin}/__feedback/api/threads/${stale.id}`)).json();
  check('the API marks the question expired and the thread idle', detail.messages[0].question.expired === true && detail.waiting === 'idle' && detail.open_question === false);
  const late = await fetch(`${origin}/__feedback/api/threads/${stale.id}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question_id: 'q1', option_ids: ['o1'] }) });
  check('an answer to it is 409 "This question expired"', late.status === 409 && (await late.text()).includes('This question expired'));
  await walk(390, 844, true);
  await walk(1280, 800, false);
} finally { await browser.close(); server.stop(true); }
console.log(`screenshots: ${SHOTS}`);
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log('all checks passed');
