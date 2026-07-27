import { Router } from "express";
import { enqueueAgentJob } from "../agentJobs.js";
import { composeDailySession, suggestSession, weekAheadRead } from "../coachOps.js";
import { readToday } from "../domain/brain/index.js";
import { createAgentJob } from "../domain/person/index.js";
import { dailySessionErrorBody, prepareDailySessionUseCase } from "../domain/training/index.js";
import {
  decideDailySession,
  getActiveDailySession,
  getDailySessionOutcome,
  recordDailySessionDecision,
  sessionPrimer,
} from "../repo.js";
import { localDateISO } from "../repo/shared.js";
import { backgroundOp } from "./background-op.js";

export const dayCoachRouter = Router();

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
dayCoachRouter.get("/today-read", async (req, res) => {
  const date = req.query.date ? String(req.query.date) : undefined;
  const override = req.query.override ? String(req.query.override) : undefined;
  const agentParam = req.query.agent ? String(req.query.agent) : undefined;
  // ?reset=1 clears a persisted steer ("back to today's read") and recomputes the
  // canonical read — the un-steer escape hatch, so the user is never trapped in
  // an override they changed their mind about (mirrors the cache-invalidation path).
  const reset = req.query.reset === "1" || req.query.reset === "true";
  return res.json(await readToday({ date, override, agent: agentParam, reset, recordOutcome: true }));
});

// Background the Brief OVERRIDE reshape ("rough night" / "short on time" / "train
// anyway") as a durable job, so a steer survives a tab switch / reload / restart
// like the other 7 ops. The canonical GET /api/today-read (and ?reset=1) stays
// synchronous (cached + deterministic floor); this POST is ONLY for the agentic
// override reshape. The job's `done` result is byte-for-byte what
// GET /api/today-read?override= returns, so the PWA reuses its Brief render.
// This always queues: a user-facing request never waits on a coaching CLI.
dayCoachRouter.post("/today-read/reshape", async (req, res) => {
  const b = req.body ?? {};
  const date = b.date != null ? String(b.date) : undefined;
  const override = b.override != null ? String(b.override) : undefined;
  const agentParam = b.agent != null ? String(b.agent) : undefined;
  const job = createAgentJob({
    kind: "day_read_override",
    input: { date, override, agent: agentParam ?? null },
    agent: agentParam ?? null,
  });
  enqueueAgentJob((job as any).id);
  return res.json({ ok: true, job });
});

