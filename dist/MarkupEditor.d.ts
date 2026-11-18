import type { Shot } from './types';
export declare function MarkupEditor({ shot, onSave, onCancel }: {
    shot: Shot;
    onSave: (url: string | null) => void;
    onCancel: () => void;
}): import("react").JSX.Element;
