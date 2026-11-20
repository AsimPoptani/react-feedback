import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Rect, Shot } from './types.js';
import { Keycap } from './Keycap.js';
import { modifiers, keyLabel } from './shortcuts.js';
import { focusInto, useModalFocus } from './focus.js';
import { CAPTURE_FAILED } from './draft.js';
interface Props {
  note: string; saveLabel?: string; shot: Shot | null; failed: boolean; annotated: string | null; clipped?: string; rect?: Rect;
  onNote: (value: string) => void; onEdit: () => void; onSave: () => void; onCancel: () => void;
}
function beside(rect: Rect | undefined, width: number, height: number): CSSProperties {
  if (!rect || innerWidth <= 600) return {};
  const top = Math.max(12, Math.min(rect.y, innerHeight - height - 12));
  if (rect.x + rect.width + width + 24 <= innerWidth) return { left: rect.x + rect.width + 12, top, bottom: 'auto' };
  if (rect.x - width - 12 >= 12) return { left: rect.x - width - 12, top, bottom: 'auto' };
  if (rect.y >= height + 24) return { left: Math.max(12, Math.min(rect.x, innerWidth - width - 12)), top: rect.y - height - 12, bottom: 'auto' };
  return {};
}
export function FeedbackDraft(props: Props) {
  const id = useId();
  const root = useRef<HTMLElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [position, setPosition] = useState<CSSProperties>({});
  useModalFocus(root);
  // The textarea is home when the note opens.
  useEffect(() => { focusInto(textarea.current); }, []);
  useLayoutEffect(() => {
    const update = () => {
      if (root.current) setPosition(beside(props.rect, root.current.offsetWidth, root.current.offsetHeight));
    };
    update(); window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [props.rect]);
  return <section ref={root} className="fb-panel fb-note" aria-label="Feedback note" style={position}>
    {props.shot
      ? <img className="fb-preview" src={props.annotated ?? props.shot.url} alt="Captured area" />
      : <p className="fb-preview-pending" role="status">{props.failed ? CAPTURE_FAILED : 'Capturing…'}</p>}
    <label htmlFor={id}>Note</label>
    <textarea ref={textarea} id={id} maxLength={10000 - (props.clipped ? props.clipped.length + 2 : 0)} value={props.note} onChange={event => props.onNote(event.target.value)} placeholder="What should change?" />
    {props.clipped && <p className="fb-hint">{props.clipped} This will be included in your note.</p>}
    <div className="fb-toolbar">
      <button type="button" onClick={props.onEdit} disabled={!props.shot} aria-label="Draw on it" aria-keyshortcuts="Alt+D">Draw on it <Keycap>{keyLabel('Alt', 'D')}</Keycap></button>
      <button type="button" onClick={props.onCancel} aria-keyshortcuts="Escape">Cancel <Keycap>Esc</Keycap></button>
      <button className="fb-save" type="button" disabled={!props.note.trim()} onClick={props.onSave} aria-label={props.saveLabel ?? 'Save'} aria-keyshortcuts={`${modifiers().commandKey}+Enter`}>{props.saveLabel ?? 'Save'} <Keycap>{keyLabel('Command', '↵')}</Keycap></button>
    </div>
  </section>;
}
