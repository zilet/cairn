import fs from "node:fs";
import { type Response, Router } from "express";
import {
  explainExercise,
  getCachedExerciseExplanation,
  reconcileExercises,
} from "../coachOps.js";
import {
  attachGuide,
  buildPlanICS,
  cachedGuideImage,
  deleteExercise,
  deletePlanDay,
  detachGuide,
  ensureGuideImage,
  exerciseGuideStatus,
  getExerciseDetail,
  getExerciseGuide,
  getPlan,
  getPlanDay,
  getPlanQuality,
  importExerciseGuides,
  listExerciseAliases,
  listExercises,
  listGuideSuggestions,
  mergeExercises,
  planUpcomingNote,
  reconcileExerciseGroups,
  recoveryWeekStatus,
  replacePlanChecked,
  savePlanDayChecked,
  suggestAlternatives,
  suggestVariations,
  updateExercise,
  updateTarget,
  upsertExercise,
} from "../domain/training/index.js";

export const planExercisesRouter = Router();

planExercisesRouter.get("/plan", (_req, res) => res.json(getPlan()));
planExercisesRouter.get("/plan/quality", (_req, res) => res.json(getPlanQuality()));

// The recovery-week story for the Plan surface: a waiting draft ('drafted'), the
// applied lighter week in flight ('applied', ~a week from the apply stamp), or
// null. The Plan tab's banner reads this so a reshaped week announces itself —
// heads-up + what changed — instead of arriving silently.
planExercisesRouter.get("/plan/recovery-status", (_req, res) => res.json(recoveryWeekStatus()));

// A calm forward look for the Plan surface: the training/recovery changes the
// brain will land soon (a recovery week landing Monday, a bounded target
// change), so a reshaped week announces itself instead of arriving silently.
// Deduped against the recovery banner's draft; null when nothing is waiting.
planExercisesRouter.get("/plan/upcoming", (_req, res) => res.json(planUpcomingNote()));

// Subscribe-able iCal of the training template — pull-not-push. Each plan day is
// a weekly-recurring all-day event (Day 1 → Monday by default; ?start=0..6 to
// shift, JS weekday where 0=Sun). Subscribe in Apple/Google Calendar via
//   webcal://<host>/api/plan.ics   (append ?token=… when CAIRN_AUTH_TOKEN is set,
// since a calendar client can't send a custom header). Registered before
// /plan/:day; the literal ".ics" path never matches the :day param.
planExercisesRouter.get("/plan.ics", (req, res) => {
  const start = req.query.start != null ? Number(req.query.start) : NaN;
  const ics = buildPlanICS({ startWeekday: Number.isFinite(start) ? start : undefined });
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", 'inline; filename="cairn-plan.ics"');
  res.send(ics);
});

planExercisesRouter.get("/plan/:day", (req, res) => {
  const d = getPlanDay(Number(req.params.day));
  if (!d) return res.status(404).json({ error: "not found" });
  res.json(d);
});

planExercisesRouter.put("/plan/:day/target", (req, res) => {
  try {
    const { exercise, target_weight, target_seconds, quality_override } = req.body ?? {};
    res.json(updateTarget(
      Number(req.params.day),
      exercise,
      target_weight !== undefined && target_weight !== null ? Number(target_weight) : undefined,
      target_seconds !== undefined && target_seconds !== null ? Number(target_seconds) : undefined,
      { quality_override: quality_override === true }
    ));
  } catch (e: any) {
    res.status(400).json({ error: e.message, ...(e?.report ? { quality: e.report, quality_override_available: true } : {}) });
  }
});

// ---- plan editing (manual) ----
planExercisesRouter.put("/plan", (req, res) => {
  try {
    const body = req.body ?? {};
    const result = replacePlanChecked(body.days, { quality_override: body.quality_override === true });
    // Preserve the established REST success shape (the plan array). Quality is
    // available at GET /plan/quality; rejected writes include the report below.
    res.json(result.plan);
  } catch (e: any) {
    res.status(400).json({ error: e.message, ...(e?.report ? { quality: e.report, quality_override_available: true } : {}) });
  }
});

