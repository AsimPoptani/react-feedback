// Drop-in script: <script src=".../embed.js" data-endpoint="/__feedback"></script>
// Mounts the widget on any page, with no build step on the host side.
import { createRoot } from "react-dom/client";
import css from "./feedback.css?inline";
import { FeedbackErrorBoundary } from "./FeedbackErrorBoundary.js";
import FeedbackWidget, { positionOf, type LauncherPosition } from "./FeedbackWidget.js";

function mount(endpoint: string, position: LauncherPosition, hints: 'on' | 'off') {
  const style = document.createElement("style");
  style.setAttribute("data-react-feedback", "");
  style.textContent = css;
  document.head.append(style);
  const host = document.createElement("div");
  host.setAttribute("data-react-feedback-root", "");
  document.body.append(host);
  createRoot(host).render(
    <FeedbackErrorBoundary>
      <FeedbackWidget endpoint={endpoint} position={position} hints={hints} />
    </FeedbackErrorBoundary>,
  );
}

const script = document.currentScript as HTMLScriptElement | null;
const endpoint = script?.dataset.endpoint || "/__feedback";
const position = positionOf(script?.dataset.position);
const hints = script?.dataset.hints === "on" ? "on" : "off";
if (!document.querySelector("[data-react-feedback-root]")) {
  if (document.body) mount(endpoint, position, hints);
  else document.addEventListener("DOMContentLoaded", () => mount(endpoint, position, hints), { once: true });
}
