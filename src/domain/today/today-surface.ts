// The Today surface aggregate: ONE server read for everything the PWA needs
// before its first paint. Cross-domain by nature (training plan + session, the
// person, and the brain's salience arbiter / conductor), so it composes the
// existing domain reads and adds no rules of its own — every slice here is
// byte-identical to the standalone route that still serves it.
import { getCoachingFocus, markTodaySeen, shouldMarkTodayAgendaSeen, todayAgenda } from "../brain/index.js";
import { getProfile } from "../person/index.js";
import {
  getLastSet,
  getSessionByDate,
  getWeeklyStats,
  listExercises,
  planDayProgression,
  selectedPlanDayForDate,
  strengthJourneyRead,
  openSessionOn,
  todayStrengthLine,
  type OpenSession,
  type TodayStrengthLine,
} from "../training/index.js";
import { getPlanWithPurpose } from "../../repo/day-read.js";
import { getCachedDayRead } from "../../repo/day-read-cache.js";
import { chosenSessionHeadline } from "../../repo/day-read-prose.js";
import { localDateISO } from "../../repo/shared.js";

export function todayDateParam(value: unknown): string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : localDateISO();
}

// Marking "seen" powers the "since you last looked" continuity line. It is
// DEBOUNCED (~1h) inside markTodaySeen, so both surfaces that compute the agenda
// — GET /today-agenda and the aggregate below — can call this and one Today open
// still advances the stamp exactly once. Best-effort; never throws into a request.
export function markTodayAgendaSeen(date?: string | null): void {
  try {
    if (shouldMarkTodayAgendaSeen(date, localDateISO())) markTodaySeen();
  } catch {
    /* best-effort */
  }
}

function planItemsOf(day: unknown): Array<Record<string, unknown>> {
  const items = (day as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as Array<Record<string, unknown>>) : [];
}

// The strength exercises the Today/Session card will show for this date, so the
// aggregate can carry their last logged set instead of the client asking one
// GET /last-set per name. Best-effort and bounded: an off-plan name the client
// adds itself simply is not covered and falls back to its own request.
const MAX_LAST_SET_NAMES = 24;

function todayExerciseNames(date: string, plan: Array<Record<string, unknown>>, session: unknown): string[] {
  const names: string[] = [];
  const push = (items: Array<Record<string, unknown>>) => {
    for (const item of items) {
      if (item.kind === "cardio") continue;
      const name = typeof item.exercise === "string" ? item.exercise.trim() : "";
      if (name && !names.includes(name)) names.push(name);
    }
  };
  // A started/accepted daily session is the concrete prescription the card renders.
  const daily = (session as { daily_session?: unknown } | null)?.daily_session;
  if (daily && typeof daily === "object") push(planItemsOf(daily));
  const selectedDay = selectedPlanDayForDate(date);
  if (selectedDay) {
    const day = plan.find((row) => Number(row.day_number) === Number(selectedDay.day_number));
    if (day) push(planItemsOf(day));
  }
  return names.slice(0, MAX_LAST_SET_NAMES);
}

export type TodayAggregate = {
  date: string;
  plan: Array<Record<string, unknown>>;
  session: unknown;
  stats: unknown;
  profile: unknown;
  exercises: unknown;
  last_sets: Record<string, unknown>;
  progression_day: number | null;
  progression: unknown[];
  strength_journey: unknown;
  agenda: unknown;
  coaching_focus: unknown;
  strength_line: TodayStrengthLine;
  /** Today's open session — the one Start/Continue fact the strength line also reads. */
  open_session: OpenSession | null;
  /**
   * The Brief's headline when the athlete's CHOSEN session owns today on a training read:
   * a server-written line about that session (its title; a neutral line for the empty
   * "Open session"), to print in place of the day read's `headline`, which names the plan
   * day. Null when the day read's own headline stands. The read's cached prose and its
   * identity are untouched (second review, item 14).
   */
  chosen_session_headline: string | null;
};

// The Brief headline a chosen session earns (see `chosen_session_headline`). Only on a
// training read: a rest or easy read stays the suggestion it is beside a session the
// athlete chose (the strength line already carries that choice as a caveat). The read is
// the cached one — never a fresh agent call from the aggregate; with no read cached yet
// the read's own headline stands. Fail-soft.
function chosenSessionHeadlineFor(date: string, open: OpenSession | null): string | null {
  if (!open?.chosen) return null;
  try {
    const read = getCachedDayRead(date);
    if (read?.kind !== "train") return null;
    return chosenSessionHeadline(open.title, date);
  } catch {
    return null;
  }
}

export function todayAggregate(dateQuery?: unknown): TodayAggregate {
  const date = todayDateParam(dateQuery);
  // One quiet purpose line per plan day (Amendment 2: "why this session" tied
  // to the strength block/endurance goal) — same source GET /plan reads, so
  // the sentence never appears here then vanishes on the client's background
  // /plan revalidation. See repo/day-read.ts getPlanWithPurpose.
  const plan = getPlanWithPurpose(date);
  const session = getSessionByDate(date);
  const selectedDay = selectedPlanDayForDate(date);
  const progressionDay =
    selectedDay && Number.isFinite(Number(selectedDay.day_number)) ? Number(selectedDay.day_number) : null;
  const last_sets: Record<string, unknown> = {};
  for (const name of todayExerciseNames(date, plan, session)) last_sets[name] = getLastSet(name);
  // The agenda is a real read of today's state, so computing it here marks Today
  // seen exactly as GET /today-agenda does (same debounced helper, one stamp).
  const agenda = todayAgenda(date);
  markTodayAgendaSeen(date);
  const openSession = openSessionOn(date);
  return {
    date,
    plan,
    session,
    stats: getWeeklyStats(),
    profile: getProfile(),
    exercises: listExercises(),
    last_sets,
    progression_day: progressionDay,
    progression: progressionDay == null ? [] : planDayProgression(progressionDay, { readDate: date }),
    strength_journey: strengthJourneyRead(),
    agenda,
    coaching_focus: getCoachingFocus(),
    strength_line: todayStrengthLine(date),
    open_session: openSession,
    chosen_session_headline: chosenSessionHeadlineFor(date, openSession),
  };
}
