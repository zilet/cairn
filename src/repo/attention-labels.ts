// Shared attention-schedule label helpers — used by BOTH the forward timeline
// (Train's "road ahead") and the next-checkup read (Stand's doctor loop) so the two
// surfaces describe the same recheck signal with the same words, and dedupe it the
// same way. Pure/offline; null-safe on any input.

// A review-followup row's signal_key is machinery ("review-followup:hs-crp:…"); the
// human action lives in its reason ("Health review follow-up: Recheck hs-CRP (when
// rested…)"). Return that action as a label — minus the "Health review follow-up:"
// prefix and any trailing timing parenthetical — so two different follow-ups read as
// their two different actions instead of one generic "Lab follow-up" line. Null when
// there's nothing usable left.
export function followupLabel(reason: unknown): string | null {
  const core = String(reason ?? "")
    .replace(/^\s*health review follow-up:\s*/i, "")
    .replace(/\s*\([^)]*\)\s*\.?\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!core) return null;
  return core.length > 90 ? `${core.slice(0, 89).trimEnd()}...` : core;
}

// The sentinel slug a review follow-up is filed under when it matches no real marker
// (doctor-loop's applyReviewFollowups falls back to the label "lab follow-up" →
// signalSlug "lab-follow-up"). It is NOT a marker identity — many unrelated follow-ups
// ("Repeat sleep study", "Repeat colonoscopy") share it — so it must never be a dedupe
// key, or one would silently drop the other.
const FOLLOWUP_SENTINEL_SLUG = "lab-follow-up";

// The marker slug an attention signal_key is about — for MARKER-LEVEL dedupe across
// the periodic cadence recheck (`marker:<slug>`) and any review follow-ups on that
// same marker (`review-followup:<slug>:<what>`), which otherwise render as two entries
// for one marker. Null for non-marker signals (dexa, add-ons) AND for a sentinel
// non-marker follow-up, so callers fall back to the FULL signal_key and distinct
// follow-ups both survive; a real-marker follow-up still dedupes against its cadence row.
export function markerSlugFromSignalKey(key: unknown): string | null {
  const s = String(key ?? "");
  if (s.startsWith("marker:")) return s.slice("marker:".length) || null;
  if (s.startsWith("review-followup:")) {
    const slug = s.split(":")[1] || null;
    return slug === FOLLOWUP_SENTINEL_SLUG ? null : slug;
  }
  return null;
}
