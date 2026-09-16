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
  // only the overlay is built into the binary; the old React settings app
  // (index.html/App.tsx) is retired, ClipLib's Settings > Clipdip page owns config now
  build: {
    rollupOptions: {
      input: {
        overlay: path.resolve(__dirname, "overlay.html"),
      },
    },
  },
});
