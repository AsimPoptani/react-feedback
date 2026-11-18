import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FeedbackWidget from './FeedbackWidget.js';
import { getContext, installCapture } from './context.js';
import { componentChain, selectorFor, sectionFor } from './elements.js';
import type { Context, Options } from 'modern-screenshot';
import { domToCanvas } from 'modern-screenshot';
// The widget builds one context per capture (createContext) and renders it (domToCanvas(context)); the fake context keeps the options.
const captureCanvas = vi.mocked(domToCanvas as (context: Context) => Promise<HTMLCanvasElement>);
const optionsOf = (call: number) => (captureCanvas.mock.calls[call] as unknown as [Options & { node: Node }])[0];
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
vi.mock('modern-screenshot', () => ({ domToCanvas: vi.fn(), createContext: vi.fn(async (node: Node, options: object) => ({ node, ...options, requests: new Map(), fontCssTexts: new Map() })) }));
interface CardProps { click: () => void; pointer: () => void }
function ItemCard({ click, pointer }: CardProps) { return <button type="button" data-testid="item-card" onClick={click} onPointerDown={pointer}>Open Item</button>; }
function CardGroup(props: CardProps) { return <section data-testid="item-section"><ItemCard {...props} /></section>; }
const originalWarn = console.warn, originalError = console.error;
let fetchMock: ReturnType<typeof vi.fn>;
let ctx: Record<string, ReturnType<typeof vi.fn>>;
beforeEach(() => {
  localStorage.clear();
  Reflect.deleteProperty(window, Symbol.for('standalone.feedback.capture'));
  console.warn = originalWarn; console.error = originalError;
  fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ id: '20261118-120000-abcd' })));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('devicePixelRatio', 2);
  ctx = Object.fromEntries(['drawImage', 'beginPath', 'stroke', 'fillText', 'moveTo', 'lineTo', 'strokeRect'].map(name => [name, vi.fn()]));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(PNG);
  vi.spyOn(HTMLImageElement.prototype, 'decode').mockResolvedValue();
  captureCanvas.mockImplementation(async context => {
    const options = context as unknown as Options;
    const canvas = document.createElement('canvas'); canvas.width = options.width! * options.scale!; canvas.height = options.height! * options.scale!; return canvas;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); console.warn = originalWarn; console.error = originalError; });
