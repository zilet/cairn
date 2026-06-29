import { Router } from "express";
import {
  explainExercise,
  getCachedExerciseExplanation,
  reconcileExercises,
} from "../coachOps.js";
import * as repo from "../repo.js";

export const planExercisesRouter = Router();

planExercisesRouter.get("/plan", (_req, res) => res.json(repo.getPlan()));

// Subscribe-able iCal of the training template — pull-not-push. Each plan day is
// a weekly-recurring all-day event (Day 1 → Monday by default; ?start=0..6 to
// shift, JS weekday where 0=Sun). Subscribe in Apple/Google Calendar via
//   webcal://<host>/api/plan.ics   (append ?token=… when CAIRN_AUTH_TOKEN is set,
// since a calendar client can't send a custom header). Registered before
// /plan/:day; the literal ".ics" path never matches the :day param.
planExercisesRouter.get("/plan.ics", (req, res) => {
  const start = req.query.start != null ? Number(req.query.start) : NaN;
  const ics = repo.buildPlanICS({ startWeekday: Number.isFinite(start) ? start : undefined });
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", 'inline; filename="cairn-plan.ics"');
  res.send(ics);
});

planExercisesRouter.get("/plan/:day", (req, res) => {
  const d = repo.getPlanDay(Number(req.params.day));
  if (!d) return res.status(404).json({ error: "not found" });
  res.json(d);
});

planExercisesRouter.put("/plan/:day/target", (req, res) => {
  try {
    const { exercise, target_weight, target_seconds } = req.body ?? {};
    res.json(repo.updateTarget(
      Number(req.params.day),
      exercise,
      target_weight !== undefined && target_weight !== null ? Number(target_weight) : undefined,
      target_seconds !== undefined && target_seconds !== null ? Number(target_seconds) : undefined
    ));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ---- plan editing (manual) ----
planExercisesRouter.put("/plan", (req, res) => {
  try {
    res.json(repo.replacePlan((req.body ?? {}).days));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

planExercisesRouter.put("/plan/:day", (req, res) => {
  try {
    const b = req.body ?? {};
    res.json(repo.savePlanDay(Number(req.params.day), b.name, b.focus ?? null, b.items ?? []));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

planExercisesRouter.delete("/plan/:day", (req, res) => res.json(repo.deletePlanDay(Number(req.params.day))));

planExercisesRouter.get("/exercises", (_req, res) => res.json(repo.listExercises()));

// Upsert by name: creates the exercise (with mode/muscle_group) or updates the
// provided fields on an existing one. Returns the exercise row.
planExercisesRouter.post("/exercises", (req, res) => {
  try {
    const b = req.body ?? {};
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: "name required" });
    res.json(repo.upsertExercise({ name: b.name, muscle_group: b.muscle_group, mode: b.mode }));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

planExercisesRouter.put("/exercises/:id", (req, res) => {
  try {
    const b = req.body ?? {};
    const updated = repo.updateExercise(Number(req.params.id), {
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
    res.json(repo.deleteExercise(decodeURIComponent(req.params.name)));
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
  res.json(repo.getExerciseDetail(decodeURIComponent(req.params.name)))
);

// Reconcile exercise muscle groups using the deterministic canonicalizer. Useful
// after importing/creating older exercises with blank or legacy groups.
planExercisesRouter.post("/exercises/reconcile-groups", (_req, res) =>
  res.json(repo.reconcileExerciseGroups())
);

// Merge duplicate exercises explicitly: repoint logged sets + plan items from
// `from` into `into`, then remove the now-empty `from` exercise. ok:false when
// `into` does not exist (guard; nothing is changed).
planExercisesRouter.post("/exercises/merge", (req, res) => {
  const b = req.body ?? {};
  const from = String(b.from ?? "").trim();
  const into = String(b.into ?? "").trim();
  if (!from || !into) return res.status(400).json({ error: "from and into required" });
  res.json(repo.mergeExercises(from, into));
});

// Exercise-name reconciliation (movement de-duplication) — the canon counterpart
// to /markers/reconcile. GET lists the learned variant→canonical aliases; POST
// runs the agentic reconciler over the distinct exercise names, tidying
// descriptive/duplicate titles ("DB bench"/"Dumbbell bench press") into clean
// reusable canonical names and profiling muscle groups. The deterministic
// exercise-canon normalizer is always on; this learns the long tail. Synchronous
// like the marker reconcile — ok:false at 200 is the designed failure signal.
// Never changes logged numbers — only the series merge.
planExercisesRouter.get("/exercises/aliases", (_req, res) => res.json(repo.listExerciseAliases()));
planExercisesRouter.post("/exercises/reconcile-names", async (req, res) => {
  try {
    res.json(await reconcileExercises(req.body?.agent));
  } catch (e: any) {
    res.json({ ok: false, error: e?.message || "reconcile failed" });
  }
});

// Exercise variations / alternatives (the plateau-break + "make it interesting"
// library). ?exercise= required; ?mode=alternatives with bodyweight=1 / avoid= for swaps.
planExercisesRouter.get("/program/variations", (req, res) => {
  const exercise = req.query.exercise ? String(req.query.exercise) : "";
  if (!exercise) return res.status(400).json({ error: "exercise required" });
  if (String(req.query.mode) === "alternatives") {
    const avoid = req.query.avoid ? String(req.query.avoid).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    return res.json(repo.suggestAlternatives(exercise, {
      bodyweightOnly: req.query.bodyweight === "1",
      avoidEquipment: avoid as any,
    }));
  }
  res.json(repo.suggestVariations(exercise));
});
