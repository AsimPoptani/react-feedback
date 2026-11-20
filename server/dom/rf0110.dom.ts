// 0.11.0 in the inbox page (happy-dom): the source chip of a capture, quoting selected text (selection, popover, composer, send, display), and an expired question.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync('server/inbox/index.html', 'utf8');
const body = html.slice(html.indexOf('<body'), html.indexOf('<script type="module"')).replace(/<body[^>]*>/, '');
const at = (n: number) => `2026-11-18T10:0${n}:00.000Z`;
const threadId = '20261118-100000-abcd';
let messages: Record<string, unknown>[] = [];
let target: unknown = null;
let withImage = false;
const posts: { path: string; body: Record<string, any> }[] = [];
const thread = () => ({ id: threadId, title: 'Plan', origin: 'user', mode: withImage ? 'element' : 'thread', status: 'open', created_at: at(0), url: null, last_message_at: at(1), last_author: 'agent',
  unread_for_user: false, user_read_at: at(1), agent_read_at: at(1), open_question: false, waiting: 'idle', last_flag: null, checklist: { total: 0, done: 0, claimed: 0 }, open_for_you: 0,
  merged_into: null, read_only: false, acked_through: null, viewport: null, target, note: '', checklist_items: [], files: { image: withImage, annotated: false, context: false }, messages });
let threadLoads = 0;
const $ = (id: string) => document.getElementById(id) as HTMLElement;

async function load() {
  vi.resetModules(); threadLoads = 0; posts.length = 0;
  document.body.innerHTML = body;
  location.hash = `#/${threadId}`;
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://local').pathname.replace(/^.*\/api\//, '');
    const reply = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data, headers: { get: () => null } });
    if (init?.method === 'POST') {
      const payload = init.body ? JSON.parse(String(init.body)) as Record<string, any> : {};
      posts.push({ path, body: payload });
      if (path.endsWith('/answer') && messages.some(m => (m.question as { id?: string; expired?: boolean } | undefined)?.id === payload.question_id && (m.question as { expired?: boolean }).expired)) return reply({ detail: 'This question expired' }, 409);
      if (path.endsWith('/messages')) messages.push({ id: `m${messages.length + 1}`, author: 'user', text: payload.text, images: [], created_at: at(messages.length + 1), ...(payload.reply_to ? { reply_to: payload.reply_to } : {}), ...(payload.quote ? { quote: payload.quote } : {}) });
      return reply({});
    }
    if (path === 'threads') return reply([thread()]);
    if (path.startsWith('threads/')) { threadLoads += 1; return reply(thread()); }
    if (path === 'projects') return reply({ projects: [{ id: 'alpha', name: 'Alpha', unread: 0 }] });
    if (path === 'profile') return reply({ user: { name: 'You' }, agent: { name: 'Agent' } });
    if (path === 'pins') return reply({ threads: [], areas: [] });
    if (path === 'areas') return reply({ areas: [] });
    return reply({});
  }));
  await import('../inbox/app.js');
}
async function repoll() {
  const before = threadLoads;
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(threadLoads).toBeGreaterThan(before));
  await new Promise(r => setTimeout(r, 0));
}
// Selects the words `part` inside the text of one rendered message, the way a mouse or a long press would.
function select(mid: string, part: string) {
  const node = document.querySelector(`#msgs .msg[data-mid="${mid}"]`)!;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const at = (text.textContent ?? '').indexOf(part);
    if (at < 0) continue;
    const range = document.createRange(); range.setStart(text, at); range.setEnd(text, at + part.length);
    const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    return;
  }
  throw new Error(`"${part}" is not in ${mid}`);
}
const popup = () => $('qpop');
const start = () => {
  messages = [
    { id: 'm1', author: 'user', text: 'Start', images: [], created_at: at(0) },
    { id: 'm2', author: 'agent', text: 'The cache is rebuilt nightly and on every deploy.', images: [], created_at: at(1), flag: 'fyi' },
  ];
};

describe('the source of a captured element', () => {
  beforeEach(() => { localStorage.clear(); start(); withImage = true; });
  it('shows a small chip with the shortened path and line, marks a runtime position, and carries the full location in its title', async () => {
    target = { selector: '#save', tag: 'button', components: ['SaveButton', 'Toolbar', 'Page'], source: { file: 'src/components/forms/inputs/buttons/SaveButton.tsx', line: 42, column: 7, component: 'SaveButton', runtime: true } };
    await load();
    await vi.waitFor(() => expect(document.querySelector('#capture .src-chip')).not.toBeNull());
    const chip = document.querySelector<HTMLButtonElement>('#capture .src-chip')!;
    expect(chip.textContent).toBe('src/…/buttons/SaveButton.tsx:42');
    expect(chip.title).toContain('src/components/forms/inputs/buttons/SaveButton.tsx:42:7');
    expect(chip.title).toContain('runtime position, not source-mapped');
    expect(document.querySelector('#capture .src-row')?.textContent).toContain('runtime, not source-mapped');
    expect(document.querySelector('#capture .src-row')?.textContent).toContain('SaveButton < Toolbar < Page');
  });
  it('shows a short path as it is, and nothing at all for a capture without a source', async () => {
    target = { selector: '#a', source: { file: 'src/Card.tsx', line: 5, column: 1, component: 'Card' } };
    await load();
    await vi.waitFor(() => expect(document.querySelector('#capture .src-chip')?.textContent).toBe('src/Card.tsx:5'));
    expect(document.querySelector('#capture .src-row')?.textContent).not.toContain('runtime');
    target = { selector: '#a', components: ['Card'] };
    await load();
    await vi.waitFor(() => expect(document.querySelector('#capture:not([hidden])')).not.toBeNull());
    expect(document.querySelector('#capture .src-chip')).toBeNull();
  });
});

