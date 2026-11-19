// RF5 in the inbox page (happy-dom): side questions, checklist items attached to messages, the tracker page, and Markdown in bubbles.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync('server/inbox/index.html', 'utf8');
const body = html.slice(html.indexOf('<body'), html.indexOf('<script type="module"')).replace(/<body[^>]*>/, '');
const at = (n: number) => `2026-11-18T10:${String(n).padStart(2, '0')}:00.000Z`;
const ID = '20261118-100000-abcd';
const m = (id: string, author: string, text: string, n: number, extra: Record<string, unknown> = {}) => ({ id, author, text, images: [], created_at: at(n), ...(author === 'agent' ? { flag: 'fyi' } : {}), ...extra });
const item = (id: string, owner: string, text: string, extra: Record<string, unknown> = {}) => ({ id, owner, text, created_by: owner === 'user' ? 'user' : 'agent', done: false, created_at: at(0), ...extra });
function thread(messages: unknown[], items: unknown[] = [], extra: Record<string, unknown> = {}) {
  return { id: ID, title: 'Side', origin: 'user', mode: 'thread', status: 'open', created_at: at(0), url: null, last_message_at: at(9), last_author: 'agent', unread_for_user: false, user_read_at: at(9), agent_read_at: at(9),
    open_question: false, waiting: 'idle', last_flag: 'fyi', checklist: { total: items.length, done: 0, claimed: 0 }, open_for_you: 0, merged_into: null, read_only: false, acked_through: null, viewport: null, target: null, note: '',
    checklist_items: items, files: { image: false, annotated: false, context: false }, messages, ...extra };
}
const posts: { path: string; method: string; body: Record<string, unknown> }[] = [];
const $ = (id: string) => document.getElementById(id)!;
const added: [EventTarget, string, EventListenerOrEventListenerObject][] = [];
for (const target of [document, window]) {
  const original = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => { added.push([target, type, fn]); original(type, fn, opts as AddEventListenerOptions); }) as typeof target.addEventListener;
}
async function load(t: ReturnType<typeof thread>, hash = `#/${ID}`, tracker: unknown = null, wait = '#msgs .msg, #msgs .aside-group') {
  for (const [target, type, fn] of added.splice(0)) target.removeEventListener(type, fn);
  vi.resetModules(); posts.length = 0;
  document.body.innerHTML = body;
  location.hash = hash;
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://local').pathname.replace(/^.*\/api\//, '');
    const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
    if (init?.method && init.method !== 'GET') { posts.push({ path, method: init.method, body: init.body ? JSON.parse(String(init.body)) : {} }); return ok({}); }
    if (path === 'threads') return ok([t]);
    if (path === 'tracker') return ok(tracker);
    if (path.startsWith('threads/')) return ok(t);
    if (path === 'profile') return ok({ user: { name: 'You' }, agent: { name: 'Agent' } });
    if (path === 'pins') return ok({ threads: [], areas: [] });
    if (path === 'areas') return ok({ areas: [] });
    return ok({});
  }));
  await import('../inbox/app.js');
  await vi.waitFor(() => expect(document.querySelectorAll(wait).length).toBeGreaterThan(0));
}
const key = (target: Element | Document, k: string) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

