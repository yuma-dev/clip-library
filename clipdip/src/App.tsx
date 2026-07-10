import MainWindow from "./windows/Main";

// The overlay window has its own entry point (`overlay.html` ->
// `src/overlay-entry.tsx`) so it doesn't pay the cost of loading the
// settings UI bundle. This file is only used by the settings window.
export default function App() {
  return <MainWindow />;
}
