/**
 * TODAY'S SESSION FROM CHAT. Until this existed the chat coach had no door to the day's
 * own session: a request for "a full upper body today" could only land as a plan_update
 * (a template edit) or as prose, and "let's start today's session" wrote nothing at all.
 * The REST and MCP surfaces already had the door — `prepareDailySession` — so chat now
 * walks through the SAME use case:
 *
 *   - `today_session` is the athlete's own session for today: an `athlete_override`
 *     composition (Today already treats one as the chosen session that owns the day),
 *     bound to the plan day today's ring selects so the week still credits it, and never
 *     a write to the weekly template. A day with logged sets is refused, honestly.
 *   - `start_session` opens what today already owns (the assertion path, no rewrite) or
 *     prepares the plan's adaptive day — with train_anyway on a rest/easy read, because
 *     the athlete just said they are training.
 *
 * Both answer with where to go next (`open`), which the client renders as a button.
 * A today_session that replaced a composition records ONE observe-tier, reversible
 * `session_suggestion` decision (the athlete decided; Cairn recorded) with a
 * `daily_session` rollback, so `revert_decision` puts the earlier session back while
 * the day is still unstarted.
 */
import { db } from "../../db.js";
import { DailySessionError, getActiveDailySession, previewAdaptiveDailySession } from "../../repo/adaptive-session.js";
import { recordDecision, saveBrainRollback } from "../../repo/brain-decisions.js";
import type { SupersetUnpaired } from "../../repo/composition-pairing.js";
import { compositionIsItemfulChoice, dailySessionOwner } from "../../repo/open-session.js";
import { selectedPlanDayForDate } from "../../repo/plan-selection.js";
import {
  meaningfulSessionReasons,
  SESSION_STARTED_COUNTS,
  sessionStarted,
  startedReasonsPhrase,
} from "../../repo/session-started.js";
import { localDateISO } from "../../repo/shared.js";
import { UNDO_UNAVAILABLE, UndoRefusal } from "../brain/undo-refusal.js";
import { prepareDailySessionUseCase } from "./adaptive-session-use-case.js";

/** Where the reply's button goes: today's session, by date. */
export interface SessionOpenTarget {
  kind: "session";
  date: string;
  /**
   * "Start <title>" before the athlete has lived on it, "Continue <title>" after, and
   * "Log more on <title>" once it is finished (opening it there reopens it to add more).
   */
  label: string;
}

export interface ChatSessionResult {
  ok: boolean;
  date: string;
  daily_session_id: number | null;
  session_id: number | null;
  title: string | null;
  item_count: number;
  /** The athlete has lived on today's session (session-started.ts: sets, notes, feedback, …). */
  started: boolean;
  /** Today's session is finished: shown as done, opened to add more ("Log more"), never a second session. */
  finished: boolean;
  /** The composition already owned the day and nothing was rewritten. */
  reused: boolean;
  open: SessionOpenTarget | null;
  /** today_session only: the composition this one replaced (null when none stood). */
  replaced_composition_id?: number | null;
  /**
   * today_session only: the name of the athlete's OWN chosen card it replaced (one they
   * picked or wrote in the app or another client, holding work — not one this chat
   * built), so the reply and its receipt say what Undo puts back. Absent otherwise.
   */
  replaced_title?: string | null;
  /** today_session only: the reversible ledger row (null when nothing was replaced or recording failed). */
  decision_id?: number | null;
  /** start_session only: prepared with train_anyway because the read was rest/easy. */
  train_anyway?: boolean;
  /**
   * today_session only: supersets the server took apart because a gym could not run them
   * (a group of three, a pair needing two fixed stations, a fourth pair) — those lifts run
   * as straight sets. Omitted when every pair stood.
   */
  unpaired?: SupersetUnpaired[];
  code?: string;
  error?: string;
}

export interface TodaySessionInput {
  title: string;
  why?: string | null;
  est_minutes?: number | null;
  items: ReadonlyArray<Record<string, unknown>>;
}

export interface ChatSessionContext {
  /** Athlete-local today; omitted, read now. */
  date?: string;
  chat_message_id?: number | null;
}

/** The refusal over a day with logged sets (todaySessionLockedError for any other lived-on day). */
export const TODAY_SESSION_LOCKED_ERROR =
  "Today's session already has logged sets, so it stays as it is — a new session can't replace one you've started.";
const START_NO_PLAN_ERROR = "There's no plan day to open today. Tell me what you'd like to train and I'll build it.";

/**
 * The refusal of a today_session over a day the athlete has lived on, naming what is
 * actually there: logged sets keep the original sentence; notes, feedback, a duration,
 * pain answers or a watch activity are said as themselves, never as "logged sets".
 */
