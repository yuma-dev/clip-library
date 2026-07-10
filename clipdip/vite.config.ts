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
  // Two entry points so the overlay window doesn't have to download +
  // parse the settings UI bundle (lucide-react, Tailwind, Radix, etc.)
  // before it can render. In dev mode each entry has its own module
  // graph too, so Vite only transforms what each window actually needs.
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        overlay: path.resolve(__dirname, "overlay.html"),
      },
    },
  },
});
