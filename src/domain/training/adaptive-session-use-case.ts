import {
  DAILY_SESSION_NO_TEMPLATE,
  DailySessionError,
  discardDailySession,
  prepareDailySession,
  type DiscardDailySessionInput,
  previewAdaptiveDailySession,
  type PrepareDailySessionInput,
} from "../../repo/adaptive-session.js";
import { getSessionDetail } from "../../repo/sessions.js";

function dailySessionErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/**
 * "There is nothing to preview for this date" — a routine absence the read surfaces
 * answer with `200 + null`, never a 400. Everything else that escapes the preview seam
 * IS malformed input (a bad date or constraint).
 */
export function isDailySessionAbsence(error: unknown): boolean {
  return dailySessionErrorCode(error) === DAILY_SESSION_NO_TEMPLATE;
}

/**
 * The state-CONFLICT class: the request was well-formed, but the durable daily session
 * it assumed is gone, has moved on, or has already been trained against. All of them are
 * the same "your copy is stale, re-read and retry" answer the PWA already handles, so
 * they share one status instead of being split between a conflict and a bad request.
 */
const DAILY_SESSION_CONFLICT_CODES = new Set([
  "daily_session_preview_stale",
  "daily_session_active_changed",
  "daily_session_missing",
  "daily_session_changed",
  "daily_session_locked",
]);

export function isDailySessionConflict(error: unknown): boolean {
  const code = dailySessionErrorCode(error);
  return code != null && DAILY_SESSION_CONFLICT_CODES.has(code);
}

export function prepareDailySessionUseCase(input: PrepareDailySessionInput = {}) {
  const prepared = prepareDailySession(input);
  const session = getSessionDetail(Number(prepared.session_id));
  if (!session) throw new DailySessionError("daily_session_session_missing", "prepared workout session was not found");
  const { session_id: _sessionId, ...result } = prepared;
  return { ...result, session };
}

export function previewAdaptiveDailySessionUseCase(
  input: Pick<PrepareDailySessionInput, "date" | "constraints" | "provenance" | "train_anyway"> = {}
) {
  return previewAdaptiveDailySession(input);
}

/**
 * Discard an accidental empty session for a date (repo `discardDailySession`): the
 * date is free again. A started session is refused as a `daily_session_locked`
 * conflict carrying its owner.
 */
export function discardDailySessionUseCase(input: DiscardDailySessionInput = {}) {
  return discardDailySession(input);
}

/**
 * The one error body REST and MCP both answer with. `code` is the daily-session code
 * only for a coded refusal (`DailySessionError`); anything else that escapes these paths
 * is a validation failure of the request (a bad date, source, plan day or payload) and
 * reads `daily_session_invalid` — a foreign `code` (a driver's, say) never leaks out as
 * if it were part of this contract, and neither does its message.
 */
const DAILY_SESSION_UNEXPECTED_ERROR = "This session couldn't be saved just now. Try again in a moment.";

export function dailySessionErrorBody(error: unknown) {
  const value = error as { code?: unknown; message?: unknown; preview?: unknown; owner?: unknown };
  const foreign = !(error instanceof DailySessionError) && value?.code != null;
  return {
    ok: false as const,
    code: error instanceof DailySessionError ? error.code : "daily_session_invalid",
    error: foreign
      ? DAILY_SESSION_UNEXPECTED_ERROR
      : typeof value?.message === "string"
        ? value.message
        : String(error),
    ...(value?.preview ? { preview: value.preview } : {}),
    // The session that owns the date, on a conflict the client resolves by opening it.
    ...(value?.owner ? { owner: value.owner } : {}),
  };
}