export function todaySessionLockedError(reasons: readonly string[]): string {
  if (!reasons.length || reasons.includes("logged sets")) return TODAY_SESSION_LOCKED_ERROR;
  return `Today's session already has ${startedReasonsPhrase(reasons)}, so it stays as it is — a new session can't replace one you've started.`;
}

function sessionName(title: unknown): string {
  const text = typeof title === "string" ? title.replace(/\s+/g, " ").trim() : "";
  return text || "today's session";
}

export function sessionOpenTarget(date: string, title: unknown, started: boolean, finished = false): SessionOpenTarget {
  const name = sessionName(title);
  return {
    kind: "session",
    date,
    label: finished ? `Log more on ${name}` : `${started ? "Continue" : "Start"} ${name}`,
  };
}

// A date's session rows, each with the counts the one "started" test reads.
function sessionRowsOn(date: string): any[] {
  return db
    .prepare(`SELECT s.*, ${SESSION_STARTED_COUNTS} FROM sessions s WHERE s.date = ? ORDER BY s.id`)
    .all(date) as any[];
}

function sessionRowById(sessionId: unknown): any | null {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return (db.prepare(`SELECT s.*, ${SESSION_STARTED_COUNTS} FROM sessions s WHERE s.id = ?`).get(id) as any) ?? null;
}

/** What the athlete has on the date's sessions (session-started.ts), in its words; empty when nothing. */
function dayStartedReasons(date: string): string[] {
  return [...new Set(sessionRowsOn(date).flatMap((row) => meaningfulSessionReasons(row)))];
}

function dayStarted(date: string): boolean {
  return dayStartedReasons(date).length > 0;
}

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

function resultFor(
  date: string,
  composition: any,
  sessionId: unknown,
  extra: Partial<ChatSessionResult> = {}
): ChatSessionResult {
  const id = Number(sessionId ?? composition?.session_id);
  const row = Number.isInteger(id) && id > 0 ? sessionRowById(id) : null;
  const started = row ? meaningfulSessionReasons(row).length > 0 : dayStarted(date);
  const finished = row?.finished_at != null;
  const title = typeof composition?.title === "string" && composition.title.trim() ? composition.title.trim() : null;
  return {
    ok: true,
    date,
    daily_session_id: Number(composition?.id) > 0 ? Number(composition.id) : null,
    session_id: Number.isInteger(id) && id > 0 ? id : null,
    title,
    item_count: Array.isArray(composition?.items) ? composition.items.length : 0,
    started,
    finished,
    reused: false,
    open: sessionOpenTarget(date, title, started, finished),
    ...extra,
  };
}

function failure(date: string, code: string, error: string, standing: any = null): ChatSessionResult {
  // A refusal over a day that already has a session still says where that session is:
  // the athlete asked to train today, and the honest answer points at what they have.
  const base = standing ? resultFor(date, standing, standing.session_id) : null;
  return {
    ok: false,
    date,
    daily_session_id: base?.daily_session_id ?? null,
    session_id: base?.session_id ?? null,
    title: base?.title ?? null,
    item_count: base?.item_count ?? 0,
    started: base?.started ?? false,
    finished: base?.finished ?? false,
    reused: false,
    open: base?.open ?? null,
    code,
    error,
  };
}

/** The plan day today's ring selects, when today carries a lifting day at all. */
function ringDayNumber(date: string): number | null {
  try {
    const selected = selectedPlanDayForDate(date);
    const day = Number(selected?.day_number);
    return selected && selected.day_type !== "rest" && Number.isInteger(day) && day > 0 ? day : null;
  } catch {
    return null;
  }
}

interface DailySessionRollback {
  version: 1;
  date: string;
  applied_composition_id: number;
  previous_composition_id: number | null;
  /**
   * The skips and finish stamp the replace cleared from the shared session row (a replace
   * opens the new card clean — adaptive-session.ts). Undo puts them back with the earlier
   * card. Absent on rollbacks recorded before 2026-11-12: those restore the card alone.
   */
  previous_skips?: string[];
  previous_finished_at?: string | null;
}

