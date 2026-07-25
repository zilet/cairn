import { dayReadHeadline } from "../../repo/day-read.js";
import { finishSession } from "../../repo/sessions.js";

// Mark a session finished and attach the SAME rotated "done" headline the next
// /today-read fetch will compute for today's Brief. dayReadHeadline is a pure
// function of (kind, date) — see pickDayVariant — so this and the reconciling
// fetch always agree. The client's optimistic Today paint right after finishing
// (today-session-controller.ts's finishedBrief) uses this field instead of a
// hardcoded literal, so the headline never flickers between an invented sentence
// and the real rotated one once the network catches up (CLAUDE.md: athlete-facing
// prose is a variant set, never a single literal).
export function finishSessionWithHeadline(sessionId: number, notes?: string | null) {
  const result = finishSession(sessionId, notes);
  return { ...result, headline: dayReadHeadline({ kind: "done" }, String(result.date)) };
}
