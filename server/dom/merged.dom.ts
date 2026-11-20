// A merged-away thread: the banner, a disabled composer and question card, and a post that races the merge.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('merged-away thread', () => {
  beforeEach(() => { localStorage.clear(); merged = targetId; });

  it('shows Merged into the target and keeps the composer open (0.12.0), with the question card disabled', async () => {
    await load();
    await vi.waitFor(() => expect(document.getElementById('merged-banner')!.hidden).toBe(false));
    const banner = document.getElementById('merged-banner')!;
    expect(banner.textContent).toBe('Merged into Main thread · Open');
    expect(banner.querySelector('a')!.getAttribute('href')).toBe(`#/${targetId}`);
    expect((document.getElementById('text') as HTMLTextAreaElement).disabled).toBe(false);
    expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(false);
    const option = document.querySelector<HTMLButtonElement>(`[data-question="${question.id}"] .qopt`)!;
    expect(option.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>(`[data-question="${question.id}"] .qsubmit`)!.disabled).toBe(true);
    expect((document.getElementById('waiting-bar') as HTMLElement).hidden).toBe(true);
  });

  it('a post that races the merge follows forwarded_to and shows a toast', async () => {
    merged = null;
    await load();
    await vi.waitFor(() => expect(document.querySelectorAll('#msgs .msg').length).toBeGreaterThan(0));
    expect(document.getElementById('merged-banner')!.hidden).toBe(true);
    const text = document.getElementById('text') as HTMLTextAreaElement;
    text.value = 'the first one';
    document.getElementById('composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(location.hash).toBe(`#/${targetId}`));
    const toast = document.getElementById('toast')!;
    expect(toast.hidden).toBe(false);
    expect(toast.textContent).toBe('Sent in the merged thread');
    expect(posts.some(post => post.path === `threads/${sourceId}/messages`)).toBe(true);
  });
});
