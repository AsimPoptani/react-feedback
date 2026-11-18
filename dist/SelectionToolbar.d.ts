import type { Rect } from './types';
interface Props {
    rect: Rect;
    focusKey?: number;
    onConfirm: () => void;
    onRedo: () => void;
    onCancel: () => void;
}
/** A selection exists: Write note takes focus (on mount and whenever focusKey changes), so Enter presses it. */
export declare function SelectionToolbar({ rect, focusKey, onConfirm, onRedo, onCancel }: Props): import("react").JSX.Element;
export {};
