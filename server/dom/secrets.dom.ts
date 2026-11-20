// The secret dialog encrypts before it POSTs, and the recipient page decrypts from the fragment and wipes it.
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { unpadSecret } from '../inbox/secret.js';

const html = readFileSync('server/inbox/index.html', 'utf8');
const body = html.slice(html.indexOf('<body'), html.indexOf('<script type="module"')).replace(/<body[^>]*>/, '');
const PLAIN = 'plaintext-SECRETLINK-9f3c1a';
const threadId = '20261120-100000-abcd';
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const posts: { path: string; body: string }[] = [];
let secretCreateUrl = `/__feedback/x/${'A'.repeat(43)}`;

async function load() {
  vi.resetModules(); posts.length = 0;
  secretCreateUrl = `/__feedback/x/${'A'.repeat(43)}`;
  document.body.innerHTML = body;
  location.hash = `#/${threadId}`;
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('crypto', webcrypto);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => undefined) }, configurable: true });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://local').pathname.replace(/^.*\/api\//, '');
    const method = init?.method ?? 'GET';
    const raw = typeof init?.body === 'string' ? init.body : '';
    if (method === 'POST') posts.push({ path, body: raw });
    const reply = (data: unknown, code = 200) => ({ ok: code < 400, status: code, json: async () => data, headers: { get: () => null } });
    if (path === 'secret-links' && method === 'POST') return reply({ id: 'A'.repeat(43), url: secretCreateUrl, expires_at: '2026-11-20T13:00:00.000Z', views_left: 1, created_at: '2026-11-20T12:00:00.000Z' }, 201);
    if (path === 'secret-links') return reply({ links: [{ id: 'A'.repeat(43), created_at: '2026-11-20T12:00:00.000Z', expires_at: '2026-11-20T13:00:00.000Z', views_left: 1 }] });
    if (path === 'pair/status') return reply({ remote: true, public_url: 'https://share.example.test', source: 'env' });
    if (path === 'threads') return reply([{ id: threadId, title: 'Plan', origin: 'user', mode: 'thread', status: 'open', created_at: '2026-11-20T10:00:00.000Z', url: null, last_message_at: '2026-11-20T10:01:00.000Z', last_author: 'agent', unread_for_user: false, user_read_at: null, agent_read_at: null, open_question: false, waiting: 'idle', last_flag: null, checklist: { total: 0, done: 0, claimed: 0 }, open_for_you: 0, merged_into: null, read_only: false, acked_through: null, viewport: null, target: null, note: '', checklist_items: [], files: { image: false, annotated: false, context: false }, messages: [{ id: 'm1', author: 'user', text: 'Hi', images: [], created_at: '2026-11-20T10:00:00.000Z' }] }]);
    if (path.startsWith('threads/')) return reply({ id: threadId, title: 'Plan', origin: 'user', mode: 'thread', status: 'open', created_at: '2026-11-20T10:00:00.000Z', messages: [{ id: 'm1', author: 'user', text: 'Hi', images: [], created_at: '2026-11-20T10:00:00.000Z' }], checklist_items: [], read_only: false, merged_into: null, files: {} });
    if (path === 'projects') return reply({ projects: [{ id: 'default', name: 'Feedback', unread: 0 }] });
    if (path === 'profile') return reply({ user: { name: 'You' }, agent: { name: 'Agent' } });
    if (path === 'pins') return reply({ threads: [], areas: [] });
    if (path === 'areas') return reply({ areas: [] });
    if (path === 'config') return reply({ version: '0.16.0' });
    return reply({});
  }));
  await import('../inbox/app.js');
  await vi.waitFor(() => expect(document.querySelector('.msg')).toBeTruthy());
}

