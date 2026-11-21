// 0.15 in the inbox page (happy-dom): kept drafts, typing pings, the new-topic nudge, reactions, multi-choice cards, the cross-project list, the Move chip and answers queued offline.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync('server/inbox/index.html', 'utf8');
const body = html.slice(html.indexOf('<body'), html.indexOf('<script type="module"')).replace(/<body[^>]*>/, '');
const at = (n: number) => `2026-11-18T10:${String(n).padStart(2, '0')}:00.000Z`;
const ID = '20261118-100000-abcd';
type Msg = Record<string, unknown>;
const added: [EventTarget, string, EventListenerOrEventListenerObject][] = [];
for (const target of [document, window]) {
  const original = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => { added.push([target, type, fn]); original(type, fn, opts as AddEventListenerOptions); }) as typeof target.addEventListener;
}
const opt = (id: string, label: string, extra: Msg = {}) => ({ id, label, ...extra });
const ask = (extra: Msg = {}, options = [opt('o1', 'Reuse'), opt('o2', 'Draw new')]) => ({ id: 'q2', prompt: 'Which pictures?', multi: false, allow_other: true, options, ...extra });
let messages: Msg[] = [];
let detailExtra: Msg = {};
let status = 'open';
let waiting: unknown = { count: 0, items: [] };
let projects: { id: string; name: string; unread: number }[] = [{ id: 'alpha', name: 'Alpha', unread: 0 }];
let down = false;
let answerReply: (payload: Record<string, unknown>) => { status: number; body: unknown } = () => ({ status: 201, body: {} });
const posts: { path: string; search: string; body: Record<string, any> }[] = [];
let unauthorized = false;
const thread = () => ({ id: ID, title: 'Pictures', origin: 'user', mode: 'thread', status, created_at: at(0), url: null, last_message_at: at(1), last_author: 'agent', unread_for_user: false, user_read_at: at(1), agent_read_at: at(1),
  open_question: true, waiting: 'you', last_flag: 'needs_you', checklist: { total: 0, done: 0, claimed: 0 }, open_for_you: 0, merged_into: null, read_only: false, acked_through: null, viewport: null, target: null, note: '',
  checklist_items: [], files: { image: false, annotated: false, context: false }, messages, ...detailExtra });
const $ = (id: string) => document.getElementById(id)!;
const wait = (ms = 0) => new Promise(r => setTimeout(r, ms));

async function load(hash = `#/${ID}`) {
  for (const [target, type, fn] of added.splice(0)) target.removeEventListener(type, fn);
  vi.resetModules(); posts.length = 0;
  document.body.innerHTML = body;
  location.hash = hash;
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
  HTMLDialogElement.prototype.close ??= function () { this.open = false; };
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (down) throw new TypeError('network down');
    const parsed = new URL(url, 'http://local');
    const path = parsed.pathname.replace(/^.*\/api\//, '');
    if (unauthorized) return { ok: false, status: 401, json: async () => ({ kind: 'unpaired' }), headers: { get: () => null } };
    const reply = (data: unknown, code = 200) => ({ ok: code < 400, status: code, json: async () => data, headers: { get: () => null } });
    if (init?.method === 'POST') {
      const payload = init.body ? JSON.parse(String(init.body)) as Record<string, any> : {};
      posts.push({ path, search: parsed.search, body: payload });
      if (path.endsWith('/answer')) {
        const r = answerReply(payload);
        if (r.status < 300) messages.push({ id: `m${messages.length + 1}`, author: 'user', text: 'Chose: x', images: [], created_at: at(messages.length + 1), client_id: payload.client_id, answer: { question_id: payload.question_id, option_ids: payload.option_ids ?? [] } });
        return reply(r.body, r.status);
      }
      if (path === 'threads') return reply({ id: '20261118-110000-beef' }, 201);
      if (path === 'threads/close-done') return reply({ closed: [ID] });
      return reply({});
    }
    if (path === 'threads') return reply([thread()]);
    if (path.startsWith('threads/')) return reply(thread());
    if (path === 'projects') return reply({ projects });
    if (path === 'waiting') return reply(waiting);
    if (path === 'profile') return reply({ user: { name: 'You' }, agent: { name: 'Agent' } });
    if (path === 'pins') return reply({ threads: [], areas: [] });
    if (path === 'areas') return reply({ areas: [] });
    return reply({});
  }));
  await import('../inbox/app.js');
  await vi.waitFor(() => expect(document.querySelectorAll('#msgs .msg').length).toBeGreaterThan(0));
}
const base = (q: Msg | null = ask()) => [{ id: 'm1', author: 'user', text: 'Start', images: [], created_at: at(0) }, { id: 'm2', author: 'agent', text: 'Which pictures?', images: [], created_at: at(1), flag: 'needs_you', ...(q ? { question: q } : {}) }];
const typeIn = (node: HTMLInputElement | HTMLTextAreaElement, value: string) => { node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); };
const draftStore = () => JSON.parse(localStorage.getItem('fb-inbox-drafts') || '{}') as Record<string, { t: string }>;
const poll = async () => { const before = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length; document.dispatchEvent(new Event('visibilitychange')); await vi.waitFor(() => expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(before + 3)); await wait(); };

