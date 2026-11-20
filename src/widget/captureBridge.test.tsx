// The widget inside an artifact (0.12.0): it takes its orders from the page that framed it, never reads or patches the artifact's own console or requests, blanks private content,
// and hands a finished capture up by postMessage.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FeedbackWidget from './FeedbackWidget.js';
import { blankPrivate } from './screenshot.js';
import { targetFor } from './elements.js';
import { createBridge, fitImage, parseCommand, shotPayload } from './captureBridge.js';
import type { Command } from './captureBridge.js';
import type { Context, Options } from 'modern-screenshot';
import { domToCanvas } from 'modern-screenshot';

const captureCanvas = vi.mocked(domToCanvas as (context: Context) => Promise<HTMLCanvasElement>);
vi.mock('modern-screenshot', () => ({ domToCanvas: vi.fn(), createContext: vi.fn(async (node: Node, options: object) => ({ node, ...options, requests: new Map(), fontCssTexts: new Map() })) }));
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
let ctx: Record<string, ReturnType<typeof vi.fn>>;
beforeEach(() => {
  Reflect.deleteProperty(window, Symbol.for('standalone.feedback.capture'));
  vi.stubGlobal('devicePixelRatio', 1);
  ctx = Object.fromEntries(['drawImage', 'beginPath', 'stroke', 'fillText', 'moveTo', 'lineTo', 'strokeRect', 'fillRect'].map(name => [name, vi.fn()]));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(PNG);
  vi.spyOn(HTMLImageElement.prototype, 'decode').mockResolvedValue();
  captureCanvas.mockImplementation(async context => {
    const options = context as unknown as Options;
    const canvas = document.createElement('canvas'); canvas.width = options.width! * options.scale!; canvas.height = options.height! * options.scale!; return canvas;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fakeBridge() {
  let handler: (command: Command) => void = () => {};
  return { send: vi.fn(), closed: vi.fn(), onCommand: vi.fn((h: (command: Command) => void) => { handler = h; return () => { handler = () => {}; }; }), run: (command: Command) => act(() => handler(command)) };
}

describe('the widget with a bridge (inside an artifact)', () => {
  it('has no launcher, makes no request, and does not patch the page\'s console or fetch', async () => {
    const before = { fetch: window.fetch, warn: console.warn, error: console.error };
    const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
    const stubbed = window.fetch;
    const bridge = fakeBridge();
    const { container } = render(<FeedbackWidget bridge={bridge} />);
    expect((container.querySelector('.fb-launchers') as HTMLElement).style.display).toBe('none');
    await bridge.run({ op: 'start', mode: null, note: '' });
    expect(await screen.findByLabelText('Feedback toolbar')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'My feedback' })).toBeNull();
    expect(window.fetch).toBe(stubbed);
    expect(console.warn).toBe(before.warn); expect(console.error).toBe(before.error);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('starts a full page capture on command, prefilled with the note already typed, and sends the picture and note up (not to a server)', async () => {
    const bridge = fakeBridge();
    const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
    render(<FeedbackWidget bridge={bridge} />);
    await bridge.run({ op: 'start', mode: 'page', note: 'Already typed' });
    const note = await screen.findByLabelText('Note') as HTMLTextAreaElement;
    expect(note.value).toBe('Already typed');
    fireEvent.change(note, { target: { value: 'Already typed, and more' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(bridge.send).toHaveBeenCalledTimes(1));
    const shot = bridge.send.mock.calls[0]![0];
    expect(shot).toMatchObject({ note: 'Already typed, and more', mode: 'page', image: PNG, selector: '', components: [] });
    expect(shot.viewport.width).toBeGreaterThan(0);
    expect(bridge.closed).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Note')).toBeNull();
  });

  it('a cancel from the page closes it, and says so', async () => {
    const bridge = fakeBridge();
    render(<FeedbackWidget bridge={bridge} />);
    await bridge.run({ op: 'start', mode: null, note: '' });
    await screen.findByLabelText('Feedback toolbar');
    await bridge.run({ op: 'cancel' });
    await waitFor(() => expect(screen.queryByLabelText('Feedback toolbar')).toBeNull());
    expect(bridge.closed).toHaveBeenCalled();
  });
});

describe('what a finished capture carries', () => {
  it('an element capture names the element, its components and source; a region or page one has the box or nothing', () => {
    const element = { mode: 'element', target: { selector: 'button#pay', tag: 'button', role: 'button', name: 'Pay', text: 'Pay now', rect: { x: 10, y: 20, width: 30, height: 40 }, components: ['PayButton'], source: { file: 'src/Pay.tsx', line: 3, column: 1, component: 'PayButton' } }, context: {}, pending: Promise.resolve(null), capture: null, failed: false } as never;
    const done = { shot: { url: PNG, width: 1, height: 1, origin: { x: 0, y: 0 } } };
    expect(shotPayload(element, done, 'note', null)).toMatchObject({ mode: 'element', selector: 'button#pay', text: 'Pay now', components: ['PayButton'], rect: { x: 10, y: 20, width: 30, height: 40 }, source: { line: 3 }, image: PNG });
    expect(shotPayload(element, done, 'note', 'data:image/png;base64,DRAWN').image).toBe('data:image/png;base64,DRAWN'); // what was drawn on it, when it was
    const region = { ...(element as object), mode: 'region', target: { rect: { x: 1, y: 2, width: 3, height: 4 } } } as never;
    expect(shotPayload(region, done, 'n', null)).toMatchObject({ mode: 'region', rect: { x: 1, y: 2, width: 3, height: 4 }, selector: '', components: [] });
    const page = { ...(element as object), mode: 'page', target: { width: 800, height: 3000 } } as never;
    expect(shotPayload(page, done, 'n', null).rect).toBeNull();
    const failed = shotPayload(page, null, 'n', null);
    expect(failed.image).toBeNull();
    expect(failed.note).toContain('Screenshot capture failed');
  });

  it('private content reports no words, and is painted over in the picture', () => {
    document.body.innerHTML = '<div data-rf-private id="secret"><span id="inner">4242 4242</span></div><p id="open">Hello</p>';
    const secret = document.getElementById('secret')!;
    vi.spyOn(secret, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 100, height: 40 } as DOMRect);
    expect(targetFor(document.getElementById('inner')!)).toMatchObject({ text: '', name: '' });
    expect(targetFor(document.getElementById('open')!).text).toBe('Hello');
    const canvas = document.createElement('canvas');
    blankPrivate(canvas, 2, { x: 0, y: 100 });
    expect(ctx.fillRect).toHaveBeenCalledWith(20, 240, 200, 80);
    document.body.innerHTML = '';
    ctx.fillRect!.mockClear();
    blankPrivate(canvas, 2);
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });
});

describe('capturing inside a sandboxed page', () => {
  it('hands modern-screenshot a stand-in style sandbox when the origin is opaque, and leaves its own alone otherwise', async () => {
    const { capturePage } = await import('./screenshot.js');
    const { createContext } = await import('modern-screenshot');
    await capturePage({ width: 300, height: 200 });
    const normal = await vi.mocked(createContext).mock.results.at(-1)!.value as { sandbox?: unknown };
    expect(normal.sandbox).toBeUndefined();
    vi.stubGlobal('origin', 'null');
    await capturePage({ width: 300, height: 200 });
    const sandboxed = await vi.mocked(createContext).mock.results.at(-1)!.value as { sandbox?: { contentWindow: unknown; remove: () => void } };
    expect(sandboxed.sandbox?.contentWindow).toBeNull(); // no window to read: every computed style is copied
    expect(() => sandboxed.sandbox?.remove()).not.toThrow();
  });
});

describe('the bridge believes only the page that framed it', () => {
  const parent = {} as Window;
  it('parseCommand: another window, a wrong tag, an unknown op or a bad mode are not commands', () => {
    expect(parseCommand({ source: {} as MessageEventSource, data: { rf: 'cap', op: 'start', mode: 'region' } }, parent)).toBeNull();
    expect(parseCommand({ source: parent as unknown as MessageEventSource, data: { rf: 'other', op: 'start' } }, parent)).toBeNull();
    expect(parseCommand({ source: parent as unknown as MessageEventSource, data: { rf: 'cap', op: 'steal' } }, parent)).toBeNull();
    expect(parseCommand({ source: parent as unknown as MessageEventSource, data: null }, parent)).toBeNull();
    expect(parseCommand({ source: parent as unknown as MessageEventSource, data: { rf: 'cap', op: 'start', mode: 'both', note: 5 } }, parent)).toEqual({ op: 'start', mode: null, note: '' });
    expect(parseCommand({ source: parent as unknown as MessageEventSource, data: { rf: 'cap', op: 'start', mode: 'element', note: 'x'.repeat(5000) } }, parent)).toEqual({ op: 'start', mode: 'element', note: 'x'.repeat(4000) });
    expect(parseCommand({ source: parent as unknown as MessageEventSource, data: { rf: 'cap', op: 'cancel' } }, parent)).toEqual({ op: 'cancel' });
  });

  it('createBridge: a message from another window does nothing; one from the parent reaches the widget, and a finished shot goes to the parent only', async () => {
    const posted: unknown[] = [];
    const framed = Object.assign(new EventTarget(), { parent: { postMessage: (message: unknown) => { posted.push(message); } } }) as unknown as Window;
    const bridge = createBridge(framed);
    const seen: Command[] = [];
    bridge.onCommand(command => seen.push(command));
    const message = (source: unknown, data: unknown) => { const event = new Event('message') as Event & { source: unknown; data: unknown }; event.source = source; event.data = data; framed.dispatchEvent(event); };
    message({}, { rf: 'cap', op: 'start', mode: 'region' });
    expect(seen).toEqual([]);
    message((framed as unknown as { parent: unknown }).parent, { rf: 'cap', op: 'start', mode: 'region', note: 'hi' });
    expect(seen).toEqual([{ op: 'start', mode: 'region', note: 'hi' }]);
    bridge.send({ note: 'n', mode: 'region', image: PNG, rect: null, viewport: { width: 1, height: 1 }, selector: '', text: '', components: [] });
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ rf: 'shot', note: 'n', image: PNG });
    bridge.closed();
    expect(posted[1]).toEqual({ rf: 'cap-closed' });
  });

  it('fitImage: a small PNG is passed through, an unsupported type is dropped, and a picture too big for the cap is brought under it as a JPEG', async () => {
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(800);
    vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(600);
    expect(await fitImage(PNG)).toBe(PNG);
    expect(await fitImage('data:image/gif;base64,AAAA')).toBeNull();
    expect(await fitImage('hello')).toBeNull();
    const huge = `data:image/png;base64,${'A'.repeat(4000)}`; // about 3 KB decoded, over a 1 KB cap
    const small = 'data:image/jpeg;base64,AAAA';
    const toData = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation((type?: string) => (type === 'image/jpeg' ? small : huge));
    expect(await fitImage(huge, 1000)).toBe(small);
    toData.mockImplementation(() => huge);
    expect(await fitImage(huge, 1000)).toBeNull(); // nothing fits: the picture is dropped, never sent over the cap
  });
});
