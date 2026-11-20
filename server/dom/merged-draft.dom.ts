// Text typed in a thread that is merged away is kept readable there and restored in the target.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync('server/inbox/index.html', 'utf8');
const body = html.slice(html.indexOf('<body'), html.indexOf('<script type="module"')).replace(/<body[^>]*>/, '');
const at = (n: number) => `2026-11-20T10:2${n}:00.000Z`;
const sourceId = '20261118-100000-abcd';
const targetId = '20261118-100001-abce';
const question = { id: 'q4', prompt: 'Which option?', multi: false, allow_other: true, options: [{ id: 'o1', label: 'First' }] };
const summary = (id: string, title: string, merged: string | null) => ({ id, title, origin: 'user', mode: 'thread', status: merged ? 'done' : 'open', created_at: at(0), url: null, last_message_at: at(1), last_author: 'agent',
  unread_for_user: false, user_read_at: at(1), agent_read_at: at(1), open_question: !merged, waiting: merged ? 'done' : 'you', last_flag: 'needs_you', checklist: { total: 0, done: 0, claimed: 0 }, open_for_you: 0,
  merged_into: merged, read_only: false, acked_through: null });
const messages = [
  { id: 'm1', author: 'user', text: 'Hello', images: [], created_at: at(0) },
  { id: 'm4', author: 'agent', text: question.prompt, images: [], created_at: at(1), flag: 'needs_you', question },
];
let merged: string | null = targetId;
let answerStatus = 200;
let posts: { path: string; body: Record<string, unknown> }[] = [];

async function load(hash = `#/${sourceId}`) {
  vi.resetModules(); posts = [];
  document.body.innerHTML = body;
  location.hash = hash;
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://local').pathname.replace(/^.*\/api\//, '');
    const ok = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      posts.push({ path, body });
      if (answerStatus === 409 && path === `threads/${sourceId}/answer`) return { ok: false, status: 409, json: async () => ({ detail: 'That question is already answered' }) };
      if (path === `threads/${sourceId}/messages` || path === `threads/${sourceId}/answer`) {
        return ok({ id: 'm9', author: 'user', text: 'Sent in Side thread after the merge', images: [], created_at: at(2), forwarded_to: targetId });
      }
      return ok({});
    }
    if (path === 'threads') return ok([summary(sourceId, 'Side thread', merged), summary(targetId, 'Main thread', null)]);
    if (path === `threads/${sourceId}`) return ok({ ...summary(sourceId, 'Side thread', merged), note: '', checklist_items: [], viewport: null, target: null, files: { image: false, annotated: false, context: false }, messages });
    if (path === `threads/${targetId}`) return ok({ ...summary(targetId, 'Main thread', null), note: '', checklist_items: [], viewport: null, target: null, files: { image: false, annotated: false, context: false }, messages: [{ id: 'm1', author: 'user', text: 'Target', images: [], created_at: at(0) }] });
    if (path === 'profile') return ok({ user: { name: 'You' }, agent: { name: 'Agent' } });
    if (path === 'pins') return ok({ threads: [], areas: [] });
    if (path === 'areas') return ok({ areas: [] });
    return ok({});
  }));
  await import('../inbox/app.js');
}

describe('typed text survives a merge', () => {
  // Each load() imports the app afresh, and an earlier copy would keep answering hashchange on the shared DOM, so its listeners are removed after each test.
  const added: [EventTarget, string, EventListenerOrEventListenerObject][] = [];
  beforeEach(() => {
    localStorage.clear(); merged = null; answerStatus = 200; added.length = 0;
    for (const target of [window, document]) {
      const real = target.addEventListener.bind(target);
      vi.spyOn(target, 'addEventListener').mockImplementation((type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => { added.push([target, type, fn]); real(type, fn, opts); });
    }
  });
  afterEach(() => { for (const [target, type, fn] of added) target.removeEventListener(type, fn); vi.restoreAllMocks(); location.hash = ''; });
  const refresh = async () => { document.dispatchEvent(new Event('visibilitychange')); await new Promise(r => setTimeout(r, 30)); };
  const bar = () => document.querySelector<HTMLInputElement>('#waiting-bar .qother');

  it('keeps the composer text readable, and restores it in the target', async () => {
    await load();
    await vi.waitFor(() => expect(document.querySelectorAll('#msgs .msg').length).toBeGreaterThan(0));
    const text = document.getElementById('text') as HTMLTextAreaElement;
    text.value = 'half written reply';
    merged = targetId;
    await refresh();
    await vi.waitFor(() => expect(document.getElementById('merged-banner')!.hidden).toBe(false));
    expect(text.value).toBe('half written reply');
    expect(text.disabled).toBe(false);
    expect(text.readOnly).toBe(true);
    location.hash = `#/${targetId}`;
    await vi.waitFor(() => expect(text.readOnly).toBe(false));
    expect(text.value).toBe('half written reply');
    expect(document.getElementById('merged-banner')!.hidden).toBe(true);
  });

  it('carries typed Other text as a quoted draft', async () => {
    await load();
    await vi.waitFor(() => expect(bar()).not.toBeNull());
    bar()!.value = 'my own answer';
    merged = targetId;
    await refresh();
    await vi.waitFor(() => expect(document.getElementById('merged-banner')!.hidden).toBe(false));
    location.hash = `#/${targetId}`;
    const text = document.getElementById('text') as HTMLTextAreaElement;
    await vi.waitFor(() => expect(text.value).toBe('> Which option?\nmy own answer'));
  });

  it('says why on a 409 and carries the Other text', async () => {
    await load();
    await vi.waitFor(() => expect(bar()).not.toBeNull());
    answerStatus = 409;
    const other = bar()!;
    other.value = 'late answer';
    merged = targetId;
    other.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const error = document.getElementById('error')!;
    await vi.waitFor(() => expect(error.textContent).toBe('This thread was merged into Main thread · Open'));
    expect(error.querySelector('a')!.getAttribute('href')).toBe(`#/${targetId}`);
    location.hash = `#/${targetId}`;
    const text = document.getElementById('text') as HTMLTextAreaElement;
    await vi.waitFor(() => expect(text.value).toBe('> Which option?\nlate answer'));
  });
});
