import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

export const MARGIN = 12;
export const DRAG_THRESHOLD = 5; // px of movement before a press counts as a drag instead of a click
export const NUDGE = 10;

/** A saved position. `x` and `y` are the launcher's top-left corner in viewport px; `ex` / `ey` pin it to an edge so it stays there when the window resizes. */
export interface Pos { x: number; y: number; ex?: 'l' | 'r'; ey?: 't' | 'b' }
export interface Size { vw: number; vh: number; w: number; h: number }
export interface Placed { x: number; y: number }

const clampTo = (v: number, max: number) => Math.min(Math.max(MARGIN, v), Math.max(MARGIN, max));

/** Turn a saved position into on-screen coordinates, kept inside the viewport. */
export function resolve(pos: Pos, { vw, vh, w, h }: Size): Placed {
  const maxX = vw - w - MARGIN, maxY = vh - h - MARGIN;
  const x = pos.ex === 'l' ? MARGIN : pos.ex === 'r' ? maxX : pos.x;
  const y = pos.ey === 't' ? MARGIN : pos.ey === 'b' ? maxY : pos.y;
  return { x: clampTo(x, maxX), y: clampTo(y, maxY) };
}

/** On release: clamp, then pin to the nearest edge (the other coordinate stays where it was let go). */
export function snap(x: number, y: number, size: Size): Pos {
  const { vw, vh, w, h } = size;
  const p = resolve({ x, y }, size);
  const dist = { l: p.x - MARGIN, r: vw - w - MARGIN - p.x, t: p.y - MARGIN, b: vh - h - MARGIN - p.y };
  const nearest = (Object.keys(dist) as (keyof typeof dist)[]).reduce((a, b) => (dist[b] < dist[a] ? b : a));
  return nearest === 'l' || nearest === 'r' ? { x: p.x, y: p.y, ex: nearest } : { x: p.x, y: p.y, ey: nearest };
}

/** Alt+arrow: move by `step` px along one axis, free of any edge pin on that axis. */
export function nudge(pos: Pos, key: string, size: Size, step = NUDGE): Pos {
  const at = resolve(pos, size);
  const next: Pos = { x: at.x, y: at.y, ...(pos.ex ? { ex: pos.ex } : {}), ...(pos.ey ? { ey: pos.ey } : {}) };
  if (key === 'ArrowLeft' || key === 'ArrowRight') { next.x = at.x + (key === 'ArrowLeft' ? -step : step); delete next.ex; }
  else { next.y = at.y + (key === 'ArrowUp' ? -step : step); delete next.ey; }
  const c = resolve({ x: next.x, y: next.y }, size);
  return { ...next, x: c.x, y: c.y };
}

export const storageKey = () => `react-feedback:position:${location.origin}`;
export function loadPos(): Pos | null {
  try {
    const v = JSON.parse(localStorage.getItem(storageKey()) || 'null');
    if (!v || typeof v.x !== 'number' || typeof v.y !== 'number' || !Number.isFinite(v.x) || !Number.isFinite(v.y)) return null;
    return { x: v.x, y: v.y, ...(v.ex === 'l' || v.ex === 'r' ? { ex: v.ex } : {}), ...(v.ey === 't' || v.ey === 'b' ? { ey: v.ey } : {}) };
  } catch { return null; }
}
function savePos(pos: Pos | null) {
  try { if (pos) localStorage.setItem(storageKey(), JSON.stringify(pos)); else localStorage.removeItem(storageKey()); } catch { /* storage may be blocked */ }
}

/** Dragging, edge snapping, keyboard nudging and a remembered position for the launcher (the toolbar drags it too). */
export function useLauncherPosition(ref: RefObject<HTMLElement | null>) {
  const [pos, setPos] = useState<Pos | null>(loadPos);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const justDragged = useRef(false);
  const size = useCallback((): Size => {
    const r = ref.current?.getBoundingClientRect();
    return { vw: window.innerWidth, vh: window.innerHeight, w: r?.width ?? 0, h: r?.height ?? 0 };
  }, [ref]);
  const current = useCallback((): Placed => {
    const r = ref.current?.getBoundingClientRect();
    return { x: r?.left ?? MARGIN, y: r?.top ?? MARGIN };
  }, [ref]);
  const commit = useCallback((next: Pos | null) => { setPos(next); savePos(next); }, []);

  // Place (and re-place, after a resize, a rotation or a change of the launcher's own size) inside the viewport.
  const place = useCallback(() => {
    if (drag.current?.moved) return;
    if (!pos) { setPlaced(null); return; }
    const p = resolve(pos, size());
    setPlaced(prev => (prev && prev.x === p.x && prev.y === p.y ? prev : p));
  }, [pos, size]);
  useLayoutEffect(place);
  useEffect(() => { window.addEventListener('resize', place); return () => window.removeEventListener('resize', place); }, [place]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    const at = current();
    drag.current = { id: event.pointerId, sx: event.clientX, sy: event.clientY, ox: at.x, oy: at.y, moved: false };
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* capture is optional */ }
  }, [current]);
  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current; if (!d || d.id !== event.pointerId) return;
    const dx = event.clientX - d.sx, dy = event.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!d.moved) { d.moved = true; setDragging(true); }
    setPlaced(resolve({ x: d.ox + dx, y: d.oy + dy }, size()));
  }, [size]);
  const end = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current; if (!d || d.id !== event.pointerId) return;
    drag.current = null;
    try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch { /* not captured */ }
    if (!d.moved) return; // a plain click: let it through
    setDragging(false);
    justDragged.current = true; setTimeout(() => { justDragged.current = false; }, 0); // swallow the click that follows a drag
    const next = snap(d.ox + (event.clientX - d.sx), d.oy + (event.clientY - d.sy), size());
    commit(next); setPlaced(resolve(next, size()));
  }, [commit, size]);
  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const base = pos ?? { x: current().x, y: current().y };
    const next = nudge(base, event.key, size(), event.shiftKey ? NUDGE * 5 : NUDGE);
    commit(next); setPlaced(resolve(next, size()));
  }, [commit, current, pos, size]);
  const reset = useCallback(() => { commit(null); setPlaced(null); }, [commit]);
  /** True once, right after a drag ends, so the launcher's click handler can ignore it. */
  const wasDrag = useCallback(() => justDragged.current, []);

  const side: 'left' | 'right' | null = placed ? (placed.x + size().w / 2 > window.innerWidth / 2 ? 'right' : 'left') : null;
  const handlers = { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end };
  return { custom: pos !== null, placed, side, dragging, handlers, onKeyDown, reset, wasDrag, size };
}
