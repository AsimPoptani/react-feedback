// The parts of the replay screens that need no DOM, shared with the tests.

// 83000 -> "1:23", 3725000 -> "1:02:05", under a second -> "0:00".
export function durationText(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const two = n => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

// A recording's one-line summary: "1:23 · 4 clicks · v2".
export function replaySummary(meta) {
  const clicks = meta.clicks === 1 ? '1 click' : `${meta.clicks} clicks`;
  return [durationText(meta.duration_ms), clicks, ...(meta.version ? [`v${meta.version}`] : [])].join(' · ');
}

// Click points are fractions of the page width at the width it was recorded (x / w, y / w). At a width of `width` pixels they sit at x * width, y * width.
// Points outside the page are dropped. `height` (optional) also drops points below it.
export function heatPositions(clicks, width, height = Infinity) {
  const out = [];
  for (const c of clicks || []) {
    const left = c.x * width, top = c.y * width;
    if (!Number.isFinite(left) || !Number.isFinite(top) || left < 0 || top < 0 || left > width || top > height) continue;
    out.push({ left: Math.round(left), top: Math.round(top) });
  }
  return out;
}

export const newSessionId = () => {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
};