function open() { fireEvent.click(screen.getByRole('button', { name: 'Feedback' })); }
function enterNote(value = 'Make this clearer') { fireEvent.change(screen.getByPlaceholderText('What should change?'), { target: { value } }); }
// Save only queues the note; wait for the toast and for the background send.
async function sent() { await screen.findByText('Queued'); await waitFor(() => expect(fetchMock.mock.calls.some(call => call[1]?.method === 'POST')).toBe(true)); }
function payload() { return JSON.parse(fetchMock.mock.calls.at(-1)![1].body); }
async function capturePage() { open(); fireEvent.click(screen.getByRole('button', { name: 'Full page' })); await screen.findByLabelText('Note'); }
function app(hints?: 'on' | 'off') {
  const click = vi.fn(), pointer = vi.fn();
  render(<><CardGroup click={click} pointer={pointer} /><FeedbackWidget endpoint="/custom" hints={hints} /></>);
  const target = screen.getByTestId('item-card'), section = screen.getByTestId('item-section');
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ x: 100, y: 80, width: 200, height: 60 } as DOMRect);
  vi.spyOn(section, 'getBoundingClientRect').mockReturnValue({ x: 40, y: 50, width: 400, height: 200 } as DOMRect);
  return { click, pointer, target, section };
}
describe('FeedbackWidget', () => {
  it('preserves app focus on mount and returns focus to the launcher only after closing', () => {
    render(<button type="button">App focus</button>);
    screen.getByRole('button', { name: 'App focus' }).focus();
    const focused = document.activeElement;
    render(<StrictMode><FeedbackWidget /></StrictMode>);
    expect(document.activeElement).toBe(focused);
    open(); fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Feedback' }));
  });
  it.each(['Element', 'Section'].flatMap(mode => ['Enter', ' '].map(key => ({ mode, key }))))('$mode captures the focused app element with $key and blocks its handler', async ({ mode, key }) => {
    const handler = vi.fn();
    render(<><section data-testid="keyboard-section"><button type="button" onKeyDown={handler}>Keyboard target</button></section><FeedbackWidget /></>);
    const target = screen.getByRole('button', { name: 'Keyboard target' });
    open(); act(() => target.focus());
    fireEvent.keyDown(target, { code: mode === 'Element' ? 'Digit2' : 'Digit3' });
    expect(fireEvent.keyDown(target, { key, code: key === 'Enter' ? 'Enter' : 'Space' })).toBe(false);
    if (key === ' ') { expect(screen.queryByLabelText('Note')).toBeNull(); fireEvent.keyDown(target, { code: 'Enter' }); }
    expect(handler).not.toHaveBeenCalled();
    await screen.findByLabelText('Note'); enterNote();
    fireEvent.click(screen.getByRole('button', { name: 'Save' })); await sent();
    expect(payload().target.selector).toBe(mode === 'Element' ? selectorFor(target) : '[data-testid="keyboard-section"]');
  });
  it('opens a toolbar, supports the shortcut and numbers, and Escape backs out one step', () => {
    render(<FeedbackWidget />);
    expect(screen.queryByLabelText('Feedback toolbar')).toBeNull();
    fireEvent.keyDown(window, { code: 'KeyF', altKey: true, shiftKey: true });
    expect(screen.getByLabelText('Feedback toolbar')).toBeTruthy(); expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.keyDown(window, { key: '1', code: 'Digit1' }); expect(screen.getByRole('dialog', { name: 'Select screenshot region' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' }); expect(screen.getByLabelText('Feedback toolbar')).toBeTruthy();
    fireEvent.keyDown(window, { key: '2', code: 'Digit2' }); expect(screen.getByText(/Select an element/)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' }); fireEvent.keyDown(window, { key: '3', code: 'Digit3' }); expect(screen.getByText(/Select a section/)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' }); fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    expect(screen.queryByLabelText('Feedback toolbar')).toBeNull();
  });
  it.each(['Element', 'Section'])('%s captures metadata, suppresses app events, then saves once', async mode => {
    const { click, pointer, target } = app(); open(); fireEvent.click(screen.getByRole('button', { name: mode }));
    fireEvent.pointerMove(target); expect(document.querySelector('.fb-highlight')?.textContent).toContain('CardGroup');
    fireEvent.pointerDown(target, { pointerType: 'touch' }); fireEvent.pointerUp(target, { pointerType: 'touch' }); fireEvent.click(target);
    expect(click).not.toHaveBeenCalled(); expect(pointer).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Note')).toBeNull(); expect(domToCanvas).not.toHaveBeenCalled();
    expect(document.querySelector('.fb-highlight')?.classList.contains('fb-locked')).toBe(true);
    fireEvent.keyDown(window, { code: 'Enter' });
    const textarea = await screen.findByLabelText('Note'); expect(document.activeElement).toBe(textarea);
    expect(fetchMock).not.toHaveBeenCalled();
    enterNote(); fireEvent.click(screen.getByRole('button', { name: 'Save' })); await sent();
    expect(fetchMock).toHaveBeenCalledOnce(); expect(fetchMock.mock.calls[0]![0]).toBe('/custom/api/items');
    expect(payload()).toMatchObject({ note: 'Make this clearer', mode: mode.toLowerCase(), image: PNG, context_image: PNG, target: { tag: mode === 'Element' ? 'button' : 'section', selector: `[data-testid="${mode === 'Element' ? 'item-card' : 'item-section'}"]`, components: mode === 'Element' ? ['ItemCard', 'CardGroup'] : ['CardGroup'] } });
    if (mode === 'Element') expect(payload().target).toMatchObject({ role: 'button', name: 'Open Item', text: 'Open Item', rect: { x: 100, y: 80, width: 200, height: 60 } });
    expect(payload().annotated).toBeUndefined(); expect(payload().pins).toBeUndefined();
    expect(screen.queryByLabelText('Feedback note')).toBeNull(); expect(screen.queryByLabelText('Feedback toolbar')).toBeNull();
    expect(document.querySelector('.fb-toast')?.textContent).toBe('Queued');
    expect(screen.getByRole('button', { name: 'Feedback' }).getAttribute('aria-expanded')).toBe('false');
  });
  it('keeps a dragged region selected until Enter and sends only the rect as target', async () => {
    render(<FeedbackWidget />); open(); fireEvent.click(screen.getByRole('button', { name: 'Region' }));
    const surface = screen.getByRole('application', { name: /Drag a region/ });
    surface.setPointerCapture = vi.fn();
    fireEvent.pointerDown(surface, { clientX: 25, clientY: 35, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 150, clientY: 120, pointerId: 1 });
    expect(document.querySelector('.fb-region-box')?.getAttribute('style')).toContain('width: 125px');
    fireEvent.pointerUp(surface, { clientX: 150, clientY: 120, pointerId: 1 });
    expect(screen.queryByLabelText('Note')).toBeNull(); expect(domToCanvas).not.toHaveBeenCalled();
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(window, { code: 'Enter' });
    await screen.findByLabelText('Note'); enterNote('This area'); fireEvent.click(screen.getByRole('button', { name: 'Save' })); await sent();
    expect(payload()).toMatchObject({ mode: 'region', target: { rect: { x: 25, y: 35, width: 125, height: 85 } }, image: PNG, context_image: PNG });
    expect(Object.keys(payload().target)).toEqual(['rect']);
  });
  it('full page captures the whole document, requires a note and Cmd+Enter saves', async () => {
    vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockReturnValue(3200);
    render(<FeedbackWidget />); open(); fireEvent.keyDown(window, { key: '4', code: 'Digit4' }); await screen.findByLabelText('Note');
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }); expect(save.disabled).toBe(true);
    enterNote('  '); expect(save.disabled).toBe(true);
    fireEvent.keyDown(screen.getByLabelText('Note'), { key: 'Enter', code: 'Enter', metaKey: true }); expect(fetchMock).not.toHaveBeenCalled();
    enterNote(); fireEvent.keyDown(screen.getByLabelText('Note'), { key: 'Enter', code: 'Enter', metaKey: true }); await sent();
    expect(payload()).toMatchObject({ mode: 'page', target: { width: innerWidth, height: 3200 }, image: PNG, context: { url: location.href, route: location.pathname + location.search, viewport: { width: innerWidth, height: innerHeight }, scroll: { x: 0, y: 0 }, devicePixelRatio: 2, console: [], failedFetches: [] } });
    expect(payload().context_image).toBeUndefined(); expect(payload().annotated).toBeUndefined();
    expect(payload().context.ts).toBeTruthy(); expect(payload().context.userAgent).toBeTruthy();
    expect(optionsOf(0)).toMatchObject({ height: 3200, scale: 2 });
  });
  it('caps full page at 16000 px and includes the clipping notice in the saved note', async () => {
    vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockReturnValue(20000);
    render(<FeedbackWidget />); await capturePage();
    expect(screen.getByText(/Full page capture clipped at 16 000 px/)).toBeTruthy();
    enterNote('Long page'); fireEvent.click(screen.getByRole('button', { name: 'Save' })); await sent();
    expect(payload().note).toBe('Long page\n\nFull page capture clipped at 16 000 px (page height: 20000 px).');
    expect(payload().target.height).toBe(20000); expect(optionsOf(0).height).toBe(16000);
  });
  it('grows to a parent with Up and returns with Down before capture', async () => {
    const { target, section } = app(); open(); fireEvent.click(screen.getByRole('button', { name: 'Element' }));
    fireEvent.pointerMove(target); fireEvent.keyDown(window, { key: 'ArrowUp', code: 'ArrowUp' });
    expect(document.querySelector('.fb-highlight')?.textContent).toContain('item-section');
    expect((document.querySelector('.fb-highlight') as HTMLElement).style.width).toBe('400px');
    fireEvent.keyDown(window, { key: 'ArrowDown', code: 'ArrowDown' }); expect(document.querySelector('.fb-highlight')?.textContent).toContain('item-card');
    fireEvent.keyDown(window, { key: 'ArrowUp', code: 'ArrowUp' }); fireEvent.click(target); fireEvent.keyDown(window, { code: 'Enter' }); await screen.findByLabelText('Note');
    enterNote(); fireEvent.click(screen.getByRole('button', { name: 'Save' })); await sent();
    expect(payload().target.selector).toBe(selectorFor(section));
  });
  it('Section captures a card when there is no semantic ancestor', async () => {
    const click = vi.fn();
    render(<><div data-testid="card" style={{ boxShadow: '0 2px 4px black' }}><button type="button" onClick={click}>Card action</button></div><FeedbackWidget /></>);
    const card = screen.getByTestId('card');
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({ x: 50, y: 60, width: 240, height: 120 } as DOMRect);
    open(); fireEvent.click(screen.getByRole('button', { name: 'Section' })); fireEvent.click(screen.getByText('Card action')); fireEvent.click(screen.getByRole('button', { name: /Write note/ }));
    await screen.findByLabelText('Note'); enterNote(); fireEvent.click(screen.getByRole('button', { name: 'Save' })); await sent();
    expect(click).not.toHaveBeenCalled(); expect(payload()).toMatchObject({ mode: 'section', target: { selector: '[data-testid="card"]', tag: 'div', rect: { x: 50, y: 60, width: 240, height: 120 } } });
  });
  it('crops from one viewport screenshot at DPR and filters noscript and its own DOM', async () => {
    const { target } = app(); open(); fireEvent.click(screen.getByRole('button', { name: 'Element' })); fireEvent.click(target); fireEvent.keyDown(window, { code: 'Enter' }); await screen.findByLabelText('Note');
    expect(domToCanvas).toHaveBeenCalledOnce(); expect(optionsOf(0).node).toBe(document.documentElement);
    const options = optionsOf(0);
    expect(options).toMatchObject({ width: innerWidth, height: innerHeight, scale: 2 });
    expect(options.filter!(document.querySelector('[data-feedback-root]')!)).toBe(false);
    expect(options.filter!(document.createElement('noscript'))).toBe(false); expect(options.filter!(target)).toBe(true);
    expect(options.fetch?.requestInit?.credentials).toBe('same-origin');
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.anything(), 176, 136, 448, 168, 0, 0, 448, 168);
    expect(ctx.strokeRect).toHaveBeenCalledWith(200, 160, 400, 120); expect(ctx.lineWidth).toBe(6);
  });
  it('keeps original crop and context images distinct in the POST', async () => {
    const { target } = app();
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockReturnValueOnce('data:image/png;base64,cropped').mockReturnValueOnce('data:image/png;base64,context');
    open(); fireEvent.click(screen.getByRole('button', { name: 'Element' })); fireEvent.click(target); fireEvent.keyDown(window, { code: 'Enter' }); await screen.findByLabelText('Note');
    enterNote(); fireEvent.click(screen.getByRole('button', { name: 'Save' })); await sent();
    expect(payload()).toMatchObject({ image: 'data:image/png;base64,cropped', context_image: 'data:image/png;base64,context' });
  });
  it('Escape cancels an in-flight capture without reopening a note later', async () => {
    let finish: (canvas: HTMLCanvasElement) => void = () => {};
    captureCanvas.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    render(<FeedbackWidget />); open(); fireEvent.click(screen.getByRole('button', { name: 'Full page' }));
    expect(screen.getByText('Capturing…')).toBeTruthy(); fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    finish(document.createElement('canvas'));
    await vi.waitFor(() => expect(screen.getByLabelText('Feedback toolbar')).toBeTruthy());
    expect(screen.queryByLabelText('Note')).toBeNull(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('draws on a capture, returns to its note and sends original and annotated images', async () => {
    render(<FeedbackWidget />); await capturePage(); enterNote('Look here');
    fireEvent.click(screen.getByRole('button', { name: 'Draw on it' })); await screen.findByRole('dialog', { name: 'Mark up screenshot' });
    fireEvent.click(screen.getByRole('button', { name: 'box' }));
    const surface = screen.getByRole('img', { name: 'Screenshot drawing surface' });
    fireEvent.keyDown(surface, { key: ' ', code: 'Space' }); fireEvent.keyDown(surface, { key: 'ArrowRight', code: 'ArrowRight' }); fireEvent.keyDown(surface, { key: 'ArrowDown', code: 'ArrowDown' }); fireEvent.keyDown(surface, { key: ' ', code: 'Space' });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Undo' }).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' })); expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Undo' }).disabled).toBe(true);
    fireEvent.keyDown(surface, { key: ' ', code: 'Space' }); fireEvent.keyDown(surface, { key: 'ArrowRight', code: 'ArrowRight' }); fireEvent.keyDown(surface, { key: ' ', code: 'Space' });
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockReturnValue('data:image/png;base64,marked');
    fireEvent.click(screen.getByRole('button', { name: 'Use markup' })); await screen.findByLabelText('Note');
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Note' }).value).toBe('Look here');
    fireEvent.click(screen.getByRole('button', { name: 'Save' })); await sent();
    expect(payload()).toMatchObject({ image: PNG, annotated: 'data:image/png;base64,marked' });
  });
  it('omits annotated when the editor has no marks and Escape returns to the note', async () => {
    render(<FeedbackWidget />); await capturePage(); enterNote();
    fireEvent.click(screen.getByRole('button', { name: 'Draw on it' })); fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Note' }).value).toBe('Make this clearer');
    fireEvent.click(screen.getByRole('button', { name: 'Draw on it' })); fireEvent.click(screen.getByRole('button', { name: 'Use markup' })); await screen.findByLabelText('Note');
    fireEvent.click(screen.getByRole('button', { name: 'Save' })); await sent(); expect(payload().annotated).toBeUndefined();
  });
  it('Cancel discards the capture without posting', async () => {
    render(<FeedbackWidget />); await capturePage(); enterNote(); fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByLabelText('Feedback toolbar')).toBeTruthy(); expect(screen.queryByLabelText('Note')).toBeNull(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('opens the note on a capture failure and still sends the text, saying there is no picture', async () => {
    captureCanvas.mockRejectedValueOnce(new Error('CSS unsupported'));
    render(<FeedbackWidget />); open(); fireEvent.click(screen.getByRole('button', { name: 'Full page' }));
    expect((await screen.findByRole('status')).textContent).toContain('Screenshot capture failed');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Draw on it' }).disabled).toBe(true);
    enterNote('Still send this'); fireEvent.click(screen.getByRole('button', { name: 'Save' })); await sent();
    expect(payload().note).toContain('Still send this'); expect(payload().note).toContain('Screenshot capture failed');
    expect(payload().image).toMatch(/^data:image\/png;base64,/);
  });
  it('opens the note before the capture resolves, with the textarea focused, and Save queues at once and sends when the picture lands', async () => {
    let finish: (canvas: HTMLCanvasElement) => void = () => {};
    captureCanvas.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    render(<FeedbackWidget />); open(); fireEvent.click(screen.getByRole('button', { name: 'Full page' }));
    const note = screen.getByLabelText('Note');
    expect(document.activeElement).toBe(note); expect(screen.getByText('Capturing…')).toBeTruthy(); expect(screen.queryByAltText('Captured area')).toBeNull();
    enterNote('Typed while capturing'); fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByLabelText('Note')).toBeNull(); expect(screen.getByText('Queued')).toBeTruthy(); expect(screen.getByRole('button', { name: /Feedback.*1 sending/ })).toBeTruthy();
    await act(async () => { await Promise.resolve(); }); expect(fetchMock).not.toHaveBeenCalled();
    finish(document.createElement('canvas')); await sent();
    expect(payload()).toMatchObject({ note: 'Typed while capturing', image: PNG });
  });
  it('starts the capture when a region is drawn and reuses it on Enter, but retakes it if the selection changes', async () => {
    render(<FeedbackWidget />); open(); fireEvent.click(screen.getByRole('button', { name: 'Region' }));
    const surface = screen.getByRole('application'); surface.setPointerCapture = vi.fn();
    fireEvent.pointerDown(surface, { clientX: 20, clientY: 30, pointerId: 1 }); fireEvent.pointerMove(surface, { clientX: 120, clientY: 90, pointerId: 1 }); fireEvent.pointerUp(surface, { clientX: 120, clientY: 90, pointerId: 1 });
    await vi.waitFor(() => expect(domToCanvas).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /Write note/ })); await screen.findByLabelText('Note');
    expect(domToCanvas).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByLabelText('Note'), { code: 'Escape' });
    fireEvent.keyDown(window, { code: 'ArrowRight' }); fireEvent.click(screen.getByRole('button', { name: /Write note/ })); await screen.findByLabelText('Note');
    await vi.waitFor(() => expect(domToCanvas).toHaveBeenCalledTimes(2));
    expect(optionsOf(1).width).toBe(innerWidth);
  });
  it('never sends a stale warm-up capture after the selection is redone', async () => {
    const first = document.createElement('canvas'); first.width = 11; first.height = 11;
    let finish: (canvas: HTMLCanvasElement) => void = () => {};
    captureCanvas.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockImplementation(function (this: HTMLCanvasElement) { return this.width === 11 ? 'data:image/png;base64,STALE' : PNG; });
    render(<FeedbackWidget />); open(); fireEvent.click(screen.getByRole('button', { name: 'Region' }));
    const surface = screen.getByRole('application'); surface.setPointerCapture = vi.fn();
    fireEvent.pointerDown(surface, { clientX: 20, clientY: 30, pointerId: 1 }); fireEvent.pointerMove(surface, { clientX: 120, clientY: 90, pointerId: 1 }); fireEvent.pointerUp(surface, { clientX: 120, clientY: 90, pointerId: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    fireEvent.pointerDown(surface, { clientX: 200, clientY: 130, pointerId: 2 }); fireEvent.pointerMove(surface, { clientX: 300, clientY: 230, pointerId: 2 }); fireEvent.pointerUp(surface, { clientX: 300, clientY: 230, pointerId: 2 });
    fireEvent.click(screen.getByRole('button', { name: /Write note/ })); await screen.findByAltText('Captured area');
    finish(first); await act(async () => { await Promise.resolve(); });
    enterNote(); fireEvent.click(screen.getByRole('button', { name: 'Save' })); await sent();
    expect(payload().image).toBe(PNG); expect(payload().target.rect).toMatchObject({ x: 200, y: 130, width: 100, height: 100 });
  });
  it('lists status and the agent reply, with full expansion', async () => {
    fetchMock.mockResolvedValue(Response.json([{ id: '20261118-120000-abcd', created_at: '2026-11-18T12:00:00Z', url: 'http://local', mode: 'element', note_first_line: 'Spacing', status: 'seen', reply: 'Fixed it.\nThe card is easier to read.' }]));
    render(<FeedbackWidget />); open(); fireEvent.click(screen.getByRole('button', { name: 'My feedback' }));
    expect(await screen.findByText('seen')).toBeTruthy(); expect(screen.getByText('Reply: Fixed it.')).toBeTruthy(); expect(screen.getByText('Spacing')).toBeTruthy();
    fireEvent.click(screen.getByText('20261118-120000-abcd')); expect(screen.getByText(/The card is easier to read/)).toBeTruthy();
  });
});
it('snaps sections to semantic ancestors first, otherwise the nearest card', () => {
  const { container } = render(<><section><div style={{ border: '1px solid black' }}><button type="button">Semantic</button></div></section><div data-testid="card" style={{ backgroundColor: 'rgb(230, 230, 230)' }}><button type="button">Card</button></div></>);
  const semantic = screen.getByText('Semantic'), card = screen.getByTestId('card');
  vi.spyOn(semantic.parentElement!, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 200, height: 100 } as DOMRect);
  vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 200, height: 100 } as DOMRect);
  expect(sectionFor(semantic)).toBe(container.querySelector('section')); expect(sectionFor(screen.getByText('Card'))).toBe(card);
});
it('patches once, bounds logs, strips fetch queries, and never consumes response bodies', async () => {
  const response = new Response('stream', { status: 503 });
  const read = vi.spyOn(response, 'text'), clone = vi.spyOn(response, 'clone');
  fetchMock.mockResolvedValue(response);
  render(<FeedbackWidget />);
  const capture = installCapture(); expect(installCapture()).toBe(capture);
  const errorSpy = vi.spyOn(console, 'error'); // forwards through the installed capture
  for (let i = 0; i < 32; i++) console.error('x'.repeat(350), i);
  expect(errorSpy).toHaveBeenCalled();
  for (let i = 0; i < 22; i++) await fetch(`/broken?token=secret-${i}`, { method: 'PATCH' });
  fetchMock.mockRejectedValueOnce(new TypeError('Network failed'));
  await expect(fetch('/offline?secret=true')).rejects.toThrow('Network failed');
  const context = getContext();
  expect(context.console).toHaveLength(30); expect(context.console[0]!.message).toHaveLength(300);
  expect(context.failedFetches).toHaveLength(20);
  expect(context.failedFetches[0]).toMatchObject({ method: 'PATCH', url: `${location.origin}/broken`, status: 503 });
  expect(context.failedFetches.at(-1)).toMatchObject({ error: 'TypeError', url: `${location.origin}/offline` });
  expect(JSON.stringify(context.failedFetches)).not.toContain('secret');
  expect(read).not.toHaveBeenCalled(); expect(clone).not.toHaveBeenCalled();
});
it('selectors remain unique for repeated tags and component chains stop at six', () => {
  const { container } = render(<div><span>one</span><span>two</span></div>);
  const target = container.querySelectorAll('span')[1]!;
  const selector = selectorFor(target); expect(document.querySelectorAll(selector)).toHaveLength(1); expect(document.querySelector(selector)).toBe(target);
  Object.assign(target, { '__reactFiber$test': { type: { displayName: 'Card' }, return: { type: { name: 'CardGroup' } } } });
  // Prefer the real fiber already on React nodes; a detached element exercises a synthetic chain.
  const detached = document.createElement('div');
  let chain = { type: { name: 'Last' }, return: undefined as unknown };
  for (let i = 0; i < 8; i++) chain = { type: { name: `Name${i}` }, return: chain };
  Object.assign(detached, { '__reactFiber$test': chain }); expect(componentChain(detached)).toHaveLength(6);
});

