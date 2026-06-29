import { Router } from "express";
import { enqueueAgentJob } from "../agentJobs.js";
import { agentStatusFor, suggestSession, weekAheadRead } from "../coachOps.js";
import { db } from "../db.js";
import { computeDayRead, localToday } from "../dayread.js";
import * as repo from "../repo.js";
import { backgroundOp } from "./background-op.js";

export const dayCoachRouter = Router();

// Record the day_read suggestion for outcome learning, idempotent per CALENDAR DAY.
// Why this exists: the canonical (no-override) Brief is precomputed nightly and served
// CACHED every morning, so the typical open returns before any fresh compute — without
// this, the cache-hit path never records a suggestion and reconcileOutcomes has almost
// no day_read rows to learn from. We record on the cache hit too, deduping by
// (kind='day_read', date) so repeated opens in the same day don't pile up duplicate
// rows. An OVERRIDE read is transient (a reshaped steer, not the canonical read) and
// must always be recorded — it carries a distinct payload — so it bypasses the dedupe.
// Best-effort throughout: a failed insert/check never blocks the response.
function recordDayReadSuggestion(date: string, read: any, override: string | null | undefined): void {
  try {
    if (!override) {
      // A canonical recording serializes override as `"override":null`; an override
      // read serializes a string value. Match the canonical marker so we dedupe only
      // canonical-against-canonical (an override row for the same date is fine to keep).
      const existing = db
        .prepare(`SELECT 1 FROM suggestions WHERE kind = 'day_read' AND date = ? AND payload_json LIKE '%"override":null%' LIMIT 1`)
        .get(date);
      // A canonical (no-override) row already recorded for this date — don't duplicate.
      if (existing) return;
    }
    repo.recordSuggestion("day_read", date, {
      kind: read?.kind ?? null,
      focus: read?.focus ?? null,
      est_minutes: read?.est_minutes ?? null,
      override: override ?? null,
    });
  } catch {
    /* outcome recording is never allowed to break the read */
  }
}

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
  // canonical read — the un-steer escape hatch, so the athlete is never trapped in
  // an override they changed their mind about (mirrors the cache-invalidation path).
  const reset = req.query.reset === "1" || req.query.reset === "true";
  const readDate = date || localToday();
  // The day-ahead forward line is attached deterministically on EVERY read: it must
  // reflect the CURRENT plan/balance (the day_reads cache columns don't carry it, and
  // a persisted snapshot would go stale as the week fills in). null on a done day —
  // the debrief's `why` already voices what's next. forwardLook is null-safe.
  // Attach the day-ahead forward line AND the goal ARC line (where today sits on the
  // path to the goals) on EVERY read — both reflect the CURRENT plan/goals, never a
  // stale snapshot. forwardLook is null on a done day (the debrief voices what's next);
  // the arc is null when there's no goal/block/race. Both null-safe.
  const withForward = (r: any) => {
    let arc: string | null = null;
    try {
      arc = repo.getTrajectory(readDate)?.line ?? null;
    } catch {
      arc = null;
    }
    return { ...r, forward: r?.kind === "done" ? null : repo.forwardLook(readDate).text || null, arc };
  };
  try {
    if (reset) {
      repo.invalidateDayRead(readDate);
      const r: any = await computeDayRead({ date, agent: agentParam });
      recordDayReadSuggestion(readDate, r, null);
      return res.json(withForward({ ...r, agent_status: agentStatusFor(r) }));
    }
    if (!override) {
      const cached = repo.getCachedDayRead(readDate);
      if (cached) {
        // Outcome learning on the FAST path too: the canonical read is precomputed
        // nightly and served cached every morning, so without recording here the
        // typical open never lands a day_read suggestion for reconcileOutcomes to learn
        // from. Idempotent per (kind, date) so repeated opens don't duplicate the row.
        recordDayReadSuggestion(readDate, cached, null);
        return res.json(withForward({ ...cached, cached: true, agent_status: agentStatusFor(cached) }));
      }
    }
    const read: any = await computeDayRead({ date, override, agent: agentParam });
    // Outcome learning: record what the Brief proposed for this date so a later
    // reconciliation pass can compare it to what the athlete actually did. Deduped
    // per (kind, date) for the canonical read; an override read always records.
    recordDayReadSuggestion(readDate, read, override ?? null);
    return res.json(withForward({ ...read, agent_status: agentStatusFor(read) }));
  } catch (e: any) {
    // Last-resort floor — computeDayRead already swallows agent failures, so this
    // only fires on an unexpected repo error. Still return a real read, never 500.
    const b = repo.dayRead(date);
    const headline = b.kind === "done"
      ? "You're done for today."
      : b.kind === "rest"
        ? "Rest today."
        : b.kind === "easy"
          ? "Take it easy."
          : b.focus
            ? `${b.focus}.`
            : "Good to train.";
    return res.json(withForward({ ...b, headline, source: "deterministic", error: e.message }));
  }
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
  if (repo.getSettings().bg_ops_enabled) {
    const job = repo.createAgentJob({
      kind: "day_read_override",
      input: { date, override, agent: agentParam ?? null },
      agent: agentParam ?? null,
    });
    enqueueAgentJob((job as any).id);
    return res.json({ ok: true, job });
  }
  // Legacy inline path (bg_ops off) — same body the GET override branch returns.
  try {
    const read: any = await computeDayRead({ date, override, agent: agentParam });
    recordDayReadSuggestion(date || localToday(), read, override ?? null);
    return res.json({ ...read, agent_status: agentStatusFor(read) });
  } catch (e: any) {
    const f = repo.dayRead(date);
    const headline = f.kind === "rest"
      ? "Rest today."
      : f.kind === "easy"
        ? "Take it easy."
        : f.focus
          ? `${f.focus}.`
          : "Good to train.";
    return res.json({ ...f, headline, source: "deterministic", error: e.message });
  }
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