beforeEach(() => { unauthorized = false; localStorage.clear(); messages = base(); detailExtra = {}; status = 'open'; waiting = { count: 0, items: [] }; down = false; answerReply = () => ({ status: 201, body: {} }); projects = [{ id: 'alpha', name: 'Alpha', unread: 0 }]; });

describe('what you type is kept', () => {
  it('the composer is kept per thread and comes back after a reload; sending clears it', async () => {
    await load();
    typeIn($('text') as HTMLTextAreaElement, 'half a thought');
    expect(Object.values(draftStore()).map(d => d.t)).toEqual(['half a thought']);
    await poll(); expect(($('text') as HTMLTextAreaElement).value).toBe('half a thought');
    await load();
    expect(($('text') as HTMLTextAreaElement).value).toBe('half a thought');
    $('composer').dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(posts.some(p => p.path.endsWith('/messages'))).toBe(true));
    await vi.waitFor(() => expect(draftStore()).toEqual({}));
  });
  it('an Other answer survives a reload, a withdrawal and a re-ask, and Send as a message posts it', async () => {
    await load();
    const box = document.querySelector<HTMLInputElement>('#msgs .qother')!;
    typeIn(box, 'Reuse them, redraw the cover');
    expect(Object.keys(draftStore()).some(k => k.endsWith('|q:q2'))).toBe(true);
    messages[1] = { ...messages[1], question: ask({ withdrawn: { at: at(2) } }) };
    await load();
    const kept = document.querySelector<HTMLInputElement>('#msgs .qrescue .qother')!;
    expect(kept.value).toBe('Reuse them, redraw the cover');
    [...document.querySelectorAll<HTMLButtonElement>('#msgs .qrescue button')].find(b => b.textContent === 'Send as a message')!.click();
    await vi.waitFor(() => expect(posts.some(p => p.path.endsWith('/messages') && p.body.text === 'Reuse them, redraw the cover' && p.body.reply_to === 'm2')).toBe(true));
    await vi.waitFor(() => expect(draftStore()).toEqual({}));
  });
  it('a typed answer whose question is gone from the thread is kept below it, with Send as a message', async () => {
    localStorage.setItem('fb-inbox-drafts', JSON.stringify({ [`alpha|${ID}|q:q9`]: { t: 'my answer to a vanished question', at: Date.now() } }));
    await load();
    const row = document.querySelector<HTMLElement>('#kept-answers [data-kept="q9"]')!;
    expect(row.querySelector<HTMLInputElement>('input')!.value).toBe('my answer to a vanished question');
    [...row.querySelectorAll('button')].find(b => b.textContent === 'Send as a message')!.click();
    await vi.waitFor(() => expect(posts.some(p => p.path.endsWith('/messages') && p.body.text === 'my answer to a vanished question')).toBe(true));
  });
  it('storage that throws never breaks the page', async () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('blocked'); };
    try { await load(); typeIn($('text') as HTMLTextAreaElement, 'still works'); expect(($('text') as HTMLTextAreaElement).value).toBe('still works'); } finally { Storage.prototype.setItem = original; }
  });
  it('typing tells the server the person is typing (a debounced ping), and sending says they stopped', async () => {
    await load();
    await wait(450); posts.length = 0; // pings still pending from an earlier test's page instance
    typeIn($('text') as HTMLTextAreaElement, 'a');
    typeIn($('text') as HTMLTextAreaElement, 'ab');
    await vi.waitFor(() => expect(posts.filter(p => p.path === `threads/${ID}/typing`).length).toBe(1), { timeout: 2000 });
    expect(posts.find(p => p.path.endsWith('/typing'))!.body).toEqual({ typing: true }); // never the words
    $('composer').dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(posts.some(p => p.path.endsWith('/typing') && p.body.typing === false)).toBe(true));
  });
});

