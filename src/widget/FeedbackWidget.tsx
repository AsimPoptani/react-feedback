import { useCallback, useEffect, useRef, useState } from 'react';
import { getContext, installCapture } from './context.js';
import { capturePage, captureViewport, pageSize } from './screenshot.js';
import { useFeedbackLayer } from './layer.js';
import { useCaptureShield, usePicker } from './usePicker.js';
import { FeedbackDraft } from './FeedbackDraft.js';
import { FeedbackList } from './FeedbackList.js';
import { MarkupEditor } from './MarkupEditor.js';
import { RegionPicker } from './RegionPicker.js';
import { useLauncherPosition, MARGIN } from './launcherPosition.js';
import { useShortcuts, modifiers, keyLabel } from './shortcuts.js';
import { Keycap } from './Keycap.js';
import { FirstRunTip, HintsContext } from './StepHints.js';
import { PickerOverlay } from './PickerOverlay.js';
import { focusInto, restoreFocus } from './focus.js';
import { feedbackBody } from './draft.js';
import { Outbox, newId } from './outboxQueue.js';
import { openStore } from './outboxStore.js';
import { OutboxContext, useOutboxSnapshot } from './useOutbox.js';
import type { Draft } from './draft.js';
import { shotPayload } from './captureBridge.js';
import type { CaptureBridge, Command } from './captureBridge.js';
import type { Capture, CaptureMode, ElementTarget, Rect, Target } from './types.js';
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
export type LauncherPosition = 'bottom-left' | 'bottom-right';
export const positionOf = (value: unknown): LauncherPosition => (value === 'bottom-right' ? 'bottom-right' : 'bottom-left');
export interface FeedbackWidgetProps {
  /** Base URL of the feedback server. Defaults to "/__feedback". */
  endpoint?: string;
  /** Which bottom corner holds the launcher and its panels. Defaults to "bottom-left". */
  position?: LauncherPosition;
  /** "on" shows the step-by-step shortcut banner while a capture mode is active. Defaults to "off" (press ? for the shortcuts). */
  hints?: 'on' | 'off';
  /** Inside a shared artifact: no launcher and no server. A finished capture goes to the page that framed this one (see captureBridge). */
  bridge?: CaptureBridge;
}
export default function FeedbackWidget({ endpoint = "/__feedback", position = "bottom-left", hints = "off", bridge }: FeedbackWidgetProps) {
  if (bridge) return <HintsContext.Provider value={hints === 'on'}><FeedbackPanel outbox={null} bridge={bridge} endpoint="" position={positionOf(position)} /></HintsContext.Provider>;
  return <ServerWidget endpoint={endpoint} position={position} hints={hints} />;
}
function ServerWidget({ endpoint, position, hints }: { endpoint: string; position: LauncherPosition; hints: 'on' | 'off' }) {
  const base = endpoint.replace(/\/$/, '');
  const [outbox] = useState(() => new Outbox(base, openStore()));
  outbox.endpoint = base;
  useEffect(() => { outbox.start(); return () => outbox.stop(); }, [outbox]);
  return <OutboxContext.Provider value={outbox}><HintsContext.Provider value={hints === 'on'}><FeedbackPanel outbox={outbox} endpoint={base} position={positionOf(position)} /></HintsContext.Provider></OutboxContext.Provider>;
}
// The context a page's note carries (console, failed requests). Inside an artifact nothing is read or patched: the page is not ours.
const noContext = () => ({ url: '', title: '', route: '', viewport: { width: 0, height: 0 }, scroll: { x: 0, y: 0 }, devicePixelRatio: 1, userAgent: '', 'prefers-color-scheme': 'light', ts: '', console: [], failedFetches: [] }) as unknown as ReturnType<typeof getContext>;
function FeedbackPanel({ outbox, endpoint, position, bridge }: { outbox: Outbox | null; endpoint: string; position: LauncherPosition; bridge?: CaptureBridge }) {
  const readContext = bridge ? noContext : getContext;
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
  const place = useLauncherPosition(launcher);
  const previousStep = useRef<Step>(step);
  const root = useRef<HTMLDivElement>(null);
  // On a phone the launcher sits on the edge and slides off while the page scrolls, so a line of text underneath can be read.
  useEffect(() => {
    if (bridge) return;
    const rootEl = root.current;
    if (!rootEl) return;
    const narrow = () => { try { return window.matchMedia('(max-width: 480px)').matches; } catch { return false; } };
    let timer = 0;
    const onScroll = () => {
      if (!narrow()) { rootEl.classList.remove('fb-scrolling'); return; }
      rootEl.classList.add('fb-scrolling');
      window.clearTimeout(timer);
      timer = window.setTimeout(() => rootEl.classList.remove('fb-scrolling'), 700);
    };
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('scroll', onScroll);
    return () => {
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('scroll', onScroll);
      window.clearTimeout(timer);
      rootEl.classList.remove('fb-scrolling');
    };
  }, [bridge]);
  // Focus before the widget opened. A Save returns there (the launcher if that control is gone);
  // closing with Esc or the launcher focuses the launcher, ready to open it again.
  const opener = useRef<HTMLElement | null>(null);
  const savedClose = useRef(false);
  // The toolbar button to focus when stepping back to the toolbar: the mode or list just left.
  const returnTo = useRef<string | null>(null);
  useFeedbackLayer(root);
  const queue = useOutboxSnapshot();
  useEffect(() => { if (!bridge) installCapture(); }, [bridge]);
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 4000);
    return () => window.clearTimeout(timer);
  }, [saved]);
  useEffect(() => {
    const from = previousStep.current; previousStep.current = step;
    if (step === 'closed' && from !== 'closed') bridge?.closed();
    if (step === 'closed') {
      if (from !== 'closed') restoreFocus(savedClose.current ? opener.current : null, launcher.current);
      opener.current = null; savedClose.current = false; return;
    }
    if (step !== 'toolbar' && step !== 'list') return;
    const panel = root.current?.querySelector<HTMLElement>('.fb-panel'), choice = returnTo.current;
    returnTo.current = null;
    focusInto((choice && panel?.querySelector<HTMLElement>(`[data-choice="${choice}"]`)) || panel?.querySelector<HTMLElement>('button'));
  }, [step, bridge]);
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
    setDraft({ mode, target, context: readContext(), pending, capture: null, failed: false }); setStep('note');
    pending.then(result => { if (generation.current === token) current({ capture: result }); }, () => { if (generation.current === token) current({ failed: true }); });
  }, [warm, readContext]);
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
    const actions: Record<string, () => void> = { toggle, back, save, draw: () => { if (draft?.capture) setStep('editor'); }, help: () => setHelp(value => !value), list: () => { if (bridge) return; remember(); reset(); setStep('list'); } };
    if (actions[command]) actions[command]();
    else if (modes.includes(command as CaptureMode)) choose(command as CaptureMode);
  });
  // Inside an artifact the page that framed this one starts and stops a capture (its own Feedback button), through the latest closures.
  const commands = useRef<(command: Command) => void>(() => {});
  commands.current = command => {
    if (command.op === 'cancel') { if (step !== 'closed') { reset(); setMode(null); setStep('closed'); } return; }
    if (step !== 'closed') return;
    if (command.mode) choose(command.mode); else toggle();
    if (command.note) setNote(command.note); // the words already typed in the page's own box
  };
  useEffect(() => bridge?.onCommand(command => commands.current(command)), [bridge]);
  // Save never waits: the note goes into the outbox and the widget is idle again at once.
  function save() {
    if (!draft || !note.trim()) return;
    const text = note, drawn = annotated, taken = draft;
    if (bridge) {
      // Inside an artifact: the picture and the note go to the page that framed this one, and the widget is idle again at once.
      Promise.resolve(taken.capture ?? taken.pending).then(result => result, () => null).then(result => bridge.send(shotPayload(taken, result, text, drawn)));
      reset(); setMode(null); savedClose.current = true; setStep('closed');
      return;
    }
    const live = getContext();
    outbox!.enqueue({ id: newId(), label: text.trim().split('\n')[0]!.slice(0, 80), text, capture: taken.capture ?? taken.pending, build: result => feedbackBody(taken, result, text, drawn, live) });
    reset(); setMode(null); setSaved(true); savedClose.current = true; setStep('closed');
  }
  const side = place.side ?? (position === 'bottom-right' ? 'right' : 'left');
  const launcherStyle = place.placed ? { left: place.placed.x, top: place.placed.y, right: 'auto', bottom: 'auto' } as const : undefined;
  // The toolbar follows a dragged launcher: above it in the lower half of the screen, below it in the upper half.
  const toolbarStyle = (() => {
    if (!place.placed) return undefined;
    const { vw, vh, h } = place.size();
    const width = Math.min(370, vw - 24);
    const left = Math.max(MARGIN, Math.min(place.placed.x, vw - width - MARGIN));
    return place.placed.y > vh / 2 ? { left, right: 'auto', top: 'auto', bottom: vh - place.placed.y + 8 } as const : { left, right: 'auto', bottom: 'auto', top: place.placed.y + h + 8 } as const;
  })();
  const dragToolbar = (event: React.PointerEvent<HTMLElement>) => { if (!(event.target as Element).closest('button, input, textarea, a, summary, aside')) place.handlers.onPointerDown(event); };
  return <div className={`fb-root${side === 'right' ? ' fb-right' : ''}${place.dragging ? ' fb-dragging' : ''}`} data-feedback-root data-position={side === 'right' ? 'bottom-right' : 'bottom-left'} ref={root}>
    <div className="fb-launchers" style={bridge ? { display: 'none' } : launcherStyle}><button ref={launcher} type="button" className={`fb-launcher${queue.failed ? ' fb-launcher-warn' : ''}`} aria-expanded={step !== 'closed'} aria-keyshortcuts="Alt+Shift+F" aria-description="Drag to move, or Alt plus the arrow keys" {...place.handlers} onKeyDown={place.onKeyDown} onClick={() => { if (!place.wasDrag()) toggle(); }}>Feedback <Keycap>{keyLabel('Alt', 'Shift', 'F')}</Keycap>{queue.items.length > 0 && <span className="fb-pill-count"> · {pillText(queue)}</span>}</button></div>
    {saved && <div className="fb-toast" role="status">Queued</div>}
    {step === 'toolbar' && <section className="fb-panel fb-capture-toolbar" aria-label="Feedback toolbar" style={toolbarStyle} onPointerDown={dragToolbar} onPointerMove={place.handlers.onPointerMove} onPointerUp={place.handlers.onPointerUp} onPointerCancel={place.handlers.onPointerCancel}>
      <div className="fb-toolbar">{modes.map((mode, index) => <button type="button" key={mode} data-choice={mode} aria-label={['Region', 'Element', 'Section', 'Full page'][index]} aria-keyshortcuts={`${modeKeys[index]} ${index + 1}`} onClick={() => choose(mode)}>{['Region', 'Element', 'Section', 'Full page'][index]} <Keycap>{modeKeys[index]}</Keycap></button>)}
        {!bridge && <button type="button" data-choice="list" aria-label="My feedback" aria-keyshortcuts="L" onClick={() => setStep('list')}>My feedback <Keycap>L</Keycap></button>}<button type="button" aria-label="Shortcuts" aria-keyshortcuts="?" aria-expanded={help} onClick={() => setHelp(value => !value)}><Keycap>?</Keycap> Shortcuts</button>{!bridge && place.custom && <button type="button" data-choice="reset-position" onClick={place.reset}>Reset position</button>}</div>
      <FirstRunTip />
      {help && <ShortcutHelp />}
    </section>}
    {selectingElement && <PickerOverlay step={step} hover={picker.hover} focusKey={picker.focusKey} onConfirm={picker.confirm} onRedo={() => { job.current = null; picker.clear(); }} onCancel={discard} />}
    {step === 'note' && draft && <FeedbackDraft note={note} shot={draft.capture?.shot ?? null} failed={draft.failed} annotated={annotated} clipped={draft.capture?.clipped} rect={'rect' in draft.target ? draft.target.rect : undefined}
      saveLabel={bridge ? 'Send' : 'Save'} onNote={setNote} onEdit={() => { if (draft.capture) setStep('editor'); }} onSave={save} onCancel={discard} />}
    {step === 'list' && !bridge && <FeedbackList endpoint={endpoint} onClose={back} />}
    {step === 'region' && <RegionPicker rect={region} onChange={rect => { if (!rect) job.current = null; setRegion(rect); }} onSettle={rect => { void warm('region', { rect }).catch(() => {}); }} onCapture={rect => capture('region', { rect })} onCancel={discard} />}
    {step === 'editor' && draft?.capture && <MarkupEditor shot={draft.capture.shot} onSave={url => { setAnnotated(url); setStep('note'); }} onCancel={() => setStep('note')} />}
  </div>;
}

function ShortcutHelp() {
  const { command, alt } = modifiers();
  return <aside className="fb-shortcut-help" aria-label="Keyboard shortcuts">
    <p>{alt}+Shift+F: toolbar · {alt}+Shift+R/E/S/P: Region / Element / Section / Full page · {alt}+Shift+L: My feedback</p>
    <p>Move it: drag the Feedback button or the toolbar · {alt}+arrows (button focused): nudge · Reset position: back to the corner</p>
    <p>Toolbar: R/E/S/P or 1–4: modes · L: My feedback · ?: shortcuts</p>
    <p>Selection: Enter: Write note · Esc: back · ↑/↓: parent/child · Region arrows: move 1 px, Shift: 10 px, Alt: resize</p>
    <p>Note: {command}↵: Save · {alt}+D: Draw on it · Esc: back</p>
    <p>Markup: P: pen · B: box · A: arrow · T: text · 1/2/3: colour · Delete: Clear · {command}+Z: Undo · Enter: Use markup · Esc: cancel · Space: start/finish mark · arrows: move cursor</p>
  </aside>;
}

function elementMode(mode: CaptureMode | null) { return mode === 'element' || mode === 'section' ? mode : null; }
