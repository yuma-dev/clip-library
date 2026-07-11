// Debug-only UI helpers ported from the legacy renderer's debug-tools.js:
//   • window.loadingScreenTest.{show,hide,toggle}() + Ctrl/Cmd+Shift+L — previews
//     the startup loading screen in-renderer (the real splash is a separate
//     main-process window, splash.html, so this mirrors its look for eyeballing).
//   • F6 — toggles the secret easter-egg overlay.
// Registered once from App on mount; returns a disposer that removes listeners
// and any injected overlays.
import titleUrl from "../../../assets/title.png";

const LOADING_ID = "loading-screen-test";
const SECRET_ID = "secret-overlay-test";
const SECRET_IMG = "https://i.pinimg.com/736x/db/95/e1/db95e1ed08f7009ee11afbe79b4857a3.jpg";

function buildLoadingScreen(): HTMLElement {
  const el = document.createElement("div");
  el.id = LOADING_ID;
  // Mirrors splash.html: centered title logo above a sweeping progress bar on a
  // near-opaque backdrop. Inline styles keep this self-contained (no CSS file).
  Object.assign(el.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483646",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#050608",
    transition: "opacity 300ms ease",
    opacity: "1",
  } satisfies Partial<CSSStyleDeclaration>);
  el.innerHTML = `
    <style>
      @keyframes ls-test-sweep { 0% { transform: translateX(-115%); } 72%, 100% { transform: translateX(115%); } }
    </style>
    <div style="display:flex;flex-direction:column;align-items:center;gap:28px;">
      <img src="${titleUrl}" alt="ClipLib" draggable="false"
        style="width:140px;height:140px;object-fit:contain;filter:drop-shadow(0 4px 16px rgba(0,0,0,0.9));" />
      <div style="width:200px;height:2px;border-radius:999px;background:rgba(255,255,255,0.15);overflow:hidden;">
        <span style="display:block;width:100%;height:100%;transform:translateX(-115%);
          background:linear-gradient(90deg,transparent,rgba(255,255,255,0.85),transparent);
          animation:ls-test-sweep 1.8s cubic-bezier(0.22,1,0.36,1) infinite;"></span>
      </div>
    </div>`;
  return el;
}

const loadingScreenTest = {
  show(): void {
    let el = document.getElementById(LOADING_ID);
    if (!el) {
      el = buildLoadingScreen();
      document.body.appendChild(el);
      void el.offsetHeight; // force reflow so a subsequent fade would animate
    } else {
      el.style.display = "flex";
      el.style.opacity = "1";
    }
  },
  hide(): void {
    const el = document.getElementById(LOADING_ID);
    if (!el) return;
    el.style.opacity = "0";
    window.setTimeout(() => {
      el.style.display = "none";
    }, 1000);
  },
  toggle(): void {
    const el = document.getElementById(LOADING_ID);
    if (!el || el.style.display === "none" || el.style.opacity === "0") loadingScreenTest.show();
    else loadingScreenTest.hide();
  },
};

function toggleSecretOverlay(): void {
  let el = document.getElementById(SECRET_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = SECRET_ID;
    Object.assign(el.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      pointerEvents: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    const img = document.createElement("img");
    img.src = SECRET_IMG;
    img.alt = "";
    Object.assign(img.style, {
      maxHeight: "70vh",
      maxWidth: "90vw",
      objectFit: "contain",
      borderRadius: "8px",
      boxShadow: "0 0 60px rgba(255,255,255,0.1)",
    } satisfies Partial<CSSStyleDeclaration>);
    el.appendChild(img);
    document.body.appendChild(el);
    return;
  }
  el.style.display = el.style.display === "none" ? "flex" : "none";
}

/** Install the debug hooks. Returns a disposer for cleanup. */
export function installDebugTools(): () => void {
  (window as unknown as { loadingScreenTest: typeof loadingScreenTest }).loadingScreenTest =
    loadingScreenTest;

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l") {
      loadingScreenTest.toggle();
    } else if (e.key === "F6") {
      toggleSecretOverlay();
    }
  };
  document.addEventListener("keydown", onKeyDown);

  return () => {
    document.removeEventListener("keydown", onKeyDown);
    document.getElementById(LOADING_ID)?.remove();
    document.getElementById(SECRET_ID)?.remove();
  };
}
