// A withdrawn or re-asked question collapses, and an answer that was being typed is kept (happy-dom).
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync('server/inbox/index.html', 'utf8');
const body = html.slice(html.indexOf('<body'), html.indexOf('<script type="module"')).replace(/<body[^>]*>/, '');
const at = (n: number) => `2026-11-18T10:0${n}:00.000Z`;
const prompt = 'Which pictures?';
const question = { id: 'q2', prompt, multi: false, allow_other: true, options: [{ id: 'o1', label: 'Reuse' }, { id: 'o2', label: 'Draw new' }] };
const threadId = '20261118-100000-abcd';
let messages: Record<string, unknown>[] = [];
let projects: { id: string; name: string; unread: number }[] = [{ id: 'alpha', name: 'Alpha', unread: 0 }];
const posts: { path: string; body: Record<string, unknown>; status: number }[] = [];
const thread = () => ({ id: threadId, title: 'Pictures', origin: 'user', mode: 'thread', status: 'open', created_at: at(0), url: null, last_message_at: at(1), last_author: 'agent',
  unread_for_user: false, user_read_at: at(1), agent_read_at: at(1), open_question: true, waiting: 'user', last_flag: 'needs_you', checklist: { total: 0, done: 0, claimed: 0 }, open_for_you: 0,
  merged_into: null, read_only: false, acked_through: null, viewport: null, target: null, note: '', checklist_items: [], files: { image: false, annotated: false, context: false }, messages });
let threadLoads = 0;

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
      const payload = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      posts.push({ path, body: payload, status: path.endsWith('/answer') && payload.question_id === 'q2' && messages.some(m => (m.question as { withdrawn?: unknown } | undefined)?.withdrawn) ? 409 : 200 });
      if (path.endsWith('/answer') && payload.question_id === 'q2' && messages.some(m => (m.question as { id?: string; withdrawn?: unknown } | undefined)?.id === 'q2' && (m.question as { withdrawn?: unknown }).withdrawn)) {
        return reply({ detail: 'That question was withdrawn' }, 409);
      }
      if (path.endsWith('/answer')) {
        messages.push({ id: `m${messages.length + 1}`, author: 'user', text: `Chose: Other: ${payload.other_text ?? ''}`, images: [], created_at: at(messages.length + 1), answer: { question_id: payload.question_id, option_ids: payload.option_ids ?? [], ...(payload.other_text ? { other_text: payload.other_text } : {}) } });
      }
      if (path.endsWith('/messages')) messages.push({ id: `m${messages.length + 1}`, author: 'user', text: payload.text, images: [], created_at: at(messages.length + 1), reply_to: payload.reply_to });
      return reply({});
    }
    if (path === 'threads') return reply([thread()]);
    if (path.startsWith('threads/')) { threadLoads += 1; return reply(thread()); }
    if (path === 'projects') return reply({ projects });
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
const start = () => {
  messages = [
    { id: 'm1', author: 'user', text: 'Start', images: [], created_at: at(0) },
    { id: 'm2', author: 'agent', text: prompt, images: [], created_at: at(1), flag: 'needs_you', question: { ...question, options: question.options.map(o => ({ ...o })) } },
  ];
};

