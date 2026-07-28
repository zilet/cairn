import { Router } from "express";
import { localToday } from "../dayread.js";
import { streamEnrichRow } from "./enrich-stream.js";
import {
  addActivity,
  currentLiftCapacities,
  deleteSet,
  dismissAnchorObjectiveSuggestion,
  suggestAnchorObjective,
  finishSessionWithHeadline,
  getActivity,
  getCardioForDate,
  getEnduranceGoal,
  getEndurancePRs,
  getLastSet,
  getProgress,
  getStrengthJourney,
  getRecentSessions,
  getRunCompliance,
  getSessionByDate,
  getSessionDetail,
  getTrainingCalendar,
  getVolumeByMuscle,
  getWeeklyStats,
  listActivities,
  logSetByName,
  recentTraining,
  recordExerciseSymptomObservation,
  recordMovementTolerance,
  recurTrainingSymptom,
  reportTrainingSymptom,
  resolveTrainingSymptom,
  listTrainingSymptoms,
  resolveImplicitPlanDay,
  reopenSession,
  sessionHighlights,
  setSessionFeedback,
  setStrengthObjective,
  skipExercise,
  trainingLoadBand,
  unskipExercise,
  updateSessionNotes,
  updateSet,
  weekWins,
} from "../domain/training/index.js";

export const trainingLogRouter = Router();

function positiveId(value: unknown, field: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`${field} must be a positive integer`);
  return id;
}

function boundedText(value: unknown, field: string, max: number, required = false): string | undefined {
  if (value == null) {
    if (required) throw new Error(`${field} required`);
    return undefined;
  }
  const text = String(value).trim();
  if (required && !text) throw new Error(`${field} required`);
  if (text.length > max) throw new Error(`${field} must be ${max} characters or fewer`);
  return text || undefined;
}

// The athlete-owned movement-symptom lifecycle. Reads are calm evidence only:
// trial readiness remains movement-specific and never resolves the symptom.
trainingLogRouter.get("/training-symptoms", (req, res) => {
  try {
    res.json(
      listTrainingSymptoms({
        on: req.query.on ? String(req.query.on) : undefined,
        include_resolved: req.query.include_resolved === "1" || req.query.include_resolved === "true",
        movement: req.query.movement == null ? undefined : String(req.query.movement),
        exercise_id: req.query.exercise_id == null ? undefined : positiveId(req.query.exercise_id, "exercise_id"),
      })
    );
  } catch (error: any) {
    res.status(400).json({ error: error?.message ?? String(error) });
  }
});

// One exercise-card answer becomes one canonical, session-bound movement
// observation. The use case owns lifecycle relevance and atomicity.
trainingLogRouter.post("/training-symptoms/observation", (req, res) => {
  try {
    const body = req.body ?? {};
    res.json(
      recordExerciseSymptomObservation({
        date: String(body.date ?? ""),
        movement: boundedText(body.movement, "movement", 120, true)!,
        session_id: body.session_id == null ? null : positiveId(body.session_id, "session_id"),
        symptom_event_id:
          body.symptom_event_id == null ? null : positiveId(body.symptom_event_id, "symptom_event_id"),
        area_text: boundedText(body.area_text, "area_text", 300),
        outcome: body.outcome,
      })
    );
  } catch (error: any) {
    res.status(400).json({ error: error?.message ?? String(error) });
  }
});

// Record one athlete-reported area. Same-source/date retries return the existing active record.
trainingLogRouter.post("/training-symptoms", (req, res) => {
  try {
    const body = req.body ?? {};
    const sourceSessionId =
      body.source_session_id == null ? null : positiveId(body.source_session_id, "source_session_id");
    res.json(
      reportTrainingSymptom({
        area_text: boundedText(body.area_text, "area_text", 300, true)!,
        onset_on: body.onset_on == null ? undefined : String(body.onset_on),
        source_session_id: sourceSessionId,
        source_kind: boundedText(body.source_kind, "source_kind", 80),
      })
    );
  } catch (error: any) {
    res.status(400).json({ error: error?.message ?? String(error) });
  }
});