it.each(['section', 'article', 'main', 'aside', 'nav', 'header', 'footer', 'dialog', 'form'])('Section recognizes the %s ancestor', tag => {
  const ancestor = document.createElement(tag), child = document.createElement('span');
  ancestor.append(child); document.body.append(ancestor); expect(sectionFor(child)).toBe(ancestor); ancestor.remove();
});
it.each(['region', 'dialog', 'main', 'complementary', 'navigation'])('Section recognizes role=%s', role => {
  const ancestor = document.createElement('div'), child = document.createElement('span');
  ancestor.setAttribute('role', role); ancestor.append(child); document.body.append(ancestor); expect(sectionFor(child)).toBe(ancestor); ancestor.remove();
});
it('Section ignores tiny decorated elements and prefers the nearest qualifying card', () => {
  const outer = document.createElement('div'), card = document.createElement('div'), tiny = document.createElement('button');
  outer.style.border = card.style.border = tiny.style.border = '1px solid black';
  card.append(tiny); outer.append(card); document.body.append(outer);
  vi.spyOn(outer, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 200 } as DOMRect);
  vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({ width: 120, height: 60 } as DOMRect);
  vi.spyOn(tiny, 'getBoundingClientRect').mockReturnValue({ width: 119, height: 60 } as DOMRect);
  expect(sectionFor(tiny)).toBe(card); outer.remove();
});

