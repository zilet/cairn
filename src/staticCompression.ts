import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { NextFunction, Request, Response } from "express";

// Compressed transfer WITHOUT a new dependency and without spending Raspberry Pi
// CPU on the same 2.7 MB of app shell over and over.
//
// Two halves, deliberately different:
//   - Static shell: `scripts/build-client.mjs` writes a `.br` (quality 11) and a
//     `.gz` (level 9) sibling next to every asset index.html loads, at BUILD time.
//     precompressedStatic() hands the browser that sibling when Accept-Encoding
//     allows it, so the expensive compression is paid once per deploy, never per
//     request. Mounted in front of express.static, which still serves the raw
//     bytes to anything that cannot decode (and every asset we do not precompress).
//   - JSON bodies: gzipped at RUNTIME above ~1 KB (jsonCompression). These are
//     dynamic, so there is nothing to precompute; the bodies are small (tens of
//     KB) and gzip on them is cheap next to the query work that produced them.
//
// text/event-stream is never touched: SSE routes write through res.write(), not
// res.json(), so they fall outside this wrapper by construction — and the
// content-type guard below keeps it that way even if one ever calls res.json().

/** Encodings we can serve, in server-preference order (best ratio first). */
const STATIC_ENCODINGS: ReadonlyArray<{ name: "br" | "gzip"; ext: string }> = [
  { name: "br", ext: ".br" },
  { name: "gzip", ext: ".gz" },
];

/**
 * Content types by extension. Doubles as the allowlist: a path whose extension is
 * absent here is never served from a sibling file, so no unexpected artifact can
 * be reached through this middleware.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=UTF-8",
  ".css": "text/css; charset=UTF-8",
  ".html": "text/html; charset=UTF-8",
  ".json": "application/json; charset=UTF-8",
  ".svg": "image/svg+xml",
};

/**
 * Paths that must keep express.static's own Cache-Control contract (`no-cache`, so
 * a bumped worker/manifest is never served stale). We do not precompress them, but
 * the guard is explicit rather than incidental.
 */
const NEVER_PRECOMPRESSED = new Set(["/sw.js", "/manifest.json"]);

/** Bodies below this stay uncompressed: the gzip header costs more than it saves. */
export const MIN_JSON_COMPRESS_BYTES = 1024;

/**
 * The acceptable encodings from an Accept-Encoding header, best first.
 * Honours q-values (`;q=0` means "refused") and the `*` wildcard. Pure and
 * exported so the contract is unit-testable without a socket.
 */
export function acceptedEncodings(header: string | string[] | undefined, offered: readonly string[]): string[] {
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (!raw) return [];
  const quality = new Map<string, number>();
  for (const part of raw.split(",")) {
    const [token, ...params] = part.trim().split(";");
    const name = token.trim().toLowerCase();
    if (!name) continue;
    let q = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param);
      if (match) q = Number.parseFloat(match[1]);
    }
    if (!Number.isFinite(q)) q = 0;
    quality.set(name, q);
  }
  const wildcard = quality.get("*");
  const scored = offered
    .map((name) => ({ name, q: quality.has(name) ? (quality.get(name) as number) : (wildcard ?? 0) }))
    .filter((entry) => entry.q > 0);
  // Stable sort keeps `offered` order as the tie-break, i.e. our own preference.
  scored.sort((a, b) => b.q - a.q);
  return scored.map((entry) => entry.name);
}

/** Weak ETag for a stored representation. Weak because encoding, not bytes, varies. */
function fileEtag(stat: fs.Stats, encoding: string): string {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}-${encoding}"`;
}

