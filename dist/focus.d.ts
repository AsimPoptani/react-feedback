import type { RefObject } from 'react';
export declare function tabbables(root: HTMLElement | null): HTMLElement[];
export declare function focusInto(element: HTMLElement | null | undefined): void;
/** Focus sits on the page itself (an app control), not on the body and not in the widget. */
export declare function onAppControl(element?: Element | null): boolean;
/** Return focus to the element focused before the widget opened, else to the fallback. */
export declare function restoreFocus(target: HTMLElement | null, fallback: HTMLElement | null): void;
/** Locks page scroll and keeps Tab inside `root`. Initial focus is the caller's job. */
export declare function useModalFocus(root: RefObject<HTMLElement | null>): void;