function dragRegion(from = [25, 35], to = [150, 120]) {
  const surface = screen.getByRole('application', { name: /Drag a region/ });
  surface.setPointerCapture = vi.fn();
  fireEvent.pointerDown(surface, { clientX: from[0], clientY: from[1], pointerId: 1 });
  fireEvent.pointerMove(surface, { clientX: to[0], clientY: to[1], pointerId: 1 });
  fireEvent.pointerUp(surface, { clientX: to[0], clientY: to[1], pointerId: 1 });
  return surface;
}
function regionStyle() { return (document.querySelector('.fb-region-box') as HTMLElement).style; }
describe('FB1-d selection and shortcuts', () => {
  it('moves and resizes a region precisely, captures on Enter, and restores selection and draft on Esc', async () => {
    render(<FeedbackWidget />); fireEvent.keyDown(window, { code: 'KeyR', key: '‰', altKey: true, shiftKey: true });
    dragRegion();
    expect(screen.queryByLabelText('Note')).toBeNull(); expect(domToCanvas).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { code: 'ArrowRight' }); expect(regionStyle().left).toBe('26px');
    fireEvent.keyDown(window, { code: 'ArrowDown', shiftKey: true }); expect(regionStyle().top).toBe('45px');
    fireEvent.keyDown(window, { code: 'ArrowRight', altKey: true }); expect(regionStyle().width).toBe('126px');
    fireEvent.keyDown(window, { code: 'ArrowDown', altKey: true, shiftKey: true }); expect(regionStyle().height).toBe('95px');
    const handle = screen.getByRole('button', { name: 'Resize se' }); handle.setPointerCapture = vi.fn();
    expect(screen.getAllByRole('button', { name: /Resize / })).toHaveLength(8);
    fireEvent.pointerDown(handle, { clientX: 152, clientY: 140, pointerId: 2 });
    fireEvent.pointerMove(handle, { clientX: 172, clientY: 170, pointerId: 2 });
    fireEvent.pointerUp(handle, { clientX: 172, clientY: 170, pointerId: 2 });
    expect(regionStyle().width).toBe('146px'); expect(regionStyle().height).toBe('125px');
    const selected = regionStyle().cssText;
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(window, { code: 'Enter' }); const note = await screen.findByLabelText('Note');
    // One warm-up per settled drag (the first drag and the handle drag), none for arrow keys or for Enter itself.
    expect(document.activeElement).toBe(note); expect(domToCanvas).toHaveBeenCalledTimes(2); enterNote('Keep this draft');
    fireEvent.keyDown(note, { code: 'Escape' });
    expect(screen.queryByLabelText('Note')).toBeNull(); expect(regionStyle().cssText).toBe(selected);
    fireEvent.click(screen.getByRole('button', { name: /Write note/ })); await screen.findByLabelText('Note');
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Note' }).value).toBe('Keep this draft');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Full page' })); await screen.findByLabelText('Note');
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Note' }).value).toBe('');
  });
  it('moves by dragging inside and replaces the box by dragging outside, with Redo and stepped Esc', () => {
    render(<FeedbackWidget />); open(); fireEvent.click(screen.getByRole('button', { name: 'Region' }));
    dragRegion(); dragRegion([50, 50], [70, 60]);
    expect(regionStyle().left).toBe('45px'); expect(regionStyle().top).toBe('45px'); expect(regionStyle().width).toBe('125px');
    dragRegion([200, 200], [250, 260]); expect(regionStyle().left).toBe('200px'); expect(regionStyle().width).toBe('50px');
    fireEvent.click(screen.getByRole('button', { name: 'Redo' })); expect(document.querySelector('.fb-region-box')).toBeNull();
    dragRegion(); fireEvent.keyDown(window, { code: 'Escape' });
    expect(document.querySelector('.fb-region-box')).toBeNull(); expect(screen.getByRole('dialog', { name: 'Select screenshot region' })).toBeTruthy();
    fireEvent.keyDown(window, { code: 'Escape' }); expect(screen.getByLabelText('Feedback toolbar')).toBeTruthy();
    fireEvent.keyDown(window, { code: 'Escape' }); expect(screen.queryByLabelText('Feedback toolbar')).toBeNull();
  });
  it.each([
    ['nw', 35, 45, 115, 75], ['n', 25, 45, 125, 75], ['ne', 25, 45, 135, 75], ['e', 25, 35, 135, 85],
    ['se', 25, 35, 135, 95], ['s', 25, 35, 125, 95], ['sw', 35, 35, 115, 95], ['w', 35, 35, 115, 85],
  ])('resizes the %s handle', (handleName, x, y, width, height) => {
    render(<FeedbackWidget />); fireEvent.keyDown(window, { code: 'KeyR', altKey: true, shiftKey: true }); dragRegion();
    const handle = screen.getByRole('button', { name: `Resize ${handleName}` }); handle.setPointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { clientX: 50, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 60, clientY: 60, pointerId: 1 });
    expect([regionStyle().left, regionStyle().top, regionStyle().width, regionStyle().height]).toEqual([`${x}px`, `${y}px`, `${width}px`, `${height}px`]);
  });
  it('locks an element, ignores hover while locked, navigates, blocks app keys, and Write note confirms', async () => {
    const { target, section, click } = app();
    const keys = vi.fn(); target.addEventListener('keydown', keys); target.addEventListener('keyup', keys);
    fireEvent.keyDown(window, { code: 'KeyE', altKey: true, shiftKey: true });
    fireEvent.click(target); expect(click).not.toHaveBeenCalled(); expect(screen.queryByLabelText('Note')).toBeNull();
    fireEvent.pointerMove(section); expect(document.querySelector('.fb-highlight')?.textContent).toContain('item-card');
    fireEvent.keyDown(target, { code: 'KeyX' }); fireEvent.keyUp(target, { code: 'KeyX' }); expect(keys).not.toHaveBeenCalled();
    fireEvent.keyDown(target, { code: 'ArrowUp' }); expect(document.querySelector('.fb-highlight')?.textContent).toContain('item-section');
    fireEvent.keyDown(target, { code: 'ArrowDown' }); expect(document.querySelector('.fb-highlight')?.textContent).toContain('item-card');
    fireEvent.keyDown(target, { code: 'ArrowUp' });
    fireEvent.click(screen.getByRole('button', { name: /Write note/ })); await screen.findByLabelText('Note'); enterNote();
    fireEvent.keyDown(screen.getByLabelText('Note'), { code: 'Escape' }); expect(document.querySelector('.fb-highlight')?.textContent).toContain('item-section');
    expect(document.querySelector('.fb-highlight')?.classList.contains('fb-locked')).toBe(true);
    fireEvent.keyDown(window, { code: 'Escape' }); expect(document.querySelector('.fb-highlight')).toBeNull();
    expect(screen.getByText(/Select an element/)).toBeTruthy();
  });
  it('moves a locked selection on a second click and Redo stays in the mode', () => {
    const { target, section } = app(); open(); fireEvent.click(screen.getByRole('button', { name: 'Element' }));
    fireEvent.click(target); fireEvent.click(section); expect(document.querySelector('.fb-highlight')?.textContent).toContain('item-section');
    fireEvent.click(screen.getByRole('button', { name: 'Redo' })); expect(document.querySelector('.fb-highlight')).toBeNull();
    expect(screen.getByText(/Select an element/)).toBeTruthy();
    fireEvent.pointerMove(target); expect(document.querySelector('.fb-highlight')?.classList.contains('fb-locked')).toBe(false);
  });
  it('Enter confirms a hovered target without locking first', async () => {
    const { target } = app(); open(); fireEvent.click(screen.getByRole('button', { name: 'Element' })); fireEvent.pointerMove(target);
    fireEvent.keyDown(window, { code: 'Enter' }); expect(await screen.findByLabelText('Note')).toBeTruthy();
  });
  it.each(['input', 'textarea', 'select', 'editable'])('ignores global and toolbar shortcuts in an app %s', tag => {
    render(<FeedbackWidget />);
    const input = document.createElement(tag === 'editable' ? 'div' : tag);
    if (tag === 'editable') input.setAttribute('contenteditable', 'true');
    document.body.append(input); input.focus();
    for (const code of ['KeyF', 'KeyR', 'KeyE', 'KeyS', 'KeyP', 'KeyL']) fireEvent.keyDown(input, { code, altKey: true, shiftKey: true });
    fireEvent.keyDown(window, { code: 'KeyR', altKey: true, shiftKey: true });
    expect(screen.queryByLabelText('Feedback toolbar')).toBeNull(); expect(screen.queryByRole('dialog')).toBeNull(); expect(domToCanvas).not.toHaveBeenCalled();
    open(); input.focus(); fireEvent.keyDown(input, { code: 'KeyR' }); expect(screen.getByLabelText('Feedback toolbar')).toBeTruthy(); input.remove();
  });
  it.each([['KeyR', 'Select screenshot region'], ['KeyE', 'Select an element'], ['KeyS', 'Select a section']])('global %s selects by code with a different key', (code, label) => {
    render(<FeedbackWidget />); fireEvent.keyDown(window, { code, key: 'special character', altKey: true, shiftKey: true });
    expect(screen.queryByText(new RegExp(label)) || screen.getByLabelText(label)).toBeTruthy();
  });
  it('toggles the toolbar globally, lists feedback globally and captures a full page globally', async () => {
    render(<FeedbackWidget />);
    fireEvent.keyDown(window, { code: 'KeyF', altKey: true, shiftKey: true }); expect(screen.getByLabelText('Feedback toolbar')).toBeTruthy();
    fireEvent.keyDown(window, { code: 'KeyF', altKey: true, shiftKey: true }); expect(screen.queryByLabelText('Feedback toolbar')).toBeNull();
    fetchMock.mockResolvedValueOnce(Response.json([]));
    fireEvent.keyDown(window, { code: 'KeyL', altKey: true, shiftKey: true }); expect(await screen.findByText('No feedback yet.')).toBeTruthy();
    fireEvent.keyDown(window, { code: 'KeyP', altKey: true, shiftKey: true }); expect(await screen.findByLabelText('Note')).toBeTruthy();
  });
  it('opens the cheat sheet with ? and Esc closes it before closing the toolbar', () => {
    render(<FeedbackWidget />); open(); fireEvent.keyDown(window, { code: 'Slash', key: '?', shiftKey: true });
    const help = screen.getByLabelText('Keyboard shortcuts');
    for (const text of ['Shift+F', 'Shift+R/E/S/P', 'Shift+L', '1–4', 'parent/child', '1 px', '10 px', 'Draw on it', 'P: pen', 'B: box', 'A: arrow', 'T: text', '1/2/3', 'Undo', 'Use markup']) expect(help.textContent).toContain(text);
    fireEvent.keyDown(window, { code: 'Escape' }); expect(screen.queryByLabelText('Keyboard shortcuts')).toBeNull(); expect(screen.getByLabelText('Feedback toolbar')).toBeTruthy();
  });
  it('supports note Alt+D, markup tool/colour keys, undo, Enter to apply, and Cmd+Enter to send', async () => {
    render(<FeedbackWidget />); await capturePage(); enterNote('Shortcuts');
    fireEvent.keyDown(screen.getByLabelText('Note'), { code: 'KeyD', key: '∂', altKey: true });
    expect(screen.getByRole('dialog', { name: 'Mark up screenshot' })).toBeTruthy();
    for (const [code, name] of [['KeyB', 'box'], ['KeyA', 'arrow'], ['KeyT', 'text'], ['KeyP', 'pen']]) {
      fireEvent.keyDown(window, { code }); expect(screen.getByRole('button', { name }).getAttribute('aria-pressed')).toBe('true');
    }
    for (const [code, name] of [['Digit1', 'Red'], ['Digit2', 'Teal'], ['Digit3', 'Yellow']]) {
      fireEvent.keyDown(window, { code }); expect(screen.getByRole('button', { name }).getAttribute('aria-pressed')).toBe('true');
    }
    const surface = screen.getByRole('img', { name: 'Screenshot drawing surface' });
    fireEvent.keyDown(surface, { code: 'Space' }); fireEvent.keyDown(surface, { code: 'ArrowRight' }); fireEvent.keyDown(surface, { code: 'Space' });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Undo' }).disabled).toBe(false);
    fireEvent.keyDown(window, { code: 'KeyZ', metaKey: true }); expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Undo' }).disabled).toBe(true);
    surface.focus();
    fireEvent.keyDown(window, { code: 'Enter' }); await screen.findByLabelText('Note');
    fireEvent.keyDown(screen.getByLabelText('Note'), { code: 'Enter', metaKey: true }); await sent(); expect(payload().note).toBe('Shortcuts');
  });
  it('leaves typing and native undo alone in markup text input', async () => {
    render(<FeedbackWidget />); await capturePage(); fireEvent.click(screen.getByRole('button', { name: 'Draw on it' }));
    fireEvent.keyDown(window, { code: 'KeyT' }); const input = screen.getByLabelText('Text to place'); input.focus();
    for (const code of ['KeyP', 'KeyB', 'KeyA', 'Digit1']) expect(fireEvent.keyDown(input, { code })).toBe(true);
    expect(fireEvent.keyDown(input, { code: 'KeyZ', ctrlKey: true })).toBe(true);
    expect(screen.getByRole('button', { name: 'text' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(input, { code: 'Escape' }); expect(screen.getByLabelText('Note')).toBeTruthy();
  });
});

it.each([['KeyR', 'Select screenshot region'], ['KeyE', 'Select an element'], ['KeyS', 'Select a section']])('toolbar %s selects a mode', (code, label) => {
  render(<FeedbackWidget />); open(); fireEvent.keyDown(window, { code });
  expect(screen.queryByText(new RegExp(label)) || screen.getByLabelText(label)).toBeTruthy();
});
it('toolbar P captures and toolbar L opens My feedback', async () => {
  render(<FeedbackWidget />); open(); fireEvent.keyDown(window, { code: 'KeyP' }); await screen.findByLabelText('Note');
  fireEvent.keyDown(screen.getByLabelText('Note'), { code: 'Escape' }); fetchMock.mockResolvedValueOnce(Response.json([]));
  fireEvent.keyDown(window, { code: 'KeyL' }); expect(await screen.findByText('No feedback yet.')).toBeTruthy();
});
it('keeps the selection toolbar on a narrow screen and flips above low selections', () => {
  vi.stubGlobal('innerWidth', 390); vi.stubGlobal('innerHeight', 600);
  render(<FeedbackWidget />); open(); fireEvent.click(screen.getByRole('button', { name: 'Region' })); dragRegion([280, 500], [380, 590]);
  const toolbar = screen.getByRole('toolbar', { name: 'Selection actions' });
  expect(Number.parseFloat(toolbar.style.top)).toBeLessThan(500);
  expect(Number.parseFloat(toolbar.style.left)).toBeGreaterThanOrEqual(8);
  expect(Number.parseFloat(toolbar.style.left) + 290).toBeLessThanOrEqual(390);
  dragRegion([280, 100], [380, 150]); expect(Number.parseFloat(screen.getByRole('toolbar', { name: 'Selection actions' }).style.top)).toBe(162);
});
it('keeps region moves and resizes inside the viewport and rejects empty drags', () => {
  render(<FeedbackWidget />); open(); fireEvent.click(screen.getByRole('button', { name: 'Region' }));
  dragRegion([25, 35], [25, 35]); expect(document.querySelector('.fb-region-box')).toBeNull();
  expect(screen.queryByRole('button', { name: /Write note/ })).toBeNull();
  dragRegion([5, 5], [15, 15]);
  fireEvent.keyDown(window, { code: 'ArrowLeft', shiftKey: true }); expect(regionStyle().left).toBe('0px');
  fireEvent.keyDown(window, { code: 'ArrowUp', shiftKey: true }); expect(regionStyle().top).toBe('0px');
  fireEvent.keyDown(window, { code: 'ArrowLeft', altKey: true, shiftKey: true }); expect(regionStyle().width).toBe('1px');
});
it('confirms hover from page focus and keeps app keyup suppressed for shortcut keys', async () => {
  const { target } = app(); const keys = vi.fn(); target.addEventListener('keyup', keys);
  screen.getByRole('button', { name: 'Feedback' }).focus();
  fireEvent.keyDown(document.activeElement!, { code: 'KeyE', altKey: true, shiftKey: true }); fireEvent.pointerMove(target);
  fireEvent.keyUp(target, { code: 'KeyE', altKey: true, shiftKey: true }); expect(keys).not.toHaveBeenCalled();
  target.focus();
  fireEvent.keyDown(document.activeElement!, { code: 'Enter' }); expect(await screen.findByLabelText('Note')).toBeTruthy();
});
it('uses platform-specific hints and ignores mode shortcuts in the note textarea', async () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  render(<FeedbackWidget />); await capturePage();
  expect(screen.getByRole('button', { name: 'Save' }).querySelector('kbd')?.textContent).toBe('⌘↵');
  expect(screen.getByRole('button', { name: 'Draw on it' }).querySelector('kbd')?.textContent).toBe('⌥D');
  for (const code of ['KeyR', 'KeyE', 'KeyS', 'KeyP', 'KeyF', 'KeyL']) fireEvent.keyDown(screen.getByLabelText('Note'), { code, altKey: true, shiftKey: true });
  expect(screen.getByLabelText('Note')).toBeTruthy(); expect(domToCanvas).toHaveBeenCalledOnce();
});
it('preserves the child path when a grown hover is locked', () => {
  const { target } = app(); open(); fireEvent.click(screen.getByRole('button', { name: 'Element' }));
  fireEvent.pointerMove(target); fireEvent.keyDown(window, { code: 'ArrowUp' }); fireEvent.click(target);
  fireEvent.keyDown(window, { code: 'ArrowDown' }); expect(document.querySelector('.fb-highlight')?.textContent).toContain('item-card');
});
it('blocks app keyup and clicks while the confirmed screenshot is pending', async () => {
  let finish: (canvas: HTMLCanvasElement) => void = () => {};
  captureCanvas.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const { target, click } = app(), keys = vi.fn(); target.addEventListener('keyup', keys); target.addEventListener('keydown', keys);
  fireEvent.keyDown(window, { code: 'KeyE', altKey: true, shiftKey: true }); fireEvent.click(target); fireEvent.keyDown(target, { code: 'Enter' });
  expect(screen.getByText('Capturing…')).toBeTruthy();
  fireEvent.keyUp(target, { code: 'Enter' }); fireEvent.keyDown(target, { code: 'KeyX' }); fireEvent.click(target);
  expect(keys).not.toHaveBeenCalled(); expect(click).not.toHaveBeenCalled();
  finish(document.createElement('canvas')); expect(await screen.findByLabelText('Note')).toBeTruthy(); expect(domToCanvas).toHaveBeenCalledOnce();
});

