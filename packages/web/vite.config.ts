import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dashboard dev server. Proxies API + WebSocket to the backend so there's no CORS.
const BACKEND = process.env.BACKEND_URL ?? "http://127.0.0.1:8787";
const SECURITY_HEADERS = {
  // A hostile site must not be able to frame the localhost dashboard and turn a
  // legitimate same-origin session into clickjacking-driven wallet actions.
  "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    headers: SECURITY_HEADERS,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true },
      "/ws": { target: BACKEND, ws: true, changeOrigin: true },
    },
  },
  preview: {
    headers: SECURITY_HEADERS,
  },
});
