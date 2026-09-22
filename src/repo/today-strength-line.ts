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
// Deterministic and cheap: it reads the persisted day read and never computes one.
import { db } from "../db.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { getCachedDayRead } from "./day-read-cache.js";
import { activitySportWhere, RUN_SPORT_PATTERNS } from "./endurance-sports.js";
import {
  planDayCandidates,
  planDayLabel,
  planDayRole,
  resolveSessionPlanDay,
  selectedPlanDayForDate,
  type PlanDayCandidate,
  type WeekdayPlanDayRole,
} from "./plan-selection.js";
import { localDateISO } from "./shared.js";

export type TodayStrengthState = "not_started" | "in_progress" | "logged" | "rest_day" | "no_lift" | "none";

export interface TodayStrengthLine {
  date: string;
  day_number: number | null;
  /** The plan day's NAME ("Pull") — the label everywhere; "Pull, reshaped" when most slots moved. */
  title: string | null;
  /** The plan day's focus sentence — secondary text only. */
  focus: string | null;
  role: WeekdayPlanDayRole | null;
  state: TodayStrengthState;
  /** The read's suggestion for today, carried as a caveat on the plan day. */
  suggestion: "easy" | "rest" | null;
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
    const row = db
      .prepare(`SELECT COUNT(*) AS n, SUM(a.distance_km) AS km FROM activities a WHERE a.date = ? AND (${sport.sql})`)
      .get(date, ...sport.params) as any;
    if (!row || !Number(row.n)) return null;
    const km = row.km == null || !Number.isFinite(Number(row.km)) ? null : Math.round(Number(row.km) * 10) / 10;
    return { km };
  } catch {
    return null;
  }
}

// The accepted composition for today: whether most of its strength slots were moved
// off the plan day (a substitution names the slot it replaced), and the decision kind
// it was composed under — the fallback suggestion when the read itself says nothing
// about today's lift.
function acceptedComposition(date: string): { reshaped: boolean; decisionKind: string | null } {
  try {
    const row = db
      .prepare(
        `SELECT items_json, provenance_json FROM daily_session_compositions
          WHERE date = ? AND status = 'active' ORDER BY version DESC LIMIT 1`
      )
      .get(date) as any;
    if (!row) return { reshaped: false, decisionKind: null };
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
    return { reshaped: items.length > 0 && substituted * 2 > items.length, decisionKind };
  } catch {
    return { reshaped: false, decisionKind: null };
  }
}

function suggestionFor(date: string, decisionKind: string | null): "easy" | "rest" | null {
  let readKind: string | null = null;
  try {
    readKind = getCachedDayRead(date)?.kind ?? null;
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

function caveatFor(suggestion: "easy" | "rest", name: string, date: string): string {
  const variant = pickDayVariant(CAVEAT[suggestion], date, `strength_line_caveat:${suggestion}`);
  return variant(name);
}

function lineText(title: string | null, state: TodayStrengthState, run: boolean, name: string | null): string {
  switch (state) {
    case "not_started":
      // "Run in · Pull still open", never "Pull, reshaped still open".
      if (run) return `Run in · ${name ?? title} still open${title !== name ? " · reshaped for today" : ""}`;
      return `${title} · not started`;
    case "in_progress":
      return `${title} · in progress${run ? " · run in" : ""}`;
    case "logged":
      return `${title} · logged${run ? " · run in" : ""}`;
    case "rest_day":
      return run ? "Rest day · run in" : "Rest day";
    case "no_lift":
      return run ? `${title} · run in` : `${title} · no lift today`;
    default:
      return run ? "Run in" : "Nothing planned today";
  }
}

export function todayStrengthLine(date?: string): TodayStrengthLine {
  const d = String(date || localDateISO()).slice(0, 10);
  let candidates: PlanDayCandidate[] = [];
  try {
    candidates = planDayCandidates();
  } catch {
    candidates = [];
  }
  const session = (() => {
    try {
      return todaySession(d);
    } catch {
      return null;
    }
  })();
  // The logged session owns the day, the same way it owns its week-strip cell.
  let day: PlanDayCandidate | null = null;
  if (session) {
    try {
      const resolved = resolveSessionPlanDay(session.id, session.plan_day_id, candidates);
      day = resolved ? (candidates.find((c) => c.day_number === resolved.day_number) ?? null) : null;
    } catch {
      day = null;
    }
  }
  if (!day && !session) {
    try {
      const selected = selectedPlanDayForDate(d);
      day = selected ? (candidates.find((c) => c.day_number === selected.day_number) ?? null) : null;
    } catch {
      day = null;
    }
  }
  const run = runLoggedOn(d);
  const role = day ? planDayRole(day) : null;
  const composition = acceptedComposition(d);
  const name = day ? planDayLabel(day) : null;

  let state: TodayStrengthState;
  if (session) state = session.finished ? "logged" : "in_progress";
  else if (!day) state = "none";
  else if (role === "rest") state = "rest_day";
  else if (role === "strength") state = "not_started";
  else state = "no_lift";

  const reshaped = !!name && role === "strength" && composition.reshaped;
  const title = name ? (reshaped ? `${name}, reshaped` : name) : session ? "Today's session" : null;
  const suggestion =
    state === "not_started" || state === "in_progress" ? suggestionFor(d, composition.decisionKind) : null;
  return {
    date: d,
    day_number: day ? day.day_number : null,
    title,
    focus: day?.focus ? String(day.focus).trim() || null : null,
    role,
    state,
    suggestion,
    caveat: suggestion && name ? caveatFor(suggestion, name, d) : null,
    run_in: run,
    reshaped,
    original: reshaped && day ? [...day.names] : [],
    text: lineText(title, state, !!run, name),
  };
}
