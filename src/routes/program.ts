import { Router } from "express";
import { draftCoachProposal, evolveProgram } from "../coachOps.js";
import { localToday } from "../dayread.js";
import { applyProposalWithAutonomy, getCachedDayRead } from "../domain/brain/index.js";
import { dexaTargeting } from "../domain/health/index.js";
import {
  advanceBlockWeek,
  applyProposal,
  buildAndApplySwap,
  buildProgressionProposal,
  buildRunPlanProposal,
  buildSwapProposal,
  completeBlock,
  createBlock,
  ensureActiveBlock,
  getActiveBlock,
  getEquipmentProfile,
  getPlan,
  getProgramState,
  listBlocks,
  listProposals,
  muscleGroupTrajectory,
  performanceStanding,
  planDayProgression,
  programAdjustments,
  programBalance,
  recentMuscleLoad,
  runZones,
  setEquipmentProfile,
  setProposalStatus,
  testWeekDue,
  trainingPlaybook,
  updateBlock,
  weeklyRunPlan,
} from "../domain/training/index.js";
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

// The persisted equipment/preference profile (free text) that RANKS variation
// suggestions by what the user can actually load. GET reads it (+ the parsed
// equipment types); PUT replaces it (null/'' clears). A plain profile field.
programRouter.get("/program/equipment", (_req, res) => res.json(getEquipmentProfile()));
programRouter.put("/program/equipment", (req, res) => {
  const eq = (req.body ?? {}).equipment;
  res.json(setEquipmentProfile(eq === undefined ? null : eq));
});

// Periodization blocks (the mesocycle model the coach periodizes toward).
programRouter.get("/program/blocks", (req, res) =>
  res.json(listBlocks(req.query.limit ? Number(req.query.limit) : 20))
);
programRouter.get("/program/blocks/active", (_req, res) => res.json(getActiveBlock()));
// Ensure ONE active periodization block exists (auto-create a sensible default aligned
// to the user's goal when none is running; idempotent — never resets an in-progress
// block). Keeps periodization live without waiting for the scheduler's weekly slot.
programRouter.post("/program/blocks/ensure", (_req, res) => res.json(ensureActiveBlock()));
programRouter.post("/program/blocks", (req, res) => res.json(createBlock(req.body ?? {})));
programRouter.put("/program/blocks/:id", (req, res) => {
  const b = updateBlock(Number(req.params.id), req.body ?? {});
  if (!b) return res.status(404).json({ error: "not found" });
  res.json(b);
});
programRouter.post("/program/blocks/:id/advance", (req, res) => {
  const b = advanceBlockWeek(Number(req.params.id));
  if (!b) return res.status(404).json({ error: "not found" });
  res.json(b);
});
programRouter.post("/program/blocks/:id/complete", (req, res) => {
  const b = completeBlock(Number(req.params.id));
  if (!b) return res.status(404).json({ error: "not found" });
  res.json(b);
});

// ---- program intelligence (progression engine + balance + adjustments) --------
// Volume balance per canonical muscle group over the last N weeks (default 2).
// Plain words: which groups are due, which are over, and an adherence-skew
// summary. No scores — band labels (low/productive/high) are the output.
programRouter.get("/program/balance", (_req, res) => res.json(programBalance()));

// Acute per-muscle freshness over the last ~2 days — recent strength sets AND
// endurance sessions folded onto the regions they fatigue (a long ride loads the
// legs). Lets the Train overview say "recovering from yesterday's ride" instead
// of "undertrained" on a group that's simply resting. Plain words, no scores.
programRouter.get("/muscle-load", (req, res) => {
  const days = Number(req.query.days) > 0 ? Math.min(7, Number(req.query.days)) : 2;
  res.json({ days, groups: [...recentMuscleLoad(days).values()] });
});

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
    const cached = getCachedDayRead(localToday());
    const focus = cached?.focus ? String(cached.focus).toLowerCase().trim() : null;
    const days = getPlan();
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
  res.json(planDayProgression(dayNumber));
});

// The handful of concrete adaptations due right now — lifts to push/hold/deload,
// groups that are due, missing-pattern gaps. Plain words, most-actionable first.
programRouter.get("/program/adjustments", (_req, res) => res.json(programAdjustments()));

// Build a DRAFT plan proposal from the current day's per-lift prescriptions, via
// the same propose→apply path as /agent/run and /program/evolve. Never auto-
// applied. Returns { ok:true, proposal } or { ok:false, error } at 200 (the
// designed-failure signal — nothing wrong at the HTTP level, just nothing to do).
programRouter.post("/program/progression/apply", (req, res) => {
  // ONE shared builder (buildProgressionProposal) with MCP so the two never drift. A
  // "hold" (incl. an autoregulation-braked hold) is dropped; a "vary" becomes a real
  // {swap:{from,to}} change instead of the old no-op same-exercise write.
  res.json(buildProgressionProposal(Number((req.body ?? {}).day)));
});

