import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The canvas API lives in the FastAPI backend (server/canvas); proxy /api to it in dev.
const API = process.env.AGORA_API_ORIGIN ?? "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5181,
    strictPort: true,
    proxy: { "/api": { target: API, changeOrigin: false } },
  },
});
