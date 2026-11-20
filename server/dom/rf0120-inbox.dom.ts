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
// Send as you ignores clicks in its first 700 ms; step the clock past that before a click.
const pastClickGuard = () => { const t = Date.now() + 1000; vi.spyOn(Date, 'now').mockReturnValue(t); };

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
      expect(win.postMessage).toHaveBeenCalledWith({ rf: 'cap', op: 'start', mode: 'element', maxBytes: 6_000_000, nonce: expect.stringMatching(/^[0-9a-f]{24}$/) }, '*');
      expect((document.getElementById('artifact-capture') as HTMLElement).hidden).toBe(true);
      from(win, { rf: 'cap-closed' });
      expect((document.getElementById('artifact-capture') as HTMLElement).hidden).toBe(false);
    });

    // The owner picks a mode (which arms one capture and sends a one-time word); the page's answer must carry it.
    const arm = (win: { postMessage: ReturnType<typeof vi.fn> }, mode = 'region') => {
      from(win, { rf: 'cap-ready' });
      document.getElementById('artifact-capture')!.click();
      document.querySelector<HTMLButtonElement>(`#cap-modes [data-capture="${mode}"]`)!.click();
      return (win.postMessage.mock.calls.at(-1)![0] as { nonce: string }).nonce;
    };
    const messagePosts = () => posts.filter(p => p.path.endsWith('/messages'));
    const confirmOpen = () => (document.getElementById('cap-confirm') as HTMLDialogElement).hasAttribute('open');

    it('a capture the owner asked for is shown in an inbox panel as the page sent it; nothing is posted until Send as you, and the note can be changed there', async () => {
      const win = await open();
      const nonce = arm(win);
      from(win, { ...shot, nonce });
      await vi.waitFor(() => expect(confirmOpen()).toBe(true));
      expect(messagePosts()).toHaveLength(0); // shown, not posted
      expect((document.getElementById('cap-confirm-note') as HTMLTextAreaElement).value).toBe('The header overlaps the form');
      expect((document.getElementById('cap-confirm-img') as HTMLImageElement).getAttribute('src')).toBe(PNG);
      expect(document.getElementById('cap-confirm-where')!.textContent).toContain('Checkout page v1 \u00b7 Region');
      (document.getElementById('cap-confirm-note') as HTMLTextAreaElement).value = 'My own words instead';
      pastClickGuard(); document.getElementById('cap-confirm-send')!.click();
      await vi.waitFor(() => expect(messagePosts()).toHaveLength(1));
      const sent = messagePosts()[0]!;
      expect(sent.path).toBe('threads/20261118-100002-abcf/messages');
      expect(sent.body.images).toEqual([PNG]);
      expect(String(sent.body.text)).toContain('My own words instead');
      expect(String(sent.body.text)).not.toContain('The header overlaps');
      expect(String(sent.body.text)).toContain('Checkout page v1 \u00b7 Region');
      await vi.waitFor(() => expect(document.getElementById('toast')!.textContent).toBe('Sent to this artifact\u2019s thread'));
    });

    it('Cancel posts nothing', async () => {
      const win = await open();
      from(win, { ...shot, nonce: arm(win) });
      await vi.waitFor(() => expect(confirmOpen()).toBe(true));
      document.getElementById('cap-confirm-cancel')!.click();
      await new Promise(r => setTimeout(r, 30));
      expect(messagePosts()).toHaveLength(0);
      expect(confirmOpen()).toBe(false);
    });

    it('a page that forges captures with no click posts nothing and shows nothing (the artifact is the source of these messages, and is not trusted)', async () => {
      const win = await open();
      for (let i = 0; i < 5; i++) from(win, { ...shot, nonce: 'anything' });
      from(win, shot);
      from(win, { ...shot, nonce: '' });
      from(win, { rf: 'cap-ready' });
      for (let i = 0; i < 5; i++) from(win, { ...shot, nonce: 'anything' });
      await new Promise(r => setTimeout(r, 40));
      expect(messagePosts()).toHaveLength(0);
      expect(confirmOpen()).toBe(false);
    });

    it('a stale or wrong word is ignored, and a word works once', async () => {
      const win = await open();
      const first = arm(win);
      from(win, { ...shot, nonce: 'not-the-word' });
      expect(confirmOpen()).toBe(false);
      from(win, { ...shot, nonce: first });
      await vi.waitFor(() => expect(confirmOpen()).toBe(true));
      document.getElementById('cap-confirm-cancel')!.click();
      from(win, { ...shot, nonce: first }); // used: not armed any more
      expect(confirmOpen()).toBe(false);
      const second = arm(win, 'page');
      expect(second).not.toBe(first);
      from(win, { ...shot, nonce: first }); // the old word, while a new capture is armed
      expect(confirmOpen()).toBe(false);
      expect(messagePosts()).toHaveLength(0);
    });

    it('closing the capture leaves a short grace for its shot, but the arm ends after two minutes', async () => {
      const win = await open();
      const nonce = arm(win);
      from(win, { rf: 'cap-closed' }); // the picture is fitted after the capture closes: the shot follows
      from(win, { ...shot, nonce });
      await vi.waitFor(() => expect(confirmOpen()).toBe(true));
      document.getElementById('cap-confirm-cancel')!.click();
      const late = arm(win);
      const now = Date.now();
      const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 121_000);
      from(win, { ...shot, nonce: late });
      expect(confirmOpen()).toBe(false);
      spy.mockRestore();
    });

    it('a shot that arrives after the frame has switched to another version is ignored', async () => {
      const win = await open();
      const nonce = arm(win);
      location.hash = `#/artifact/${artId}/v2`;
      await vi.waitFor(() => expect(document.getElementById('artifact-frame')!.getAttribute('src')).toContain('/v2?'));
      from(win, { ...shot, nonce });
      expect(confirmOpen()).toBe(false);
      expect(messagePosts()).toHaveLength(0);
    });

    it('a click on Send as you in the moment the panel opens is ignored, so a page cannot time one onto it', async () => {
      const win = await open();
      from(win, { ...shot, nonce: arm(win) });
      await vi.waitFor(() => expect(confirmOpen()).toBe(true));
      document.getElementById('cap-confirm-send')!.click();
      await new Promise(r => setTimeout(r, 20));
      expect(messagePosts()).toHaveLength(0);
      expect(confirmOpen()).toBe(true);
      pastClickGuard(); document.getElementById('cap-confirm-send')!.click();
      await vi.waitFor(() => expect(messagePosts()).toHaveLength(1));
    });

    it('at most 6 captures a minute can be sent from here', async () => {
      const win = await open();
      for (let i = 0; i < 7; i++) {
        from(win, { ...shot, nonce: arm(win) });
        await vi.waitFor(() => expect(confirmOpen()).toBe(true));
        pastClickGuard(); document.getElementById('cap-confirm-send')!.click();
        await new Promise(r => setTimeout(r, 10));
        if (i === 6) expect(document.getElementById('toast')!.textContent).toContain('Too many captures');
      }
      expect(messagePosts()).toHaveLength(6);
    });

    it('a message from any other window posts nothing, and a bad capture is not shown', async () => {
      const win = await open();
      const nonce = arm(win);
      from({}, { ...shot, nonce });
      from(window, { ...shot, nonce });
      from(win, { ...shot, nonce, mode: 'bogus' });
      from(win, { ...shot, nonce, note: '' });
      expect(confirmOpen()).toBe(false);
      expect(messagePosts()).toHaveLength(0);
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
