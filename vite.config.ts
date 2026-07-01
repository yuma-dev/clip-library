import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Renderer-only Vite build (see plan D9). The Electron main process (main.js)
// is untouched and simply loads the dev server in dev, or dist/index.html in
// the packaged app.
export default defineConfig({
  root: path.resolve(__dirname, "src/renderer"),
  // Relative asset URLs so the built index.html works over file:// in prod.
  base: "./",
  plugins: [react(), tailwindcss()],
  server: {
    // Pin to IPv4 so the dev wait-on check and main.js loadURL agree
    // (default `localhost` binding resolves to ::1 on some machines).
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // Allow importing assets from the project root (root is src/renderer).
    fs: { allow: [path.resolve(__dirname)] },
  },
  build: {
    // Separate from electron-builder's own output dir (`dist/`) to avoid
    // the renderer bundle and the packaged installer clobbering each other.
    outDir: path.resolve(__dirname, "renderer-dist"),
    emptyOutDir: true,
  },
});