describe('cards', () => {
  it('a multi card has real checkboxes; a recommended option says so', async () => {
    messages = base(ask({ multi: true, options: [opt('o1', 'Reuse', { recommended: true }), opt('o2', 'Draw new'), opt('o3', 'Skip')] }));
    await load();
    const boxes = document.querySelectorAll<HTMLInputElement>('#msgs .qcard input[type="checkbox"]');
    expect(boxes.length).toBe(3);
    expect(document.querySelector('#msgs .qopt .rec')!.textContent).toBe('Recommended');
    boxes[0]!.checked = true; boxes[0]!.dispatchEvent(new Event('change', { bubbles: true }));
    boxes[2]!.checked = true; boxes[2]!.dispatchEvent(new Event('change', { bubbles: true }));
    (document.querySelector('#msgs .qsubmit') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(posts.find(p => p.path.endsWith('/answer'))?.body.option_ids).toEqual(['o1', 'o3']));
  });
  it('picking an option clears Other with a visible hint and an Undo; typing Other clears the option', async () => {
    messages = base(ask({ multi: true, options: [opt('o1', 'Reuse'), opt('o2', 'Draw new')] }));
    await load();
    const other = document.querySelector<HTMLInputElement>('#msgs .qother')!;
    typeIn(other, 'my own');
    const box = document.querySelector<HTMLInputElement>('#msgs input[type="checkbox"]')!;
    box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true }));
    expect(other.value).toBe('');
    expect(document.querySelector('#msgs .qhint')!.textContent).toContain('cleared because you picked an option');
    [...document.querySelectorAll<HTMLButtonElement>('#msgs .qhint button')].find(b => b.textContent === 'Undo')!.click();
    expect(other.value).toBe('my own'); expect(box.checked).toBe(false);
    box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true }));
    typeIn(other, 'again');
    expect(box.checked).toBe(false);
    expect(document.querySelector('#msgs .qhint')!.textContent).toContain('cleared the option');
    expect(posts.some(p => p.path.endsWith('/answer'))).toBe(false); // nothing was sent together by accident
  });
});

