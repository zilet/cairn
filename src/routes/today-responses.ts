// The Today and Horizon-race fan-ins: the bodies other GET routes answer, computed
// in ONE request and keyed by the exact path the PWA would have asked for them.
//
// A Today open used to fire ~25 GETs across several serial waves (the plan-day
// pick, the run line, the side panels, the directives, the Changes
// line, and the rail cards the agenda names). Over a phone link the cost is request
// count x round trip, so `/today?surface=today` carries all of them in `responses`
// and the client primes its request layer (api-core apiPrime) from it — every
// loader keeps asking for its own path and simply gets its answer without a trip.
//
// The contract that keeps this honest:
//   • each entry is produced by the SAME function the individual route calls, with
//     the same arguments, so the body is byte-identical to that route's answer;
//   • the individual routes all still exist and answer identically — a client that
//     knows nothing about `responses` keeps working, and this is free to degrade;
//   • degradation is per entry: a reader that throws simply leaves its path out,
//     and that one loader falls back to its own request;
//   • side-effecting reads are included only when the surface that renders them is
//     actually on this open — the agenda names the card — exactly as the client
//     loaders decide, so a backlog drain or a week-ahead job never fires for a card
//     nobody drew.
import { brainChangesRead, listVisibleInsights, teamWeekRead } from "../domain/brain/index.js";
import { getProfile, listContextTags } from "../domain/person/index.js";
import {
  calendarDayRead,
  getEnduranceGoal,
  listTrainingSymptoms,
  listUnreconciledGarminStrength,
  planDayProgression,
  planDayRecoveryCandidates,
  planUpcomingNote,
  planWeek,
  programAdjustments,
  raceBuild,
  recentTraining,
  runComplianceRead,
  selectedPlanDayForDate,
  todayStrengthLine,
  weekWins,
  weeklyRunPlan,
} from "../domain/training/index.js";
import { overnightDigest, todayDateParam } from "../domain/today/index.js";
import { flexibleTrainingAgenda, sessionPrimer } from "../repo.js";
import { contextTagVocab } from "../repo/context-tag-effects.js";
import { todayPath } from "../repo/today-path.js";
import { getRecoveryBaselineRead } from "../repo/baseline-bands.js";
import { fuelIdeas } from "../repo/fuel-ideas.js";
import { localDateISO, localHourFraction } from "../repo/shared.js";
import { directivesResponse } from "./connected-brain.js";
import { weekAheadResponse } from "./day-coach.js";
import { fuelingFollowupResponse, nutritionDayResponse } from "./nutrition.js";
import { settingsResponse } from "./operator.js";
import { todaySideRead } from "./today-side.js";

export type ApiResponses = Record<string, unknown>;

/** Put one path's body into the map, or leave the path out if its reader failed. */
function put(out: ApiResponses, path: string, read: () => unknown): void {
  try {
    out[path] = read();
  } catch {
    /* this one loader falls back to its own request */
  }
}

const q = (value: string) => encodeURIComponent(value);

export function publicTodayPlanDay(dateQuery?: unknown) {
  const date = todayDateParam(dateQuery);
  const selected = selectedPlanDayForDate(date);
  if (!selected) {
    // No plan day today. Plan days hold strength only, so a weekday the athlete does
    // not lift has no row: say which CALENDAR day it is — a stated run day or a rest
    // day — rather than a bare null the client would read as "no plan at all". Still
    // null when there is genuinely no plan and no lifting week to read.
    const calendar = (() => {
      try {
        return calendarDayRead(date);
      } catch {
        return null;
      }
    })();
    if (!calendar || calendar.kind === "lift") return null;
    return {
      day_number: null,
      focus: null,
      source: "calendar" as const,
      calendar: calendar.kind,
      run_kind: calendar.kind === "run" ? calendar.run_kind : null,
      reason: null,
      candidates: planDayRecoveryCandidates(date),
    };
  }
  const adaptiveReason = typeof selected.selection?.reason === "string"
    ? selected.selection.reason.trim().slice(0, 240)
    : null;
  return {
    day_number: selected.day_number,
    focus: selected.focus,
    source: selected.source,
    reason: adaptiveReason || (selected.source === "existing-session" ? "Continue the session already linked to this date." : null),
    // Every programmed day, not just the chosen one: the athlete can tap any pill,
    // and a pill that would hand them work their legs are still doing should say
    // so before they tap it rather than after. Groups and a boolean only — the
    // scores behind the pick stay on the server.
    candidates: planDayRecoveryCandidates(date),
  };
}

