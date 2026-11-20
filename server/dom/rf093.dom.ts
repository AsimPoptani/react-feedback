// A typed answer is kept per thread, and a merged child offers no move (happy-dom).
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync('server/inbox/index.html', 'utf8');
const body = html.slice(html.indexOf('<body'), html.indexOf('<script type="module"')).replace(/<body[^>]*>/, '');
const at = (n: number) => `2026-11-18T10:0${n}:00.000Z`;
const A = '20261118-100000-aaaa', B = '20261118-100000-bbbb';
const question = { id: 'q2', prompt: 'Which pictures?', multi: false, allow_other: true, options: [{ id: 'o1', label: 'Reuse' }, { id: 'o2', label: 'Draw new' }] };
let mergedInto: Record<string, string | null> = {};
const msgs = () => [
  { id: 'm1', author: 'user', text: 'Start', images: [], created_at: at(0) },
  { id: 'm2', author: 'agent', text: 'Which pictures?', images: [], created_at: at(1), flag: 'needs_you', question: { ...question, options: question.options.map(o => ({ ...o })) } },
];
const thread = (id: string) => ({ id, title: `Thread ${id.slice(-4)}`, origin: 'user', mode: 'thread', status: 'open', created_at: at(0), url: null, last_message_at: at(1), last_author: 'agent',
  unread_for_user: false, user_read_at: at(1), agent_read_at: at(1), open_question: true, waiting: 'you', last_flag: 'needs_you', checklist: { total: 0, done: 0, claimed: 0 }, open_for_you: 0,
  merged_into: mergedInto[id] ?? null, read_only: false, acked_through: null, viewport: null, target: null, note: '', checklist_items: [], files: { image: false, annotated: false, context: false }, messages: msgs() });
let loads = 0;

async function load(hash: string) {
  vi.resetModules(); loads = 0;
  document.body.innerHTML = body;
  location.hash = hash;
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://local').pathname.replace(/^.*\/api\//, '');
    const reply = (data: unknown) => ({ ok: true, status: 200, json: async () => data, headers: { get: () => null } });
    if (init?.method === 'POST') return reply({});
    if (path === 'threads') return reply([thread(A), thread(B)]);
    if (path.startsWith('threads/')) { loads += 1; return reply(thread(path.split('/')[1]!)); }
    if (path === 'projects') return reply({ projects: [{ id: 'alpha', name: 'Alpha', unread: 0 }, { id: 'beta', name: 'Beta', unread: 0 }] });
    if (path === 'profile') return reply({ user: { name: 'You' }, agent: { name: 'Agent' } });
    if (path === 'pins') return reply({ threads: [], areas: [] });
    if (path === 'areas') return reply({ areas: [] });
    return reply({});
  }));
  await import('../inbox/app.js');
}
const go = async (id: string) => {
  const before = loads;
  location.hash = `#/${id}`;
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  await vi.waitFor(() => expect(loads).toBeGreaterThan(before));
  await vi.waitFor(() => expect(document.querySelector('#waiting-bar .qother')).not.toBeNull());
};

describe('per-thread answers and merged children', () => {
  beforeEach(() => { localStorage.clear(); mergedInto = {}; });

  it('keeps a typed answer across leaving and returning, and does not show it in another thread', async () => {
    await load(`#/${A}`);
    await vi.waitFor(() => expect(document.querySelector('#waiting-bar .qother')).not.toBeNull());
    document.querySelector<HTMLInputElement>('#waiting-bar .qother')!.value = 'typed in A';
    await go(B);
    expect(document.querySelector<HTMLInputElement>('#waiting-bar .qother')!.value).toBe('');
    await go(A);
    expect(document.querySelector<HTMLInputElement>('#waiting-bar .qother')!.value).toBe('typed in A');
  });

  it('hides Move to project, in the menu and as a button, on a merged child', async () => {
    mergedInto = { [A]: B };
    await load(`#/${A}`);
    await vi.waitFor(() => expect(loads).toBeGreaterThan(0));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.getElementById('move-open')?.hidden).toBe(true);
    document.getElementById('more')?.click();
    expect([...document.querySelectorAll('#popmenu button')].map(button => button.textContent)).not.toContain('Move to project…');
  });

  it('still offers Move to project on a thread that is not merged', async () => {
    await load(`#/${A}`);
    await vi.waitFor(() => expect(loads).toBeGreaterThan(0));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.getElementById('move-open')?.hidden).toBe(false);
    document.getElementById('more')?.click();
    expect([...document.querySelectorAll('#popmenu button')].map(button => button.textContent)).toContain('Move to project…');
  });
});