describe('withdrawn and re-asked questions', () => {
  beforeEach(() => { localStorage.clear(); projects = [{ id: 'alpha', name: 'Alpha', unread: 0 }]; start(); });

  it('renders an already withdrawn question as one muted line, and show expands it read-only', async () => {
    (messages[1]!.question as { withdrawn?: unknown }).withdrawn = { at: at(2), reason: 'stale' };
    (messages[1] as { flag?: string }).flag = 'fyi';
    await load();
    await vi.waitFor(() => expect(document.querySelector('.qclosed')).not.toBeNull());
    const line = document.querySelector('.qclosed')!;
    expect(line.textContent).toContain(`Withdrawn · ${prompt} · stale`);
    expect(document.querySelector('#msgs .qopt')).toBeNull();
    expect(document.querySelector('#msgs .qsubmit')).toBeNull();
    expect(document.querySelector('#msgs .qother')).toBeNull();
    expect(document.querySelector<HTMLElement>('#waiting-bar')!.hidden).toBe(true);
    (line.querySelector('.show') as HTMLButtonElement).click();
    const opt = document.querySelector<HTMLButtonElement>('#msgs .qopt');
    expect(opt?.disabled).toBe(true);
    expect(document.querySelector('#msgs .qsubmit')).toBeNull();
    expect(document.querySelector('#msgs .qother')).toBeNull();
    expect(document.querySelector('.prompt.struck')?.textContent).toBe(prompt);
  });

  it('collapses a re-asked original and keeps the new copy in the bar', async () => {
    (messages[1]!.question as { reasked?: boolean }).reasked = true;
    messages.push({ id: 'm3', author: 'agent', text: prompt, images: [], created_at: at(2), flag: 'needs_you', question: { ...question, id: 'q3', options: [{ id: 'o9', label: 'Reuse' }, { id: 'o8', label: 'Draw new' }] } });
    await load();
    await vi.waitFor(() => expect(document.querySelector('.qcard.reasked .qlink')).not.toBeNull());
    expect(document.querySelector('.qcard.reasked .qlink')?.textContent).toBe('Re-asked below');
    expect(document.querySelector('.qcard.reasked .qopt')).toBeNull();
    expect(document.querySelector<HTMLElement>('#waiting-bar')!.hidden).toBe(false);
    expect(document.querySelector('#waiting-bar .qopt, #waiting-bar .waiting-opt')).not.toBeNull();
    expect(document.getElementById('waiting-bar')?.dataset.question).toBe('q3');
  });

  it('keeps Other text when a question is withdrawn on the next poll, and Send as a message posts it', async () => {
    await load();
    await vi.waitFor(() => expect(document.querySelector('#waiting-bar .qother')).not.toBeNull());
    const input = document.querySelector<HTMLInputElement>('#waiting-bar .qother')!;
    input.value = 'Reuse them, but redraw the cover';
    (messages[1]!.question as { withdrawn?: unknown }).withdrawn = { at: at(3), reason: 'stale' };
    await repoll();
    const kept = document.querySelector<HTMLInputElement>('.qrescue .qother');
    expect(kept?.value).toBe('Reuse them, but redraw the cover');
    expect(document.querySelector('.qrescue')?.textContent).toContain('Send as a message');
    expect(document.querySelector<HTMLElement>('#error')!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('#waiting-bar')!.hidden).toBe(true);
    (document.querySelector('.qrescue button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(posts.some(post => post.path.endsWith('/messages') && post.body.text === 'Reuse them, but redraw the cover' && post.body.reply_to === 'm2')).toBe(true));
    await vi.waitFor(() => expect(document.body.textContent).toContain('Reuse them, but redraw the cover'));
  });

  it('recovers a 409 from Submit into the same rescue, without leaving the error line', async () => {
    await load();
    await vi.waitFor(() => expect(document.querySelector('#waiting-bar .qother')).not.toBeNull());
    const input = document.querySelector<HTMLInputElement>('#waiting-bar .qother')!;
    input.value = 'kept-on-409';
    (messages[1]!.question as { withdrawn?: unknown }).withdrawn = { at: at(3), reason: 'stale' };
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('.qrescue .qother')?.value).toBe('kept-on-409'));
    expect(document.querySelector<HTMLElement>('#error')!.hidden).toBe(true);
    expect(document.querySelector('#error')?.textContent).toBe('');
  });

  it('offers a bumped answer on the new copy', async () => {
    await load();
    await vi.waitFor(() => expect(document.querySelector('#waiting-bar .qother')).not.toBeNull());
    document.querySelector<HTMLInputElement>('#waiting-bar .qother')!.value = 'kept-on-bump';
    (messages[1]!.question as { reasked?: boolean }).reasked = true;
    messages.push({ id: 'm3', author: 'agent', text: prompt, images: [], created_at: at(3), flag: 'needs_you', question: { ...question, id: 'q3', options: [{ id: 'o9', label: 'Reuse' }, { id: 'o8', label: 'Draw new' }] } });
    await repoll();
    const use = [...document.querySelectorAll('.qrescue button')].find(button => button.textContent === 'Use on the new copy') as HTMLButtonElement;
    expect(use).toBeTruthy();
    expect(document.querySelector<HTMLInputElement>('.qrescue .qother')?.value).toBe('kept-on-bump');
    use.click();
    await vi.waitFor(() => expect(posts.some(post => post.path.endsWith('/answer') && post.body.question_id === 'q3' && post.body.other_text === 'kept-on-bump')).toBe(true));
    await vi.waitFor(() => expect(document.body.textContent).toContain('Answered: Other: kept-on-bump'));
  });

  it('hides Move to project with one project and lists only the other project with two', async () => {
    await load();
    await vi.waitFor(() => expect(threadLoads).toBeGreaterThan(0));
    expect(document.getElementById('move-open')?.hidden).toBe(true);
    document.getElementById('more')?.click();
    expect([...document.querySelectorAll('#popmenu button')].map(button => button.textContent)).not.toContain('Move to project…');
    projects = [{ id: 'alpha', name: 'Alpha', unread: 0 }, { id: 'beta', name: 'Beta', unread: 1 }];
    await repoll();
    expect(document.getElementById('move-open')?.hidden).toBe(false);
    document.getElementById('more')?.click();
    const move = [...document.querySelectorAll('#popmenu button')].find(button => button.textContent === 'Move to project…') as HTMLButtonElement;
    expect(move).toBeTruthy();
    move.click();
    const labels = [...document.querySelectorAll('#popmenu button')].map(button => button.textContent);
    expect(labels).toEqual(['Beta']);
  });
});
