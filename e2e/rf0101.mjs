// Browser test for 0.10.1: project badges and pictures in the closed and open project menu at 390 and 1280 wide.
// Needs Playwright (PLAYWRIGHT=/path/to/playwright/index.mjs). Run: bun e2e/rf0101.mjs   (SHOTS=/some/dir saves the screenshots there)
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const root = await mkdtemp(join(tmpdir(), 'rf0101-e2e-'));
const dirs = ['field', 'react', 'plain'].map(name => join(root, name));
// A small orange-and-navy PNG, built here so the test needs no binary file.
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4); return out; };
const size = 64, rows = [];
for (let y = 0; y < size; y++) { const row = Buffer.alloc(1 + size * 3); for (let x = 0; x < size; x++) { const on = (x + y) % 32 < 16; row.set(on ? [240, 140, 30] : [20, 40, 90], 1 + x * 3); } rows.push(row); }
const head = Buffer.alloc(13); head.writeUInt32BE(size, 0); head.writeUInt32BE(size, 4); head[8] = 8; head[9] = 2;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
const iconFile = join(root, 'logo.png');
await writeFile(iconFile, png);
delete process.env.FEEDBACK_PROJECT;
process.env.FEEDBACK_DIR = dirs[0];
process.env.FEEDBACK_PROJECTS = JSON.stringify([
  { id: 'acme-app', name: 'Acme App', dir: dirs[0] },
  { id: 'react-feedback', name: 'react-feedback', dir: dirs[1], icon: iconFile },
  { id: 'plain', name: 'Plain', dir: dirs[2] },
]);
const SHOTS = process.env.SHOTS ?? join(root, 'shots');
await mkdir(SHOTS, { recursive: true });
const store = await import('../server/store.ts');
const { serverOptions } = await import('../server/server.ts');
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
await store.createThread(dirs[0], { title: 'First thread', text: 'Hello', origin: 'user' });
const server = Bun.serve({ ...serverOptions(), hostname: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch();
let failed = 0;
const check = (name, ok) => { console.log(ok ? 'ok  ' : 'FAIL', name); if (!ok) failed++; };

async function walk(width, height, tap) {
  const context = await browser.newContext({ viewport: { width, height }, ...(tap ? { hasTouch: true, isMobile: true } : {}) });
  const page = await context.newPage();
  await page.goto(`${origin}/__feedback/inbox/#/`);
  await page.waitForSelector('#project-button');
  check(`${width}: the heading is gone and the badge is in the button`, !(await page.locator('#app-title').isVisible()) && (await page.locator('#project-badge').innerText()) === 'AA');
  await page.locator('.project-switch').screenshot({ path: join(SHOTS, `projects-closed-${width}.png`) });
  await page.locator('#project-button')[tap ? 'tap' : 'click']();
  await page.waitForSelector('#project-menu:not([hidden])');
  const rows = page.locator('#project-menu .pbadge');
  check(`${width}: every row has a badge`, (await rows.count()) === 3);
  check(`${width}: the one with an icon shows its picture, the others the initials`, await page.evaluate(() => {
    const badges = [...document.querySelectorAll('#project-menu .pbadge')];
    const img = badges[1].querySelector('img');
    return !!img && img.complete && img.naturalWidth === 64 && badges[0].textContent === 'AA' && badges[2].textContent === 'PL' && !badges[0].querySelector('img');
  }));
  const size28 = await rows.first().evaluate(node => node.getBoundingClientRect().width);
  check(`${width}: a list badge is 28 px`, Math.round(size28) === 28);
  await page.locator('#project-menu').screenshot({ path: join(SHOTS, `projects-open-${width}.png`) });
  await page.screenshot({ path: join(SHOTS, `projects-open-page-${width}.png`) });
  check(`${width}: no sideways scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await context.close();
}

try {
  const icon = await fetch(`${origin}/__feedback/api/projects/react-feedback/icon`);
  check('the icon is served as a PNG with nosniff', icon.status === 200 && icon.headers.get('content-type') === 'image/png' && icon.headers.get('x-content-type-options') === 'nosniff');
  const list = await (await fetch(`${origin}/__feedback/api/projects`)).text();
  check('the list says has_icon and never the path', list.includes('"has_icon":true') && !list.includes(root));
  await walk(390, 844, true);
  await walk(1280, 800, false);
} finally { await browser.close(); server.stop(true); }
console.log(`screenshots: ${SHOTS}`);
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log('all checks passed');
