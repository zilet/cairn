import { Router } from "express";
import * as repo from "../repo.js";
import { localDateISO } from "../repo/shared.js";

export const todayRouter = Router();

// ---- Era 2 (the calm daily driver, docs/VISION.md §12) ----
// The Today salience arbiter: ONE ranking + budget pass over the whole Today
// surface, so only the 1-2 things that matter most today render inline and the
// rest collapse behind a quiet "more". Marking "seen" at the end (debounced)
// powers the "since you last looked" continuity line.
todayRouter.get("/today-agenda", (req, res) => {
  const date = typeof req.query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
    ? req.query.date
    : undefined;
  const agenda = repo.todayAgenda(date);
  try {
    if (repo.shouldMarkTodayAgendaSeen(date, localDateISO())) repo.markTodaySeen();
  } catch {
    /* best-effort */
  }
  res.json(agenda);
});

// The legible "what Cairn has learned about you" timeline (pull-only; no scores).
todayRouter.get("/learned-timeline", (req, res) => {
  const limit = Number.parseInt(String(req.query.limit ?? ""), 10);
  res.json(repo.learnedTimeline({ limit: Number.isFinite(limit) ? limit : undefined }));
});

// Trusted clinical-guideline statements (offline pack) for a marker, or the whole set.
todayRouter.get("/guidelines", (req, res) => {
  const marker = typeof req.query.marker === "string" ? req.query.marker : "";
  if (marker.trim()) return res.json({ marker, guideline: repo.guidelineFor(marker) });
  res.json({ guidelines: repo.allGuidelines() });
});

// The "since you last looked" continuity line standalone (or null).
todayRouter.get("/since-last", (_req, res) => res.json(repo.sinceLastLookedCandidate() ?? null));

// Gentle goal check-in (you-drive): confirm restarts the ~3-month stable clock;
// dismiss starts the cooldown. Neither changes the goal — that's the profile flow.
todayRouter.post("/goal-checkin/confirm", (_req, res) => {
  repo.confirmGoalCheckin();
  res.json({ ok: true });
});
todayRouter.post("/goal-checkin/dismiss", (_req, res) => {
  repo.dismissGoalCheckin();
  res.json({ ok: true });
});
