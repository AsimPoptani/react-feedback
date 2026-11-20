// The replay player: rrweb-player bundled into dist/player.js (and dist/player.css), served by the feedback server itself.
// It runs in its own page (/__feedback/replay/player) with a strict CSP, and rrweb 2.2 rebuilds a recording only inside an iframe that has no scripts.
import Player from "rrweb-player";
import "rrweb-player/dist/style.css";

interface RawEvent { type: number; timestamp: number; data?: { source?: number; type?: number } }
const CLICK = "#e8590c";

// Adds a timeline marker at each click (rrweb draws custom events of a tag in that tag's colour). The markers change nothing on screen.
export function withClickMarkers(events: RawEvent[]): RawEvent[] {
  const out: RawEvent[] = [];
  for (const event of events) {
    out.push(event);
    if (event.type === 3 && event.data?.source === 2 && event.data.type === 2) out.push({ type: 5, timestamp: event.timestamp, data: { tag: "click", payload: {} } as never });
  }
  return out;
}

export function create(target: HTMLElement, events: RawEvent[], width: number, height: number): void {
  target.replaceChildren();
  // eslint-disable-next-line no-new
  new Player({ target, props: { events: withClickMarkers(events) as never, width, height, autoPlay: false, showController: true, skipInactive: true, tags: { click: CLICK } } });
}

(globalThis as unknown as { RFPlayer?: unknown }).RFPlayer = { create, withClickMarkers };

// On the player page the host (the inbox) sends the events by postMessage; nothing else is believed.
if (typeof document !== "undefined" && document.getElementById("rf-player")) {
  addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { rf?: string; events?: RawEvent[]; width?: number; height?: number } | null;
    if (event.source !== parent || !data || data.rf !== "play" || !Array.isArray(data.events)) return;
    try { create(document.getElementById("rf-player") as HTMLElement, data.events, Math.max(200, Number(data.width) || 600), Math.max(150, Number(data.height) || 400)); }
    catch (error) { parent.postMessage({ rf: "player-error", message: String((error as Error)?.message ?? error) }, "*"); }
  });
  parent.postMessage({ rf: "player-ready" }, "*");
}
