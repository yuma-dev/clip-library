import MainWindow from "./windows/Main";
import OverlayWindow from "./windows/Overlay";

const isOverlay = new URLSearchParams(window.location.search).get("overlay") === "1";

export default function App() {
  return isOverlay ? <OverlayWindow /> : <MainWindow />;
}
