// The inbox page in a DOM (happy-dom): the real index.html and app.js against a fake API.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync('server/inbox/index.html', 'utf8');
const body = html.slice(html.indexOf('<body'), html.indexOf('<script type="module"')).replace(/<body[^>]*>/, '');
const at = (n: number) => `2026-11-18T10:0${n}:00.000Z`;
const messages = [
  { id: 'm1', author: 'user', text: 'Which colour?\nsecond line', images: [], created_at: at(0) },
  { id: 'm2', author: 'agent', text: 'Teal.', images: [], created_at: at(1), flag: 'fyi' },
  { id: 'm3', author: 'user', text: 'Thanks', images: [], created_at: at(2), reply_to: 'm1' },
  { id: 'm4', author: 'agent', text: 'Gone original', images: [], created_at: at(3), flag: 'fyi', reply_to: 'm99' },
];
const thread = { id: '20261118-100000-abcd', title: 'Colours', origin: 'user', mode: 'thread', status: 'open', created_at: at(0), url: null, last_message_at: at(3), last_author: 'agent',
  unread_for_user: false, user_read_at: at(3), agent_read_at: at(3), open_question: false, waiting: 'idle', last_flag: 'fyi', checklist: { total: 0, done: 0, claimed: 0 }, open_for_you: 0,
  merged_into: null, read_only: false, acked_through: null, viewport: null, target: null, note: '', checklist_items: [], files: { image: false, annotated: false, context: false }, messages };
const posts: { path: string; body: Record<string, unknown> }[] = [];

async function load(fold = false) {
  vi.resetModules(); posts.length = 0;
  document.body.innerHTML = body;
  document.body.removeAttribute('data-fold-fyi');
  if (fold) document.body.setAttribute('data-fold-fyi', '');
  location.hash = `#/${thread.id}`;
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://local').pathname.replace(/^.*\/api\//, '');
    const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
    if (init?.method === 'POST') { posts.push({ path, body: JSON.parse(String(init.body)) }); return ok({}); }
    if (path === 'threads') return ok([thread]);
    if (path.startsWith('threads/')) return ok(thread);
    if (path === 'profile') return ok({ user: { name: 'You' }, agent: { name: 'Agent' } });
    if (path === 'pins') return ok({ threads: [], areas: [] });
    if (path === 'areas') return ok({ areas: [] });
    return ok({});
  }));
  await import('../inbox/app.js');
  await vi.waitFor(() => expect(document.querySelectorAll('#msgs .msg').length).toBeGreaterThan(0));
}
const msg = (id: string) => document.querySelector<HTMLElement>(`#msgs [data-mid="${id}"]`)!;

describe('inbox quote replies', () => {
  beforeEach(() => { localStorage.clear(); });

  it('shows every message in full by default, and folds FYI ones only when opted in', async () => {
    await load();
    expect(document.querySelector('.msg.collapsed')).toBeNull();
    expect(msg('m2').textContent).toContain('Teal.');
    await load(true);
    expect(msg('m2').classList.contains('collapsed')).toBe(true);
  });

  it('shows the quoted snippet, and "Original message unavailable" when the original is gone', async () => {
    await load();
    const quote = msg('m3').querySelector<HTMLButtonElement>('.quote')!;
    expect(quote.textContent).toContain('You');
    expect(quote.textContent).toContain('Which colour?');
    expect(quote.textContent).not.toContain('second line');
    expect(msg('m4').querySelector('.quote.missing')!.textContent).toBe('Original message unavailable');
    expect(msg('m4').querySelector('button.quote')).toBeNull();
    expect(msg('m1').querySelector('.quote')).toBeNull();
  });

  it('tapping the snippet scrolls to the original and highlights it', async () => {
    await load();
    msg('m3').querySelector<HTMLButtonElement>('.quote')!.click();
    expect((Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect(msg('m1').classList.contains('flash')).toBe(true);
  });

  it('Reply puts a quote bar above the composer; x cancels it; sending carries reply_to', async () => {
    await load();
    const bar = document.getElementById('replybar')!;
    expect(bar.hidden).toBe(true);
    msg('m2').querySelector<HTMLButtonElement>('.reply-btn')!.click();
    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toContain('Agent');
    expect(bar.textContent).toContain('Teal.');
    document.getElementById('replybar-x')!.click();
    expect(bar.hidden).toBe(true);
    msg('m1').querySelector<HTMLButtonElement>('.reply-btn')!.click();
    (document.getElementById('text') as HTMLTextAreaElement).value = 'a reply';
    document.getElementById('composer')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(posts.some(p => p.path.endsWith('/messages'))).toBe(true));
    expect(posts.find(p => p.path.endsWith('/messages'))!.body).toMatchObject({ text: 'a reply', reply_to: 'm1' });
    await vi.waitFor(() => expect(bar.hidden).toBe(true));
  });

  it('R on a focused message replies to it; Esc in the composer cancels', async () => {
    await load();
    const node = msg('m2'); node.focus();
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));
    expect(document.getElementById('replybar')!.hidden).toBe(false);
    document.getElementById('text')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.getElementById('replybar')!.hidden).toBe(true);
  });

  it('a swipe to the right on touch replies; a short or vertical one does not', async () => {
    await load();
    const touch = (type: string, x: number, y: number) => {
      const e = new Event(type, { bubbles: true }) as Event & { touches: unknown[]; changedTouches: unknown[] };
      const t = [{ clientX: x, clientY: y }]; e.touches = type === 'touchend' ? [] : t; e.changedTouches = t;
      msg('m2').dispatchEvent(e);
    };
    touch('touchstart', 10, 10); touch('touchmove', 40, 12); touch('touchend', 40, 12);
    expect(document.getElementById('replybar')!.hidden).toBe(true);
    touch('touchstart', 10, 10); touch('touchmove', 100, 60); touch('touchend', 100, 60);
    expect(document.getElementById('replybar')!.hidden).toBe(true);
    touch('touchstart', 10, 10); touch('touchmove', 100, 14); touch('touchend', 100, 14);
    expect(document.getElementById('replybar')!.hidden).toBe(false);
  });
});
