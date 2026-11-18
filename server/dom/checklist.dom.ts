// The checklist side panel, the narrow bottom sheet, the donut and roving focus, in a DOM (happy-dom).
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { donutNode } from '../inbox/donut.js';

const html = readFileSync('server/inbox/index.html', 'utf8');
const body = html.slice(html.indexOf('<body'), html.indexOf('<script type="module"')).replace(/<body[^>]*>/, '');
const at = (n: number) => `2026-11-18T10:0${n}:00.000Z`;
const item = (id: string, owner: string, text: string, extra: Record<string, unknown> = {}) => ({ id, owner, text, created_by: owner === 'user' ? 'user' : 'agent', done: false, ...extra });
const messages = [0, 1, 2].map(n => ({ id: `m${n + 1}`, author: n % 2 ? 'agent' : 'user', text: `msg ${n}`, images: [], created_at: at(n) }));
const base = { id: '20261118-100000-abcd', title: 'Trial', origin: 'user', mode: 'thread', status: 'open', created_at: at(0), url: null, last_message_at: at(2), last_author: 'user', unread_for_user: false, user_read_at: at(2), agent_read_at: at(2),
  open_question: false, waiting: 'agent', last_flag: null, open_for_you: 0, merged_into: null, read_only: false, acked_through: null, viewport: null, target: null, note: '', files: { image: false, annotated: false, context: false }, messages };
const withItems = (items: ReturnType<typeof item>[], extra: Record<string, unknown> = {}) => ({ ...base, ...extra, checklist_items: items,
  checklist: { total: items.length, done: items.filter(i => i.done).length, claimed: items.filter(i => (i as { claimed_by_user_at?: string }).claimed_by_user_at).length } });
const eleven = withItems([item('c1', 'user', 'Retry', { claimed_by_user_at: at(1) }), item('c2', 'agent', 'Run', { done: true }), item('c3', 'agent', 'Map', { done: true }), ...Array.from({ length: 8 }, (_, i) => item(`c${i + 4}`, 'agent', `Step ${i}`))]);
const posts: { path: string; method: string; body: Record<string, unknown> }[] = [];
const $ = (id: string) => document.getElementById(id)!;
const key = (target: Element | Document, k: string, init: KeyboardEventInit = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));

// Each load re-imports app.js, which adds document and window listeners; drop the previous page's so they do not act on the new DOM.
const added: [EventTarget, string, EventListenerOrEventListenerObject][] = [];
for (const target of [document, window]) {
  const original = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => { added.push([target, type, fn]); original(type, fn, opts as AddEventListenerOptions); }) as typeof target.addEventListener;
}
async function load(thread: unknown, narrow = false) {
  for (const [target, type, fn] of added.splice(0)) target.removeEventListener(type, fn);
  vi.resetModules(); posts.length = 0;
  document.body.innerHTML = body;
  location.hash = `#/${base.id}`;
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('max-width: 899px') ? narrow : false }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://local').pathname.replace(/^.*\/api\//, '');
    const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
    if (init?.method && init.method !== 'GET') { posts.push({ path, method: init.method, body: init.body ? JSON.parse(String(init.body)) : {} }); return ok({}); }
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

