import { Router } from "express";
import { enqueueAgentJob, ensureWeekAheadJob } from "../agentJobs.js";
import { composeDailySession, suggestSession, weekAheadServe, whatIfDo } from "../coachOps.js";
import { ensureDayReadRefresh } from "../dayread-refresh.js";
import { readToday, tradeRestDay } from "../domain/brain/index.js";
import { createAgentJob } from "../domain/person/index.js";
import {
  dailySessionErrorBody,
  isDailySessionAbsence,
  isDailySessionConflict,
  prepareDailySessionUseCase,
  previewAdaptiveDailySessionUseCase,
} from "../domain/training/index.js";
import {
  dailyOutcomeRead,
  decideDailySession,
  getActiveDailySession,
  recordDailySessionDecision,
  sessionPrimer,
} from "../repo.js";
import { localDateISO } from "../repo/shared.js";
import { backgroundOp } from "./background-op.js";
import { memoizedRead } from "./response-memo.js";

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
//
// The canonical read (no override, no reset) is also memoized on the response
// freshness key (routes/response-memo.ts): a repeat open whose inputs have not moved
// — no log, no sync, no agent run landing — answers the same body, or a 304, without
// re-running the reconciliation. A steer or a reset always computes.
dayCoachRouter.get("/today-read",
  memoizedRead(
    "today-read",
    (req) => {
      const date = req.query.date ? String(req.query.date) : undefined;
      const override = req.query.override ? String(req.query.override) : undefined;
      const agentParam = req.query.agent ? String(req.query.agent) : undefined;
      // ?reset=1 clears a persisted steer ("back to today's read") and recomputes the
      // canonical read — the un-steer escape hatch, so the user is never trapped in
      // an override they changed their mind about (mirrors the cache-invalidation path).
      const reset = req.query.reset === "1" || req.query.reset === "true";
      return readToday({ date, override, agent: agentParam, reset, recordOutcome: true });
    },
    {
      cacheable: (req) => !req.query.override && !req.query.reset,
      // A remembered floor read still arms its self-heal on every open, exactly as
      // the cached-row path of readToday does (ensureDayReadRefresh dedupes).
      onHit: (req, read) => {
        const row = read as { source?: unknown; curated?: unknown; date?: unknown; prose_identity?: unknown } | null;
        if (row?.source !== "deterministic" || row.curated) return;
        const date = typeof row.date === "string" ? row.date : req.query.date ? String(req.query.date) : undefined;
        ensureDayReadRefresh(date, typeof row.prose_identity === "string" ? row.prose_identity : null);
      },
    }
  )
);

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

// The rest trade — "train today, rest tomorrow", written onto the calendar.
// Deterministic, synchronous, agent-free: it claims TOMORROW with one context event
// and hands back today's re-derived read plus train_anyway, so the Brief can reveal
// the plan on the same tap. Only offered on a quiet day that is about rhythm (the
// ceiling-easy read, any easy read, the week's own rest day); a rest grounded in the
// athlete — a rest-grade reading, a symptom, anything clinical — refuses as
// `{ok:false, error}` at HTTP 200, the designed failure signal the agentic endpoints
// here already use. Idempotent per date, never more than one open trade, and the
// plan's ring is untouched — the calendar carries the trade.
dayCoachRouter.post("/today-read/trade-rest", (req, res) => {
  const b = req.body ?? {};
  try {
    res.json(tradeRestDay({ date: b.date != null ? String(b.date) : undefined }));
  } catch (error: any) {
    res.json({ ok: false, error: error?.message ?? String(error) });
  }
});

