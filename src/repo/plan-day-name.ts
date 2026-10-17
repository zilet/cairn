// A plan day's NAME as a person reads it on a dated surface — the stored name minus a
// subtitle that counts the week ("Lower — the week's one leg day").
//
// A plan day is a slot in a RING, not a weekday: a short strength pool repeats inside
// the week, a trade moves a day, a mid-week redraw lands the same kind of day twice.
// So a count written into a name ("one", "only", "once a week") is a claim the
// calendar can contradict at any time — 2026-10-16 the strip printed "the week's one
// leg day" on both Wednesday and Friday. The stored name is the athlete's or the
// agent's own data and is never rewritten — not here, not on save; every surface that
// names a day reads this instead. Leaf module: no imports.

// A subtitle: whatever follows an em or en dash (spaced or not: "Lower—the week's…"),
// a spaced hyphen or a colon, or sits in parentheses. An unspaced hyphen is part of a
// word ("one-arm", "Push-Pull") and never starts one.
const SUBTITLE = /\s*[—–]\s*|\s+-\s+|\s*:\s+/;
const PAREN = /\s*\(([^)]*)\)/g;
// A count of the week: "the week's one…", "only leg day this week", "once a week",
// "2x a week". A week NUMBER ("week 3") is not a count and stays.
const COUNT_WORD =
  /\b(?:one|only|single|sole|once|twice|two|three|four|five|six|seven|first|second|third|last)\b|\b\d+\s*[x×]/i;
const WEEK_WORD = /\bweek(?:'s|’s|s|ly)?\b/i;

function claimsAWeekCount(segment: string): boolean {
  return WEEK_WORD.test(segment) && COUNT_WORD.test(segment);
}

/**
 * The display form of a plan day's name: any subtitle that asserts how many of
 * something the week holds is dropped; everything else is kept verbatim. A name that
 * is nothing BUT such a claim is returned as it is — there is no other name to say.
 */
export function planDayDisplayName(name: unknown): string {
  const raw = String(name ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return raw;
  let out = raw.replace(PAREN, (whole, inner: string) => (claimsAWeekCount(inner) ? "" : whole)).trim();
  const parts = out.split(SUBTITLE);
  if (parts.length > 1) {
    // Rejoin the kept parts with the separators they had, so "Pull — heavy row" is untouched.
    const seps = out.match(new RegExp(SUBTITLE.source, "g")) ?? [];
    let kept = parts[0];
    for (let i = 1; i < parts.length; i++) {
      if (!claimsAWeekCount(parts[i])) kept += `${seps[i - 1]}${parts[i]}`;
    }
    out = kept;
  }
  out = out.trim();
  return out && !claimsAWeekCount(out) ? out : raw;
}

/** True when the display form differs from the stored name (a week count was dropped). */
export function planDayNameClaimsWeekCount(name: unknown): boolean {
  const raw = String(name ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return !!raw && planDayDisplayName(raw) !== raw;
}
