// ---------- the change receipt: one uniform line for a change the server made ----------
// src/contracts/change-receipt.ts holds the shape. This module builds it from the two
// records a change can leave — a `brain_decisions` row (every coaching change the
// autonomy policy landed or announced) and a `plan_adaptations` row (a lift adapted for
// the race until a date) — and re-reads a STORED receipt against the live ledger, so a
// chat message that said "applied" on Tuesday reads "undone" once the athlete pressed Undo.
//
// It invents nothing: status and Undo mirror exactly what `revertDecision`
// (src/domain/brain/autonomy-service.ts) will accept right now — an announced change is
// held, an applied one is restored while it is reversible AND its snapshot exists. The
// state's words are the Changes feed's own (src/repo/change-status-words.ts): a change
// still to land "Lands Thursday", never "Waiting on you" — nobody is waiting on an answer. The
// `what` a surface already titled (the Changes feed's own title) is passed in; without
// one, an adaptation's own words, then the decision's summary.
//
// Read-only over plan_adaptations: that module (plan-adaptations.ts) is the writer, and the
// rows are read here with their own tiny projection rather than adding a helper there.
import { db } from "../db.js";
import type { BrainDecision } from "../brain/decision-contract.js";
import type {
  ChangeReceipt,
  ChangeReceiptOpen,
  ChangeReceiptStatus,
  ChangeReceiptUndo,
} from "../contracts/change-receipt.js";
import { getBrainDecision, getBrainRollback } from "./brain-decisions.js";
import {
  adaptationDateWords,
  adaptationIsForRace,
  adaptedUntilWords,
  planAdaptationTitle,
} from "./plan-adaptations.js";
import { changeLandsWords, changeStatusLine } from "./change-status-words.js";
import { clipText, localDateISO, localDayOfStamp } from "./shared.js";
import { isoDate } from "../lib/dates.js";
import { sessionOpenState, sessionOpenTarget, todaySessionUndoRefusal } from "../domain/training/chat-today-session.js";

const WHAT_MAX = 160;

// A real YYYY-MM-DD off a stored day or stamp, else null (src/lib/dates.ts validates).
function dayKeyOf(value: unknown): string | null {
  return isoDate(String(value ?? "").slice(0, 10));
}

/** "Ends after the race (Nov 1)" / "Ends after Nov 1". */
export function receiptUntilWords(until: string, forRace: boolean): string {
  const date = adaptationDateWords(until);
  return forRace ? `Ends after the race (${date})` : `Ends after ${date}`;
}

// ---------- from a brain_decisions row ----------

/** Where a decision stands; null = not a change that landed, is landing, or was put back. */
export function decisionReceiptStatus(
  decision: Pick<BrainDecision, "status" | "applied_at">
): ChangeReceiptStatus | null {
  switch (decision.status) {
    case "applied":
      return "applied";
    // A change a newer one replaced after it landed still happened; only its Undo is gone.
    case "superseded":
      return decision.applied_at ? "applied" : null;
    case "announced":
    case "pending":
      return "scheduled";
    case "reverted":
    case "canceled":
      return "undone";
    default:
      return null;
  }
}

/** The Undo `revertDecision` would take right now, else null. */
export function decisionReceiptUndo(decision: BrainDecision): ChangeReceiptUndo | null {
  if (decision.id == null) return null;
  if (decision.status === "announced") return { kind: "brain_decision", id: decision.id };
  if (decision.status !== "applied" || !decision.reversible) return null;
  let rollback: unknown = null;
  try {
    rollback = getBrainRollback(decision.id);
  } catch {
    rollback = null;
  }
  return rollback ? { kind: "brain_decision", id: decision.id } : null;
}

// The adaptations a decision made, read-only (plan-adaptations.ts owns the writes).
function adaptationUntilsForDecision(decisionId: number): string[] {
  try {
    const rows = db
      .prepare(`SELECT until_date FROM plan_adaptations WHERE decision_id = ? AND status IN ('active', 'asked')`)
      .all(decisionId) as Array<{ until_date: unknown }>;
    return rows.map((row) => dayKeyOf(row.until_date)).filter((day): day is string => !!day);
  } catch {
    return [];
  }
}

