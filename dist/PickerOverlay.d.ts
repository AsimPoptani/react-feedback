import type { Highlight } from './usePicker';
interface Props {
    step: 'element' | 'section';
    hover: Highlight | null;
    focusKey: number;
    onConfirm: () => void;
    onRedo: () => void;
    onCancel: () => void;
}
/**
 * Element and Section modes. With nothing locked, focus sits on the picker panel, where Enter
 * selects the hovered target and ↑/↓ change it; a focused app control keeps focus (a global
 * shortcut from the page), since Enter selects that control. A locked target focuses Write note.
 */
export declare function PickerOverlay({ step, hover, focusKey, onConfirm, onRedo, onCancel }: Props): import("react").JSX.Element;
export {};
