// THE TODAY STRENGTH LINE — one server-owned answer to "what is today's lift, and
// where does it stand", rendered verbatim by the Brief, the Session header, the Plan
// week strip and the Train overview.
//
// Four surfaces used to read four different fields (the read's kind, the accepted
// decision, the week projection, the conductor's posture) and so gave four answers
// on one morning. This composes the answer ONCE from the log and the plan:
//
// - the plan day is the one today resolves to (the session already logged, else the
//   same selection the Brief and Session use), named by its NAME, never its focus;
// - the state is read off the log — sets in a finished session are "logged", sets in
//   an open one are "in progress", nothing lifted is "not started";
// - a rest/easy read is a CAVEAT on that plan day, never a replacement title
//   (suggestion, never a gate);
// - a run logged today is named beside the lift, never instead of it ("Run in · Pull
//   still open").
//
// Deterministic and cheap: it reads the persisted day read, and computes the
// deterministic floor only when no row exists at all (the floor the Brief would serve).
import { db } from "../db.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { getCachedDayRead } from "./day-read-cache.js";
import { dayRead } from "./day-read.js";
import { activitySportWhere, RUN_SPORT_PATTERNS } from "./endurance-sports.js";
import { withoutShadowActivities } from "./activity-shadow.js";
import { sameDayEnduranceOutings } from "./hybrid-load.js";
import {
  calendarDayRead,
  planDayRole,
  selectedPlanDayForDate,
  type CalendarDayRead,
  type PlanDayCandidate,
  type WeekdayPlanDayRole,
} from "./plan-selection.js";
import { datedPlanDayFocus, legTrimFocus, type LegTrim } from "./plan-day-focus.js";
import { planDayLegTrimOn } from "./plan-day-trim.js";
import { planDayDisplayName } from "./plan-day-name.js";
import { RUN_KIND_LABELS } from "./run-edit.js";
import { loggedSessionDay, planDayTitle, sessionDayCandidates, type LoggedSessionDay } from "./session-day.js";
import { openSessionOn, type OpenSession } from "./open-session.js";
import { copyDeep, requestMemo } from "./request-memo.js";
import { localDateISO } from "./shared.js";

export type TodayStrengthState = "not_started" | "in_progress" | "logged" | "rest_day" | "no_lift" | "none";

export interface TodayStrengthLine {
  date: string;
  day_number: number | null;
  /** The plan day's NAME ("Pull") — the label everywhere; "Pull, reshaped" when most slots moved. */
  title: string | null;
  /**
   * The plan day's focus sentence — secondary text only. On a day the race build trims
   * the legs (taper, race week, a key run's eve) it says so beside the stored focus
   * ("… Lighter on the legs — taper week."); the title stays the plan day's NAME.
   */
  focus: string | null;
  /** The stress budget's leg trim on today's plan day (plan-day-trim.ts), or null. */
  trim?: LegTrim | null;
  role: WeekdayPlanDayRole | null;
  state: TodayStrengthState;
  /**
   * The read's suggestion for today, carried as a caveat on the plan day. Null once the
   * athlete CHOSE today's session (`open_session.chosen`): a chosen session is never
   * "rest suggested" — the read survives only as `caveat`, in "you chose to train" words.
   */
  suggestion: "easy" | "rest" | null;
  /** The suggestion as a few words beside the plan day's name ("Pull · lighter today"). */
  suggestion_label: string | null;
  caveat: string | null;
  run_in: { km: number | null } | null;
  /** Most of the accepted session's slots were substituted off the plan day. */
  reshaped: boolean;
  /** The plan day's own movements, so a reshaped day keeps its original list one tap away. */
  original: string[];
  /** The one line every surface prints verbatim. */
  text: string;
}

function todaySession(date: string): { id: number; plan_day_id: number | null; finished: boolean } | null {
  const row = db
    .prepare(
      `SELECT s.id AS id, s.plan_day_id AS plan_day_id, s.finished_at AS finished_at
         FROM sessions s
        WHERE s.date = ? AND COALESCE(s.kind, 'strength') <> 'cardio'
          AND EXISTS (SELECT 1 FROM logged_sets l WHERE l.session_id = s.id)
        ORDER BY s.id DESC LIMIT 1`
    )
    .get(date) as any;
  if (!row) return null;
  return {
    id: Number(row.id),
    plan_day_id: row.plan_day_id == null ? null : Number(row.plan_day_id),
    finished: !!row.finished_at,
  };
}

