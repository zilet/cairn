// IS THIS SESSION STARTED — the one test behind every "the athlete has lived on this
// session" question: the lock on replacing a day's composition (adaptive-session.ts),
// whether today's open session reads Start or Continue (open-session.ts), whether
// an accidental empty session may be discarded, and whether a chat-built session may
// still be undone (chat-today-session.ts).
//
// What counts: work the athlete actually did, or words they wrote or answered about it —
// logged sets, a duration, notes, feedback, a linked watch activity, or an answer to an
// exercise card's pain question (a STATED movement-tolerance observation bound to the
// session). Skips and a finish stamp on a session with no logged sets are bookkeeping of
// a prescription the athlete walked away from, not evidence of training. A cardio
// activity that happens to match a prescribed run is never a lock either: the activity
// row is its own record. Leaf module: reads only the row it is handed — a caller reads
// the row with SESSION_STARTED_COUNTS so the counts ride on it.

/**
 * The two counted columns the test reads, for a `SELECT s.*, ${SESSION_STARTED_COUNTS}
 * FROM sessions s`: `set_count` (logged sets) and `answer_count` (pain answers the
 * athlete gave on an exercise card — stated observations, never ones inferred from a
 * logged set). Every reader of a session row it hands to this module selects both.
 */
export const SESSION_STARTED_COUNTS = `(SELECT COUNT(*) FROM logged_sets ls WHERE ls.session_id = s.id) AS set_count,
              (SELECT COUNT(*) FROM movement_tolerance_observations mto
                WHERE mto.session_id = s.id AND mto.evidence = 'stated') AS answer_count`;

function hasText(value: unknown): boolean {
  return value != null && String(value).replace(/\s+/g, " ").trim().length > 0;
}

/**
 * Why `session` counts as started, in words ("logged sets", "session notes", …); empty
 * when it does not. `session.set_count` / `session.answer_count` are the caller's counts
 * (SESSION_STARTED_COUNTS).
 */
export function meaningfulSessionReasons(session: any): string[] {
  const reasons: string[] = [];
  if (Number(session?.set_count ?? 0) > 0) reasons.push("logged sets");
  if (session?.duration_min != null) reasons.push("recorded duration");
  if (hasText(session?.notes)) reasons.push("session notes");
  if (session?.soreness != null || session?.performance != null || hasText(session?.joint_pain)) {
    reasons.push("session feedback");
  }
  if (hasText(session?.garmin_json)) reasons.push("linked strength activity");
  if (Number(session?.answer_count ?? 0) > 0) reasons.push("pain answers");
  return reasons;
}

/** True when the athlete has lived on the session (see meaningfulSessionReasons). */
export function sessionStarted(session: any): boolean {
  return meaningfulSessionReasons(session).length > 0;
}

// The same reasons as a person reads them, in second person ("your logged sets").
const REASON_WORDS: Readonly<Record<string, string>> = {
  "logged sets": "your logged sets",
  "recorded duration": "a recorded duration",
  "session notes": "your notes",
  "session feedback": "your feedback on how it went",
  "linked strength activity": "your watch's strength activity",
  "pain answers": "your answers about pain",
};

/**
 * What the athlete has on the session, as one phrase for a sentence ("your notes and
 * your feedback on how it went"); "your work" when there is nothing specific to name.
 */
export function startedReasonsPhrase(reasons: readonly string[]): string {
  const words = [...new Set(reasons.map((reason) => REASON_WORDS[reason] ?? null).filter((w): w is string => !!w))];
  if (!words.length) return "your work";
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
