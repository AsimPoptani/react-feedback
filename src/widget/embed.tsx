// Drop-in script: <script src=".../embed.js" data-endpoint="/__feedback"></script>
// Mounts the widget on any page, with no build step on the host side.
import { createRoot } from "react-dom/client";
import css from "./feedback.css?inline";
import { FeedbackErrorBoundary } from "./FeedbackErrorBoundary.js";
import FeedbackWidget from "./FeedbackWidget.js";

function mount(endpoint: string) {
  const style = document.createElement("style");
  style.setAttribute("data-react-feedback", "");
  style.textContent = css;
  document.head.append(style);
  const host = document.createElement("div");
  host.setAttribute("data-react-feedback-root", "");
  document.body.append(host);
  createRoot(host).render(
    <FeedbackErrorBoundary>
      <FeedbackWidget endpoint={endpoint} />
    </FeedbackErrorBoundary>,
  );
}

const script = document.currentScript as HTMLScriptElement | null;
const endpoint = script?.dataset.endpoint || "/__feedback";
if (!document.querySelector("[data-react-feedback-root]")) {
  if (document.body) mount(endpoint);
  else document.addEventListener("DOMContentLoaded", () => mount(endpoint), { once: true });
}
