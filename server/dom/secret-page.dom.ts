// The recipient page decrypts from the URL fragment and wipes it. It does not load the inbox.
import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { padSecret } from '../inbox/secret.js';
import { secretPage } from '../secret-page';

const $ = (id: string) => document.getElementById(id) as HTMLElement;

describe('the recipient page', () => {
  it('decrypts from the fragment on Reveal and wipes the fragment', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const text = 'horse battery staple';
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)));
    const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
    const fragment = b64(keyBytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const id = 'F'.repeat(43);
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ ciphertext: b64(cipher), iv: b64(iv) }) };
    }));
    const page = secretPage('n'.repeat(22));
    const code = page.slice(page.indexOf('<script'), page.lastIndexOf('</script>')).replace(/^<script[^>]*>/, '');
    const parsed = new DOMParser().parseFromString(page, 'text/html');
    parsed.querySelectorAll('script').forEach(node => node.remove());
    document.body.innerHTML = parsed.body.innerHTML;
    history.replaceState(null, '', `/__feedback/x/${id}#${fragment}`);
    window.eval(code);
    expect(calls).toEqual([]);
    $('reveal').click();
    await vi.waitFor(() => expect($('secret').hidden).toBe(false));
    expect($('secret').textContent).toBe(text);
    expect(location.hash).toBe('');
    expect(calls).toEqual([`/__feedback/x/${id}/open`]);
    expect(calls.join('')).not.toContain(fragment);
    expect(calls.join('')).not.toContain(text);
  });

  it('keeps the fragment on a rate limit, strips padding, and clears the secret on pagehide', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const text = 'short-secret';
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, padSecret(text)));
    const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
    const fragment = b64(keyBytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const id = 'F'.repeat(43);
    let status = 429;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: status === 200, status, json: async () => (status === 200 ? { ciphertext: b64(cipher), iv: b64(iv) } : {}) })));
    const page = secretPage('n'.repeat(22));
    const code = page.slice(page.indexOf('<script'), page.lastIndexOf('</script>')).replace(/^<script[^>]*>/, '');
    const parsed = new DOMParser().parseFromString(page, 'text/html');
    parsed.querySelectorAll('script').forEach(node => node.remove());
    document.body.innerHTML = parsed.body.innerHTML;
    history.replaceState(null, '', `/__feedback/x/${id}#${fragment}`);
    window.eval(code);
    for (const [name, value] of [['spellcheck', 'false'], ['data-gramm', 'false'], ['data-enable-grammarly', 'false']] as const) expect($('secret').getAttribute(name)).toBe(value);
    ($('reveal') as HTMLButtonElement).click();
    await vi.waitFor(() => expect($('msg').textContent).toBe('Too many tries, wait a minute and press Reveal again'));
    expect(location.hash).toBe(`#${fragment}`);
    expect(($('reveal') as HTMLButtonElement).disabled).toBe(false);
    expect($('reveal').hidden).toBe(false);
    expect($('secret').hidden).toBe(true);
    status = 200;
    ($('reveal') as HTMLButtonElement).click();
    await vi.waitFor(() => expect($('secret').hidden).toBe(false));
    expect($('secret').textContent).toBe(text);
    expect(location.hash).toBe('');
    window.dispatchEvent(new Event('pagehide'));
    expect($('secret').textContent).toBe('');
  });
});
