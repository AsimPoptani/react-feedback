import { useEffect } from 'react';
import type { RefObject } from 'react';

// Focus model: every step owns one "home" control where Enter does that step's main
// action (the region surface, the picker panel, Write note, the note textarea, the
// drawing canvas). Steps move focus there themselves; the widget restores the
// opener's focus when it closes. Nothing here restores focus on unmount, because a
// dead control from the previous step would steal it back.
const TABBABLE = 'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]';
export function tabbables(root: HTMLElement | null) { return [...(root?.querySelectorAll<HTMLElement>(TABBABLE) ?? [])]; }
export function focusInto(element: HTMLElement | null | undefined) { element?.focus({ preventScroll: true }); }
/** Focus sits on the page itself (an app control), not on the body and not in the widget. */
export function onAppControl(element: Element | null = document.activeElement) {
  return !!element && element.isConnected && element !== document.body && element !== document.documentElement && !element.closest('[data-feedback-root]');
}
/** Return focus to the element focused before the widget opened, else to the fallback. */
export function restoreFocus(target: HTMLElement | null, fallback: HTMLElement | null) {
  if (target?.isConnected) { focusInto(target); if (document.activeElement === target) return; }
  focusInto(fallback);
}
/** Where Tab should wrap to, or undefined to let the browser move focus normally. */
function wrapTarget(elements: HTMLElement[], back: boolean) {
  const index = elements.indexOf(document.activeElement as HTMLElement), last = elements.length - 1;
  if (back) return index <= 0 ? elements[last] : undefined;
  return index < 0 || index === last ? elements[0] : undefined;
}
/** Locks page scroll and keeps Tab inside `root`. Initial focus is the caller's job. */
export function useModalFocus(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const trap = (event: globalThis.KeyboardEvent) => {
      if (event.code !== 'Tab') return;
      const next = wrapTarget(tabbables(root.current), event.shiftKey);
      if (next) { event.preventDefault(); focusInto(next); }
    };
    const node = root.current; node?.addEventListener('keydown', trap);
    return () => { document.body.style.overflow = overflow; node?.removeEventListener('keydown', trap); };
  }, [root]);
}
