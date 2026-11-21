import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from './server';
import { run } from './cli';
import { packageVersion } from './version';
import { offeredVersion, updateBannerText } from './inbox/version.js';

let dir: string;
let handle: ReturnType<typeof createHandler>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'feedback-rf9-'));
  handle = createHandler(dir);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test('config includes the package version', async () => {
  const body = await (await handle(new Request('http://local/__feedback/api/config'))).json();
  expect(body.version).toBe(packageVersion());
  expect(typeof body.version).toBe('string');
  expect(body.version).toBe('0.16.2');
});

test('the inbox page is stamped with the package version', async () => {
  const html = await (await handle(new Request('http://local/__feedback/inbox/'))).text();
  const version = packageVersion();
  expect(html).toContain(`<meta name="rf-version" content="${version}">`);
  expect(html).toContain(`react-feedback v${version}`);
  const script = await (await handle(new Request('http://local/__feedback/inbox/version.js'))).text();
  expect(script).toContain('offeredVersion');
});

test('--version prints the package version and writes nothing', async () => {
  const missing = join(dir, 'absent');
  expect(await run(['--version'], missing)).toBe(packageVersion());
  await expect(stat(missing)).rejects.toThrow();
});

test('an update is offered only when the versions differ, and a dismiss holds for that version', () => {
  expect(offeredVersion('0.8.2', '0.8.2', null)).toBeNull();
  expect(offeredVersion('0.8.2', '0.8.3', null)).toBe('0.8.3');
  expect(offeredVersion('0.8.2', '0.8.3', '0.8.3')).toBeNull();
  expect(offeredVersion('0.8.2', '0.8.4', '0.8.3')).toBe('0.8.4');
  expect(offeredVersion('', '0.8.3', null)).toBeNull();
  expect(offeredVersion('0.8.2', '', null)).toBeNull();
  expect(offeredVersion('0.8.2', 'https://example.invalid/x', null)).toBeNull();
  expect(updateBannerText('0.8.3')).toBe('A new version (v0.8.3) is ready. Reload to update');
  expect(updateBannerText('v0.8.3')).toBe('A new version (v0.8.3) is ready. Reload to update');
});