type AgendaCandidate = { client_card?: unknown };

/** The rail cards the agenda names, primary and more alike (the client runs both). */
function agendaCards(agenda: unknown): Set<string> {
  const cards = new Set<string>();
  const row = agenda && typeof agenda === "object" ? (agenda as { primary?: unknown; more?: unknown }) : null;
  for (const tier of [row?.primary, row?.more]) {
    if (!Array.isArray(tier)) continue;
    for (const candidate of tier as AgendaCandidate[]) {
      if (candidate && typeof candidate.client_card === "string") cards.add(candidate.client_card);
    }
  }
  return cards;
}

/**
 * Everything a Today open asks for beside the aggregate itself, keyed by the path it
 * asks with. `agenda` and `progressionDay` are the ones the aggregate already
 * computed, so the rail follows the same agenda the aggregate returns.
 */
export function todaySurfaceResponses(
  date: string,
  opts: {
    agenda: unknown;
    progressionDay: number | null;
    coachingFocus: unknown;
    strengthJourney: unknown;
    /** Hears the week-ahead cache key this open kicked a refresh job for. */
    onWeekAheadRefresh?: (cacheKey: string) => void;
  },
): ApiResponses {
  const out: ApiResponses = {};
  const isToday = date === localDateISO();
  // Paint-critical: the plan-day pick the session prep awaits, and the prep wave.
  put(out, `/today-plan-day?date=${q(date)}`, () => publicTodayPlanDay(date));
  if (opts.progressionDay != null) {
    const day = opts.progressionDay;
    put(out, `/program/progression?day=${q(String(day))}`, () => planDayProgression(day));
  }
  out["/strength-journey"] = opts.strengthJourney;
  // The aggregate already answered these two for this open.
  out[`/today-agenda?date=${q(date)}`] = opts.agenda;
  out["/coaching-focus"] = opts.coachingFocus;
  put(out, "/settings", () => settingsResponse());
  put(out, "/profile", () => getProfile());
  if (isToday) put(out, `/training-agenda?date=${q(date)}`, () => flexibleTrainingAgenda(date));
  // Phase-one side panels and the capture row's tag chips (wall-clock date).
  put(out, `/today-side?date=${q(date)}`, () => todaySideRead(date));
  put(out, "/context-tags/vocab", () => contextTagVocab());
  const wallDate = localDateISO();
  put(out, `/context-tags?date=${q(wallDate)}`, () => listContextTags(wallDate));
  // The directives the capture provenance reads, the Changes line.
  put(out, "/directives", () => directivesResponse(false));
  put(out, "/brain/changes", () => brainChangesRead({}));
  // The redesigned Today's forward reads: the path under the Brief (and the week,
  // horizon and progress board it feeds), the overnight digest, the week strip's
  // projection and the recovery gauges' personal bands.
  put(out, `/today-path?date=${q(date)}`, () => todayPath(date));
  put(out, `/today-digest?date=${q(date)}`, () => overnightDigest(date));
  if (isToday) {
    put(out, "/plan/week", () => planWeek());
    put(out, "/recovery/baseline", () => getRecoveryBaselineRead());
    // The Fuel glance under the Brief draws on every Today open for today
    // (today-fuel-glance-client.ts): the day's intake and the ideas for the device's
    // hour, spelled as the glance asks. The hour is the local one in the device zone
    // this request runs in; a glance that reads another hour just asks its own.
    put(out, `/nutrition/day?date=${q(date)}`, () => nutritionDayResponse(date));
    const hour = Math.floor(localHourFraction());
    put(out, `/fuel/ideas?date=${q(date)}&hour=${hour}`, () => fuelIdeas(date, { hour, exclude: [] }));
  }
  // The rail: only the cards this agenda names (see the header).
  const cards = agendaCards(opts.agenda);
  if (!isToday && cards.has("fuel")) put(out, `/nutrition/day?date=${q(date)}`, () => nutritionDayResponse(date));
  if (cards.has("fueling-followup")) put(out, "/nutrition/fueling-followup", () => fuelingFollowupResponse());
  if (cards.has("week-ahead")) put(out, "/week-ahead", () => weekAheadResponse(undefined, opts.onWeekAheadRefresh));
  if (cards.has("program-adjustments")) put(out, "/program/adjustments", () => programAdjustments());
  if (cards.has("garmin-reconcile")) put(out, "/garmin/unreconciled", () => listUnreconciledGarminStrength(30));
  if (cards.has("lately")) put(out, "/recent-training?limit=6", () => recentTraining(6));
  if (cards.has("weekly-read") || cards.has("connection-insight")) {
    put(out, "/insights", () => listVisibleInsights(20));
  }
  if (cards.has("weekly-read")) {
    put(out, "/team-week", () => teamWeekRead({ drainBacklog: true }));
    // Asked only when a full weekly card will render (see capture-reads-client):
    // a weekly read the athlete has not thumbed up, or one gone stale.
    const insights = out["/insights"];
    const weekly = Array.isArray(insights)
      ? (insights as Array<{ kind?: unknown; feedback?: unknown; stale?: unknown }>).find(
          (row) => row && row.kind === "weekly_read"
        )
      : null;
    if (weekly && (weekly.feedback !== "up" || weekly.stale === true)) put(out, "/week-wins", () => weekWins(undefined));
  }
  return out;
}

