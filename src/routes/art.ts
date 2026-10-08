import { Router } from "express";
import fs from "node:fs";
import {
  isArtKind,
  cachedArtPath,
  requestArt,
  warmArt,
  artManifest,
  artVersions,
  artState,
  regenerateArt,
  enqueueExerciseArt,
  buildExerciseArtContext,
  exercisePoseFor,
  assetKeyFromPath,
  exerciseArtPath,
  type ArtContext,
} from "../art.js";
import { genericFigureFor, starterFigureFor } from "../artStarter.js";
import { getArtStats } from "../domain/operator/index.js";
import { exerciseArtPending, findExercise } from "../domain/training/index.js";
import { getExerciseDetail } from "../repo.js";

export const artRouter = Router();

function exerciseContextFor(q: string): ArtContext {
  const detail: any = getExerciseDetail(q);
  if (detail?.found) {
    return {
      muscle_group: detail.muscle_group ?? null,
      equipment: detail.equipment ?? null,
      pose: exercisePoseFor(q),
    };
  }
  return buildExerciseArtContext(q);
}

/** The image's real type from its magic bytes — pack files are JPEG in a .png name. */
function sniffArtMime(file: string): string {
  let mime = "image/png";
  try {
    const fd = fs.openSync(file, "r");
    const head = Buffer.alloc(3);
    fs.readSync(fd, head, 0, 3, 0);
    fs.closeSync(fd);
    if (head[0] === 0xff && head[1] === 0xd8) mime = "image/jpeg";
    else if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46) mime = "image/webp";
  } catch {
    /* sniffing is a nicety — the default mime already set above stands */
  }
  return mime;
}

function sendArtFile(file: string, res: import("express").Response): void {
  res.setHeader("Content-Type", sniffArtMime(file));
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.setHeader("ETag", `"${assetKeyFromPath(file)}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  fs.createReadStream(file)
    .on("error", () => {
      if (!res.headersSent) res.status(500).json({ error: "read failed" });
    })
    .pipe(res);
}

// ---- generated artwork (Gemini image cache; see src/art.ts) ----
// Cache hit -> the cached image, immutable-cached, ETag = asset key. The URL is
// versioned (`v=`) so immutable stays honest. Miss -> 204 immediately.
// An exercise miss first asks the starter picture pack (src/artStarter.ts): a
// figure for exactly this exercise is installed as a real asset and served, with
// no generation queued. Otherwise exercise misses never fire a name-only
// generate: they enqueue `exercise_art` (or produce from classifyMuscleGroup /
// detectImplement when no row exists). The generic movement-pattern stand-in is
// NEVER served here — it has its own URL (/art/generic, below), so the
// cache-first service worker can never file it as this exercise's picture.
artRouter.get("/art", (req, res) => {
  const kind = String(req.query.kind ?? "");
  const q = String(req.query.q ?? "").trim();
  if (!isArtKind(kind)) return res.status(400).json({ error: "kind must be food|exercise|activity" });
  if (!q || q.length > 200) return res.status(400).json({ error: "q required, max 200 chars" });

  const file = kind === "exercise" ? exerciseArtPath(q) : cachedArtPath(kind, q);
  if (file) return sendArtFile(file, res);

  if (kind === "exercise") {
    if (exerciseArtPending(q)) return res.status(204).end();
    const row = findExercise(q);
    if (row?.id) {
      import("../enrich.js")
        .then((m) => m.enqueueEnrich("exercise_art", Number(row.id)))
        .catch(() => {
          void enqueueExerciseArt(q);
        });
    } else {
      void enqueueExerciseArt(q);
    }
    return res.status(204).end();
  }

  requestArt(kind, q);
  res.status(204).end();
});

// The visible stand-in while an exercise has no figure of its own: the starter
// pack's generic movement-pattern figure (a squat, a horizontal pull…), classified
// from the stored row (group, mode) or the deterministic name classifiers. The PWA
// layers it UNDER the real /api/art photo, which paints over it the moment a real
// figure exists. Its own URL is the whole design: the service worker's cache-first
// art layer keys on /api/art only, so a stand-in can never be cached as that
// exercise's real picture. A 204 (no-store) when the exercise already has — or the
// pack holds — a real figure, or when the generic image was never built.
artRouter.get("/art/generic", (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q || q.length > 200) return res.status(400).json({ error: "q required, max 200 chars" });
  const none = () => {
    res.setHeader("Cache-Control", "no-store");
    return res.status(204).end();
  };
  if (cachedArtPath("exercise", q) || starterFigureFor(q)) return none();
  const generic = genericFigureFor(q);
  if (!generic) return none();
  res.setHeader("Content-Type", sniffArtMime(generic.file));
  // Short and revalidating, never immutable: the stand-in for a name can change
  // (a re-classified row, a newly built pattern figure), and it is never the
  // picture a phone should keep.
  res.setHeader("Cache-Control", "private, max-age=86400");
  let etag = `"generic-${generic.pattern}"`;
  try {
    const stat = fs.statSync(generic.file);
    etag = `"generic-${generic.pattern}-${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  } catch {
    /* the read below answers for a vanished file */
  }
  res.setHeader("ETag", etag);
  res.setHeader("X-Cairn-Art-Generic", generic.pattern);
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.headers["if-none-match"] === etag) return res.status(304).end();
  fs.createReadStream(generic.file)
    .on("error", () => {
      if (!res.headersSent) none();
    })
    .pipe(res);
});