function recordTodaySessionDecision(input: {
  date: string;
  title: string | null;
  appliedId: number;
  previousId: number | null;
  previousTitle: string | null;
  previousSkips: string[];
  previousFinishedAt: string | null;
  chatMessageId: number | null;
}): number | null {
  const title = `Today's session set to ${sessionName(input.title)}`;
  try {
    const { decision } = recordDecision({
      effective_date: input.date,
      kind: "session_suggestion",
      domain: "training",
      summary: title,
      rationale: "Your ask, recorded as said. Today serves this session; the weekly plan is unchanged.",
      source: "chat",
      source_ref_type: null,
      source_ref_key: null,
      status: "applied",
      autonomy_tier: "observe",
      risk_class: "low",
      reversible: true,
      input_fingerprint: null,
      context: {
        stated_by_athlete: true,
        stated_kind: "today_session",
        entry: "chat_request",
        chat_message_id: input.chatMessageId,
      },
      action: {
        kind: "today_session",
        title,
        user_explanation: input.previousTitle
          ? `Undo puts back ${input.previousTitle}, the session Today had before, while nothing is logged on this one.`
          : input.previousId
            ? "Undo puts back the session Today had before, while nothing is logged on it."
            : "Undo hands today back to the plan's own session, while nothing is logged on it.",
        date: input.date,
        composition_id: input.appliedId,
        superseded_composition_id: input.previousId,
      },
      specialist: null,
      applied_at: new Date().toISOString(),
      reverted_at: null,
      superseded_by: null,
      evaluator_version: null,
    });
    if (!decision.id) return null;
    const rollback: DailySessionRollback = {
      version: 1,
      date: input.date,
      applied_composition_id: input.appliedId,
      previous_composition_id: input.previousId,
      previous_skips: input.previousSkips,
      previous_finished_at: input.previousFinishedAt,
    };
    saveBrainRollback(decision.id, "daily_session", rollback);
    return decision.id;
  } catch {
    // The session is already Today's; a missing Undo is the only cost of a failed record.
    return null;
  }
}

/** Apply a chat `today_session`: today's own athlete-authored composition, never a template write. */
export function applyChatTodaySession(input: TodaySessionInput, ctx: ChatSessionContext = {}): ChatSessionResult {
  const date = ctx.date ?? localDateISO();
  const before = getActiveDailySession(date) as any;
  // What the replace will clear from the shared session row, kept for the Undo, and the
  // name of the athlete's own chosen card when one stands (not a card this chat built):
  // they asked, so it is replaced — and the reply says which card Undo puts back.
  const beforeSession = before ? sessionRowById(before.session_id) : null;
  const previousSkips = beforeSession
    ? (
        db.prepare(`SELECT exercise FROM session_skips WHERE session_id = ? ORDER BY id`).all(beforeSession.id) as any[]
      ).map((row) => String(row.exercise))
    : [];
  const previousFinishedAt = beforeSession?.finished_at != null ? String(beforeSession.finished_at) : null;
  const beforeChosen =
    before &&
    compositionIsItemfulChoice({ ...before, items_json: JSON.stringify(before.items ?? []) }) &&
    (before.provenance as { entry?: unknown } | null)?.entry !== "chat_request";
  const previousTitle = beforeChosen ? (dailySessionOwner(date)?.title ?? null) : null;
  const dayNumber = ringDayNumber(date);
  let prepared: ReturnType<typeof prepareDailySessionUseCase>;
  try {
    prepared = prepareDailySessionUseCase({
      date,
      source: "athlete_override",
      replace: true,
      ...(dayNumber != null ? { day_number: dayNumber } : {}),
      session: {
        title: input.title,
        why: input.why ?? null,
        ...(input.est_minutes != null ? { est_minutes: input.est_minutes } : {}),
        items: input.items.map((item) => ({ ...item })),
      },
      provenance: { entry: "chat_request", chat_message_id: ctx.chat_message_id ?? null },
    });
  } catch (error) {
    const code = errorCode(error);
    if (code === "daily_session_locked") {
      // The refusal still points at the session that holds the logged work — a composition,
      // or (`before` null) a session logged outside one, named by the conflict's owner.
      const owner = (error as { owner?: { session_id?: unknown; title?: unknown } } | null)?.owner;
      const standing = before ?? (owner?.session_id ? { session_id: owner.session_id, title: owner.title } : null);
      return failure(date, code, todaySessionLockedError(dayStartedReasons(date)), standing);
    }
    const message = error instanceof Error ? error.message : String(error);
    return failure(date, code ?? "daily_session_invalid", message);
  }
  const composition = prepared.daily_session as any;
  const appliedId = Number(composition?.id);
  const previousId = Number(before?.id) > 0 && Number(before.id) !== appliedId ? Number(before.id) : null;
  const decisionId =
    prepared.reused === true || !(appliedId > 0)
      ? null
      : recordTodaySessionDecision({
          date,
          title: composition?.title ?? input.title,
          appliedId,
          previousId,
          previousTitle: previousId ? previousTitle : null,
          previousSkips: previousId ? previousSkips : [],
          previousFinishedAt: previousId ? previousFinishedAt : null,
          chatMessageId: ctx.chat_message_id ?? null,
        });
  const unpaired = (prepared as { unpaired?: SupersetUnpaired[] }).unpaired;
  const replacedChosen = prepared.reused !== true && previousId != null && previousTitle ? previousTitle : null;
  return resultFor(date, composition, prepared.session?.id ?? composition?.session_id, {
    reused: prepared.reused === true,
    replaced_composition_id: prepared.reused === true ? null : previousId,
    ...(replacedChosen ? { replaced_title: replacedChosen } : {}),
    decision_id: decisionId,
    ...(unpaired?.length ? { unpaired } : {}),
  });
}

