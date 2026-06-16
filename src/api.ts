import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as repo from "./repo.js";
import { todayISO } from "./db.js";
import { buildCoachPrompt } from "./prompt.js";
import { enqueueChatTurn, cancelTurn, onTurnEvent } from "./chatTurns.js";
import { enqueueAgentJob, cancelAgentJob, onJobEvent } from "./agentJobs.js";
import { getAgentCliUpdateStatus, startAgentCliUpdate } from "./agentCliUpdates.js";
import {
  runChosen,
  suggestSession,
  draftMealPlan,
  nutritionCheckin,
  swapMealAgentic,
  generateRecipe,
  runHealthReview,
  generateInsight,
  runResearch,
  consolidateMemory,
  growAboutMe,
  reconcileOutcomes,
  distillChat,
} from "./coachOps.js";
import { isArtKind, cachedArtPath, requestArt, warmArt } from "./art.js";
import { computeDayRead, localToday } from "./dayread.js";
import { authEnabled } from "./auth.js";

export const api = Router();

// The 7 heavy agentic ops are durable BACKGROUND JOBS by default: the POST
// handler persists an agent_jobs row, enqueues it, and returns { ok, job } at
// once (the PWA streams progress + reconnects across reloads). The
// settings.bg_ops_enabled toggle (default on) is a safety valve: when OFF, the
// handler falls through to run the op INLINE and returns the legacy body
// unchanged. backgroundOp() encapsulates that fork: when backgrounding is on it
// creates + enqueues the job and responds { ok, job }; when off it returns false
// so the caller runs the op inline exactly as before.
function backgroundOp(res: Response, kind: string, input: any, agent?: string | null): boolean {
  if (!repo.getSettings().bg_ops_enabled) return false;
  const job = repo.createAgentJob({ kind, input, agent: agent ?? null });
  enqueueAgentJob((job as any).id);
  res.json({ ok: true, job });
  return true;
}

// Uploaded health docs live next to the DB, inside the mounted data volume, so
// they survive container rebuilds. Mirrors db.ts's DATA_DIR resolution.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

// Accepted upload types → file extension. A CONCRETE allowlist on purpose: a
// permissive `image/*` rule would let through `image/svg+xml`, and an SVG served
// inline executes its embedded <script>. Raster images + PDF, plus the health
// export formats (zip / html / xml / text) which are only ever read by the
// ingestion agent or downloaded as an attachment — never served inline.
const ACCEPTED_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "text/plain": "txt",
  "text/html": "html",
  "application/xml": "xml",
  "text/xml": "xml",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
};

function extForMime(mime: string): string {
  return ACCEPTED_MIME[(mime || "").toLowerCase()] || "bin";
}

function isAcceptedMime(mime: string): boolean {
  return !!ACCEPTED_MIME[(mime || "").toLowerCase()];
}

// Only raster images + PDF are ever served INLINE (rendered in the browser).
// Everything else in the allowlist (zip/html/xml/text) is forced to download so
// nothing markup-bearing executes in the app's origin.
function isInlineMime(mime: string): boolean {
  const m = (mime || "").toLowerCase();
  return m === "application/pdf" || (m.startsWith("image/") && isAcceptedMime(m));
}

api.get("/plan", (_req, res) => res.json(repo.getPlan()));

api.get("/plan/:day", (req, res) => {
  const d = repo.getPlanDay(Number(req.params.day));
  if (!d) return res.status(404).json({ error: "not found" });
  res.json(d);
});

