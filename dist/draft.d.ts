import type { getContext } from './context.js';
import type { Capture, CaptureMode, Target } from './types.js';
/** The open note. Its capture runs in the background: `capture` fills in when it lands, `failed` if it never will. */
export interface Draft {
    mode: CaptureMode;
    target: Target;
    context: ReturnType<typeof getContext>;
    pending: Promise<Capture>;
    capture: Capture | null;
    failed: boolean;
}
export declare const CAPTURE_FAILED = "Screenshot capture failed, so this note has no picture.";
export declare function feedbackBody(draft: Draft, result: Capture | null, note: string, annotated: string | null, live: {
    console: unknown;
    failedFetches: unknown;
}): {
    context: {
        console: unknown;
        failedFetches: unknown;
        url: string;
        title: string;
        route: string;
        viewport: {
            width: number;
            height: number;
        };
        scroll: {
            x: number;
            y: number;
        };
        devicePixelRatio: number;
        userAgent: string;
        'prefers-color-scheme': string;
        ts: string;
    };
    context_image?: string | undefined;
    annotated?: string | undefined;
    note: string;
    mode: CaptureMode;
    target: Target;
    image: string;
};
