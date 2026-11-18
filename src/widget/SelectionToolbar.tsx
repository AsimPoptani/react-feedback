import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Keycap } from './Keycap.js';
import { focusInto } from './focus.js';
import type { Rect } from './types.js';
interface Props { rect: Rect; focusKey?: number; onConfirm: () => void; onRedo: () => void; onCancel: () => void }
/** A selection exists: Write note takes focus (on mount and whenever focusKey changes), so Enter presses it. */
export function SelectionToolbar({ rect, focusKey = 0, onConfirm, onRedo, onCancel }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusKey is the trigger; each new pointer selection re-focuses Write note.
  useEffect(() => { focusInto(confirm.current); }, [focusKey]);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  useLayoutEffect(() => {
    const update = () => {
      const width = root.current?.offsetWidth || 290, height = root.current?.offsetHeight || 52;
      const hint = root.current?.closest('.fb-root')?.querySelector('.fb-step-hints');
      const bottom = (hint?.getBoundingClientRect().top || innerHeight - 88) - 8;
      const below = rect.y + rect.height + 12;
      const top = below + height <= bottom ? below : rect.y - height - 12;
      setPosition({ left: Math.max(8, Math.min(rect.x, innerWidth - width - 8)), top: Math.max(8, Math.min(top, bottom - height)) });
    };
    update(); window.addEventListener('resize', update);
    const observer = new ResizeObserver(update);
    if (root.current) observer.observe(root.current);
    const hint = root.current?.closest('.fb-root')?.querySelector('.fb-step-hints');
    if (hint) observer.observe(hint);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); };
  }, [rect]);
  return <div ref={root} className="fb-selection-toolbar" role="toolbar" aria-label="Selection actions" style={position}>
    <button ref={confirm} type="button" onClick={onConfirm} aria-keyshortcuts="Enter">Write note <Keycap>↵</Keycap></button>
    <button type="button" onClick={onRedo}>Redo</button>
    <button type="button" onClick={onCancel} aria-keyshortcuts="Escape">Cancel <Keycap>Esc</Keycap></button>
  </div>;
}
