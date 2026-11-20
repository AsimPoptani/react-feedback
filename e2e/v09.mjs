// Browser test for 0.9: artifact card, viewer, share dialog, shared pill, pinned question, project switch, and the sandbox.
// Needs Playwright (PLAYWRIGHT=/path/to/playwright/index.mjs). Run: bun e2e/v09.mjs   (SHOTS=/some/dir also saves screenshots)
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'v09-e2e-'));
const alpha = join(root, 'alpha');
const beta = join(root, 'beta');
delete process.env.FEEDBACK_PROJECT;
process.env.FEEDBACK_DIR = alpha;
process.env.FEEDBACK_PROJECTS = JSON.stringify([
  { id: 'alpha', name: 'Alpha', dir: alpha },
  { id: 'beta', name: 'Beta', dir: beta },
]);
const SHOTS = process.env.SHOTS ?? join(root, 'shots');
await mkdir(SHOTS, { recursive: true });
const store = await import('../server/store.ts');
const artifacts = await import('../server/artifacts.ts');
const { serverOptions } = await import('../server/server.ts');
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');

const { id } = await store.createThread(alpha, { title: 'Options for review', text: 'Three ways to ship this.', origin: 'user' });
await store.appendMessage(alpha, id, { author: 'agent', text: 'Which option should we ship?', question: { prompt: 'Which option should we ship?', options: [{ label: 'The small one' }, { label: 'The thorough one' }] }, flag: 'needs_you' });
const probe = `<!doctype html><html><head><title>Options</title></head><body><p>Options for review</p><script>
const report = { storage: 'open', cookie: 'open', fetch: 'open' };
try { report.storage = parent.localStorage.getItem('inbox-secret'); } catch (e) { report.storage = 'blocked'; }
try { report.cookie = String(parent.document.cookie); } catch (e) { report.cookie = 'blocked'; }
fetch('/__feedback/api/threads').then(function () { report.fetch = 'read'; parent.postMessage(report, '*'); }).catch(function () { report.fetch = 'blocked'; parent.postMessage(report, '*'); });
</script></body></html>`;
const meta = await artifacts.publishArtifact(alpha, { thread: id, title: 'Options for review', content: probe, format: 'html' });
await store.createThread(beta, { title: 'Beta notes', text: 'Only in beta', origin: 'user' });

const server = Bun.serve({ ...serverOptions(), hostname: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch();
let failed = 0;
const check = (name, ok) => { console.log(ok ? 'ok  ' : 'FAIL', name); if (!ok) failed++; };
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
const shotOf = (locator, name) => locator.screenshot({ path: join(SHOTS, `${name}.png`) });

async function sandbox(page) {
  await page.evaluate(() => { localStorage.setItem('inbox-secret', 'top-secret'); document.cookie = 'session=secret; path=/'; });
  return page.evaluate(src => new Promise(resolve => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts allow-popups');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    const timer = setTimeout(() => resolve({ storage: 'timeout', cookie: 'timeout', fetch: 'timeout' }), 5000);
    window.addEventListener('message', event => { clearTimeout(timer); resolve(event.data); }, { once: true });
    frame.src = src;
    document.body.append(frame);
  }), `/__feedback/a/${meta.id}/v1`);
}

async function walk(page, width, tap) {
  const act = tap ? 'tap' : 'click';
  await page.goto(`${origin}/__feedback/inbox/#/`);
  await page.waitForSelector('#project-button');
  check(`${width}: the project menu is at the top`, await page.locator('#project-name').innerText() === 'Alpha');
  await page.locator('#project-button')[act]();
  await page.locator('#project-menu button', { hasText: 'Beta' })[act]();
  await page.waitForSelector('text=Beta notes');
  check(`${width}: switching projects shows only that project's threads`, await page.locator('text=Options for review').count() === 0);
  await page.locator('#project-button')[act]();
  await page.locator('#project-menu button', { hasText: 'Alpha' })[act]();
  await page.waitForSelector('text=Options for review');
  await page.locator(`a[href="#/${id}"]`)[act]();
  await page.waitForSelector('.art-card');
  check(`${width}: the artifact card shows the title, version and Open`, (await page.locator('.art-card').innerText()).includes('Options for review') && (await page.locator('.art-card').innerText()).includes('v1'));
  check(`${width}: the pinned question bar is above the composer`, await page.evaluate(() => {
    const bar = document.getElementById('waiting-bar').getBoundingClientRect();
    const composer = document.getElementById('composer').getBoundingClientRect();
    return bar.height > 0 && bar.bottom <= composer.top + 1 && document.documentElement.scrollWidth <= document.documentElement.clientWidth;
  }));
  await shotOf(page.locator('.art-card'), `card-${width}`);
  await shotOf(page.locator('#waiting-bar'), `waiting-${width}`);
  await page.locator('.art-card a', { hasText: 'Open' })[act]();
  await page.waitForSelector('#artifact-frame');
  check(`${width}: the viewer iframe is sandboxed without the parent origin`, (await page.locator('#artifact-frame').getAttribute('sandbox')) === 'allow-scripts allow-popups');
  await shot(page, `viewer-${width}`);
  await page.locator('#artifact-share')[act]();
  await page.waitForSelector('#share-dialog[open]');
  await shotOf(page.locator('#share-dialog'), `share-${width}`);
  await page.locator('#share-create')[act]();
  await page.waitForSelector('#share-url:not([hidden])');
  const link = await page.locator('#share-url').innerText();
  await page.locator('#share-cancel')[act]();
  await page.waitForSelector('#artifact-pill:not([hidden])');
  check(`${width}: the pill counts the link`, /Shared · \d+ link/.test(await page.locator('#artifact-pill').innerText()));
  await page.locator('#artifact-pill')[act]();
  await page.waitForSelector('#manage-dialog[open]');
  check(`${width}: manage lists the link and Revoke`, (await page.locator('#manage-list').innerText()).includes('Revoke') && (await page.locator('#manage-list').innerText()).includes('you'));
  await shot(page, `manage-${width}`);
  await page.locator('#manage-close')[act]();
  const shared = await fetch(`${origin}${link.replace(origin, '')}`);
  check(`${width}: the share is noindex and sandboxed`, shared.headers.get('x-robots-tag') === 'noindex' && shared.headers.get('content-security-policy') === 'sandbox allow-scripts allow-popups' && !shared.headers.has('set-cookie'));
  await shared.text();
  const gone = await fetch(`${origin}/__feedback/s/not-a-token`);
  check(`${width}: an unknown token is a 404`, gone.status === 404);
}

try {
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
  const errors = [];
  phone.on('pageerror', error => errors.push(String(error)));
  await walk(phone, 390, true);
  const isolated = await sandbox(phone);
  check('sandbox: parent storage, cookies and the API are blocked', isolated.storage === 'blocked' && isolated.cookie === 'blocked' && isolated.fetch === 'blocked');
  check('phone: no page errors', errors.length === 0);

  const wide = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const wideErrors = [];
  wide.on('pageerror', error => wideErrors.push(String(error)));
  await walk(wide, 1280, false);
  check('desktop: no page errors', wideErrors.length === 0);
} finally { await browser.close(); server.stop(true); }
console.log(failed ? `${failed} FAILED` : 'all ok');
console.log('shots', SHOTS);
process.exit(failed ? 1 : 0);
