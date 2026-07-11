// Drives the shared #export-toast markup (rendered once, at document level, by
// VideoPlayer). Both player exports and grid context-menu exports feed it, so
// the imperative DOM logic lives here rather than inside the player component.
import type { ProgressFn } from "./playerExport";

// One toast, one dismiss timer — a module-level handle is enough.
let exportTimer: number | undefined;

/** (current, total, isClipboard) — mirrors the legacy showExportProgress. */
export const showExportProgress: ProgressFn = (current, total, clipboard = false) => {
  const toastEl = document.getElementById("export-toast");
  const content = toastEl?.querySelector(".export-toast-content") as HTMLElement | null;
  const title = toastEl?.querySelector(".export-title") as HTMLElement | null;
  const progressText = toastEl?.querySelector(".export-progress-text") as HTMLElement | null;
  if (!toastEl || !content || !title || !progressText) return;

  toastEl.classList.add("show");
  const pct = Math.min(Math.round((current / total) * 100), 100);
  content.style.setProperty("--progress", `${pct}%`);
  progressText.textContent = `${pct}%`;

  if (pct >= 100) {
    content.classList.add("complete");
    title.textContent = clipboard ? "Copied to clipboard!" : "Export complete!";
    window.clearTimeout(exportTimer);
    exportTimer = window.setTimeout(() => {
      toastEl.classList.remove("show");
      window.setTimeout(() => {
        title.textContent = "Exporting...";
        content.style.setProperty("--progress", "0%");
        progressText.textContent = "0%";
        content.classList.remove("complete");
      }, 300);
    }, 3000);
  } else {
    title.textContent = "Exporting...";
    content.classList.remove("complete");
  }
};

/** Hide + reset the export toast (on error). */
export function hideExportProgress(): void {
  const toastEl = document.getElementById("export-toast");
  const content = toastEl?.querySelector(".export-toast-content") as HTMLElement | null;
  window.clearTimeout(exportTimer);
  toastEl?.classList.remove("show");
  content?.classList.remove("complete");
  content?.style.setProperty("--progress", "0%");
}