/**
 * Everything a Session open asks for beside the aggregate, keyed by the path it asks
 * with: the header's strength line, the plan-day pick, the plan day's prescriptions,
 * the anchor journey, the primer for that day and the day's symptom rows. The primer
 * and prescriptions follow the plan day the aggregate picked (`progressionDay`); a
 * session opened on another day simply asks for its own. Each entry is the same call
 * its route makes, so this is never memoized (routes/today.ts) — it is exactly as fresh
 * as the reads it replaces.
 */
export function sessionSurfaceResponses(
  date: string,
  opts: { progressionDay: number | null; strengthJourney: unknown },
): ApiResponses {
  const out: ApiResponses = {};
  put(out, `/today-strength-line?date=${q(date)}`, () => todayStrengthLine(date));
  put(out, `/today-plan-day?date=${q(date)}`, () => publicTodayPlanDay(date));
  out["/strength-journey"] = opts.strengthJourney;
  put(out, "/settings", () => settingsResponse());
  put(out, "/profile", () => getProfile());
  if (opts.progressionDay != null) {
    const day = opts.progressionDay;
    put(out, `/program/progression?day=${q(String(day))}`, () => planDayProgression(day));
    put(out, `/session-primer?date=${q(date)}&day=${q(String(day))}`, () => sessionPrimer(date, { dayNumber: day }));
  }
  put(out, `/training-symptoms?on=${q(date)}&include_resolved=1`, () =>
    listTrainingSymptoms({ on: date, include_resolved: true, seed_legacy: true })
  );
  return out;
}

/**
 * Horizon -> Race in one request: the goal, compliance, settings, this week's run
 * plan / race build / agenda, and the same three reads for each later Monday the
 * screen asks about (`dates`, at most four, each YYYY-MM-DD).
 */
export function horizonRaceResponses(datesQuery: unknown): ApiResponses {
  const out: ApiResponses = {};
  const today = localDateISO();
  put(out, "/profile", () => getProfile());
  put(out, "/endurance-goal", () => getEnduranceGoal());
  put(out, "/run-compliance", () => runComplianceRead(undefined));
  put(out, "/settings", () => settingsResponse());
  put(out, "/race-build", () => raceBuild(undefined, { describeRunning: true }));
  put(out, "/run-plan", () => weeklyRunPlan(undefined));
  put(out, `/training-agenda?date=${q(today)}`, () => flexibleTrainingAgenda(today));
  put(out, "/plan/upcoming", () => planUpcomingNote());
  const dates = String(typeof datesQuery === "string" ? datesQuery : "")
    .split(",")
    .map((d) => d.trim())
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .slice(0, 4);
  for (const date of [...new Set(dates)]) {
    put(out, `/training-agenda?date=${q(date)}`, () => flexibleTrainingAgenda(date));
    put(out, `/run-plan?date=${q(date)}`, () => weeklyRunPlan(date));
    put(out, `/race-build?date=${q(date)}`, () => raceBuild(date, { describeRunning: true }));
  }
  return out;
}
