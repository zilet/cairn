import { Router } from "express";
import { draftCoachProposal, evolveProgram } from "../coachOps.js";
import { localToday } from "../dayread.js";
import {
  applyProposalWithAutonomy,
  buildProgressionWithAutonomy,
  buildRunPlanWithAutonomy,
  getCachedDayRead,
} from "../domain/brain/index.js";
import { dexaTargeting } from "../domain/health/index.js";
import {
  advanceBlockWeek,
  applyProposal,
  applySwapSmart,
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
  supportWorkRead,
  testWeekDue,
  trainingPlaybook,
  updateBlock,
  weeklyRunPlan,
} from "../domain/training/index.js";
import { calibrationStatus, dueCalibrations } from "../repo/calibration.js";
import { backgroundOp } from "./background-op.js";
import { flexibleTrainingAgenda } from "../repo.js";

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

// Adaptive program evolution: read the program-state, draft a plan EVOLUTION
// (progress / deload / rotate-a-variation / periodize), then route it through the
// autonomy layer. Under lead_mode='lead' a bounded, reversible evolution quiet-applies
// at its natural boundary and a structural restructure announces first (one-tap Undo,
// surprise budget honored); under 'review_everything' it parks as a DRAFT proposal for
// review — same propose→apply path as /agent/run. The `autonomy` field says which.
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
    const strengthDays = days.filter(
      (d: any) => Array.isArray(d.items) && d.items.some((it: any) => it.kind !== "cardio" && it.exercise)
    );
    if (strengthDays.length) {
      const matched = focus
        ? strengthDays.find((d: any) => {
            const f = String(d.focus || d.name || "")
              .toLowerCase()
              .trim();
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

// Support-work read: for each lagging COMPOUND lift (plateaued/regressing) whose
// CONTRIBUTING muscles run under their productive volume, one targeted supporting-
// work suggestion (build the weak synergist — e.g. direct triceps for a stalled
// bench — instead of only rotating the movement; if the lift's own prime mover is
// under-trained it says the lift may simply be under-practiced). Plain words,
// suggestion-not-a-gate, no scores; [] when nothing lags. ?date= optional.
programRouter.get("/support-work", (req, res) =>
  res.json(supportWorkRead(req.query.date ? String(req.query.date) : undefined))
);

// Build a DRAFT plan proposal from the current day's per-lift prescriptions, then
// route it through the autonomy layer (buildProgressionWithAutonomy, shared with MCP
// so the two never drift). Under lead_mode='lead' a bounded target nudge quiet-applies
// at its natural boundary with a decision + one-tap Undo; under 'review_everything' the
// draft stays a plain reviewable draft (autonomy tier 'ask'). A "hold" (incl. an
// autoregulation-braked hold) is still dropped; a "vary" becomes a real {swap:{from,to}}
// change. Returns { ok:true, proposal, autonomy } or { ok:false, error } at 200 (the
// designed-failure signal — nothing wrong at the HTTP level, just nothing to do).
programRouter.post("/program/progression/apply", (req, res) => {
  res.json(buildProgressionWithAutonomy(Number((req.body ?? {}).day)));
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
  // applySwapSmart owns the whole rotate-in intent: an explicit day is used
  // verbatim; otherwise the slot resolves through the tiered ladder (exact →
  // key → movement family — the plan's implement spelling never blocks the
  // athlete's logged one), and when `from` isn't represented at all, the
  // variation is ADDED to the day already training that muscle group. The
  // response `message` says what actually happened.
  res.json(applySwapSmart(from, to, Number.isFinite(Number(day)) ? Number(day) : null));
});

programRouter.get("/proposals", (req, res) => res.json(listProposals(req.query.limit ? Number(req.query.limit) : 20)));

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
// Rolling weekly run intentions: actual compatible logs close intentions and
// suggested openings move around real strength/endurance load. Any completed
// run occupies its actual date; moderate/hard cross-training also reserves its
// date, while light cross-training may still share a clean easy-run opening.
// Read-only; unfinished work creates no catch-up debt.
programRouter.get("/training-agenda", (req, res) =>
  res.json(flexibleTrainingAgenda(req.query.date ? String(req.query.date) : undefined))
);
programRouter.get("/run-zones", (_req, res) => res.json(runZones()));
// CALIBRATION — how well-anchored the numbers steering training actually are, plus
// any test worth suggesting right now. Freshness words and prose only: no counts,
// no scores, and nothing here gates a session. Quiet by construction — an athlete
// with nothing calibrated reads {status:{items:[]}, due:[]}.
programRouter.get("/calibration/status", (req, res) => {
  const date = req.query.date ? String(req.query.date) : undefined;
  // One status pass feeds both halves of the response — dueCalibrations derives the
  // same items, and each derive walks every main lift's verification history.
  const status = calibrationStatus(date);
  res.json({ status, due: dueCalibrations(date, { status }) });
});
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
// Build this week's deterministic run mix and route it through the same autonomy
// policy as strength progression. Lead mode lands the bounded update at its natural
// boundary with Undo; review posture keeps a draft. Strength work stays intact.
programRouter.post("/program/run-plan/apply", (req, res) => {
  const date = (req.body ?? {}).date ? String((req.body as any).date) : undefined;
  res.json(buildRunPlanWithAutonomy(date));
});
