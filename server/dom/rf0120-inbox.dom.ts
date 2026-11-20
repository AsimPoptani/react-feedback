// 0.12.0 in the inbox page (happy-dom): typing in a merged-away thread, the owner's capture on an artifact, and Watch live on a recording that is still coming in.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync('server/inbox/index.html', 'utf8');
const body = html.slice(html.indexOf('<body'), html.indexOf('<script type="module"')).replace(/<body[^>]*>/, '');
const at = (n: number) => `2026-11-20T10:2${n}:00.000Z`;
const sourceId = '20261118-100000-abcd';
const targetId = '20261118-100001-abce';
const artId = 'a0123456789ab';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const SESSION_A = 'AbCdEfGhIjKlMnOpQrStUvWx';
const SESSION_B = 'ZyXwVuTsRqPoNmLkJiHgFeDc';
const question = { id: 'q4', prompt: 'Which option?', multi: false, allow_other: true, options: [{ id: 'o1', label: 'First' }] };
const summary = (id: string, title: string, merged: string | null) => ({ id, title, origin: 'user', mode: 'thread', status: merged ? 'done' : 'open', created_at: at(0), url: null, last_message_at: at(1), last_author: 'agent',
  unread_for_user: false, user_read_at: at(1), agent_read_at: at(1), open_question: !merged, waiting: merged ? 'done' : 'you', last_flag: 'needs_you', checklist: { total: 0, done: 0, claimed: 0 }, open_for_you: 0,
  merged_into: merged, read_only: false, acked_through: null });
const threadMessages = [
  { id: 'm1', author: 'user', text: 'Hello', images: [], created_at: at(0) },
  { id: 'm4', author: 'agent', text: question.prompt, images: [], created_at: at(1), flag: 'needs_you', question },
];
let posts: { path: string; body: Record<string, unknown> }[] = [];
let gets: string[] = [];
let replays: Record<string, unknown>[] = [];
let readReplies: { events: unknown[]; cursor: number; live: boolean }[] = [];
const frameWindows = new Map<string, { postMessage: ReturnType<typeof vi.fn> }>();

async function load(hash: string) {
  vi.resetModules(); posts = []; gets = []; frameWindows.clear();
  document.body.innerHTML = body;
  location.hash = hash;
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const full = new URL(url, 'http://local');
    const path = full.pathname.replace(/^.*\/api\//, '') + full.search.replace(/[?&]capture=1/, '');
    const ok = (data: unknown, status = 200) => ({ ok: status < 300, status, headers: new Headers(), json: async () => data });
    if (init?.method === 'POST') {
      const data = JSON.parse(String(init.body));
      posts.push({ path, body: data });
      if (path === `threads/${sourceId}/messages`) return ok({ id: 'm9', author: 'user', text: data.text, images: [], created_at: at(2), forwarded_to: targetId }, 201);
      if (path === `threads/20261118-100002-abcf/messages`) return ok({ id: 'm5', author: 'user', text: data.text, images: [], created_at: at(2) }, 201);
      return ok({});
    }
    gets.push(path);
    if (path === 'threads') return ok([summary(sourceId, 'Side thread', targetId), summary(targetId, 'Main thread', null)]);
    if (path === `threads/${sourceId}`) return ok({ ...summary(sourceId, 'Side thread', targetId), note: '', checklist_items: [], viewport: null, target: null, files: { image: false, annotated: false, context: false }, messages: threadMessages });
    if (path === `threads/${targetId}`) return ok({ ...summary(targetId, 'Main thread', null), note: '', checklist_items: [], viewport: null, target: null, files: { image: false, annotated: false, context: false }, messages: [{ id: 'm1', author: 'user', text: 'Target', images: [], created_at: at(0) }] });
    if (path === `artifacts/${artId}`) return ok({ id: artId, thread: '20261118-100002-abcf', title: 'Checkout page', latest: 1, versions: [{ n: 1 }], links: 0, views: 0, shares: [], updated_at: at(0) });
    if (path === `artifacts/${artId}/replays`) return ok(replays);
    if (path.startsWith(`artifacts/${artId}/replays/${SESSION_A}?after=`)) { const next = readReplies.shift(); return next ? ok(next) : ok({ events: [], cursor: 0, live: true }); }
    if (path === 'profile') return ok({ user: { name: 'You' }, agent: { name: 'Agent' } });
    if (path === 'pins') return ok({ threads: [], areas: [] });
    if (path === 'areas') return ok({ areas: [] });
    return ok({});
  }));
  await import('../inbox/app.js');
}
// A frame's window is a stand-in we control: the page believes only messages whose source is exactly it.
function fakeFrame(id: string) {
  const frame = document.getElementById(id) as HTMLIFrameElement;
  const win = { postMessage: vi.fn() };
  Object.defineProperty(frame, 'contentWindow', { value: win, configurable: true });
  frameWindows.set(id, win);
  return win;
}
const from = (source: unknown, data: unknown) => { const e = new Event('message') as Event & { source: unknown; data: unknown }; e.source = source; e.data = data; window.dispatchEvent(e); };

