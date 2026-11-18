import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FeedbackWidget from './FeedbackWidget.js';
import { BACKOFF, Outbox } from './outboxQueue.js';
import { openStore } from './outboxStore.js';
import { Outbox as OutboxList } from './OutboxList.js';
import { OutboxContext } from './useOutbox.js';
import type { OutboxRecord, OutboxStore } from './outboxStore.js';
import type { Capture } from './types.js';
import { domToCanvas } from 'modern-screenshot';
import type { Context } from 'modern-screenshot';
vi.mock('modern-screenshot', () => ({ domToCanvas: vi.fn(), createContext: vi.fn(async (node: Node, options: object) => ({ node, ...options, requests: new Map(), fontCssTexts: new Map() })) }));

// A store that outlives the Outbox, the way IndexedDB outlives a page.
function memoryStore(persistent = true) {
  const records = new Map<string, OutboxRecord>();
  const store: OutboxStore = {
    ready: Promise.resolve(persistent),
    load: async () => structuredClone([...records.values()]),
    put: async record => { records.set(record.id, structuredClone(record)); },
    remove: async id => { records.delete(id); },
  };
  return { store, records };
}
const shot: Capture = { shot: { url: 'data:image/png;base64,AAAA', width: 1, height: 1, origin: { x: 0, y: 0 } } };
const job = (id: string, capture: Capture | Promise<Capture> = shot) => ({
  id, label: id, text: `full text of ${id}`, capture,
  build: (result: Capture | null) => ({ note: id, image: result ? result.shot.url : 'blank', ...(result ? {} : { noPicture: true }) }),
});
const ok = () => new Response(JSON.stringify({ id: 'x' }), { status: 201 });
let fetchMock: ReturnType<typeof vi.fn>;
let queues: Outbox[] = [];
function boot(store: OutboxStore) { const outbox = new Outbox('/fb', store); queues.push(outbox); outbox.start(); return outbox; }
const bodies = () => fetchMock.mock.calls.map(call => JSON.parse(call[1].body));
const flushAsync = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
beforeEach(() => { vi.useFakeTimers(); fetchMock = vi.fn(async () => ok()); vi.stubGlobal('fetch', fetchMock); queues = []; });
afterEach(() => { for (const queue of queues) queue.stop(); cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('outbox queue', () => {
  it('sends one at a time, in the order saved, each with its own client_id', async () => {
    let inFlight = 0, peak = 0;
    fetchMock.mockImplementation(async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise(resolve => setTimeout(resolve, 100)); inFlight--; return ok(); });
    const { store, records } = memoryStore(); const outbox = boot(store); await flushAsync();
    outbox.enqueue(job('note-one-1')); outbox.enqueue(job('note-two-2')); outbox.enqueue(job('note-three-3'));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(bodies().map(body => [body.note, body.client_id])).toEqual([['note-one-1', 'note-one-1'], ['note-two-2', 'note-two-2'], ['note-three-3', 'note-three-3']]);
    expect(peak).toBe(1); expect(outbox.getSnapshot().items).toEqual([]); expect(records.size).toBe(0);
  });
  it('waits for a capture still running, then sends with the picture; a failed capture sends the text with no picture', async () => {
    const { store } = memoryStore(); const outbox = boot(store); await flushAsync();
    let finish: (capture: Capture) => void = () => {}, fail: (error: Error) => void = () => {};
    outbox.enqueue(job('slow-capture-1', new Promise<Capture>(resolve => { finish = resolve; })));
    outbox.enqueue(job('bad-capture-2', new Promise<Capture>((_, reject) => { fail = reject; })));
    await flushAsync(); expect(fetchMock).not.toHaveBeenCalled();
    expect(outbox.getSnapshot().items.map(item => item.status)).toEqual(['capturing', 'capturing']);
    fail(new Error('no')); await flushAsync(); expect(fetchMock).not.toHaveBeenCalled(); // still behind the first
    finish(shot); await flushAsync();
    expect(bodies().map(body => [body.note, body.image, body.noPicture])).toEqual([['slow-capture-1', shot.shot.url, undefined], ['bad-capture-2', 'blank', true]]);
  });
  it('retries a network failure or a 5xx after 2, 5, 15 and 30 s, then every 60 s, and stops once it is delivered', async () => {
    fetchMock.mockImplementation(async () => { throw new TypeError('offline'); });
    const { store } = memoryStore(); const outbox = boot(store); await flushAsync();
    outbox.enqueue(job('flaky-note-1')); await flushAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(outbox.getSnapshot().items[0]!.status).toBe('retrying');
    let calls = 1;
    for (const wait of [...BACKOFF, 60000]) {
      await act(async () => { await vi.advanceTimersByTimeAsync(wait - 1); }); expect(fetchMock).toHaveBeenCalledTimes(calls);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(fetchMock).toHaveBeenCalledTimes(++calls);
    }
    expect(BACKOFF).toEqual([2000, 5000, 15000, 30000, 60000]);
    fetchMock.mockImplementation(async () => new Response('bad gateway', { status: 502 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); }); expect(outbox.getSnapshot().items[0]!.status).toBe('retrying');
    fetchMock.mockImplementation(async () => ok());
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(outbox.getSnapshot().items).toEqual([]);
    const before = fetchMock.mock.calls.length; await act(async () => { await vi.advanceTimersByTimeAsync(300000); }); expect(fetchMock).toHaveBeenCalledTimes(before);
  });
  it('the online event and window focus skip the wait', async () => {
    fetchMock.mockImplementationOnce(async () => { throw new TypeError('offline'); });
    const { store } = memoryStore(); const outbox = boot(store); await flushAsync();
    outbox.enqueue(job('wait-skipped-1')); await flushAsync(); expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => { window.dispatchEvent(new Event('online')); }); await flushAsync();
    expect(fetchMock).toHaveBeenCalledTimes(2); expect(outbox.getSnapshot().items).toEqual([]);
    fetchMock.mockImplementationOnce(async () => { throw new TypeError('offline'); });
    outbox.enqueue(job('wait-skipped-2')); await flushAsync(); act(() => { window.dispatchEvent(new Event('focus')); }); await flushAsync();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  it('a 4xx fails the item with a plain reason, does not loop, lets later items through, and Retry and Discard work', async () => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ kind: 'feedback_too_large' }), { status: 413 }));
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ detail: 'Note must be 1–10000 characters' }), { status: 400 }));
    const { store, records } = memoryStore(); const outbox = boot(store); await flushAsync();
    outbox.enqueue(job('too-large-note-1')); outbox.enqueue(job('invalid-note-2')); outbox.enqueue(job('fine-note-3')); await flushAsync();
    await act(async () => { await vi.advanceTimersByTimeAsync(600000); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [large, invalid] = outbox.getSnapshot().items;
    expect(outbox.getSnapshot()).toMatchObject({ pending: 0, failed: 2 });
    expect(large!.reason).toContain('Too large'); expect(invalid!.reason).toContain('Note must be 1–10000 characters');
    expect(records.get('too-large-note-1')!.state).toBe('failed');
    outbox.retry('too-large-note-1'); await flushAsync();
    expect(fetchMock).toHaveBeenCalledTimes(4); expect(bodies()[3].client_id).toBe('too-large-note-1');
    outbox.discard('invalid-note-2'); expect(outbox.getSnapshot().items).toEqual([]); expect(records.size).toBe(0);
  });
  it('429 and 408 are retried, not failed', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('slow down', { status: 429 }));
    const { store } = memoryStore(); const outbox = boot(store); await flushAsync();
    outbox.enqueue(job('rate-limited-1')); await flushAsync();
    expect(outbox.getSnapshot().items[0]!.status).toBe('retrying');
  });
  it('survives a reload: what was unsent is sent after it, with the same client_id, once', async () => {
    fetchMock.mockImplementation(async () => { throw new TypeError('offline'); });
    const { store, records } = memoryStore(); const first = boot(store); await flushAsync();
    first.enqueue(job('before-reload-1')); first.enqueue(job('before-reload-2')); await flushAsync();
    first.stop(); expect([...records.keys()]).toEqual(['before-reload-1', 'before-reload-2']);
    fetchMock.mockClear(); fetchMock.mockImplementation(async () => ok());
    const second = boot(store); await flushAsync();
    expect(bodies().map(body => body.client_id)).toEqual(['before-reload-1', 'before-reload-2']);
    expect(second.getSnapshot().items).toEqual([]); expect(records.size).toBe(0);
    fetchMock.mockClear(); boot(store); await flushAsync(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('a capture that never finished before the reload is sent as text with the no-picture version', async () => {
    const { store, records } = memoryStore(); const first = boot(store); await flushAsync();
    first.enqueue(job('cut-short-1', new Promise<Capture>(() => {}))); await flushAsync();
    expect(records.get('cut-short-1')!.body).toBeNull(); first.stop();
    boot(store); await flushAsync();
    expect(bodies()).toEqual([{ note: 'cut-short-1', image: 'blank', noPicture: true, client_id: 'cut-short-1' }]);
  });
  it('a failed item is still failed after a reload and is not resent', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('', { status: 400 }));
    const { store } = memoryStore(); const first = boot(store); await flushAsync();
    first.enqueue(job('stays-failed-1')); await flushAsync(); first.stop(); fetchMock.mockClear();
    const second = boot(store); await flushAsync();
    expect(fetchMock).not.toHaveBeenCalled(); expect(second.getSnapshot().items[0]!.status).toBe('failed');
  });
  it('the IndexedDB wrapper falls back to memory when there is no IndexedDB', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const store = openStore();
    expect(await store.ready).toBe(false);
    const record: OutboxRecord = { id: 'a-record-1', seq: 1, label: 'x', text: 'x', body: null, fallback: { note: 'x' }, state: 'queued' };
    await store.put(record); expect(await store.load()).toEqual([record]);
    await store.remove('a-record-1'); expect(await store.load()).toEqual([]);
  });
});