describe('Share a secret', () => {
  beforeEach(load);
  it('is in the thread menu and the composer menu', async () => {
    $('more').click();
    expect([...document.querySelectorAll('#popmenu button')].map(button => button.textContent)).toEqual(expect.arrayContaining(['Share a secret', 'Secret links']));
    document.body.click();
    $('plus').click();
    expect([...document.querySelectorAll('#popmenu button')].map(button => button.textContent)).toContain('Share a secret');
  });
  it('encrypts before POST, so the request body has no plaintext', async () => {
    $('more').click();
    ([...document.querySelectorAll('#popmenu button')].find(button => button.textContent === 'Share a secret') as HTMLButtonElement).click();
    expect(($('secret-dialog') as HTMLDialogElement).open || $('secret-dialog').hasAttribute('open')).toBe(true);
    ($('secret-text') as HTMLTextAreaElement).value = PLAIN;
    $('secret-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(posts.some(post => post.path === 'secret-links')).toBe(true));
    const sent = posts.find(post => post.path === 'secret-links')!;
    expect(sent.body).not.toContain(PLAIN);
    const parsed = JSON.parse(sent.body) as { ciphertext: string; iv: string; expires: string; views: number };
    expect(parsed.expires).toBe('1h');
    expect(parsed.views).toBe(1);
    expect(parsed.ciphertext.length).toBeGreaterThan(16);
    expect(parsed.iv).toMatch(/^[A-Za-z0-9+/]{16}={0,2}$/);
    const link = ($('secret-url') as HTMLInputElement).value;
    expect(link.startsWith('https://share.example.test/__feedback/x/')).toBe(true);
    expect(link.includes('#')).toBe(true);
    expect(link).not.toContain(PLAIN);
    expect($('secret-note').textContent).toBe('Anyone with this link can read it once. Send it in a different channel from anything that says what it\'s for.');
    expect($('secret-dialog').textContent).toContain('may be read by agents');
    expect(($('secret-text') as HTMLTextAreaElement).value).toBe('');
    const key = link.slice(link.indexOf('#') + 1);
    const cipherBytes = Uint8Array.from(atob(parsed.ciphertext), c => c.charCodeAt(0));
    expect(cipherBytes.length % 64).toBe(16);
    expect(cipherBytes.length).toBeGreaterThan(PLAIN.length + 16);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Uint8Array.from(atob(parsed.iv), c => c.charCodeAt(0)) },
      await crypto.subtle.importKey('raw', Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='), c => c.charCodeAt(0)), { name: 'AES-GCM' }, false, ['decrypt']),
      cipherBytes,
    );
    expect(new TextDecoder().decode(unpadSecret(new Uint8Array(plain)))).toBe(PLAIN);
  });
  it('keeps the secret out of spellcheck and password managers', () => {
    const text = $('secret-text');
    for (const [name, value] of [
      ['spellcheck', 'false'], ['autocomplete', 'off'], ['autocapitalize', 'off'], ['autocorrect', 'off'],
      ['data-gramm', 'false'], ['data-enable-grammarly', 'false'], ['data-lpignore', 'true'], ['data-1p-ignore', 'true'], ['data-bwignore', 'true'],
    ] as const) expect(text.getAttribute(name)).toBe(value);
    expect($('secret-url').getAttribute('spellcheck')).toBe('false');
  });
  it('does not build a link unless the server returns a secret path', async () => {
    secretCreateUrl = `https://evil.example/__feedback/x/${'A'.repeat(43)}`;
    $('more').click();
    ([...document.querySelectorAll('#popmenu button')].find(button => button.textContent === 'Share a secret') as HTMLButtonElement).click();
    ($('secret-text') as HTMLTextAreaElement).value = PLAIN;
    $('secret-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect($('secret-error').textContent).toContain('usable link'));
    expect(($('secret-url') as HTMLInputElement).hidden).toBe(true);
    expect(($('secret-url') as HTMLInputElement).value).toBe('');
    expect($('secret-error').textContent).not.toContain('evil.example');
    expect(($('secret-text') as HTMLTextAreaElement).value).toBe('');
    expect(posts.some(post => post.path === 'secret-links' && !post.body.includes(PLAIN))).toBe(true);
  });
});
