import { cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FeedbackWidget, { positionOf } from './FeedbackWidget.js';

afterEach(() => { cleanup(); for (const n of document.querySelectorAll('[data-react-feedback-root], [data-react-feedback]')) n.remove(); vi.resetModules(); });
const root = () => document.querySelector<HTMLElement>('[data-feedback-root]')!;

describe('launcher position', () => {
  it('defaults to the bottom-left corner, as before', () => {
    render(<FeedbackWidget />);
    expect(root().dataset.position).toBe('bottom-left');
    expect(root().classList.contains('fb-right')).toBe(false);
  });
  it('takes bottom-right', () => {
    render(<FeedbackWidget position="bottom-right" />);
    expect(root().dataset.position).toBe('bottom-right');
    expect(root().classList.contains('fb-right')).toBe(true);
    expect(root().querySelector('.fb-launchers')).not.toBeNull();
  });
  it('falls back to bottom-left for anything else', () => {
    expect(positionOf('top-left')).toBe('bottom-left');
    expect(positionOf(undefined)).toBe('bottom-left');
    expect(positionOf('bottom-right')).toBe('bottom-right');
  });
  it('moves the launcher, the panels and the toast to the right edge in the stylesheet, and keeps the phone sheet full width', () => {
    const css = readFileSync('src/widget/feedback.css', 'utf8');
    expect(css).toMatch(/\.fb-right \.fb-launchers, \.fb-right \.fb-panel, \.fb-right \.fb-toast \{ left: auto; right: 12px; \}/);
    expect(css).toMatch(/\.fb-note, \.fb-right \.fb-note \{ left: 0; right: auto;/);
  });
  async function embed(position?: string, hints?: string) {
    const script = document.createElement('script');
    if (position !== undefined) script.dataset.position = position;
    if (hints !== undefined) script.dataset.hints = hints;
    Object.defineProperty(document, 'currentScript', { configurable: true, get: () => script });
    try { vi.resetModules(); await import('./embed.js'); await vi.waitFor(() => expect(root()).not.toBeNull()); }
    finally { Reflect.deleteProperty(document, 'currentScript'); }
    return root().dataset.position;
  }
  it('the embed script reads data-position', async () => {
    expect(await embed('bottom-right')).toBe('bottom-right');
  });
  it('the embed script defaults to bottom-left without it', async () => {
    expect(await embed()).toBe('bottom-left');
  });
});

describe('step banner option', () => {
  const open = () => { const b = document.querySelector<HTMLButtonElement>('.fb-launcher')!; b.click(); };
  it('the embed script shows the banner only with data-hints="on"', async () => {
    for (const [value, expected] of [[undefined, false], ['off', false], ['on', true]] as const) {
      cleanup(); for (const n of document.querySelectorAll('[data-react-feedback-root]')) n.remove();
      const script = document.createElement('script'); if (value) script.dataset.hints = value;
      Object.defineProperty(document, 'currentScript', { configurable: true, get: () => script });
      vi.resetModules(); await import('./embed.js');
      await vi.waitFor(() => expect(document.querySelector('.fb-launcher')).not.toBeNull());
      Reflect.deleteProperty(document, 'currentScript');
      open();
      await vi.waitFor(() => expect(document.querySelector('[data-choice="region"]')).not.toBeNull());
      document.querySelector<HTMLButtonElement>('[data-choice="region"]')!.click();
      await vi.waitFor(() => expect(document.querySelector('.fb-region-surface')).not.toBeNull());
      expect(document.querySelector('.fb-step-hints') !== null).toBe(expected);
    }
  });
});
