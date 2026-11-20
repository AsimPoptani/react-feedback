// 0.12.0 in the browser (happy-dom): what the share shell believes from the artifact, what the live player believes from its parent, and parseShot.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseShot } from '../inbox/shot.js';
import { shellPage, shellScript } from '../shell';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const good = { rf: 'shot', note: 'The button is cut off', mode: 'element', image: PNG, rect: { x: 10, y: 20, width: 100, height: 50 }, viewport: { width: 400, height: 800 }, selector: 'button#pay', text: 'Pay', components: ['PayButton'], source: { file: 'src/Pay.tsx', line: 4, column: 2, component: 'PayButton' } };

describe('parseShot: every field of a capture from an artifact is checked', () => {
  it('keeps a good capture and works out the box as fractions of the viewport', () => {
    const shot = parseShot(good, 1_000_000)!;
    expect(shot).toMatchObject({ note: 'The button is cut off', mode: 'element', image: PNG, selector: 'button#pay', text: 'Pay', components: ['PayButton'], source: { file: 'src/Pay.tsx', line: 4, column: 2, component: 'PayButton' } });
    expect(shot.box).toEqual([0.025, 0.025, 0.25, 0.063]);
  });
  it('is not a capture without the tag, a note or a known mode', () => {
    expect(parseShot(null, 1e6)).toBeNull();
    expect(parseShot('shot', 1e6)).toBeNull();
    expect(parseShot({ ...good, rf: 'pick' }, 1e6)).toBeNull();
    expect(parseShot({ ...good, note: '   ' }, 1e6)).toBeNull();
    expect(parseShot({ ...good, note: 5 }, 1e6)).toBeNull();
    expect(parseShot({ ...good, mode: 'everything' }, 1e6)).toBeNull();
  });
  it('drops what is not valid and keeps the rest', () => {
    for (const image of ['data:text/html;base64,AAAA', 'data:image/gif;base64,AAAA', 'javascript:alert(1)', 'data:image/png;base64,AA AA', 5, null, 'data:image/png;base64,' + 'A'.repeat(100)]) {
      expect(parseShot({ ...good, image }, 50)!.image).toBeNull();
    }
    const bad = parseShot({ ...good, rect: { x: Number.NaN, y: 0, width: 5, height: 5 }, viewport: { width: 0, height: 10 }, components: 'PayButton', source: { file: 5, line: 1 } }, 1e6)!;
    expect(bad.rect).toBeNull(); expect(bad.viewport).toBeNull(); expect(bad.box).toBeNull(); expect(bad.components).toEqual([]); expect(bad.source).toBeNull();
    expect(parseShot({ ...good, rect: { x: 0, y: 0, width: -5, height: 5 } }, 1e6)!.rect).toBeNull();
    expect(parseShot({ ...good, source: { file: 'a.tsx', line: 1.5 } }, 1e6)!.source).toBeNull();
  });
  it('clips long text, strips control characters and caps the list of components', () => {
    const shot = parseShot({ ...good, note: `hi\u0000there${'x'.repeat(5000)}`, selector: 's'.repeat(500), text: 't'.repeat(500), components: Array.from({ length: 30 }, (_, i) => `C${i}`) }, 1e6)!;
    expect(shot.note.startsWith('hithere')).toBe(true);
    expect(shot.note).toHaveLength(4000);
    expect(shot.selector).toHaveLength(300); expect(shot.text).toHaveLength(200); expect(shot.components).toHaveLength(8);
  });
});

