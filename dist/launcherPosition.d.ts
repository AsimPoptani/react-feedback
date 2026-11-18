import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
export declare const MARGIN = 12;
export declare const DRAG_THRESHOLD = 5;
export declare const NUDGE = 10;
/** A saved position. `x` and `y` are the launcher's top-left corner in viewport px; `ex` / `ey` pin it to an edge so it stays there when the window resizes. */
export interface Pos {
    x: number;
    y: number;
    ex?: 'l' | 'r';
    ey?: 't' | 'b';
}
export interface Size {
    vw: number;
    vh: number;
    w: number;
    h: number;
}
export interface Placed {
    x: number;
    y: number;
}
/** Turn a saved position into on-screen coordinates, kept inside the viewport. */
export declare function resolve(pos: Pos, { vw, vh, w, h }: Size): Placed;
/** On release: clamp, then pin to the nearest edge (the other coordinate stays where it was let go). */
export declare function snap(x: number, y: number, size: Size): Pos;
/** Alt+arrow: move by `step` px along one axis, free of any edge pin on that axis. */
export declare function nudge(pos: Pos, key: string, size: Size, step?: number): Pos;
export declare const storageKey: () => string;
export declare function loadPos(): Pos | null;
/** Dragging, edge snapping, keyboard nudging and a remembered position for the launcher (the toolbar drags it too). */
export declare function useLauncherPosition(ref: RefObject<HTMLElement | null>): {
    custom: boolean;
    placed: Placed | null;
    side: "left" | "right" | null;
    dragging: boolean;
    handlers: {
        onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
        onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
        onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
        onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
    };
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
    reset: () => void;
    wasDrag: () => boolean;
    size: () => Size;
};