function runLoggedOn(date: string): { km: number | null } | null {
  try {
    const sport = activitySportWhere("a", RUN_SPORT_PATTERNS);
    // A hand-logged shadow of a synced run is one outing, not a doubled distance.
    const rows = withoutShadowActivities(
      db
        .prepare(
          `SELECT a.date AS date, a.type AS type, a.source AS source, a.external_id AS external_id, a.distance_km AS distance_km
             FROM activities a WHERE a.date = ? AND (${sport.sql})`
        )
        .all(date, ...sport.params) as any[]
    );
    if (!rows.length) return null;
    const km = rows.reduce((sum, r) => sum + (Number(r.distance_km) > 0 ? Number(r.distance_km) : 0), 0);
    return { km: km > 0 ? Math.round(km * 10) / 10 : null };
  } catch {
    return null;
  }
}

// The other sport already in beside the run: the day's biggest non-run outing, when it
// was a real session (the ride out, the loop and the ride home are one outing:
// sameDayEnduranceOutings, which grades it against the sport's own long bar). A stroll
// or a short spin is not named, and a sport with no plain noun stays unnamed.
const OUTING_NOUN: Readonly<Record<string, string>> = {
  ride: "ride",
  swim: "swim",
  row: "row",
  paddle: "paddle",
  snow: "ski",
  hike: "hike",
};
function otherSportLoggedOn(date: string): string | null {
  try {
    const outing = sameDayEnduranceOutings(date).find((o) => o.heavy || o.real_session);
    return outing ? (OUTING_NOUN[outing.family] ?? null) : null;
  } catch {
    return null;
  }
}

// A session the athlete CHOSE for today instead of the plan day — a drafted
// suggestion they accepted, or one they wrote themselves. It owns the day's title:
// naming the plan day over it read as though the choice never landed, and the
// Brief kept offering the swap they had already made.
type ChosenSession = { sessionId: number | null; title: string; focus: string | null };

// `exercises` is the lifts the composition's card actually carries, so a focus is held to them.
type AcceptedComposition = {
  reshaped: boolean;
  decisionKind: string | null;
  chosen: ChosenSession | null;
  exercises: string[];
};

const NO_COMPOSITION: AcceptedComposition = { reshaped: false, decisionKind: null, chosen: null, exercises: [] };

// The accepted composition for today: whether most of its strength slots were moved
// off the plan day (a substitution names the slot it replaced), the decision kind
// it was composed under — the fallback suggestion when the read itself says nothing
// about today's lift — and, when it is not a plan day at all, the chosen session.
function acceptedComposition(date: string): AcceptedComposition {
  try {
    const row = db
      .prepare(
        `SELECT session_id, source, title, focus, items_json, provenance_json FROM daily_session_compositions
          WHERE date = ? AND status = 'active' ORDER BY version DESC LIMIT 1`
      )
      .get(date) as any;
    if (!row) return NO_COMPOSITION;
    let items: any[] = [];
    try {
      const parsed = JSON.parse(String(row.items_json ?? "[]"));
      items = Array.isArray(parsed) ? parsed.filter((it) => String(it?.kind ?? "") !== "cardio") : [];
    } catch {
      items = [];
    }
    const substituted = items.filter(
      (it) => typeof it?.substitution_for === "string" && it.substitution_for.trim()
    ).length;
    let decisionKind: string | null = null;
    try {
      const provenance = JSON.parse(String(row.provenance_json ?? "null"));
      const kind = provenance?.daily_decision?.kind;
      decisionKind = typeof kind === "string" ? kind : null;
    } catch {
      decisionKind = null;
    }
    const source = String(row.source ?? "");
    // A title the athlete TYPED (athlete_override) is theirs and prints exactly as
    // typed. A suggestion's title is agent-authored, so it reads through the same
    // display rule as a plan day's name: a count of the week ("Lower — the week's one
    // leg day") is dropped, since the calendar can contradict it (src/repo/plan-day-name.ts).
    const stored = String(row.title ?? "").trim();
    const title = source === "agent_suggest" ? planDayDisplayName(stored) : stored;
    const chosen =
      (source === "agent_suggest" || source === "athlete_override") && title
        ? {
            sessionId: row.session_id == null ? null : Number(row.session_id),
            title,
            focus: String(row.focus ?? "").trim() || null,
          }
        : null;
    const exercises = items.map((it) => String(it?.exercise ?? "").trim()).filter(Boolean);
    return { reshaped: items.length > 0 && substituted * 2 > items.length, decisionKind, chosen, exercises };
  } catch {
    return NO_COMPOSITION;
  }
}

