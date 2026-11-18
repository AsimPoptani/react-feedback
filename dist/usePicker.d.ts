import type { ElementTarget, Rect } from './types';
export interface Highlight {
    rect: Rect;
    label: string;
    locked: boolean;
}
export declare function usePicker(mode: 'element' | 'section' | null, active: boolean, onPick: (target: ElementTarget) => void, onLock?: (target: ElementTarget) => void): {
    hover: Highlight | null;
    clear: () => void;
    confirm: () => void;
    focusKey: number;
    hasSelection: boolean;
};
export declare function useCaptureShield(enabled: boolean): void;
