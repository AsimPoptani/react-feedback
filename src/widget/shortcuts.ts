import { useEffect } from 'react';
export function modifiers() {
  const mac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
  return { command: mac ? '⌘' : 'Ctrl', alt: mac ? '⌥' : 'Alt', shift: mac ? '⇧' : 'Shift', commandKey: mac ? 'Meta' : 'Control' };
}
export function keyLabel(...keys: string[]) {
  const { alt, command, shift } = modifiers();
  const names: Record<string, string> = { Alt: alt, Command: command, Shift: shift };
  return keys.map(key => names[key] ?? key).join(command === '⌘' ? '' : '+');
}
export function isInput(target: EventTarget | null) {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}
const choices: Record<string, string> = { KeyR: 'region', KeyE: 'element', KeyS: 'section', KeyP: 'page', KeyL: 'list' };
const digits: Record<string, string> = { Digit1: 'region', Digit2: 'element', Digit3: 'section', Digit4: 'page' };
function noteAction(event: KeyboardEvent) {
  if (event.code === 'Escape') return 'back';
  if (event.code === 'Enter' && (event.metaKey || event.ctrlKey)) return 'save';
  if (event.code === 'KeyD' && event.altKey) return 'draw';
}
function toolbarAction(event: KeyboardEvent) {
  if (event.altKey || event.metaKey || event.ctrlKey) return;
  if (event.code === 'Slash' && event.shiftKey) return 'help';
  return choices[event.code] ?? digits[event.code];
}
export function isWidgetEvent(event: Event) {
  return event.target instanceof Element && !!event.target.closest('[data-feedback-root]');
}
export function keyboardTarget(event: Event) { return event.target instanceof Element ? event.target : document.activeElement; }
export function nativeButtonActivation(event: KeyboardEvent) {
  return ['Enter', 'Space'].includes(event.code) && !!keyboardTarget(event)?.closest('[data-feedback-root] button');
}
function action(event: KeyboardEvent, step: string) {
  if (step === 'editor') return;
  if (event.code === 'Escape' && step !== 'closed') return 'back';
  const target = keyboardTarget(event);
  if (isInput(target) && !target?.closest('[data-feedback-root]')) return;
  if (step === 'note') return noteAction(event);
  if (isInput(target)) return;
  if (event.altKey && event.shiftKey) return event.code === 'KeyF' ? 'toggle' : choices[event.code];
  if (step === 'toolbar') return toolbarAction(event);
}
export function useShortcuts(step: string, run: (action: string) => void) {
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const command = action(event, step);
      if (!command) return;
      event.preventDefault(); event.stopImmediatePropagation(); run(command);
    };
    window.addEventListener('keydown', keyboard, true);
    return () => window.removeEventListener('keydown', keyboard, true);
  }, [step, run]);
}
