// TODAY'S OPEN SESSION — one server-owned answer to "is there a session on this date
// the athlete can start or continue, and what is it called".
//
// A session opened on one device used to be invisible to another until a set was
// logged (the strength line matched only sessions WITH sets), a train-anyway session
// under a rest read vanished on reload, and Train's overview meanwhile treated ANY
// session row as live — three surfaces, three answers. This is the one read: the date's
// active composition plus its session row, whatever its set count.
//
// - `started` is the one "has the athlete lived on it" test (session-started.ts), the
//   same test that locks a composition against replacement;
// - `chosen` is the athlete's own act: a session they wrote (`athlete_override`), a
//   suggestion they accepted that holds work (`agent_suggest`), a plan day they picked
//   (`manual_plan`), or an adaptive day they asked to train on a quiet read
//   (`training_by_choice` / train anyway). A plain adaptive composition the athlete
//   merely opened is not a choice;
// - `label` is the one wording every surface prints verbatim.
//
// A finished session is not open. Read-only; request-memoized.
import { db } from "../db.js";
import type { DailySessionSource } from "./adaptive-session.js";
import { planDayDisplayName } from "./plan-day-name.js";
import { copyFlat, requestMemo } from "./request-memo.js";
import { loggedSessionTitle, planDayTitle, sessionDayCandidates } from "./session-day.js";
import { sessionStarted } from "./session-started.js";
import { localDateISO } from "./shared.js";

export type OpenSessionAction = "start" | "continue";

export interface OpenSession {
  daily_session_id: number;
  session_id: number;
  source: DailySessionSource;
  plan_day_id: number | null;
  /** The session's display name — a typed title verbatim, a plan day by its name. */
  title: string;
  set_count: number;
  /** The athlete has lived on it: logged sets, a duration, notes, feedback or a linked activity. */
  started: boolean;
  /** The athlete picked it (see the module header); a chosen session is never "rest suggested". */
  chosen: boolean;
  action: OpenSessionAction;
  /** "Start <title>" / "Continue <title>" — printed verbatim. */
  label: string;
}

/** The session that owns a date, carried on a daily-session conflict so a client can open it. */
export interface DailySessionOwner {
  daily_session_id: number | null;
  session_id: number;
  source: DailySessionSource | null;
  title: string;
  set_count: number;
  started: boolean;
}

const SOURCES: ReadonlySet<string> = new Set(["adaptive_plan", "agent_suggest", "manual_plan", "athlete_override"]);
// The empty "Open session" override's stored placeholder (adaptive-session.ts
// normalizeSessionPayload): a door, not a name, so its label says "your session".
const PLACEHOLDER_TITLE = /^open session$/i;