function expectShortcut(button: HTMLElement, key: string, aria: string) {
  const cap = button.querySelector('kbd');
  expect(cap?.textContent).toBe(key);
  expect(cap?.getAttribute('aria-hidden')).toBe('true');
  expect(button.getAttribute('aria-keyshortcuts')).toBe(aria);
}
function expectAllButtonsHaveShortcuts(root: HTMLElement) {
  for (const button of root.querySelectorAll('button')) {
    expect(button.querySelector('kbd')).toBeTruthy();
    expect(button.getAttribute('aria-keyshortcuts')).toBeTruthy();
    expect(button.querySelector('kbd')?.getAttribute('aria-hidden')).toBe('true');
  }
}
function stepHints() { return screen.getByRole('note', { name: 'Step shortcuts' }); }
describe('FB1-e visible shortcuts', () => {
  it.each(['MacIntel', 'Linux x86_64'])('shows toolbar, note and editor keycaps on %s', async platform => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
    const mac = platform === 'MacIntel', command = mac ? 'Meta' : 'Control';
    render(<FeedbackWidget />);
    expectShortcut(screen.getByRole('button', { name: 'Feedback' }), mac ? '⌥⇧F' : 'Alt+Shift+F', 'Alt+Shift+F');
    open();
    for (const [index, name] of ['Region', 'Element', 'Section', 'Full page'].entries()) {
      const key = ['R', 'E', 'S', 'P'][index]!;
      expectShortcut(screen.getByRole('button', { name }), key, `${key} ${index + 1}`);
    }
    expectShortcut(screen.getByRole('button', { name: 'My feedback' }), 'L', 'L');
    expectShortcut(screen.getByRole('button', { name: 'Shortcuts' }), '?', '?');
    fireEvent.click(screen.getByRole('button', { name: 'Full page' })); await screen.findByLabelText('Note');
    expectShortcut(screen.getByRole('button', { name: 'Save' }), mac ? '⌘↵' : 'Ctrl+↵', `${command}+Enter`);
    expectShortcut(screen.getByRole('button', { name: 'Draw on it' }), mac ? '⌥D' : 'Alt+D', 'Alt+D');
    expectShortcut(screen.getByRole('button', { name: 'Cancel' }), 'Esc', 'Escape');
    fireEvent.click(screen.getByRole('button', { name: 'Draw on it' }));
    const editor = screen.getByRole('dialog', { name: 'Mark up screenshot' });
    expectAllButtonsHaveShortcuts(editor);
    expectShortcut(screen.getByRole('button', { name: 'Undo' }), mac ? '⌘Z' : 'Ctrl+Z', `${command}+Z`);
    expectShortcut(screen.getByRole('button', { name: 'Use markup' }), '↵', 'Enter');
    expectShortcut(screen.getByRole('button', { name: 'Cancel' }), 'Esc', 'Escape');
    for (const text of ['Pen', 'Box', 'Arrow', 'Text', 'colour', 'undo', 'clear', 'done', 'cancel']) expect(stepHints().textContent).toContain(text);
  });
  it('switches Region hints after selection and gives selection actions keycaps', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    render(<FeedbackWidget hints="on" />); open(); fireEvent.click(screen.getByRole('button', { name: 'Region' }));
    expect(stepHints().textContent).toContain('Drag to select'); expect(stepHints().textContent).toContain('Esc cancel');
    expect(stepHints().textContent).not.toContain('write note');
    dragRegion();
    for (const text of ['↵ write note', 'arrows move', '⇧ arrows ×10', '⌥ arrows resize', 'drag to redraw', 'Esc cancel']) expect(stepHints().textContent).toContain(text);
    expectShortcut(screen.getByRole('button', { name: 'Write note' }), '↵', 'Enter');
    expectShortcut(screen.getByRole('button', { name: 'Cancel' }), 'Esc', 'Escape');
    fireEvent.click(screen.getByRole('button', { name: 'Redo' })); expect(stepHints().textContent).toContain('Drag to select');
  });
  it.each(['Region', 'Element', 'Section'])('shows no step banner by default while %s is active, so the page stays clear to capture', mode => {
    const { target } = app(); open(); fireEvent.click(screen.getByRole('button', { name: mode }));
    fireEvent.pointerMove(target);
    expect(screen.queryByRole('note', { name: 'Step shortcuts' })).toBeNull();
    expect(document.querySelector('.fb-step-hints')).toBeNull();
  });
  it('keeps the shortcuts one key away behind ? even with the banner off', () => {
    render(<FeedbackWidget />); open();
    fireEvent.click(screen.getByRole('button', { name: 'Shortcuts' }));
    expect(screen.getByLabelText('Keyboard shortcuts').textContent).toContain('Selection:');
  });
  it.each(['Element', 'Section'])('switches %s hints from hovering to locked', mode => {
    const { target } = app('on'); open(); fireEvent.click(screen.getByRole('button', { name: mode }));
    fireEvent.pointerMove(target);
    for (const text of ['Click to select', '↑ parent', '↓ child', '↵ select and write', 'Esc cancel']) expect(stepHints().textContent).toContain(text);
    fireEvent.click(target);
    expect(stepHints().textContent).toContain('↵ write note'); expect(stepHints().textContent).toContain('click another to change');
    expect(stepHints().textContent).not.toContain('select and write');
    fireEvent.click(screen.getByRole('button', { name: 'Redo' })); expect(stepHints().textContent).toContain('Click to select');
  });
  it('hides keyboard-only hints for coarse pointers and keeps touch actions', async () => {
    const media = window.matchMedia('(pointer: coarse)');
    vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ ...media, media: query, matches: query === '(pointer: coarse)', addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const { target } = app('on'); open(); fireEvent.click(screen.getByRole('button', { name: 'Region' }));
    expect(stepHints().textContent).toContain('Drag to select'); expect(stepHints().querySelector('kbd')).toBeNull();
    dragRegion(); expect(stepHints().textContent).toContain('Tap Write note'); expect(stepHints().textContent).toContain('Drag to redraw');
    expect(stepHints().textContent).not.toMatch(/arrows|Esc|×10/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); fireEvent.click(screen.getByRole('button', { name: 'Element' }));
    expect(stepHints().textContent).toContain('Tap to select'); fireEvent.click(target);
    expect(stepHints().textContent).toContain('Tap another to change'); expect(stepHints().textContent).not.toMatch(/parent|child|Esc/);
    fireEvent.click(screen.getByRole('button', { name: 'Write note' })); await screen.findByLabelText('Note');
    fireEvent.click(screen.getByRole('button', { name: 'Draw on it' }));
    expect(stepHints().textContent).toContain('Draw on the image'); expect(stepHints().querySelector('kbd')).toBeNull();
  });
  it('shows the first-run tip once, dismissing on the next action and remembering across mounts', () => {
    const tip = 'Tip: press ? any time to see every shortcut';
    const first = render(<StrictMode><FeedbackWidget /></StrictMode>); open(); expect(screen.getByText(tip)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Shortcuts' })); expect(screen.queryByText(tip)).toBeNull();
    first.unmount(); render(<FeedbackWidget />); open(); expect(screen.queryByText(tip)).toBeNull();
  });
  it('dismisses the tip on keyboard actions and tolerates unavailable localStorage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Unavailable'); });
    render(<FeedbackWidget />); open(); expect(screen.getByText(/Tip: press/)).toBeTruthy();
    fireEvent.keyDown(window, { code: 'Slash', key: '?', shiftKey: true }); expect(screen.queryByText(/Tip: press/)).toBeNull();
    expect(screen.getByLabelText('Keyboard shortcuts')).toBeTruthy();
  });
  it('clears markup with the displayed Delete shortcut', async () => {
    render(<FeedbackWidget />); await capturePage(); fireEvent.click(screen.getByRole('button', { name: 'Draw on it' }));
    const surface = screen.getByRole('img', { name: 'Screenshot drawing surface' });
    fireEvent.keyDown(surface, { code: 'Space' }); fireEvent.keyDown(surface, { code: 'Space' });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Undo' }).disabled).toBe(false);
    fireEvent.keyDown(window, { code: 'Delete' }); expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Undo' }).disabled).toBe(true);
  });
});
it('keeps Write note above the hint bar on a 390px viewport', () => {
  vi.stubGlobal('innerWidth', 390); vi.stubGlobal('innerHeight', 600);
  render(<FeedbackWidget hints="on" />); open(); fireEvent.click(screen.getByRole('button', { name: 'Region' }));
  vi.spyOn(stepHints(), 'getBoundingClientRect').mockReturnValue({ top: 420, height: 100 } as DOMRect);
  dragRegion([200, 350], [380, 390]);
  const toolbar = screen.getByRole('toolbar', { name: 'Selection actions' });
  expect(Number.parseFloat(toolbar.style.top) + 52).toBeLessThan(420);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Write note' }).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
  expect(stepHints().textContent).toContain('Drag to select');
});

