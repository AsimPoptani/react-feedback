// 0.10.2 in the inbox page (happy-dom): the sidebar collapses to a rail, by button and by the [ key, and the choice is remembered.
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
  unread_for_user: true, user_read_at: at(1), agent_read_at: at(1), open_question: false, waiting: 'agent', last_flag: null, checklist: { total: 0, done: 0, claimed: 0 }, open_for_you: 0,
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


const key = (k: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
describe('the collapsible sidebar', () => {
  beforeEach(() => { localStorage.clear(); projects = [{ id: 'a', name: 'A', unread: 0 }, { id: 'b', name: 'B', unread: 0 }]; });
  it('starts expanded, toggles by button and by [, and shows an unread count for the rail', async () => {
    await load();
    expect($('app').classList.contains('rail')).toBe(false);
    expect($('side-toggle').getAttribute('aria-expanded')).toBe('true');
    $('side-toggle').click();
    expect($('app').classList.contains('rail')).toBe(true);
    expect($('side-toggle').getAttribute('aria-expanded')).toBe('false');
    expect($('side-toggle').getAttribute('aria-label')).toBe('Expand sidebar');
    expect(localStorage.getItem('fb-inbox-sidebar')).toBe('1');
    expect($('rail-unread').hidden).toBe(false);
    expect($('rail-unread').textContent).toBe('1');
    key('[');
    expect($('app').classList.contains('rail')).toBe(false);
    expect(localStorage.getItem('fb-inbox-sidebar')).toBe('0');
    key('[');
    expect($('app').classList.contains('rail')).toBe(true);
  });
  it('comes back collapsed when it was left collapsed, and is listed in the shortcuts help', async () => {
    localStorage.setItem('fb-inbox-sidebar', '1');
    await load();
    expect($('app').classList.contains('rail')).toBe(true);
    expect($('help-rows').textContent).toContain('Collapse or expand the sidebar');
  });
  it('still works when storage throws', async () => {
    await load();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    $('side-toggle').click();
    expect($('app').classList.contains('rail')).toBe(true);
    vi.restoreAllMocks();
  });
});
