// The replay player: rrweb-player bundled into dist/player.js (and dist/player.css), served by the feedback server itself.
// It runs in its own page (/__feedback/replay/player) with a strict CSP, and rrweb 2.2 rebuilds a recording only inside an iframe that has no scripts.
import Player from "rrweb-player";
import { Replayer } from "@rrweb/replay";
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

// ---- Live view. The page the recording is recorded on is still sending, and the inbox (which is signed in; this page makes no requests) polls for new events and passes them in here.
// rrweb's live mode plays an event `timestamp - baseline` after the replayer started, so the baseline sits LAG_MS before the newest event it was given: the view runs that far behind,
// which is about one upload (4 s) plus one poll. Whatever is older than the baseline is drawn at once; anything newer plays out at the pace it happened.
export const LAG_MS = 6000;
export const MAX_EVENTS_PER_MESSAGE = 5000;
export const validEvent = (e: unknown): e is RawEvent => !!e && typeof e === "object" && !Array.isArray(e) && Number.isInteger((e as RawEvent).type) && (e as RawEvent).type >= 0 && (e as RawEvent).type <= 6 && typeof (e as RawEvent).timestamp === "number" && Number.isFinite((e as RawEvent).timestamp) && (e as RawEvent).timestamp >= 0;
// A list from the parent: at most MAX_EVENTS_PER_MESSAGE, and only whole events. Anything else in it is dropped.
export const cleanEvents = (list: unknown): RawEvent[] => (Array.isArray(list) ? list.slice(0, MAX_EVENTS_PER_MESSAGE).filter(validEvent) : []);

export interface Live { add(events: RawEvent[]): void; end(): void }
export function createLive(target: HTMLElement, first: RawEvent[], width: number, height: number): Live {
  target.replaceChildren();
  const bar = document.createElement("div");
  bar.className = "rf-live-bar";
  const badge = document.createElement("span");
  badge.className = "rf-live-badge"; badge.textContent = "LIVE";
  const note = document.createElement("span");
  note.className = "rf-live-note"; note.textContent = "a few seconds behind";
  bar.append(badge, note);
  const stage = document.createElement("div");
  stage.className = "rr-player__frame rf-live-stage";
  Object.assign(stage.style, { width: `${width}px`, height: `${height}px`, position: "relative", overflow: "hidden", background: "#fff", margin: "0 auto" });
  target.append(bar, stage);
  const replayer = new Replayer([], { root: stage, liveMode: true, mouseTail: false });
  replayer.on("resize", (d) => {
    const size = d as { width: number; height: number };
    replayer.wrapper.style.transform = `scale(${Math.min(width / size.width, height / size.height, 1)})translate(-50%, -50%)`;
  });
  replayer.startLive(Math.max(0, Math.max(0, ...first.map((e) => e.timestamp)) - LAG_MS));
  for (const e of first) replayer.addEvent(e as never);
  let ended = false;
  return {
    add(events) { if (!ended) for (const e of events) replayer.addEvent(e as never); },
    end() { if (ended) return; ended = true; badge.textContent = "ENDED"; badge.classList.add("rf-ended"); note.textContent = "no new activity"; },
  };
}

(globalThis as unknown as { RFPlayer?: unknown }).RFPlayer = { create, withClickMarkers, createLive };

// On the player page the host (the inbox) sends the events by postMessage; nothing else is believed: the message must come from the page that framed this one, from this page's own origin.
if (typeof document !== "undefined" && document.getElementById("rf-player")) {
  let live: Live | null = null;
  addEventListener("message", (event: MessageEvent) => {
    if (event.source !== parent || event.origin !== location.origin) return;
    const data = event.data as { rf?: string; events?: unknown; width?: number; height?: number } | null;
    if (!data || typeof data !== "object") return;
    const size = { width: Math.max(200, Number(data.width) || 600), height: Math.max(150, Number(data.height) || 400) };
    const root = document.getElementById("rf-player") as HTMLElement;
    try {
      if (data.rf === "play" && Array.isArray(data.events)) create(root, data.events as RawEvent[], size.width, size.height);
      else if (data.rf === "live") live = createLive(root, cleanEvents(data.events), size.width, size.height);
      else if (data.rf === "more" && live) live.add(cleanEvents(data.events));
      else if (data.rf === "ended" && live) live.end();
    } catch (error) { parent.postMessage({ rf: "player-error", message: String((error as Error)?.message ?? error) }, "*"); }
  });
  parent.postMessage({ rf: "player-ready" }, "*");
}