api.put("/plan/:day/target", (req, res) => {
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
api.put("/plan", (req, res) => {
  try {
    res.json(repo.replacePlan((req.body ?? {}).days));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

api.put("/plan/:day", (req, res) => {
  try {
    const b = req.body ?? {};
    res.json(repo.savePlanDay(Number(req.params.day), b.name, b.focus ?? null, b.items ?? []));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

api.delete("/plan/:day", (req, res) => res.json(repo.deletePlanDay(Number(req.params.day))));

api.get("/exercises", (_req, res) => res.json(repo.listExercises()));

// Upsert by name: creates the exercise (with mode/muscle_group) or updates the
// provided fields on an existing one. Returns the exercise row.
api.post("/exercises", (req, res) => {
  try {
    const b = req.body ?? {};
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: "name required" });
    res.json(repo.upsertExercise({ name: b.name, muscle_group: b.muscle_group, mode: b.mode }));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

api.put("/exercises/:id", (req, res) => {
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
api.delete("/exercises/:name", (req, res) => {
  try {
    res.json(repo.deleteExercise(decodeURIComponent(req.params.name)));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

api.get("/exercise/:name", (req, res) =>
  res.json(repo.getExerciseDetail(decodeURIComponent(req.params.name)))
);

api.get("/sessions", (req, res) => {
  // ?date= is a soft lookup: "no session for that date yet" is a normal, expected
  // state, so we return 200 + null (not 404). The PWA's api() helper resolves to
  // the parsed body regardless of status, so a 404 error-object would read as a
  // truthy hit and break the caller — null is the correct absence signal here.
  if (req.query.date) return res.json(repo.getSessionByDate(String(req.query.date)));
  const limit = req.query.limit ? Number(req.query.limit) : 10;
  res.json(repo.getRecentSessions(limit));
});

api.get("/last-set", (req, res) => {
  const exercise = req.query.exercise ? String(req.query.exercise) : "";
  if (!exercise) return res.status(400).json({ error: "exercise required" });
  // Soft lookup (for input prefill): null when the exercise has no logged sets. See /sessions note above.
  res.json(repo.getLastSet(exercise));
});

api.get("/sessions/:id", (req, res) => {
  const s = repo.getSessionDetail(Number(req.params.id));
  if (!s) return res.status(404).json({ error: "not found" });
  res.json(s);
});

api.post("/sessions/:id/finish", (req, res) => {
  try {
    res.json(repo.finishSession(Number(req.params.id), (req.body ?? {}).notes ?? null));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Reopen a finished session to keep logging (clears finished_at).
api.post("/sessions/:id/reopen", (req, res) => {
  const s = repo.reopenSession(Number(req.params.id));
  if (!s) return res.status(404).json({ error: "not found" });
  res.json(s);
});

// Edit a finished/past session's notes (history correction).
api.put("/sessions/:id/notes", (req, res) => {
  const s = repo.updateSessionNotes(Number(req.params.id), (req.body ?? {}).notes ?? null);
  if (!s) return res.status(404).json({ error: "not found" });
  res.json(s);
});

// The day intelligence read — the soul of the product. Judges what KIND of day
// today should be (train / easy / rest) as a calm SUGGESTION, never a gate.
// ALWAYS 200: the agentic read writes the human sentence, and if no agent is
// reachable (or it returns garbage) it falls back to the deterministic floor so
// the Brief always has something true to say. ?override= lets the launchpad
// chips reshape the read ("rough night" / "short on time" / "train anyway").
//
// Fast path: the canonical (no-override) read is cached per day — written nightly
// by the scheduler and on any miss — so the morning open is instant and never
// waits on an agent subprocess. Overrides always recompute (they're transient).
api.get("/today-read", async (req, res) => {
  const date = req.query.date ? String(req.query.date) : undefined;
  const override = req.query.override ? String(req.query.override) : undefined;
  const agentParam = req.query.agent ? String(req.query.agent) : undefined;
  // ?reset=1 clears a persisted steer ("back to today's read") and recomputes the
  // canonical read — the un-steer escape hatch, so the athlete is never trapped in
  // an override they changed their mind about (mirrors the cache-invalidation path).
  const reset = req.query.reset === "1" || req.query.reset === "true";
  try {
    if (reset) {
      repo.invalidateDayRead(date || localToday());
      return res.json(await computeDayRead({ date, agent: agentParam }));
    }
    if (!override) {
      const cached = repo.getCachedDayRead(date || localToday());
      if (cached) return res.json({ ...cached, cached: true });
    }
    const read: any = await computeDayRead({ date, override, agent: agentParam });
    // Outcome learning: record what the Brief proposed for this date (once per
    // fresh compute — the cached path above short-circuits repeats) so a later
    // reconciliation pass can compare it to what the athlete actually did.
    try { repo.recordSuggestion("day_read", date || localToday(), { kind: read?.kind ?? null, focus: read?.focus ?? null, est_minutes: read?.est_minutes ?? null, override: override ?? null }); } catch {}
    return res.json(read);
  } catch (e: any) {
    // Last-resort floor — computeDayRead already swallows agent failures, so this
    // only fires on an unexpected repo error. Still return a real read, never 500.
    const b = repo.dayRead(date);
    const headline = b.kind === "rest" ? "Rest today." : b.kind === "easy" ? "Take it easy." : b.focus ? `${b.focus}.` : "Good to train.";
    return res.json({ ...b, headline, source: "deterministic", error: e.message });
  }
});

// Background the Brief OVERRIDE reshape ("rough night" / "short on time" / "train
// anyway") as a durable job, so a steer survives a tab switch / reload / restart
// like the other 7 ops. The canonical GET /api/today-read (and ?reset=1) stays
// synchronous (cached + deterministic floor); this POST is ONLY for the agentic
// override reshape. The job's `done` result is byte-for-byte what
// GET /api/today-read?override= returns, so the PWA reuses its Brief render.
// When bg_ops is OFF this computes inline and returns the legacy read body.
api.post("/today-read/reshape", async (req, res) => {
  const b = req.body ?? {};
  const date = b.date != null ? String(b.date) : undefined;
  const override = b.override != null ? String(b.override) : undefined;
  const agentParam = b.agent != null ? String(b.agent) : undefined;
  if (repo.getSettings().bg_ops_enabled) {
    const job = repo.createAgentJob({ kind: "day_read_override", input: { date, override, agent: agentParam ?? null }, agent: agentParam ?? null });
    enqueueAgentJob((job as any).id);
    return res.json({ ok: true, job });
  }
  // Legacy inline path (bg_ops off) — same body the GET override branch returns.
  try {
    const read: any = await computeDayRead({ date, override, agent: agentParam });
    try { repo.recordSuggestion("day_read", date || localToday(), { kind: read?.kind ?? null, focus: read?.focus ?? null, est_minutes: read?.est_minutes ?? null, override: override ?? null }); } catch {}
    return res.json(read);
  } catch (e: any) {
    const f = repo.dayRead(date);
    const headline = f.kind === "rest" ? "Rest today." : f.kind === "easy" ? "Take it easy." : f.focus ? `${f.focus}.` : "Good to train.";
    return res.json({ ...f, headline, source: "deterministic", error: e.message });
  }
});

// Build ONE session for today on demand ("ask it for a session right now"). A
// SUGGESTION the user can act on or ignore — NOT saved/applied as the plan. Like
// the meal-swap endpoint, ok:false at status 200 is the designed failure signal
// (the PWA api() helper reads the body regardless of status).
api.post("/session-suggest", async (req, res) => {
  const b = req.body ?? {};
  const input = {
    agent: b.agent ?? null,
    minutes: b.minutes != null ? Number(b.minutes) : undefined,
    equipment: b.equipment != null ? String(b.equipment) : undefined,
    focus: b.focus != null ? String(b.focus) : undefined,
    constraints: b.constraints != null ? String(b.constraints) : undefined,
    date: b.date != null ? String(b.date) : undefined,
  };
  if (backgroundOp(res, "session_suggest", input, b.agent)) return;
  try {
    res.json(await suggestSession(b.agent, {
      minutes: input.minutes, equipment: input.equipment, focus: input.focus,
      constraints: input.constraints, date: input.date,
    }));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Optional per-session autoregulation feedback (Phase 3B): 1-tap soreness /
// performance (1-5, clamped) and a free-text joint_pain area. Keyed by DATE
// (creates that date's session if needed); only provided fields are written.
// buildCoachPrompt reads these to bend volume / de-load a sore joint.
api.post("/sessions/:date/feedback", (req, res) => {
  try {
    const b = req.body ?? {};
    res.json(repo.setSessionFeedback(String(req.params.date), {
      soreness: b.soreness,
      performance: b.performance,
      joint_pain: b.joint_pain,
    }));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Skip / unskip a planned exercise for one date's session ("not today").
// An exercise with sets already logged that session refuses with 200 + ok:false
// — a designed state the PWA surfaces as a gentle toast, not an HTTP error.
api.post("/sessions/skip", (req, res) => {
  try {
    const b = req.body ?? {};
    if (!b.exercise || !String(b.exercise).trim()) return res.status(400).json({ error: "exercise required" });
    res.json(repo.skipExercise(String(b.exercise), b.date ? String(b.date) : undefined));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

api.delete("/sessions/skip", (req, res) => {
  try {
    const b = req.body ?? {};
    const exercise = String(b.exercise ?? req.query.exercise ?? "").trim();
    if (!exercise) return res.status(400).json({ error: "exercise required" });
    const date = b.date ?? req.query.date;
    res.json(repo.unskipExercise(exercise, date ? String(date) : undefined));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

api.post("/sets", (req, res) => {
  try {
    const b = req.body ?? {};
    if (!b.exercise) return res.status(400).json({ error: "exercise is required" });
    res.json(repo.logSetByName(b));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

api.delete("/sets/:id", (req, res) => res.json(repo.deleteSet(Number(req.params.id))));

// Edit a single logged set (history correction). Only provided fields are touched.
api.put("/sets/:id", (req, res) => {
  try {
    const b = req.body ?? {};
    const updated = repo.updateSet(Number(req.params.id), {
      weight: b.weight, reps: b.reps, rir: b.rir, note: b.note, duration_sec: b.duration_sec,
    });
    if (!updated) return res.status(404).json({ error: "not found" });
    res.json(updated);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

api.get("/progress/:exercise", (req, res) =>
  res.json(repo.getProgress(decodeURIComponent(req.params.exercise)))
);

api.get("/agents", (_req, res) => res.json(repo.getAgentConfig()));
api.get("/agent-clis/update", (_req, res) => res.json(getAgentCliUpdateStatus()));
api.post("/agent-clis/update", (_req, res) => res.status(202).json(startAgentCliUpdate("manual")));

// ---- settings (agent rotation + auto-coach schedule) ----
api.get("/settings", (_req, res) => res.json({ settings: repo.getSettings(), agents: repo.getAgentConfig() }));
api.put("/settings", (req, res) => res.json({ settings: repo.setSettings(req.body ?? {}), agents: repo.getAgentConfig() }));

api.post("/agent/run", async (req, res) => {
  const { agent, instruction } = req.body ?? {};
  try {
    const prompt = buildCoachPrompt(instruction);
    const { agent: chosen, result, tried } = await runChosen(agent, prompt);
    const proposal = repo.createProposal(chosen, instruction ?? "", result.raw, result.parsed);
    res.json({
      proposal,
      ok: !!result.parsed,
      agent: chosen,
      tried,
      exit_code: result.code,
      stderr: (result.stderr || "").slice(0, 800),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

api.get("/proposals", (req, res) =>
  res.json(repo.listProposals(req.query.limit ? Number(req.query.limit) : 20))
);

api.post("/proposals/:id/apply", (req, res) => {
  try {
    res.json(repo.applyProposal(Number(req.params.id)));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

api.post("/proposals/:id/discard", (req, res) =>
  res.json(repo.setProposalStatus(Number(req.params.id), "discarded"))
);

// ---- profile & goal ----
api.get("/profile", (_req, res) => res.json(repo.getProfile()));
api.put("/profile", (req, res) => res.json(repo.setProfile(req.body ?? {})));
api.get("/goal", (_req, res) => res.json(repo.computeGoalCheck()));

// ---- bodyweight log ----
api.get("/bodyweight", (req, res) => res.json(repo.listWeight(req.query.limit ? Number(req.query.limit) : 60)));
api.post("/bodyweight", (req, res) => {
  const b = req.body ?? {};
  if (b.weight_lb == null) return res.status(400).json({ error: "weight_lb required" });
  res.json(repo.logWeight(Number(b.weight_lb), b.date, b.note));
});

// ---- optional morning check-in (T5C: a day-read signal, offered never required) ----
// All fields optional; mood/energy/sleep_feel/soreness are clamped to 1-5 in the
// repo. GET /checkins?date= returns the latest for that date (or null);
// GET /checkins (no date) lists recent.
api.post("/checkins", (req, res) => {
  const b = req.body ?? {};
  res.json(repo.addCheckin(b.date, {
    mood: b.mood, energy: b.energy, sleep_feel: b.sleep_feel, soreness: b.soreness, note: b.note,
  }));
});
api.get("/checkins", (req, res) => {
  if (req.query.date) return res.json(repo.getCheckinByDate(String(req.query.date)));
  res.json(repo.listCheckins(req.query.limit ? Number(req.query.limit) : 14));
});

// ---- activities (free text or structured) ----
api.post("/activities", (req, res) => {
  const b = req.body ?? {};
  if (!b.text && !b.type) return res.status(400).json({ error: "text or type required" });
  res.json(repo.addActivity(b));
});
api.get("/activities", (req, res) =>
  res.json(repo.listActivities(req.query.limit ? Number(req.query.limit) : 20))
);
// Single activity row (frontend polls this to watch enrichment_status).
api.get("/activities/:id", (req, res) => {
  const a = repo.getActivity(Number(req.params.id));
  if (!a) return res.status(404).json({ error: "not found" });
  res.json(a);
});

// ---- Garmin source data (normalized ingest boundary) ----
api.get("/garmin/sources", (_req, res) => res.json(repo.listGarminSources()));
api.post("/garmin/sync", async (req, res) => {
  try {
    const { syncGarmin } = await import("./garmin.js");
    res.json(await syncGarmin(req.body ?? {}));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
api.post("/garmin/sources", (req, res) => {
  try {
    res.json(repo.upsertGarminSource(req.body ?? {}));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
api.get("/garmin/activities", (req, res) =>
  res.json(repo.listGarminActivities(req.query.limit ? Number(req.query.limit) : 30))
);
api.post("/garmin/activities", (req, res) => {
  try {
    res.json(repo.upsertGarminActivity(req.body ?? {}, req.body?.source_id ? Number(req.body.source_id) : undefined));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
api.get("/garmin/daily", (req, res) =>
  res.json(repo.listGarminDailyMetrics(req.query.limit ? Number(req.query.limit) : 30))
);
api.post("/garmin/daily", (req, res) => {
  try {
    res.json(repo.upsertGarminDailyMetric(req.body ?? {}, req.body?.source_id ? Number(req.body.source_id) : undefined));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
api.get("/garmin/summary", (req, res) =>
  res.json(repo.getGarminCoachSummary(req.query.days ? Number(req.query.days) : 14))
);
// Reconcile synced Garmin strength activities into the day's Cairn session: the
// deterministic physiology merge runs now; the agentic narrative/extrapolation
// is queued on the serial enrichment queue. {date} for one day, else {days} window.
api.post("/garmin/reconcile", async (req, res) => {
  try {
    const date = req.body?.date ? String(req.body.date) : undefined;
    const days = req.body?.days != null ? Number(req.body.days) : undefined;
    const rows = repo.listStrengthGarminActivities(date ? { date } : { days });
    const sessions: any[] = [];
    for (const r of rows) {
      const out = repo.reconcileGarminStrength(r.id);
      if (out?.session) sessions.push(out.session);
    }
    if (rows.length) {
      const { enqueueEnrich } = await import("./enrich.js");
      for (const r of rows) enqueueEnrich("garmin_strength", r.id);
    }
    res.json({ ok: true, reconciled: rows.length, sessions });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ---- source-agnostic daily metrics (T5D: Apple Health via Shortcuts) ----
// The documented Apple Shortcuts automation POSTs here. The body is EITHER one
// row OR an array of rows (a Shortcut can batch a backfill of several days), so
// we normalize to a list and upsert each via UNIQUE(source,date) — fully
// idempotent: re-posting a day overwrites it. Each row carries an optional
// `source` (default 'apple') and a `date` (YYYY-MM-DD, required per row), plus
// any of steps/sleep_min/sleep_score/resting_hr/hrv_ms/active_calories and a
// free-form `raw` blob preserved verbatim for later.
api.post("/health-metrics", (req, res) => {
  const body = req.body ?? {};
  // Cap the batch — a year of daily rows is a sane ceiling for a Shortcuts
  // backfill; the 25mb body limit + no auth means an unbounded loop of synchronous
  // sqlite upserts is otherwise possible. Per-row values are coerced/clamped in
  // repo.recordDailyMetrics (the trust boundary shared by REST + MCP).
  const rows: any[] = (Array.isArray(body) ? body : Array.isArray(body.rows) ? body.rows : [body]).slice(0, 366);
  const saved: any[] = [];
  const errors: { date?: string; error: string }[] = [];
  for (const r of rows) {
    const row = r ?? {};
    if (!row.date) { errors.push({ error: "date required" }); continue; }
    try {
      saved.push(repo.recordDailyMetrics(row.source ?? "apple", String(row.date), {
        steps: row.steps, sleep_min: row.sleep_min, sleep_score: row.sleep_score,
        resting_hr: row.resting_hr, hrv_ms: row.hrv_ms, active_calories: row.active_calories,
        raw: row.raw,
      }));
    } catch (e: any) {
      errors.push({ date: row.date, error: e?.message ?? "write failed" });
    }
  }
  res.json({ ok: errors.length === 0, saved: saved.length, rows: saved, errors });
});
// Recent metrics for a source (default all sources) over the last N days.
api.get("/health-metrics", (req, res) => {
  const source = req.query.source ? String(req.query.source) : null;
  const days = req.query.days ? Number(req.query.days) : 30;
  res.json(repo.getDailyMetrics(source, Number.isFinite(days) ? days : 30));
});
// Unified recovery view (Garmin + Apple/other merged) — graceful when empty.
api.get("/recovery", (req, res) =>
  res.json(repo.getRecoverySummary(req.query.days ? Number(req.query.days) : 14))
);

// ---- memory ----
// ?all=1 includes superseded rows (history) for the curation UI; default hides them.
api.get("/memory", (req, res) =>
  res.json(repo.listMemory(req.query.limit ? Number(req.query.limit) : 50, { includeSuperseded: req.query.all === "1" }))
);
api.post("/memory", (req, res) => {
  const b = req.body ?? {};
  if (!b.content) return res.status(400).json({ error: "content required" });
  res.json(repo.addMemory(b.content, b.kind, b.source));
});
api.put("/memory/:id", (req, res) => {
  const b = req.body ?? {};
  const updated = repo.updateMemory(Number(req.params.id), { content: b.content, kind: b.kind, confidence: b.confidence });
  if (!updated) return res.status(404).json({ error: "not found" });
  res.json(updated);
});
// Supersede (mark, never hard-delete): optionally provide a replacement content
// (a new row is created) or replacement_id (point at an existing row).
api.post("/memory/:id/supersede", (req, res) => {
  const b = req.body ?? {};
  const r = repo.supersedeMemory(Number(req.params.id), { content: b.replacement ?? b.content, kind: b.kind, replacementId: b.replacement_id, reason: b.reason });
  if (!r) return res.status(404).json({ error: "not found" });
  res.json(r);
});
api.delete("/memory/:id", (req, res) => res.json(repo.deleteMemory(Number(req.params.id))));

// Quiet memory consolidation: merge near-duplicates, supersede contradictions,
// promote recurring observations. Marks, never hard-deletes. On demand here; also
// scheduled nightly. Designed ok:false at 200 when the agent returns nothing usable.
api.post("/memory/consolidate", async (req, res) => {
  try { res.json(await consolidateMemory(req.body?.agent)); }
  catch (e: any) { res.json({ ok: false, error: e.message }); }
});

// Grow profile.about_me from typed memory + family + check-ins (augments, never
// overwrites blindly). changed:false is the calm, common answer.
api.post("/profile/grow-about-me", async (req, res) => {
  try { res.json(await growAboutMe(req.body?.agent)); }
  catch (e: any) { res.json({ ok: false, error: e.message }); }
});

// ---- outcome learning (suggestions → actuals) ----
api.get("/suggestions", (req, res) =>
  res.json(repo.listSuggestions(req.query.limit ? Number(req.query.limit) : 50))
);
// Reconcile past suggestions to what actually happened, writing durable learnings.
// Deterministic, no agent. Also scheduled quietly.
api.post("/suggestions/reconcile", (req, res) =>
  res.json(reconcileOutcomes({ maxPerPass: req.body?.max != null ? Number(req.body.max) : undefined }))
);

// ---- meal plans ----
// Draft a goal-aware weekly meal plan, then run a bounded self-critique verify
// pass against the lean-safe / longevity floors before persisting (see
// coachOps.draftMealPlan). The persisted plan is the verified draft; `verified`
// carries the "checked against your floors" signal. Verify fails open.
api.post("/coach/mealplan", async (req, res) => {
  const { agent, instruction } = req.body ?? {};
  if (backgroundOp(res, "meal_plan", { agent: agent ?? null, instruction }, agent)) return;
  try {
    res.json(await draftMealPlan(agent, instruction));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
api.get("/mealplans", (req, res) =>
  res.json(repo.listMealPlans(req.query.limit ? Number(req.query.limit) : 10))
);

// ---- adaptive nutrition (T3 / Phase 3A) ----
// Derived real expenditure (MacroFactor-style), adherence-neutral. Read-only;
// powers the calm "Energy Balance" view. ?window= overrides the 21-day window.
api.get("/nutrition/expenditure", (req, res) => {
  const window = req.query.window ? Number(req.query.window) : undefined;
  res.json(repo.estimateExpenditure(Number.isFinite(window as number) ? (window as number) : 21));
});

// Quiet adaptive-nutrition check-in: when the derived expenditure has drifted
// meaningfully off the goal, the agent drafts a calorie/macro target CHANGE as a
// DRAFT proposal to review — never auto-applied. Most weeks nothing has moved
// (change:false) and no proposal is created. ok:false (status 200) is the
// designed failure signal, mirroring the swap/recipe endpoints.
api.post("/nutrition/checkin", async (req, res) => {
  const b = req.body ?? {};
  const window = b.window ? Number(b.window) : undefined;
  if (backgroundOp(res, "nutrition_checkin", { agent: b.agent ?? null, window }, b.agent)) return;
  try {
    res.json(await nutritionCheckin(b.agent, window));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
// Agentic swap of ONE meal in a drafted plan, honoring an optional free-text
// hint ("let's go with fish"). ok:false (status 200) is the designed failure
// signal when the agent returns garbage — the PWA api() helper reads the body
// regardless of status.
api.post("/meal-plans/:id/swap", async (req, res) => {
  const b = req.body ?? {};
  const id = Number(req.params.id);
  const plan = repo.getMealPlan(id);
  if (!plan) return res.status(404).json({ error: "not found" });
  if (backgroundOp(res, "meal_swap", { agent: b.agent ?? null, id, day: String(b.day ?? ""), meal_index: Number(b.meal_index), hint: b.hint }, b.agent)) return;
  try {
    res.json(await swapMealAgentic(b.agent, { plan, id, day: String(b.day ?? ""), mealIndex: Number(b.meal_index), hint: b.hint }));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Agentic recipe for ONE planned meal, cached on the meal inside parsed_json.
// Cached recipe → instant { ok, recipe, cached:true } unless force. Like the
// swap endpoint, ok:false at status 200 is the designed failure signal.
api.post("/meal-plans/:id/recipe", async (req, res) => {
  const b = req.body ?? {};
  const id = Number(req.params.id);
  const plan = repo.getMealPlan(id);
  if (!plan) return res.status(404).json({ error: "not found" });
  const day = String(b.day ?? "");
  const mealIndex = Number(b.meal_index);
  const dayObj = (Array.isArray(plan.parsed?.days) ? plan.parsed.days : []).find(
    (d: any) => String(d?.day ?? "").trim().toLowerCase() === day.trim().toLowerCase()
  );
  const existing = Array.isArray(dayObj?.meals) ? dayObj.meals[mealIndex]?.recipe : undefined;
  if (existing && !b.force) return res.json({ ok: true, recipe: existing, cached: true });
  if (backgroundOp(res, "recipe", { agent: b.agent ?? null, id, day, meal_index: mealIndex }, b.agent)) return;
  try {
    res.json(await generateRecipe(b.agent, { plan, id, day, mealIndex }));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Replace a plan's days array (manual meal reorder/edit). Preserves every other
// parsed_json key (daily_kcal, shopping, notes, ...).
api.put("/meal-plans/:id/days", (req, res) => {
  try {
    const updated = repo.updateMealPlanDays(Number(req.params.id), (req.body ?? {}).days);
    if (!updated) return res.status(404).json({ error: "not found" });
    res.json(updated);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

api.post("/mealplans/:id/:status", (req, res) => {
  const s = req.params.status;
  if (!["accept", "discard"].includes(s)) return res.status(400).json({ error: "bad status" });
  res.json(repo.setMealPlanStatus(Number(req.params.id), s === "accept" ? "accepted" : "discarded"));
});

// ---- food notes (vision happens in the Claude client; this stores the result) ----
api.get("/food-notes", (req, res) =>
  res.json(repo.listFoodNotes(req.query.limit ? Number(req.query.limit) : 20))
);
// Single food note row, hydrated (frontend polls this to watch enrichment_status).
api.get("/food-notes/:id", (req, res) => {
  const f = repo.getFoodNote(Number(req.params.id));
  if (!f) return res.status(404).json({ error: "not found" });
  res.json(f);
});
api.post("/food-notes", (req, res) => {
  const b = req.body ?? {};
  res.json(repo.addFoodNote(b.meal, b.raw ?? b.text ?? "", b.parsed ?? null, b.image_path));
});
api.delete("/food-notes/:id", (req, res) => res.json(repo.deleteFoodNote(Number(req.params.id))));

// One-tap "frequents": the foods most often logged near a time of day (±2h),
// most-frequent first (max 8), with macros carried from the latest occurrence
// when present. ?hour= overrides the server clock (the PWA passes the device
// hour so frequents match the user's local time-of-day, not UTC).
api.get("/frequent-foods", (req, res) => {
  const hour = req.query.hour != null ? Number(req.query.hour) : undefined;
  res.json(repo.frequentFoods(Number.isFinite(hour) ? hour : undefined));
});

// ---- chat (conversational coach) ----
api.get("/chat", (req, res) => res.json(repo.listChatMessages(req.query.limit ? Number(req.query.limit) : 50)));

// Read-only history: browse past conversations (archived by "fresh start") and
// search across everything. These never mutate — nothing is hard-deleted.
api.get("/chat/search", (req, res) =>
  res.json(repo.searchChatMessages(String(req.query.q ?? ""), req.query.limit ? Number(req.query.limit) : 40)));
api.get("/chat/sessions", (req, res) =>
  res.json(repo.listArchivedSessions(req.query.limit ? Number(req.query.limit) : 50)));
api.get("/chat/sessions/:archivedAt", (req, res) =>
  res.json(repo.getArchivedConversation(req.params.archivedAt)));

// "Clear" archives rather than deletes (repo.clearChat → archiveChat): chat is
// part of the athlete's history/export, so nothing is hard-deleted anymore.
api.delete("/chat", (_req, res) => res.json(repo.clearChat()));

// "Fresh start": ARCHIVE the live conversation immediately (so the composer is
// usable at once — no blocking on the agent), then distill durable facts from the
// pre-archive history into memory in the BACKGROUND as a chat_distill job. The
// PWA settles a "✓ N remembered" pill when the job lands; a message typed during
// the distill just queues as a normal chat turn (archive-before-enqueue keeps the
// ordering). When bg_ops is OFF this falls back to the legacy blocking inline path.
api.post("/chat/reset", async (req, res) => {
  const history = repo.listChatMessages(200);
  if (!history.length) return res.json({ ok: true, distilled: 0, archived: 0 });
  const agent = req.body?.agent ?? null;
  if (repo.getSettings().bg_ops_enabled) {
    const snapshot = history.map((m: any) => ({ role: m.role, content: m.content }));
    const { archived } = repo.archiveChat();
    const job = repo.createAgentJob({ kind: "chat_distill", input: { agent, history: snapshot }, agent });
    enqueueAgentJob((job as any).id);
    return res.json({ ok: true, archived, distilling: (job as any).id });
  }
  // Legacy inline path (bg_ops off): distill (best-effort) then archive.
  const r = await distillChat(agent, history.map((m: any) => ({ role: m.role, content: m.content })));
  const { archived } = repo.archiveChat();
  res.json({ ok: true, distilled: r.distilled, archived, ...(r.farewell ? { farewell: r.farewell } : {}), ...(r.note ? { note: r.note } : {}) });
});

// Serve a chat-attached photo back to the PWA. Filename is locked to the
// UUID.ext shape we generate below, so no traversal / no serving arbitrary files.
api.get("/chat-images/:name", (req, res) => {
  const name = String(req.params.name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|gif|heic|heif)$/i.test(name)) {
    return res.status(400).json({ error: "bad name" });
  }
  const p = path.join(UPLOADS_DIR, name);
  if (!fs.existsSync(p)) return res.status(404).json({ error: "not found" });
  const ext = name.split(".").pop()!.toLowerCase();
  const mime = Object.entries(ACCEPTED_MIME).find(([, e]) => e === ext)?.[0] || "application/octet-stream";
  res.setHeader("Content-Type", mime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  fs.createReadStream(p).on("error", () => {
    if (!res.headersSent) res.status(500).json({ error: "read failed" });
  }).pipe(res);
});

// Chat is now a DURABLE, non-blocking turn (see src/chatTurns.ts): we persist the
// user message + a chat_turn and hand it to the serial worker, returning at once.
// The PWA streams progress over GET /api/chat/turns/:id/stream and rebuilds the
// in-flight + queued thread from GET /api/chat/turns on (re)load — so a follow-up
// queued mid-think, or a turn interrupted by navigation/reload/restart, survives.
api.post("/chat", (req, res) => {
  const b = req.body ?? {};
  const message = (b.message ?? "").toString().trim();

  // Optional attached photo (plate shot etc.): saved like a health-doc upload,
  // then the agent gets the absolute path and looks at the file itself.
  let imagePath: string | null = null;
  let imageUrl: string | null = null;
  if (b.image_base64) {
    const mime = (b.image_mime ?? "").toString().toLowerCase();
    if (!mime.startsWith("image/") || !isAcceptedMime(mime)) {
      return res.status(400).json({ error: "image_mime must be an accepted raster image type" });
    }
    let buf: Buffer;
    try { buf = Buffer.from(String(b.image_base64), "base64"); } catch { return res.status(400).json({ error: "invalid base64" }); }
    if (!buf.length) return res.status(400).json({ error: "empty image" });
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const name = `${crypto.randomUUID()}.${extForMime(mime)}`;
    imagePath = path.join(UPLOADS_DIR, name);
    fs.writeFileSync(imagePath, buf);
    imageUrl = `/api/chat-images/${name}`;
  }

  if (!message && !imagePath) return res.status(400).json({ error: "message or image required" });

  const userMsg = repo.addChatMessage("user", message || "(photo)", null, imageUrl ? { image: imageUrl } : undefined);
  const turn = repo.createChatTurn({
    message,
    image_path: imagePath,
    image_url: imageUrl,
    agent: b.agent ?? null,
    user_message_id: (userMsg as any).id,
  });
  enqueueChatTurn((turn as any).id);
  res.json({ ok: true, turn, user_message: userMsg });
});

// Active (queued + running) turns, oldest-first — the PWA reconstructs the live
// in-flight + queued thread from this on every (re)load (durable across restarts).
api.get("/chat/turns", (_req, res) => res.json(repo.listActiveChatTurns()));

// One turn's current state (poll fallback when SSE is unavailable).
api.get("/chat/turns/:id", (req, res) => res.json(repo.getChatTurn(Number(req.params.id)) ?? null));

// Stop a queued or running turn (drops it / SIGKILLs the live subprocess).
api.post("/chat/turns/:id/cancel", (req, res) => {
  const turn = cancelTurn(Number(req.params.id));
  res.json({ ok: !!turn, turn: turn ?? null });
});

// Live progress for one turn (Server-Sent Events). Sends an immediate snapshot
// (so a late subscriber / poll-fallback sees current state), then forwards every
// phase + the terminal event from the worker bus, then closes. A keepalive comment
// holds the connection through proxies. EventSource can't set headers, so the PWA
// reaches this with ?token= (withToken) when auth is on.
api.get("/chat/turns/:id/stream", (req, res) => {
  const id = Number(req.params.id);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event: string, data: any) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
  };

  const turn = repo.getChatTurn(id) as any;
  if (!turn) { send("error", { error: "no such turn" }); return res.end(); }

  // Initial snapshot, with the assistant message if the turn already finished.
  const assistantMsg = turn.assistant_message_id ? repo.getChatMessage(turn.assistant_message_id) : null;
  send("snapshot", { turn, message: assistantMsg });
  if (["done", "error", "canceled"].includes(turn.status)) return res.end();

  const keepalive = setInterval(() => { try { res.write(`: keepalive\n\n`); } catch { /* client gone */ } }, 15000);
  let unsubscribe = () => {};
  const cleanup = () => { clearInterval(keepalive); unsubscribe(); };
  unsubscribe = onTurnEvent(id, (e) => {
    send(e.type, e);
    if (e.type === "done" || e.type === "error" || e.type === "canceled") { cleanup(); res.end(); }
  });
  req.on("close", cleanup);
});

// ---- durable agent jobs (the backgrounded heavy agentic ops) ----
// Mirrors the chat-turns surface verbatim (the PWA's kind-agnostic job runner
// codes against this). The `done` event's `result` (and GET /:id's job.result) is
// byte-for-byte the body the corresponding op endpoint returned synchronously
// before this change — so the client's done-handler reuses its old rendering.

// Active (queued + running) jobs, oldest-first — the PWA reconstructs in-flight +
// queued ops from this on every (re)load (durable across restarts).
api.get("/agent-jobs", (_req, res) => res.json({ ok: true, jobs: repo.listActiveAgentJobs() }));

// One job's current state (poll fallback when SSE is unavailable). A `done` job
// includes job.result = the ref-hydrated contract body.
api.get("/agent-jobs/:id", (req, res) => {
  const job = repo.getAgentJob(Number(req.params.id));
  if (!job) return res.status(404).json({ ok: false, error: "not found" });
  res.json({ ok: true, job });
});

// Stop a queued or running job (drops it / SIGKILLs the live subprocess).
api.post("/agent-jobs/:id/cancel", (req, res) => {
  const job = cancelAgentJob(Number(req.params.id));
  res.json({ ok: !!job, job: job ?? null });
});

// Live progress for one job (Server-Sent Events). An immediate `snapshot` (so a
// late subscriber / poll-fallback sees current state, with the result if already
// terminal), then every phase + the terminal event from the worker bus, then
// close. EventSource can't set headers, so the PWA reaches this with ?token=.
api.get("/agent-jobs/:id/stream", (req, res) => {
  const id = Number(req.params.id);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event: string, data: any) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
  };

  const job = repo.getAgentJob(id) as any;
  if (!job) { send("error", { error: "no such job" }); return res.end(); }

  // Initial snapshot, with the result if the job already finished.
  send("snapshot", { job, ...(job.result !== undefined ? { result: job.result } : {}) });
  if (["done", "error", "canceled"].includes(job.status)) return res.end();

  const keepalive = setInterval(() => { try { res.write(`: keepalive\n\n`); } catch { /* client gone */ } }, 15000);
  let unsubscribe = () => {};
  const cleanup = () => { clearInterval(keepalive); unsubscribe(); };
  unsubscribe = onJobEvent(id, (e) => {
    send(e.type, e);
    if (e.type === "done" || e.type === "error" || e.type === "canceled") { cleanup(); res.end(); }
  });
  req.on("close", cleanup);
});

api.get("/stats", (_req, res) => res.json(repo.getWeeklyStats()));

api.get("/volume", (req, res) => res.json(repo.getVolumeByMuscle(Number(req.query.days) || 30)));

api.get("/calendar", (req, res) => res.json(repo.getTrainingCalendar(Number(req.query.days) || 84)));

api.get("/export", (_req, res) => {
  const data = { exported_at: todayISO(), ...repo.exportAll() };
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="cairn-export-${todayISO()}.json"`);
  res.send(JSON.stringify(data, null, 2));
});

api.get("/export/db", async (req, res) => {
  const tmp = path.join(os.tmpdir(), `cairn-snap-${process.pid}-${Date.now()}.db`);
  try {
    repo.snapshotDbTo(tmp);
    res.download(tmp, `cairn-${todayISO()}.db`, (err) => {
      fs.rm(tmp, { force: true }, () => {});
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ---- health documents (file upload + background AI analysis) ----
api.get("/health-docs", (req, res) =>
  res.json(repo.listHealthDocuments(req.query.limit ? Number(req.query.limit) : 50))
);

// Single row (frontend polls this to watch enrichment_status).
api.get("/health-docs/:id", (req, res) => {
  const d = repo.getHealthDocument(Number(req.params.id));
  if (!d) return res.status(404).json({ error: "not found" });
  res.json(d);
});

// Stream the original file inline. Only ever image/* or application/pdf.
api.get("/health-docs/:id/file", (req, res) => {
  const row = repo.getHealthDocumentRaw(Number(req.params.id)) as any;
  if (!row || !row.file_path || !fs.existsSync(row.file_path)) {
    return res.status(404).json({ error: "not found" });
  }
  // Serve inline only for raster images / PDF; zip/html/xml/text and anything
  // else are forced to download, and nosniff stops the browser re-interpreting bytes.
  const inline = isInlineMime(row.mime);
  res.setHeader("Content-Type", isAcceptedMime(row.mime) ? row.mime : "application/octet-stream");
  res.setHeader("Content-Disposition", inline ? "inline" : "attachment");
  res.setHeader("X-Content-Type-Options", "nosniff");
  fs.createReadStream(row.file_path).on("error", () => {
    if (!res.headersSent) res.status(500).json({ error: "read failed" });
  }).pipe(res);
});

api.post("/health-docs", (req, res) => {
  const b = req.body ?? {};
  const pasted = (b.text ?? "").toString().trim();
  const mime = pasted ? "text/plain" : (b.mime ?? "").toString();
  if (!isAcceptedMime(mime)) return res.status(400).json({ error: "mime must be an image, PDF, zip, HTML, XML, or pasted text" });
  if (!pasted && !b.data_base64) return res.status(400).json({ error: "data_base64 or text required" });

  let buf: Buffer;
  if (pasted) {
    buf = Buffer.from(pasted.slice(0, 400000), "utf8");
  } else {
    try {
      buf = Buffer.from(String(b.data_base64), "base64");
    } catch {
      return res.status(400).json({ error: "invalid base64" });
    }
  }
  if (!buf.length) return res.status(400).json({ error: "empty file" });

  try {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const name = `${crypto.randomUUID()}.${extForMime(mime)}`;
    const filePath = path.join(UPLOADS_DIR, name);
    fs.writeFileSync(filePath, buf);

    const status = repo.getSettings().enrich_enabled ? "pending" : "skipped";
    const row = repo.addHealthDocument({
      kind: b.kind ?? "other",
      doc_date: b.doc_date ?? null,
      original_name: b.original_name ?? (pasted ? "Pasted results" : null),
      mime,
      file_path: filePath,
      enrichment_status: status,
    });

    // Kick the background analyzer after the row exists.
    if (status === "pending") {
      import("./enrich.js").then((m) => m.enqueueEnrich("health", row.id)).catch(() => {});
    }
    res.json(row); // already stripped of file_path by repo.publicHealthDoc
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

api.put("/health-docs/:id", (req, res) => {
  const row = repo.getHealthDocument(Number(req.params.id));
  if (!row) return res.status(404).json({ error: "not found" });
  const b = req.body ?? {};
  const fields: { kind?: string | null; doc_date?: string | null } = {};
  if (b.kind !== undefined) fields.kind = b.kind;
  let dateChanged = false;
  if (b.doc_date !== undefined) {
    const d = b.doc_date == null ? null : String(b.doc_date).trim();
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: "doc_date must be YYYY-MM-DD" });
    fields.doc_date = d || null;
    dateChanged = (d || null) !== (row.doc_date || null);
  }
  const updated = repo.updateHealthDocFields(Number(req.params.id), fields);
  // A corrected date reorders the marker timeline and shifts what's "latest", so
  // refresh the deterministic directives and whole-picture review to keep the
  // analysis consistent.
  if (dateChanged) {
    try { repo.deriveDirectives(); } catch { /* keep the edit path resilient */ }
    import("./enrich.js").then((m) => m.enqueueReviewRefresh()).catch(() => {});
  }
  res.json(updated);
});

// Re-run the agentic scan over a document's original file (e.g. after a bad
// parse). Only rows that own a binary can be re-analyzed; derived dated panels
// and client-recorded analyses have nothing to re-read.
api.post("/health-docs/:id/reanalyze", (req, res) => {
  const row = repo.getHealthDocumentRaw(Number(req.params.id)) as any;
  if (!row) return res.status(404).json({ error: "not found" });
  if (!row.file_path) return res.status(400).json({ error: "no source file to re-analyze" });
  if (!repo.getSettings().enrich_enabled) return res.status(409).json({ error: "analysis is disabled in settings" });
  repo.setHealthDocEnrichStatus(Number(req.params.id), "pending");
  import("./enrich.js").then((m) => m.enqueueEnrich("health", Number(req.params.id))).catch(() => {});
  res.json(repo.getHealthDocument(Number(req.params.id)));
});

api.delete("/health-docs/:id", (req, res) => {
  const row = repo.getHealthDocumentRaw(Number(req.params.id)) as any;
  // Delete the row first; only unlink the file once the row is gone, so a DB
  // error can't strand a row pointing at a missing file. deleteHealthDocument
  // cascades to derived dated panels (which carry no binary of their own).
  const result = repo.deleteHealthDocument(Number(req.params.id));
  if (row?.file_path) {
    try { fs.rmSync(row.file_path, { force: true }); } catch { /* best-effort */ }
    // Clean up any unpacked-archive folder left by ingestion.
    try { fs.rmSync(`${row.file_path}-x`, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  res.json(result);
});

// ---- health insights (marker history + whole-picture agentic review) ----
api.get("/health/markers", (_req, res) => res.json(repo.getMarkerHistory()));

// Latest review or null — a soft lookup like /sessions?date= (200 + null on
// absence, never 404): "no review yet" is a normal state the PWA renders.
api.get("/health/review", (_req, res) => res.json(repo.getLatestHealthReview()));

// Run a fresh whole-picture health review via the shared agent rotation.
// Like the meal swap, ok:false at status 200 is the designed failure signal
// when the agent returns garbage (addHealthReview rejects the shape).
api.post("/health/review", async (req, res) => {
  const agent = req.body?.agent;
  if (backgroundOp(res, "health_review", { agent: agent ?? null }, agent)) return;
  try {
    res.json(await runHealthReview(agent));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ---- the connected brain: priority markers + propagation directives (T4) ----
// Markers re-ranked by impact (distance from OPTIMAL, most-actionable first).
// Informational, not medical advice; the impact_score is an internal ordering
// signal only and is never rendered as a user-facing grade.
api.get("/markers/priority", (_req, res) => res.json(repo.prioritizeMarkers()));

// Active cross-domain directives (?all=1 includes resolved/dismissed).
api.get("/directives", (req, res) =>
  res.json({ directives: repo.listDirectives({ all: req.query.all === "1" || req.query.all === "true" }) })
);

// User-controlled status flip (the review side of propose-review-apply). This
// is feedback memory, not just a hide: resolved/dismissed directives suppress
// equivalent future advice until the relevant marker changes enough. Nothing
// auto-applies. 400 on a bad status, 404 on an unknown id.
api.put("/directives/:id", (req, res) => {
  const status = String(req.body?.status ?? "");
  if (!["active", "resolved", "dismissed"].includes(status)) {
    return res.status(400).json({ error: "status must be active | resolved | dismissed" });
  }
  const updated = repo.updateDirective(Number(req.params.id), { status });
  if (!updated) return res.status(404).json({ error: "directive not found" });
  res.json({ ok: true, directive: updated });
});

// Re-run the deterministic propagation engine over the latest markers.
api.post("/directives/derive", (_req, res) => {
  const out = repo.deriveDirectives();
  res.json({ ok: true, derived: out.derived, directives: out.directives });
});

// ---- host-side research & grounding (Stream 4) ----
// Read cached evidence (by ?topic= and/or ?marker=). Always available — reads the
// cache only, never the network — so it works even with research disabled.
api.get("/research", (req, res) => {
  const topic = typeof req.query.topic === "string" ? req.query.topic : undefined;
  const marker = typeof req.query.marker === "string" ? req.query.marker : undefined;
  res.json({ enabled: repo.getSettings().research_enabled, evidence: repo.getEvidence({ topic, marker }) });
});

// Make a directive's citation INSPECTABLE: the cited evidence behind ONE marker,
// projected to the verifiable fields { claim, source_title, source_url, body,
// confidence, retrieved_at }. Reads the cache only (never the network), so it
// works with research disabled; evidence:[] when research never ran for it.
api.get("/evidence", (req, res) => {
  const marker = typeof req.query.marker === "string" ? req.query.marker : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  res.json(repo.getEvidenceForMarker(marker, Number.isFinite(limit as number) ? (limit as number) : undefined));
});

// Run a cited, web-grounded evidence pass for ONE question and cache it. Gated by
// settings.research_enabled: when off, serves only cached evidence and returns
// ok:false (the designed signal, at 200) — never reaches the network. Informational,
// not medical advice.
api.post("/research", async (req, res) => {
  try {
    const question = String(req.body?.question ?? "").trim();
    if (!question) return res.status(400).json({ ok: false, error: "question required" });
    const markers = Array.isArray(req.body?.markers) ? req.body.markers.map(String) : [];
    res.json(await runResearch(question, { markers, agent: req.body?.agent, force: !!req.body?.force }));
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- quiet cross-domain insights (Phase 6: pull-based, never pushed) ----
// The Brief surfaces ONE at a time when the app is opened. GET returns the live
// stream (new + seen, most recent first); dismissed insights stay in the DB and
// exports but are hidden here.
api.get("/insights", (req, res) =>
  res.json(repo.listVisibleInsights(req.query.limit ? Number(req.query.limit) : 20))
);

// Run ONE agentic pass over the whole picture for a single genuine cross-domain
// connection, dedupe against what we've already said, and store it. Like the
// health review, ok:false at status 200 is the designed failure signal — the
// agent found nothing real (found:false) or returned an unusable shape. NO push
// notification ever fires; the result simply waits in-app.
api.post("/insights/generate", async (req, res) => {
  const agent = req.body?.agent;
  const kind = req.body?.kind === "weekly_read" ? "weekly_read" : "insight";
  if (backgroundOp(res, kind, { agent: agent ?? null, kind: req.body?.kind }, agent)) return;
  try {
    res.json(await generateInsight(agent, req.body?.kind));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Mark an insight seen/dismissed and/or record thumbs feedback. On feedback:'up'
// we ALSO write the insight text to memory so the relationship learns what kind
// of connection lands. 404 on unknown id (a real lookup, unlike the soft reads).
api.put("/insights/:id", (req, res) => {
  const b = req.body ?? {};
  const updated = repo.updateInsight(Number(req.params.id), { status: b.status, feedback: b.feedback });
  if (!updated) return res.status(404).json({ error: "not found" });
  if (b.feedback === "up") {
    const text = String((updated as any).text ?? "").trim();
    if (text) repo.addMemory(text, "insight", "insight-feedback");
  }
  res.json(updated);
});

// ---- context events (life timeline: trips / injuries / life events) ----
api.get("/context-events", (req, res) =>
  res.json(repo.listContextEvents({ activeOnly: req.query.active === "1" || req.query.active === "true" }))
);
api.post("/context-events", (req, res) => {
  const b = req.body ?? {};
  if (!b.kind) return res.status(400).json({ error: "kind required" });
  res.json(repo.addContextEvent({
    kind: b.kind, title: b.title, detail: b.detail,
    start_date: b.start_date, end_date: b.end_date, meta: b.meta, archived: b.archived,
  }));
});
api.put("/context-events/:id", (req, res) => {
  const b = req.body ?? {};
  const updated = repo.updateContextEvent(Number(req.params.id), {
    kind: b.kind, title: b.title, detail: b.detail,
    start_date: b.start_date, end_date: b.end_date, meta: b.meta, archived: b.archived,
  });
  if (!updated) return res.status(404).json({ error: "not found" });
  res.json(updated);
});
api.delete("/context-events/:id", (req, res) => res.json(repo.deleteContextEvent(Number(req.params.id))));

// ---- family roster (Me -> Family; recurring commitments live as family_event context_events) ----
api.get("/family", (_req, res) => res.json(repo.listFamily()));
api.post("/family", (req, res) => {
  const b = req.body ?? {};
  res.json(repo.addFamily({
    name: b.name, color: b.color, relationship: b.relationship,
    birthdate: b.birthdate, notes: b.notes,
  }));
});
api.put("/family/:id", (req, res) => {
  const b = req.body ?? {};
  const updated = repo.updateFamily(Number(req.params.id), {
    name: b.name, color: b.color, relationship: b.relationship,
    birthdate: b.birthdate, notes: b.notes,
  });
  if (!updated) return res.status(404).json({ error: "not found" });
  res.json(updated);
});
api.delete("/family/:id", (req, res) => res.json(repo.deleteFamily(Number(req.params.id))));

// ---- generated artwork (Gemini image cache; see src/art.ts) ----
// Cache hit → the PNG, immutable-cached. Miss → 204 immediately and a background
// generation is queued (when a Gemini key is set and art_enabled); the client
// simply retries later. No key / disabled / known-failed also → 204.
api.get("/art", (req, res) => {
  const kind = String(req.query.kind ?? "");
  const q = String(req.query.q ?? "").trim();
  if (!isArtKind(kind)) return res.status(400).json({ error: "kind must be food|exercise|activity" });
  if (!q || q.length > 200) return res.status(400).json({ error: "q required, max 200 chars" });

  const file = cachedArtPath(kind, q);
  if (file) {
    // Gemini may hand back JPEG bytes even though we cache as .png — declare
    // the real format (sniffed from the magic bytes) so nosniff stays honest.
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
    return fs.createReadStream(file).on("error", () => {
      if (!res.headersSent) res.status(500).json({ error: "read failed" });
    }).pipe(res);
  }
  requestArt(kind, q); // no-op when unavailable; serial queue dedups in-flight keys
  res.status(204).end();
});

// Warm the art cache: enqueue generation for everything the PWA will ask for
// (exercises, current meal plans, recent food notes/activities). Safe no-op
// when generation is unavailable — requestArt handles that per query.
api.post("/art/warm", (_req, res) => {
  const { queued, skipped } = warmArt();
  res.json({ ok: true, queued, skipped });
});

// Artwork spend telemetry: estimated Gemini cost since art was last enabled,
// all-time totals, generations avoided via semantic reuse, and cache size.
api.get("/art/stats", (_req, res) => res.json(repo.getArtStats()));

// Agent-run telemetry: ok-rate, per-agent reliability + median latency, and the
// recent raw attempts. An operator/health view — NOT a user-facing score.
// Optional ?recent=N (last N attempts) and ?days=N (window the roll-up).
api.get("/agent-stats", (req, res) => {
  const recent = req.query.recent != null ? Number(req.query.recent) : undefined;
  const days = req.query.days != null ? Number(req.query.days) : undefined;
  res.json(repo.getAgentStats({ recent, days }));
});

api.get("/health", (_req, res) => res.json({ ok: true, auth_required: authEnabled }));

// Global JSON error handler — registered LAST so any uncaught route error
// returns JSON, not Express's default HTML error page (the PWA's api() helper
// calls r.json() and would break on HTML).
api.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err?.message ?? "internal error" });
});