// Build ONE session for today on demand ("ask it for a session right now"). A
// SUGGESTION the user can act on or ignore — NOT saved/applied as the plan. Like
// the meal-swap endpoint, ok:false at status 200 is the designed failure signal
// (the PWA api() helper reads the body regardless of status).
dayCoachRouter.post("/session-suggest", async (req, res) => {
  const b = req.body ?? {};
  const input = {
    agent: b.agent ?? null,
    minutes: b.minutes != null ? Number(b.minutes) : undefined,
    equipment: b.equipment != null ? String(b.equipment) : undefined,
    focus: b.focus != null ? String(b.focus) : undefined,
    constraints: b.constraints != null ? String(b.constraints) : undefined,
    // Persist the resolved local date with the job. Preparing an agent suggestion
    // later must be able to prove that its canonical job belongs to this day.
    date: b.date != null ? String(b.date) : localDateISO(),
  };
  if (backgroundOp(res, "session_suggest", input, b.agent)) return;
  try {
    res.json(
      await suggestSession(b.agent, {
        minutes: input.minutes,
        equipment: input.equipment,
        focus: input.focus,
        constraints: input.constraints,
        date: input.date,
      })
    );
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Stage 3 — bounded agent composition. Compose ONE session strictly inside the
// deterministic Stage 2 envelope: the agent proposes, the server verifies every
// item against the envelope's exclusions/caps and safe novel-exercise rules, and
// an absent/malformed/over-excluded output degrades to a deterministic session.
// Preview-only (never applied); accept it later via /daily-session/prepare with
// source agent_suggest + this job's id. Always returns a usable session.
dayCoachRouter.post("/session-compose", async (req, res) => {
  const b = req.body ?? {};
  const input = {
    agent: b.agent ?? null,
    minutes: b.minutes != null ? Number(b.minutes) : undefined,
    equipment: b.equipment != null ? String(b.equipment) : undefined,
    override: b.override != null ? String(b.override) : undefined,
    train_anyway: b.train_anyway === true,
    date: b.date != null ? String(b.date) : localDateISO(),
  };
  if (backgroundOp(res, "session_compose", input, b.agent)) return;
  try {
    res.json(
      await composeDailySession(b.agent, {
        minutes: input.minutes,
        equipment: input.equipment,
        override: input.override,
        train_anyway: input.train_anyway,
        date: input.date,
      })
    );
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Read the durable composition the athlete accepted for a day. Agent suggestions
// remain preview-only until the explicit prepare call below writes this snapshot.
dayCoachRouter.get("/daily-session", (req, res) => {
  try {
    res.json(getActiveDailySession(req.query.date != null ? String(req.query.date) : undefined));
  } catch (error: any) {
    res.status(400).json({ ok: false, error: error?.message ?? String(error) });
  }
});

// The deterministic decision envelope (Stage 2) — an explainable, reproducible
// read of what KIND of day today is, the movement/muscle envelope, caps, and the
// reason codes behind them, BEFORE any agent composes. Synchronous + agent-free.
// The same bounded snapshot yields the same envelope + input_fingerprint. Recorded
// best-effort for observability; a record failure never fails the read.
dayCoachRouter.get("/daily-session/decision", (req, res) => {
  try {
    const { envelope } = decideDailySession(req.query.date != null ? String(req.query.date) : undefined, {
      override: req.query.override != null ? String(req.query.override) : null,
      train_anyway: req.query.train_anyway === "1" || req.query.train_anyway === "true",
      equipment: req.query.equipment != null ? String(req.query.equipment) : null,
      minutes: req.query.minutes != null ? Number(req.query.minutes) : null,
    });
    try {
      recordDailySessionDecision(envelope);
    } catch {
      /* observability write never blocks the read */
    }
    res.json(envelope);
  } catch (error: any) {
    res.status(400).json({ ok: false, error: error?.message ?? String(error) });
  }
});

// Prepare (or explicitly replace) today's durable session without mutating the
// weekly plan. Plan sources snapshot a plan day; agent_suggest resolves a
// completed canonical job; athlete_override snapshots a user-authored payload.
// expected_active_id is assertion-only: it returns the matching active snapshot
// and bound session without creating/replacing anything. Different replacements
// stop once logging begins; exact retries remain safe.
dayCoachRouter.post("/daily-session/prepare", (req, res) => {
  const body = req.body ?? {};
  try {
    res.json(
      prepareDailySessionUseCase({
        date: body.date,
        expected_active_id: body.expected_active_id,
        day_number: body.day_number,
        source: body.source,
        agent_job_id: body.agent_job_id,
        session: body.session,
        constraints: body.constraints,
        provenance: body.provenance,
        train_anyway: body.train_anyway === true,
        replace: body.replace === true,
      })
    );
  } catch (error: any) {
    res.status(400).json(dailySessionErrorBody(error));
  }
});

// Stage 4 — the post-session outcome reconciliation for a date: what was
// suggested vs what was actually trained (completed / substituted / skipped /
// reordered), progression evidence, feedback, and the adherence-neutral reason
// codes + confounders. Deterministic, agent-free. null (200) when the date has
// no reconciled daily-session composition.
dayCoachRouter.get("/daily-session/outcome", (req, res) => {
  try {
    res.json(getDailySessionOutcome(req.query.date != null ? String(req.query.date) : undefined));
  } catch (error: any) {
    res.status(400).json({ ok: false, error: error?.message ?? String(error) });
  }
});

// The pre-session primer — a calm, DETERMINISTIC "a coach was already here" read
// the /app/session surface shows on open: why today's session is what it is (reused
// from the Brief), what changed since last time, what to watch, and what's fresh.
// Synchronous + agent-free (never blocks on a CLI). Returns the primer, or `null`
// (200) when there's nothing worth saying beyond the Brief — the PWA api() helper
// reads the body regardless of status, so null reads as a clean "no primer".
dayCoachRouter.get("/session-primer", (req, res) => {
  const date = req.query.date ? String(req.query.date) : undefined;
  const dayRaw = req.query.day != null ? Number(req.query.day) : undefined;
  const dayNumber = dayRaw != null && Number.isFinite(dayRaw) ? dayRaw : null;
  try {
    res.json(sessionPrimer(date, { dayNumber }));
  } catch (e: any) {
    res.json({ ok: false, error: e?.message });
  }
});

// The week ahead — a calm forward look (lift / run / mixed / rest across the next
// several days). Agentic with a deterministic plan-rotation floor, so it always
// returns a usable shape even with no agent. Cached per day+plan+goal.
dayCoachRouter.get("/week-ahead", async (req, res) => {
  try {
    res.json(await weekAheadRead(req.query.agent != null ? String(req.query.agent) : undefined));
  } catch (e: any) {
    res.json({ ok: false, error: e.message });
  }
});
