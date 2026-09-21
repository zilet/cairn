// Which coaching prose belongs on an EXERCISE card vs the session/plan.
//
// A restructure's weekly-split essay, or a fueling sentence that is true of the
// whole day, used to be copied onto every changed lift — including mobility prep.
// The session header already says the decision once. A card keeps only a cue that
// is actually about that movement (straps, start light, a swap).

const WEEKDAY = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;

const SESSION_LEVEL_REASON =
  /you already lifted this|fueling can catch up|fueling catches up|the log is what moved this load|the work you logged earned this step|weekly split|days you actually train/i;

/** True when `reason` is a cue unique to one movement, not the week's story. */
export function isItemSpecificChangeReason(reason: unknown, summary?: unknown): boolean {
  const text = String(reason ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  const sum = String(summary ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (sum && text === sum) return false;
  if (text.length > 220) return false;
  const days = text.match(WEEKDAY) ?? [];
  if (new Set(days.map((day) => day.toLowerCase())).size >= 2) return false;
  if (SESSION_LEVEL_REASON.test(text)) return false;
  return true;
}