// Explicitly close one record; tolerance observations never call this path on their own.
trainingLogRouter.post("/training-symptoms/:id/resolve", (req, res) => {
  try {
    const symptom = resolveTrainingSymptom(
      positiveId(req.params.id, "id"),
      req.body?.on == null ? undefined : String(req.body.on)
    );
    if (!symptom) return res.status(404).json({ error: "symptom not found" });
    res.json(symptom);
  } catch (error: any) {
    res.status(400).json({ error: error?.message ?? String(error) });
  }
});

// Explicitly reopen a record, optionally resetting evidence only for one exact movement.
trainingLogRouter.post("/training-symptoms/:id/recur", (req, res) => {
  try {
    const body = req.body ?? {};
    const symptom = recurTrainingSymptom(positiveId(req.params.id, "id"), {
      on: body.on == null ? undefined : String(body.on),
      area_text: boundedText(body.area_text, "area_text", 300),
      movement: boundedText(body.movement, "movement", 120),
      exercise_id: body.exercise_id == null ? null : positiveId(body.exercise_id, "exercise_id"),
    });
    if (!symptom) return res.status(404).json({ error: "symptom not found" });
    res.json(symptom);
  } catch (error: any) {
    res.status(400).json({ error: error?.message ?? String(error) });
  }
});

// Record one movement-specific pain-free or pain-present observation.
trainingLogRouter.post("/training-symptoms/:id/tolerance", (req, res) => {
  try {
    const body = req.body ?? {};
    if (typeof body.pain_free !== "boolean") {
      return res.status(400).json({ error: "pain_free must be true or false" });
    }
    const symptom = recordMovementTolerance({
      symptom_event_id: positiveId(req.params.id, "id"),
      movement: boundedText(body.movement, "movement", 120, true)!,
      exercise_id: body.exercise_id == null ? null : positiveId(body.exercise_id, "exercise_id"),
      observed_on: body.observed_on == null ? undefined : String(body.observed_on),
      session_id: body.session_id == null ? null : positiveId(body.session_id, "session_id"),
      pain_free: body.pain_free,
    });
    if (!symptom) return res.status(404).json({ error: "symptom not found" });
    res.json(symptom);
  } catch (error: any) {
    res.status(400).json({ error: error?.message ?? String(error) });
  }
});

trainingLogRouter.get("/sessions", (req, res) => {
  // ?date= is a soft lookup: "no session for that date yet" is a normal, expected
  // state, so we return 200 + null (not 404). The PWA's api() helper resolves to
  // the parsed body regardless of status, so a 404 error-object would read as a
  // truthy hit and break the caller — null is the correct absence signal here.
  if (req.query.date) return res.json(getSessionByDate(String(req.query.date)));
  const limit = req.query.limit ? Number(req.query.limit) : 10;
  res.json(getRecentSessions(limit));
});

trainingLogRouter.get("/last-set", (req, res) => {
  const exercise = req.query.exercise ? String(req.query.exercise) : "";
  if (!exercise) return res.status(400).json({ error: "exercise required" });
  // Soft lookup (for input prefill): null when the exercise has no logged sets. See /sessions note above.
  res.json(getLastSet(exercise));
});

trainingLogRouter.get("/sessions/:id", (req, res) => {
  const s = getSessionDetail(Number(req.params.id));
  if (!s) return res.status(404).json({ error: "not found" });
  res.json(s);
});

// Motivational progress for one session: PRs set, per-exercise comparison to last
// session, and a small trailing-7-day rollup. Soft read — an unknown session is a
// normal "no highlights" state, so return 200 + null (the /sessions?date= convention),
// not 404. Factual, never a score.
trainingLogRouter.get("/sessions/:id/highlights", (req, res) => res.json(sessionHighlights(Number(req.params.id))));