describe('stuck items', () => {
  it('after 3 failed attempts an item moves behind the others, which still send', async () => {
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => (JSON.parse(init.body).note === 'poison-note-1' ? new Response('', { status: 500 }) : ok()));
    const { store } = memoryStore(); const outbox = boot(store); await flushAsync();
    outbox.enqueue(job('poison-note-1'));
    await act(async () => { await vi.advanceTimersByTimeAsync(7100); });  // attempts at 0, 2 s and 7 s: the third failure
    expect(outbox.getSnapshot().items[0]).toMatchObject({ id: 'poison-note-1', stuck: true, attempts: 3 });
    outbox.enqueue(job('behind-note-2')); outbox.enqueue(job('behind-note-3')); await flushAsync();
    expect(bodies().filter(body => body.note !== 'poison-note-1').map(body => body.note)).toEqual(['behind-note-2', 'behind-note-3']);
    expect(outbox.getSnapshot().items.map(item => item.id)).toEqual(['poison-note-1']);
  });
  it('a note still waiting its first retries blocks later ones, to keep order', async () => {
    fetchMock.mockImplementation(async () => { throw new TypeError('offline'); });
    const { store } = memoryStore(); const outbox = boot(store); await flushAsync();
    outbox.enqueue(job('first-note-01')); await flushAsync(); outbox.enqueue(job('second-note-2')); await flushAsync();
    expect(bodies().map(body => body.note)).toEqual(['first-note-01']);
  });
  it('Send without picture sends the text-only body, and Discard removes a stuck item even mid-send', async () => {
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => (JSON.parse(init.body).noPicture ? ok() : new Response('', { status: 500 })));
    const { store, records } = memoryStore(); const outbox = boot(store); await flushAsync();
    outbox.enqueue(job('big-picture-1')); outbox.enqueue(job('too-slow-pic-2'));
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(outbox.getSnapshot().items.every(item => item.stuck)).toBe(true);
    render(<OutboxContext.Provider value={outbox}><OutboxList /></OutboxContext.Provider>);
    expect(screen.getAllByText(/Still can't send it after \d tries/)).toHaveLength(2);
    const row = screen.getByText('big-picture-1').closest('li')!;
    expect(row.querySelector('pre')!.textContent).toBe('full text of big-picture-1');
    fireEvent.click(within(row).getByRole('button', { name: 'Send without picture' })); await flushAsync();
    expect(bodies().find(body => body.noPicture)).toMatchObject({ note: 'big-picture-1', noPicture: true, client_id: 'big-picture-1' });
    expect(outbox.getSnapshot().items.map(item => item.id)).toEqual(['too-slow-pic-2']);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' })); await flushAsync();
    expect(outbox.getSnapshot().items).toEqual([]); expect(records.size).toBe(0);
  });
});

