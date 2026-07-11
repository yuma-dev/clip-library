import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  publicDir: "assets",
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  // Only the notification overlay is built and embedded in the binary. The
  // old React settings app (index.html + src/App.tsx) is retired — ClipLib's
  // Settings → Clipdip page owns configuration now. The source stays in the
  // repo as reference, excluded from the build.
  build: {
    rollupOptions: {
      input: {
        overlay: path.resolve(__dirname, "overlay.html"),
      },
    },
  },
});
