import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Dashboard dev server. Proxies API + WebSocket to the backend so there's no CORS.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function normalizeProxyHost(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  return trimmed.includes(":") ? `[${trimmed}]` : trimmed;
}

export function defaultBackendUrl(host?: string, port?: string): string {
  const normalizedHost = normalizeProxyHost(host?.trim() || "127.0.0.1");
  return `http://${normalizedHost}:${port?.trim() || "8787"}`;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const backend = process.env.BACKEND_URL
    ?? env.BACKEND_URL
    ?? defaultBackendUrl(process.env.HOST ?? env.HOST, process.env.PORT ?? env.PORT);
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