describe('a new topic', () => {
  const send = (text: string) => { typeIn($('text') as HTMLTextAreaElement, text); $('composer').dispatchEvent(new Event('submit', { cancelable: true })); };
  it('"Also …" offers a new thread with the title filled in; Send as a new thread creates it, and nothing is posted to this one', async () => {
    messages = base(null);
    await load();
    send('Also, can the logo be bigger? It looks small on the phone.');
    await vi.waitFor(() => expect(($('nudge-dialog') as HTMLDialogElement).open).toBe(true));
    expect(($('nudge-title') as HTMLInputElement).value).toBe('Can the logo be bigger?');
    $('nudge-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(posts.find(p => p.path === 'threads')?.body).toMatchObject({ title: 'Can the logo be bigger?', text: 'Also, can the logo be bigger? It looks small on the phone.' }));
    expect(posts.some(p => p.path.endsWith('/messages'))).toBe(false);
  });
  it('Send here goes to this thread; an ordinary message does not ask at all', async () => {
    messages = base(null);
    await load();
    send('Separately, one more thing.');
    await vi.waitFor(() => expect(($('nudge-dialog') as HTMLDialogElement).open).toBe(true));
    $('nudge-here').click();
    await vi.waitFor(() => expect(posts.some(p => p.path === `threads/${ID}/messages` && p.body.text === 'Separately, one more thing.')).toBe(true));
    await vi.waitFor(() => expect(($('send') as HTMLButtonElement).disabled).toBe(false));
    send('plain reply');
    await vi.waitFor(() => expect(posts.filter(p => p.path.endsWith('/messages')).length).toBe(2));
    expect(($('nudge-dialog') as HTMLDialogElement).open).toBe(false);
  });
});

describe('reactions and closing', () => {
  it('Close all done threads shows how many and closes them', async () => {
    messages = [{ id: 'm1', author: 'agent', text: 'All shipped', images: [], created_at: at(1), flag: 'done' }];
    detailExtra = { waiting: 'idle', last_flag: 'done', last_author: 'agent' };
    await load();
    const b = $('close-done') as HTMLButtonElement;
    await vi.waitFor(() => expect(b.hidden).toBe(false));
    expect(b.textContent).toBe('Close all done threads (1)');
    b.click();
    await vi.waitFor(() => expect(posts.some(p => p.path === 'threads/close-done')).toBe(true));
  });
});

describe('waiting on you across projects, and the Move chip', () => {
  it('the header button counts every project\'s open questions and needs-you items, and a row opens its thread', async () => {
    projects = [{ id: 'alpha', name: 'Alpha', unread: 0 }, { id: 'beta', name: 'Beta', unread: 1 }];
    waiting = { count: 2, items: [{ project: 'alpha', project_name: 'Alpha', thread: ID, title: 'Pictures', kind: 'question', text: 'Which pictures?', at: at(1) }, { project: 'beta', project_name: 'Beta', thread: '20261118-120000-cafe', title: 'Billing', kind: 'needs_you', text: 'Look', at: at(2) }] };
    await load();
    await vi.waitFor(() => expect($('waiting-all-count').textContent).toBe('2'));
    $('waiting-all').click();
    expect(($('waiting-all-dialog') as HTMLDialogElement).open).toBe(true);
    expect(document.querySelectorAll('#waiting-all-list .wa-row').length).toBe(2);
    expect(document.querySelector('#waiting-all-list [data-project="beta"] h3')!.textContent).toBe('Beta');
    document.querySelector<HTMLButtonElement>('#waiting-all-list .wa-row[data-thread="20261118-120000-cafe"]')!.click();
    await vi.waitFor(() => expect(location.hash).toBe('#/20261118-120000-cafe'));
  });
  it('an unmatched capture shows a Move chip naming the best project, and one tap moves it', async () => {
    projects = [{ id: 'alpha', name: 'Alpha', unread: 0 }, { id: 'beta', name: 'Beta', unread: 0 }];
    detailExtra = { unmatched: true, suggested_project: { id: 'beta', name: 'Beta' } };
    await load();
    const chip = $('move-chip') as HTMLButtonElement;
    await vi.waitFor(() => expect(chip.hidden).toBe(false));
    expect(chip.textContent).toBe('Move to Beta…');
    chip.click();
    await vi.waitFor(() => expect(posts.find(p => p.path.endsWith('/move-project'))?.body).toEqual({ project: 'beta', force: true }));
  });
});

describe('answering a card while offline', () => {
  const choose = async (label: string) => { [...document.querySelectorAll<HTMLButtonElement>('#msgs .qopt')].find(b => b.textContent?.includes(label))!.click(); await wait(20); };
  it('is queued, shown as pending on the card, sent once when back online with its client id, and the card then reads Answered', async () => {
    await load();
    down = true;
    await choose('Draw new');
    const card = document.querySelector<HTMLElement>('#msgs .qcard')!;
    await vi.waitFor(() => expect(card.isConnected && document.querySelector('#msgs .qpending')?.textContent).toContain("will send when you're back online"));
    expect(document.querySelector('#msgs .qpending')!.textContent).toContain('Draw new');
    expect(posts.filter(p => p.path.endsWith('/answer')).length).toBe(0);
    expect(document.querySelectorAll('#msgs .qopt:not(:disabled)').length).toBe(0);
    down = false;
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(posts.filter(p => p.path.endsWith('/answer')).length).toBe(1));
    const sent = posts.find(p => p.path.endsWith('/answer'))!.body;
    expect(sent).toMatchObject({ question_id: 'q2', option_ids: ['o2'], client_id: expect.any(String), written_at: expect.any(String) });
    await vi.waitFor(() => expect(document.querySelector('#msgs .qpending')).toBeNull());
    await wait(30);
    expect(posts.filter(p => p.path.endsWith('/answer')).length).toBe(1);
  });
  it('an Other answer written offline is queued too, and the typed box is emptied only because it is in the queue', async () => {
    await load();
    down = true;
    const other = document.querySelector<HTMLInputElement>('#msgs .qother')!;
    typeIn(other, 'something else entirely');
    other.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector('#msgs .qpending')?.textContent).toContain('something else entirely'));
    expect(draftStore()).toEqual({});
  });
  it('if the question was withdrawn meanwhile, the answer is kept under it with Send as a message (nothing is lost)', async () => {
    await load();
    down = true;
    await choose('Reuse');
    await vi.waitFor(() => expect(document.querySelector('#msgs .qpending')).not.toBeNull());
    messages[1] = { ...messages[1], question: ask({ withdrawn: { at: at(3) } }) };
    answerReply = () => ({ status: 409, body: { detail: 'That question was withdrawn' } });
    down = false;
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(document.querySelector('#msgs .qrescue .qother')).not.toBeNull());
    expect(document.querySelector<HTMLInputElement>('#msgs .qrescue .qother')!.value).toBe('Reuse');
    [...document.querySelectorAll<HTMLButtonElement>('#msgs .qrescue button')].find(b => b.textContent === 'Send as a message')!.click();
    await vi.waitFor(() => expect(posts.some(p => p.path.endsWith('/messages') && p.body.text === 'Reuse' && p.body.reply_to === 'm2')).toBe(true));
  });
});

