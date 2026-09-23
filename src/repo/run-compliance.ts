// RUN COMPLIANCE, told against the run engine's own week.
//
// Runs are never plan items (migration 110): the prescription for a week IS the live
// weeklyRunPlan for that week, laid on the athlete's stated run days. getRunCompliance
// (sessions.ts) owns the ACTUALS — logged runs are fact — and this module composes the
// prescription on top, so every surface that quotes "X of Y km" reads one number.
//
// The recursion is broken here, as it always was: weeklyRunPlan reads getRunCompliance
// for last week's actuals, so the prescription is shaped for the week's MONDAY off the
// volume already in the bank when it opened (last week's actuals + the seven days
// ending the Sunday before) — handing it a compliance read in means it never re-enters
// this module. A re-entrant call (a read somewhere inside the engine that asks for
// compliance again) gets the actuals with no prescription rather than a loop.
import { weeklyRunPlan } from "./run-progression.js";
import { getRunCompliance, runComplianceInWords, runComplianceWeekStart, type RunCompliance } from "./sessions.js";
import { dayEpoch, isoDay, mondayOf } from "../lib/dates.js";

let composing = false;

export function runComplianceRead(dateISO?: string): RunCompliance {
  const weekStart = runComplianceWeekStart(dateISO ? weekStartOf(dateISO) : undefined);
  const actuals = getRunCompliance(weekStart);
  if (composing) return actuals;
  composing = true;
  let live: ReturnType<typeof weeklyRunPlan> | null = null;
  try {
    // The prescription this week is judged against must not move as the week is run:
    // anchored at the week boundary, never at today with today's compliance.
    live = weeklyRunPlan(weekStart, {
      compliance: getRunCompliance(shiftDays(weekStart, -7)),
      volumeAnchorDate: shiftDays(weekStart, -1),
    });
  } catch {
    live = null;
  } finally {
    composing = false;
  }
  const runs = live && live.available !== false && Array.isArray(live.runs) ? live.runs : [];
  if (!runs.length) return actuals;

  let prescribed_km = 0;
  let prescribed_min = 0;
  for (const run of runs as any[]) {
    const km = Number(run.target_distance_km);
    const min = Number(run.target_duration_min);
    if (Number.isFinite(km) && km > 0) prescribed_km += km;
    if (Number.isFinite(min) && min > 0) prescribed_min += min;
  }
  prescribed_km = Math.round(prescribed_km * 10) / 10;
  prescribed_min = Math.round(prescribed_min);
  const prescribed_sessions = runs.length;

  return {
    ...actuals,
    prescribed_sessions,
    prescribed_km,
    prescribed_min,
    pct_km: prescribed_km > 0 ? Math.round((actuals.actual_km / prescribed_km) * 100) / 100 : null,
    in_words: runComplianceInWords({
      prescribed_sessions,
      prescribed_km,
      actual_sessions: actuals.actual_sessions,
      actual_km: actuals.actual_km,
    }),
    basis: "live_plan",
  };
}

// A day offset from a known-good ISO date (never null — the caller already has a
// parsed week start, so the input cannot be malformed).
function shiftDays(dateISO: string, days: number): string {
  return new Date(Date.parse(`${dateISO}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
}

// Monday of the week a given date falls in (the anchor every weekly read shares),
// falling back to the CURRENT week when the date is unusable — this read's own
// contract, on top of the canonical `mondayOf`, which throws there instead.
function weekStartOf(dateISO: string): string {
  const day = isoDay(dateISO);
  return dayEpoch(day) == null ? runComplianceWeekStart() : mondayOf(day);
}
