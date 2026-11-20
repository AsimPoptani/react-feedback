// The update banner in the inbox page (happy-dom): shown only when the loaded version and the server's differ, and a dismiss holds.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync('server/inbox/index.html', 'utf8');
const body = html.slice(html.indexOf('<body'), html.indexOf('<script type="module"')).replace(/<body[^>]*>/, '');
const PAGE = /name="rf-version" content="([^"]+)"/.exec(html)?.[1] ?? '';
const at = (n: number) => `2026-11-18T10:0${n}:00.000Z`;
const thread = { id: '20261118-100000-abcd', title: 'Version', origin: 'user', mode: 'thread', status: 'open', created_at: at(0), url: null, last_message_at: at(1), last_author: 'user',
  unread_for_user: false, user_read_at: at(1), agent_read_at: null, open_question: false, waiting: 'agent', last_flag: null, checklist: { total: 0, done: 0, claimed: 0 }, open_for_you: 0,
  merged_into: null, read_only: false, acked_through: null, viewport: null, target: null, note: '', checklist_items: [], files: { image: false, annotated: false, context: false },
  messages: [{ id: 'm1', author: 'user', text: 'Hello', images: [], created_at: at(0) }] };
let serverVersion = PAGE;
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const realSetInterval = window.setInterval.bind(window);
const realClearInterval = window.clearInterval.bind(window);
const timers: ReturnType<typeof setInterval>[] = [];
window.setInterval = ((fn: TimerHandler, ms?: number) => { const id = realSetInterval(fn, ms); timers.push(id); return id; }) as typeof window.setInterval;
const added: [EventTarget, string, EventListener][] = [];
for (const target of [document, window]) {
  const original = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListener, opts?: unknown) => { added.push([target, type, fn]); original(type, fn, opts as AddEventListenerOptions); }) as typeof target.addEventListener;
}

async function load() {
  for (const id of timers.splice(0)) realClearInterval(id);
  for (const [target, type, fn] of added.splice(0)) target.removeEventListener(type, fn);
  vi.resetModules();
  document.body.innerHTML = body;
  document.querySelector('meta[name="rf-version"]')?.remove();
  document.head.insertAdjacentHTML('beforeend', `<meta name="rf-version" content="${PAGE}">`);
  location.hash = `#/${thread.id}`;
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
  HTMLDialogElement.prototype.close ??= function () { this.open = false; };
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://local').pathname.replace(/^.*\/api\//, '');
    const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data, headers: new Headers() });
    if (init?.method === 'POST') return ok({});
    if (path === 'threads') return ok([thread]);
    if (path.startsWith('threads/')) return ok(thread);
    if (path === 'profile') return ok({ user: { name: 'You' }, agent: { name: 'Agent' } });
    if (path === 'pins') return ok({ threads: [], areas: [] });
    if (path === 'areas') return ok({ areas: [] });
    if (path === 'config') return ok({ secret_target: null, redact: false, version: serverVersion });
    if (path === 'presence') return ok({ user: null, agents: [] });
    return ok({});
  }));
  await import('../inbox/app.js');
  await vi.waitFor(() => expect(document.querySelectorAll('#msgs .msg').length).toBeGreaterThan(0));
}
async function settlePoll() {
  const before = vi.mocked(fetch).mock.calls.length;
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(before));
  await new Promise(r => setTimeout(r, 40));
}

describe('the update banner', () => {
  beforeEach(() => { localStorage.clear(); serverVersion = PAGE; });

  it('stays hidden when the server version matches the loaded page', async () => {
    await load();
    expect($('app-version').textContent).toBe(`react-feedback v${PAGE}`);
    expect($('app-version').parentElement?.querySelector('#tracker-link')).not.toBeNull();
    expect($('update-banner').hidden).toBe(true);
    expect($('update-text').textContent).toBe('');
  });

  it('shows only when the versions differ, and a dismiss holds until the next version', async () => {
    serverVersion = '0.9.3';
    await load();
    const banner = $('update-banner');
    expect(banner.hidden).toBe(false);
    expect($('update-text').textContent).toBe('A new version (v0.9.3) is ready. Reload to update');
    expect($('update-reload').textContent).toBe('Reload');
    expect($('update-dismiss').getAttribute('aria-label')).toBe('Dismiss');
    expect($('app-version').textContent).toBe(`react-feedback v${PAGE}`);
    $('update-dismiss').click();
    expect(banner.hidden).toBe(true);
    expect(localStorage.getItem('fb-inbox-update-dismissed')).toBe('0.9.3');
    serverVersion = '0.9.3';
    await settlePoll();
    expect(banner.hidden).toBe(true);
    serverVersion = '0.9.4';
    await settlePoll();
    expect(banner.hidden).toBe(false);
    expect($('update-text').textContent).toBe('A new version (v0.9.4) is ready. Reload to update');
    serverVersion = PAGE;
    await settlePoll();
    expect(banner.hidden).toBe(true);
  });
});