describe('checklist side panel (wide)', () => {
  beforeEach(() => { localStorage.clear(); });

  it('opens beside the messages when the thread has items, with a count, a bar and two sections', async () => {
    await load(eleven);
    const panel = $('checklist');
    expect(panel.hidden).toBe(false);
    expect(panel.getAttribute('role')).toBe('region');
    expect(panel.getAttribute('aria-labelledby')).toBe('cl-h');
    expect($('cl-h').textContent).toContain('Checklist');
    expect($('cl-summary').textContent).toBe('· 2 of 11');
    expect($('cl-progress').getAttribute('aria-valuenow')).toBe('2');
    expect([...panel.querySelectorAll('.cl-sec')].map(h => h.firstChild!.textContent)).toEqual(['For you', 'For the agent']);
    expect($('cl-tab').hidden).toBe(true);
    expect($('cl-btn').hidden).toBe(true);
    expect($('composer').closest('#thread-main')).not.toBeNull(); // the composer stays under the messages column
    expect(panel.contains($('composer'))).toBe(false);
  });

  it('is hidden (slim tab only) when there are no items, and L opens it', async () => {
    await load(withItems([]));
    expect($('checklist').hidden).toBe(true);
    expect($('cl-tab').hidden).toBe(false);
    key(document, 'l');
    expect($('checklist').hidden).toBe(false);
    expect($('cl-tab').hidden).toBe(true);
  });

  it('Hide collapses it to a slim tab that reopens it, and remembers the choice per thread', async () => {
    await load(eleven);
    $('cl-hide').click();
    expect($('checklist').hidden).toBe(true);
    expect($('cl-tab').hidden).toBe(false);
    expect($('cl-tab').textContent).toContain('Checklist 2/11');
    expect($('cl-tab').getAttribute('aria-expanded')).toBe('false');
    expect(JSON.parse(localStorage.getItem('fb-inbox-checklist')!)).toEqual({ [base.id]: 'hidden' });
    await load(eleven); // a reload keeps it hidden
    expect($('checklist').hidden).toBe(true);
    $('cl-tab').click();
    expect($('checklist').hidden).toBe(false);
    expect(JSON.parse(localStorage.getItem('fb-inbox-checklist')!)).toEqual({ [base.id]: 'open' });
  });

  it('survives blocked storage', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    await load(eleven);
    $('cl-hide').click();
    expect($('checklist').hidden).toBe(true);
    vi.restoreAllMocks();
  });

  it('C and Y open a hidden panel and focus the add box for that owner; the box adds', async () => {
    await load(withItems([]));
    key(document, 'y');
    expect($('checklist').hidden).toBe(false);
    expect(document.activeElement).toBe($('cl-add'));
    expect($('cl-owner-user').getAttribute('aria-pressed')).toBe('true');
    ($('cl-add') as HTMLInputElement).value = 'Call them';
    $('cl-foot').dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(posts.some(p => p.method === 'POST' && p.path.endsWith('/checklist'))).toBe(true));
    expect(posts.find(p => p.path.endsWith('/checklist'))!.body).toEqual({ owner: 'user', text: 'Call them' });
    (document.activeElement as HTMLElement).blur();
    key(document, 'c');
    expect($('cl-owner-agent').getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps the item rules: claim button, own items editable, agent ticks only', async () => {
    await load(eleven);
    const mine = $('cl-body').querySelector('[data-owner="user"] .cl-item')!;
    expect([...mine.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Undo claim', 'Edit', 'Delete']);
    const agent = $('cl-body').querySelector('[data-owner="agent"] .cl-item:last-child')!;
    expect([...agent.querySelectorAll('button')].map(b => b.textContent)).toEqual(["I've done this"]);
    expect(agent.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('a read-only thread shows items without any controls, and no panel when it has none', async () => {
    await load(withItems([item('c1', 'agent', 'Ship', { done: true })], { read_only: true }));
    expect($('checklist').hidden).toBe(false);
    expect($('cl-foot').hidden).toBe(true);
    expect($('cl-body').querySelectorAll('button').length).toBe(0);
    key(document, 'c');
    expect(document.activeElement).not.toBe($('cl-add'));
    await load(withItems([], { read_only: true }));
    expect($('checklist').hidden).toBe(true);
    expect($('cl-tab').hidden).toBe(true);
    expect($('cl-btn').hidden).toBe(true);
  });

  it('lists L in the ? cheat sheet', async () => {
    await load(eleven);
    expect($('help-rows').textContent).toContain('Show or hide the checklist');
  });
});

describe('checklist bottom sheet (narrow)', () => {
  beforeEach(() => { localStorage.clear(); });

  it('shows a Checklist 2/11 button instead of the column; the button opens a dialog sheet', async () => {
    await load(eleven, true);
    expect($('checklist').hidden).toBe(true);
    expect($('cl-tab').hidden).toBe(true);
    expect($('cl-btn').hidden).toBe(false);
    expect($('cl-btn').textContent).toBe('Checklist 2/11');
    expect($('cl-btn').getAttribute('aria-expanded')).toBe('false');
    $('cl-btn').click();
    expect($('checklist').hidden).toBe(false);
    expect($('checklist').getAttribute('role')).toBe('dialog');
    expect($('checklist').getAttribute('aria-modal')).toBe('true');
    expect($('cl-btn').getAttribute('aria-expanded')).toBe('true');
    expect($('cl-backdrop').hidden).toBe(false);
    expect(document.activeElement).toBe($('cl-close'));
  });

  it('closes with x, the backdrop or Esc, and returns focus to the button', async () => {
    await load(eleven, true);
    for (const close of [() => $('cl-close').click(), () => $('cl-backdrop').click(), () => key(document, 'Escape')]) {
      $('cl-btn').click();
      expect($('checklist').hidden).toBe(false);
      close();
      expect($('checklist').hidden).toBe(true);
      expect(document.activeElement).toBe($('cl-btn'));
    }
  });

  it('closes on a swipe down on its header, not on a short one', async () => {
    await load(eleven, true);
    const touch = (type: string, y: number) => { const e = new Event(type, { bubbles: true }) as Event & { touches: unknown[] }; e.touches = [{ clientX: 5, clientY: y }]; $('cl-head').dispatchEvent(e); };
    $('cl-btn').click();
    touch('touchstart', 100); touch('touchmove', 130); $('cl-head').dispatchEvent(new Event('touchend', { bubbles: true }));
    expect($('checklist').hidden).toBe(false);
    touch('touchstart', 100); touch('touchmove', 220); $('cl-head').dispatchEvent(new Event('touchend', { bubbles: true }));
    expect($('checklist').hidden).toBe(true);
  });

  it('traps Tab inside the sheet', async () => {
    await load(eleven, true);
    $('cl-btn').click();
    const stops = [...$('checklist').querySelectorAll<HTMLElement>('button, input')].filter(n => !n.hidden);
    stops[stops.length - 1]!.focus();
    key(stops[stops.length - 1]!, 'Tab');
    expect($('checklist').contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(stops[0]);
    key(stops[0]!, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(stops[stops.length - 1]);
  });

  it('L toggles the sheet and C opens it with the add box focused', async () => {
    await load(eleven, true);
    key(document, 'l'); expect($('checklist').hidden).toBe(false);
    key(document, 'l'); expect($('checklist').hidden).toBe(true);
    key(document, 'c');
    expect($('checklist').hidden).toBe(false);
    expect(document.activeElement).toBe($('cl-add'));
  });
});

describe('donut', () => {
  const c = (total: number, done: number, claimed = 0) => ({ total, done, claimed });
  const arcs = (svg: SVGElement) => [...svg.querySelectorAll('circle')].map(x => x.getAttribute('class'));
  it('0 of N: just the track', () => { const s = donutNode(c(11, 0)); expect(arcs(s)).toEqual(['donut-track']); expect(s.getAttribute('aria-label')).toBe('0 of 11 done'); });
  it('partial: track and a done arc', () => { expect(arcs(donutNode(c(11, 2)))).toEqual(['donut-track', 'donut-done']); });
  it('all done: a full done arc', () => { const s = donutNode(c(4, 4)); expect(arcs(s)).toEqual(['donut-track', 'donut-done']); expect(s.querySelector('.donut-done')!.getAttribute('stroke-dasharray')!.split(' ')[0]).toBe((2 * Math.PI * 7).toFixed(2)); });
  it('claimed: a lighter segment under the done one, named in the label', () => { const s = donutNode(c(11, 2, 1)); expect(arcs(s)).toEqual(['donut-track', 'donut-claimed', 'donut-done']); expect(s.getAttribute('aria-label')).toBe('2 of 11 done, 1 claimed'); });
  it('shows in the sidebar row with its count, and in the panel header', async () => {
    localStorage.clear();
    await load(eleven);
    const tally = document.querySelector('#groups .tally')!;
    expect(tally.textContent).toBe('2/11');
    expect(tally.querySelector('svg.donut')!.getAttribute('aria-label')).toBe('2 of 11 done, 1 claimed');
    expect($('cl-donut').querySelector('svg.donut')).not.toBeNull();
  });
});

describe('roving tabindex on messages', () => {
  beforeEach(() => { localStorage.clear(); });
  const stops = () => [...document.querySelectorAll<HTMLElement>('#msgs .msg')].filter(n => n.tabIndex === 0).map(n => n.dataset.mid);
  it('has one tab stop (the newest), and arrows move between messages', async () => {
    await load(eleven);
    expect(stops()).toEqual(['m3']);
    const first = document.querySelector<HTMLElement>('[data-mid="m1"]')!;
    first.focus();
    expect(stops()).toEqual(['m1']);
    key(first, 'ArrowDown');
    expect(document.activeElement).toBe(document.querySelector('[data-mid="m2"]'));
    expect(stops()).toEqual(['m2']);
    key(document.activeElement!, 'ArrowUp'); key(document.activeElement!, 'ArrowUp');
    expect(document.activeElement).toBe(first);
    key(first, 'End');
    expect(document.activeElement).toBe(document.querySelector('[data-mid="m3"]'));
  });
});
