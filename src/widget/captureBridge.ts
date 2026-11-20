// The widget inside a shared or owner-viewed artifact. The page is a sandboxed iframe, so the widget cannot reach the server itself: it hands what was captured
// to the page that framed it, by postMessage, and that page validates and sends it. Nothing here makes a network request.
import { CAPTURE_FAILED } from './draft.js';
import type { Draft } from './draft.js';
import type { Capture, CaptureMode, ElementSource, ElementTarget, Rect } from './types.js';

export const MODES: CaptureMode[] = ['region', 'element', 'section', 'page'];
/** What the iframe tells its parent: a finished capture. */
export interface ShotPayload {
  note: string; mode: CaptureMode; image: string | null; rect: Rect | null; viewport: { width: number; height: number };
  selector: string; text: string; components: string[]; source?: ElementSource; tag?: string; role?: string; name?: string;
}
/** What the parent asks of the iframe. */
export type Command = { op: 'start'; mode: CaptureMode | null; note: string; nonce: string } | { op: 'cancel' };
export interface CaptureBridge {
  send(shot: ShotPayload): void;
  closed(): void;
  /** Registers the handler for the parent's commands; returns a function that removes it. */
  onCommand(handler: (command: Command) => void): () => void;
}

export const DEFAULT_MAX_BYTES = 1_900_000; // a share link takes up to 2 MB decoded
export const MAX_WIDTH = 3000;
export const MAX_HEIGHT = 12000;
const bytesOf = (url: string) => { const at = url.indexOf(','); return at < 0 ? 0 : Math.floor(((url.length - at - 1) * 3) / 4); };

// What a finished draft sends up: the picture (drawn-on if it was), the note, where it was, and the element's names. Words inside private content are already blank.
export function shotPayload(draft: Draft, result: Capture | null, note: string, annotated: string | null): ShotPayload {
  const extra = [result?.clipped, result ? undefined : CAPTURE_FAILED].filter(Boolean).join('\n\n');
  const target = draft.target;
  const element = 'selector' in target ? (target as ElementTarget) : null;
  return {
    note: extra ? `${note}\n\n${extra}` : note, mode: draft.mode, image: result ? annotated ?? result.shot.url : null,
    rect: 'rect' in target ? (target as { rect: Rect }).rect : null, viewport: { width: innerWidth, height: innerHeight },
    selector: element?.selector ?? '', text: element?.text ?? '', components: element?.components ?? [],
    ...(element?.source ? { source: element.source } : {}), ...(element ? { tag: element.tag, role: element.role, name: element.name } : {}),
  };
}

async function load(url: string): Promise<HTMLImageElement> { const image = new Image(); image.src = url; await image.decode(); return image; }
// A picture the parent will accept: no wider or taller than the caps and no more than `maxBytes` decoded. PNG first (it keeps text sharp); when that is too big, JPEG at falling quality
// and then a smaller picture. Never returns something over the cap: the last try is a small JPEG, and if even that is too big the picture is dropped (null) and the note goes alone.
export async function fitImage(url: string, maxBytes = DEFAULT_MAX_BYTES): Promise<string | null> {
  if (!/^data:image\/(png|jpeg);base64,/.test(url)) return null;
  const image = await load(url);
  const fits = image.naturalWidth <= MAX_WIDTH && image.naturalHeight <= MAX_HEIGHT;
  if (fits && bytesOf(url) <= maxBytes && url.startsWith('data:image/png')) return url;
  let scale = Math.min(1, MAX_WIDTH / image.naturalWidth, MAX_HEIGHT / image.naturalHeight);
  for (let attempt = 0; attempt < 10; attempt++) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    if (attempt === 0 && scale === 1 && url.startsWith('data:image/png')) { const png = canvas.toDataURL('image/png'); if (bytesOf(png) <= maxBytes) return png; }
    for (const quality of [0.85, 0.7, 0.5]) { const jpeg = canvas.toDataURL('image/jpeg', quality); if (bytesOf(jpeg) <= maxBytes) return jpeg; }
    scale *= 0.75;
  }
  return null;
}

const asMode = (value: unknown): CaptureMode | null => (typeof value === 'string' && (MODES as string[]).includes(value) ? (value as CaptureMode) : null);
// The parent's command, believed only when it came from the page that framed this one.
export function parseCommand(event: Pick<MessageEvent, 'source' | 'data'>, parentWindow: unknown): Command | null {
  if (event.source !== parentWindow) return null;
  const data = event.data as { rf?: unknown; op?: unknown; mode?: unknown; note?: unknown; nonce?: unknown } | null;
  if (!data || typeof data !== 'object' || data.rf !== 'cap') return null;
  if (data.op === 'cancel') return { op: 'cancel' };
  if (data.op === 'start') return { op: 'start', mode: asMode(data.mode), note: typeof data.note === 'string' ? data.note.slice(0, 4000) : '', nonce: typeof data.nonce === 'string' ? data.nonce.slice(0, 64) : '' };
  return null;
}
const clampBytes = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(100_000, Math.min(8_000_000, Math.floor(value))) : DEFAULT_MAX_BYTES);

// Wires a window to the widget: the commands in, the finished shot out.
export function createBridge(win: Window = window): CaptureBridge {
  let maxBytes = DEFAULT_MAX_BYTES;
  let nonce = ''; // the page's one-time word for the capture it asked for, echoed on what comes back
  const handlers = new Set<(command: Command) => void>();
  const tell = (message: object) => { try { (win.parent as Window).postMessage(message, '*'); } catch { /* the page is gone */ } };
  win.addEventListener('message', event => {
    const command = parseCommand(event, win.parent);
    if (!command) return;
    if (command.op === 'start') { maxBytes = clampBytes((event.data as { maxBytes?: unknown }).maxBytes); nonce = command.nonce; }
    for (const handler of handlers) handler(command);
  });
  return {
    send(shot) {
      void (async () => {
        let image: string | null = null;
        try { image = shot.image ? await fitImage(shot.image, maxBytes) : null; } catch { image = null; }
        const note = shot.image && !image ? `${shot.note}\n\nThe screenshot was too large to send.` : shot.note;
        tell({ rf: 'shot', ...shot, note, image, nonce });
      })();
    },
    closed() { tell({ rf: 'cap-closed' }); },
    onCommand(handler) { handlers.add(handler); return () => { handlers.delete(handler); }; },
  };
}