// A scoped change's end: the race adaptation's own `until`, else the latest end of the
// adaptations it left, else a dated push stance (`action.until`).
function decisionUntil(decision: BrainDecision): { until: string; forRace: boolean } | null {
  const action = (decision.action ?? {}) as Record<string, any>;
  const scope = action.plan_adaptation;
  const scoped = dayKeyOf(scope?.until);
  // The apply stamped whether it was for the race (a trip layer never is): that word wins.
  if (scoped) {
    return { until: scoped, forRace: typeof scope?.for_race === "boolean" ? scope.for_race : adaptationIsForRace(scoped) };
  }
  if (decision.id != null) {
    const ends = adaptationUntilsForDecision(decision.id).sort();
    const last = ends.at(-1);
    if (last) return { until: last, forRace: adaptationIsForRace(last) };
  }
  const stance = dayKeyOf(action.until);
  if (stance && action.training_drive === "push") return { until: stance, forRace: false };
  return null;
}

/** The receipt's state in the feed's words; null while it is simply applied. */
function decisionStatusWords(decision: BrainDecision, status: ChangeReceiptStatus, asOf: string): string | null {
  if (status === "scheduled") return changeLandsWords(dayKeyOf(decision.effective_date), asOf);
  if (status === "undone") return changeStatusLine(decision.status === "reverted" ? "reverted" : "held", asOf, null, asOf);
  if (status === "not_landed") return NOT_LANDED_WORDS;
  return null;
}

/** A stored receipt whose change was refused or held for a look after it was said. */
const NOT_LANDED_WORDS = "Didn't land";

function decisionWhen(decision: BrainDecision): string | null {
  return (
    dayKeyOf(decision.effective_date) ??
    (decision.applied_at ? localDayOfStamp(decision.applied_at) : null) ??
    (decision.created_at ? localDayOfStamp(decision.created_at) : null)
  );
}

/**
 * The receipt for one ledger decision, or null when the row is not a change that landed,
 * waits to land, or was put back (an observation, a review hold, a refusal).
 * `what` / `when` are the calling surface's own finished words when it has them (the
 * Changes feed's title and open day); otherwise the adaptation title, then the summary.
 */
export function receiptFromBrainDecision(
  decision: BrainDecision | null | undefined,
  opts: { what?: string | null; when?: string | null; asOf?: string } = {}
): ChangeReceipt | null {
  if (!decision || decision.id == null) return null;
  const status = decisionReceiptStatus(decision);
  if (!status) return null;
  const what =
    String(opts.what ?? "").trim() ||
    planAdaptationTitle(decision.action) ||
    clipText(String(decision.summary ?? "").trim(), WHAT_MAX);
  if (!what) return null;
  const scope = decisionUntil(decision);
  return {
    key: `decision:${decision.id}`,
    what,
    when: dayKeyOf(opts.when) ?? decisionWhen(decision),
    until: scope?.until ?? null,
    until_words: scope ? receiptUntilWords(scope.until, scope.forRace) : null,
    undo: decisionReceiptUndo(decision),
    status,
    status_words: decisionStatusWords(decision, status, dayKeyOf(opts.asOf) ?? localDateISO()),
  };
}

// ---------- from a plan_adaptations row ----------

interface AdaptationRow {
  id: number;
  decision_id: number | null;
  restore_decision_id: number | null;
  exercise: string;
  before_exercise: string | null;
  kind: string;
  until_date: string;
  status: string;
  layer: string | null;
  created_at: string | null;
}

function adaptationRow(raw: any): AdaptationRow | null {
  if (!raw) return null;
  let before: string | null = null;
  try {
    const parsed = raw.before_json ? JSON.parse(String(raw.before_json)) : null;
    before = typeof parsed?.exercise === "string" && parsed.exercise.trim() ? parsed.exercise.trim() : null;
  } catch {
    before = null;
  }
  return {
    id: Number(raw.id),
    decision_id: raw.decision_id == null ? null : Number(raw.decision_id),
    restore_decision_id: raw.restore_decision_id == null ? null : Number(raw.restore_decision_id),
    exercise: String(raw.exercise ?? "").trim(),
    before_exercise: before,
    kind: String(raw.kind ?? ""),
    until_date: String(raw.until_date ?? ""),
    status: String(raw.status ?? ""),
    layer: raw.layer == null ? null : String(raw.layer),
    created_at: raw.created_at == null ? null : String(raw.created_at),
  };
}

function readAdaptation(id: number): AdaptationRow | null {
  try {
    return adaptationRow(db.prepare(`SELECT * FROM plan_adaptations WHERE id = ?`).get(id));
  } catch {
    return null;
  }
}

