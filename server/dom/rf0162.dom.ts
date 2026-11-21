// 0.16.2: the phone footer More menu, and Open on phone hidden on a coarse pointer and on the remote listener.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync('server/inbox/index.html', 'utf8');
const body = html.slice(html.indexOf('<body'), html.indexOf('<script type="module"')).replace(/<body[^>]*>/, '');
const at = (n: number) => `2026-11-20T10:0${n}:00.000Z`;
const threadId = '20261120-100000-abcd';
const $ = (id: string) => document.getElementById(id) as HTMLElement;
let coarse = false;
let devices: { id: string; name: string; created_at: string; last_seen_at: string; expires_at: string; current?: boolean }[] = [];

async function load() {
  vi.resetModules();
  document.body.innerHTML = body;
  document.head.querySelector('#pair-style')?.remove();
  document.querySelector('meta[name="rf-version"]')?.remove();
  document.head.insertAdjacentHTML('beforeend', '<meta name="rf-version" content="0.16.2">');
  location.hash = '#/';
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: coarse && query.includes('coarse'), addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url, 'http://local').pathname.replace(/^.*\/api\//, '');
    const reply = (data: unknown) => ({ ok: true, status: 200, json: async () => data, headers: { get: () => null } });
    if (path === 'threads') return reply([]);
    if (path === 'profile') return reply({ user: { name: 'You' }, agent: { name: 'Agent' } });
    if (path === 'pins') return reply({ threads: [], areas: [] });
    if (path === 'areas') return reply({ areas: [] });
    if (path === 'config') return reply({ secret_target: null, redact: false, version: '0.16.2' });
    if (path === 'projects') return reply({ projects: [] });
    if (path === 'devices') return reply({ remote: true, devices });
    if (path === 'secret-links') return reply({ links: [] });
    if (path === 'pair/status') return reply({ remote: true, public_url: 'https://phone.example.test', source: 'env' });
    return reply({});
  }));
  await import('../inbox/app.js');
  await vi.waitFor(() => expect($('project-name').textContent).toBeTruthy());
  await new Promise(r => setTimeout(r, 30));
}
const labels = () => [...document.querySelectorAll('#popmenu button')].map(button => button.textContent);
const device = (extra: { current?: boolean } = {}) => ({ id: 'd0000000a', name: 'iPhone · Safari', created_at: at(0), last_seen_at: at(2), expires_at: '2026-12-20T10:00:00.000Z', ...extra });

describe('the phone footer More menu', () => {
  beforeEach(() => { coarse = true; devices = []; location.hash = '#/'; });

  it('hides Open on phone on a coarse pointer and puts Secret links, devices and the version in More', async () => {
    await load();
    expect($('phone-link').hidden).toBe(true);
    expect($('phone-link').textContent).toContain('Open on phone');
    expect($('phone-open').hidden).toBe(true);
    $('foot-more').click();
    expect(labels()).toEqual(['Secret links', 'Paired devices']);
    expect(labels().some(label => label?.includes('Open on phone'))).toBe(false);
    expect($('popmenu').querySelector('.ver')?.textContent).toBe('react-feedback v0.16.2');
    ([...document.querySelectorAll('#popmenu button')].find(button => button.textContent === 'Secret links') as HTMLButtonElement).click();
    await vi.waitFor(() => expect($('secret-list').hasAttribute('open')).toBe(true));
    expect($('secret-list').textContent).toContain('No secret links yet.');
    $('secret-list').close();
    $('foot-more').click();
    ([...document.querySelectorAll('#popmenu button')].find(button => button.textContent === 'Paired devices') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('.pair-page')?.textContent).toContain('No device is paired'));
  });
});

describe('Open on phone on a fine pointer', () => {
  beforeEach(() => { coarse = false; devices = []; location.hash = `#/${threadId}`; });

  it('keeps the footer button, and More can still offer it', async () => {
    await load();
    expect($('phone-link').hidden).toBe(false);
    expect($('phone-open').hidden).toBe(false);
    $('foot-more').click();
    expect(labels().some(label => label?.includes('Open on phone'))).toBe(true);
    expect(labels()).toContain('Secret links');
    expect($('popmenu').querySelector('.ver')?.textContent).toBe('react-feedback v0.16.2');
  });

  it('hides Open on phone when this browser is the paired device', async () => {
    devices = [device({ current: true })];
    await load();
    await vi.waitFor(() => expect($('phone-link').hidden).toBe(true));
    expect($('phone-open').hidden).toBe(true);
    $('foot-more').click();
    expect(labels().some(label => label?.includes('Open on phone'))).toBe(false);
    expect(labels()).toContain('Paired devices');
  });
});
