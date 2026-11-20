// Browser test for 0.9.4: files of any type, uploaded in chunks, at 390 and 1280 wide.
// A test proxy in front of the server rejects any request body over 50 MB (like a tunnel with a per-request limit), so a 70 MB file only gets through because it goes up in chunks.
// Needs Playwright (PLAYWRIGHT=/path/to/playwright/index.mjs) and a built dist/. Run: bun e2e/attach.mjs   (SHOTS=/some/dir also saves screenshots)
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'attach-e2e-'));
const dataDir = join(root, 'data');
process.env.FEEDBACK_DIR = dataDir;
const SHOTS = process.env.SHOTS;
if (SHOTS) await mkdir(SHOTS, { recursive: true });
const store = await import('../server/store.ts');
const { serverOptions } = await import('../server/server.ts');
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');

const PROXY_LIMIT = 50 * 1024 * 1024;
let delayPut = 0, diskFull = false, oversized = 0;
const options = serverOptions({ FEEDBACK_DIR: dataDir });
const server = Bun.serve({ ...options, hostname: '127.0.0.1', port: 0, maxRequestBodySize: 200 * 1024 * 1024, fetch: async req => {
  const length = Number(req.headers.get('content-length') ?? 0);
  if (length > PROXY_LIMIT) { oversized++; return new Response('Request Entity Too Large (the proxy)', { status: 413 }); }
  if (req.method === 'PUT') {
    if (delayPut) await new Promise(resolve => setTimeout(resolve, delayPut));
    if (diskFull) { await req.arrayBuffer(); return Response.json({ kind: 'invalid_request', detail: 'Not enough disk space on the server' }, { status: 507 }); }
  }
  return options.fetch(req);
} });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch();
let failed = 0;
const check = (name, ok) => { console.log(ok ? 'ok  ' : 'FAIL', name); if (!ok) failed++; };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The files to send.
const src = join(root, 'src'); await mkdir(src);
const bigPath = join(src, 'dataset-70mb.bin');
const big = Buffer.alloc(70 * 1024 * 1024); for (let i = 0; i < big.length; i += 4096) big.writeUInt32LE((i * 2654435761) >>> 0, i);
await writeFile(bigPath, big);
const zipBytes = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(2048, 7)]);
await writeFile(join(src, 'results.zip'), zipBytes);
const pdfText = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 24 Tf 40 100 Td (Field notes) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
await writeFile(join(src, 'report.pdf'), pdfText);
const smallPath = join(src, 'notes-small.txt'); await writeFile(smallPath, 'a small file that waits offline\n'.repeat(40));