describe('side questions in the inbox', () => {
  beforeEach(() => { localStorage.clear(); });
  const base = [m('m1', 'user', 'Main question', 0), m('m2', 'agent', 'Main answer', 1)];

  it('an unanswered aside is open with a "Waiting for agent" pill; the main messages are unchanged', async () => {
    await load(thread([...base, m('m3', 'user', 'Quick aside?', 2, { aside: true })]));
    const g = document.querySelector<HTMLElement>('.aside-group')!;
    expect(g.dataset.aside).toBe('waiting');
    expect(g.querySelector('.pill')!.textContent).toBe('Waiting for agent');
    expect(g.querySelector('.aside-head')!.getAttribute('aria-expanded')).toBe('true');
    expect(g.textContent).toContain('Quick aside?');
    expect(document.querySelectorAll('#msgs > .msg').length).toBe(2);
  });

  it('an answered aside is collapsed by default, shows a peek and the answer count, and opens on click', async () => {
    await load(thread([...base, m('m3', 'user', 'What is **x**?', 2, { aside: true }), m('m4', 'agent', 'It is y.', 3, { aside: true, reply_to: 'm3' })]));
    const g = document.querySelector<HTMLElement>('.aside-group')!;
    const head = g.querySelector<HTMLButtonElement>('.aside-head')!;
    expect(g.dataset.aside).toBe('answered');
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(g.querySelector('.pill')).toBeNull();
    expect(g.querySelector('.peek')!.textContent).toBe('What is x?'); // Markdown stripped in the peek
    expect(g.textContent).toContain('1 answer');
    expect(g.textContent).not.toContain('It is y.');
    head.click();
    const open = document.querySelector<HTMLElement>('.aside-group')!;
    expect(open.querySelector('.aside-head')!.getAttribute('aria-expanded')).toBe('true');
    expect(open.textContent).toContain('It is y.');
    expect(open.querySelectorAll('.aside-msg').length).toBe(2);
  });

  it('the aside sits where it was asked and does not count as a main message', async () => {
    await load(thread([m('m1', 'user', 'one', 0), m('m2', 'user', 'aside', 1, { aside: true }), m('m3', 'agent', 'three', 2)]));
    expect([...document.getElementById('msgs')!.children].map(n => n.getAttribute('data-mid'))).toEqual(['m1', 'm2', 'm3']);
    expect(document.querySelectorAll('#msgs > .msg').length).toBe(2);
  });

  it('/btw sends an aside with the prefix stripped; a plain message does not; an empty /btw is refused', async () => {
    await load(thread(base));
    const send = () => $('composer').dispatchEvent(new Event('submit', { cancelable: true }));
    const text = $('text') as HTMLTextAreaElement;
    text.value = '/btw what is x?'; send();
    await vi.waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]!.body).toMatchObject({ text: 'what is x?', aside: true });
    await vi.waitFor(() => expect(($('send') as HTMLButtonElement).disabled).toBe(false));
    text.value = 'plain'; send();
    await vi.waitFor(() => expect(posts.length).toBe(2));
    expect(posts[1]!.body).toEqual({ text: 'plain', images: [], client_id: expect.any(String), written_at: expect.any(String) });
    await vi.waitFor(() => expect(($('send') as HTMLButtonElement).disabled).toBe(false));
    text.value = '/btw'; send();
    await vi.waitFor(() => expect($('error').textContent).toContain('after /btw'));
    expect(posts.length).toBe(2);
  });

  it('the Side question button sends the text as an aside, or starts /btw on an empty box; B does the same', async () => {
    await load(thread(base));
    const text = $('text') as HTMLTextAreaElement;
    $('btw').click();
    expect(text.value).toBe('/btw ');
    text.value = 'typed'; $('btw').click();
    await vi.waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]!.body).toMatchObject({ text: 'typed', aside: true });
    await vi.waitFor(() => expect(($('btw') as HTMLButtonElement).disabled).toBe(false));
    text.value = ''; (document.activeElement as HTMLElement)?.blur();
    key(document.body, 'b');
    expect(text.value).toBe('/btw ');
    expect(document.getElementById('help-rows')!.textContent).toContain('side question');
  });

  it('a quote bar stays out of an aside', async () => {
    await load(thread(base));
    document.querySelector<HTMLButtonElement>('#msgs [data-mid="m2"] .reply-btn')!.click();
    ($('text') as HTMLTextAreaElement).value = '/btw q';
    $('composer').dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]!.body).not.toHaveProperty('reply_to');
  });
});