describe('quoting selected text', () => {
  beforeEach(() => { localStorage.clear(); start(); withImage = false; target = null; });
  it('offers Quote on a selection inside one message, and puts a > block and the note in the composer', async () => {
    await load();
    await vi.waitFor(() => expect(document.querySelector('#msgs .msg[data-mid="m2"]')).not.toBeNull());
    expect(popup().hidden).toBe(true);
    select('m2', 'rebuilt nightly');
    await vi.waitFor(() => expect(popup().hidden).toBe(false));
    (document.getElementById('qpop-note') as HTMLInputElement).value = 'Why nightly?';
    $('qpop-go').click();
    expect((document.getElementById('text') as HTMLTextAreaElement).value).toBe('> rebuilt nightly\n\nWhy nightly?');
    expect(popup().hidden).toBe(true);
  });
  it('keeps what was already typed above the quote', async () => {
    await load();
    await vi.waitFor(() => expect(document.querySelector('#msgs .msg[data-mid="m2"]')).not.toBeNull());
    (document.getElementById('text') as HTMLTextAreaElement).value = 'First thing';
    select('m2', 'every deploy');
    await vi.waitFor(() => expect(popup().hidden).toBe(false));
    $('qpop-go').click();
    expect((document.getElementById('text') as HTMLTextAreaElement).value).toBe('First thing\n\n> every deploy\n\n');
  });
  it('sends quote { message_id, text }, then draws it as a linked quote without repeating the > block', async () => {
    await load();
    await vi.waitFor(() => expect(document.querySelector('#msgs .msg[data-mid="m2"]')).not.toBeNull());
    select('m2', 'rebuilt nightly');
    await vi.waitFor(() => expect(popup().hidden).toBe(false));
    (document.getElementById('qpop-note') as HTMLInputElement).value = 'Why nightly?';
    $('qpop-go').click();
    $('composer').dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(posts.some(p => p.path.endsWith('/messages'))).toBe(true));
    const sent = posts.find(p => p.path.endsWith('/messages'))!.body;
    expect(sent.text).toBe('> rebuilt nightly\n\nWhy nightly?');
    expect(sent.quote).toEqual({ message_id: 'm2', text: 'rebuilt nightly' });
    expect(sent.reply_to).toBeUndefined();
    await vi.waitFor(() => expect(document.querySelector('#msgs .msg[data-mid="m3"] .quote')).not.toBeNull());
    const mine = document.querySelector('#msgs .msg[data-mid="m3"]')!;
    expect(mine.querySelector('.quote .snip')?.textContent).toBe('rebuilt nightly');
    expect(mine.querySelector('.quote strong')?.textContent).toBe('Agent');
    expect(mine.querySelector('blockquote')).toBeNull(); // the block is the quote, drawn once
    expect(mine.textContent).toContain('Why nightly?');
    (mine.querySelector('.quote') as HTMLButtonElement).click();
    expect(document.querySelector('#msgs .msg[data-mid="m2"]')!.classList.contains('flash')).toBe(true); // jumps to the source message
  });
  it('drops the quote when its block was deleted from the composer, and sends a plain message', async () => {
    await load();
    await vi.waitFor(() => expect(document.querySelector('#msgs .msg[data-mid="m2"]')).not.toBeNull());
    select('m2', 'rebuilt nightly');
    await vi.waitFor(() => expect(popup().hidden).toBe(false));
    $('qpop-go').click();
    (document.getElementById('text') as HTMLTextAreaElement).value = 'Never mind the quote';
    $('composer').dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(posts.some(p => p.path.endsWith('/messages'))).toBe(true));
    expect(posts.find(p => p.path.endsWith('/messages'))!.body.quote).toBeUndefined();
  });
  it('keeps a quote with no note: the block alone is the message and the quote is drawn once', async () => {
    await load();
    await vi.waitFor(() => expect(document.querySelector('#msgs .msg[data-mid="m2"]')).not.toBeNull());
    select('m2', 'rebuilt nightly and on every deploy');
    await vi.waitFor(() => expect(popup().hidden).toBe(false));
    $('qpop-go').click();
    $('composer').dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector('#msgs .msg[data-mid="m3"] .quote')).not.toBeNull());
    expect(posts.find(p => p.path.endsWith('/messages'))!.body.quote.text).toBe('rebuilt nightly and on every deploy');
  });
  it('offers nothing for a selection that spans two messages, a collapsed one, or one in the composer', async () => {
    await load();
    await vi.waitFor(() => expect(document.querySelector('#msgs .msg[data-mid="m2"]')).not.toBeNull());
    const textIn = (mid: string, part: string) => { const w = document.createTreeWalker(document.querySelector(`#msgs .msg[data-mid="${mid}"]`)!, NodeFilter.SHOW_TEXT); for (let t = w.nextNode(); t; t = w.nextNode()) if ((t.textContent ?? '').includes(part)) return t; throw new Error(part); };
    const range = document.createRange(); range.setStart(textIn('m1', 'Start'), 0); range.setEnd(textIn('m2', 'cache'), 5);
    const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise(r => setTimeout(r, 400));
    expect(popup().hidden).toBe(true);
    sel.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise(r => setTimeout(r, 300));
    expect(popup().hidden).toBe(true);
  });
  it('hides when the selection goes away', async () => {
    await load();
    await vi.waitFor(() => expect(document.querySelector('#msgs .msg[data-mid="m2"]')).not.toBeNull());
    select('m2', 'rebuilt');
    await vi.waitFor(() => expect(popup().hidden).toBe(false));
    window.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    await vi.waitFor(() => expect(popup().hidden).toBe(true));
  });
  it('a quote whose original is gone keeps its words, with a note', async () => {
    messages.push({ id: 'm3', author: 'user', text: '> old words\n\nstill here', images: [], created_at: at(3), quote: { message_id: 'm9', text: 'old words' } });
    await load();
    await vi.waitFor(() => expect(document.querySelector('#msgs .msg[data-mid="m3"] .quote.missing')).not.toBeNull());
    const gone = document.querySelector('#msgs .msg[data-mid="m3"] .quote.missing')!;
    expect(gone.textContent).toContain('old words');
    expect(gone.textContent).toContain('original message unavailable');
  });
});

