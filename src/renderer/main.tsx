import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ToastProvider } from "./ui/Toast";
import { ConfirmProvider } from "./ui/ConfirmDialog";
import { initGridDensity } from "./library/gridDensity";
import "./styles.css";

initGridDensity();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ToastProvider>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ToastProvider>
  </React.StrictMode>,
);
