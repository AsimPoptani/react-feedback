// Browser test: a question withdrawn or re-asked while an answer is being typed keeps that answer.
// Needs Playwright (NODE_PATH points at it, or PLAYWRIGHT=/path/to/playwright). Run: bun e2e/rf093.mjs
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'rf093-e2e-'));
const alpha = join(root, 'alpha');
delete process.env.FEEDBACK_PROJECT;
process.env.FEEDBACK_DIR = alpha;
process.env.FEEDBACK_PROJECTS = '';
const store = await import('../server/store.ts');
const { serverOptions } = await import('../server/server.ts');
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');

const prompt = 'Which pictures should we keep?';
async function asked(title) {
  const id = (await store.createThread(alpha, { title, text: 'Start', origin: 'user' })).id;
  const message = await store.appendMessage(alpha, id, { author: 'agent', text: prompt, question: { prompt, options: [{ label: 'Reuse' }, { label: 'Draw new' }] }, flag: 'needs_you' });
  return { id, qid: message.question.id };
}
const pollThread = await asked('Poll');
const submitThread = await asked('Submit');
const bumpThread = await asked('Bump');

const server = Bun.serve({ ...serverOptions(), hostname: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch();
let failed = 0;
const check = (name, ok) => { console.log(ok ? 'ok  ' : 'FAIL', name); if (!ok) failed++; };

async function open(page, id) {
  await page.goto(`${origin}/__feedback/inbox/#/${id}`);
  await page.waitForSelector('#waiting-bar .qother');
}
async function poll(page) {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}

try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));

  await open(page, pollThread.id);
  await page.locator('#waiting-bar .qother').fill('kept-by-poll');
  await store.cancelQuestion(alpha, pollThread.id, pollThread.qid, 'changed my mind');
  await poll(page);
  await page.waitForSelector('text=Send as a message');
  check('a poll keeps the typed answer', await page.locator('.qrescue .qother').inputValue() === 'kept-by-poll');
  check('a withdrawn question collapses to one line', (await page.locator('.qclosed').innerText()).includes('Withdrawn ·') && (await page.locator('.qclosed').innerText()).includes('changed my mind'));
  check('the composer error stays clear', await page.locator('#error').isHidden());
  await page.getByRole('button', { name: 'Send as a message' }).click();
  await page.locator('.msg', { hasText: 'kept-by-poll' }).first().waitFor();
  check('Send as a message posts the kept answer', await page.locator('.msg', { hasText: 'kept-by-poll' }).count() > 0);

  await open(page, submitThread.id);
  await page.locator('#waiting-bar .qother').fill('kept-on-409');
  await store.cancelQuestion(alpha, submitThread.id, submitThread.qid, 'too late');
  await page.locator('#waiting-bar .qother').press('Enter');
  await page.waitForSelector('text=Send as a message');
  check('a 409 keeps the typed answer', await page.locator('.qrescue .qother').inputValue() === 'kept-on-409');
  check('a 409 does not leave the withdrawn error', await page.locator('#error').isHidden());

  await open(page, bumpThread.id);
  await page.locator('#waiting-bar .qother').fill('kept-on-bump');
  await store.bumpQuestion(alpha, bumpThread.id, bumpThread.qid);
  await poll(page);
  await page.waitForSelector('text=Use on the new copy');
  check('a bump keeps the typed answer', await page.locator('.qrescue .qother').inputValue() === 'kept-on-bump');
  check('the original says it was re-asked below', await page.locator('.qlink', { hasText: 'Re-asked below' }).count() > 0);
  await page.getByRole('button', { name: 'Use on the new copy' }).click();
  await page.waitForSelector('text=Answered: Other: kept-on-bump');
  check('Use on the new copy answers the new question', await page.locator('text=Answered: Other: kept-on-bump').count() > 0);
  check('no page errors', errors.length === 0);
} finally { await browser.close(); server.stop(true); }
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);
