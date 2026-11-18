import { cleanup, render, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { documentClone, viewportClone } from './screenshot-layout';
import { cropRect, captureViewport } from './screenshot';
import { domToCanvas } from 'modern-screenshot';
import { MarkupEditor } from './MarkupEditor';
import FeedbackWidget from './FeedbackWidget';
vi.mock('modern-screenshot', () => ({ domToCanvas: vi.fn(), domToPng: vi.fn(), createContext: vi.fn(async (node: Node, options: object) => ({ node, ...options, requests: new Map(), fontCssTexts: new Map() })) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('undoes document restoration once, preserves nested scroll, and anchors fixed content', () => {
  const container = document.createElement('div');
  container.innerHTML = '<div id="nested-scroll"><span id="inner">content</span></div><button id="floating" style="position:fixed">Float</button><header id="sticky" style="position:sticky">Header</header>';
  document.body.append(container);
  const fixed = document.getElementById('floating')!;
  vi.spyOn(fixed, 'getBoundingClientRect').mockReturnValue({ x: 100, y: 50, width: 60, height: 30 } as DOMRect);
  vi.spyOn(document, 'scrollingElement', 'get').mockReturnValue(document.documentElement);
  document.documentElement.scrollTop = 300;
  const layout = viewportClone({ x: 0, y: 300 });
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  const body = clone.querySelector('body')!; body.style.transform = 'translate(0px, -300px)';
  clone.querySelector<HTMLElement>('#inner')!.style.transform = 'translate(0px, -75px)';
  layout(clone);
  expect(body.style.transform).not.toContain('-300');
  expect(clone.querySelector<HTMLElement>('#inner')!.style.transform).toContain('-75');
  const floating = clone.querySelector<HTMLElement>('#floating')!;
  expect(floating.parentElement).toBe(clone); expect(floating.style.top).toBe('350px'); expect(floating.style.left).toBe('100px');
  expect(clone.querySelector<HTMLElement>('#sticky')!.style.visibility).toBe('hidden');
  document.documentElement.scrollTop = 0; container.remove();
});
it('clamps padded crops to every viewport edge', () => {
  expect(cropRect({ x: -20, y: -30, width: 100, height: 90 }, 390, 844)).toEqual({ x: 0, y: 0, width: 92, height: 72 });
  expect(cropRect({ x: 350, y: 800, width: 100, height: 100 }, 390, 844)).toEqual({ x: 338, y: 788, width: 52, height: 56 });
});
it('cuts partially off-screen captures from the scaled viewport screenshot', async () => {
  vi.stubGlobal('devicePixelRatio', 3); vi.stubGlobal('innerWidth', 390); vi.stubGlobal('innerHeight', 844);
  const source = document.createElement('canvas'); vi.mocked(domToCanvas).mockResolvedValue(source);
  const ctx = { drawImage: vi.fn(), strokeRect: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,crop');
  const capture = await captureViewport({ x: -20, y: 800, width: 100, height: 100 });
  expect(ctx.drawImage).toHaveBeenCalledWith(source, 0, 2364, 276, 168, 0, 0, 276, 168);
  expect(capture.shot).toMatchObject({ width: 276, height: 168, origin: { x: 0, y: 788 } });
  vi.unstubAllGlobals();
});
it('shares fetched images, stylesheets and fonts between captures in one page session', async () => {
  vi.mocked(domToCanvas).mockImplementation(async () => document.createElement('canvas'));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn(), strokeRect: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,x');
  await captureViewport({ x: 0, y: 0, width: 50, height: 50 }); await captureViewport({ x: 10, y: 10, width: 50, height: 50 });
  const [first, second] = vi.mocked(domToCanvas).mock.calls.map(call => call[0] as unknown as { requests: Map<string, unknown>; fontCssTexts: Map<string, string> });
  expect(second!.requests).toBe(first!.requests); expect(second!.fontCssTexts).toBe(first!.fontCssTexts);
});
it('leaves app Escape handlers alone while closed', () => {
  const appEscape = vi.fn(); render(<FeedbackWidget />);
  window.addEventListener('keydown', appEscape);
  fireEvent.keyDown(window, { key: 'Escape' }); expect(appEscape).toHaveBeenCalledOnce();
  window.removeEventListener('keydown', appEscape);
});
it('finishes pointer marks without reading a cleared mutable ref', async () => {
  const ctx = Object.fromEntries(['drawImage', 'beginPath', 'moveTo', 'lineTo', 'stroke'].map(name => [name, vi.fn()]));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,marked');
  vi.spyOn(HTMLImageElement.prototype, 'decode').mockResolvedValue();
  const save = vi.fn();
  render(<MarkupEditor shot={{ url: 'data:image/png;base64,original', width: 300, height: 200, origin: { x: 0, y: 0 } }} onSave={save} onCancel={() => {}} />);
  const canvas = screen.getByRole<HTMLCanvasElement>('img', { name: 'Screenshot drawing surface' });
  canvas.setPointerCapture = vi.fn();
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 300, height: 200 } as DOMRect);
  fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 80, clientY: 60 });
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 90, clientY: 70 });
  fireEvent.click(screen.getByRole('button', { name: 'Use markup' }));
  await vi.waitFor(() => expect(save).toHaveBeenCalledWith('data:image/png;base64,marked'));
  expect(ctx.lineTo).toHaveBeenCalledWith(90, 70);
});