describe('0.12.0 inbox page', () => {
  const added: [EventTarget, string, EventListenerOrEventListenerObject][] = [];
  beforeEach(() => {
    localStorage.clear(); added.length = 0; replays = []; readReplies = [];
    for (const target of [window, document]) {
      const real = target.addEventListener.bind(target);
      vi.spyOn(target, 'addEventListener').mockImplementation((type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => { added.push([target, type, fn]); real(type, fn, opts); });
    }
  });
  afterEach(() => { for (const [target, type, fn] of added) target.removeEventListener(type, fn); vi.restoreAllMocks(); vi.unstubAllGlobals(); location.hash = ''; });

  describe('a merged-away thread', () => {
    it('keeps the composer open, with a note directly above it, and a send goes to the target: a toast names it and the target opens', async () => {
      await load(`#/${sourceId}`);
      await vi.waitFor(() => expect(document.getElementById('merged-note')!.hidden).toBe(false));
      const note = document.getElementById('merged-note')!;
      expect(note.textContent).toBe('This thread was merged into Main thread. What you send goes there. · Open');
      expect(note.querySelector('a')!.getAttribute('href')).toBe(`#/${targetId}`);
      expect(note.nextElementSibling!.id).toBe('composer'); // directly above the composer
      for (const id of ['text', 'send', 'attach', 'attach-file', 'plus']) expect((document.getElementById(id) as HTMLButtonElement).disabled, id).toBe(false);
      expect((document.getElementById('text') as HTMLTextAreaElement).readOnly).toBe(false);
      // The question stays read-only.
      expect(document.querySelector<HTMLButtonElement>(`[data-question="${question.id}"] .qopt`)!.disabled).toBe(true);
      const text = document.getElementById('text') as HTMLTextAreaElement;
      text.value = 'Typed after the merge';
      document.getElementById('composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(location.hash).toBe(`#/${targetId}`));
      expect(posts.find(p => p.path === `threads/${sourceId}/messages`)!.body).toMatchObject({ text: 'Typed after the merge' });
      expect(document.getElementById('toast')!.textContent).toBe('Sent to Main thread');
      expect(document.getElementById('toast')!.hidden).toBe(false);
      await vi.waitFor(() => expect(document.getElementById('merged-note')!.hidden).toBe(true));
      expect((document.getElementById('text') as HTMLTextAreaElement).value).toBe(''); // what was sent is not brought back as a draft
    });

    it('an image goes the same way (the composer takes an image, and the post names it)', async () => {
      await load(`#/${sourceId}`);
      await vi.waitFor(() => expect(document.getElementById('merged-note')!.hidden).toBe(false));
      const input = document.getElementById('file') as HTMLInputElement;
      expect(input.disabled).toBe(false);
      expect((document.getElementById('attach') as HTMLButtonElement).disabled).toBe(false);
      expect((document.getElementById('attach-file') as HTMLButtonElement).disabled).toBe(false);
    });
  });

  describe('the owner\'s capture of an artifact', () => {
    async function open() {
      await load(`#/artifact/${artId}`);
      await vi.waitFor(() => expect(document.getElementById('artifact-frame')).not.toBeNull());
      await vi.waitFor(() => expect(document.getElementById('artifact-title')!.textContent).toBe('Checkout page'));
      return fakeFrame('artifact-frame');
    }
    const shot = { rf: 'shot', note: 'The header overlaps the form', mode: 'region', image: PNG, rect: { x: 10, y: 10, width: 200, height: 100 }, viewport: { width: 400, height: 800 }, selector: '', text: '', components: [] };

    it('loads the page with the capture script, shows Feedback only once the page says it is ready, and starts a capture on a click', async () => {
      const win = await open();
      expect((document.getElementById('artifact-frame') as HTMLIFrameElement).getAttribute('src')).toBe(`/__feedback/a/${artId}/v1?capture=1`);
      expect((document.getElementById('artifact-capture') as HTMLElement).hidden).toBe(true);
      from({}, { rf: 'cap-ready' }); // not the frame
      expect((document.getElementById('artifact-capture') as HTMLElement).hidden).toBe(true);
      from(win, { rf: 'cap-ready' });
      expect((document.getElementById('artifact-capture') as HTMLElement).hidden).toBe(false);
      document.getElementById('artifact-capture')!.click();
      expect((document.getElementById('cap-modes') as HTMLElement).hidden).toBe(false);
      document.querySelector<HTMLButtonElement>('#cap-modes [data-capture="element"]')!.click();
      expect(win.postMessage).toHaveBeenCalledWith({ rf: 'cap', op: 'start', mode: 'element', maxBytes: 6_000_000 }, '*');
      expect((document.getElementById('artifact-capture') as HTMLElement).hidden).toBe(true);
      from(win, { rf: 'cap-closed' });
      expect((document.getElementById('artifact-capture') as HTMLElement).hidden).toBe(false);
    });

    it('a capture from the page is posted to the artifact\'s thread as a message from you, with the picture', async () => {
      const win = await open();
      from(win, { rf: 'cap-ready' });
      from(win, shot);
      await vi.waitFor(() => expect(posts.some(p => p.path === 'threads/20261118-100002-abcf/messages')).toBe(true));
      const sent = posts.find(p => p.path === 'threads/20261118-100002-abcf/messages')!.body;
      expect(sent.images).toEqual([PNG]);
      expect(String(sent.text)).toContain('The header overlaps the form');
      expect(String(sent.text)).toContain('Checkout page v1 · Region');
      await vi.waitFor(() => expect(document.getElementById('toast')!.textContent).toBe('Sent to this artifact’s thread'));
    });

    it('a message from any other window posts nothing, and bad fields are dropped before anything is posted', async () => {
      const win = await open();
      from({}, shot);
      from(window, shot);
      from(win, { ...shot, mode: 'bogus' });
      from(win, { ...shot, note: '' });
      await new Promise(r => setTimeout(r, 30));
      expect(posts.filter(p => p.path.endsWith('/messages'))).toHaveLength(0);
      from(win, { ...shot, mode: 'element', selector: 'button#pay', image: 'javascript:alert(1)', rect: { x: Number.NaN, y: 0, width: 1, height: 1 } });
      await vi.waitFor(() => expect(posts.filter(p => p.path.endsWith('/messages'))).toHaveLength(1));
      const sent = posts.find(p => p.path.endsWith('/messages'))!.body;
      expect(sent.images).toEqual([]);
      expect(String(sent.text)).toContain('Element · `button#pay`');
    });
  });

  describe('watching a session live', () => {
    const row = (session: string, live: boolean) => ({ session, scope: artId, link: 's0000abcd', version: 1, started_at: at(0), last_at: at(1), duration_ms: 12_000, clicks: 2, events: 40, bytes: 1000, seq: 3, first_ts: 1, last_ts: 2, viewport: { w: 800, h: 600 }, scroll_y: 0, live });
    const ev = (t: number) => ({ type: 3, timestamp: t, data: { source: 1 } });
    async function openReplays() {
      await load(`#/artifact/${artId}`);
      await vi.waitFor(() => expect(document.getElementById('artifact-title')!.textContent).toBe('Checkout page'));
      document.getElementById('tab-replays')!.click();
      await vi.waitFor(() => expect(document.querySelectorAll('#replays-list .replay-row').length).toBeGreaterThan(0));
    }

    it('a session with a chunk in the last 20 s shows Live and Watch live; a recorded one keeps Play only', async () => {
      replays = [row(SESSION_A, true), row(SESSION_B, false)];
      await openReplays();
      const [live, done] = [...document.querySelectorAll<HTMLElement>('#replays-list .replay-row')];
      expect(live!.textContent).toContain('● Live');
      expect([...live!.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Watch live', 'Play', 'Delete']);
      expect(done!.textContent).not.toContain('Live');
      expect([...done!.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Play', 'Delete']);
    });

    it('Watch live opens the player, passes what is there, then new events by cursor, and says ended once the server says the session is no longer live', async () => {
      replays = [row(SESSION_A, true)];
      readReplies = [
        { events: [ev(1000), ev(1010)], cursor: 2, live: true },   // the first read (after=0)
        { events: [ev(1020), ev(1030)], cursor: 4, live: true },   // the first poll
        { events: [], cursor: 4, live: false },                     // then nothing for 30 s
      ];
      await openReplays();
      const win = fakeFrame('replay-frame');
      [...document.querySelectorAll<HTMLButtonElement>('#replays-list button')].find(b => b.textContent === 'Watch live')!.click();
      await vi.waitFor(() => expect((document.getElementById('replay-dialog') as HTMLDialogElement).hasAttribute('open')).toBe(true));
      expect(gets).toContain(`artifacts/${artId}/replays/${SESSION_A}?after=0`);
      expect(document.getElementById('replay-meta')!.textContent).toContain('LIVE');
      // Nothing is sent to a window that is not the player's own frame, and the player is told only when it says it is ready.
      from({}, { rf: 'player-ready' });
      expect(win.postMessage).not.toHaveBeenCalled();
      from(win, { rf: 'player-ready' });
      expect(win.postMessage).toHaveBeenCalledWith(expect.objectContaining({ rf: 'live', events: [ev(1000), ev(1010)] }), '*');
      await vi.waitFor(() => expect(win.postMessage).toHaveBeenCalledWith({ rf: 'more', events: [ev(1020), ev(1030)] }, '*'), { timeout: 5000 });
      expect(gets).toContain(`artifacts/${artId}/replays/${SESSION_A}?after=2`);
      await vi.waitFor(() => expect(win.postMessage).toHaveBeenCalledWith({ rf: 'ended' }, '*'), { timeout: 5000 });
      expect(gets).toContain(`artifacts/${artId}/replays/${SESSION_A}?after=4`);
      expect(document.getElementById('replay-meta')!.textContent).toContain('ended');
    }, 15000);

    it('closing the player stops the polling', async () => {
      replays = [row(SESSION_A, true)];
      readReplies = [{ events: [ev(1000)], cursor: 1, live: true }];
      await openReplays();
      const win = fakeFrame('replay-frame');
      [...document.querySelectorAll<HTMLButtonElement>('#replays-list button')].find(b => b.textContent === 'Watch live')!.click();
      await vi.waitFor(() => expect((document.getElementById('replay-dialog') as HTMLDialogElement).hasAttribute('open')).toBe(true));
      from(win, { rf: 'player-ready' });
      document.getElementById('replay-close')!.click();
      const polls = () => gets.filter(g => g.includes('?after=')).length;
      const before = polls(); // the first read only
      await new Promise(r => setTimeout(r, 2600));
      expect(polls()).toBe(before);
    }, 10000);
  });
});
