import MainWindow from "./windows/Main";

// overlay.html/overlay-entry.tsx is a separate entry point so the overlay
// doesn't load the settings UI bundle; this file is only for the settings window
export default function App() {
  return <MainWindow />;
}