describe('an expired question', () => {
  const question = { id: 'q2', prompt: 'Ship it?', multi: false, allow_other: true, options: [{ id: 'o1', label: 'Yes' }, { id: 'o2', label: 'No' }], expires_at: at(5) };
  beforeEach(() => { localStorage.clear(); withImage = false; target = null; messages = [
    { id: 'm1', author: 'user', text: 'Start', images: [], created_at: at(0) },
    { id: 'm2', author: 'agent', text: 'Ship it?', images: [], created_at: at(1), flag: 'needs_you', question: { ...question } },
  ]; });
  it('is one muted "Expired" line, out of the pinned bar, with its options hidden until shown (read-only)', async () => {
    (messages[1]!.question as Record<string, unknown>).expired = true; messages[1]!.flag = 'fyi';
    await load();
    await vi.waitFor(() => expect(document.querySelector('.qcard.expired')).not.toBeNull());
    expect(document.querySelector('.qclosed')!.textContent).toContain('Expired · Ship it?');
    expect(document.querySelector('.qcard.expired')!.getAttribute('aria-label')).toBe('Expired question');
    expect(document.querySelector('#msgs .qopt')).toBeNull();
    expect(($('waiting-bar') as HTMLElement).hidden).toBe(true);
    (document.querySelector('.qclosed .show') as HTMLButtonElement).click();
    expect(document.querySelector<HTMLButtonElement>('#msgs .qopt')?.disabled).toBe(true);
    expect(document.querySelector('#msgs .qsubmit')).toBeNull();
  });
  it('keeps typed text when it expires on the next poll, with Send as a message', async () => {
    await load();
    await vi.waitFor(() => expect(document.querySelector('#waiting-bar .qother')).not.toBeNull());
    document.querySelector<HTMLInputElement>('#waiting-bar .qother')!.value = 'Yes, after lunch';
    (messages[1]!.question as Record<string, unknown>).expired = true; messages[1]!.flag = 'fyi';
    await repoll();
    expect(document.querySelector<HTMLInputElement>('.qrescue .qother')?.value).toBe('Yes, after lunch');
    expect(document.querySelector('.qrescue')?.textContent).toContain('Send as a message');
    expect(($('waiting-bar') as HTMLElement).hidden).toBe(true);
    (document.querySelector('.qrescue button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(posts.some(p => p.path.endsWith('/messages') && p.body.text === 'Yes, after lunch' && p.body.reply_to === 'm2')).toBe(true));
  });
  it('a 409 "This question expired" on Submit turns into the same kept answer, with no error line', async () => {
    await load();
    await vi.waitFor(() => expect(document.querySelector('#waiting-bar .qother')).not.toBeNull());
    const input = document.querySelector<HTMLInputElement>('#waiting-bar .qother')!;
    input.value = 'kept-on-expiry';
    (messages[1]!.question as Record<string, unknown>).expired = true; messages[1]!.flag = 'fyi';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('.qrescue .qother')?.value).toBe('kept-on-expiry'));
    expect(($('error') as HTMLElement).hidden).toBe(true);
  });
});