/**
 * Apply a chat `start_session`: open what today owns, else prepare the plan's day. A day
 * that has a session never answers with a failure: the composition that owns it comes
 * back with `open`, a session logged outside any composition is adopted by the plain
 * (open) prepare, and a write that lost a race re-reads the owner that won it. Only a day
 * with no session and no plan day to open is the honest "nothing to open".
 */
export function applyChatStartSession(ctx: ChatSessionContext = {}): ChatSessionResult {
  const date = ctx.date ?? localDateISO();
  const active = getActiveDailySession(date) as any;
  try {
    if (active) {
      // The assertion path: the composition that owns the day, re-read, never rewritten.
      const asserted = prepareDailySessionUseCase({ date, expected_active_id: Number(active.id) });
      return resultFor(date, asserted.daily_session, asserted.session?.id, { reused: true });
    }
    let trainAnyway = false;
    try {
      const preview = previewAdaptiveDailySession({ date });
      trainAnyway = preview.kind === "rest" || preview.kind === "easy";
    } catch (error) {
      // No plan day to preview. The open prepare below still opens a session the day
      // already holds; with none, it answers the same absence.
      if (!(error instanceof DailySessionError && errorCode(error) === "daily_session_no_template")) throw error;
    }
    // An OPEN request (no replace): a session already on the day is adopted, never refused.
    const prepared = prepareDailySessionUseCase({
      date,
      source: "adaptive_plan",
      train_anyway: trainAnyway,
      provenance: { entry: "chat_request", chat_message_id: ctx.chat_message_id ?? null },
    });
    return resultFor(date, prepared.daily_session, prepared.session?.id, {
      reused: prepared.reused === true,
      train_anyway: trainAnyway,
    });
  } catch (error) {
    // The day's owner as it stands now (a concurrent prepare may have won the write).
    const standing = getActiveDailySession(date) as any;
    if (standing) return resultFor(date, standing, standing.session_id, { reused: true });
    const code = errorCode(error);
    if (code === "daily_session_no_template") return failure(date, code, START_NO_PLAN_ERROR);
    const message = error instanceof Error ? error.message : String(error);
    return failure(date, code ?? "daily_session_invalid", message, active);
  }
}

type UndoCheck =
  | { refusal: string }
  | { p: DailySessionRollback; appliedId: number; appliedSession: any | null; previous: any | null };

// Whether a chat today_session's Undo would be taken right now, read-only: the one test
// revertChatTodaySession acts on and the receipt's Undo button mirrors.
function todaySessionUndoCheck(payload: unknown): UndoCheck {
  const p = payload as DailySessionRollback | null;
  const appliedId = Number(p?.applied_composition_id);
  if (!p || p.version !== 1 || typeof p.date !== "string" || !(appliedId > 0)) return { refusal: UNDO_UNAVAILABLE };
  const active = db
    .prepare(`SELECT id, session_id FROM daily_session_compositions WHERE date = ? AND status = 'active'`)
    .get(p.date) as any;
  if (!active || Number(active.id) !== appliedId) {
    return { refusal: "Today's session has changed since, so it stays as it is." };
  }
  // The ONE "started" test (session-started.ts): sets, a duration, notes, feedback, pain
  // answers or a watch activity on the day are a record of work on THIS session, and
  // putting another card back under it would rewrite what that record is about.
  const reasons = dayStartedReasons(p.date);
  if (reasons.length) {
    return { refusal: `Today's session already has ${startedReasonsPhrase(reasons)}, so it stays as you have it.` };
  }
  const appliedSession = sessionRowById(active.session_id);
  if (appliedSession?.finished_at != null) {
    return { refusal: "You've finished today's session, so it stays as you have it." };
  }
  const previousId = Number(p.previous_composition_id);
  const previous =
    previousId > 0
      ? (db
          .prepare(
            `SELECT id, session_id, plan_day_id FROM daily_session_compositions
              WHERE id = ? AND date = ? AND status = 'superseded'`
          )
          .get(previousId, p.date) as any)
      : null;
  if (previousId > 0 && !previous) return { refusal: "The earlier session is gone, so today's stays as it is." };
  return { p, appliedId, appliedSession, previous };
}

