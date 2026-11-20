// The replay screens' pure parts: durations, summaries and where heatmap dots land.
import { describe, expect, it } from 'vitest';
import { durationText, heatPositions, newSessionId, replaySummary } from '../inbox/replays.js';

describe('replays', () => {
  it('writes durations as m:ss and h:mm:ss', () => {
    expect(durationText(0)).toBe('0:00');
    expect(durationText(999)).toBe('0:00');
    expect(durationText(83_000)).toBe('1:23');
    expect(durationText(3_725_000)).toBe('1:02:05');
    expect(durationText(-5)).toBe('0:00');
    expect(durationText(Number.NaN)).toBe('0:00');
  });
  it('summarises a recording in one line', () => {
    expect(replaySummary({ duration_ms: 83_000, clicks: 4, version: 2 })).toBe('1:23 · 4 clicks · v2');
    expect(replaySummary({ duration_ms: 1000, clicks: 1, version: null })).toBe('0:01 · 1 click');
  });
  it('scales click points to the width the page is shown at and drops points outside it', () => {
    const clicks = [{ x: 0.25, y: 0.1 }, { x: 0.5, y: 0.5 }, { x: 1.4, y: 0.1 }, { x: -0.1, y: 0.1 }, { x: 0.5, y: 3 }];
    expect(heatPositions(clicks, 400, 300)).toEqual([{ left: 100, top: 40 }, { left: 200, top: 200 }]);
    expect(heatPositions(clicks, 800)).toEqual([{ left: 200, top: 80 }, { left: 400, top: 400 }, { left: 400, top: 2400 }]);
    expect(heatPositions(undefined as never, 400)).toEqual([]);
  });
  it('makes session ids the server accepts', () => {
    const id = newSessionId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(newSessionId()).not.toBe(id);
  });
});