function parse(value: unknown): unknown {
  try {
    return JSON.parse(String(value ?? "null"));
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function itemCount(row: any): number {
  const items = parse(row?.items_json);
  return Array.isArray(items) ? items.length : 0;
}

/** Whether the composition row is the athlete's own choice for the date. */
export function compositionChosen(row: any): boolean {
  const source = String(row?.source ?? "");
  if (source === "athlete_override" || source === "manual_plan") return true;
  if (source === "agent_suggest") return itemCount(row) > 0;
  if (source !== "adaptive_plan") return false;
  const provenance = record(parse(row?.provenance_json));
  const constraints = record(parse(row?.constraints_json));
  return (
    provenance.choice === "training_by_choice" ||
    constraints.train_anyway === true ||
    record(provenance.daily_decision).train_anyway === true
  );
}

/** An agent_suggest / athlete_override composition that holds work: the athlete's chosen card. */
export function compositionIsItemfulChoice(row: any): boolean {
  const source = String(row?.source ?? "");
  return (source === "athlete_override" || source === "agent_suggest") && itemCount(row) > 0;
}

// The name a person reads — the line's own naming rule: a typed title prints as typed,
// a suggestion's reads through the display rule, a plan snapshot is its plan day's NAME
// (never the focus sentence).
function compositionTitle(row: any): string {
  const source = String(row?.source ?? "");
  const stored = String(row?.title ?? "").trim();
  if (source === "athlete_override" && stored) return stored;
  if (source === "agent_suggest" && stored) return planDayDisplayName(stored);
  if (row?.plan_day_id != null) {
    const day = sessionDayCandidates().find((c) => Number(c.id) === Number(row.plan_day_id));
    if (day) return planDayTitle(day);
  }
  return stored ? planDayDisplayName(stored) : "Today's session";
}

function labelFor(action: OpenSessionAction, title: string): string {
  const verb = action === "continue" ? "Continue" : "Start";
  return PLACEHOLDER_TITLE.test(title) ? `${verb} your session` : `${verb} ${title}`;
}

function activeComposition(date: string): any {
  return db
    .prepare(
      `SELECT id, session_id, source, plan_day_id, title, items_json, constraints_json, provenance_json
         FROM daily_session_compositions
        WHERE date = ? AND status = 'active' ORDER BY version DESC LIMIT 1`
    )
    .get(date);
}

function sessionRow(sessionId: number): any {
  return db
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM logged_sets l WHERE l.session_id = s.id) AS set_count
         FROM sessions s WHERE s.id = ?`
    )
    .get(sessionId);
}

/**
 * The owner summary for a session row (with its `set_count`) and the composition that
 * owns it, if any. A session with no composition (a legacy or watch-logged day) is named
 * by the logged-session resolver.
 */
export function dailySessionOwnerOf(row: any | null, session: any | null): DailySessionOwner | null {
  const sessionId = Number(session?.id ?? row?.session_id);
  if (!Number.isInteger(sessionId) || sessionId <= 0) return null;
  const source = SOURCES.has(String(row?.source ?? "")) ? (String(row.source) as DailySessionSource) : null;
  let title = "";
  if (row) title = compositionTitle(row);
  else {
    try {
      title = loggedSessionTitle(sessionId, session?.plan_day_id ?? null);
    } catch {
      title = "";
    }
  }
  return {
    daily_session_id: row?.id != null ? Number(row.id) : null,
    session_id: sessionId,
    source,
    title: title || "Today's session",
    set_count: Number(session?.set_count ?? 0),
    started: session ? sessionStarted(session) : false,
  };
}

/**
 * The owner of `date` for a conflict body: the active composition and its session, or —
 * when the session that blocks is not the composition's — that session on its own.
 */
export function dailySessionOwner(date: string, sessionId?: number | null): DailySessionOwner | null {
  try {
    const row = activeComposition(date);
    const wanted = sessionId != null ? Number(sessionId) : row ? Number(row.session_id) : null;
    if (wanted == null) return null;
    const session = sessionRow(wanted);
    const owns = !!row && Number(row.session_id) === wanted;
    return dailySessionOwnerOf(owns ? row : null, session ?? null);
  } catch {
    return null;
  }
}

function openSessionRead(date: string): OpenSession | null {
  const row = activeComposition(date);
  if (!row) return null;
  const session = sessionRow(Number(row.session_id));
  if (!session || String(session.date ?? "") !== date || session.finished_at) return null;
  const owner = dailySessionOwnerOf(row, session);
  if (!owner || owner.daily_session_id == null || owner.source == null) return null;
  const action: OpenSessionAction = owner.started ? "continue" : "start";
  return {
    daily_session_id: owner.daily_session_id,
    session_id: owner.session_id,
    source: owner.source,
    plan_day_id: row.plan_day_id == null ? null : Number(row.plan_day_id),
    title: owner.title,
    set_count: owner.set_count,
    started: owner.started,
    chosen: compositionChosen(row),
    action,
    label: labelFor(action, owner.title),
  };
}

/**
 * The date's open session — its active composition and unfinished session row,
 * whatever its set count — or null when the date has none (nothing prepared, or the
 * session is finished). Every surface that offers Start/Continue reads this.
 */
export function openSessionOn(date?: string): OpenSession | null {
  const d = String(date || localDateISO()).slice(0, 10);
  return requestMemo(
    `open_session:${d}`,
    () => {
      try {
        return openSessionRead(d);
      } catch {
        return null;
      }
    },
    copyFlat
  );
}
