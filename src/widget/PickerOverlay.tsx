import { useEffect, useRef } from 'react';
import { Keycap } from './Keycap';
import { StepHints } from './StepHints';
import { SelectionToolbar } from './SelectionToolbar';
import { focusInto, onAppControl } from './focus';
import type { Highlight } from './usePicker';
interface Props {
  step: 'element' | 'section'; hover: Highlight | null; focusKey: number;
  onConfirm: () => void; onRedo: () => void; onCancel: () => void;
}
/**
 * Element and Section modes. With nothing locked, focus sits on the picker panel, where Enter
 * selects the hovered target and ↑/↓ change it; a focused app control keeps focus (a global
 * shortcut from the page), since Enter selects that control. A locked target focuses Write note.
 */
export function PickerOverlay({ step, hover, focusKey, onConfirm, onRedo, onCancel }: Props) {
  const panel = useRef<HTMLElement>(null);
  const locked = !!hover?.locked;
  useEffect(() => { if (!locked && !onAppControl()) focusInto(panel.current); }, [locked]);
  const label = step === 'section' ? 'Select a section' : 'Select an element';
  return <>
    <section ref={panel} className="fb-panel fb-pick-hint" aria-label={label} tabIndex={-1}>{label} <button type="button" onClick={onCancel} aria-keyshortcuts="Escape">Cancel <Keycap>Esc</Keycap></button></section>
    <StepHints step={step} locked={locked} />
    {hover && <div className={`fb-highlight ${hover.locked ? 'fb-locked' : ''}`} style={{ left: hover.rect.x, top: hover.rect.y, width: hover.rect.width, height: hover.rect.height }}><span>{hover.label}</span></div>}
    {hover?.locked && <SelectionToolbar rect={hover.rect} focusKey={focusKey} onConfirm={onConfirm} onRedo={onRedo} onCancel={onCancel} />}
  </>;
}
