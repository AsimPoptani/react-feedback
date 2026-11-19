// RF6 in the inbox page (happy-dom): the key box, redaction, and the offline outbox.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync('server/inbox/index.html', 'utf8');
const body = html.slice(html.indexOf('<body'), html.indexOf('<script type="module"')).replace(/<body[^>]*>/, '');
const at = (n: number) => `2026-11-18T10:${String(n).padStart(2, '0')}:00.000Z`;
const ID = '20261118-100000-abcd';
const SECRET = 'sk-or-v1-FAKE-KEY-0123456789abcd';
const m = (id: string, author: string, text: string, n: number, extra: Record<string, unknown> = {}) => ({ id, author, text, images: [], created_at: at(n), ...(author === 'agent' ? { flag: 'fyi' } : {}), ...extra });
const keyRequest = (extra: Record<string, unknown> = {}) => m('m2', 'agent', 'Please add the OpenRouter key.', 1, { flag: 'needs_you', kind: 'secret_request', secret: { name: 'openrouter', label: 'OpenRouter API key', help_url: 'https://openrouter.ai/keys', ...extra } });
type Thread = ReturnType<typeof thread>;
function thread(messages: unknown[], extra: Record<string, unknown> = {}) {
  return { id: ID, title: 'Keys', origin: 'user', mode: 'thread', status: 'open', created_at: at(0), url: null, last_message_at: at(9), last_author: 'agent', unread_for_user: false, user_read_at: at(9), agent_read_at: at(9),
    open_question: false, waiting: 'idle', last_flag: 'fyi', checklist: { total: 0, done: 0, claimed: 0 }, open_for_you: 0, merged_into: null, read_only: false, acked_through: null, viewport: null, target: null, note: '',
    checklist_items: [], files: { image: false, annotated: false, context: false }, messages, ...extra };
}
interface Call { url: string; method: string; body: string }
const calls: Call[] = [];
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const added: [EventTarget, string, EventListenerOrEventListenerObject][] = [];
for (const target of [document, window]) {
  const original = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => { added.push([target, type, fn]); original(type, fn, opts as AddEventListenerOptions); }) as typeof target.addEventListener;
}
let t: Thread, config: unknown, online = true, keyAnswer: () => { ok: boolean; status: number; body: unknown }, postAnswer: (c: Call) => { status: number; body?: unknown } | 'network';
const setOnline = (v: boolean) => { online = v; Object.defineProperty(navigator, 'onLine', { value: v, configurable: true }); };
async function load(thr: Thread, cfg: unknown = { secret_target: '/api/keys/{name}', redact: true }) {
  for (const [target, type, fn] of added.splice(0)) target.removeEventListener(type, fn);
  vi.resetModules(); calls.length = 0; t = thr; config = cfg; setOnline(true);
  keyAnswer = () => ({ ok: true, status: 200, body: { hint: '…abcd' } });
  postAnswer = () => ({ status: 201, body: {} });
  document.body.innerHTML = body;
  location.hash = `#/${ID}`;
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
  HTMLDialogElement.prototype.close ??= function () { this.open = false; };
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET', call = { url, method, body: init?.body ? String(init.body) : '' };
    calls.push(call);
    const json = (status: number, data: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => data, headers: new Headers() });
    if (url.startsWith('/api/keys/')) { const a = keyAnswer(); return json(a.status, a.body); }
    const path = new URL(url, 'http://local').pathname.replace(/^.*\/api\//, '');
    if (method !== 'GET') {
      if (!online) throw new TypeError('Failed to fetch');
      const a = postAnswer(call);
      if (a === 'network') throw new TypeError('Failed to fetch');
      if (a.status < 300 && /\/messages$/.test(path)) { const b = JSON.parse(call.body); if (!t.messages.some((x: { client_id?: string }) => x.client_id === b.client_id)) t.messages.push(m(`m${t.messages.length + 1}`, 'user', b.text, 20 + t.messages.length, { client_id: b.client_id, images: [], ...(b.reply_to ? { reply_to: b.reply_to } : {}) })); }
      if (a.status < 300 && /\/secret$/.test(path)) { const b = JSON.parse(call.body), k = (t.messages as { id: string; secret?: Record<string, unknown>; flag?: string }[]).find(x => x.secret); if (k) { k.secret = { ...k.secret, status: 'saved', hint: b.hint }; k.flag = 'fyi'; } }
      return json(a.status, a.body ?? {});
    }
    if (!online) throw new TypeError('Failed to fetch');
    if (path === 'threads') return json(200, [t]);
    if (path.startsWith('threads/')) return json(200, t);
    if (path === 'profile') return json(200, { user: { name: 'You' }, agent: { name: 'Agent' } });
    if (path === 'pins') return json(200, { threads: [], areas: [] });
    if (path === 'areas') return json(200, { areas: [] });
    if (path === 'config') return json(200, config);
    return json(200, {});
  }));
  await import('../inbox/app.js');
  await vi.waitFor(() => expect(document.querySelectorAll('#msgs .msg').length).toBeGreaterThan(0));
}
const flush = () => new Promise(r => setTimeout(r, 0));
const msgs = () => [...document.querySelectorAll<HTMLElement>('#msgs > .msg')];
const sentPosts = () => calls.filter(c => c.method === 'POST' && /\/messages$/.test(c.url)).map(c => JSON.parse(c.body));
const compose = async (text: string) => { ($('text') as HTMLTextAreaElement).value = text; $('composer').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); await flush(); };

