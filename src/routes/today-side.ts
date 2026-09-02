import { Router } from "express";
import {
  getHealthSynthesisView,
  healthFocus,
  getRecoveryBaselineRead,
} from "../domain/health/index.js";
import { listContextEvents } from "../domain/person/index.js";
import { listGarminDailyMetrics } from "../domain/training/index.js";
import { listMealPlansSummary } from "../domain/nutrition/index.js";
import { localDateISO } from "../repo/shared.js";

export const todaySideRouter = Router();

// ---- Today's side reads, fanned in (PWA convenience only) ----
// Wave 3 of a Today open fires a handful of small, independent, deterministic
// GETs at paint. Over a tailnet the cost is request count x round trip, not
// bytes, so this route answers them in ONE trip. It is a pure wrapper: every key
// is produced by the SAME domain function the individual route calls, and those
// routes (and the MCP surface) stay exactly as they were — a client that knows
// nothing about this endpoint keeps working, and this one is free to degrade.
//
// Degradation is per key, never per response: a reader that throws yields `null`
// for its own key and nothing else, because the client loaders each already
// treat "no data" as "render nothing" and must keep that independence. A
// composite that failed whole would take out five calm panels at once.
//
// NOT here on purpose: `/checkins` and `/context-tags` (the check-in surface owns
// its own reads), and `/today-agenda` (it carries a seen-marking side effect that
// must fire exactly once per open, from the surface that actually renders it).

export type TodaySideReaders = Record<string, () => unknown>;

/**
 * The readers, one per response key, each the individual route's own call.
 *
 * The set is exactly what `today-side-loaders.ts` reads through `sideValue`, and
 * nothing more. A key no client asks for is pure server work and payload on the
 * open that blocks first paint, so `directives`, `insights` and `team_week` are
 * deliberately NOT here — those surfaces fetch their own routes when they render.
 *
 * `mealplans` is one deliberate difference: the side loader only ever prints the first meal
 * name of today's row, so this key reads `listMealPlansSummary()` — the same
 * selection/freshness logic as `listMealPlans()`, projected down to the fields
 * a screen renders (`GET /mealplans?fields=summary` is the same call). The full
 * `GET /mealplans` route and the MCP tool the coach reasons over are unchanged.
 */
export const TODAY_SIDE_READERS: TodaySideReaders = {
  context_events: () => listContextEvents({ activeOnly: true }),
  health_synthesis: () => {
    const view = getHealthSynthesisView();
    return { synthesis: view.synthesis, focus: healthFocus(), stale: view.stale, stale_reason: view.stale_reason };
  },
  garmin_daily: () => listGarminDailyMetrics(1),
  recovery_baseline: () => getRecoveryBaselineRead(),
  mealplans: () => listMealPlansSummary(6),
};

function todaySideDate(value: unknown): string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : localDateISO();
}

export function todaySideRead(dateQuery?: unknown, readers: TodaySideReaders = TODAY_SIDE_READERS) {
  const out: Record<string, unknown> = { date: todaySideDate(dateQuery) };
  for (const [key, read] of Object.entries(readers)) {
    try {
      out[key] = read();
    } catch {
      // One panel's read failing is that panel's silence, not the response's.
      out[key] = null;
    }
  }
  return out;
}

// One trip for the Today screen's small independent side panels (context events,
// health synthesis, Garmin daily, recovery bands, meal plans) instead of one GET
// each. A PWA convenience: every individual route still exists and still owns its
// semantics, each key here is that route's own read, and a key whose read fails
// comes back `null` so one panel's failure never takes the others with it. The key
// set is exactly what the Today side loaders read — directives, insights and the
// team week are NOT fanned in, because nothing on this path renders them.
todaySideRouter.get("/today-side", (req, res) => {
  res.json(todaySideRead(req.query.date));
});