describe('copying a message', () => {
  const md = '**Done.** See `a.ts`:\n\n- one\n- two';
  const setup = async (extra: Msg = {}) => {
    messages = [{ id: 'm1', author: 'user', text: 'Start', images: [], created_at: at(0) }, { id: 'm2', author: 'agent', text: md, images: [], created_at: at(1), flag: 'fyi', reply_to: 'm1', ...extra },
      { id: 'm3', author: 'user', text: 'Secret words', images: [], created_at: at(2), redacted: { at: at(3), by: 'user', key: 'k' } }];
    await load();
  };
  const msg = (id: string) => document.querySelector<HTMLElement>(`#msgs [data-mid="${id}"]`)!;
  it('Copy puts the message\'s Markdown (not the drawn HTML, not the quote it replied to) on the clipboard and says Copied', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await setup();
    msg('m2').querySelector<HTMLButtonElement>('.copy-btn')!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(md));
    await vi.waitFor(() => expect($('toast').textContent).toBe('Copied'));
    // the same action is in the message's ⋯ menu
    writeText.mockClear();
    msg('m2').querySelector<HTMLButtonElement>('.msg-actions')!.click();
    [...document.querySelectorAll<HTMLButtonElement>('#popmenu button')].find(b => b.textContent === 'Copy')!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(md));
  });
  it('falls back to a hidden textarea and execCommand when the clipboard API is missing, and a redacted message has no Copy', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const exec = vi.fn(() => true); (document as unknown as { execCommand: unknown }).execCommand = exec;
    await setup();
    msg('m2').querySelector<HTMLButtonElement>('.copy-btn')!.click();
    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith('copy'));
    await vi.waitFor(() => expect($('toast').textContent).toBe('Copied'));
    expect(document.querySelector('body > textarea[readonly]')).toBeNull(); // cleaned up
    expect(msg('m3').querySelector('.copy-btn')).toBeNull();
    expect(msg('m3').querySelector('.msg-actions, .msg-more')).toBeNull();
  });
  it('a copy that cannot be made says so', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    (document as unknown as { execCommand: unknown }).execCommand = () => false;
    await setup();
    msg('m2').querySelector<HTMLButtonElement>('.copy-btn')!.click();
    await vi.waitFor(() => expect($('toast').textContent).toBe("Couldn't copy"));
  });
});