describe('the share shell', () => {
  let frameWindow: { postMessage: ReturnType<typeof vi.fn> };
  let fetchMock: ReturnType<typeof vi.fn>;
  let status = 201;
  async function load() {
    const html = await shellPage({ html: '<html><body><p>Page</p></body></html>', title: 'Checkout page', record: false });
    const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script type="application/json"')).replace(/<iframe[^>]*><\/iframe>/, '<iframe id="art"></iframe>');
    document.body.innerHTML = `${body}<script type="application/json" id="rf-config">{"record":false}</script>`;
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
    frameWindow = { postMessage: vi.fn() };
    Object.defineProperty(document.getElementById('art')!, 'contentWindow', { value: frameWindow, configurable: true });
    new Function(shellScript())();
  }
  // The viewer asks for a capture in the shell (that arms it and sends a one-time word); the artifact's answer must carry that word.
  const arm = () => { from(frameWindow, { rf: 'cap-ready' }); document.querySelector<HTMLButtonElement>('[data-capture="region"]')!.click(); return (frameWindow.postMessage.mock.calls.at(-1)![0] as { nonce: string }).nonce; };
  const from = (source: unknown, data: unknown) => { const event = new Event('message') as Event & { source: unknown; data: unknown }; event.source = source; event.data = data; window.dispatchEvent(event); };
  const sentBody = (call = 0) => JSON.parse(fetchMock.mock.calls[call]![1].body as string) as Record<string, unknown>;
  beforeEach(async () => {
    status = 201;
    fetchMock = vi.fn(async () => ({ status, ok: status < 300 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => a });
    await load();
  });
  afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

  it('ignores a message from any window but the artifact\'s own', async () => {
    const nonce = arm();
    from({}, { ...good, nonce });
    from(window, { ...good, nonce });
    await new Promise(r => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect((document.getElementById('fb-toast') as HTMLElement).hidden).toBe(true);
  });

  it('a forged capture with no click, a wrong word, a used word or one after the time is not sent (the artifact is the page\'s own code)', async () => {
    from(frameWindow, good); from(frameWindow, { ...good, nonce: '' }); from(frameWindow, { ...good, nonce: 'guess' });
    const nonce = arm();
    from(frameWindow, { ...good, nonce: 'guess' }); // armed, but the wrong word
    await new Promise(r => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    from(frameWindow, { ...good, nonce });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    from(frameWindow, { ...good, nonce }); // one capture, one shot
    from(frameWindow, { ...good, nonce });
    await new Promise(r => setTimeout(r, 30));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const late = arm();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 121_000);
    from(frameWindow, { ...good, nonce: late });
    vi.useRealTimers();
    await new Promise(r => setTimeout(r, 30));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows the capture buttons only once the artifact says its capture script is there, and a click starts that capture', () => {
    expect((document.getElementById('fb-capture') as HTMLElement).hidden).toBe(true);
    from(frameWindow, { rf: 'cap-ready' });
    expect((document.getElementById('fb-capture') as HTMLElement).hidden).toBe(false);
    (document.getElementById('fb-note') as HTMLTextAreaElement).value = 'Typed first';
    document.querySelector<HTMLButtonElement>('[data-capture="region"]')!.click();
    expect(frameWindow.postMessage).toHaveBeenCalledWith({ rf: 'cap', op: 'start', mode: 'region', note: 'Typed first', maxBytes: 1_900_000, nonce: expect.stringMatching(/^[0-9a-f]{24}$/) }, '*');
    expect((document.getElementById('fb-open') as HTMLElement).hidden).toBe(true); // out of the way while capturing
    from(frameWindow, { rf: 'cap-closed' });
    expect((document.getElementById('fb-open') as HTMLElement).hidden).toBe(false);
  });

  it('sends a good capture to the same feedback path, with the image flag, the picture and what it pointed at', async () => {
    const nonce = arm();
    from(frameWindow, { ...good, nonce });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/feedback\?image=1$/);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'text/plain' });
    expect(init.credentials).toBe('omit');
    expect(sentBody()).toEqual({ note: 'The button is cut off', image: PNG, quote: { text: 'Pay', path: 'button#pay', mode: 'element', box: [0.025, 0.025, 0.25, 0.063], components: ['PayButton'], source: { file: 'src/Pay.tsx', line: 4, column: 2, component: 'PayButton' } } });
    await vi.waitFor(() => expect(document.getElementById('fb-toast')!.textContent).toBe('Thanks, your note was sent.'));
  });

  it('drops bad fields: a note with a bad picture goes alone, to the plain path; one with no valid mode is not sent at all', async () => {
    from(frameWindow, { ...good, nonce: arm(), image: 'data:text/html;base64,AAAA', rect: { x: Number.NaN, y: 0, width: 1, height: 1 }, components: 'x' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/feedback$/);
    expect(sentBody()).toEqual({ note: 'The button is cut off', quote: { text: 'Pay', path: 'button#pay', mode: 'element', source: { file: 'src/Pay.tsx', line: 4, column: 2, component: 'PayButton' } } });
    await vi.waitFor(() => expect(document.getElementById('fb-toast')!.textContent).toBe('Thanks, your note was sent.'));
    from(frameWindow, { ...good, nonce: arm(), mode: 'whole' });
    await new Promise(r => setTimeout(r, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.getElementById('fb-toast')!.textContent).toBe('That capture could not be read.');
  });

  it('when the send fails the note and its picture come back in the dialog, so nothing is lost, and Send tries again', async () => {
    status = 429;
    from(frameWindow, { ...good, nonce: arm() });
    await vi.waitFor(() => expect((document.getElementById('fb-dialog') as HTMLDialogElement).hasAttribute('open')).toBe(true));
    expect((document.getElementById('fb-note') as HTMLTextAreaElement).value).toBe('The button is cut off');
    expect((document.getElementById('fb-held') as HTMLElement).hidden).toBe(false);
    expect(document.getElementById('fb-status')!.textContent).toContain('Too many notes');
    status = 201;
    (document.getElementById('fb-send') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1]![0])).toMatch(/\?image=1$/);
    expect(sentBody(1).image).toBe(PNG);
    await vi.waitFor(() => expect(document.getElementById('fb-status')!.textContent).toBe('Thanks, your note was sent.'));
  });

  it('a note typed in the dialog with no capture is the old request: the plain path and just the note', async () => {
    (document.getElementById('fb-note') as HTMLTextAreaElement).value = 'Only words';
    (document.getElementById('fb-send') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/feedback$/);
    expect(sentBody()).toEqual({ note: 'Only words' });
  });
});