async function tabTo(user: ReturnType<typeof userEvent.setup>, control: HTMLElement) {
  for (let count = 0; document.activeElement !== control && count < 20; count++) await user.tab();
  expect(document.activeElement).toBe(control);
}
async function drawWithKeyboard(user: ReturnType<typeof userEvent.setup>) {
  render(<FeedbackWidget />); await capturePage(); enterNote('Keyboard markup');
  fireEvent.click(screen.getByRole('button', { name: 'Draw on it' }));
  screen.getByRole('img', { name: 'Screenshot drawing surface' }).focus();
  await user.keyboard('[Space][ArrowRight][Space]');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Undo' }).disabled).toBe(false);
}
describe('FB1-f focused controls', () => {
  it.each(['Element', 'Section'])('Tabs to %s pick-hint Cancel and Enter cancels without capturing', async mode => {
    const user = userEvent.setup(); const { target } = app(); open();
    fireEvent.click(screen.getByRole('button', { name: mode })); fireEvent.pointerMove(target);
    target.focus(); await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Cancel/ }));
    await user.keyboard('[Enter]');
    expect(screen.getByLabelText('Feedback toolbar')).toBeTruthy();
    expect(screen.queryByLabelText('Note')).toBeNull(); expect(domToCanvas).not.toHaveBeenCalled();
  });
  it.each(['[Enter]', '[Space]'])('%s on Clear clears marks and leaves the editor open', async key => {
    const user = userEvent.setup(); await drawWithKeyboard(user);
    await tabTo(user, screen.getByRole('button', { name: /Clear/ })); await user.keyboard(key);
    expect(screen.getByRole('dialog', { name: 'Mark up screenshot' })).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Undo' }).disabled).toBe(true);
    await tabTo(user, screen.getByRole('button', { name: 'Use markup' })); await user.keyboard('[Enter]');
    await screen.findByLabelText('Note'); fireEvent.click(screen.getByRole('button', { name: 'Save' })); await sent();
    expect(payload().annotated).toBeUndefined();
  });
  it('Enter on Cancel throws the drawing away', async () => {
    const user = userEvent.setup(); await drawWithKeyboard(user);
    await tabTo(user, screen.getByRole('button', { name: 'Cancel' })); await user.keyboard('[Enter]');
    await screen.findByLabelText('Note'); fireEvent.click(screen.getByRole('button', { name: 'Save' })); await sent();
    expect(payload().annotated).toBeUndefined();
  });
  it('Enter on Undo or a colour button activates that control', async () => {
    const user = userEvent.setup(); await drawWithKeyboard(user);
    await tabTo(user, screen.getByRole('button', { name: 'Teal' })); await user.keyboard('[Enter]');
    expect(screen.getByRole('button', { name: 'Teal' }).getAttribute('aria-pressed')).toBe('true');
    await tabTo(user, screen.getByRole('button', { name: 'Undo' })); await user.keyboard('[Enter]');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Undo' }).disabled).toBe(true);
    expect(screen.getByRole('dialog', { name: 'Mark up screenshot' })).toBeTruthy();
  });
  it('Enter in the text input places text and keeps the editor open', async () => {
    const user = userEvent.setup(); render(<FeedbackWidget />); await capturePage();
    fireEvent.click(screen.getByRole('button', { name: 'Draw on it' }));
    fireEvent.click(screen.getByRole('button', { name: 'text' }));
    const input = screen.getByLabelText('Text to place'); input.focus(); await user.type(input, 'Label');
    await user.keyboard('[Enter]');
    expect(screen.getByRole('dialog', { name: 'Mark up screenshot' })).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Undo' }).disabled).toBe(false);
    expect(ctx.fillText).toHaveBeenCalledWith('Label', 20, 20);
  });
  it('Enter on the drawing surface still applies markup', async () => {
    const user = userEvent.setup(); await drawWithKeyboard(user); await user.keyboard('[Enter]');
    expect(await screen.findByLabelText('Note')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' })); await sent();
    expect(payload().annotated).toBe(PNG);
  });
});

