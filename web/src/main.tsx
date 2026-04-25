import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

window.addEventListener("pointerdown", (event) => {
  const target = event.target instanceof Element ? event.target.closest("button, .card, .tabs button, .tool-card summary, .thinking-block summary") as HTMLElement | null : null;
  if (!target) return;
  const rect = target.getBoundingClientRect();
  target.style.setProperty("--ripple-x", `${event.clientX - rect.left}px`);
  target.style.setProperty("--ripple-y", `${event.clientY - rect.top}px`);
}, { capture: true });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