/**
 * Why the Undo of a chat today_session (its `daily_session` rollback payload) would be
 * refused right now, in the athlete's words — null when revertChatTodaySession would take
 * it. Read-only; the receipt offers Undo only when this is null.
 */
export function todaySessionUndoRefusal(payload: unknown): string | null {
  const check = todaySessionUndoCheck(payload);
  return "refusal" in check ? check.refusal : null;
}

/**
 * Where today's session stands for its button (the same truth as open-session.ts): the
 * composition's session row read by the one "started" test, and its finish stamp.
 */
export function sessionOpenState(sessionId: unknown): { started: boolean; finished: boolean } {
  const row = sessionRowById(sessionId);
  return { started: row ? sessionStarted(row) : false, finished: row?.finished_at != null };
}

/**
 * Undo a chat today_session (called inside the autonomy service's revert savepoint).
 * Acts only while the composition it wrote still owns the day, nobody has lived on it
 * (session-started.ts: sets, notes, feedback, a duration, pain answers, a watch activity)
 * and it is not finished: the earlier composition comes back as it was, with the skips
 * and finish stamp the replace cleared (or, when none stood, the day goes back to the
 * plan's own session). A newer, started or finished session stands, said in words.
 */
export function revertChatTodaySession(payload: unknown): void {
  const check = todaySessionUndoCheck(payload);
  if ("refusal" in check) throw new UndoRefusal(check.refusal);
  const { p, appliedId, appliedSession, previous } = check;
  db.prepare(
    `UPDATE daily_session_compositions SET status = 'superseded', superseded_at = datetime('now')
      WHERE id = ? AND status = 'active'`
  ).run(appliedId);
  // Skips made on the chat card belong to that card, never to the one coming back.
  if (appliedSession) db.prepare(`DELETE FROM session_skips WHERE session_id = ?`).run(appliedSession.id);
  if (previous) {
    db.prepare(
      `UPDATE daily_session_compositions SET status = 'active', superseded_at = NULL WHERE id = ? AND status = 'superseded'`
    ).run(previous.id);
    db.prepare(`UPDATE sessions SET plan_day_id = ? WHERE id = ?`).run(
      previous.plan_day_id ?? null,
      previous.session_id
    );
    // The earlier card comes back as the athlete left it: the skips (and a finish stamp
    // on a day they walked away from) the replace cleared off the shared session row.
    const skips = Array.isArray(p.previous_skips)
      ? p.previous_skips.filter((s) => typeof s === "string" && s.trim())
      : [];
    const insertSkip = db.prepare(`INSERT OR IGNORE INTO session_skips (session_id, exercise) VALUES (?, ?)`);
    for (const exercise of skips) insertSkip.run(previous.session_id, exercise);
    if (typeof p.previous_finished_at === "string" && p.previous_finished_at) {
      db.prepare(`UPDATE sessions SET finished_at = ? WHERE id = ? AND finished_at IS NULL`).run(
        p.previous_finished_at,
        previous.session_id
      );
    }
  }
}

/** Today's (or a date's) composed session as Today serves it — the read the coach checks. */
export function todaySessionRead(date: string = localDateISO()) {
  const composition = getActiveDailySession(date) as any;
  if (!composition) {
    return { date, found: false, started: dayStarted(date), session: null };
  }
  const started = dayStarted(date);
  return {
    date,
    found: true,
    started,
    session: {
      daily_session_id: Number(composition.id),
      session_id: Number(composition.session_id),
      source: composition.source,
      title: composition.title ?? null,
      focus: composition.focus ?? null,
      why: composition.why ?? null,
      est_minutes: composition.est_minutes ?? null,
      items: (Array.isArray(composition.items) ? composition.items : []).map((item: any) => ({
        exercise: item?.exercise ?? null,
        kind: item?.kind ?? null,
        sets: item?.sets ?? null,
        rep_low: item?.rep_low ?? null,
        rep_high: item?.rep_high ?? null,
        target_weight: item?.target_weight ?? null,
        target_seconds: item?.target_seconds ?? null,
        mode: item?.mode ?? null,
        superset_group: item?.superset_group ?? null,
        note: item?.note ?? null,
      })),
    },
  };
}