// Draft a single-exercise SWAP (rotate `from` out for `to` on a day) as a DRAFT
// proposal via the propose→apply path — behind Today's "rotate one in" chips. Never
// auto-applied. Returns the designed { ok:false, error } at 200 on bad input.
programRouter.post("/program/swap", (req, res) => {
  const { day, from, to } = req.body ?? {};
  res.json(buildSwapProposal(Number(day), from, to));
});

// Swap AND apply in one tap — the in-session "rotate one in" chip. Unlike
// /program/swap (draft → review in Coach), this lands the swap in the plan
// immediately so the athlete can log against the new movement now; the plan
// adapts as they go. Returns { ok:true, swapped } or the designed { ok:false,
// error } at 200.
programRouter.post("/program/swap/apply", (req, res) => {
  const { day, from, to } = req.body ?? {};
  res.json(buildAndApplySwap(Number(day), from, to));
});

programRouter.get("/proposals", (req, res) =>
  res.json(listProposals(req.query.limit ? Number(req.query.limit) : 20))
);

programRouter.post("/proposals/:id/apply", (req, res) => {
  try {
    res.json(applyProposal(Number(req.params.id)));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

programRouter.post("/proposals/:id/lead", (req, res) => {
  try {
    res.json(
      applyProposalWithAutonomy(Number(req.params.id), {
        requested_tier: req.body?.requested_tier,
        safety_response: !!req.body?.safety_response,
        user_locked: !!req.body?.user_locked,
        clamp_refused: !!req.body?.clamp_refused,
      })
    );
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

programRouter.post("/proposals/:id/discard", (req, res) =>
  res.json(setProposalStatus(Number(req.params.id), "discarded"))
);

// Adaptive program state: per-lift trend + plateau/stall, volume landmarks,
// mesocycle position, endurance trends — the deterministic read the evolve-program
// proposal builds on. Informational (no score, no gate).
programRouter.get("/program-state", (req, res) =>
  res.json(getProgramState(req.query.date ? String(req.query.date) : undefined))
);
// The TRAINING-INTELLIGENCE / performance read — the athletic counterpart to
// /api/health/standing. Benchmarks where the user actually STANDS (each lift's
// capacity vs sex/age strength standards + VO2max norms), the strength imbalances,
// the single biggest lever, lifts worth re-testing, a variety nudge, and a holistic
// balance line. Derived live each call; percentile/level reference reads, no scores.
programRouter.get("/performance", (req, res) =>
  res.json(performanceStanding(req.query.date ? String(req.query.date) : undefined))
);
// The RUNNING brain: this week's deterministic periodized run mix (N easy Z2 + 1
// long + 1 rotated quality, each with a bpm-bearing zone + interval structure) and
// the user's real HR-zone bpm bands. The endurance counterpart to /performance.
// Both degrade to {available:false} for a non-runner / no zones.
programRouter.get("/run-plan", (req, res) =>
  res.json(weeklyRunPlan(req.query.date ? String(req.query.date) : undefined))
);
programRouter.get("/run-zones", (_req, res) => res.json(runZones()));
// Per-canonical-muscle-group advance/stall trajectory + the cadenced strength
// test-week read. Plain words, no scores; quiet to {available:false}/{due:false}.
programRouter.get("/muscle-trajectory", (req, res) =>
  res.json(muscleGroupTrajectory(req.query.date ? String(req.query.date) : undefined))
);
programRouter.get("/test-week", (req, res) =>
  res.json(testWeekDue(req.query.date ? String(req.query.date) : undefined))
);
// The deterministic TRAINING PLAYBOOK — plateau-type plays (strength/endurance/
// mono-stimulus/hybrid-interference) + an adherence-fit restructure read, each with
// plain-language adaptations the evolve-program loop can focus on. Suggestion only:
// never mutates the plan, never a score. Quiet ("no signal strong enough") at steady
// state. ?date= / ?window= optional.
programRouter.get("/program/playbook", (req, res) => {
  const date = req.query.date ? String(req.query.date) : undefined;
  const windowDays = Number(req.query.window) > 0 ? Number(req.query.window) : undefined;
  res.json(trainingPlaybook(date, windowDays !== undefined ? { windowDays } : {}));
});
// DEXA-driven targeting: the body scan's regional read → concrete training +
// nutrition targets, each with a "path to your next scan". {available:false} w/o DEXA.
programRouter.get("/dexa-targeting", (_req, res) => res.json(dexaTargeting()));
// Build a DRAFT plan proposal from this week's deterministic run mix, via the same
// propose→apply path as /program/progression/apply. Maps weeklyRunPlan(date).runs →
// parsed.cardio[] (applyProposal → setWeeklyRuns, keeping strength intact + carrying
// interval structure). Never auto-applied. Returns the designed ok:false at 200.
programRouter.post("/program/run-plan/apply", (req, res) => {
  const date = (req.body ?? {}).date ? String((req.body as any).date) : undefined;
  res.json(buildRunPlanProposal(date));
});
