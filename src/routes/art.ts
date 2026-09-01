import { Router } from "express";
import fs from "node:fs";
import { isArtKind, cachedArtPath, requestArt, warmArt, artManifest, regenerateArt, type ArtContext } from "../art.js";
import { getArtStats } from "../domain/operator/index.js";
import { exerciseArtPending } from "../domain/training/index.js";
import { getExerciseDetail } from "../repo.js";
import { getCachedExerciseExplanation, exercisePoseFromExplanation } from "../coachOps.js";

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
  // A just-added exercise whose background enrichment is still running will get
  // muscle-group/equipment-aware art from that job, generated under THIS same cache
  // key. Don't race it with a name-only generation here — defer (still a 204; the
  // client just retries and finds the enriched image once the job lands it).
  if (kind === "exercise" && exerciseArtPending(q)) return res.status(204).end();
  requestArt(kind, q); // no-op when unavailable; serial queue dedups in-flight keys
  res.status(204).end();
});

// Warm the art cache: enqueue generation for everything the PWA will ask for.
// Safe no-op when generation is unavailable.
artRouter.post("/art/warm", (_req, res) => {
  const { queued, skipped } = warmArt();
  res.json({ ok: true, queued, skipped });
});

// Repair path for an image that came back wrong (the classic: a cable lateral
// raise rendered as a plank, because the name alone under-specified the pose and
// the style references filled the gap). Drops the cached file and generates again
// under the SAME key, with the richest prompt we can build — for an exercise that
// means its muscle group, implement, and the pose from its cached how-to guide.
// Designed-failure convention: {ok:false, error} at HTTP 200.
artRouter.post("/art/regenerate", async (req, res) => {
  const kind = String(req.body?.kind ?? "");
  const q = String(req.body?.q ?? "").trim();
  if (!isArtKind(kind)) return res.json({ ok: false, error: "kind must be food|exercise|activity" });
  if (!q || q.length > 200) return res.json({ ok: false, error: "q required, max 200 chars" });

  let context: ArtContext | null = null;
  if (kind === "exercise") {
    const detail: any = getExerciseDetail(q);
    if (detail?.found) {
      const guide: any = getCachedExerciseExplanation(q);
      context = {
        muscle_group: detail.muscle_group ?? null,
        equipment: detail.equipment ?? null,
        pose: exercisePoseFromExplanation(guide?.explanation),
      };
    }
  }

  try {
    const regenerated = await regenerateArt(kind, q, context);
    // false means generation was unavailable — no key, art disabled, or the
    // breaker is open on this kind's model — not that anything broke here.
    if (!regenerated) return res.json({ ok: false, error: "art generation unavailable", regenerated: false });
    return res.json({ ok: true, regenerated: true });
  } catch (e: any) {
    return res.json({ ok: false, error: String(e?.message ?? e) });
  }
});

// Which PWA art queries already have a cached image, as "kind|q" tokens. Not
// cached because readiness changes as the background queue produces images.
artRouter.get("/art/manifest", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(artManifest());
});

// Artwork spend telemetry: estimated Gemini cost since art was last enabled,
// all-time totals, generations avoided via semantic reuse, and cache size. Also
// returns `health`: when art last rendered, failures in the last 7 days, the last
// upstream error code, and whether the circuit breaker has paused generation.
artRouter.get("/art/stats", (_req, res) => res.json(getArtStats()));
