// The capture script a shared (or owner-viewed) artifact page gets: the widget's own region / element / section / page capture, with no launcher and no server.
// The page that framed this one drives it by postMessage and receives the finished capture the same way (see captureBridge). It does nothing until told.
import { createRoot } from "react-dom/client";
import css from "./feedback.css?inline";
import { FeedbackErrorBoundary } from "./FeedbackErrorBoundary.js";
import FeedbackWidget from "./FeedbackWidget.js";
import { createBridge } from "./captureBridge.js";

function mount() {
  if (document.querySelector("[data-react-feedback-root]")) return;
  const style = document.createElement("style");
  style.setAttribute("data-react-feedback", "");
  style.textContent = css;
  document.head.append(style);
  const host = document.createElement("div");
  host.setAttribute("data-react-feedback-root", "");
  document.body.append(host);
  const bridge = createBridge(window);
  createRoot(host).render(
    <FeedbackErrorBoundary>
      <FeedbackWidget bridge={bridge} />
    </FeedbackErrorBoundary>,
  );
  try { parent.postMessage({ rf: "cap-ready" }, "*"); } catch { /* not framed */ }
}

if (window.parent !== window) {
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
}
