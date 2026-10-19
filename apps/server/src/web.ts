import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

type Lookup = (rel: string) => Buffer | null;

/** Static dashboard files from the Next.js export (WEB_DIR, default apps/web/out). */
function webSource(): Lookup | null {
  const root = [process.env.WEB_DIR, "apps/web/out", "../web/out"]
    .filter((d): d is string => Boolean(d))
    .map((d) => path.resolve(d))
    .find((d) => fs.existsSync(path.join(d, "index.html")));
  if (!root) return null;
  return (rel) => {
    const file = path.join(root, rel);
    if (!file.startsWith(root + path.sep)) return null;
    try {
      return fs.statSync(file).isFile() ? fs.readFileSync(file) : null;
    } catch {
      return null;
    }
  };
}

export function registerStatic(app: FastifyInstance) {
  const lookup = webSource();
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== "GET" && req.method !== "HEAD") return reply.code(404).send({ error: "Not found" });
    const url = new URL(req.url, "http://local");
    let pathname: string;
    let rawPath: string;
    try {
      pathname = decodeURIComponent(url.pathname);
      rawPath = decodeURIComponent(req.url.split("?")[0]);
    } catch {
      return reply.code(400).send({ error: "Bad path" });
    }
    // Check the raw path too: the URL parser silently resolves "/%2e%2e/" segments.
    if ([rawPath, pathname].some((p) => p.includes("..") || p.includes("\\") || p.includes("\0"))) {
      return reply.code(400).send({ error: "Bad path" });
    }
    if (pathname.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
    if (!lookup) return reply.code(404).type("text/plain").send("Dashboard files not found. Run `npm run build:web` first.");
    const rel = pathname.slice(1);
    if (rel && !pathname.endsWith("/") && !path.extname(rel) && lookup(`${rel}/index.html`)) {
      return reply.redirect(`${pathname}/${url.search}`, 308);
    }
    const file = pathname.endsWith("/") ? `${rel}index.html` : rel;
    const body = lookup(file);
    reply.header("X-Content-Type-Options", "nosniff");
    if (!body) {
      const notFound = lookup("404.html");
      return reply.code(404).header("Cache-Control", "no-cache").type(TYPES[".html"]).send(notFound ?? "Not found");
    }
    reply.header("Cache-Control", pathname.startsWith("/_next/static/") ? "public, max-age=31536000, immutable" : "no-cache");
    return reply.type(TYPES[path.extname(file)] ?? "application/octet-stream").send(body);
  });
}
