import { readFileSync } from 'node:fs';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FeedbackWidget from './FeedbackWidget.js';

const css = readFileSync('src/widget/feedback.css', 'utf8');

describe('phone launcher', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  it('keeps the desktop edge rule, and tucks a shorter launcher that hides while scrolling', () => {
    expect(css).toMatch(/\.fb-right \.fb-launchers, \.fb-right \.fb-panel, \.fb-right \.fb-toast \{ left: auto; right: 12px; \}/);
    expect(css).toContain('--rf-launcher-offset');
    expect(css).toMatch(/@media \(max-width: 480px\)[\s\S]*\.fb-scrolling \.fb-launchers \{ transform: translateY\(100%\)/);
    expect(css).toMatch(/@media \(max-width: 480px\)[\s\S]*min-height: 40px/);
  });
  it('adds fb-scrolling while a narrow page scrolls', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('480'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }));
    render(<FeedbackWidget />);
    const root = document.querySelector('[data-feedback-root]') as HTMLElement;
    document.dispatchEvent(new Event('scroll'));
    expect(root.classList.contains('fb-scrolling')).toBe(true);
  });
});