function suggestionFor(date: string, decisionKind: string | null): "easy" | "rest" | null {
  let readKind: string | null = null;
  try {
    // Stale rows included: `invalidateDayRead` only MARKS the Brief's row (a check-in, a
    // sync), and hiding it here left the line with no caveat on the very morning the
    // Brief was still saying rest — two voices for one day. The marked row is the last
    // thing the Brief said, and the Brief's next open reconciles it in place.
    const cached = getCachedDayRead(date, { includeStale: true });
    // No row at all: an invalidation DELETES a deterministic row, and the Brief then
    // serves the deterministic floor on its next open. Say what that floor says rather
    // than nothing — the one computed read here, and only on a day with a lift still
    // open (the caller's gate).
    readKind = cached ? (cached.kind ?? null) : (dayRead(date)?.kind ?? null);
  } catch {
    readKind = null;
  }
  if (readKind === "rest" || readKind === "easy") return readKind;
  // A "train" read is a positive answer about today; only an absent read, or one that
  // speaks to work already done, leaves the accepted decision as the standing word.
  if (readKind === "train") return null;
  return decisionKind === "rest" || decisionKind === "easy" ? decisionKind : null;
}

// One wording per quiet morning would print the same sentence for weeks (the
// reading-grammar variant law — see day-read-rules.ts). Rotate through a small set
// keyed by date, same as every other athlete-facing string; each still carries a
// caveat, never a gate ("still yours/there" — the athlete drives).
const CAVEAT: Record<"easy" | "rest", ((name: string) => string)[]> = {
  easy: [
    (name) => `The read suggests easy today — ${name} is still there, held light.`,
    (name) => `Today reads easy — ${name} is still yours, just take it light.`,
    (name) => `The read leans easy today — ${name} is still there if lighter suits you.`,
  ],
  rest: [
    (name) => `The read suggests rest today — ${name} is still yours if you want it.`,
    (name) => `Today reads as rest — ${name} is still there whenever you want it.`,
    (name) => `The read leans toward rest — ${name} is still yours to pick up.`,
  ],
};

// The short form a strip cell prints beside the plan day's NAME — still a suggestion,
// never a replacement title and never a gate.
const SUGGESTION_LABEL: Record<"easy" | "rest", string> = {
  easy: "lighter today",
  rest: "rest suggested",
};

function caveatFor(suggestion: "easy" | "rest", name: string, date: string): string {
  const variant = pickDayVariant(CAVEAT[suggestion], date, `strength_line_caveat:${suggestion}`);
  return variant(name);
}

// The athlete CHOSE today's session over a quiet read. The read is still worth a word,
// but the day is theirs: never "rest suggested" beside a session they picked, never a
// gate. Rotated by date like every other athlete-facing string.
const CHOSEN_CAVEAT: Record<"easy" | "rest", ((name: string) => string)[]> = {
  easy: [
    (name) => `The read leaned easy — you chose ${name}, so let how it feels set the pace.`,
    (name) => `Today read easy; ${name} is your call — settle in and see how it goes.`,
    (name) => `An easy read this morning, and you picked ${name} — take it as it comes.`,
  ],
  rest: [
    (name) => `The read leaned quiet — you chose to train, so let how ${name} feels set the pace.`,
    (name) => `A quiet read this morning; ${name} is your call, and it stands.`,
    (name) => `You chose ${name} on a quiet read — take it as it comes.`,
  ],
};

