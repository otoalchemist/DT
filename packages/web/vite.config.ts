import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Dashboard dev server. Proxies API + WebSocket to the backend so there's no CORS.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const backend = process.env.BACKEND_URL
    ?? env.BACKEND_URL
    ?? `http://127.0.0.1:${env.PORT || "8787"}`;
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": { target: backend, changeOrigin: true },
        "/ws": { target: backend, ws: true, changeOrigin: true },
      },
    },
  };
});