function adaptationWhat(row: AdaptationRow, forRace: boolean): string {
  const words = adaptedUntilWords(row.until_date, forRace);
  if (row.kind === "swapped" && row.before_exercise && row.before_exercise !== row.exercise) {
    return `${row.exercise} in place of ${row.before_exercise}, ${words}`;
  }
  return `${row.exercise || "Your plan"} ${words}`;
}

// In force: `active`, `asked` (a return waiting on the athlete's yes keeps it in force)
// and `kept` (an asked return settled to keeping the change — it stays).
const IN_FORCE = new Set(["active", "asked", "kept"]);

/**
 * The receipt for one adaptation row. In force reads `applied`; ended any way reads
 * `undone` — "Put back" when its change was undone, "Ended" when it ran its course or the
 * plan moved past it. Its Undo is the Undo of the decision that made it, while that
 * decision still takes one. A trip layer is never "for the race".
 */
export function receiptFromPlanAdaptation(
  input: number | Record<string, unknown> | null | undefined
): ChangeReceipt | null {
  const row = typeof input === "number" ? readAdaptation(input) : adaptationRow(input);
  if (!row || !Number.isFinite(row.id) || !dayKeyOf(row.until_date)) return null;
  const forRace = !row.layer && adaptationIsForRace(row.until_date);
  const inForce = IN_FORCE.has(row.status);
  let undo: ChangeReceiptUndo | null = null;
  if (inForce && row.decision_id != null) {
    try {
      const decision = getBrainDecision(row.decision_id);
      undo = decision ? decisionReceiptUndo(decision) : null;
    } catch {
      undo = null;
    }
  }
  return {
    key: `adaptation:${row.id}`,
    what: adaptationWhat(row, forRace),
    when: row.created_at ? localDayOfStamp(row.created_at) : null,
    until: row.until_date,
    until_words: receiptUntilWords(row.until_date, forRace),
    undo,
    status: inForce ? "applied" : "undone",
    status_words: inForce ? null : row.status === "cancelled" ? "Put back" : "Ended",
  };
}

// ---------- a session a chat turn built or opened ----------
// Not a coaching change the team made: the athlete asked for today's session and chat
// built it (today_session) or opened it (start_session). The receipt's job is the way
// in — `open`, the button — plus the Undo of a session that replaced another, offered
// only while that Undo would be taken: the SAME test revertChatTodaySession acts on
// (todaySessionUndoRefusal — the composition still owns the day, nobody has lived on it
// by the one "started" test of session-started.ts, and it is not finished). The button
// reads the same started/finished truth: "Start <title>", "Continue <title>", and
// "Log more on <title>" once the day is finished (the chat result's own sessionOpenTarget).

/** The receipt for one daily-session composition, as it stands now; null when it is gone. */
export function receiptFromDailySession(
  compositionId: number,
  opts: { decisionId?: number | null; what?: string | null } = {}
): ChangeReceipt | null {
  const row = db
    .prepare(`SELECT id, date, title, status, session_id FROM daily_session_compositions WHERE id = ?`)
    .get(compositionId) as any;
  if (!row) return null;
  const date = dayKeyOf(row.date);
  const title = clipText(String(row.title ?? "").replace(/\s+/g, " ").trim(), WHAT_MAX - 20) || "today's session";
  const active = row.status === "active";
  const decisionId = Number(opts.decisionId);
  const decision = Number.isSafeInteger(decisionId) && decisionId > 0 ? getBrainDecision(decisionId) : null;
  const rollback =
    active && decision?.status === "applied" && decision.reversible === true ? getBrainRollback(decisionId) : null;
  const undoable =
    rollback?.kind === "daily_session" &&
    Number(rollback.payload?.applied_composition_id) === Number(row.id) &&
    todaySessionUndoRefusal(rollback.payload) == null;
  return {
    key: `session:${row.id}`,
    what: clipText(opts.what?.trim() || `Today's session: ${title}`, WHAT_MAX),
    when: date,
    until: null,
    until_words: null,
    undo: undoable ? { kind: "brain_decision", id: decisionId } : null,
    status: active ? "applied" : "undone",
    status_words: active ? null : decision?.status === "reverted" ? "Put back" : "Replaced",
    open: active && date ? sessionOpenButton(date, row.title, row.session_id) : null,
  };
}

// The button over the composition's session row as it stands now.
function sessionOpenButton(date: string, title: unknown, sessionId: unknown): ChangeReceiptOpen {
  const { started, finished } = sessionOpenState(sessionId);
  return sessionOpenTarget(date, title, started, finished);
}

