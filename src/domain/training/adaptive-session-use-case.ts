import { DailySessionError, prepareDailySession, type PrepareDailySessionInput } from "../../repo/adaptive-session.js";
import { getSessionDetail } from "../../repo/sessions.js";

export function prepareDailySessionUseCase(input: PrepareDailySessionInput = {}) {
  const prepared = prepareDailySession(input);
  const session = getSessionDetail(Number(prepared.session_id));
  if (!session) throw new DailySessionError("daily_session_session_missing", "prepared workout session was not found");
  const { session_id: _sessionId, ...result } = prepared;
  return { ...result, session };
}

export function dailySessionErrorBody(error: unknown) {
  const value = error as { code?: unknown; message?: unknown };
  return {
    ok: false as const,
    code: typeof value?.code === "string" ? value.code : "daily_session_invalid",
    error: typeof value?.message === "string" ? value.message : String(error),
  };
}
