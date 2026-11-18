import type { Rect } from './types';
export declare function RegionPicker({ rect, onChange, onSettle, onCapture, onCancel }: {
    rect: Rect | null;
    onChange: (rect: Rect | null) => void;
    onSettle: (rect: Rect) => void;
    onCapture: (rect: Rect) => void;
    onCancel: () => void;
}): import("react").JSX.Element;
