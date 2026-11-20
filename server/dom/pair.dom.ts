// "Open on phone" and the paired-devices page in the inbox (happy-dom): the box, the QR code, the link with the code in the fragment, the countdown, and revoking.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync('server/inbox/index.html', 'utf8');
const body = html.slice(html.indexOf('<body'), html.indexOf('<script type="module"')).replace(/<body[^>]*>/, '');
const at = (n: number) => `2026-11-20T10:0${n}:00.000Z`;
const threadId = '20261120-100000-abcd';
const $ = (id: string) => document.getElementById(id) as HTMLElement;
let status: Record<string, unknown> = {};
let devices: { id: string; name: string; created_at: string; last_seen_at: string; expires_at: string; current?: boolean }[] = [];
let codeCount = 0;
let unauthorised = false;
const calls: { method: string; path: string }[] = [];
const thread = () => ({ id: threadId, title: 'Plan', origin: 'user', mode: 'thread', status: 'open', created_at: at(0), url: null, last_message_at: at(1), last_author: 'agent',
  unread_for_user: false, user_read_at: at(1), agent_read_at: at(1), open_question: false, waiting: 'idle', last_flag: null, checklist: { total: 0, done: 0, claimed: 0 }, open_for_you: 0,
  merged_into: null, read_only: false, acked_through: null, viewport: null, target: null, note: '', checklist_items: [], files: { image: false, annotated: false, context: false },
  messages: [{ id: 'm1', author: 'user', text: 'Hi', images: [], created_at: at(0) }] });

async function load() {
  vi.resetModules(); calls.length = 0; codeCount = 0; unauthorised = false;
  document.body.innerHTML = body;
  document.head.querySelector('#pair-style')?.remove();
  location.hash = `#/${threadId}`;
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => undefined) }, configurable: true });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://local').pathname.replace(/^.*\/api\//, '');
    const method = init?.method ?? 'GET';
    calls.push({ method, path });
    const reply = (data: unknown, code = 200) => ({ ok: code < 400, status: code, json: async () => data, headers: { get: () => null } });
    if (unauthorised) return reply({ kind: 'unpaired' }, 401);
    if (path === 'pair/status') return reply(status);
    if (path === 'pair/codes' && method === 'POST') { codeCount += 1; return reply({ id: `0000000${codeCount}`, code: `CODE${String(codeCount).padStart(18, 'x')}`, expires_at: new Date(Date.now() + 300000).toISOString(), ttl_seconds: 300 }, 201); }
    if (path.startsWith('pair/codes/') && method === 'DELETE') return reply({ revoked: true });
    if (path === 'devices/revoke-all' && method === 'POST') { const n = devices.length; devices = []; return reply({ revoked: n }); }
    if (path.startsWith('devices/') && method === 'DELETE') { devices = devices.filter(d => d.id !== path.slice(8)); return reply({ revoked: true }); }
    if (path === 'devices') return reply({ remote: true, devices });
    if (path === 'threads') return reply([thread()]);
    if (path.startsWith('threads/')) return reply(thread());
    if (path === 'projects') return reply({ projects: [] });
    if (path === 'profile') return reply({ user: { name: 'You' }, agent: { name: 'Agent' } });
    if (path === 'pins') return reply({ threads: [], areas: [] });
    if (path === 'areas') return reply({ areas: [] });
    return reply({});
  }));
  await import('../inbox/app.js');
  await vi.waitFor(() => expect(document.querySelector('.msg') || $('project-name').textContent).toBeTruthy());
  await new Promise(r => setTimeout(r, 20));
}
const device = (id: string, name: string, extra = {}) => ({ id, name, created_at: at(0), last_seen_at: at(2), expires_at: '2026-12-20T10:00:00.000Z', ...extra });

