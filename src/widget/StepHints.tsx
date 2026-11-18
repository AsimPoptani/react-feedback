import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Keycap } from './Keycap.js';
import { modifiers, keyLabel } from './shortcuts.js';
// The capture modes (region, element, section) show no banner unless the host opts in with hints="on": it would cover the page being captured.
export const HintsContext = createContext(false);
const CAPTURE_STEPS = ['region', 'element', 'section'];
type Hint = { key?: string; word: string; touch?: string; touchOnly?: boolean };
function hintsFor(step: string, locked: boolean): Hint[] {
  const { alt } = modifiers();
  const cancel = { key: 'Esc', word: 'cancel' };
  if (step === 'region' && !locked) return [{ word: 'Drag to select', touch: 'Drag to select' }, cancel];
  if (step === 'region') return [
    { key: '↵', word: 'write note', touch: 'Tap Write note' }, { key: 'arrows', word: 'move' },
    { key: `${modifiers().shift} arrows`, word: '×10' }, { key: `${alt} arrows`, word: 'resize' },
    { word: 'drag to redraw', touch: 'Drag to redraw' }, cancel,
  ];
  if (step === 'element' || step === 'section') return [
    ...(locked ? [{ key: '↵', word: 'write note', touch: 'Tap Write note' }] : [{ word: 'Click to select', touch: 'Tap to select' }]),
    { key: '↑', word: 'parent' }, { key: '↓', word: 'child' },
    ...(locked ? [{ word: 'click another to change', touch: 'Tap another to change' }] : [{ key: '↵', word: 'select and write' }]), cancel,
  ];
  if (step === 'editor') return [
    ...['P:Pen', 'B:Box', 'A:Arrow', 'T:Text', '1/2/3:colour'].map(item => { const [key, word] = item.split(':'); return { key, word: word! }; }),
    { key: keyLabel('Command', 'Z'), word: 'undo' }, { key: 'Del', word: 'clear' }, { key: '↵', word: 'done' }, cancel,
    { word: 'Draw on the image', touch: 'Draw on the image · tap tools, Done or Cancel', touchOnly: true },
  ];
  return [];
}
export function StepHints({ step, locked = false }: { step: string; locked?: boolean }) {
  const [coarse, setCoarse] = useState(() => window.matchMedia('(pointer: coarse)').matches);
  const root = useRef<HTMLDivElement>(null);
  const banner = useContext(HintsContext) || !CAPTURE_STEPS.includes(step);
  const hints = banner ? hintsFor(step, locked).filter(hint => coarse ? hint.touch : !hint.touchOnly) : [];
  useEffect(() => {
    const media = window.matchMedia('(pointer: coarse)');
    const update = () => setCoarse(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const owner = element.closest<HTMLElement>('.fb-root');
    const update = () => owner?.style.setProperty('--fb-hint-height', `${element.getBoundingClientRect().height}px`);
    update();
    const observer = new ResizeObserver(update); observer.observe(element);
    return () => { observer.disconnect(); owner?.style.removeProperty('--fb-hint-height'); };
  }, []);
  if (!hints.length) return null;
  return <div ref={root} className={`fb-step-hints fb-step-${step}`} role="note" aria-label="Step shortcuts">
    {hints.map(hint => <span className="fb-hint-item" key={hint.word}>
      {!coarse && hint.key && <Keycap>{hint.key}</Keycap>} {coarse ? hint.touch : hint.word}
    </span>)}
  </div>;
}
const TIP_KEY = 'react-feedback.shortcuts-tip';
export function FirstRunTip() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    try {
      if (!localStorage.getItem(TIP_KEY)) { setVisible(true); localStorage.setItem(TIP_KEY, '1'); }
    } catch { setVisible(true); }
    const dismiss = () => setVisible(false);
    // Not pointerdown: the toolbar is bottom-anchored, so hiding the tip there shifts the buttons
    // under the pointer before mouseup, and the first click on a mode button is lost.
    const events = ['click', 'keydown'];
    for (const event of events) window.addEventListener(event, dismiss, true);
    return () => { for (const event of events) window.removeEventListener(event, dismiss, true); };
  }, []);
  return visible ? <p className="fb-first-tip">Tip: press ? any time to see every shortcut</p> : null;
}
