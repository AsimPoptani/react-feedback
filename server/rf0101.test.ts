// 0.10.1: project icons are served from one configured file, with the same care as other images.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from './server';
import { checkIcons, loadProjects, ICON_MAX_BYTES } from './projects';

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(64)]);
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'feedback-0101-')); await mkdir(join(root, 'a')); await mkdir(join(root, 'b')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const get = (handle: ReturnType<typeof createHandler>, path: string) => handle(new Request(`http://local/__feedback/${path}`));

test('the icon route serves the configured image and never exposes the path', async () => {
  await writeFile(join(root, 'logo.png'), PNG);
  const projects = [{ id: 'a', name: 'Alpha', dir: join(root, 'a'), icon: join(root, 'logo.png') }, { id: 'b', name: 'Beta', dir: join(root, 'b') }];
  const handle = createHandler(join(root, 'a'), undefined, { projects });
  const res = await get(handle, 'api/projects/a/icon');
  expect(res.status).toBe(200);
  expect(res.headers.get('Content-Type')).toBe('image/png');
  expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  expect((await get(handle, 'api/projects/b/icon')).status).toBe(404); // no icon configured
  expect((await get(handle, 'api/projects/zzz/icon')).status).toBe(404);
  const list = await (await get(handle, 'api/projects')).text();
  expect(JSON.parse(list).projects).toEqual([{ id: 'a', name: 'Alpha', unread: 0, has_icon: true }, { id: 'b', name: 'Beta', unread: 0 }]);
  expect(list).not.toContain(root);
  expect(list).not.toContain('logo.png');
});

test('SVG, an oversize file and a missing file are 404, with a single warning at startup', async () => {
  await writeFile(join(root, 'x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
  await writeFile(join(root, 'big.png'), Buffer.concat([PNG, Buffer.alloc(ICON_MAX_BYTES)]));
  const projects = [
    { id: 'a', name: 'A', dir: join(root, 'a'), icon: join(root, 'x.svg') },
    { id: 'b', name: 'B', dir: join(root, 'b'), icon: join(root, 'big.png') },
    { id: 'c', name: 'C', dir: join(root, 'c'), icon: join(root, 'missing.png') },
  ];
  const handle = createHandler(join(root, 'a'), undefined, { projects });
  for (const id of ['a', 'b', 'c']) expect((await get(handle, `api/projects/${id}/icon`)).status).toBe(404);
  const warnings: string[] = [];
  const checked = checkIcons(projects, message => warnings.push(message));
  expect(warnings.length).toBe(3);
  expect(checked.every(project => project.icon === undefined)).toBe(true);
  expect(warnings.join('\n')).not.toContain(root);
  const handled = createHandler(join(root, 'a'), undefined, { projects: checked });
  expect((await (await get(handled, 'api/projects')).json() as { projects: { has_icon?: boolean }[] }).projects.every(p => !p.has_icon)).toBe(true);
});

test('FEEDBACK_PROJECTS accepts icon as a path and nothing else is read; single-project mode has no icon route', async () => {
  const [project] = loadProjects({ FEEDBACK_PROJECTS: JSON.stringify([{ id: 'a', name: 'A', dir: join(root, 'a'), icon: join(root, 'logo.png') }]) });
  expect(project?.icon).toBe(join(root, 'logo.png'));
  expect(() => loadProjects({ FEEDBACK_PROJECTS: JSON.stringify([{ id: 'a', name: 'A', dir: join(root, 'a'), icon: 5 }]) })).toThrow();
  const handle = createHandler(join(root, 'a'));
  expect((await get(handle, 'api/projects/default/icon')).status).toBe(404);
  expect((await (await get(handle, 'api/projects')).json() as { projects: { has_icon?: boolean }[] }).projects[0]?.has_icon).toBeUndefined();
});