describe('outbox in the widget', () => {
  it('lists each item in the panel with Retry and Discard on a failed one, and says when it cannot persist', async () => {
    fetchMock.mockImplementation(async () => new Response('', { status: 400 }));
    const { store } = memoryStore(false); const outbox = boot(store); await flushAsync();
    outbox.enqueue(job('listed-note-1'));
    render(<OutboxContext.Provider value={outbox}><OutboxList /></OutboxContext.Provider>);
    await flushAsync();
    expect(screen.getByText(/can't keep unsent notes across a reload/)).toBeTruthy();
    expect(screen.getByText(/Failed: The feedback server refused it \(400\)/)).toBeTruthy();
    fetchMock.mockImplementation(async () => ok());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await flushAsync();
    expect(screen.queryByRole('region', { name: 'Outbox' })).toBeNull();
    outbox.enqueue(job('discarded-note-2')); await flushAsync();
  });
  it('the pill counts what is pending and turns to a warning when something failed', async () => {
    fetchMock.mockImplementation(async () => { throw new TypeError('offline'); });
    vi.stubGlobal('indexedDB', undefined);
    const options = (context: Context) => context as unknown as { width: number; height: number; scale: number };
    vi.mocked(domToCanvas).mockImplementation(async context => { const canvas = document.createElement('canvas'); canvas.width = options(context).width; canvas.height = options(context).height; return canvas; });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,iVBORw0KGgo=');
    render(<FeedbackWidget />); await flushAsync();
    const pill = () => screen.getByRole('button', { name: /^Feedback/ });
    expect(pill().textContent).not.toContain('sending');
    for (let i = 0; i < 2; i++) {
      fireEvent.click(pill()); fireEvent.click(screen.getByRole('button', { name: 'Full page' })); await flushAsync();
      fireEvent.change(screen.getByPlaceholderText('What should change?'), { target: { value: `Note ${i}` } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' })); await flushAsync();
    }
    expect(pill().textContent).toContain('2 sending'); expect(pill().className).not.toContain('warn');
    fetchMock.mockImplementation(async () => new Response('', { status: 400 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(pill().textContent).toContain('2 failed'); expect(pill().className).toContain('warn');
  });
});
