import type { getContext } from './context.js';
import type { Capture, CaptureMode, Target } from './types.js';
/** The open note. Its capture runs in the background: `capture` fills in when it lands, `failed` if it never will. */
export interface Draft {
  mode: CaptureMode; target: Target; context: ReturnType<typeof getContext>;
  pending: Promise<Capture>; capture: Capture | null; failed: boolean;
}
// A 1x1 transparent PNG: the inbox needs an image, so a failed capture still sends the text.
const BLANK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
export const CAPTURE_FAILED = 'Screenshot capture failed, so this note has no picture.';
export function feedbackBody(draft: Draft, result: Capture | null, note: string, annotated: string | null, live: { console: unknown; failedFetches: unknown }) {
  const extra = [result?.clipped, result ? undefined : CAPTURE_FAILED].filter(Boolean).join('\n\n');
  return {
    note: extra ? `${note}\n\n${extra}` : note,
    mode: draft.mode, target: draft.target, image: result?.shot.url ?? BLANK,
    ...(annotated ? { annotated } : {}), ...(result?.contextImage ? { context_image: result.contextImage } : {}),
    context: { ...draft.context, console: live.console, failedFetches: live.failedFetches },
  };
}
