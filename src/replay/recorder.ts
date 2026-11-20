// The session recorder: rrweb's `record`, bundled into dist/recorder.js with no CDN. It exposes one global, `RFRecorder.start`.
// It is injected into a shared page, or loaded by the inbox, and it starts only when the host page tells it to.
import { record } from "rrweb";

export interface RecorderOptions {
  /** Called with each rrweb event. */
  emit: (event: unknown) => void;
}

// Inputs are always masked, anything marked data-rf-private is blocked, and mouse moves are sampled every 50 ms.
export function start(options: RecorderOptions): () => void {
  const stop = record({
    emit: options.emit as never,
    maskAllInputs: true,
    blockSelector: "[data-rf-private]",
    sampling: { mousemove: 50, scroll: 150, input: "last" },
    slimDOMOptions: "all",
    recordCanvas: false,
    collectFonts: false,
  });
  return () => { stop?.(); };
}

(globalThis as unknown as { RFRecorder?: unknown }).RFRecorder = { start };
