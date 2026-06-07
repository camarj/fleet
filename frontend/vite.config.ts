import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Fixed dev port so the Tauri shell can point at it deterministically.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
});
