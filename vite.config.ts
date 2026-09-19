import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages deploy friendly: relative base so it works under /<repo>/
export default defineConfig({
  plugins: [react()],
  base: "./",
  worker: {
    format: "es",
  },
  build: {
    target: "esnext",
    chunkSizeWarningLimit: 4096,
  },
});