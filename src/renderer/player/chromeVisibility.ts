// when the player chrome shows. one rule set: any activity (key, mouse movement, clip open,
// legacy's player-activity event) shows it and arms a timer; the timer hides it unless the
// video is paused, the pointer is over chrome, or a drag is in progress, in which case it
// re-arms. legacy no longer touches the visible class.

const IDLE_MS = 1800;
const CHROME = "#video-controls .pl-pill, .video-nav-button, #audio-tracks-panel, .volume-drag-control";

export function installChromeVisibility(): () => void {
  const controls = document.getElementById("video-controls");
  const overlay = document.getElementById("player-overlay");
  const video = document.getElementById("video-player") as HTMLVideoElement | null;
  if (!controls || !overlay || !video) return () => {};

  let timer: number | undefined;
  let hoverChrome = false;
  let interacting = false;
  let last = { x: -1, y: -1 };

  const hide = () => {
    controls.classList.remove("visible");
  };
  const arm = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (video.paused || hoverChrome || interacting) arm();
      else hide();
    }, IDLE_MS);
  };
  const show = () => {
    controls.classList.add("visible");
    arm();
  };

  // chromium fires a synthetic mousemove when the cursor style changes under a still pointer
  // (hiding the chrome hides the cursor), so only real movement counts
  const onMove = (e: MouseEvent) => {
    if (e.clientX === last.x && e.clientY === last.y) return;
    last = { x: e.clientX, y: e.clientY };
    show();
  };
  const onOver = (e: MouseEvent) => {
    hoverChrome = !!(e.target as HTMLElement).closest(CHROME);
  };
  const onDown = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest(CHROME)) interacting = true;
  };
  const onUp = () => {
    if (!interacting) return;
    interacting = false;
    arm();
  };
  const onKey = () => {
    if (document.body.classList.contains("player-open")) show();
  };
  const onActivity = () => show();
  const onPause = () => show();
  const onPlay = () => arm();

  overlay.addEventListener("mousemove", onMove);
  overlay.addEventListener("mouseover", onOver);
  overlay.addEventListener("mouseleave", () => {
    hoverChrome = false;
  });
  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("mouseup", onUp, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("player-activity", onActivity);
  document.addEventListener("clip-open-state", onActivity);
  video.addEventListener("pause", onPause);
  video.addEventListener("play", onPlay);

  return () => {
    window.clearTimeout(timer);
    overlay.removeEventListener("mousemove", onMove);
    overlay.removeEventListener("mouseover", onOver);
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("mouseup", onUp, true);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("player-activity", onActivity);
    document.removeEventListener("clip-open-state", onActivity);
    video.removeEventListener("pause", onPause);
    video.removeEventListener("play", onPlay);
  };
}
