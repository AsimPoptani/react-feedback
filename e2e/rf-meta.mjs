// Browser test for 0.15 (working together), at 390 and 1280 px: "the thread changes while I type" (poll, withdraw, re-ask, merge, move: the text is never lost), kept drafts across a reload,
// typing presence refusing an agent, multi-choice cards, Waiting on you across projects, the Move chip, reactions, answers given offline, and the phone's bottom gap.
// Needs Playwright (NODE_PATH points at it, or PLAYWRIGHT=/path/to/playwright). Run: bun e2e/rf-meta.mjs   Screenshots: RF_SHOTS (default ./rf-meta-shots)
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'rfmeta-e2e-'));
const alpha = join(root, 'alpha'), beta = join(root, 'beta');
const shots = process.env.RF_SHOTS ?? join(process.cwd(), 'rf-meta-shots');
await mkdir(shots, { recursive: true });
delete process.env.FEEDBACK_PROJECT;
process.env.FEEDBACK_PROJECTS = JSON.stringify([{ id: 'alpha', name: 'Alpha', dir: alpha, match: ['http://alpha.test'] }, { id: 'beta', name: 'Beta', dir: beta, match: ['http://beta.test/app'] }]);
const store = await import('../server/store.ts');
const { serverOptions } = await import('../server/server.ts');
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
const server = Bun.serve({ ...serverOptions(), hostname: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch();
let failed = 0;
const check = (name, ok) => { console.log(ok ? 'ok  ' : 'FAIL', name); if (!ok) failed++; };
const refused = async fn => { try { await fn(); return false; } catch (e) { return e?.status === 409 && e.message === 'the person is typing here'; } };
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, 60)); } return false; };
const PNG = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString('base64')}`;
const asked = async (title, options = [{ label: 'Reuse', recommended: true }, { label: 'Draw new' }], extra = {}) => {
  const id = (await store.createThread(alpha, { title, text: 'Start', origin: 'user' })).id;
  const m = await store.appendMessage(alpha, id, { author: 'agent', text: 'Which pictures?', question: { prompt: 'Which pictures?', options, ...extra }, flag: 'needs_you' });
  return { id, qid: m.question.id };
};
const poll = page => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

async function scenario(label, contextOptions) {
  const tag = (name) => `${label}: ${name}`;
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const shot = name => page.screenshot({ path: join(shots, `${label}-${name}.png`) });
  // The inbox remembers its project, and a hash change alone does not reload it: set the project, then load.
  const openAlpha = async id => { await page.evaluate(() => localStorage.setItem('fb-inbox-project', 'alpha')); await page.goto(`${origin}/__feedback/inbox/#/${id}`); await page.reload(); };
  const wide = contextOptions.viewport.width >= 760;

  // ---- The thread changes while I type
  const t1 = await asked(`Race ${label}`);
  await page.goto(`${origin}/__feedback/inbox/#/${t1.id}`);
  await page.waitForSelector('#msgs .qcard');
  await page.locator('#text').fill('a draft I am still writing');
  await page.locator('#msgs .qother').fill('my own answer, half typed');
  check(tag('the inbox reports that the person is typing'), await until(() => store.isTyping(alpha, t1.id)));
  // an agent reply arrives and the page polls
  await store.appendMessage(alpha, t1.id, { author: 'agent', text: 'A new update while you type' });
  await poll(page);
  await page.locator('#msgs', { hasText: 'A new update while you type' }).waitFor();
  check(tag('a poll keeps the composer and the Other box'), (await page.locator('#text').inputValue()) === 'a draft I am still writing' && (await page.locator('#msgs .qother').first().inputValue()) === 'my own answer, half typed');
  // withdraw: refused while typing, allowed with force, and the Other text is kept with Send as a message
  check(tag('a withdraw is refused with 409 "the person is typing here"'), await refused(() => store.cancelQuestion(alpha, t1.id, t1.qid)));
  await store.cancelQuestion(alpha, t1.id, t1.qid, 'changed my mind', { force: true });
  await poll(page);
  await page.waitForSelector('text=Send as a message');
  check(tag('a forced withdraw keeps the Other text and the composer'), (await page.locator('.qrescue .qother').inputValue()) === 'my own answer, half typed' && (await page.locator('#text').inputValue()) === 'a draft I am still writing');
  await shot('withdrawn-keeps-text');
  // re-ask on a second question
  const reask = await asked(`Reask ${label}`);
  await page.goto(`${origin}/__feedback/inbox/#/${reask.id}`);
  await page.waitForSelector('#msgs .qcard');
  await page.locator('#msgs .qother').fill('typed before the re-ask');
  await page.locator('#text').fill('composer while re-asked');
  await until(() => store.isTyping(alpha, reask.id));
  await store.bumpQuestion(alpha, reask.id, reask.qid);
  await poll(page);
  await page.waitForSelector('text=Use on the new copy');
  check(tag('a re-ask keeps the Other text and the composer'), (await page.locator('.qrescue .qother').inputValue()) === 'typed before the re-ask' && (await page.locator('#text').inputValue()) === 'composer while re-asked');
  // merge and move
  const other = (await store.createThread(alpha, { title: `Merge target ${label}`, text: 'target', origin: 'agent' })).id;
  check(tag('a merge is refused while typing'), await refused(() => store.mergeThreads(alpha, reask.id, other, 'agent')));
  const mover = (await store.createThread(alpha, { title: `Move target ${label}`, text: 'target', origin: 'agent' })).id;
  check(tag('a move is refused while typing'), await refused(() => store.moveMessages(alpha, reask.id, ['m1'], mover)));
  await store.mergeThreads(alpha, reask.id, other, 'agent', undefined, { force: true });
  await poll(page);
  await page.waitForSelector('#merged-note:not([hidden])');
  check(tag('a forced merge keeps the composer text'), (await page.locator('#text').inputValue()) === 'composer while re-asked');
  // reload: the draft is back
  await page.reload();
  await page.waitForSelector('#merged-note:not([hidden]), #msgs .msg');
  check(tag('a reload brings the composer draft back'), (await page.locator('#text').inputValue()).includes('composer while re-asked'));
  const mv = await asked(`Mover ${label}`);
  await page.goto(`${origin}/__feedback/inbox/#/${mv.id}`);
  await page.waitForSelector('#msgs .qcard');
  await page.locator('#text').fill('typing while a message moves');
  await until(() => store.isTyping(alpha, mv.id));
  await store.moveMessages(alpha, mv.id, ['m1'], mover, 'agent', undefined, { force: true });
  await poll(page);
  await page.locator('#msgs', { hasText: 'Moved to' }).waitFor();
  check(tag('a forced move keeps the composer text'), (await page.locator('#text').inputValue()) === 'typing while a message moves');
  await page.locator('#text').fill('');

  // ---- multi-choice card
  const multi = await asked(`Multi ${label}`, [{ label: 'One', recommended: true }, { label: 'Two' }, { label: 'Three' }], { multi: true });
  await page.goto(`${origin}/__feedback/inbox/#/${multi.id}`);
  await page.waitForSelector('#msgs .qcard');
  check(tag('a multi card has checkboxes and a Recommended mark'), (await page.locator('#msgs .qcard input[type=checkbox]').count()) === 3 && (await page.locator('#msgs .qopt .rec').count()) === 1);
  await page.locator('#msgs .qother').fill('typed');
  await page.locator('#msgs .qcard input[type=checkbox]').first().check();
  check(tag('picking an option clears Other with a visible hint'), (await page.locator('#msgs .qother').inputValue()) === '' && (await page.locator('#msgs .qhint').innerText()).includes('cleared'));
  await shot('multi-card');

  // ---- reactions
  const rid = (await store.createThread(alpha, { title: `React ${label}`, text: 'I finished it.', origin: 'agent', flag: 'fyi' })).id;
  await page.goto(`${origin}/__feedback/inbox/#/${rid}`);
  await page.waitForSelector('#msgs .react');
  await page.locator('#msgs .react[aria-label="Thumbs up"]').click();
  check(tag('a thumbs up is an event, not a message'), await until(async () => (await store.readReactions(join(alpha, rid))).m1?.thumbs_up !== undefined) && (await store.summarise(alpha, rid)).messages.length === 1);
  await page.getByRole('button', { name: 'Done, close it' }).click();
  check(tag('Done, close it closes the thread'), await until(async () => (await store.summarise(alpha, rid)).summary.status === 'done'));
  await shot('reactions');

  // ---- Waiting on you across projects, and the Move chip
  await store.createThread(beta, { title: `Beta asks ${label}`, text: 'Pick?', origin: 'agent', question: { prompt: 'Pick one?', options: [{ label: 'a' }] } });
  const capture = async url => (await (await fetch(`${origin}/__feedback/api/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: `capture on ${url}`, mode: 'page', image: PNG, context: { url } }) })).json()).id;
  const toBeta = await capture('http://beta.test/app/billing');
  const toAlpha = await capture('http://alpha.test/home');
  const lost = await capture('http://beta.test/other');
  check(tag('captures land in the project whose rule matches'), (await store.listThreads(beta)).some(t => t.id === toBeta) && (await store.listThreads(alpha)).some(t => t.id === toAlpha));
  await page.goto(`${origin}/__feedback/inbox/#/`);
  await page.waitForSelector('#waiting-all');
  await until(async () => (await page.locator('#waiting-all-count').innerText()) !== '');
  await page.locator('#waiting-all').click();
  await page.waitForSelector('#waiting-all-dialog[open] .wa-row');
  await until(async () => (await page.locator('#waiting-all-list .wa-group h3').allInnerTexts()).includes('Beta'));
  const projectsListed = await page.locator('#waiting-all-list .wa-group h3').allInnerTexts();
  check(tag(`Waiting on you lists every project (${projectsListed.join(',')})`), projectsListed.includes('Alpha') && projectsListed.includes('Beta'));
  await shot('waiting-on-you');
  await page.locator('#waiting-all-list .wa-group[data-project="beta"] .wa-row').first().click();
  check(tag('a row opens its thread in the other project'), await until(async () => (await page.locator('#title').innerText()).startsWith('Beta asks')));
  await page.evaluate(() => localStorage.setItem('fb-inbox-project', 'alpha')); // the row above switched the inbox to Beta
  await page.goto(`${origin}/__feedback/inbox/#/${lost}`);
  await page.reload(); // a hash change alone does not reload the page, and the inbox remembers its project
  await page.waitForSelector('#move-chip:not([hidden])');
  check(tag('an unmatched capture offers Move to the best project'), (await page.locator('#move-chip').innerText()).includes('Beta'));
  await shot('move-chip');
  await page.locator('#move-chip').click();
  check(tag('one tap moves it'), await until(async () => (await store.listThreads(beta)).some(t => t.id === lost)));
  // the inbox then switches to Beta and opens the moved thread: wait for that before going on
  check(tag('and the inbox follows it to Beta'), await until(async () => (await page.evaluate(() => localStorage.getItem('fb-inbox-project'))) === 'beta' && (await page.evaluate(() => location.hash)).includes(lost) && (await page.locator('#title').innerText().catch(() => '')) !== ''));

  // ---- Answers given offline
  const off = await asked(`Offline ${label}`);
  await openAlpha(off.id);
  await page.waitForSelector('#msgs .qcard');
  await context.setOffline(true);
  await page.locator('#msgs .qopt', { hasText: 'Draw new' }).click();
  await page.waitForSelector('#msgs .qpending');
  check(tag('an answer given offline waits, and the card says so'), (await page.locator('#msgs .qpending').innerText()).includes("will send when you're back online") && (await store.summarise(alpha, off.id)).messages.every(m => !m.answer));
  await shot('offline-answer');
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  check(tag('back online it is posted'), await until(async () => (await store.summarise(alpha, off.id)).messages.filter(m => m.answer).length === 1));
  await poll(page); await page.waitForTimeout(400);
  check(tag('and only once'), (await store.summarise(alpha, off.id)).messages.filter(m => m.answer).length === 1);
  const gone = await asked(`Offline gone ${label}`);
  await openAlpha(gone.id);
  await page.waitForSelector('#msgs .qcard');
  await context.setOffline(true);
  await page.locator('#msgs .qopt', { hasText: 'Reuse' }).click();
  await page.waitForSelector('#msgs .qpending');
  await store.cancelQuestion(alpha, gone.id, gone.qid, 'withdrawn meanwhile', { force: true });
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForSelector('#msgs .qrescue .qother');
  check(tag('a question withdrawn meanwhile keeps the answer, with Send as a message'), (await page.locator('#msgs .qrescue .qother').inputValue()) === 'Reuse' && (await page.getByRole('button', { name: 'Send as a message' }).count()) > 0);
  await shot('offline-answer-kept');

  // ---- Offline in the second project: the answer and the message go to Beta, never to the first project
  const bq = (await store.createThread(beta, { title: `Beta offline ${label}`, text: 'Start', origin: 'user' })).id;
  await store.appendMessage(beta, bq, { author: 'agent', text: 'Which?', question: { prompt: 'Which?', options: [{ label: 'Reuse' }, { label: 'Draw new' }] }, flag: 'needs_you' });
  await page.evaluate(() => localStorage.setItem('fb-inbox-project', 'beta'));
  await page.goto(`${origin}/__feedback/inbox/#/${bq}`);
  await page.reload();
  await page.waitForSelector('#msgs .qcard');
  await context.setOffline(true);
  await page.locator('#msgs .qopt', { hasText: 'Draw new' }).click();
  await page.waitForSelector('#msgs .qpending');
  await page.locator('#text').fill('a note written offline in Beta');
  await page.locator('#send').click();
  await page.waitForSelector('#msgs [data-queued]:not(.qpending)');
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  check(tag('an offline answer in Beta is delivered to Beta'), await until(async () => (await store.summarise(beta, bq)).messages.filter(m => m.answer).length === 1));
  check(tag('an offline message in Beta is delivered to Beta'), await until(async () => (await store.summarise(beta, bq)).messages.some(m => m.text === 'a note written offline in Beta')));
  check(tag('and nothing of it went to the first project'), (await store.listThreads(alpha)).every(t => t.id !== bq));

  // ---- Copy
  const copyId = (await store.createThread(alpha, { title: `Copy ${label}`, text: '**Bold** and `code`\n\n- one\n- two', origin: 'agent', flag: 'fyi' })).id;
  await openAlpha(copyId);
  await page.waitForSelector('#msgs .msg');
  await page.evaluate(() => { window.__copied = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async t => { window.__copied.push(t); } } }); });
  if (wide) await page.locator('#msgs .msg').first().hover();
  await (wide ? page.locator('#msgs .msg .copy-btn').first().click() : (async () => { await page.locator('#msgs .msg .msg-actions').first().tap(); await page.getByRole('menuitem', { name: 'Copy' }).tap(); })());
  await page.waitForSelector('#toast:not([hidden])');
  check(tag('Copy puts the Markdown on the clipboard and says Copied'), (await page.evaluate(() => window.__copied[0])) === '**Bold** and `code`\n\n- one\n- two' && (await page.locator('#toast').innerText()) === 'Copied');
  check(tag(wide ? 'a copy icon sits beside Reply' : 'native text selection is allowed in a message body'), wide ? (await page.locator('#msgs .msg .copy-btn + .reply-btn').count()) === 1 : (await page.evaluate(() => getComputedStyle(document.querySelector('#msgs .msg p')).userSelect !== 'none')));
  await shot('copy');

  // ---- the phone's bottom gap
  if (!wide) {
    await openAlpha(t1.id);
    await page.waitForSelector('#text');
    const gap = () => page.evaluate(() => { const r = document.getElementById('text').getBoundingClientRect(); return Math.round(window.innerHeight - r.bottom); });
    const normal = await gap();
    check(tag(`the composer sits close to the bottom edge in a normal tab (${normal}px)`), normal >= 8 && normal <= 24);
    await shot('composer-bottom');
    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'display-mode', value: 'standalone' }] });
      const standalone = await page.evaluate(() => matchMedia('(display-mode: standalone)').matches);
      if (standalone) { const g = await gap(); check(tag(`standalone display mode keeps the inset rule (${g}px, no inset in this browser)`), g >= 8 && g <= 24); await shot('composer-bottom-standalone'); }
      else console.log('skip', tag('display-mode: standalone cannot be emulated in this browser; checked the rule in the stylesheet instead'));
    } catch { console.log('skip', tag('display-mode emulation is not available here')); }
    const rule = await page.evaluate(() => [...document.styleSheets].flatMap(s => [...s.cssRules]).some(r => r.media?.mediaText?.includes('display-mode') && r.cssText.includes('safe-area-inset-bottom')));
    check(tag('the safe-area inset is applied only under a standalone or fullscreen display mode'), rule);
  }
  check(tag('no page errors'), errors.length === 0);
  await context.close();
}

try {
  await scenario('390', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await scenario('1280', { viewport: { width: 1280, height: 800 } });
} finally { await browser.close(); server.stop(true); }
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);