function chosenCaveatFor(suggestion: "easy" | "rest", name: string, date: string): string {
  const variant = pickDayVariant(CHOSEN_CAVEAT[suggestion], date, `strength_line_chosen_caveat:${suggestion}`);
  return variant(name);
}

// The run is in and the lift is still to come: a calm sentence, never the clipped
// "Run in · Push B — overhead support still open" (2026-10-20, under "An easy day
// today."). The lift stays the athlete's to take; rotated by date so a stable morning
// never prints one literal for weeks.
const RUN_IN_LIFT_OPEN: ReadonlyArray<(name: string) => string> = [
  (name) => `Your run's in. ${name} is still there if you want it.`,
  (name) => `Run done. ${name} is still on for today, whenever you're ready.`,
  (name) => `The run's in; ${name} is still there if you want it.`,
];
// The lift is logged and the run is in: a calm sentence, never the clipped
// "Push B — overhead support · logged · run in" (2026-10-20). Rotated by date.
const LOGGED_RUN_IN: ReadonlyArray<(title: string) => string> = [
  (title) => `${title} is done, and the run's in.`,
  (title) => `${title} is logged, and so is the run.`,
  (title) => `The run's in and ${title} is done.`,
];
// The lift is under way and the run is in: the same calm register.
const IN_PROGRESS_RUN_IN: ReadonlyArray<(title: string) => string> = [
  (title) => `${title} is under way, and the run's in.`,
  (title) => `The run's in, and ${title} is under way.`,
  (title) => `${title} is in progress, with the run already in.`,
];
// …and when another sport is in beside the run, both are named: a morning run and two
// and a half hours on the bike read as "the run's in" (2026-11-11).
const RUN_AND_MORE_IN_LIFT_OPEN: ReadonlyArray<(name: string, also: string) => string> = [
  (name, also) => `Your run and ${also} are in. ${name} is still there if you want it.`,
  (name, also) => `Run and ${also} done. ${name} is still on for today, if you want it.`,
  (name, also) => `The run and the ${also} are in; ${name} is still there if you want it.`,
];
const RESHAPED_TODAY: readonly string[] = ["It's reshaped for today.", "It's been shaped for today."];

function lineText(
  title: string | null,
  state: TodayStrengthState,
  run: boolean,
  name: string | null,
  date: string,
  also: string | null = null
): string {
  switch (state) {
    case "not_started":
      // One sentence for the run in and the lift still open, never "Pull, reshaped still open".
      if (run) {
        const lift = String(name ?? title ?? "the lift").replace(/[.\s]+$/, "");
        const lead = also
          ? pickDayVariant(RUN_AND_MORE_IN_LIFT_OPEN, date, "strength_line:run_in_open")(lift, also)
          : pickDayVariant(RUN_IN_LIFT_OPEN, date, "strength_line:run_in_open")(lift);
        return title !== name
          ? `${lead} ${pickDayVariant(RESHAPED_TODAY, date, "strength_line:reshaped")}`
          : lead;
      }
      return `${title} · not started`;
    case "in_progress":
      if (run) {
        const going = String(title ?? "Today's session").replace(/[.\s]+$/, "");
        return pickDayVariant(IN_PROGRESS_RUN_IN, date, "strength_line:in_progress_run_in")(going);
      }
      return `${title} · in progress`;
    case "logged":
      if (run) {
        const done = String(title ?? "Today's session").replace(/[.\s]+$/, "");
        return pickDayVariant(LOGGED_RUN_IN, date, "strength_line:logged_run_in")(done);
      }
      return `${title} · logged`;
    case "rest_day":
      return run ? "Rest day · run in" : "Rest day";
    case "no_lift":
      return run ? `${title} · run in` : `${title} · no lift today`;
    default:
      return run ? "Run in" : "Nothing planned today";
  }
}

