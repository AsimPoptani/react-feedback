import type { Draft } from './draft.js';
import type { Capture, CaptureMode, ElementSource, Rect } from './types.js';
export declare const MODES: CaptureMode[];
/** What the iframe tells its parent: a finished capture. */
export interface ShotPayload {
    note: string;
    mode: CaptureMode;
    image: string | null;
    rect: Rect | null;
    viewport: {
        width: number;
        height: number;
    };
    selector: string;
    text: string;
    components: string[];
    source?: ElementSource;
    tag?: string;
    role?: string;
    name?: string;
}
/** What the parent asks of the iframe. */
export type Command = {
    op: 'start';
    mode: CaptureMode | null;
    note: string;
    nonce: string;
} | {
    op: 'cancel';
};
export interface CaptureBridge {
    send(shot: ShotPayload): void;
    closed(): void;
    /** Registers the handler for the parent's commands; returns a function that removes it. */
    onCommand(handler: (command: Command) => void): () => void;
}
export declare const DEFAULT_MAX_BYTES = 1900000;
export declare const MAX_WIDTH = 3000;
export declare const MAX_HEIGHT = 12000;
export declare function shotPayload(draft: Draft, result: Capture | null, note: string, annotated: string | null): ShotPayload;
export declare function fitImage(url: string, maxBytes?: number): Promise<string | null>;
export declare function parseCommand(event: Pick<MessageEvent, 'source' | 'data'>, parentWindow: unknown): Command | null;
export declare function createBridge(win?: Window): CaptureBridge;