// Warm the art cache: enqueue generation for everything the PWA will ask for.
// Safe no-op when generation is unavailable. Exercises go through the
// context-aware producer, never a name-only prompt.
artRouter.post("/art/warm", (_req, res) => {
  const { queued, skipped } = warmArt();
  res.json({ ok: true, queued, skipped });
});

// Repair path for an image that came back wrong. Drops the parked failure,
// bumps `art_index.version`, and generates under a new pose-aware key with the
// richest prompt we can build. A repeat within 60s or while a regen is in flight
// returns {ok:true, regenerated:false, reason}. Designed-failure convention:
// {ok:false} at HTTP 200 when generation is unavailable.
artRouter.post("/art/regenerate", async (req, res) => {
  const kind = String(req.body?.kind ?? "");
  const q = String(req.body?.q ?? "").trim();
  if (!isArtKind(kind)) return res.json({ ok: false, error: "kind must be food|exercise|activity" });
  if (!q || q.length > 200) return res.json({ ok: false, error: "q required, max 200 chars" });

  const context = kind === "exercise" ? exerciseContextFor(q) : null;

  try {
    const result = await regenerateArt(kind, q, context);
    if (!result.ok) return res.json({ ok: false, error: "art generation unavailable", regenerated: false });
    return res.json(result);
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

// Current exercise art versions, keyed like the PWA token (`exercise|Name`).
// Optional `?q=a,b,c` (≤200 names, each ≤120 chars) returns only those; with no
// `q`, the most recently used 500 rows. Fetched once at boot and kept in memory.
artRouter.get("/art/versions", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const raw = String(req.query?.q ?? "").trim();
  const queries = raw
    ? raw
        .split(",")
        .map((s) => s.trim().slice(0, 120))
        .filter(Boolean)
        .slice(0, 200)
    : undefined;
  res.json(artVersions({ queries: queries?.length ? queries : undefined }));
});

// The boot read: ready tokens + enabled + exercise versions in one call (the two
// routes above stay for older clients). Not cached — readiness and versions move
// as the background queue draws.
artRouter.get("/art/state", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(artState());
});

// Artwork spend telemetry: estimated Gemini cost since art was last enabled,
// all-time totals, generations avoided via semantic reuse, and cache size. Also
// returns `health`: when art last rendered, failures in the last 7 days, the last
// upstream error code, and whether the circuit breaker has paused generation.
artRouter.get("/art/stats", (_req, res) => res.json(getArtStats()));
