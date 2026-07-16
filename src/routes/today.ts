import { Router } from "express";
import {
  acknowledgeTodayAgendaCandidate,
  confirmGoalCheckin,
  dismissGoalCheckin,
  learnedTimeline,
  markTodaySeen,
  shouldMarkTodayAgendaSeen,
  sinceLastLookedCandidate,
  teamWeekRead,
  todayAgenda,
} from "../domain/brain/index.js";
import { allGuidelines, guidelineFor } from "../domain/health/index.js";
import { getProfile } from "../domain/person/index.js";
import { getPlan, getSessionByDate, getWeeklyStats, listExercises, selectedPlanDayForDate } from "../domain/training/index.js";
import { localDateISO } from "../repo/shared.js";

export const todayRouter = Router();

function todayDateParam(value: unknown): string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : localDateISO();
}

export function todayAggregate(dateQuery?: unknown) {
  const date = todayDateParam(dateQuery);
  return {
    date,
    plan: getPlan(),
    session: getSessionByDate(date),
    stats: getWeeklyStats(),
    profile: getProfile(),
    exercises: listExercises(),
  };
}

// ---- Era 2 (the calm daily driver, docs/VISION.md §12) ----
// Cold-start aggregate for the Today screen. This is deliberately only the
// independent low-risk reads the client previously fetched separately; route
// semantics for /plan, /sessions?date=, /stats, /profile, and /exercises stay
// unchanged and the client still primes their individual SWR keys.
todayRouter.get("/today", (req, res) => {
  res.json(todayAggregate(req.query.date));
});

export function publicTodayPlanDay(dateQuery?: unknown) {
  const selected = selectedPlanDayForDate(todayDateParam(dateQuery));
  if (!selected) return null;
  const adaptiveReason = typeof selected.selection?.reason === "string"
    ? selected.selection.reason.trim().slice(0, 240)
    : null;
  return {
    day_number: selected.day_number,
    focus: selected.focus,
    source: selected.source,
    reason: adaptiveReason || (selected.source === "existing-session" ? "Continue the session already linked to this date." : null),
  };
}

// Canonical implicit plan-day choice for Today/Session. Manual day selection is
// an explicit client override and therefore does not call this route. The public
// DTO is deliberately bounded: internal candidate scores and load arrays stay on
// the server.
todayRouter.get("/today-plan-day", (req, res) => {
  res.json(publicTodayPlanDay(req.query.date));
});

// The Today salience arbiter: ONE ranking + budget pass over the whole Today
// surface, so only the 1-2 things that matter most today render inline and the
// rest collapse behind a quiet "more". Marking "seen" at the end (debounced)
// powers the "since you last looked" continuity line.
todayRouter.get("/today-agenda", (req, res) => {
  const date = typeof req.query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
    ? req.query.date
    : undefined;
  const agenda = todayAgenda(date);
  try {
    if (shouldMarkTodayAgendaSeen(date, localDateISO())) markTodaySeen();
  } catch {
    /* best-effort */
  }
  res.json(agenda);
});

// Presentation acknowledgement only: this retires the current semantic revision
// from Today without resolving or dismissing the underlying health directives.
// Materially new evidence creates a new revision and may surface again.
todayRouter.post("/today-agenda/ack", (req, res) => {
  const id = String(req.body?.id ?? "").trim();
  if (!id) return res.status(400).json({ ok: false, error: "id required" });
  const revision = typeof req.body?.revision === "string" ? req.body.revision : null;
  const result = acknowledgeTodayAgendaCandidate(id, revision);
  res.status(result.stale ? 409 : result.ok ? 200 : 404).json(result);
});

// The team's-week digest — the deterministic "here's what your team did this
// week" read that sits under the agentic weekly sentence (pull-only; words, no
// scores). This is the human-facing surface, so it MAY drain the oldest 1-2
// unseen backlog insights (flipping new→seen) so nothing rots unseen.
todayRouter.get("/team-week", (_req, res) => {
  res.json(teamWeekRead({ drainBacklog: true }));
});

// The legible "what Cairn has learned about you" timeline (pull-only; no scores).
todayRouter.get("/learned-timeline", (req, res) => {
  const limit = Number.parseInt(String(req.query.limit ?? ""), 10);
  res.json(learnedTimeline({ limit: Number.isFinite(limit) ? limit : undefined }));
});

// Trusted clinical-guideline statements (offline pack) for a marker, or the whole set.
todayRouter.get("/guidelines", (req, res) => {
  const marker = typeof req.query.marker === "string" ? req.query.marker : "";
  if (marker.trim()) return res.json({ marker, guideline: guidelineFor(marker) });
  res.json({ guidelines: allGuidelines() });
});

// The "since you last looked" continuity line standalone (or null).
todayRouter.get("/since-last", (_req, res) => res.json(sinceLastLookedCandidate() ?? null));

// Gentle goal check-in (you-drive): confirm restarts the ~3-month stable clock;
// dismiss starts the cooldown. Neither changes the goal — that's the profile flow.
todayRouter.post("/goal-checkin/confirm", (_req, res) => {
  confirmGoalCheckin();
  res.json({ ok: true });
});
todayRouter.post("/goal-checkin/dismiss", (_req, res) => {
  dismissGoalCheckin();
  res.json({ ok: true });
});
