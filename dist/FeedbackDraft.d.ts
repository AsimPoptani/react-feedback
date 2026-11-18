import type { Rect, Shot } from './types.js';
interface Props {
    note: string;
    shot: Shot | null;
    failed: boolean;
    annotated: string | null;
    clipped?: string;
    rect?: Rect;
    onNote: (value: string) => void;
    onEdit: () => void;
    onSave: () => void;
    onCancel: () => void;
}
export declare function FeedbackDraft(props: Props): import("react").JSX.Element;
export {};