// Build ONE session for today on demand ("ask it for a session right now"). A
// SUGGESTION the user can act on or ignore — NOT saved/applied as the plan. Like
// the meal-swap endpoint, ok:false at status 200 is the designed failure signal
// (the PWA api() helper reads the body regardless of status). Optional
// train_anyway records that the ask itself was the intent to train, which is what
// lets the suggestion keep its movements when it is accepted on a rest day
// (acceptance revalidates against the live envelope and would otherwise clamp
// every item away); the PWA sends it, agents must opt in explicitly.
dayCoachRouter.post("/session-suggest", async (req, res, next) => {
  const b = req.body ?? {};
  const input = {
    agent: b.agent ?? null,
    minutes: b.minutes != null ? Number(b.minutes) : undefined,
    equipment: b.equipment != null ? String(b.equipment) : undefined,
    focus: b.focus != null ? String(b.focus) : undefined,
    constraints: b.constraints != null ? String(b.constraints) : undefined,
    // Asking for a session on a rest day IS the intent to train, and this is the
    // moment it is given — so it is recorded on the job, where acceptance reads it
    // back (agentDecisionOpts). Without it the athlete gets a card full of
    // movements and then an empty day: /session-suggest composes freely, but
    // prepare_daily_session revalidates against the live envelope and a rest
    // envelope rejects every item as `rest_requires_train_anyway`. Recording it
    // here rather than at acceptance is what keeps a STALE suggestion — drafted
    // before recovery turned — still correctly clamped when it is finally used.
    train_anyway: b.train_anyway === true ? true : undefined,
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
  } catch (e) {
    // One error path: the shared handler logs it privately and answers the fixed
    // {ok:false,error:'internal error'} envelope instead of leaking e.message.
    next(e);
  }
});