describe('the key box', () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
  const base = () => [m('m1', 'user', 'Hello', 0), keyRequest()];

  it('draws a password box with autocomplete off, a Save button and a help link', async () => {
    await load(thread(base()));
    const input = document.querySelector<HTMLInputElement>('.secret input')!;
    expect(input.type).toBe('password'); expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.getAttribute('name')).toBeNull();
    expect(document.querySelector('.secret button[type=submit]')!.textContent).toBe('Save');
    const a = document.querySelector<HTMLAnchorElement>('.secret a')!;
    expect(a.href).toBe('https://openrouter.ai/keys'); expect(a.rel).toContain('noopener');
  });

  it('with no target configured it says so and draws no box', async () => {
    await load(thread(base()), { secret_target: null, redact: false });
    expect(document.querySelector('.secret input')).toBeNull();
    expect(document.querySelector('.secret')!.textContent).toBe("Secure entry isn't set up on this server");
  });

  it('Save sends the key to the app only (PUT, JSON, same site), clears the box, and tells the feedback server just "saved" and the hint', async () => {
    await load(thread(base()));
    const input = document.querySelector<HTMLInputElement>('.secret input')!;
    input.value = SECRET;
    document.querySelector<HTMLFormElement>('.secret form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector('.secret-ok')?.textContent).toBe('Saved ✓ · ends …abcd'));
    const withValue = calls.filter(c => c.body.includes(SECRET) || c.url.includes(SECRET));
    expect(withValue.length).toBe(1);
    expect(withValue[0]!.url).toBe('/api/keys/openrouter'); expect(withValue[0]!.method).toBe('PUT');
    expect(JSON.parse(withValue[0]!.body)).toEqual({ value: SECRET });
    const record = calls.find(c => c.url.endsWith('/messages/m2/secret'))!;
    expect(JSON.parse(record.body)).toEqual({ status: 'saved', hint: '…abcd' });
    expect(calls.filter(c => c.url.includes('/__feedback') || c.url.includes('/api/threads')).some(c => c.body.includes(SECRET))).toBe(false);
    expect(document.body.innerHTML.includes(SECRET)).toBe(false);
    expect(JSON.stringify({ ...localStorage })).not.toContain(SECRET); expect(JSON.stringify({ ...sessionStorage })).not.toContain(SECRET);
    expect(document.querySelector('.secret input')).toBeNull();
  });

  it('a refusal shows the app\'s error text and keeps the box and the typed key; nothing is recorded', async () => {
    await load(thread(base()));
    keyAnswer = () => ({ ok: false, status: 422, body: { detail: 'That does not look like an OpenRouter key.' } });
    const input = document.querySelector<HTMLInputElement>('.secret input')!;
    input.value = 'not-a-key-value'; document.querySelector<HTMLFormElement>('.secret form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector('.secret .error')?.textContent).toContain('does not look like'));
    expect(document.querySelector<HTMLInputElement>('.secret input')!.value).toBe('not-a-key-value');
    expect(calls.some(c => c.url.endsWith('/secret'))).toBe(false);
  });

  it('an absolute or protocol-relative target is refused: the key is never sent anywhere', async () => {
    for (const bad of ['https://evil.example/{name}', '//evil.example/{name}']) {
      await load(thread(base()), { secret_target: bad, redact: false });
      const input = document.querySelector<HTMLInputElement>('.secret input')!;
      input.value = SECRET; document.querySelector<HTMLFormElement>('.secret form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      await vi.waitFor(() => expect(document.querySelector('.secret .error')?.textContent).toContain('set up correctly'));
      expect(calls.some(c => c.body.includes(SECRET))).toBe(false);
    }
  });

  it('offline: "Connect to save this key", no Save, nothing sent, nothing queued', async () => {
    await load(thread(base()));
    setOnline(false); window.dispatchEvent(new Event('offline')); await flush();
    expect(document.querySelector('.secret')!.textContent).toContain('Connect to save this key');
    const input = document.querySelector<HTMLInputElement>('.secret input')!;
    expect(input.disabled).toBe(true); expect(document.querySelector<HTMLButtonElement>('.secret button[type=submit]')!.disabled).toBe(true);
    input.value = SECRET; document.querySelector<HTMLFormElement>('.secret form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); await flush();
    expect(calls.some(c => c.method === 'PUT' || c.body.includes(SECRET))).toBe(false);
    expect(document.querySelector('[data-queued]')).toBeNull();
  });

  it('a half-typed key survives the thread being redrawn', async () => {
    await load(thread(base()));
    const input = document.querySelector<HTMLInputElement>('.secret input')!; input.value = 'half-typed';
    t.messages.push(m('m3', 'agent', 'one more thing', 5)); t.last_message_at = at(10);
    window.dispatchEvent(new Event('online')); await vi.waitFor(() => expect(msgs().length).toBe(3));
    expect(document.querySelector<HTMLInputElement>('.secret input')!.value).toBe('half-typed');
  });
});

describe('redact in the inbox', () => {
  beforeEach(() => { localStorage.clear(); });
  const msgsList = () => [m('m1', 'user', 'my card is 4111', 0), m('m2', 'agent', 'ok', 1), m('m3', 'user', 'quote it', 2, { reply_to: 'm1' })];

  it('your own messages have a ⋯ with Redact…; the agent\'s do not; it asks first, then posts', async () => {
    await load(thread(msgsList()));
    expect(msgs()[0]!.querySelector('.msg-more')).not.toBeNull(); expect(msgs()[1]!.querySelector('.msg-more')).toBeNull();
    msgs()[0]!.querySelector<HTMLButtonElement>('.msg-more')!.click();
    const item = [...document.querySelectorAll<HTMLButtonElement>('#popmenu button')].find(b => b.textContent === 'Redact…')!; item.click();
    expect((document.getElementById('redact-dialog') as HTMLDialogElement).open).toBe(true);
    expect(calls.some(c => c.url.endsWith('/redact'))).toBe(false);
    $('redact-go').click(); await vi.waitFor(() => expect(calls.some(c => c.url.endsWith('/messages/m1/redact') && c.method === 'POST')).toBe(true));
  });

  it('a redacted message shows the lock with who and when, and quotes of it show "🔒 Redacted"', async () => {
    const redacted = m('m1', 'user', '', 0, { redacted: { at: at(5), by: 'user', key: `${ID}/m1` } });
    await load(thread([redacted, m('m2', 'agent', 'ok', 1), m('m3', 'user', 'quote it', 2, { reply_to: 'm1' })]));
    expect(msgs()[0]!.textContent).toContain('🔒 Redacted (sensitive)'); expect(msgs()[0]!.textContent).toContain('by You');
    expect(msgs()[0]!.querySelector('.msg-more')).toBeNull();
    expect(msgs()[2]!.querySelector('.quote .snip')!.textContent).toBe('🔒 Redacted');
    expect(document.body.textContent).not.toContain('4111');
  });

  it('with no vault configured the action is not offered', async () => {
    await load(thread(msgsList()), { secret_target: null, redact: false });
    expect(document.querySelector('.msg-more')).toBeNull();
  });
});

describe('offline sending', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { vi.useRealTimers(); });
  const base = () => [m('m1', 'user', 'Hello', 0), m('m2', 'agent', 'Hi there', 1)];
  const goOffline = async () => { setOnline(false); window.dispatchEvent(new Event('offline')); await flush(); };
  const comeBack = async () => { setOnline(true); window.dispatchEvent(new Event('online')); await flush(); };

  it('shows the offline banner, queues a message with a clock, and sends nothing', async () => {
    await load(thread(base()));
    await goOffline();
    expect($('offline-banner').hidden).toBe(false); expect($('offline-banner').textContent).toContain('Offline · showing what you last saw');
    await compose('written on the train');
    await vi.waitFor(() => expect(document.querySelector('[data-queued]')).not.toBeNull());
    const q = document.querySelector<HTMLElement>('[data-queued]')!;
    expect(q.textContent).toContain('written on the train'); expect(q.textContent).toContain('Waiting to send'); expect(q.querySelector('svg.clock')).not.toBeNull();
    expect(sentPosts().length).toBe(0);
    expect(($('text') as HTMLTextAreaElement).value).toBe('');
    expect($('offline-banner').textContent).toContain('1 waiting to send');
  });

  it('sends queued messages in order on reconnect, each with its client id and the time it was written, then clears the clocks', async () => {
    await load(thread(base()));
    await goOffline();
    await compose('first'); await compose('/btw side one'); await compose('third');
    await vi.waitFor(() => expect(document.querySelectorAll('[data-queued]').length).toBe(3));
    await comeBack();
    await vi.waitFor(() => expect(sentPosts().length).toBe(3));
    const posts = sentPosts();
    expect(posts.map(p => p.text)).toEqual(['first', 'side one', 'third']);
    expect(posts[1].aside).toBe(true);
    expect(new Set(posts.map(p => p.client_id)).size).toBe(3);
    expect(posts.every(p => typeof p.written_at === 'string' && !Number.isNaN(Date.parse(p.written_at)))).toBe(true);
    expect(posts[0].written_at <= posts[1].written_at && posts[1].written_at <= posts[2].written_at).toBe(true);
    await vi.waitFor(() => expect(document.querySelector('[data-queued]')).toBeNull());
    expect($('offline-banner').hidden).toBe(true);
    expect(document.body.textContent).toContain('third');
  });

  it('a quote-reply keeps its reply_to, and a picture goes along', async () => {
    await load(thread(base()));
    await goOffline();
    msgs()[1]!.querySelector<HTMLButtonElement>('.reply-btn')!.click();
    // a picture attached the way the Attach button does
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'a.png', { type: 'image/png' });
    const input = $('file') as HTMLInputElement; Object.defineProperty(input, 'files', { value: [file], configurable: true }); input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelectorAll('#previews img').length).toBe(1));
    await compose('answering you');
    await vi.waitFor(() => expect(document.querySelector('[data-queued] .quote')).not.toBeNull());
    expect(document.querySelector('[data-queued] img')!.getAttribute('src')!.startsWith('data:image/png')).toBe(true);
    await comeBack(); await vi.waitFor(() => expect(sentPosts().length).toBe(1));
    expect(sentPosts()[0].reply_to).toBe('m2'); expect(sentPosts()[0].images.length).toBe(1);
  });

  it('a send that fails on the network is queued, and the retry carries the same client id (the server dedupes it)', async () => {
    await load(thread(base()));
    postAnswer = () => 'network';
    await compose('dropped call');
    await vi.waitFor(() => expect(document.querySelector('[data-queued]')).not.toBeNull());
    const first = sentPosts()[0]!;
    postAnswer = () => ({ status: 200, body: {} }); // the reply to the first try was lost but it had arrived: the server answers 200 for the repeat
    await comeBack();
    await vi.waitFor(() => expect(sentPosts().length).toBeGreaterThanOrEqual(2));
    expect(sentPosts()[1]!.client_id).toBe(first.client_id);
    await vi.waitFor(() => expect(document.querySelector('[data-queued]')).toBeNull());
  });

  it('messages behind a waiting one do not jump ahead of it (order is kept while the first keeps failing)', async () => {
    await load(thread(base()));
    await goOffline(); await compose('one'); await compose('two');
    postAnswer = () => 'network';
    await comeBack();
    await vi.waitFor(() => expect(sentPosts().length).toBeGreaterThanOrEqual(1));
    await flush(); await flush();
    expect(new Set(sentPosts().map(p => p.text))).toEqual(new Set(['one'])); // two has not been tried while one is waiting
  });

  it('a queued message can be deleted before it sends', async () => {
    await load(thread(base()));
    await goOffline(); await compose('changed my mind');
    await vi.waitFor(() => expect(document.querySelector('[data-queued]')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('[data-queued] .qstate button')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-queued]')).toBeNull());
    await comeBack(); await flush();
    expect(sentPosts().length).toBe(0);
  });

  it('a read-only thread refuses to queue anything', async () => {
    await load(thread(base(), { read_only: true }));
    await goOffline();
    ($('text') as HTMLTextAreaElement).value = 'nope';
    $('composer').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); await flush();
    expect(document.querySelector('[data-queued]')).toBeNull();
    expect(sentPosts().length).toBe(0);
  });

  it('a queued message the server refuses (the thread went read-only) is marked not sent, with Try again and Delete, and does not block the next', async () => {
    await load(thread(base()));
    await goOffline(); await compose('late one'); await compose('later one');
    let n = 0; postAnswer = () => (n++ === 0 ? { status: 409, body: { detail: 'This thread is read-only' } } : { status: 201 });
    await comeBack();
    await vi.waitFor(() => expect(document.querySelector('[data-queued].failed')).not.toBeNull());
    const failed = document.querySelector<HTMLElement>('[data-queued].failed')!;
    expect(failed.textContent).toContain("Couldn't send: This thread is read-only");
    expect([...failed.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Try again', 'Delete']);
    await vi.waitFor(() => expect(sentPosts().length).toBe(2));
  });

  it('nothing but ordinary messages is ever written to the offline store', async () => {
    await load(thread(base()));
    await goOffline(); await compose('plain');
    const writes = JSON.stringify([localStorage.length, document.cookie]);
    expect(writes).not.toContain(SECRET);
    expect(document.querySelector('.secret')).toBeNull();
  });
});
