import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Inject a no-op Tauri shim when running in plain browser (dev preview).
// In production the real Tauri webview provides __TAURI_INTERNALS__.
if (!("__TAURI_INTERNALS__" in window)) {
  (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = {
    invoke: () => Promise.reject(new Error("not in Tauri")),
    transformCallback: (cb: unknown) => cb,
    metadata: { currentWindow: { label: "main" }, windows: [] },
  };
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
