import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dashboard dev server. Proxies API + WebSocket to the backend so there's no CORS.
const BACKEND = process.env.BACKEND_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true },
      "/ws": { target: BACKEND, ws: true, changeOrigin: true },
    },
  },
});
