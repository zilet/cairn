// WHICH SESSION WAS ON WHICH DAY — one answer to "what was this logged session called",
// read by every surface that names a day's lift: the Plan week strip's cells (and so
// Today's strip, Horizon's week, the Program look-ahead and the day view, which all
// read those cells), the Train overview's latest sessions, the day record, the activity
// feed and the today strength line.
//
// Two questions used to be answered twice. The week cell took its plan day from
// `resolveSessionPlanDay` (the link, dropped once the logged work no longer resembles
// the day) and its title from `deriveSessionTitle` (the link's CURRENT row name held
// against the session's frozen card). After a mid-week redraw rewrote day 1 from Lower
// to Pull in place, Monday's Lower session read "Pull" on the strip and "Lower" on
// Horizon, and Wednesday the reverse (2026-10-16).
//
// The rule, so the log is the truth for a day that has one:
// - WHERE it sits is the plan day the logged work resolves to (`resolveSessionPlanDay`)
//   — `placed_day_number`, what a ring-ordered week files the session under;
// - WHAT it is called is `deriveSessionTitle` held against THAT day, so a chosen card
//   keeps its own name and a divergent session reads what was trained;
// - it IS that plan day (`day_number`) only when its title is that day's label;
//   otherwise it shows as itself and borrows no plan-day name.
// Every plan day is labelled by `planDayTitle` — the same label the today line uses —
// and only a title the athlete typed on their own override card is printed verbatim.
// Read-only and null-safe.
import { db } from "../db.js";
import { planDayDisplayName } from "./plan-day-name.js";
import { planDayCandidates, planDayLabel, resolveSessionPlanDay, type PlanDayCandidate } from "./plan-selection.js";
import { copyDeep, copyFlat, requestMemo } from "./request-memo.js";
import { deriveSessionTitle } from "./training-read.js";

export interface LoggedSessionDay {
  /** The plan day this session WAS (its title is that day's label); null when it shows as itself. */
  day_number: number | null;
  /** The plan day the logged work resolves to, whatever the session is called; null when none. */
  placed_day_number: number | null;
  /** The display name every surface prints for it. */
  title: string;
}

/** A plan day as a person reads it on any dated surface: its label, minus a week count. */
export function planDayTitle(day: Pick<PlanDayCandidate, "name" | "focus" | "day_number">): string {
  return planDayDisplayName(planDayLabel(day));
}

/** The current strength plan days (read once per request), or none when the plan cannot be read. */
export function sessionDayCandidates(): PlanDayCandidate[] {
  try {
    return requestMemo("session_day_candidates", () => planDayCandidates(), copyDeep);
  } catch {
    return [];
  }
}

/**
 * The one answer for a logged session, once per request (the strip, the Brief's
 * strength line and the session payload all ask about today's session). A caller
 * naming many sessions at once (a week, a list) passes `candidates` — the current plan,
 * as `sessionDayCandidates` reads it — so the plan is read once outside a request too.
 */
export function loggedSessionDay(
  sessionId: number,
  planDayId: number | null | undefined,
  candidates?: PlanDayCandidate[]
): LoggedSessionDay {
  const link = planDayId == null ? null : Number(planDayId);
  return requestMemo(
    `logged_session_day:${Number(sessionId)}:${String(link)}`,
    () => loggedSessionDayRead(Number(sessionId), link, candidates ?? sessionDayCandidates()),
    copyFlat
  );
}

function loggedSessionDayRead(
  sessionId: number,
  planDayId: number | null,
  candidates: PlanDayCandidate[]
): LoggedSessionDay {
  let day: PlanDayCandidate | null = null;
  try {
    const resolved = resolveSessionPlanDay(sessionId, planDayId, candidates);
    day = resolved ? (candidates.find((c) => c.day_number === resolved.day_number) ?? null) : null;
  } catch {
    day = null;
  }
  const label = day ? planDayLabel(day) : null;
  let raw = "";
  try {
    raw = deriveSessionTitle(sessionId, day ? day.id : null, label);
  } catch {
    raw = label ?? "";
  }
  const named = !!day && raw === label;
  // A title the athlete TYPED (their own override card) is theirs, verbatim — the same
  // rule the today strength line keeps. Every other name (a plan day's, a suggestion's)
  // reads through the display rule.
  const typed = raw && raw === athleteTypedTitle(sessionId);
  return {
    day_number: named && day ? day.day_number : null,
    placed_day_number: day ? day.day_number : null,
    title: (typed ? raw : planDayDisplayName(raw)) || "Session",
  };
}

/** The title on the session's own athlete_override card (the one deriveSessionTitle reads), else null. */
function athleteTypedTitle(sessionId: number): string | null {
  try {
    const row = db
      .prepare(
        `SELECT source, title FROM daily_session_compositions
          WHERE session_id = ?
          ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, version DESC
          LIMIT 1`
      )
      .get(sessionId) as { source?: unknown; title?: unknown } | undefined;
    return row && String(row.source ?? "") === "athlete_override" ? String(row.title ?? "").trim() || null : null;
  } catch {
    return null;
  }
}

/** The display title alone (the session lists' `title`). */
export function loggedSessionTitle(
  sessionId: number,
  planDayId: number | null | undefined,
  candidates?: PlanDayCandidate[]
): string {
  return loggedSessionDay(sessionId, planDayId, candidates).title;
}
