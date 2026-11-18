import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import { canvasFor, loadImage } from './screenshot';
import type { Shot } from './types';
import { isInput, keyboardTarget, nativeButtonActivation, modifiers, keyLabel } from './shortcuts';
import { Keycap } from './Keycap';
import { StepHints } from './StepHints';
import { focusInto, useModalFocus } from './focus';
type Tool = 'pen' | 'box' | 'arrow' | 'text';
interface Point { x: number; y: number }
interface Mark { tool: Tool; color: string; points: Point[]; text: string }
const toolKeys: Record<string, Tool> = { KeyP: 'pen', KeyB: 'box', KeyA: 'arrow', KeyT: 'text' };
const COLORS = ['#e52e58', '#00796f', '#ffce38'];
function markupAction(event: globalThis.KeyboardEvent) {
  if (event.code === 'Escape') return 'cancel';
  if (nativeButtonActivation(event)) return;
  if (isInput(keyboardTarget(event))) return;
  if (event.code === 'Enter') return 'export';
  if (event.code === 'Delete') return 'clear';
  if (event.code === 'KeyZ' && (event.metaKey || event.ctrlKey)) return 'undo';
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (toolKeys[event.code]) return event.code;
  const index = ['Digit1', 'Digit2', 'Digit3'].indexOf(event.code);
  if (index >= 0) return String(index);
}
function drawMark(ctx: CanvasRenderingContext2D, mark: Mark) {
  const start = mark.points[0]; const end = mark.points.at(-1);
  if (!start || !end) return;
  ctx.strokeStyle = mark.color; ctx.fillStyle = mark.color; ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.beginPath();
  if (mark.tool === 'text') { ctx.font = 'bold 20px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(mark.text, start.x, start.y); return; }
  if (mark.tool === 'box') { ctx.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y); return; }
  ctx.moveTo(start.x, start.y);
  for (const point of mark.points) ctx.lineTo(point.x, point.y);
  ctx.stroke();
  if (mark.tool !== 'arrow') return;
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  ctx.beginPath(); ctx.moveTo(end.x, end.y);
  ctx.lineTo(end.x - 15 * Math.cos(angle - 0.5), end.y - 15 * Math.sin(angle - 0.5));
  ctx.moveTo(end.x, end.y); ctx.lineTo(end.x - 15 * Math.cos(angle + 0.5), end.y - 15 * Math.sin(angle + 0.5)); ctx.stroke();
}
async function render(shot: Shot, marks: Mark[]) {
  const { canvas, ctx } = canvasFor(shot.width, shot.height);
  ctx.drawImage(await loadImage(shot.url), 0, 0);
  for (const mark of marks) drawMark(ctx, mark);
  return canvas;
}
export function MarkupEditor({ shot, onSave, onCancel }: { shot: Shot; onSave: (url: string | null) => void; onCancel: () => void }) {
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState(COLORS[0]!);
  const [text, setText] = useState('');
  const [marks, setMarks] = useState<Mark[]>([]);
  const [preview, setPreview] = useState<Mark | null>(null);
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState<Point>({ x: 20, y: 20 });
  const current = useRef<Mark | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const root = useRef<HTMLDivElement>(null);
  useModalFocus(root);
  // Home is the drawing surface, where Enter is Done, as the hint bar says. A pointer click on a tool,
  // colour, Undo or Clear returns focus there too; keyboard activation keeps focus on the button.
  useEffect(() => { focusInto(canvasRef.current); }, []);
  const toCanvas = (event: MouseEvent) => { if (event.detail > 0) focusInto(canvasRef.current); };
  useEffect(() => {
    let cancelled = false;
    render(shot, preview ? [...marks, preview] : marks).then(canvas => {
      if (!cancelled) canvasRef.current?.getContext('2d')?.drawImage(canvas, 0, 0);
    }).catch(() => { if (!cancelled) setError('Could not draw this screenshot. You can still send the original.'); });
    return () => { cancelled = true; };
  }, [shot, marks, preview]);
  function begin(point: Point) {
    current.current = { tool, color, text, points: [point] };
    setPreview(current.current);
  }
  function move(point: Point) {
    const mark = current.current;
    if (!mark) return;
    const points = mark.tool === 'pen' ? [...mark.points, point] : [mark.points[0]!, point];
    current.current = { ...mark, points }; setPreview(current.current);
  }
  function finish() {
    const mark = current.current;
    if (mark) setMarks(previous => [...previous, mark]);
    current.current = null; setPreview(null);
  }
  function point(event: PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * shot.width / rect.width, y: (event.clientY - rect.top) * shot.height / rect.height };
  }
  function clear() { setMarks([]); current.current = null; setPreview(null); }
  function commitText(event: KeyboardEvent<HTMLInputElement>) {
    if (event.code !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (!text.trim()) return;
    begin(cursor); finish(); setText(''); canvasRef.current?.focus();
  }
  function exportMarkup() {
    const complete = current.current ? [...marks, current.current] : marks;
    render(shot, complete).then(canvas => onSave(complete.length ? canvas.toDataURL('image/png') : null)).catch(() => setError('Could not export markup. You can still send the original.'));
  }
  useEffect(() => {
    const shortcuts = (event: globalThis.KeyboardEvent) => {
      const command = markupAction(event);
      if (!command) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const actions: Record<string, () => void> = { cancel: onCancel, export: exportMarkup, undo: () => setMarks(previous => previous.slice(0, -1)), clear };
      if (actions[command]) actions[command]();
      else if (toolKeys[command]) setTool(toolKeys[command]);
      else setColor(COLORS[Number(command)]!);
    };
    window.addEventListener('keydown', shortcuts, true);
    return () => window.removeEventListener('keydown', shortcuts, true);
  });
  function keyboard(event: KeyboardEvent) {
    if (event.code === 'Space') { event.preventDefault(); if (current.current) finish(); else begin(cursor); return; }
    const directions: Record<string, Point> = { ArrowLeft: { x: -10, y: 0 }, ArrowRight: { x: 10, y: 0 }, ArrowUp: { x: 0, y: -10 }, ArrowDown: { x: 0, y: 10 } };
    const direction = directions[event.code];
    if (!direction) return;
    event.preventDefault();
    const next = { x: Math.max(0, Math.min(shot.width, cursor.x + direction.x)), y: Math.max(0, Math.min(shot.height, cursor.y + direction.y)) };
    setCursor(next); move(next);
  }
  return <div ref={root} className="fb-editor" role="dialog" aria-modal="true" aria-label="Mark up screenshot">
    <div className="fb-toolbar">
      <strong>Mark up screenshot</strong>
      {(['pen', 'box', 'arrow', 'text'] as Tool[]).map(value => <button type="button" key={value} aria-label={value} aria-keyshortcuts={{ pen: 'P', box: 'B', arrow: 'A', text: 'T' }[value]} aria-pressed={tool === value} onClick={event => { setTool(value); if (value !== 'text') toCanvas(event); }}>{value} <Keycap>{{ pen: 'P', box: 'B', arrow: 'A', text: 'T' }[value]}</Keycap></button>)}
      {COLORS.map((value, index) => <button type="button" key={value} aria-label={['Red', 'Teal', 'Yellow'][index]} aria-keyshortcuts={String(index + 1)} aria-pressed={color === value} onClick={event => { setColor(value); toCanvas(event); }} style={{ borderBottom: `5px solid ${value}` }}>{['Red', 'Teal', 'Yellow'][index]} <Keycap>{index + 1}</Keycap></button>)}
      {tool === 'text' && <input aria-label="Text to place" value={text} onChange={event => setText(event.target.value)} onKeyDown={commitText} placeholder="Type, then place on image" />}
      <button type="button" disabled={!marks.length} aria-label="Undo" aria-keyshortcuts={`${modifiers().commandKey}+Z`} onClick={event => { setMarks(previous => previous.slice(0, -1)); toCanvas(event); }}>Undo <Keycap>{keyLabel('Command', 'Z')}</Keycap></button>
      <button type="button" onClick={event => { clear(); toCanvas(event); }} aria-keyshortcuts="Delete">Clear <Keycap>Del</Keycap></button>
      <button type="button" onClick={onCancel} aria-label="Cancel" aria-keyshortcuts="Escape">Cancel <Keycap>Esc</Keycap></button>
      <button type="button" onClick={exportMarkup} aria-label="Use markup" aria-keyshortcuts="Enter">Done <Keycap>↵</Keycap></button>
    </div>
    <p className="fb-drawing-help">Draw with mouse, pen or touch. <span className="fb-keyboard-only"><Keycap>arrows</Keycap> move cursor · <Keycap>Space</Keycap> start/finish mark · Position: {cursor.x}, {cursor.y}.</span></p>
    <StepHints step="editor" />
    {error && <p role="alert">{error}</p>}
    <div className="fb-canvas-area"><canvas ref={canvasRef} width={shot.width} height={shot.height} role="img" aria-label="Screenshot drawing surface" tabIndex={0} onKeyDown={keyboard}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); begin(point(event)); }}
      onPointerMove={event => { if (current.current) move(point(event)); }}
      onPointerUp={event => { if (current.current) { move(point(event)); finish(); } }}
      onPointerCancel={() => { current.current = null; setPreview(null); }} /></div>
  </div>;
}