// What owns today, before anything else is composed: a session the athlete CHOSE (it
// names no plan day), else the logged session's plan day, else the day today's selection
// resolves to. One answer for the full line and for the day-only read below.
type LineDay = {
  chosen: ChosenSession | null;
  composition: AcceptedComposition;
  session: { id: number; plan_day_id: number | null; finished: boolean } | null;
  day: PlanDayCandidate | null;
  logged: LoggedSessionDay | null;
  /** Today's open session (open-session.ts), the one fact every surface reads. */
  open: OpenSession | null;
  /**
   * The open session owns the line with nothing logged yet: the athlete chose it (a
   * train-anyway day, a picked plan day) or lived on it without a set. It names its own
   * plan day, never the selection's, and never the calendar's rest.
   */
  openOwns: boolean;
};

function lineDay(d: string): LineDay {
  // The plan once per request, the same read the week strip's cells resolve against.
  const candidates: PlanDayCandidate[] = sessionDayCandidates();
  const session = (() => {
    try {
      return todaySession(d);
    } catch {
      return null;
    }
  })();
  const composition = acceptedComposition(d);
  const open = (() => {
    try {
      return openSessionOn(d);
    } catch {
      return null;
    }
  })();
  // A chosen session stands in for the plan day unless a different session was logged.
  const chosen =
    composition.chosen && (!session || composition.chosen.sessionId == null || composition.chosen.sessionId === session.id)
      ? composition.chosen
      : null;
  if (chosen) return { chosen, composition, session, day: null, logged: null, open, openOwns: false };
  // The logged session owns the day, the same way it owns its week-strip cell — through
  // the same answer (src/repo/session-day.ts), so the line and the cell name one day.
  let day: PlanDayCandidate | null = null;
  let logged: LoggedSessionDay | null = null;
  if (session) {
    try {
      logged = loggedSessionDay(session.id, session.plan_day_id, candidates);
      day = logged.day_number != null ? (candidates.find((c) => c.day_number === logged!.day_number) ?? null) : null;
    } catch {
      day = null;
    }
  }
  // Nothing logged, but a session is open that the athlete chose or lived on: it owns
  // the day, named by the plan day it was snapshotted from (a train-anyway session under
  // a rest read is the session, not the calendar's rest).
  const openOwns = !session && !!open && (open.chosen || open.started);
  if (openOwns && open?.plan_day_id != null) {
    day = candidates.find((c) => Number(c.id) === Number(open.plan_day_id)) ?? null;
  }
  if (!day && !session && !openOwns) {
    try {
      const selected = selectedPlanDayForDate(d);
      day = selected ? (candidates.find((c) => c.day_number === selected.day_number) ?? null) : null;
    } catch {
      day = null;
    }
  }
  return { chosen: null, composition, session, day, logged, open, openOwns };
}

/**
 * The plan day the strength line for `date` names — its `day_number` when its role is
 * strength, else null — WITHOUT composing the rest of the line (no read's suggestion, no
 * leg trim, no run, no calendar). For a caller that needs only which day (the week
 * placement, src/repo/week-strength-placement.ts): the full line computes a day read and a
 * race build to say its caveat and trim, which the placement never prints.
 * Request-memoized: a Today open asks it from several reads.
 */
export function todayStrengthLineDay(date?: string): number | null {
  const d = String(date || localDateISO()).slice(0, 10);
  return requestMemo(
    `strength_line_day:${d}`,
    () => {
      const { day } = lineDay(d);
      return day && planDayRole(day) === "strength" ? day.day_number : null;
    },
    (n) => n
  );
}

export function todayStrengthLine(date?: string): TodayStrengthLine {
  const d = String(date || localDateISO()).slice(0, 10);
  return requestMemo(`today_strength_line:${d}`, () => todayStrengthLineRead(d), copyDeep);
}

