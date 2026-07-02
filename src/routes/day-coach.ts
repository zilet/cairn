import { Router } from "express";
import { enqueueAgentJob } from "../agentJobs.js";
import { suggestSession, weekAheadRead } from "../coachOps.js";
import { readToday } from "../domain/brain/index.js";
import { createAgentJob, getSettings } from "../domain/person/index.js";
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
// When bg_ops is OFF this computes inline and returns the legacy read body.
dayCoachRouter.post("/today-read/reshape", async (req, res) => {
  const b = req.body ?? {};
  const date = b.date != null ? String(b.date) : undefined;
  const override = b.override != null ? String(b.override) : undefined;
  const agentParam = b.agent != null ? String(b.agent) : undefined;
  if (getSettings().bg_ops_enabled) {
    const job = createAgentJob({
      kind: "day_read_override",
      input: { date, override, agent: agentParam ?? null },
      agent: agentParam ?? null,
    });
    enqueueAgentJob((job as any).id);
    return res.json({ ok: true, job });
  }
  // Legacy inline path (bg_ops off) — same body the GET override branch returns.
  return res.json(await readToday({ date, override, agent: agentParam, recordOutcome: true }));
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
    date: b.date != null ? String(b.date) : undefined,
  };
  if (backgroundOp(res, "session_suggest", input, b.agent)) return;
  try {
    res.json(await suggestSession(b.agent, {
      minutes: input.minutes,
      equipment: input.equipment,
      focus: input.focus,
      constraints: input.constraints,
      date: input.date,
    }));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
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
