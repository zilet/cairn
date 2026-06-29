import { Router } from "express";
import { draftCoachProposal, evolveProgram } from "../coachOps.js";
import { localToday } from "../dayread.js";
import * as repo from "../repo.js";
import { backgroundOp } from "./background-op.js";

export const programRouter = Router();

// Draft a plan proposal from a free-text instruction (the Coach tab's DRAFT PLAN
// UPDATE + the Plan → Endurance "shape your running" composer). A durable
// background job by default — the PWA streams the evolving caption + reconnects
// across reloads, exactly like session-suggest / meal-plan; when bg ops are off it
// runs inline and returns the legacy body unchanged. draftCoachProposal owns the
// agent run + proposal persistence so both paths return byte-for-byte the same body.
programRouter.post("/agent/run", async (req, res) => {
  const { agent, instruction } = req.body ?? {};
  if (backgroundOp(res, "proposal", { agent: agent ?? null, instruction: instruction ?? "" }, agent)) return;
  try {
    res.json(await draftCoachProposal(agent, instruction));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Adaptive program evolution: read the program-state and draft a plan EVOLUTION
// (progress / deload / rotate-a-variation / periodize) as a DRAFT proposal for
// review — same propose→apply path as /agent/run, driven by the trend analysis.
programRouter.post("/program/evolve", async (req, res) => {
  const { agent, instruction } = req.body ?? {};
  // Long agentic call → a durable background job by default (the PWA streams the
  // evolving caption + reconnects across reloads, like session-suggest); inline
  // when bg ops are off. evolveProgram owns the run + proposal persistence so both
  // paths return the same body.
  if (backgroundOp(res, "evolve_program", { agent: agent ?? null, instruction: instruction ?? "" }, agent)) return;
  try {
    res.json(await evolveProgram(agent, instruction));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Periodization blocks (the mesocycle model the coach periodizes toward).
programRouter.get("/program/blocks", (req, res) =>
  res.json(repo.listBlocks(req.query.limit ? Number(req.query.limit) : 20))
);
programRouter.get("/program/blocks/active", (_req, res) => res.json(repo.getActiveBlock()));
programRouter.post("/program/blocks", (req, res) => res.json(repo.createBlock(req.body ?? {})));
programRouter.put("/program/blocks/:id", (req, res) => {
  const b = repo.updateBlock(Number(req.params.id), req.body ?? {});
  if (!b) return res.status(404).json({ error: "not found" });
  res.json(b);
});
programRouter.post("/program/blocks/:id/advance", (req, res) => {
  const b = repo.advanceBlockWeek(Number(req.params.id));
  if (!b) return res.status(404).json({ error: "not found" });
  res.json(b);
});
programRouter.post("/program/blocks/:id/complete", (req, res) => {
  const b = repo.completeBlock(Number(req.params.id));
  if (!b) return res.status(404).json({ error: "not found" });
  res.json(b);
});

// ---- program intelligence (progression engine + balance + adjustments) --------
// Volume balance per canonical muscle group over the last N weeks (default 2).
// Plain words: which groups are due, which are over, and an adherence-skew
// summary. No scores — band labels (low/productive/high) are the output.
programRouter.get("/program/balance", (_req, res) => res.json(repo.programBalance()));

// Per-lift next-session prescription for every strength item on a plan day.
// ?day=N selects the day; omit to default to the plan day today's read points
// at (the "upcoming session" the Brief already suggests). Returns [] when the
// day has no strength items or does not exist.
programRouter.get("/program/progression", (req, res) => {
  let dayNumber: number | undefined;
  if (req.query.day !== undefined) {
    dayNumber = Number(req.query.day);
  } else {
    // Default: the plan day the day-read is pointing at today. Mirrors the
    // nextPlanDayNumber logic in coach.ts — match the cached day-read's focus
    // to a plan day; fall back to the first plan day with strength items.
    const cached = repo.getCachedDayRead(localToday());
    const focus = cached?.focus ? String(cached.focus).toLowerCase().trim() : null;
    const days = repo.getPlan();
    const strengthDays = days.filter((d: any) =>
      Array.isArray(d.items) && d.items.some((it: any) => it.kind !== "cardio" && it.exercise)
    );
    if (strengthDays.length) {
      const matched = focus
        ? strengthDays.find((d: any) => {
            const f = String(d.focus || d.name || "").toLowerCase().trim();
            return f && (f === focus || f.includes(focus) || focus.includes(f));
          })
        : null;
      dayNumber = (matched ?? strengthDays[0]).day_number;
    }
  }
  if (dayNumber == null || !Number.isFinite(dayNumber)) return res.json([]);
  res.json(repo.planDayProgression(dayNumber));
});

// The handful of concrete adaptations due right now — lifts to push/hold/deload,
// groups that are due, missing-pattern gaps. Plain words, most-actionable first.
programRouter.get("/program/adjustments", (_req, res) => res.json(repo.programAdjustments()));

// Build a DRAFT plan proposal from the current day's per-lift prescriptions, via
// the same propose→apply path as /agent/run and /program/evolve. Never auto-
// applied. Returns { ok:true, proposal } or { ok:false, error } at 200 (the
// designed-failure signal — nothing wrong at the HTTP level, just nothing to do).
programRouter.post("/program/progression/apply", (req, res) => {
  const day = Number((req.body ?? {}).day);
  if (!Number.isFinite(day)) return res.json({ ok: false, error: "day required" });
  const prescriptions = repo.planDayProgression(day);
  // Only lifts whose target actually MOVES (overload/deload/vary) become a change —
  // a "hold" is by definition no change, so it would apply as a confusing no-op and
  // inflate the count. Each change carries the full apply payload: day_number (so
  // applyPlanChange can locate the lift — its absence was the "No plan day NaN" /
  // "Couldn't apply" bug), the sets/reps for context, and a plain-words `reason`.
  const changes = prescriptions
    .filter((p) => p.action !== "hold")
    .map((p) => {
      const c: Record<string, any> = {
        day_number: day,
        exercise: p.exercise,
        sets: p.suggested?.sets ?? null,
        rep_low: p.suggested?.rep_low ?? null,
        rep_high: p.suggested?.rep_high ?? null,
        reason: p.why || p.delta_text || null,
      };
      if (p.mode === "timed") {
        if (p.suggested.seconds != null) c.target_seconds = p.suggested.seconds;
      } else {
        if (p.suggested.weight !== undefined) c.target_weight = p.suggested.weight;
      }
      return c;
    })
    .filter((c) => c.target_weight !== undefined || c.target_seconds !== undefined);
  if (!changes.length) return res.json({ ok: false, error: "nothing to propose for this day" });
  const parsed = {
    summary: `Auto-progression for day ${day} — ${changes.length} lift${changes.length === 1 ? "" : "s"}`,
    changes,
  };
  // Retire any prior un-applied auto-progression draft for THIS day so repeated taps
  // never stack duplicates in the Coach list (the fresh draft reflects the latest logs).
  repo.supersedeAutoProgressionDrafts(day);
  const proposal = repo.createProposal("auto-progression", `day ${day} progression`, "", parsed);
  res.json({ ok: true, proposal });
});

programRouter.get("/proposals", (req, res) =>
  res.json(repo.listProposals(req.query.limit ? Number(req.query.limit) : 20))
);

programRouter.post("/proposals/:id/apply", (req, res) => {
  try {
    res.json(repo.applyProposal(Number(req.params.id)));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

programRouter.post("/proposals/:id/discard", (req, res) =>
  res.json(repo.setProposalStatus(Number(req.params.id), "discarded"))
);

// Adaptive program state: per-lift trend + plateau/stall, volume landmarks,
// mesocycle position, endurance trends — the deterministic read the evolve-program
// proposal builds on. Informational (no score, no gate).
programRouter.get("/program-state", (req, res) =>
  res.json(repo.getProgramState(req.query.date ? String(req.query.date) : undefined))
);
// The TRAINING-INTELLIGENCE / performance read — the athletic counterpart to
// /api/health/standing. Benchmarks where the athlete actually STANDS (each lift's
// capacity vs sex/age strength standards + VO2max norms), the strength imbalances,
// the single biggest lever, lifts worth re-testing, a variety nudge, and a holistic
// balance line. Derived live each call; percentile/level reference reads, no scores.
programRouter.get("/performance", (req, res) =>
  res.json(repo.performanceStanding(req.query.date ? String(req.query.date) : undefined))
);
// The RUNNING brain: this week's deterministic periodized run mix (N easy Z2 + 1
// long + 1 rotated quality, each with a bpm-bearing zone + interval structure) and
// the athlete's real HR-zone bpm bands. The endurance counterpart to /performance.
// Both degrade to {available:false} for a non-runner / no zones.
programRouter.get("/run-plan", (req, res) =>
  res.json(repo.weeklyRunPlan(req.query.date ? String(req.query.date) : undefined))
);
programRouter.get("/run-zones", (_req, res) => res.json(repo.runZones()));
// Per-canonical-muscle-group advance/stall trajectory + the cadenced strength
// test-week read. Plain words, no scores; quiet to {available:false}/{due:false}.
programRouter.get("/muscle-trajectory", (req, res) =>
  res.json(repo.muscleGroupTrajectory(req.query.date ? String(req.query.date) : undefined))
);
programRouter.get("/test-week", (req, res) =>
  res.json(repo.testWeekDue(req.query.date ? String(req.query.date) : undefined))
);
// DEXA-driven targeting: the body scan's regional read → concrete training +
// nutrition targets, each with a "path to your next scan". {available:false} w/o DEXA.
programRouter.get("/dexa-targeting", (_req, res) => res.json(repo.dexaTargeting()));
// Build a DRAFT plan proposal from this week's deterministic run mix, via the same
// propose→apply path as /program/progression/apply. Maps weeklyRunPlan(date).runs →
// parsed.cardio[] (applyProposal → setWeeklyRuns, keeping strength intact + carrying
// interval structure). Never auto-applied. Returns the designed ok:false at 200.
programRouter.post("/program/run-plan/apply", (req, res) => {
  const date = (req.body ?? {}).date ? String((req.body as any).date) : undefined;
  res.json(repo.buildRunPlanProposal(date));
});