describe('items attached to messages', () => {
  beforeEach(() => { localStorage.clear(); });
  const items = [item('c1', 'user', 'Send the doc'), item('c2', 'agent', 'Run **tests**', { done: true, done_at: at(3) })];
  const msgs = [m('m1', 'user', 'hi', 0), m('m2', 'agent', 'Plan', 1, { added_items: ['c1'], ticked_items: ['c2'] }), m('m3', 'agent', 'gone', 2, { added_items: ['c9'] })];

  it('shows "Added to checklist" and "Ticked" inside the bubble; an item that was removed is shown as an id', async () => {
    await load(thread(msgs, items));
    const att = document.querySelector('#msgs [data-mid="m2"] .attached')!;
    expect(att.querySelector('[data-attached=added]')!.textContent).toContain('Added to checklist:');
    expect(att.querySelector('[data-attached=added] button')!.textContent).toBe('Send the doc');
    expect(att.querySelector('[data-attached=ticked]')!.textContent).toContain('Ticked:');
    expect(att.querySelector('[data-attached=ticked] button strong')!.textContent).toBe('tests'); // inline Markdown in the item text
    expect(document.querySelector('#msgs [data-mid="m3"] .attached .gone')!.textContent).toBe('c9');
    expect(document.querySelector('#msgs [data-mid="m1"] .attached')).toBeNull();
  });

  it('clicking an item opens the panel on it and highlights its row', async () => {
    localStorage.setItem('react-feedback-checklist', '{}');
    await load(thread(msgs, items));
    document.querySelector<HTMLButtonElement>('#msgs [data-mid="m2"] .att-item[data-item="c1"]')!.click();
    await vi.waitFor(() => expect($('cl-body').querySelector('[data-item="c1"]')!.classList.contains('flash')).toBe(true));
    expect($('checklist').hidden).toBe(false);
  });

  it('a hash like #/<thread>/c1 opens the thread on that item', async () => {
    await load(thread(msgs, items), `#/${ID}/c1`);
    await vi.waitFor(() => expect($('cl-body').querySelector('[data-item="c1"]')!.classList.contains('flash')).toBe(true));
  });
});

describe('Markdown in bubbles', () => {
  it('renders a table, a heading and a list in a message, and keeps raw HTML as text', async () => {
    await load(thread([m('m1', 'agent', '## Models\n\n| Model | Score |\n|---|--:|\n| A | 1 |\n\n- [x] done\n\n<img src=x onerror=alert(1)>', 0)]));
    const node = document.querySelector('#msgs [data-mid="m1"]')!;
    expect(node.querySelector('.md-h2')!.textContent).toBe('Models');
    expect(node.querySelectorAll('.md-table th').length).toBe(2);
    expect(node.querySelector('input[type=checkbox]')!.hasAttribute('checked')).toBe(true);
    expect(node.querySelector('img')).toBeNull();
    expect(node.textContent).toContain('<img src=x onerror=alert(1)>');
  });
  it('quote snippets and reply previews are plain text', async () => {
    await load(thread([m('m1', 'agent', '| Model | Score |\n|---|---|\n| A | 1 |', 0), m('m2', 'user', 'ok', 1, { reply_to: 'm1' }), m('m3', 'agent', '**bold** `code`', 2)]));
    expect(document.querySelector('#msgs [data-mid="m2"] .quote .snip')!.textContent).toBe('Model · Score');
    document.querySelector<HTMLButtonElement>('#msgs [data-mid="m3"] .reply-btn')!.click();
    expect($('replybar-text').textContent).toContain('bold code');
    expect($('replybar-text').textContent).not.toContain('*');
  });
  it('a read-only thread renders Markdown too', async () => {
    await load(thread([m('m1', 'agent', '# Update\n- one\n- two', 0)], [], { read_only: true }));
    expect(document.querySelector('#msgs .md-h1')).not.toBeNull();
    expect(document.querySelectorAll('#msgs li').length).toBe(2);
  });
});

