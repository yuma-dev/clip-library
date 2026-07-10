/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          base:    "#0a0a0c",
          surface: "#13131a",
          raised:  "#1c1c27",
          border:  "#2a2a3a",
        },
        accent: {
          DEFAULT: "#00b5c3",
          hover:   "#00cad9",
          muted:   "#00b5c333",
        },
        text: {
          DEFAULT: "#e2e8f0",
          muted:   "#8892a4",
          faint:   "#4a5568",
        },
        success: "#22c55e",
        danger:  "#ef4444",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
      },
      boxShadow: {
        glow:       "0 0 20px 0 rgba(124,58,237,0.25)",
        "glow-sm":  "0 0 8px 0 rgba(124,58,237,0.18)",
        card:       "0 4px 24px 0 rgba(0,0,0,0.5)",
      },
      keyframes: {
        "slide-in-right":  { from: { transform: "translateX(120%)", opacity: "0" }, to: { transform: "translateX(0)", opacity: "1" } },
        "slide-in-left":   { from: { transform: "translateX(-120%)", opacity: "0" }, to: { transform: "translateX(0)", opacity: "1" } },
        "slide-out-right": { from: { transform: "translateX(0)", opacity: "1" }, to: { transform: "translateX(120%)", opacity: "0" } },
        "slide-out-left":  { from: { transform: "translateX(0)", opacity: "1" }, to: { transform: "translateX(-120%)", opacity: "0" } },
        "fade-in":         { from: { opacity: "0" }, to: { opacity: "1" } },
      },
      animation: {
        "slide-in-right":  "slide-in-right 0.4s cubic-bezier(0.34,1.56,0.64,1) both",
        "slide-in-left":   "slide-in-left  0.4s cubic-bezier(0.34,1.56,0.64,1) both",
        "slide-out-right": "slide-out-right 0.3s ease-in both",
        "slide-out-left":  "slide-out-left  0.3s ease-in both",
        "fade-in":         "fade-in 0.2s ease both",
      },
    },
  },
  plugins: [],
};
