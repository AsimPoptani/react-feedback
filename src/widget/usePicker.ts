import { useCallback, useEffect, useRef, useState } from 'react';
import { isWidget, targetFor, rectFor, selectorFor, componentChain, sectionFor } from './elements';
import { isWidgetEvent, nativeButtonActivation } from './shortcuts';
import { focusInto, onAppControl } from './focus';
import type { ElementTarget, Rect } from './types';
export interface Highlight { rect: Rect; label: string; locked: boolean }
export function usePicker(mode: 'element' | 'section' | null, active: boolean, onPick: (target: ElementTarget) => void, onLock?: (target: ElementTarget) => void) {
  const [hover, setHover] = useState<Highlight | null>(null);
  // Bumped by every click or tap that locks a target, so Write note takes focus each time.
  const [focusKey, setFocusKey] = useState(0);
  const selected = useRef<Element | null>(null), leaf = useRef<Element | null>(null);
  // Called when a click or arrow locks a target, so its screenshot can start before Enter.
  const lockRef = useRef(onLock); lockRef.current = onLock;
  const locked = useRef(false), children = useRef<Element[]>([]);
  const clear = useCallback(() => { selected.current = null; leaf.current = null; locked.current = false; children.current = []; setHover(null); }, []);
  const show = useCallback((element: Element | null) => {
    selected.current = element;
    setHover(element ? { rect: rectFor(element), label: [element.tagName.toLowerCase(), selectorFor(element), ...componentChain(element)].filter(Boolean).join(' · '), locked: locked.current } : null);
  }, []);
  const confirm = useCallback(() => { if (selected.current) { locked.current = true; show(selected.current); onPick(targetFor(selected.current)); } }, [onPick, show]);
  useEffect(() => {
    if (!mode || !active) return;
    function target(event: Event): Element | null {
      const element = event.target instanceof Element ? event.target : null;
      return element && !isWidget(element) ? element : null;
    }
    function highlight(event: Event) {
      if (locked.current) return;
      const element = target(event);
      if (!element || element === leaf.current) return;
      leaf.current = element; children.current = [];
      show(mode === 'section' ? sectionFor(element) : element);
    }
    function suppress(event: Event) { if (target(event)) { event.preventDefault(); event.stopImmediatePropagation(); } }
    function select(event: Event) {
      const element = target(event); if (!element) return;
      suppress(event);
      const same = selected.current && leaf.current === element;
      const chosen = same ? selected.current! : mode === 'section' ? sectionFor(element) : element;
      if (!same) children.current = [];
      leaf.current = element; locked.current = true; show(chosen); setFocusKey(count => count + 1); lockRef.current?.(targetFor(chosen));
    }
    function navigate(code: string) {
      const element = selected.current;
      if (!element) return;
      if (code === 'ArrowUp' && element.parentElement) { children.current.push(element); show(element.parentElement); }
      if (code === 'ArrowDown' && children.current.length) show(children.current.pop()!);
      if (locked.current && selected.current && selected.current !== element) lockRef.current?.(targetFor(selected.current));
    }
    function keyboard(event: KeyboardEvent) {
      if (skipKey(event, !!selected.current)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.type !== 'keydown') return;
      activate(event);
    }
    function activate(event: KeyboardEvent) {
      if (event.code === 'Tab') { focusInto(document.querySelector<HTMLButtonElement>('[data-feedback-root] .fb-selection-toolbar button') ?? document.querySelector<HTMLButtonElement>('[data-feedback-root] .fb-pick-hint button')); return; }
      if (!selected.current) highlight(event);
      if (event.code === 'Enter') confirm();
      else navigate(event.code);
    }

    const events: [string, EventListener][] = [
      ['pointermove', highlight], ['focusin', highlight], ['pointerdown', suppress], ['pointerup', suppress],
      ['click', select], ['dblclick', suppress], ['contextmenu', suppress], ['keydown', keyboard as EventListener], ['keyup', keyboard as EventListener],
    ];
    for (const [name, handler] of events) window.addEventListener(name, handler, true);
    // Entered by a global shortcut from a focused app control: outline it, since Enter would select it.
    const focused = document.activeElement;
    if (!selected.current && focused && onAppControl(focused)) { leaf.current = focused; show(mode === 'section' ? sectionFor(focused) : focused); }
    const update = () => show(selected.current);
    window.addEventListener('scroll', update, true); window.addEventListener('resize', update);
    return () => { for (const [name, handler] of events) window.removeEventListener(name, handler, true); window.removeEventListener('scroll', update, true); window.removeEventListener('resize', update); };
  }, [mode, active, confirm, show]);
  return { hover: active ? hover : null, clear, confirm, focusKey, hasSelection: !!hover?.locked };
}

function skipKey(event: KeyboardEvent, hasTarget: boolean) {
  if (event.type !== 'keydown') return isWidgetEvent(event);
  if (event.code === 'Escape') return true;
  if (event.altKey && event.shiftKey && ['KeyF', 'KeyR', 'KeyE', 'KeyS', 'KeyP', 'KeyL'].includes(event.code)) return true;
  if (!isWidgetEvent(event)) return false;
  return !hasTarget || !['Enter', 'ArrowUp', 'ArrowDown'].includes(event.code) || nativeButtonActivation(event);
}

// Keep app events blocked during the asynchronous screenshot, until the note takes focus.
export function useCaptureShield(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const block = (event: Event) => {
      if (isWidgetEvent(event)) return;
      if (event instanceof KeyboardEvent && skipKey(event, false)) return;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    const events = ['pointerdown', 'pointerup', 'click', 'dblclick', 'contextmenu', 'keydown', 'keyup'];
    for (const name of events) window.addEventListener(name, block, true);
    return () => { for (const name of events) window.removeEventListener(name, block, true); };
  }, [enabled]);
}
