import "@fontsource-variable/inter";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ToastProvider } from "./ui/Toast";
import { ConfirmProvider } from "./ui/ConfirmDialog";
import { initGridDensity } from "./library/gridDensity";
import { initGlowTuner } from "./library/glowConfig";
import "./styles.css";

initGridDensity();
initGlowTuner();

// NOTE: no <React.StrictMode> — it double-mounts in dev, which breaks the
// wrapped legacy player's one-time imperative init against a stable DOM (D1).
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ToastProvider>
    <ConfirmProvider>
      <App />
    </ConfirmProvider>
  </ToastProvider>,
);