function highlightText() { return document.querySelector('.fb-highlight')?.textContent ?? ''; }
describe('FB2 focus model', () => {
  it('Region by mouse: the surface takes focus, a drag focuses Write note, Enter opens the note, and Esc steps focus back', async () => {
    const user = userEvent.setup(); render(<FeedbackWidget />);
    await user.click(screen.getByRole('button', { name: 'Feedback' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Region' }));
    await user.click(screen.getByRole('button', { name: 'Region' }));
    const surface = screen.getByRole('application', { name: /Drag a region/ });
    expect(document.activeElement).toBe(surface);
    await user.keyboard('[Enter]'); expect(screen.queryByLabelText('Note')).toBeNull(); expect(domToCanvas).not.toHaveBeenCalled();
    dragRegion();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Write note' }));
    await user.keyboard('[Enter]');
    const note = await screen.findByLabelText('Note'); expect(document.activeElement).toBe(note); expect(domToCanvas).toHaveBeenCalledOnce();
    await user.keyboard('[Escape]');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Write note' }));
    await user.keyboard('[Enter]'); expect(document.activeElement).toBe(await screen.findByLabelText('Note'));
    await user.keyboard('[Escape][Escape]');
    expect(document.querySelector('.fb-region-box')).toBeNull(); expect(document.activeElement).toBe(screen.getByRole('application', { name: /Drag a region/ }));
    await user.keyboard('[Escape]'); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Region' }));
    await user.keyboard('[Escape]'); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Feedback' }));
  });
  it('Region Tab order cycles the selection actions, never the resize handles', async () => {
    const user = userEvent.setup(); render(<FeedbackWidget />); open(); fireEvent.click(screen.getByRole('button', { name: 'Region' })); dragRegion();
    const visited: string[] = [];
    for (let i = 0; i < 4; i++) { await user.tab(); visited.push(document.activeElement?.textContent?.split(' ')[0] ?? ''); }
    expect(visited).toEqual(['Redo', 'Cancel', 'Write', 'Redo']);
    await user.tab({ shift: true }); await user.tab({ shift: true }); expect(document.activeElement?.textContent).toContain('Cancel');
    expect([...document.querySelectorAll('.fb-region-handle')].every(handle => handle.getAttribute('tabindex') === '-1')).toBe(true);
  });
  it('Element by mouse: the picker takes focus, a click focuses Write note, arrows still work, Enter opens the note and Esc steps focus back', async () => {
    const user = userEvent.setup(); const { target, click, pointer } = app();
    await user.click(screen.getByRole('button', { name: 'Feedback' })); await user.click(screen.getByRole('button', { name: 'Element' }));
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Select an element' }));
    await user.click(target);
    expect(click).not.toHaveBeenCalled(); expect(pointer).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Write note' }));
    await user.keyboard('[ArrowUp]'); expect(highlightText()).toContain('item-section');
    await user.keyboard('[ArrowDown]'); expect(highlightText()).toContain('item-card');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Write note' }));
    await user.keyboard('[Enter]');
    expect(document.activeElement).toBe(await screen.findByLabelText('Note'));
    await user.keyboard('[Escape]');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Write note' })); expect(document.querySelector('.fb-locked')).toBeTruthy();
    await user.keyboard('[Escape]'); expect(document.querySelector('.fb-locked')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Select an element' }));
    await user.keyboard('[Escape]'); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Element' }));
    await user.keyboard('[Escape]'); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Feedback' }));
    expect(click).not.toHaveBeenCalled();
  });
  it.each(['Element', 'Section'])('%s: with the picker focused, hover then Enter selects and opens the note', async mode => {
    const user = userEvent.setup(); const { target, click } = app();
    await user.click(screen.getByRole('button', { name: 'Feedback' })); await user.click(screen.getByRole('button', { name: mode }));
    await user.hover(target);
    expect(document.activeElement).toBe(screen.getByRole('region', { name: `Select ${mode === 'Element' ? 'an element' : 'a section'}` }));
    await user.keyboard('[Enter]'); expect(document.activeElement).toBe(await screen.findByLabelText('Note'));
    enterNote(); await user.click(screen.getByRole('button', { name: 'Save' })); await sent();
    expect(payload().target.selector).toBe(mode === 'Element' ? '[data-testid="item-card"]' : '[data-testid="item-section"]'); expect(click).not.toHaveBeenCalled();
  });
  it('Redo by mouse returns focus to the picker, and Tab from a page control prefers Write note over Cancel', async () => {
    const user = userEvent.setup(); const { target, section } = app(); open(); fireEvent.click(screen.getByRole('button', { name: 'Element' }));
    await user.click(target); await user.click(screen.getByRole('button', { name: 'Redo' }));
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Select an element' }));
    await user.click(section); act(() => target.focus()); await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Write note' }));
  });
  it('a global shortcut from a focused page control keeps focus there, outlines it, and Enter selects it', async () => {
    const user = userEvent.setup(); const { target, click } = app(); act(() => target.focus());
    fireEvent.keyDown(target, { code: 'KeyE', key: '´', altKey: true, shiftKey: true });
    expect(document.activeElement).toBe(target); expect(highlightText()).toContain('item-card');
    await user.keyboard('[Enter]'); await screen.findByLabelText('Note'); expect(click).not.toHaveBeenCalled();
  });
  it('after Save, focus returns to the control focused before the widget opened', async () => {
    const user = userEvent.setup(); render(<><button type="button">Opener</button><FeedbackWidget /></>);
    const opener = screen.getByRole('button', { name: 'Opener' }); act(() => opener.focus());
    fireEvent.keyDown(opener, { code: 'KeyR', altKey: true, shiftKey: true }); dragRegion();
    await user.keyboard('[Enter]'); await screen.findByLabelText('Note'); enterNote();
    await user.keyboard('{Meta>}[Enter]{/Meta}'); await sent();
    expect(document.activeElement).toBe(opener);
  });
  it('after Save, focus goes to the launcher when the opener is gone', async () => {
    const user = userEvent.setup(); render(<FeedbackWidget />);
    const opener = document.createElement('button'); opener.textContent = 'Gone'; document.body.append(opener); act(() => opener.focus());
    fireEvent.keyDown(opener, { code: 'KeyP', altKey: true, shiftKey: true }); await screen.findByLabelText('Note'); enterNote();
    opener.remove();
    await user.click(screen.getByRole('button', { name: 'Save' })); await sent();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Feedback' }));
  });
  it('Full page opens the note focused, and Esc returns to the toolbar on Full page', async () => {
    const user = userEvent.setup(); render(<FeedbackWidget />);
    await user.click(screen.getByRole('button', { name: 'Feedback' })); await user.click(screen.getByRole('button', { name: 'Full page' }));
    expect(document.activeElement).toBe(await screen.findByLabelText('Note'));
    await user.keyboard('[Escape]'); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Full page' }));
  });
  it('Save closes the note at once and focus returns to the launcher even while the send fails', async () => {
    fetchMock.mockResolvedValue(new Response('down', { status: 502 }));
    const user = userEvent.setup(); render(<FeedbackWidget />); await capturePage(); enterNote('Keep');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByLabelText('Note')).toBeNull(); expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Feedback/ }));
  });
  it('the editor opens on its drawing surface, and a mouse click on a tool returns focus there', async () => {
    const user = userEvent.setup(); render(<FeedbackWidget />); await capturePage();
    await user.click(screen.getByRole('button', { name: 'Draw on it' }));
    const surface = screen.getByRole('img', { name: 'Screenshot drawing surface' });
    expect(document.activeElement).toBe(surface);
    await user.click(screen.getByRole('button', { name: 'box' })); expect(document.activeElement).toBe(surface);
    await user.keyboard('[Enter]'); expect(document.activeElement).toBe(await screen.findByLabelText('Note'));
  });
  it('the first-run tip stays through pointerdown, so the first click on a mode button lands', () => {
    render(<FeedbackWidget />); open(); expect(screen.getByText(/Tip: press/)).toBeTruthy();
    const region = screen.getByRole('button', { name: 'Region' });
    fireEvent.pointerDown(region); fireEvent.mouseDown(region); expect(screen.getByText(/Tip: press/)).toBeTruthy();
    fireEvent.pointerUp(region); fireEvent.mouseUp(region); fireEvent.click(region);
    expect(screen.queryByText(/Tip: press/)).toBeNull(); expect(screen.getByRole('dialog', { name: 'Select screenshot region' })).toBeTruthy();
  });
});
