import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import type { Rect } from './types.js';
import { focusInto, useModalFocus } from './focus.js';
import { nativeButtonActivation } from './shortcuts.js';
import { Keycap } from './Keycap.js';
import { StepHints } from './StepHints.js';
import { SelectionToolbar } from './SelectionToolbar.js';
const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const directions: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const clamp = (value: number, max: number, min = 0) => Math.max(min, Math.min(max, value));
interface Drag { x: number; y: number; rect: Rect; kind: string }
function dragged(drag: Drag, x: number, y: number): Rect {
  const rect = drag.rect, dx = x - drag.x, dy = y - drag.y;
  if (drag.kind === 'move') return { ...rect, x: clamp(rect.x + dx, innerWidth - rect.width), y: clamp(rect.y + dy, innerHeight - rect.height) };
  if (drag.kind === 'draw') return { x: Math.min(drag.x, x), y: Math.min(drag.y, y), width: Math.abs(dx), height: Math.abs(dy) };
  const left = drag.kind.includes('w') ? clamp(rect.x + dx, rect.x + rect.width - 1) : rect.x;
  const top = drag.kind.includes('n') ? clamp(rect.y + dy, rect.y + rect.height - 1) : rect.y;
  const right = drag.kind.includes('e') ? clamp(rect.x + rect.width + dx, innerWidth, left + 1) : rect.x + rect.width;
  const bottom = drag.kind.includes('s') ? clamp(rect.y + rect.height + dy, innerHeight, top + 1) : rect.y + rect.height;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
function moveWithKey(rect: Rect | null, event: KeyboardEvent): Rect {
  const area = rect ?? { x: 20, y: 100, width: Math.min(250, innerWidth - 40), height: Math.min(200, innerHeight - 120) };
  const delta = directions[event.code]!, amount = event.shiftKey ? 10 : 1, dx = delta[0] * amount, dy = delta[1] * amount;
  return event.altKey ? { ...area, width: clamp(area.width + dx, innerWidth - area.x, 1), height: clamp(area.height + dy, innerHeight - area.y, 1) } : { ...area, x: clamp(area.x + dx, innerWidth - area.width), y: clamp(area.y + dy, innerHeight - area.height) };
}
export function RegionPicker({ rect, onChange, onSettle, onCapture, onCancel }: { rect: Rect | null; onChange: (rect: Rect | null) => void; onSettle: (rect: Rect) => void; onCapture: (rect: Rect) => void; onCancel: () => void }) {
  const start = useRef<Drag | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  // Bumped when a pointer drag ends, so Write note takes focus even if its toolbar was already showing.
  const [settled, setSettled] = useState(0);
  const selected = !!rect && rect.width > 0 && rect.height > 0;
  useModalFocus(root);
  // No selection: focus the surface, where Enter does nothing and arrows draw. A selection's toolbar focuses Write note.
  useEffect(() => { if (!selected) focusInto(surface.current); }, [selected]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (nativeButtonActivation(event)) return;
      if (event.code === 'Enter') { event.preventDefault(); event.stopImmediatePropagation(); if (rect) onCapture(rect); return; }
      const delta = directions[event.code]; if (!delta) return;
      event.preventDefault(); event.stopImmediatePropagation();
      onChange(moveWithKey(rect, event));
    };
    window.addEventListener('keydown', keyboard, true);
    return () => window.removeEventListener('keydown', keyboard, true);
  }, [rect, onChange, onCapture]);
  function begin(event: PointerEvent) {
    const target = event.target as HTMLElement;
    if (!target.closest('.fb-region-surface, .fb-region-handle')) return;
    event.preventDefault(); target.setPointerCapture(event.pointerId);
    const x = clamp(event.clientX, innerWidth), y = clamp(event.clientY, innerHeight);
    const inside = rect && x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
    start.current = { x, y, rect: rect ?? { x, y, width: 0, height: 0 }, kind: target.dataset.handle ?? (inside ? 'move' : 'draw') };
    if (start.current.kind === 'draw') onChange(null);
  }
  function move(event: PointerEvent) {
    if (!start.current) return null;
    const area = dragged(start.current, clamp(event.clientX, innerWidth), clamp(event.clientY, innerHeight));
    const valid = area.width > 0 && area.height > 0;
    onChange(valid ? area : null);
    return valid ? area : null;
  }
  function end(event: PointerEvent) {
    if (!start.current) return;
    const area = move(event); start.current = null; setSettled(count => count + 1);
    if (area) onSettle(area);
  }
  return <div ref={root} className="fb-region" role="dialog" aria-modal="true" aria-label="Select screenshot region"
    onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={() => { start.current = null; }}>
    {/* Not a button, so Enter here confirms the selection instead of pressing a no-op control. Focused by script,
        not a Tab stop: arrows and Enter work from any control in this dialog. */}
    <div ref={surface} className="fb-region-surface" role="application" tabIndex={-1} aria-label="Drag a region. Arrows move; Shift speeds up; Alt resizes. Enter writes a note." />
    {rect && <><div className="fb-region-box" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
      {/* Pointer-only handles; the keyboard resizes with Alt+arrows, so they stay out of the Tab order. */}
      {handles.map(handle => <button key={handle} type="button" tabIndex={-1} className={`fb-region-handle fb-handle-${handle}`} data-handle={handle} aria-label={`Resize ${handle}`} />)}
    </div>
    {selected && <SelectionToolbar rect={rect} focusKey={settled} onConfirm={() => onCapture(rect)} onRedo={() => onChange(null)} onCancel={onCancel} />}</>}
    {!rect && <div className="fb-region-actions"><button type="button" onClick={onCancel} aria-keyshortcuts="Escape">Cancel <Keycap>Esc</Keycap></button></div>}
    <StepHints step="region" locked={!!rect} />
  </div>;
}