planExercisesRouter.put("/plan/:day", (req, res) => {
  try {
    const b = req.body ?? {};
    const result = savePlanDayChecked(Number(req.params.day), b.name, b.focus ?? null, b.items ?? [], { quality_override: b.quality_override === true });
    res.json(result.day);
  } catch (e: any) {
    res.status(400).json({ error: e.message, ...(e?.report ? { quality: e.report, quality_override_available: true } : {}) });
  }
});

planExercisesRouter.delete("/plan/:day", (req, res) => res.json(deletePlanDay(Number(req.params.day))));

planExercisesRouter.get("/exercises", (_req, res) => res.json(listExercises()));

// Upsert by name: creates the exercise (with mode/muscle_group) or updates the
// provided fields on an existing one. Returns the exercise row.
planExercisesRouter.post("/exercises", (req, res) => {
  try {
    const b = req.body ?? {};
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: "name required" });
    // A user-facing add: when this creates a brand-new exercise, queue the quiet
    // background enrichment (canonicalize + classify + how-to guide + good art).
    res.json(upsertExercise({ name: b.name, muscle_group: b.muscle_group, mode: b.mode }, { enrich: true }));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

planExercisesRouter.put("/exercises/:id", (req, res) => {
  try {
    const b = req.body ?? {};
    const updated = updateExercise(Number(req.params.id), {
      mode: b.mode, muscle_group: b.muscle_group, cues: b.cues, constraint_note: b.constraint_note,
    });
    if (!updated) return res.status(404).json({ error: "not found" });
    res.json(updated);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Delete an exercise by name. Returns 200 with ok:false (not an HTTP error) when
// it's still referenced by a plan or logged sets — a designed, recoverable state
// the PWA surfaces as a gentle reason, mirroring the swap/skip failure signal.
planExercisesRouter.delete("/exercises/:name", (req, res) => {
  try {
    res.json(deleteExercise(decodeURIComponent(req.params.name)));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

planExercisesRouter.get("/exercise/:name/explanation", (req, res) => {
  try {
    res.json(getCachedExerciseExplanation(decodeURIComponent(req.params.name)));
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

planExercisesRouter.post("/exercise/:name/explanation", async (req, res) => {
  try {
    res.json(await explainExercise(req.body?.agent, decodeURIComponent(req.params.name)));
  } catch (e: any) {
    res.json({ ok: false, error: e.message });
  }
});

planExercisesRouter.get("/exercise/:name", (req, res) =>
  res.json(getExerciseDetail(decodeURIComponent(req.params.name)))
);

// Reconcile exercise muscle groups using the deterministic canonicalizer. Useful
// after importing/creating older exercises with blank or legacy groups.
planExercisesRouter.post("/exercises/reconcile-groups", (_req, res) =>
  res.json(reconcileExerciseGroups())
);

// Merge duplicate exercises explicitly: repoint logged sets + plan items from
// `from` into `into`, then remove the now-empty `from` exercise. ok:false when
// `into` does not exist (guard; nothing is changed).
planExercisesRouter.post("/exercises/merge", (req, res) => {
  const b = req.body ?? {};
  const from = String(b.from ?? "").trim();
  const into = String(b.into ?? "").trim();
  if (!from || !into) return res.status(400).json({ error: "from and into required" });
  res.json(mergeExercises(from, into));
});

// Exercise-name reconciliation (movement de-duplication) — the canon counterpart
// to /markers/reconcile. GET lists the learned variant→canonical aliases; POST
// runs the agentic reconciler over the distinct exercise names, tidying
// descriptive/duplicate titles ("DB bench"/"Dumbbell bench press") into clean
// reusable canonical names and profiling muscle groups. The deterministic
// exercise-canon normalizer is always on; this learns the long tail. Synchronous
// like the marker reconcile — ok:false at 200 is the designed failure signal.
// Never changes logged numbers — only the series merge.
planExercisesRouter.get("/exercises/aliases", (_req, res) => res.json(listExerciseAliases()));
planExercisesRouter.post("/exercises/reconcile-names", async (req, res) => {
  try {
    // User-initiated "Tidy" — allowed to override a clearly-wrong non-null muscle group.
    res.json(await reconcileExercises(req.body?.agent, undefined, { authoritativeGroups: true }));
  } catch (e: any) {
    res.json({ ok: false, error: e?.message || "reconcile failed" });
  }
});

// ---------- exercise guides (free-exercise-db, public domain) ----------
// The optional instructional layer: step-by-step text, muscles, equipment and two
// demonstration photos per movement. Nothing is fetched until the athlete asks, and
// every read is absence-tolerant — an un-imported library reads as "no guide", never
// as an error. LITERAL paths are registered BEFORE /exercise-guides/:name so
// "status"/"import"/"image" can never be read as an exercise name.

planExercisesRouter.get("/exercise-guides/status", (_req, res) => res.json(exerciseGuideStatus()));

// The low-confidence name matches waiting on a human yes/no. Never auto-applied:
// the dataset has 21 "bench press" rows, so a guess would put the wrong photos on
// the wrong lift.
planExercisesRouter.get("/exercise-guides/suggestions", (_req, res) => res.json(listGuideSuggestions()));

// Import (or refresh) the dataset and re-run matching. Long-ish but bounded — the
// ~1 MB metadata only; photos come later, lazily, per movement. ok:false at 200 is
// the designed failure signal (offline, GitHub down), not an HTTP error.
planExercisesRouter.post("/exercise-guides/import", async (req, res) => {
  try {
    const body = req.body ?? {};
    res.json(
      await importExerciseGuides({
        refresh: body.refresh === true,
        prefetchImages: body.prefetch_images === true,
      })
    );
  } catch (e: any) {
    res.json({ ok: false, error: e?.message || "guide import failed" });
  }
});

// Confirm a suggestion by hand, or drop a link that reads wrong.
planExercisesRouter.post("/exercise-guides/attach", (req, res) => {
  const b = req.body ?? {};
  res.json(attachGuide(String(b.exercise ?? ""), String(b.guide_id ?? "")));
});

planExercisesRouter.post("/exercise-guides/detach", (req, res) =>
  res.json(detachGuide(String(req.body?.guide_id ?? "")))
);

// Stream one cached photo, setting the image headers only once the stream has
// actually opened. Setting them up-front and then answering 204 on a read error
// would emit an empty body carrying `immutable, max-age=1y` — a browser would cache
// that nothing for a year and the photo would never appear again.
export function streamGuideImage(res: Response, file: string): void {
  const stream = fs.createReadStream(file);
  stream.on("open", () => {
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    stream.pipe(res);
  });
  stream.on("error", () => {
    stream.destroy();
    if (!res.headersSent) {
      for (const header of ["Content-Type", "Cache-Control", "X-Content-Type-Options"]) res.removeHeader(header);
      res.status(204);
    }
    res.end();
  });
}

// One demonstration photo, cache-first and fetched on demand the first time it is
// viewed. 204 on anything missing — an unknown guide, no network, a non-image
// response — so the sheet quietly renders its steps without a picture. Mirrors the
// generated-art route: long immutable cache, nosniff, query-token auth (an <img>
// cannot set a header).
planExercisesRouter.get("/exercise-guides/image/:guideId/:index", async (req, res) => {
  const guideId = String(req.params.guideId ?? "");
  const index = Number(req.params.index);
  try {
    const file = cachedGuideImage(guideId, index) ?? (await ensureGuideImage(guideId, index));
    if (!file || !fs.existsSync(file)) return res.status(204).end();
    return streamGuideImage(res, file);
  } catch {
    return res.status(204).end();
  }
});

// Single-row lookup: 200 + null on absence (never 404 — the PWA's api() helper
// resolves to the body regardless of status, so a 404 error object would read as a
// truthy hit).
planExercisesRouter.get("/exercise-guides/:name", (req, res) =>
  res.json(getExerciseGuide(decodeURIComponent(req.params.name)))
);

// Exercise variations / alternatives (the plateau-break + "make it interesting"
// library). ?exercise= required; ?mode=alternatives with bodyweight=1 / avoid= for swaps.
planExercisesRouter.get("/program/variations", (req, res) => {
  const exercise = req.query.exercise ? String(req.query.exercise) : "";
  if (!exercise) return res.status(400).json({ error: "exercise required" });
  if (String(req.query.mode) === "alternatives") {
    const avoid = req.query.avoid ? String(req.query.avoid).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    return res.json(suggestAlternatives(exercise, {
      bodyweightOnly: req.query.bodyweight === "1",
      avoidEquipment: avoid as any,
    }));
  }
  res.json(suggestVariations(exercise));
});