// Stage 3 — bounded agent composition. Compose ONE session strictly inside the
// deterministic Stage 2 envelope: the agent proposes, the server verifies every
// item against the envelope's exclusions/caps and safe novel-exercise rules, and
// an absent/malformed/over-excluded output degrades to a deterministic session.
// Preview-only (never applied); accept it later via /daily-session/prepare with
// source agent_suggest + this job's id. Always returns a usable session.
dayCoachRouter.post("/session-compose", async (req, res, next) => {
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
  } catch (e) {
    // One error path: the shared handler logs it privately and answers the fixed
    // {ok:false,error:'internal error'} envelope instead of leaking e.message.
    next(e);
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

// Read-only, authoritative candidate shown immediately before Start. This is
// built by the same adaptive seam prepare persists and never records a decision
// or creates a workout session.
//
// A date with no weekly template day has nothing to preview — the ordinary case on a
// rest/unplanned day, and the PWA asks on EVERY Today render. That absence answers
// `200 + null` like every other single-row read here; 400 is reserved for malformed
// input (a bad date or constraint).
// Memoized on the response freshness key; a malformed request (400) is never remembered.
dayCoachRouter.get("/daily-session/preview",
  memoizedRead("daily-session-preview", (req) => {
    try {
      return previewAdaptiveDailySessionUseCase(previewRequestFor(req));
    } catch (error: any) {
      if (isDailySessionAbsence(error)) return null;
      throw new PreviewRequestError(error);
    }
  })
);

class PreviewRequestError extends Error {
  readonly original: unknown;
  constructor(original: unknown) {
    super("daily-session preview failed");
    this.original = original;
  }
}

function previewRequestFor(req: { query: Record<string, unknown> }) {
  const override = req.query.override != null ? String(req.query.override) : null;
  return {
    date: req.query.date != null ? String(req.query.date) : undefined,
    constraints: override ? { day_read_override: override } : {},
    train_anyway: req.query.train_anyway === "1" || req.query.train_anyway === "true",
  };
}

// A preview that failed for any reason other than absence keeps its old 400 body.
dayCoachRouter.use("/daily-session/preview", (error: unknown, _req: any, res: any, next: any) => {
  if (error instanceof PreviewRequestError) return res.status(400).json(dailySessionErrorBody(error.original as any));
  next(error);
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
        expected_input_fingerprint: body.expected_input_fingerprint,
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
    // A stale preview, a moved/absent active composition and a session already logged
    // against are all the same answer — "your copy is stale, re-read and retry" — so
    // they share one CONFLICT status instead of some of them reading as malformed
    // input. 400 stays for a genuinely bad request body.
    res.status(isDailySessionConflict(error) ? 409 : 400).json(dailySessionErrorBody(error));
  }
});

// Stage 4 — the post-session outcome reconciliation for a date: what was
// suggested vs what was actually trained (completed / substituted / skipped /
// reordered), progression evidence, feedback, and the adherence-neutral reason
// codes + confounders. Deterministic, agent-free. null (200) when the date has
// no reconciled daily-session composition.
dayCoachRouter.get("/daily-session/outcome", (req, res) => {
  try {
    const rawSessionId = req.query.session_id;
    const sessionId = rawSessionId == null ? null : Number(rawSessionId);
    if (rawSessionId != null && (!Number.isInteger(sessionId) || Number(sessionId) <= 0)) {
      throw new Error("session_id must be a positive integer");
    }
    res.json(
      dailyOutcomeRead({
        session_id: sessionId,
        date: req.query.date != null ? String(req.query.date) : undefined,
      })
    );
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

// GET /week-ahead's body plus its refresh kick, shared with the /today fan-in.
// `onRefresh` hears the cache key a kick was armed for, so a memoized fan-in can
// re-kick it on a later hit (a failed job must not wait for the key to move).
export function weekAheadResponse(agentParam?: string, onRefresh?: (cacheKey: string) => void) {
  const served = weekAheadServeSafe();
  if (served.needsRefresh) {
    ensureWeekAheadJob(agentParam, served.cacheKey);
    onRefresh?.(served.cacheKey);
  }
  return served.response;
}

function weekAheadServeSafe(): { response: unknown; needsRefresh: boolean; cacheKey: string } {
  try {
    return weekAheadServe();
  } catch (e: any) {
    return { response: { ok: false, error: e.message }, needsRefresh: false, cacheKey: "" };
  }
}

// The week ahead — a calm forward look (lift / run / mixed / rest across the next
// several days). Agentic with a deterministic plan-rotation floor, so it always
// returns a usable shape even with no agent. Cached per day+plan+goal.
//
// This GET never spawns a CLI inline: weekAheadServe reads the cache
// synchronously (fresh cache / stale cache / the deterministic floor) and, on a
// miss or a stale hit, ensureWeekAheadJob kicks (or joins) a durable background
// job that runs the real agentic read and refreshes the cache for next time —
// deduplicated so a burst of opens never spawns more than one CLI per day.
//
// Memoized on the response freshness key: the served body is remembered, and the
// refresh kick still runs on EVERY serve that needs one (ensureWeekAheadJob dedupes),
// so a remembered "computing" floor never strands the agentic read.
dayCoachRouter.get("/week-ahead",
  memoizedRead("week-ahead", () => weekAheadServeSafe(), {
    body: (served) => served.response,
    onServe: (req, served) => {
      if (!served.needsRefresh) return;
      try {
        ensureWeekAheadJob(req.query.agent != null ? String(req.query.agent) : undefined, served.cacheKey);
      } catch {
        /* the next open kicks it again */
      }
    },
  })
);

// ---- the what-if (Ask) ----
// The athlete asks a hypothetical in words ("what if I lifted three days instead of
// four?"); the team answers with ONE proposed change and its ripple across the six
// stones. It is agentic, so it always queues a durable job (a user-facing request
// never waits on a coaching CLI): the body is {ok:true, job}, and the job's result is
// {ok, date, question, change, ripple[], source, agent, tried} — or the designed
// {ok:false, error, tried}. The read NEVER changes anything and always reads today.
// Optional `hint` {area, direction} is a structured nudge; the words still decide.
dayCoachRouter.post("/what-if", (req, res) => {
  const b = req.body ?? {};
  const text = typeof b.text === "string" ? b.text.trim() : "";
  if (!text) return res.status(400).json({ ok: false, error: "text required", tried: [] });
  const input = { text, hint: b.hint && typeof b.hint === "object" ? b.hint : null };
  backgroundOp(res, "what_if", input, b.agent);
});

// "Do it": hand the what-if's change to the team as a DRAFT. The body is {job_id} — the
// server reads the question and the change from that job's own stored answer (never a
// client echo, so the clinical mark cannot be dropped), writes a plan proposal and routes it through
// the ONE autonomy policy — anything clinical is held clinician-directed, a calorie
// target always waits on the athlete, and a goal is never drafted (it is theirs to
// name, in chat). Never applies on its own authority. {ok:false, error, tried:[]} at
// 200 when there is nothing concrete to hand over.
dayCoachRouter.post("/what-if/do", (req, res, next) => {
  try {
    const b = req.body ?? {};
    res.json(whatIfDo({ job_id: b.job_id }));
  } catch (e) {
    next(e);
  }
});
