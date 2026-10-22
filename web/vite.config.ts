import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The canvas API lives in the FastAPI backend (server/canvas); proxy /api to it in dev.
const API = process.env.AGORA_API_ORIGIN ?? "http://localhost:8000";

// Libraries that change rarely get chunks of their own, so an Agora upgrade re-downloads only its own code. Excalidraw is not
// grouped: a group takes every matching module, and Excalidraw's own lazy chunks (Mermaid import, fonts) would load up front.
const VENDOR = [
  { name: "vendor-react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
  { name: "vendor-motion", test: /node_modules[\\/](motion|framer-motion|motion-dom|motion-utils)[\\/]/ },
];

export default defineConfig({
  plugins: [react()],
  build: { rolldownOptions: { output: { codeSplitting: { groups: VENDOR } } } },
  server: {
    port: 5181,
    strictPort: true,
    proxy: { "/api": { target: API, changeOrigin: false } },
  },
});