trainingLogRouter.post("/sessions/:id/finish", (req, res) => {
  try {
    // Normalize an empty/whitespace-only/missing note to null so it can never
    // overwrite an existing note (finishSession COALESCEs — only NULL preserves).
    // The repo guards too; this keeps an offline outbox replay's {notes:""} clean
    // at the boundary. PUT /sessions/:id/notes below is the deliberate edit path,
    // where an explicit "" is a real "clear this note" — so it is left untouched.
    const raw = (req.body ?? {}).notes;
    const notes = raw == null || !String(raw).trim() ? null : String(raw).trim();
    // finishSessionWithHeadline attaches the same rotated "done" headline the
    // next /today-read fetch will compute, so the client's optimistic Today
    // paint (today-session-controller.ts) never flickers between an invented
    // sentence and the real one once the network catches up.
    res.json(finishSessionWithHeadline(Number(req.params.id), notes));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Reopen a finished session to keep logging (clears finished_at).
trainingLogRouter.post("/sessions/:id/reopen", (req, res) => {
  const s = reopenSession(Number(req.params.id));
  if (!s) return res.status(404).json({ error: "not found" });
  res.json(s);
});

// Edit a finished/past session's notes (history correction).
trainingLogRouter.put("/sessions/:id/notes", (req, res) => {
  const s = updateSessionNotes(Number(req.params.id), (req.body ?? {}).notes ?? null);
  if (!s) return res.status(404).json({ error: "not found" });
  res.json(s);
});

// Optional per-session feedback — the human side of autoregulation. A missing
// session for the date is a normal "not yet" state, so this returns null rather
// than throwing. Values are clamped in the repo.
trainingLogRouter.post("/sessions/:date/feedback", (req, res) => {
  const b = req.body ?? {};
  try {
    res.json(setSessionFeedback(String(req.params.date), {
      soreness: b.soreness,
      performance: b.performance,
      joint_pain: b.joint_pain,
    }));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Mark a planned exercise as intentionally skipped for today (or a passed date).
// Designed 200 + ok:false when there is no matching open session / plan item.
trainingLogRouter.post("/sessions/skip", (req, res) => {
  try {
    const b = req.body ?? {};
    if (!b.exercise || !String(b.exercise).trim()) return res.status(400).json({ error: "exercise required" });
    res.json(skipExercise(String(b.exercise), b.date ? String(b.date) : undefined));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

trainingLogRouter.delete("/sessions/skip", (req, res) => {
  try {
    const b = req.body ?? {};
    const exercise = String(b.exercise ?? req.query.exercise ?? "").trim();
    if (!exercise) return res.status(400).json({ error: "exercise required" });
    const date = b.date ?? req.query.date;
    res.json(unskipExercise(String(exercise), date ? String(date) : undefined));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

trainingLogRouter.post("/sets", (req, res) => {
  try {
    const b = req.body ?? {};
    if (!b.exercise) return res.status(400).json({ error: "exercise is required" });
    res.json(logSetByName(resolveImplicitPlanDay(b)));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

trainingLogRouter.delete("/sets/:id", (req, res) => res.json(deleteSet(Number(req.params.id))));

trainingLogRouter.put("/sets/:id", (req, res) => {
  try {
    const b = req.body ?? {};
    const updated = updateSet(Number(req.params.id), {
      weight: b.weight,
      reps: b.reps,
      rir: b.rir,
      duration_sec: b.duration_sec,
      note: b.note,
    });
    if (!updated) return res.status(404).json({ error: "not found" });
    res.json(updated);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

trainingLogRouter.get("/progress/:exercise", (req, res) =>
  res.json(getProgress(decodeURIComponent(req.params.exercise)))
);

// One explicit athlete-selected anchor lift. GET is strictly read-only; PUT snaps
// the target now and supersedes the prior active objective atomically. When no
// objective exists, the GET folds in a reachable anchor suggestion (computed from
// the standards capacities only in that case, so an existing journey pays nothing).
trainingLogRouter.get("/strength-journey", (_req, res) => {
  const journey = getStrengthJourney();
  if (!journey.available) journey.suggestion = suggestAnchorObjective({ capacities: currentLiftCapacities() });
  res.json(journey);
});

// Quiet the anchor-lift invitation for a long while (a suggestion, never a nag).
trainingLogRouter.post("/strength-journey/suggestion/dismiss", (_req, res) => {
  res.json(dismissAnchorObjectiveSuggestion());
});

trainingLogRouter.put("/strength-journey", (req, res) => {
  try {
    const body = req.body ?? {};
    const objective = setStrengthObjective({
      exercise: body.exercise,
      target_kind: body.target_kind,
      target_est_1rm: body.target_est_1rm,
    });
    res.json({ objective, journey: getStrengthJourney() });
  } catch (error: any) {
    res.status(400).json({ error: error?.message ?? String(error) });
  }
});

// ---- activities (free text or structured) ----
trainingLogRouter.post("/activities", (req, res) => {
  const b = req.body ?? {};
  if (!b.text && !b.type) return res.status(400).json({ error: "text or type required" });
  res.json(addActivity(b));
});

trainingLogRouter.get("/activities", (req, res) =>
  res.json(listActivities(req.query.limit ? Number(req.query.limit) : 20))
);

// The unified "Lately" feed: finished strength sessions + cardio activities merged,
// newest-first, with the real Garmin start time + body-reaction detail folded in.
trainingLogRouter.get("/recent-training", (req, res) =>
  res.json(recentTraining(req.query.limit ? Number(req.query.limit) : 6))
);

// Single activity row (poll fallback for watching enrichment_status).
trainingLogRouter.get("/activities/:id", (req, res) => {
  const a = getActivity(Number(req.params.id));
  if (!a) return res.status(404).json({ error: "not found" });
  res.json(a);
});

// Live enrichment status for one activity (Server-Sent Events) — the SSE-first
// path the PWA uses instead of polling; snapshot then transitions, close on
// terminal. EventSource can't set headers, so the PWA reaches this with ?token=.
trainingLogRouter.get("/activities/:id/stream", streamEnrichRow("activity", getActivity));

trainingLogRouter.get("/stats", (_req, res) => res.json(getWeeklyStats()));

// This week's training load vs the athlete's own trailing typical (weekly set
// count over the prior 8 weeks) — a plain-language band, "running hot" only when
// genuinely above typical. `{ band: null }` until there's enough history. Drives
// the quiet load-band row in the Train overview header.
trainingLogRouter.get("/training-load", (_req, res) => res.json({ band: trainingLoadBand() }));

// The week's motivational rollup (new bests, days trained, hard sets, filled volume,
// weight-trend pace) ending at ?date= (default today). Evidence of forward motion,
// in plain words — never a 0-100 score.
trainingLogRouter.get("/week-wins", (req, res) =>
  res.json(weekWins(req.query.date != null ? String(req.query.date) : undefined))
);

// Endurance PRs (v35): best efforts from the logged cardio (longest distance /
// duration + fastest pace at standard distances). ?type=run|ride filters. Plain
// numbers, never a score. The strength analogue is the est-1RM in /progress.
trainingLogRouter.get("/endurance-prs", (req, res) =>
  res.json(getEndurancePRs(req.query.type != null ? String(req.query.type) : undefined))
);

// Run compliance (closing the runner loop): prescribed plan cardio vs this week's
// logged efforts, in plain words ("32 of 40 km this week"). Never a 0-100 score.
trainingLogRouter.get("/run-compliance", (_req, res) => res.json(getRunCompliance()));

// The day's logged cardio efforts (hydrated with Garmin zones/pace). [] when none.
trainingLogRouter.get("/cardio", (req, res) =>
  res.json(getCardioForDate(req.query.date != null ? String(req.query.date) : localToday()))
);

// The endurance OBJECTIVE (v37), computed (race timing/phase derived). null = unset.
// SET it via PUT /api/profile { endurance_goal: {…} } (or null to clear).
trainingLogRouter.get("/endurance-goal", (_req, res) => res.json(getEnduranceGoal()));

trainingLogRouter.get("/volume", (req, res) => res.json(getVolumeByMuscle(Number(req.query.days) || 30)));

trainingLogRouter.get("/calendar", (req, res) => res.json(getTrainingCalendar(Number(req.query.days) || 84)));