async function scenario(label, context, viewport) {
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  const { id } = await store.createThread(dataDir, { title: `Files ${label}`, text: 'Send me anything', origin: 'agent' });
  const shot = name => SHOTS ? page.screenshot({ path: join(SHOTS, `${name}-${viewport}.png`) }) : null;
  const phone = viewport < 760;
  await page.goto(`${origin}/__feedback/inbox/#/${id}`);
  await page.waitForSelector('#msgs .msg');
  const attach = async paths => {
    if (phone) { // the system file picker, from the paperclip beside the +
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#attach-file').tap()]);
      await chooser.setFiles(paths);
    } else await page.locator('#file-any').setInputFiles(paths);
  };
  check(`${label}: the file input takes any type (no accept filter)`, (await page.locator('#file-any').getAttribute('accept')) === null);
  check(`${label}: a paperclip button is ${phone ? 'beside the + button' : 'next to the image control'}`, await page.locator('#attach-file').isVisible() && (phone ? await page.locator('#plus').isVisible() : await page.locator('#attach').isVisible()));

  // 1. A 70 MB file through the proxy: it only arrives because it goes up in chunks. Progress, then ready.
  delayPut = 1200;
  await attach([bigPath]);
  await page.waitForSelector('.fchip[data-state="uploading"]');
  await page.waitForFunction(() => { const n = document.querySelector('.fchip .fbar'); return n && Number(n.getAttribute('aria-valuenow')) >= 30; });
  const pct = Number(await page.locator('.fchip .fbar').getAttribute('aria-valuenow'));
  check(`${label}: a progress bar moves while the file goes up (${pct}%)`, pct >= 30 && pct < 100);
  await page.locator('#msgs').evaluate(node => { node.parentElement.scrollTop = 0; });
  const inView = await page.locator('.fchip').boundingBox();
  check(`${label}: the progress stays visible while the thread is scrolled`, !!inView && inView.y >= 0 && inView.y + inView.height <= page.viewportSize().height);
  await shot('progress');
  await page.waitForSelector('.fchip[data-state="done"]', { timeout: 60000 });
  delayPut = 0;
  check(`${label}: the 70 MB file finished although the proxy refuses bodies over 50 MB`, await page.locator('.fchip[data-state="done"] .fname').innerText() === 'dataset-70mb.bin');
  await shot('attach');
  await page.locator('#text').fill('Here is the dataset');
  await page.locator('#send').click();
  await page.waitForSelector('.file-card[data-attachment]');
  let saved = (await store.summarise(dataDir, id)).messages.at(-1).attachments?.[0];
  check(`${label}: the message holds the file with the right size and checksum`, !!saved && saved.size === big.length && saved.sha256 === sha(big));
  check(`${label}: the proxy never saw a request over its limit`, oversized === 0);
  check(`${label}: the composer is clear after sending`, (await page.locator('.fchip').count()) === 0);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.file-card[data-attachment] a.fdl').first().click()]);
  const downloaded = join(root, `got-${label}.bin`); await download.saveAs(downloaded);
  check(`${label}: the downloaded file is byte for byte the one sent`, sha(await readFile(downloaded)) === sha(big));
  await rm(downloaded);

  // 2. A zip is a chip with a name, a size and Download: no picture, no preview.
  await attach([join(src, 'results.zip')]);
  await page.waitForSelector('.fchip[data-state="done"]');
  await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelectorAll('.file-card[data-attachment]').length >= 2);
  const zipCard = page.locator('.file-card[data-attachment]').filter({ hasText: 'results.zip' });
  check(`${label}: a zip is a chip with its name, its size and Download only`, await zipCard.locator('a.fdl').isVisible() && (await zipCard.locator('iframe, img, button').count()) === 0 && (await zipCard.innerText()).includes('2.0 KB'));
  await zipCard.scrollIntoViewIfNeeded();
  await shot('chip');
  const zipId = await zipCard.getAttribute('data-attachment');
  const headers = (await page.request.get(`${origin}/__feedback/api/threads/${id}/attachments/${zipId}`)).headers();
  check(`${label}: a download is an attachment, nosniff, sandboxed, with no cookie`, headers['content-disposition']?.startsWith('attachment;') && headers['x-content-type-options'] === 'nosniff' && headers['content-security-policy'] === "sandbox; default-src 'none'" && !headers['set-cookie'] && headers['content-type'] === 'application/octet-stream');

  // 3. A PDF previews in a frame with an empty sandbox, and keeps its Download.
  await attach([join(src, 'report.pdf')]);
  await page.waitForSelector('.fchip[data-state="done"]');
  await page.locator('#send').click();
  const pdfCard = page.locator('.file-card.pdf');
  await pdfCard.waitFor();
  await pdfCard.getByRole('button', { name: /Preview/ }).click();
  const frame = pdfCard.locator('iframe');
  await frame.waitFor();
  check(`${label}: the PDF preview frame has an empty sandbox and the inline preview address`, (await frame.getAttribute('sandbox')) === '' && (await frame.getAttribute('src')).includes('inline=1'));
  check(`${label}: the PDF still has a Download beside the preview`, await pdfCard.locator('a.fdl').isVisible());
  await sleep(500);
  await pdfCard.scrollIntoViewIfNeeded();
  await shot('pdf');
  const pdfId = await pdfCard.getAttribute('data-attachment');
  const preview = await page.request.get(`${origin}/__feedback/api/threads/${id}/attachments/${pdfId}?inline=1`);
  check(`${label}: only the PDF preview is inline, and it is sandboxed`, preview.headers()['content-disposition']?.startsWith('inline;') && preview.headers()['content-security-policy'] === "sandbox; default-src 'none'");

  // 4. Cancel, then a refusal with Retry.
  delayPut = 2500;
  await attach([bigPath]);
  await page.waitForSelector('.fchip[data-state="uploading"]');
  await page.locator('.fchip button', { hasText: 'Cancel' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.fchip').length === 0);
  await sleep(300);
  check(`${label}: Cancel removes the chip and the partial upload on the server`, (await readdir(join(dataDir, '_uploads')).catch(() => [])).length === 0);
  delayPut = 0; diskFull = true;
  await attach([join(src, 'results.zip')]);
  await page.waitForSelector('.fchip[data-state="error"]');
  check(`${label}: a refusal shows its reason and a Retry`, (await page.locator('.fchip .fmeta').innerText()).includes('Not enough disk space on the server') && await page.getByRole('button', { name: /^Retry/ }).isVisible());
  await shot('error');
  diskFull = false;
  await page.getByRole('button', { name: /^Retry/ }).click();
  await page.waitForSelector('.fchip[data-state="done"]');
  check(`${label}: Retry resumes and finishes the upload`, true);
  await page.locator('.fchip button', { hasText: 'Remove' }).click();

  // 5. Drag and drop, and paste, a file.
  await page.evaluate(() => {
    const data = new DataTransfer(); data.items.add(new File(['dropped'], 'dropped.csv', { type: 'text/csv' }));
    document.getElementById('thread-main').dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await page.waitForSelector('.fchip .fname:text("dropped.csv")');
  await page.evaluate(() => {
    const data = new DataTransfer(); data.items.add(new File(['pasted'], 'pasted.log', { type: 'text/plain' }));
    document.getElementById('text').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.waitForSelector('.fchip .fname:text("pasted.log")');
  check(`${label}: a dropped file and a pasted file each get a chip`, (await page.locator('.fchip').count()) === 2);
  await page.waitForFunction(() => [...document.querySelectorAll('.fchip')].every(c => c.dataset.state === 'done'));
  await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelectorAll('.file-card[data-attachment]').length >= 5);

  // 6. Offline: a small file waits with the message; a big one says it needs a connection.
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await attach([join(src, 'notes-small.txt')]);
  await page.waitForSelector('.fchip[data-state="local"]');
  check(`${label}: offline, a small file is held for the message`, (await page.locator('.fchip .fmeta').innerText()).includes('uploads with the message when you are online'));
  await page.locator('#text').fill('Sent while offline');
  await page.locator('#send').click();
  await page.waitForSelector('article.queued');
  check(`${label}: offline, the message waits in the queue with its file`, (await page.locator('article.queued').innerText()).includes('notes-small.txt'));
  await shot('offline');
  await attach([bigPath]);
  await page.waitForSelector('.fchip[data-state="error"]');
  check(`${label}: offline, a file over 50 MB says it needs a connection`, (await page.locator('.fchip .fmeta').innerText()).includes('Needs a connection'));
  await page.locator('.fchip button', { hasText: 'Remove' }).click();
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => document.querySelectorAll('article.queued').length === 0, null, { timeout: 60000 });
  const after = (await store.summarise(dataDir, id)).messages.at(-1);
  check(`${label}: back online, the queued message and its file arrived`, after.text === 'Sent while offline' && after.attachments?.[0]?.name === 'notes-small.txt');
  const staged = await readdir(join(dataDir, '_uploads')).catch(() => []);
  check(`${label}: nothing is left in the upload staging folder`, staged.length === 0);
  check(`${label}: no sideways scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  check(`${label}: no script errors`, errors.length === 0);
  if (errors.length) console.log(errors);
  await page.close();
}

try {
  await scenario('phone', await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, acceptDownloads: true }), 390);
  await scenario('wide', await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true }), 1280);
  // The proxy really does refuse a single big request (what the chunking is for).
  const big60 = await fetch(`${origin}/__feedback/api/threads`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(60 * 1024 * 1024) });
  check('the test proxy refuses a 60 MB request body', big60.status === 413);
  await stat(dataDir);
} finally { await browser.close(); server.stop(true); await rm(root, { recursive: true, force: true }); }
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
