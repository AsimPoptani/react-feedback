import { useCallback, useEffect, useRef, useState } from 'react';
import { getContext, installCapture } from './context';
import { capturePage, captureViewport, pageSize } from './screenshot';
import { useFeedbackLayer } from './layer';
import { useCaptureShield, usePicker } from './usePicker';
import { FeedbackDraft } from './FeedbackDraft';
import { FeedbackList } from './FeedbackList';
import { MarkupEditor } from './MarkupEditor';
import { RegionPicker } from './RegionPicker';
import { useShortcuts, modifiers, keyLabel } from './shortcuts';
import { Keycap } from './Keycap';
import { FirstRunTip } from './StepHints';
import { PickerOverlay } from './PickerOverlay';
import { focusInto, restoreFocus } from './focus';
import { feedbackBody } from './draft';
import { Outbox, newId } from './outboxQueue';
import { openStore } from './outboxStore';
import { OutboxContext, useOutboxSnapshot } from './useOutbox';
import type { Draft } from './draft';
import type { Capture, CaptureMode, ElementTarget, Rect, Target } from './types';
type Step = 'closed' | 'toolbar' | 'region' | 'element' | 'section' | 'note' | 'editor' | 'list';
const modes: CaptureMode[] = ['region', 'element', 'section', 'page'];
const modeKeys = ['R', 'E', 'S', 'P'];
interface Job { key: string; at: number; promise: Promise<Capture> }
// A warm-up capture older than this is retaken: the page may have moved on.
const JOB_MAX_AGE = 20000;
function startCapture(mode: CaptureMode, target: Target) {
  return mode === 'page' ? capturePage(target as { width: number; height: number }) : captureViewport((target as { rect: ElementTarget['rect'] }).rect);
}
function pillText({ pending, failed }: { pending: number; failed: number }) {
  return [pending ? `${pending} sending` : '', failed ? `${failed} failed` : ''].filter(Boolean).join(', ');
}
export interface FeedbackWidgetProps {
  /** Base URL of the feedback server. Defaults to "/__feedback". */
  endpoint?: string;
}
export default function FeedbackWidget({ endpoint = "/__feedback" }: FeedbackWidgetProps) {
  const base = endpoint.replace(/\/$/, '');
  const [outbox] = useState(() => new Outbox(base, openStore()));
  outbox.endpoint = base;
  useEffect(() => { outbox.start(); return () => outbox.stop(); }, [outbox]);
  return <OutboxContext.Provider value={outbox}><FeedbackPanel outbox={outbox} endpoint={base} /></OutboxContext.Provider>;
}
function FeedbackPanel({ outbox, endpoint }: { outbox: Outbox; endpoint: string }) {
  const [step, setStep] = useState<Step>('closed');
  const [mode, setMode] = useState<CaptureMode | null>(null);
  const [region, setRegion] = useState<Rect | null>(null);
  const [help, setHelp] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [note, setNote] = useState('');
  const [annotated, setAnnotated] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const generation = useRef(0);
  const job = useRef<Job | null>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const previousStep = useRef<Step>(step);
  const root = useRef<HTMLDivElement>(null);
  // Focus before the widget opened. A Save returns there (the launcher if that control is gone);
  // closing with Esc or the launcher focuses the launcher, ready to open it again.
  const opener = useRef<HTMLElement | null>(null);
  const savedClose = useRef(false);
  // The toolbar button to focus when stepping back to the toolbar: the mode or list just left.
  const returnTo = useRef<string | null>(null);
  useFeedbackLayer(root);
  const queue = useOutboxSnapshot();
  useEffect(() => { installCapture(); }, []);
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 4000);
    return () => window.clearTimeout(timer);
  }, [saved]);
  useEffect(() => {
    const from = previousStep.current; previousStep.current = step;
    if (step === 'closed') {
      if (from !== 'closed') restoreFocus(savedClose.current ? opener.current : null, launcher.current);
      opener.current = null; savedClose.current = false; return;
    }
    if (step !== 'toolbar' && step !== 'list') return;
    const panel = root.current?.querySelector<HTMLElement>('.fb-panel'), choice = returnTo.current;
    returnTo.current = null;
    focusInto((choice && panel?.querySelector<HTMLElement>(`[data-choice="${choice}"]`)) || panel?.querySelector<HTMLElement>('button'));
  }, [step]);
  const remember = () => {
    if (step !== 'closed') return;
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
  };
  // Start the screenshot (or reuse the one already running for this exact selection and scroll).
  const warm = useCallback((mode: CaptureMode, target: Target) => {
    const key = JSON.stringify([mode, target, scrollX, scrollY, innerWidth, innerHeight]);
    if (job.current?.key === key && performance.now() - job.current.at < JOB_MAX_AGE) return job.current.promise;
    const promise = startCapture(mode, target); promise.catch(() => {});
    job.current = { key, at: performance.now(), promise };
    return promise;
  }, []);
  // The note opens at once; the screenshot lands in it when it is ready.
  const capture = useCallback((mode: CaptureMode, target: Target) => {
    const token = ++generation.current;
    const pending = warm(mode, target);
    const current = (change: Partial<Draft>) => setDraft(draft => (draft?.pending === pending ? { ...draft, ...change } : draft));
    setSaved(false); setAnnotated(null);
    setDraft({ mode, target, context: getContext(), pending, capture: null, failed: false }); setStep('note');
    pending.then(result => { if (generation.current === token) current({ capture: result }); }, () => { if (generation.current === token) current({ failed: true }); });
  }, [warm]);
  const warmElement = useCallback((target: ElementTarget) => { void warm(mode === 'section' ? 'section' : 'element', target).catch(() => {}); }, [warm, mode]);
  const pick = useCallback((target: ElementTarget) => { capture(mode === 'section' ? 'section' : 'element', target); }, [capture, mode]);
  const selectingElement = step === 'element' || step === 'section';
  useCaptureShield(step === 'note' && !!draft && !draft.capture && !draft.failed && elementMode(mode) !== null);
  const picker = usePicker(elementMode(mode), selectingElement, pick, warmElement);
  const reset = () => { generation.current++; job.current = null; setDraft(null); setNote(''); setAnnotated(null); setRegion(null); picker.clear(); setHelp(false); };
  const choose = (choice: CaptureMode) => {
    remember(); reset(); setMode(choice); setSaved(false);
    if (choice === 'page') capture(choice, pageSize());
    else setStep(choice);
  };
  const discard = () => { returnTo.current = mode; reset(); setMode(null); setStep('toolbar'); };
  const back = () => {
    if (help) { setHelp(false); return; }
    returnTo.current = step === 'list' ? 'list' : mode;
    const actions: Partial<Record<Step, () => void>> = {
      editor: () => setStep('note'),
      note: () => setStep(mode === 'page' ? 'toolbar' : mode ?? 'toolbar'),
      region: () => { if (region) setRegion(null); else setStep('toolbar'); },
      element: () => { if (picker.hasSelection) picker.clear(); else setStep('toolbar'); },
      section: () => { if (picker.hasSelection) picker.clear(); else setStep('toolbar'); },
    };
    if (actions[step]) { actions[step](); return; }
    generation.current++; setStep(step === 'toolbar' ? 'closed' : 'toolbar');
  };
  const toggle = () => { remember(); returnTo.current = null; reset(); setMode(null); setStep(step === 'closed' ? 'toolbar' : 'closed'); };
  useShortcuts(step, command => {
    const actions: Record<string, () => void> = { toggle, back, save, draw: () => { if (draft?.capture) setStep('editor'); }, help: () => setHelp(value => !value), list: () => { remember(); reset(); setStep('list'); } };
    if (actions[command]) actions[command]();
    else if (modes.includes(command as CaptureMode)) choose(command as CaptureMode);
  });
  // Save never waits: the note goes into the outbox and the widget is idle again at once.
  function save() {
    if (!draft || !note.trim()) return;
    const text = note, drawn = annotated, taken = draft, live = getContext();
    outbox.enqueue({ id: newId(), label: text.trim().split('\n')[0]!.slice(0, 80), text, capture: taken.capture ?? taken.pending, build: result => feedbackBody(taken, result, text, drawn, live) });
    reset(); setMode(null); setSaved(true); savedClose.current = true; setStep('closed');
  }
  return <div className="fb-root" data-feedback-root ref={root}>
    <div className="fb-launchers"><button ref={launcher} type="button" className={`fb-launcher${queue.failed ? ' fb-launcher-warn' : ''}`} aria-expanded={step !== 'closed'} aria-keyshortcuts="Alt+Shift+F" onClick={toggle}>Feedback <Keycap>{keyLabel('Alt', 'Shift', 'F')}</Keycap>{queue.items.length > 0 && <span className="fb-pill-count"> · {pillText(queue)}</span>}</button></div>
    {saved && <div className="fb-toast" role="status">Queued</div>}
    {step === 'toolbar' && <section className="fb-panel fb-capture-toolbar" aria-label="Feedback toolbar">
      <div className="fb-toolbar">{modes.map((mode, index) => <button type="button" key={mode} data-choice={mode} aria-label={['Region', 'Element', 'Section', 'Full page'][index]} aria-keyshortcuts={`${modeKeys[index]} ${index + 1}`} onClick={() => choose(mode)}>{['Region', 'Element', 'Section', 'Full page'][index]} <Keycap>{modeKeys[index]}</Keycap></button>)}
        <button type="button" data-choice="list" aria-label="My feedback" aria-keyshortcuts="L" onClick={() => setStep('list')}>My feedback <Keycap>L</Keycap></button><button type="button" aria-label="Shortcuts" aria-keyshortcuts="?" aria-expanded={help} onClick={() => setHelp(value => !value)}><Keycap>?</Keycap> Shortcuts</button></div>
      <FirstRunTip />
      {help && <ShortcutHelp />}
    </section>}
    {selectingElement && <PickerOverlay step={step} hover={picker.hover} focusKey={picker.focusKey} onConfirm={picker.confirm} onRedo={() => { job.current = null; picker.clear(); }} onCancel={discard} />}
    {step === 'note' && draft && <FeedbackDraft note={note} shot={draft.capture?.shot ?? null} failed={draft.failed} annotated={annotated} clipped={draft.capture?.clipped} rect={'rect' in draft.target ? draft.target.rect : undefined}
      onNote={setNote} onEdit={() => { if (draft.capture) setStep('editor'); }} onSave={save} onCancel={discard} />}
    {step === 'list' && <FeedbackList endpoint={endpoint} onClose={back} />}
    {step === 'region' && <RegionPicker rect={region} onChange={rect => { if (!rect) job.current = null; setRegion(rect); }} onSettle={rect => { void warm('region', { rect }).catch(() => {}); }} onCapture={rect => capture('region', { rect })} onCancel={discard} />}
    {step === 'editor' && draft?.capture && <MarkupEditor shot={draft.capture.shot} onSave={url => { setAnnotated(url); setStep('note'); }} onCancel={() => setStep('note')} />}
  </div>;
}

function ShortcutHelp() {
  const { command, alt } = modifiers();
  return <aside className="fb-shortcut-help" aria-label="Keyboard shortcuts">
    <p>{alt}+Shift+F: toolbar · {alt}+Shift+R/E/S/P: Region / Element / Section / Full page · {alt}+Shift+L: My feedback</p>
    <p>Toolbar: R/E/S/P or 1–4: modes · L: My feedback · ?: shortcuts</p>
    <p>Selection: Enter: Write note · Esc: back · ↑/↓: parent/child · Region arrows: move 1 px, Shift: 10 px, Alt: resize</p>
    <p>Note: {command}↵: Save · {alt}+D: Draw on it · Esc: back</p>
    <p>Markup: P: pen · B: box · A: arrow · T: text · 1/2/3: colour · Delete: Clear · {command}+Z: Undo · Enter: Use markup · Esc: cancel · Space: start/finish mark · arrows: move cursor</p>
  </aside>;
}

function elementMode(mode: CaptureMode | null) { return mode === 'element' || mode === 'section' ? mode : null; }