/** RFC 9110 If-None-Match: `*` matches anything, otherwise a weak comparison. */
function ifNoneMatchHits(header: string | string[] | undefined, etag: string): boolean {
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (!raw) return false;
  if (raw.trim() === "*") return true;
  const bare = (value: string) => value.trim().replace(/^W\//, "");
  return raw.split(",").some((candidate) => bare(candidate) === bare(etag));
}

/**
 * Serve `<asset>.br` / `<asset>.gz` when the client accepts it. Falls through to
 * the next handler (express.static) for anything without a matching sibling, so
 * an un-precompressed asset, a HEAD of a missing file, and every non-GET request
 * behave exactly as before.
 */
export function precompressedStatic(publicDir: string) {
  const root = path.resolve(publicDir);
  return function servePrecompressed(req: Request, res: Response, next: NextFunction): void {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url, "http://cairn.invalid").pathname);
    } catch {
      next();
      return;
    }
    if (pathname.includes("\0")) {
      next();
      return;
    }
    if (pathname.endsWith("/")) pathname += "index.html";
    if (NEVER_PRECOMPRESSED.has(pathname)) {
      next();
      return;
    }

    const type = CONTENT_TYPES[path.extname(pathname).toLowerCase()];
    if (!type) {
      next();
      return;
    }

    const filePath = path.resolve(root, `.${pathname}`);
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      next();
      return;
    }

    // Pick the best encoding the client accepts that we actually have on disk, so
    // a br-only build still serves gzip clients and vice versa.
    const accepted = acceptedEncodings(req.headers["accept-encoding"], ["br", "gzip"]);
    // A sibling is only an answer while it still represents its source. public/
    // index.html and styles.css are hand-authored and NOT regenerated by
    // `tsx watch`, so an edit leaves a stale .br/.gz beside a newer original —
    // serving that would ship yesterday's page. An older sibling counts as absent
    // and the request falls through to express.static, which serves the source.
    let sourceMtimeMs: number | null = null;
    try {
      const sourceStat = fs.statSync(filePath);
      if (sourceStat.isFile()) sourceMtimeMs = sourceStat.mtimeMs;
    } catch {
      // No original on disk (a build shipping only the compressed form) — then
      // there is nothing the sibling can be stale against.
    }
    let chosen: { name: string; file: string; stat: fs.Stats } | null = null;
    let anySibling = false;
    for (const candidate of STATIC_ENCODINGS) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath + candidate.ext);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (sourceMtimeMs != null && stat.mtimeMs < sourceMtimeMs) continue;
      anySibling = true;
      if (!chosen && accepted.includes(candidate.name)) {
        chosen = { name: candidate.name, file: filePath + candidate.ext, stat };
      }
    }
    // Vary even on the fallback: the raw response for this url is one of several
    // representations, and a cache that stored it must not reuse it for a client
    // that would have got brotli.
    if (anySibling) res.setHeader("Vary", "Accept-Encoding");
    if (!chosen) {
      next();
      return;
    }

    const etag = fileEtag(chosen.stat, chosen.name);
    res.setHeader("Content-Type", type);
    res.setHeader("Content-Encoding", chosen.name);
    res.setHeader("Cache-Control", "public, max-age=0");
    res.setHeader("Last-Modified", chosen.stat.mtime.toUTCString());
    res.setHeader("ETag", etag);

    if (ifNoneMatchHits(req.headers["if-none-match"], etag)) {
      res.removeHeader("Content-Type");
      res.removeHeader("Content-Encoding");
      res.status(304).end();
      return;
    }

    res.setHeader("Content-Length", String(chosen.stat.size));
    if (req.method === "HEAD") {
      res.status(200).end();
      return;
    }

    const stream = fs.createReadStream(chosen.file);
    stream.on("error", () => {
      // Raced with a rebuild that replaced the sibling. Nothing is written yet, so
      // fail the response rather than serve a truncated body.
      if (!res.headersSent) res.status(500);
      res.end();
    });
    stream.pipe(res);
  };
}

/**
 * gzip JSON bodies above MIN_JSON_COMPRESS_BYTES when the client accepts gzip.
 * Wraps res.json only — SSE, file sends and already-encoded bodies pass through
 * untouched — and preserves the weak-ETag/304 behaviour express gives res.json,
 * so a repeat GET of unchanged data still costs one empty response.
 */
export function jsonCompression(req: Request, res: Response, next: NextFunction): void {
  if (!acceptedEncodings(req.headers["accept-encoding"], ["gzip"]).length) {
    next();
    return;
  }

  const originalJson = res.json.bind(res);
  res.json = function compressedJson(body?: unknown): Response {
    try {
      if (res.headersSent || res.getHeader("Content-Encoding")) return originalJson(body);
      const declared = String(res.getHeader("Content-Type") || "").toLowerCase();
      if (declared && !declared.startsWith("application/json")) return originalJson(body);

      const payload = JSON.stringify(body);
      if (typeof payload !== "string") return originalJson(body);
      const raw = Buffer.from(payload, "utf8");
      if (raw.length < MIN_JSON_COMPRESS_BYTES) return originalJson(body);

      // ETag over the UNCOMPRESSED body (so it tracks the data, not the encoder),
      // tagged with the encoding because the stored representation differs.
      const digest = crypto.createHash("sha1").update(raw).digest("base64").slice(0, 27);
      const etag = `W/"${raw.length.toString(16)}-${digest}-gzip"`;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Vary", "Accept-Encoding");
      res.setHeader("ETag", etag);

      if (ifNoneMatchHits(req.headers["if-none-match"], etag)) {
        res.removeHeader("Content-Type");
        res.status(304).end();
        return res;
      }

      zlib.gzip(raw, (error, compressed) => {
        if (res.writableEnded) return;
        if (error) {
          // Never lose the response to a compression failure: send it plain.
          res.setHeader("Content-Length", String(raw.length));
          res.end(raw);
          return;
        }
        res.setHeader("Content-Encoding", "gzip");
        res.setHeader("Content-Length", String(compressed.length));
        res.end(req.method === "HEAD" ? undefined : compressed);
      });
      return res;
    } catch {
      return originalJson(body);
    }
  } as typeof res.json;

  next();
}
