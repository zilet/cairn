// IS THIS SESSION STARTED — the one test behind every "the athlete has lived on this
// session" question: the lock on replacing a day's composition (adaptive-session.ts),
// whether today's open session reads Start or Continue (open-session.ts), and whether
// an accidental empty session may be discarded.
//
// What counts: work the athlete actually did, or words they wrote about it. Skips and a
// finish stamp on a session with no logged sets are bookkeeping of a prescription the
// athlete walked away from, not evidence of training. A cardio activity that happens to
// match a prescribed run is never a lock either: the activity row is its own record.
// Leaf module: reads only the row it is handed.

function hasText(value: unknown): boolean {
  return value != null && String(value).replace(/\s+/g, " ").trim().length > 0;
}

/**
 * Why `session` counts as started, in words ("logged sets", "session notes", …); empty
 * when it does not. `session.set_count` is the caller's count of its logged sets.
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
  return reasons;
}

/** True when the athlete has lived on the session (see meaningfulSessionReasons). */
export function sessionStarted(session: any): boolean {
  return meaningfulSessionReasons(session).length > 0;
}
