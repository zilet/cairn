import { Router } from "express";
import fs from "node:fs";
import * as repo from "../repo.js";
import { isArtKind, cachedArtPath, requestArt, warmArt, artManifest } from "../art.js";

export const artRouter = Router();

// ---- generated artwork (Gemini image cache; see src/art.ts) ----
// Cache hit -> the cached image, immutable-cached. Miss -> 204 immediately and a
// background generation is queued when generation is available; the client simply
// retries later. No key / disabled / known-failed also returns 204.
artRouter.get("/art", (req, res) => {
  const kind = String(req.query.kind ?? "");
  const q = String(req.query.q ?? "").trim();
  if (!isArtKind(kind)) return res.status(400).json({ error: "kind must be food|exercise|activity" });
  if (!q || q.length > 200) return res.status(400).json({ error: "q required, max 200 chars" });

  const file = cachedArtPath(kind, q);
  if (file) {
    // Gemini may hand back JPEG bytes even though we cache as .png. Declare the
    // real format from magic bytes so nosniff stays honest.
    let mime = "image/png";
    try {
      const fd = fs.openSync(file, "r");
      const head = Buffer.alloc(3);
      fs.readSync(fd, head, 0, 3, 0);
      fs.closeSync(fd);
      if (head[0] === 0xff && head[1] === 0xd8) mime = "image/jpeg";
      else if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46) mime = "image/webp";
    } catch {}
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return fs
      .createReadStream(file)
      .on("error", () => {
        if (!res.headersSent) res.status(500).json({ error: "read failed" });
      })
      .pipe(res);
  }
  requestArt(kind, q); // no-op when unavailable; serial queue dedups in-flight keys
  res.status(204).end();
});

// Warm the art cache: enqueue generation for everything the PWA will ask for.
// Safe no-op when generation is unavailable.
artRouter.post("/art/warm", (_req, res) => {
  const { queued, skipped } = warmArt();
  res.json({ ok: true, queued, skipped });
});

// Which PWA art queries already have a cached image, as "kind|q" tokens. Not
// cached because readiness changes as the background queue produces images.
artRouter.get("/art/manifest", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(artManifest());
});

// Artwork spend telemetry: estimated Gemini cost since art was last enabled,
// all-time totals, generations avoided via semantic reuse, and cache size.
artRouter.get("/art/stats", (_req, res) => res.json(repo.getArtStats()));
