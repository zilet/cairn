// RUN COMPLIANCE, told against a prescription that is actually about this week.
//
// getRunCompliance sums the APPLIED plan's cardio rows. Nothing rebuilt those
// rows on a cadence, so they fossilized: the Endurance screen printed "9.1 of
// 7.3 km this week" from a run plan applied weeks earlier, while the live weekly
// mix had long since moved on. Two surfaces, two prescriptions, one screen.
//
// This composer keeps the applied plan as the default source of truth — it is
// what the athlete sees on Plan, and a hand-authored endurance week must never be
// silently overruled — and falls back to the LIVE weeklyRunPlan only when the
// applied rows cannot honestly speak for this week (they prescribe no runs at
// all, or the machine-built plan that wrote them landed before this Monday).
// `basis` says which happened; the numbers and in_words format are unchanged.
//
// It lives in the domain layer rather than inside sessions.ts on purpose:
// run-progression.ts already imports getRunCompliance, and weeklyRunPlan calls it
// back for last week's actuals. Composing here keeps that one-way and breaks the
// recursion by handing the applied read straight into weeklyRunPlan's opts.
import { weeklyRunPlan } from "../../repo/run-progression.js";
import {
  appliedRunPlanNeedsRefresh,
  getRunCompliance,
  runComplianceInWords,
  runComplianceWeekStart,
  type RunCompliance,
} from "../../repo/sessions.js";

export function runComplianceRead(dateISO?: string): RunCompliance {
  const weekStart = runComplianceWeekStart(dateISO ? mondayOf(dateISO) : undefined);
  const applied = getRunCompliance(weekStart);
  if (!appliedRunPlanNeedsRefresh(weekStart)) return applied;

  // The prescription this week is judged against must not move as the week is run.
  // weeklyRunPlan anchors its volume on max(compliance.actual_km, trailing-7-day
  // km) read at the date it is given, and BOTH of those include this week's runs so
  // far — so handing it today's date and today's compliance made the target grow
  // with every logged kilometre, pct_km plateaued near 1/factor and the number
  // visibly moved day to day. Anchor the whole read at the week boundary instead:
  // shape the week for its Monday, off the volume that was already in the bank when
  // it opened (last week's compliance + the seven days ending the Sunday before).
  // Handing a compliance read in also keeps weeklyRunPlan from re-entering
  // getRunCompliance, which is why this composer lives above the repo layer at all.
  let live: ReturnType<typeof weeklyRunPlan> | null = null;
  try {
    live = weeklyRunPlan(weekStart, {
      compliance: getRunCompliance(shiftDays(weekStart, -7)),
      volumeAnchorDate: shiftDays(weekStart, -1),
    });
  } catch {
    live = null;
  }
  const runs = live && live.available !== false && Array.isArray(live.runs) ? live.runs : [];
  if (!runs.length) return applied;

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
    ...applied,
    prescribed_sessions,
    prescribed_km,
    prescribed_min,
    pct_km: prescribed_km > 0 ? Math.round((applied.actual_km / prescribed_km) * 100) / 100 : null,
    in_words: runComplianceInWords({
      prescribed_sessions,
      prescribed_km,
      actual_sessions: applied.actual_sessions,
      actual_km: applied.actual_km,
    }),
    basis: "live_plan",
  };
}

// A day offset from a known-good ISO date (never null — the caller already has a
// parsed week start, so the input cannot be malformed).
function shiftDays(dateISO: string, days: number): string {
  return new Date(Date.parse(`${dateISO}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
}

// Monday of the week a given date falls in (the anchor every weekly read shares).
function mondayOf(dateISO: string): string {
  const parsed = Date.parse(`${String(dateISO).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return runComplianceWeekStart();
  const d = new Date(parsed);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