describe('the live player page', () => {
  const instances: { root: HTMLElement; startLive: ReturnType<typeof vi.fn>; addEvent: ReturnType<typeof vi.fn>; wrapper: HTMLElement; handlers: Record<string, (d: unknown) => void> }[] = [];
  const event = (t: number, type = 3) => ({ type, timestamp: t, data: {} });
  const send = (data: unknown, over: { source?: unknown; origin?: string } = {}) => {
    const e = new Event('message') as Event & { source: unknown; data: unknown; origin: string };
    e.source = 'source' in over ? over.source : window.parent; e.data = data; e.origin = over.origin ?? location.origin; window.dispatchEvent(e);
  };
  const added: [string, EventListenerOrEventListenerObject][] = [];
  beforeEach(async () => {
    instances.length = 0; added.length = 0;
    const real = window.addEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation((type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => { added.push([type, fn]); real(type, fn, opts); });
    vi.resetModules();
    vi.doMock('rrweb-player', () => ({ default: vi.fn() }));
    vi.doMock('@rrweb/replay', () => ({ Replayer: class { handlers: Record<string, (d: unknown) => void> = {}; wrapper = document.createElement('div'); startLive = vi.fn(); addEvent = vi.fn(); destroy = vi.fn(); constructor(_events: unknown[], public config: { root: HTMLElement }) { instances.push(this as never); (this as unknown as { root: HTMLElement }).root = config.root; } on(name: string, h: (d: unknown) => void) { this.handlers[name] = h; } } }));
    document.body.innerHTML = '<div id="rf-player"></div>';
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    await import('../../src/replay/player.ts');
  });
  afterEach(() => { for (const [type, fn] of added) window.removeEventListener(type, fn); vi.restoreAllMocks(); vi.doUnmock('@rrweb/replay'); vi.doUnmock('rrweb-player'); document.body.innerHTML = ''; });

  it('tells its parent it is ready, and believes only a message from its parent, from its own origin', () => {
    expect(window.parent.postMessage).toHaveBeenCalledWith({ rf: 'player-ready' }, '*');
    send({ rf: 'live', events: [event(1000)] }, { source: {} });
    send({ rf: 'live', events: [event(1000)] }, { source: null });
    send({ rf: 'live', events: [event(1000)] }, { origin: 'https://evil.example' });
    send({ rf: 'live', events: [event(1000)] }, { origin: 'null' });
    expect(instances).toHaveLength(0);
    send({ rf: 'live', events: [event(1000)], width: 640, height: 400 });
    expect(instances).toHaveLength(1);
    expect(document.querySelector('.rf-live-badge')!.textContent).toBe('LIVE');
  });

  it('starts live a few seconds behind its newest event and draws what it is given; more events are passed on, and only whole ones', () => {
    send({ rf: 'live', events: [event(10_000), event(20_000)], width: 640, height: 400 });
    const live = instances[0]!;
    expect(live.startLive).toHaveBeenCalledWith(14_000); // 20 s minus the 6 s it runs behind
    expect(live.addEvent).toHaveBeenCalledTimes(2);
    send({ rf: 'more', events: [event(21_000), { type: 99, timestamp: 1 }, { type: 3 }, null, 'x', { type: 3, timestamp: -4 }, event(22_000)] });
    expect(live.addEvent).toHaveBeenCalledTimes(4);
    send({ rf: 'more', events: [event(23_000)] }, { source: {} }); // not the parent: nothing
    expect(live.addEvent).toHaveBeenCalledTimes(4);
  });

  it('takes at most 5000 events from one message, and "more" before "live" does nothing', () => {
    send({ rf: 'more', events: [event(1)] });
    expect(instances).toHaveLength(0);
    send({ rf: 'live', events: Array.from({ length: 6500 }, (_, i) => event(1000 + i)) });
    expect(instances[0]!.addEvent).toHaveBeenCalledTimes(5000);
  });

  it('a second "live" destroys the first player instead of leaving it running', () => {
    send({ rf: 'live', events: [event(1000)] });
    send({ rf: 'live', events: [event(2000)] });
    expect(instances).toHaveLength(2);
    expect((instances[0] as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy).toHaveBeenCalledTimes(1);
    send({ rf: 'more', events: [event(3000)] });
    expect(instances[0]!.addEvent).toHaveBeenCalledTimes(1);
    expect(instances[1]!.addEvent).toHaveBeenCalledTimes(2);
  });

  it('shows ENDED when told, and then takes nothing more', () => {
    send({ rf: 'live', events: [event(1000)] });
    send({ rf: 'ended' });
    expect(document.querySelector('.rf-live-badge')!.textContent).toBe('ENDED');
    send({ rf: 'more', events: [event(2000)] });
    expect(instances[0]!.addEvent).toHaveBeenCalledTimes(1);
  });
});