function todayStrengthLineRead(d: string): TodayStrengthLine {
  const { chosen, composition, session, day, logged, open, openOwns } = lineDay(d);
  // The athlete chose today's session: the read is a caveat in their words, never a
  // suggestion that the day is rest (one fact, open_session.chosen).
  const choseToTrain = !!open?.chosen;
  if (chosen) {
    const state: TodayStrengthState = session
      ? session.finished
        ? "logged"
        : "in_progress"
      : open?.started
        ? "in_progress"
        : "not_started";
    const read = state === "logged" ? null : suggestionFor(d, composition.decisionKind);
    const suggestion = choseToTrain ? null : read;
    const run = runLoggedOn(d);
    return {
      date: d,
      day_number: null,
      title: chosen.title,
      focus: datedPlanDayFocus(chosen.focus, d, { exercises: composition.exercises }),
      role: "strength",
      state,
      suggestion,
      suggestion_label: suggestion ? SUGGESTION_LABEL[suggestion] : null,
      caveat: suggestion
        ? caveatFor(suggestion, chosen.title, d)
        : read && choseToTrain
          ? chosenCaveatFor(read, chosen.title, d)
          : null,
      run_in: run,
      reshaped: false,
      original: [],
      text: lineText(chosen.title, state, !!run, chosen.title, d, run ? otherSportLoggedOn(d) : null),
    };
  }
  const run = runLoggedOn(d);
  // No plan day and no session: the CALENDAR says what today is. Plan days hold
  // strength only, so a weekday the athlete does not lift has no row — a stated run
  // weekday is a run day (role "endurance"), anything else is a rest day.
  const calendar: CalendarDayRead | null =
    !day && !session && !openOwns
      ? (() => {
          try {
            return calendarDayRead(d);
          } catch {
            return null;
          }
        })()
      : null;
  // A stated run weekday the week's run did not land on reads as rest in the Brief (the
  // agenda put the "Saturday or Sunday" long run on Sunday) — the line agrees with it.
  const readSaysRest = (() => {
    try {
      return (getCachedDayRead(d) as any)?.signals?.calendar_day === "rest";
    } catch {
      return false;
    }
  })();
  const calendarRole: WeekdayPlanDayRole | null =
    calendar?.kind === "run" && !readSaysRest ? "endurance" : calendar ? (calendar.kind === "lift" ? null : "rest") : null;
  const role = day ? planDayRole(day) : openOwns ? "strength" : calendarRole;
  const name = day ? planDayTitle(day) : openOwns && open ? open.title : null;
  // A run day is named for its run, the way the athlete stated it ("Long run").
  const runDayTitle =
    calendarRole === "endurance" ? (RUN_KIND_LABELS[String(calendar?.run_kind ?? "")] ?? "Run day") : null;

  let state: TodayStrengthState;
  if (session) state = session.finished ? "logged" : "in_progress";
  else if (openOwns) state = open?.started ? "in_progress" : "not_started";
  else if (role === "rest") state = "rest_day";
  else if (role === "endurance") state = "no_lift";
  else if (!day) state = "none";
  else if (role === "strength") state = "not_started";
  else state = "no_lift";

  const reshaped = !!name && role === "strength" && composition.reshaped;
  const title = name
    ? reshaped
      ? `${name}, reshaped`
      : name
    : session
      ? logged?.title || "Today's session"
      : runDayTitle;
  const read = state === "not_started" || state === "in_progress" ? suggestionFor(d, composition.decisionKind) : null;
  const suggestion = choseToTrain ? null : read;
  const trim =
    day && role === "strength"
      ? (() => {
          try {
            return planDayLegTrimOn(d, day.day_number);
          } catch {
            return null;
          }
        })()
      : null;
  // The stored focus is free text nothing re-syncs when a slot is swapped or removed, so it
  // is held to the lifts on today's card: the composition's items when one owns the day,
  // else the plan day's own current items.
  const cardLifts = composition.exercises.length ? composition.exercises : (day?.names ?? []);
  return {
    date: d,
    day_number: day ? day.day_number : null,
    title,
    // Read for today's date: a stored calendar claim never outlives the week it was written
    // for, and a trimmed day says its trim beside the focus (never instead of the title).
    focus: legTrimFocus(day?.focus ? datedPlanDayFocus(String(day.focus).trim() || null, d, { exercises: cardLifts }) : null, trim, d),
    trim,
    role,
    state,
    suggestion,
    suggestion_label: suggestion && name ? SUGGESTION_LABEL[suggestion] : null,
    caveat:
      suggestion && name
        ? caveatFor(suggestion, name, d)
        : read && choseToTrain && name
          ? chosenCaveatFor(read, name, d)
          : null,
    run_in: run,
    reshaped,
    original: reshaped && day ? [...day.names] : [],
    text: lineText(title, state, !!run, name, d, run ? otherSportLoggedOn(d) : null),
  };
}
