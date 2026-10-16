import { defineConfig } from "vite";

// In dev, send /api to the Python server on :8000
export default defineConfig({
  server: { proxy: { "/api": "http://localhost:8000" } },
  build: { chunkSizeWarningLimit: 1200 },
});