describe('review fixes in the page', () => {
  const twoProjects = () => { projects = [{ id: 'alpha', name: 'Alpha', unread: 0 }, { id: 'beta', name: 'Beta', unread: 0 }]; localStorage.setItem('fb-inbox-project', 'beta'); };
  it('an answer and a message written offline in the second project are sent to that project, not the first', async () => {
    twoProjects();
    await load();
    down = true;
    [...document.querySelectorAll<HTMLButtonElement>('#msgs .qopt')].find(b => b.textContent?.includes('Draw new'))!.click();
    await vi.waitFor(() => expect(document.querySelector('#msgs .qpending')).not.toBeNull());
    typeIn($('text') as HTMLTextAreaElement, 'a note written offline');
    $('composer').dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(document.querySelectorAll('#msgs [data-queued]').length).toBeGreaterThan(1));
    down = false;
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(posts.some(p => p.path.endsWith('/answer')) && posts.some(p => p.path.endsWith('/messages'))).toBe(true), { timeout: 4000 });
    for (const p of posts.filter(p => p.path.endsWith('/answer') || p.path.endsWith('/messages'))) expect(p.search).toBe('?project=beta');
  });
  it('the project is kept on a queued entry: an old entry with none goes to the default project', async () => {
    twoProjects();
    await load();
    down = true;
    [...document.querySelectorAll<HTMLButtonElement>('#msgs .qopt')].find(b => b.textContent?.includes('Reuse'))!.click();
    await vi.waitFor(() => expect(document.querySelector('#msgs .qpending')).not.toBeNull());
    down = false;
    answerReply = () => ({ status: 409, body: { detail: 'That question was withdrawn' } });
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(posts.some(p => p.path.endsWith('/answer'))).toBe(true), { timeout: 4000 });
    expect(posts.find(p => p.path.endsWith('/answer'))!.search).toBe('?project=beta');
    await vi.waitFor(() => expect(Object.keys(draftStore())).toContain(`beta|${ID}|q:q2`)); // kept under the project the answer was written in
  });
  it('a 401 (an unpaired or revoked device) clears the kept drafts', async () => {
    await load();
    typeIn($('text') as HTMLTextAreaElement, 'private words');
    expect(Object.keys(draftStore()).length).toBe(1);
    unauthorized = true;
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(localStorage.getItem('fb-inbox-drafts')).toBeNull());
  });
  it('Close all done threads offers Undo, which reopens exactly the ids that were closed', async () => {
    messages = [{ id: 'm1', author: 'agent', text: 'All shipped', images: [], created_at: at(1), flag: 'done' }];
    detailExtra = { waiting: 'idle', last_flag: 'done', last_author: 'agent' };
    await load();
    await vi.waitFor(() => expect(($('close-done') as HTMLButtonElement).hidden).toBe(false));
    $('close-done').click();
    await vi.waitFor(() => expect($('toast').querySelector('.toast-act')?.textContent).toBe('Undo'));
    $('toast').querySelector<HTMLButtonElement>('.toast-act')!.click();
    await vi.waitFor(() => expect(posts.find(p => p.path === 'threads/reopen')?.body).toEqual({ ids: [ID] }));
  });
});