it('keeps the standalone widget reachable inside native app dialogs', async () => {
  const view = render(<><dialog aria-label="App modal">App content</dialog><FeedbackWidget /></>);
  const dialog = screen.getByLabelText('App modal');
  const widget = document.querySelector('[data-feedback-root]')!;
  const home = widget.parentElement;
  dialog.setAttribute('open', '');
  await waitFor(() => expect(widget.parentElement).toBe(dialog));
  fireEvent.click(screen.getByRole('button', { name: 'Feedback', hidden: true }));
  expect(screen.getByLabelText('Feedback toolbar')).toBeTruthy();
  dialog.removeAttribute('open');
  await waitFor(() => expect(widget.parentElement).toBe(home));
  dialog.setAttribute('open', '');
  await waitFor(() => expect(widget.parentElement).toBe(dialog));
  expect(() => view.unmount()).not.toThrow();
});
it('preserves overflow clipping when capturing a sticky heading', () => {
  const pane = document.createElement('div'); pane.id = 'clip-pane'; pane.style.overflow = 'auto';
  const header = document.createElement('header'); header.id = 'clip-header'; header.style.position = 'sticky'; pane.append(header); document.body.append(pane);
  vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue({ x: 10, y: 100, left: 10, top: 100, right: 210, bottom: 300, width: 200, height: 200 } as DOMRect);
  vi.spyOn(header, 'getBoundingClientRect').mockReturnValue({ x: 10, y: 80, left: 10, top: 80, right: 210, bottom: 130, width: 200, height: 50 } as DOMRect);
  const adjust = viewportClone({ x: 0, y: 0 });
  const clone = document.documentElement.cloneNode(true) as HTMLElement; adjust(clone);
  const overlay = [...clone.querySelectorAll<HTMLElement>('#clip-header')].at(-1)!;
  expect(overlay.style.clipPath).toBe('inset(20px 0px 0px 0px)'); pane.remove();
});

it('full page starts at the document origin even when filtered children precede content', () => {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = '<noscript>Hidden fallback</noscript><div id="full-content">Page</div>';
  document.body.append(wrapper);
  vi.spyOn(document, 'scrollingElement', 'get').mockReturnValue(document.body);
  const reset = documentClone();
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  clone.querySelector('noscript')?.remove();
  const content = clone.querySelector<HTMLElement>('#full-content')!;
  content.style.transform = 'translate(0px, -200px)';
  // The scroller translates its immediate children, not their descendants.
  const clonedWrapper = content.parentElement!; clonedWrapper.style.transform = 'translate(0px, -300px)';
  reset(clone);
  expect(clonedWrapper.style.transform).not.toContain('-300');
  expect(content.style.transform).toContain('-200'); wrapper.remove();
});
