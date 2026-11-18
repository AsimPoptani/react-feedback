import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import FeedbackWidget from './FeedbackWidget.js';
import { MARGIN, loadPos, nudge, resolve, snap, storageKey } from './launcherPosition.js';

const SIZE = { vw: 1000, vh: 800, w: 120, h: 40 };
const launcher = () => document.querySelector<HTMLButtonElement>('.fb-launcher')!;
const holder = () => document.querySelector<HTMLElement>('.fb-launchers')!;

describe('launcher position maths', () => {
  it('clamps inside the viewport with a margin', () => {
    expect(resolve({ x: -50, y: -50 }, SIZE)).toEqual({ x: MARGIN, y: MARGIN });
    expect(resolve({ x: 5000, y: 5000 }, SIZE)).toEqual({ x: 1000 - 120 - MARGIN, y: 800 - 40 - MARGIN });
  });
  it('snaps to the nearest edge and keeps the other coordinate', () => {
    expect(snap(30, 300, SIZE)).toMatchObject({ ex: 'l', y: 300 });
    expect(snap(850, 300, SIZE)).toMatchObject({ ex: 'r', y: 300 });
    expect(snap(400, 20, SIZE)).toMatchObject({ ey: 't', x: 400 });
    expect(snap(400, 760, SIZE)).toMatchObject({ ey: 'b', x: 400 });
  });
  it('a pinned edge follows the viewport; a free axis is re-clamped', () => {
    const pos = snap(850, 300, SIZE);
    expect(resolve(pos, { ...SIZE, vw: 600 }).x).toBe(600 - 120 - MARGIN);
    expect(resolve({ x: 100, y: 700 }, { ...SIZE, vh: 400 }).y).toBe(400 - 40 - MARGIN);
  });
  it('nudge moves along one axis and stays clamped', () => {
    expect(nudge({ x: 100, y: 100 }, 'ArrowRight', SIZE)).toMatchObject({ x: 110, y: 100 });
    expect(nudge({ x: 100, y: 100 }, 'ArrowUp', SIZE)).toMatchObject({ x: 100, y: 90 });
    expect(nudge({ x: 14, y: 100 }, 'ArrowLeft', SIZE).x).toBe(MARGIN);
    expect(nudge({ x: 0, y: 0, ex: 'l' }, 'ArrowRight', SIZE)).toMatchObject({ x: 22 }); // leaves the edge pin on that axis
    expect('ex' in nudge({ x: 0, y: 0, ex: 'l' }, 'ArrowRight', SIZE)).toBe(false);
  });
});

describe('dragging the launcher', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    // happy-dom has no layout: report the launcher where its inline position (or the bottom-left default) puts it.
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (!this.classList.contains('fb-launcher')) return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} } as DOMRect;
      const h = this.closest<HTMLElement>('.fb-launchers')!;
      const left = parseFloat(h.style.left) || 12, top = parseFloat(h.style.top) || 748;
      return { x: left, y: top, left, top, right: left + 120, bottom: top + 40, width: 120, height: 40, toJSON() {} } as DOMRect;
    };
  });
  afterEach(() => { cleanup(); localStorage.clear(); });
  const pointer = (type: string, x: number, y: number) => fireEvent(launcher(), new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
  const drag = (to: [number, number], from: [number, number] = [50, 760]) => act(() => { pointer('pointerdown', ...from); pointer('pointermove', ...to); pointer('pointerup', ...to); });

  it('a press that moves under the threshold is still a click', () => {
    render(<FeedbackWidget />);
    act(() => { pointer('pointerdown', 50, 760); pointer('pointermove', 52, 762); pointer('pointerup', 52, 762); });
    fireEvent.click(launcher());
    expect(launcher().getAttribute('aria-expanded')).toBe('true');
    expect(holder().style.left).toBe('');
    expect(localStorage.getItem(storageKey())).toBeNull();
  });
  it('a real drag moves it, snaps to the nearest edge, does not open, and is remembered', () => {
    render(<FeedbackWidget />);
    drag([900, 300]); // moved by (+850, -460) from (12, 748) -> (862, 288): nearest edge is the right
    fireEvent.click(launcher()); // the click a browser fires after a drag is ignored
    expect(launcher().getAttribute('aria-expanded')).toBe('false');
    expect(holder().style.left).toBe(`${1000 - 120 - MARGIN}px`);
    expect(holder().style.top).toBe('288px');
    expect(document.querySelector('.fb-root')!.classList.contains('fb-right')).toBe(true);
    expect(loadPos()).toMatchObject({ ex: 'r', y: 288 });
  });
  it('keeps the drag inside the viewport', () => {
    render(<FeedbackWidget />);
    drag([-500, -500]);
    expect(parseFloat(holder().style.left)).toBeGreaterThanOrEqual(MARGIN);
    expect(parseFloat(holder().style.top)).toBeGreaterThanOrEqual(MARGIN);
  });
  it('restores a saved position on the next mount, and ignores junk', () => {
    localStorage.setItem(storageKey(), JSON.stringify({ x: 400, y: 20, ey: 't' }));
    render(<FeedbackWidget />);
    expect(holder().style.top).toBe(`${MARGIN}px`);
    cleanup(); localStorage.setItem(storageKey(), '{"x":"a"}');
    render(<FeedbackWidget />);
    expect(holder().style.left).toBe('');
  });
  it('Alt+arrows nudge a focused launcher; plain arrows do nothing', () => {
    render(<FeedbackWidget />);
    fireEvent.keyDown(launcher(), { key: 'ArrowUp' });
    expect(holder().style.top).toBe('');
    fireEvent.keyDown(launcher(), { key: 'ArrowUp', altKey: true });
    expect(holder().style.top).toBe('738px');
    fireEvent.keyDown(launcher(), { key: 'ArrowRight', altKey: true });
    expect(holder().style.left).toBe('22px');
    expect(loadPos()).toMatchObject({ x: 22, y: 738 });
  });
  it('re-clamps when the window shrinks', () => {
    localStorage.setItem(storageKey(), JSON.stringify({ x: 862, y: 288, ex: 'r' }));
    render(<FeedbackWidget />);
    expect(holder().style.left).toBe('868px');
    act(() => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 }); window.dispatchEvent(new Event('resize')); });
    expect(holder().style.left).toBe(`${500 - 120 - MARGIN}px`);
  });
  it('the toolbar follows the launcher and Reset position puts it back', () => {
    render(<FeedbackWidget />);
    drag([100, 300], [50, 760]);
    fireEvent.click(launcher()); // swallowed
    act(() => { fireEvent.keyDown(document, { key: 'F', code: 'KeyF', altKey: true, shiftKey: true }); });
    const toolbar = document.querySelector<HTMLElement>('.fb-capture-toolbar')!;
    expect(toolbar).not.toBeNull();
    expect(toolbar.style.top).toBe('336px'); // launcher is at y=288 (+40 high, +8 gap) in the upper half, so the toolbar sits below it
    fireEvent.click(document.querySelector('[data-choice="reset-position"]')!);
    expect(holder().style.left).toBe('');
    expect(localStorage.getItem(storageKey())).toBeNull();
  });
});
