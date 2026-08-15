import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIME_BY_EXT: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export const DASHBOARD_SECURITY_HEADERS = {
  "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

const MISSING_DASHBOARD_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Death &amp; Taxes Bot</title>
  </head>
  <body>
    <h1>Death &amp; Taxes Bot</h1>
    <p>The API is running on this port, but the dashboard bundle is not here.</p>
    <p>In development, open <a href="http://localhost:5173/">http://localhost:5173</a>.</p>
    <p>After <code>npm run build</code>, restart to serve the dashboard from this address.</p>
  </body>
</html>
`;

/** `packages/web/dist`, resolved from either `src/` or compiled `dist/`. */
export function defaultDashboardRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
}

export function dashboardIndexExists(root = defaultDashboardRoot()): boolean {
  try {
    return fs.statSync(path.join(root, "index.html")).isFile();
  } catch {
    return false;
  }
}

/**
 * Map a request path onto a file under `root`. Returns null for traversal,
 * directories, missing files, or extensions the dashboard never serves.
 */
export function resolveDashboardAsset(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || decoded.includes("\0") || decoded.includes("\\")) return null;

  const relative = decoded === "/" ? "index.html" : decoded.slice(1);
  const parts = relative.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;

  const rootResolved = path.resolve(root);
  const resolved = path.resolve(rootResolved, relative);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return null;

  const ext = path.extname(resolved).toLowerCase();
  if (!MIME_BY_EXT[ext]) return null;

  try {
    if (!fs.statSync(resolved).isFile()) return null;
  } catch {
    return null;
  }
  return resolved;
}

function applyDashboardHeaders(reply: FastifyReply, filePath: string): FastifyReply {
  const ext = path.extname(filePath).toLowerCase();
  const hashedAsset = ext !== ".html" && ext !== ".map";
  void reply.headers({
    ...DASHBOARD_SECURITY_HEADERS,
    "Cache-Control": hashedAsset ? "public, max-age=31536000, immutable" : "no-store",
  });
  return reply.type(MIME_BY_EXT[ext] ?? "application/octet-stream");
}

function sendRouteNotFound(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const route = req.url.split("?", 1)[0] ?? "/";
  return reply.code(404).send({
    message: `Route ${req.method}:${route} not found`,
    error: "Not Found",
    statusCode: 404,
  });
}

export function registerDashboard(app: FastifyInstance, root = defaultDashboardRoot()): void {
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendRouteNotFound(req, reply);
    }

    const urlPath = req.url.split("?", 1)[0] ?? "/";
    if (urlPath === "/ws" || urlPath.startsWith("/api/") || urlPath === "/api") {
      return sendRouteNotFound(req, reply);
    }

    const filePath = resolveDashboardAsset(root, urlPath);
    if (filePath) {
      applyDashboardHeaders(reply, filePath);
      return req.method === "HEAD" ? reply.code(200).send() : reply.send(fs.readFileSync(filePath));
    }

    if (urlPath === "/" || urlPath === "/index.html") {
      void reply.headers({ ...DASHBOARD_SECURITY_HEADERS, "Cache-Control": "no-store" });
      return reply.type("text/html; charset=utf-8").code(200).send(MISSING_DASHBOARD_HTML);
    }

    return sendRouteNotFound(req, reply);
  });
}