// ---------- a stored receipt, read again ----------

function storedReceipt(raw: unknown): ChangeReceipt | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const key = typeof r.key === "string" ? r.key : "";
  const what = typeof r.what === "string" ? r.what.trim() : "";
  // "waiting" is the name a scheduled change was stored under before it was renamed.
  const status: ChangeReceiptStatus | null =
    r.status === "applied" || r.status === "scheduled" || r.status === "undone" || r.status === "not_landed"
      ? r.status
      : r.status === "waiting"
        ? "scheduled"
        : null;
  if (!key || !what || !status) return null;
  return {
    key,
    what,
    when: dayKeyOf(r.when),
    until: dayKeyOf(r.until),
    until_words: typeof r.until_words === "string" && r.until_words.trim() ? r.until_words.trim() : null,
    undo: null,
    status,
    status_words: typeof r.status_words === "string" && r.status_words.trim() ? r.status_words.trim() : null,
  };
}

/**
 * Stored receipts re-read against the ledger: the words stay as they were said, the
 * status and the Undo are the ledger's NOW. A decision that since moved somewhere no
 * receipt stands for (refused, observed, held for a look after a failed boundary) reads
 * `not_landed` — never the stale "applied" it was said as. A receipt whose record is gone
 * keeps its words and loses its Undo. Malformed entries are dropped.
 */
export function refreshChangeReceipts(raw: unknown, asOf: string = localDateISO()): ChangeReceipt[] {
  if (!Array.isArray(raw)) return [];
  const out: ChangeReceipt[] = [];
  for (const entry of raw) {
    const stored = storedReceipt(entry);
    if (!stored) continue;
    const [kind, idText] = stored.key.split(":");
    const id = Number(idText);
    let live: ChangeReceipt | null = null;
    try {
      if (kind === "decision" && Number.isSafeInteger(id) && id > 0) {
        const decision = getBrainDecision(id);
        live = receiptFromBrainDecision(decision, { what: stored.what, when: stored.when, asOf });
        if (!live && decision) {
          live = { ...stored, undo: null, status: "not_landed", status_words: NOT_LANDED_WORDS };
        }
      } else if (kind === "adaptation" && Number.isSafeInteger(id) && id > 0) {
        live = receiptFromPlanAdaptation(id);
      } else if (kind === "session" && Number.isSafeInteger(id) && id > 0) {
        // The Undo it was said with names the decision; whether it still stands is the
        // ledger's and the day's answer now, and so is the way in.
        const storedUndo = (entry as { undo?: { kind?: unknown; id?: unknown } | null })?.undo;
        const undoId = storedUndo?.kind === "brain_decision" ? Number(storedUndo.id) : null;
        const session = receiptFromDailySession(id, { decisionId: undoId, what: stored.what });
        if (session) {
          out.push(session);
          continue;
        }
      }
    } catch {
      live = null;
    }
    out.push(
      live
        ? {
            ...stored,
            status: live.status,
            status_words: live.status_words ?? null,
            undo: live.undo ?? null,
            until: stored.until ?? live.until ?? null,
            until_words: stored.until_words ?? live.until_words ?? null,
          }
        : stored
    );
  }
  return out;
}

/**
 * A chat message as the client receives it: `receipts` lifted out of the stored meta and
 * re-read against the ledger. Any message without receipts passes through untouched.
 */
export function withChangeReceipts<T>(message: T): T {
  if (!message || typeof message !== "object") return message;
  const meta = (message as any).meta;
  if (!meta || !Array.isArray(meta.receipts)) return message;
  return { ...(message as any), receipts: refreshChangeReceipts(meta.receipts) } as T;
}

// ---------- the ledger window a synchronous write ran in ----------

/** The highest decision id so far — taken before a synchronous batch of writes. */
export function brainDecisionIdFloor(): number {
  try {
    const row = db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM brain_decisions`).get() as any;
    return Number(row?.id ?? 0) || 0;
  } catch {
    return 0;
  }
}

/** Decisions written after `floor`, oldest first. */
export function brainDecisionIdsAfter(floor: number): number[] {
  try {
    return (db.prepare(`SELECT id FROM brain_decisions WHERE id > ? ORDER BY id`).all(floor) as any[])
      .map((row) => Number(row.id))
      .filter((id) => Number.isSafeInteger(id) && id > 0);
  } catch {
    return [];
  }
}
