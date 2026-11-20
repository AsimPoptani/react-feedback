// 0.10.1 in the inbox page (happy-dom): project badges, the heading, the closed-question line, and the merged composer.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync('server/inbox/index.html', 'utf8');
const body = html.slice(html.indexOf('<body'), html.indexOf('<script type="module"')).replace(/<body[^>]*>/, '');
const at = (n: number) => `2026-11-20T10:2${n}:00.000Z`;
const threadId = '20261120-100000-abcd';
let projects: { id: string; name: string; unread: number; has_icon?: boolean }[] = [];
let mergedInto: string | null = null;
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const question = { id: 'q2', prompt: 'A very long question that could easily push the show button onto a second line of text', multi: false, allow_other: false, options: [{ id: 'o1', label: 'A' }], withdrawn: { at: at(2) } };
const thread = () => ({ id: threadId, title: 'T', origin: 'user', mode: 'thread', status: 'open', created_at: at(0), url: null, last_message_at: at(1), last_author: 'agent',
  unread_for_user: false, user_read_at: at(1), agent_read_at: at(1), open_question: false, waiting: 'agent', last_flag: null, checklist: { total: 0, done: 0, claimed: 0 }, open_for_you: 0,
  merged_into: mergedInto, read_only: false, acked_through: null, viewport: null, target: null, note: '', checklist_items: [], files: { image: false, annotated: false, context: false },
  messages: [{ id: 'm1', author: 'user', text: 'Hi', images: [], created_at: at(0) }, { id: 'm2', author: 'agent', text: question.prompt, images: [], created_at: at(1), question }] });

async function load() {
  vi.resetModules();
  document.body.innerHTML = body;
  location.hash = `#/${threadId}`;
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url, 'http://local').pathname.replace(/^.*\/api\//, '');
    const reply = (data: unknown) => ({ ok: true, status: 200, json: async () => data, headers: { get: () => null } });
    if (path === 'threads') return reply([{ ...thread(), messages: undefined }]);
    if (path.startsWith('threads/')) return reply(thread());
    if (path === 'projects') return reply({ projects });
    if (path === 'profile') return reply({ user: { name: 'You' }, agent: { name: 'Agent' } });
    if (path === 'pins') return reply({ threads: [], areas: [] });
    if (path === 'areas') return reply({ areas: [] });
    return reply({});
  }));
  await import('../inbox/app.js');
  await vi.waitFor(() => expect(document.querySelector('.msg, .qclosed') || $('project-name').textContent).toBeTruthy());
  await new Promise(r => setTimeout(r, 20));
}

describe('project badges', () => {
  beforeEach(() => { mergedInto = null; });
  it('draw initials and a stable colour in the button and every menu row, and an image when has_icon', async () => {
    projects = [{ id: 'aa', name: 'Acme App', unread: 0 }, { id: 'rf', name: 'react-feedback', unread: 2, has_icon: true }, { id: 'solo', name: 'Alpha', unread: 0 }];
    await load();
    const badge = $('project-badge');
    expect(badge.textContent).toBe('AA');
    const colour = badge.style.getPropertyValue('--pb');
    expect(colour).toMatch(/^#[0-9a-f]{6}$/);
    const rows = [...document.querySelectorAll('#project-menu .pbadge')] as HTMLElement[];
    expect(rows.length).toBe(3);
    expect(rows[0]!.textContent).toBe('AA');
    expect(rows[0]!.style.getPropertyValue('--pb')).toBe(colour); // the same project, the same colour
    expect(rows[1]!.querySelector('img')?.getAttribute('src')).toContain('projects/rf/icon');
    expect(rows[2]!.textContent).toBe('AL');
    expect(document.querySelector('#project-menu')!.innerHTML).not.toContain('icon.png');
  });
  it('hides the heading with two projects and keeps it with one', async () => {
    projects = [{ id: 'a', name: 'A', unread: 0 }, { id: 'b', name: 'B', unread: 0 }];
    await load();
    expect($('app-title').hidden).toBe(true);
    projects = [{ id: 'a', name: 'A', unread: 0 }];
    await load();
    expect($('app-title').hidden).toBe(false);
    expect($('project-switch').hidden).toBe(true);
  });
});

describe('closed question line and merged composer', () => {
  it('keeps show on one line (css) and the text truncating', () => {
    expect(html).toMatch(/\.show \{[^}]*flex-shrink: 0;[^}]*white-space: nowrap/);
    expect(html).toMatch(/\.qclosed \.qsum \{[^}]*text-overflow: ellipsis[^}]*white-space: nowrap/);
  });
  it('keeps Attach image and Attach file enabled on a merged-away thread (0.12.0: what is sent there is forwarded)', async () => {
    projects = [{ id: 'a', name: 'A', unread: 0 }];
    mergedInto = null;
    await load();
    expect(($('attach-file') as HTMLButtonElement).disabled).toBe(false);
    mergedInto = '20261120-100001-abce';
    await load();
    await vi.waitFor(() => expect(($('merged-banner') as HTMLElement).hidden).toBe(false));
    expect(($('attach') as HTMLButtonElement).disabled).toBe(false);
    expect(($('attach-file') as HTMLButtonElement).disabled).toBe(false);
  });
});
