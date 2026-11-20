// The pinned "Waiting for your answer" bar (happy-dom): a poll must not wipe an answer being typed in it.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync('server/inbox/index.html', 'utf8');
const body = html.slice(html.indexOf('<body'), html.indexOf('<script type="module"')).replace(/<body[^>]*>/, '');
const at = (n: number) => `2026-11-18T10:0${n}:00.000Z`;
const question = { id: 'q2', multi: false, allow_other: true, options: [{ id: 'o1', label: 'Reuse' }, { id: 'o2', label: 'Draw new' }] };
let messages: Record<string, unknown>[] = [];
const thread = () => ({ id: '20261118-100000-abcd', title: 'Pictures', origin: 'user', mode: 'thread', status: 'open', created_at: at(0), url: null, last_message_at: at(1), last_author: 'agent',
  unread_for_user: false, user_read_at: at(1), agent_read_at: at(1), open_question: true, waiting: 'user', last_flag: 'needs_you', checklist: { total: 0, done: 0, claimed: 0 }, open_for_you: 0,
  merged_into: null, read_only: false, acked_through: null, viewport: null, target: null, note: '', checklist_items: [], files: { image: false, annotated: false, context: false }, messages });
let threadLoads = 0;

async function load() {
  vi.resetModules(); threadLoads = 0;
  messages = [
    { id: 'm1', author: 'user', text: 'Start', images: [], created_at: at(0) },
    { id: 'm2', author: 'agent', text: 'Which pictures?', images: [], created_at: at(1), flag: 'needs_you', question },
  ];
  document.body.innerHTML = body;
  location.hash = '#/20261118-100000-abcd';
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://local').pathname.replace(/^.*\/api\//, '');
    const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
    if (init?.method === 'POST') return ok({});
    if (path === 'threads') return ok([thread()]);
    if (path.startsWith('threads/')) { threadLoads += 1; return ok(thread()); }
    if (path === 'profile') return ok({ user: { name: 'You' }, agent: { name: 'Agent' } });
    if (path === 'pins') return ok({ threads: [], areas: [] });
    if (path === 'areas') return ok({ areas: [] });
    return ok({});
  }));
  await import('../inbox/app.js');
  await vi.waitFor(() => expect(document.querySelector('#waiting-bar .qother')).not.toBeNull());
}
const other = () => document.querySelector<HTMLInputElement>('#waiting-bar .qother')!;
async function repoll() {
  const before = threadLoads;
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(threadLoads).toBeGreaterThan(before));
  await new Promise(r => setTimeout(r, 0));
}

describe('waiting bar', () => {
  beforeEach(() => { localStorage.clear(); });

  it('keeps an Other answer being typed across polls, and keeps the same input element', async () => {
    await load();
    const input = other();
    input.value = 'Reuse them, but redraw the cover';
    await repoll();
    await repoll();
    expect(other()).toBe(input);
    expect(other().value).toBe('Reuse them, but redraw the cover');
  });

  it('rebuilds when the questions change, and hides once answered', async () => {
    await load();
    other().value = 'typed';
    messages.push({ id: 'm3', author: 'user', text: 'Chose: Reuse', images: [], created_at: at(2), answer: { question_id: 'q2', option_ids: ['o1'] } });
    await repoll();
    expect(document.querySelector<HTMLElement>('#waiting-bar')!.hidden).toBe(true);
  });
});