describe('the tracker page', () => {
  const row = (thread: string, title: string, i: ReturnType<typeof item>, read_only = false) => ({ thread, title, read_only, item: i });
  const tracker = {
    generated_at: at(30), counts: { total: 4, done: 1, claimed: 1 }, threads: [{ id: ID, title: 'Alpha', open: 2 }, { id: '20261118-100001-abcd', title: 'Beta', open: 1 }],
    you: [row(ID, 'Alpha', item('c1', 'user', 'Buy **milk**'))],
    agent: [row('20261118-100001-abcd', 'Beta', item('c2', 'agent', 'Claimed job', { claimed_by_user_at: at(5) })), row(ID, 'Alpha', item('c3', 'agent', 'Open job'), true)],
    done_recent: [row(ID, 'Alpha', item('c4', 'agent', 'Finished', { done: true, done_at: at(20) }))],
  };
  const open = () => load(thread([m('m1', 'user', 'x', 0)]), '#/tracker', tracker, '#tr-groups .tr-item');
  beforeEach(() => { localStorage.clear(); });

  it('groups items For you, For the agent and Done recently, with a donut and a summary', async () => {
    await open();
    const sections = [...document.querySelectorAll<HTMLElement>('.tr-section')];
    expect(sections.map(s => s.dataset.group)).toEqual(['For you', 'For the agent', 'Done recently']);
    expect(sections.map(s => s.querySelectorAll('.tr-item').length)).toEqual([1, 2, 1]);
    expect($('tr-summary').textContent).toContain('1 of 4 done, 1 claimed');
    expect($('tr-donut').querySelector('svg')).not.toBeNull();
    expect($('tracker').style.display).toBe('flex');
    expect($('tracker-link').getAttribute('aria-current')).toBe('page');
  });

  it('each item shows its text (plain), state, age and a link to the item in its thread', async () => {
    await open();
    const first = document.querySelector<HTMLElement>('.tr-item[data-item="c1"]')!;
    expect(first.querySelector('.cl-text')!.textContent).toBe('Buy milk');
    expect(first.querySelector('.cl-meta a')!.getAttribute('href')).toBe(`#/${ID}/c1`);
    expect(first.querySelector('.cl-meta')!.textContent).toContain('Open');
    expect(first.querySelector('.cl-meta')!.textContent).toContain('old');
    expect(document.querySelector('.tr-item[data-item="c2"] .cl-meta')!.textContent).toContain('Claimed');
    expect(document.querySelector('.tr-item[data-item="c4"] .cl-meta')!.textContent).toContain('Ticked');
  });

  it('read-only threads and ticked items offer no write action; open items offer "I\'ve done this" and it claims', async () => {
    await open();
    expect(document.querySelector('.tr-item[data-item="c3"] button')).toBeNull(); // read-only thread
    expect(document.querySelector('.tr-item[data-item="c4"] button')).toBeNull(); // ticked
    expect(document.querySelector('.tr-item[data-item="c2"] button')!.textContent).toBe('Undo claim');
    document.querySelector<HTMLButtonElement>('.tr-item[data-item="c1"] button')!.click();
    await vi.waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]).toMatchObject({ path: `threads/${ID}/checklist/c1`, method: 'PATCH', body: { claimed: true } });
  });

  it('filters by search, thread and state', async () => {
    await open();
    const q = $('tr-q') as HTMLInputElement, sel = $('tr-thread') as HTMLSelectElement, st = $('tr-state') as HTMLSelectElement;
    const shown = () => [...document.querySelectorAll<HTMLElement>('.tr-item')].map(n => n.dataset.item);
    expect(sel.querySelectorAll('option').length).toBe(3);
    q.value = 'MILK'; q.dispatchEvent(new Event('input'));
    expect(shown()).toEqual(['c1']);
    q.value = ''; q.dispatchEvent(new Event('input'));
    sel.value = '20261118-100001-abcd'; sel.dispatchEvent(new Event('change'));
    expect(shown()).toEqual(['c2']);
    sel.value = ''; sel.dispatchEvent(new Event('change'));
    st.value = 'claimed'; st.dispatchEvent(new Event('change'));
    expect(shown()).toEqual(['c2']);
    st.value = 'done'; st.dispatchEvent(new Event('change'));
    expect(shown()).toEqual(['c4']);
  });

  it('Done recently collapses', async () => {
    await open();
    document.querySelector<HTMLButtonElement>('.tr-section[data-group="Done recently"] h3 button')!.click();
    expect(document.querySelector('.tr-item[data-item="c4"]')).toBeNull();
    expect(document.querySelector('.tr-section[data-group="Done recently"] h3 button')!.getAttribute('aria-expanded')).toBe('false');
  });
});