describe('Open on phone', () => {
  beforeEach(() => { status = { remote: true, public_url: 'https://phone.example.test', source: 'env', ttl_seconds: 300 }; devices = []; });
  it('is in the sidebar footer and in the thread header', async () => {
    await load();
    expect(document.querySelector('.foot-links #phone-link')?.textContent).toContain('Open on phone');
    expect($('phone-open').classList.contains('desk')).toBe(true);
    expect($('phone-open').nextElementSibling).toBe($('more'));
  });
  it('shows a QR code and a link with the code in the fragment and the thread to open', async () => {
    await load();
    $('phone-open').click();
    await vi.waitFor(() => expect(document.querySelector('dialog.pair svg path')).toBeTruthy());
    const link = (document.querySelector('dialog.pair input') as HTMLInputElement).value;
    expect(link).toMatch(/^https:\/\/phone\.example\.test\/.*#\/pair\/CODE[x0-9]{18}\?to=20261120-100000-abcd$/);
    expect(link.split('#')[0]).not.toContain('CODE'); // the code is only in the fragment
    expect(link.indexOf('?')).toBeGreaterThan(link.indexOf('#'));
    const svg = document.querySelector('dialog.pair svg') as SVGElement;
    expect(svg.getAttribute('aria-label')).toContain('QR code');
    expect(svg.querySelector('path')?.getAttribute('d')?.length).toBeGreaterThan(200);
    expect(document.querySelector('dialog.pair .count')?.textContent).toMatch(/^[45]:\d\d$/);
    expect(calls.filter(c => c.path === 'pair/codes' && c.method === 'POST').length).toBe(1);
  });
  it('copies the link, and withdraws the unused code when closed', async () => {
    await load();
    $('phone-link').click();
    await vi.waitFor(() => expect(document.querySelector('dialog.pair svg')).toBeTruthy());
    const link = (document.querySelector('dialog.pair input') as HTMLInputElement).value;
    [...document.querySelectorAll('dialog.pair button')].find(b => b.textContent === 'Copy')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect((navigator.clipboard.writeText as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(link));
    [...document.querySelectorAll('dialog.pair button')].find(b => b.textContent === 'Close')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('dialog.pair')).toBeNull();
    expect(calls.some(c => c.method === 'DELETE' && c.path === 'pair/codes/00000001')).toBe(true);
  });
  it('has no thread in the link from the sidebar when no thread is open, and counts down to a new code', async () => {
    location.hash = '#/';
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      await load();
      location.hash = '#/';
      await new Promise(r => setTimeout(r, 40));
      $('phone-link').click();
      await vi.waitFor(() => expect(document.querySelector('dialog.pair svg')).toBeTruthy());
      expect((document.querySelector('dialog.pair input') as HTMLInputElement).value).not.toContain('?to=');
      vi.setSystemTime(Date.now() + 301000);
      await vi.advanceTimersByTimeAsync(1100);
      expect(document.querySelector('dialog.pair')?.textContent).toContain('expired');
      expect(document.querySelector('dialog.pair svg')).toBeNull();
      [...document.querySelectorAll('dialog.pair button')].find(b => b.textContent === 'New code')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await vi.waitFor(() => expect(document.querySelector('dialog.pair svg')).toBeTruthy());
      expect(codeCount).toBe(2);
    } finally { vi.useRealTimers(); }
  });
  it('says what to do when remote mode is off, and when no public address is set', async () => {
    status = { remote: false, public_url: null, source: null };
    await load();
    $('phone-link').click();
    await vi.waitFor(() => expect(document.querySelector('dialog.pair')?.textContent).toContain('Remote mode is off'));
    expect(document.querySelector('dialog.pair')?.textContent).toContain('serve --remote');
    expect(document.querySelector('dialog.pair svg')).toBeNull();
    expect(calls.some(c => c.path === 'pair/codes')).toBe(false);
    status = { remote: true, public_url: null, source: null };
    await load();
    $('phone-link').click();
    await vi.waitFor(() => expect(document.querySelector('dialog.pair svg')).toBeTruthy());
    expect(document.querySelector('dialog.pair')?.textContent).toContain('No public address is set');
  });
  it('says when the phone has paired', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await load();
      $('phone-open').click();
      await vi.waitFor(() => expect(document.querySelector('dialog.pair svg')).toBeTruthy());
      await vi.advanceTimersByTimeAsync(100);
      devices = [device('d0000000a', 'iPhone · Safari')];
      await vi.advanceTimersByTimeAsync(3100);
      await vi.waitFor(() => expect(document.querySelector('dialog.pair .done')?.textContent).toContain('Paired: iPhone · Safari'));
      expect(document.querySelector('dialog.pair svg')).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});

describe('Paired devices', () => {
  beforeEach(() => { status = { remote: true, public_url: 'https://phone.example.test', source: 'env', ttl_seconds: 300 }; devices = [device('d0000000a', 'iPhone · Safari', { current: true }), device('d0000000b', 'Android · Chrome')]; });
  async function openPage() {
    await load();
    $('phone-link').click();
    await vi.waitFor(() => expect(document.querySelector('dialog.pair svg')).toBeTruthy());
    [...document.querySelectorAll('dialog.pair button')].find(b => b.textContent === 'Paired devices')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector('.pair-page li')).toBeTruthy());
  }
  it('lists name, paired and last seen, and marks this device', async () => {
    await openPage();
    const rows = [...document.querySelectorAll('.pair-page li')];
    expect(rows.length).toBe(2);
    expect(rows[0]!.textContent).toContain('iPhone · Safari');
    expect(rows[0]!.textContent).toContain('This device');
    expect(rows[0]!.textContent).toMatch(/Paired .*Last seen/);
    expect(rows[1]!.textContent).not.toContain('This device');
    expect(document.querySelector('.pair-page [role="status"]')?.textContent).toContain('2 paired devices');
    expect(JSON.stringify(rows.map(r => r.outerHTML))).not.toContain('token');
  });
  it('revokes one device at once', async () => {
    await openPage();
    (document.querySelector('.pair-page li[data-device="d0000000b"] button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelectorAll('.pair-page li').length).toBe(1));
    expect(calls.some(c => c.method === 'DELETE' && c.path === 'devices/d0000000b')).toBe(true);
  });
  it('revokes all with a second press, and closes with Escape', async () => {
    await openPage();
    const all = [...document.querySelectorAll('.pair-page header button')].find(b => b.textContent?.startsWith('Revoke all')) as HTMLButtonElement;
    all.click();
    expect(all.textContent).toBe('Really revoke all?');
    expect(devices.length).toBe(2);
    all.click();
    await vi.waitFor(() => expect(document.querySelectorAll('.pair-page li').length).toBe(0));
    expect(document.querySelector('.pair-page')?.textContent).toContain('No device is paired');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.pair-page')).toBeNull();
  });
});

describe('a phone that was revoked', () => {
  it('is told so, once', async () => {
    status = { remote: true };
    await load();
    unauthorised = true;
    document.dispatchEvent(new Event('visibilitychange'));
    $('new-thread').click();
    // (earlier tests' pages are still alive in this file, each with its own copy of the module: count what this trigger adds)
    await vi.waitFor(() => expect(document.querySelectorAll('.pair-banner').length).toBeGreaterThan(0));
    expect(document.querySelector('.pair-banner')?.textContent).toContain('no longer paired');
    const first = document.querySelectorAll('.pair-banner').length;
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise(r => setTimeout(r, 30));
    expect(document.querySelectorAll('.pair-banner').length).toBe(first);
  });
});
