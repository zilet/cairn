// HOW ABSENCE IS SAID — the one vocabulary for "the watch has nothing for today".
//
// `sensor-freshness.ts` decides whether a reading may speak, `sensor-cadence.ts`
// decides whether a SERIES may, and both of them resolve to the same neutral
// outcome: the datum is treated as absent. This module owns what that outcome
// SOUNDS like.
//
// It exists because the product only ever knew one shape of absence — the watch
// is broken or was never set up — and said so everywhere: "no wearable data
// synced yet", "none synced", "connecting a wearable would let the daily read
// account for how recovered you actually are". For an athlete who wears the
// watch for runs and the occasional night, every one of those sentences is
// factually wrong AND a nag: it reports a working habit as a fault and asks them
// to change it, which is push, not pull (VISION.md).
//
// So absence has THREE shapes here, and each gets its own words:
//   • episodic — readings exist, spaced out, and today simply is not one of the
//     days they land on. The calm, factual reference is to their own cadence.
//   • unworn   — nothing on record at all. "No wearable connected" is accurate
//     here and ONLY here; cadence phrasing must never invent a history.
//   • lapsed   — a daily wearer whose series stopped. Naming the age of the last
//     reading is the informative thing to say, and stays a statement of fact.
//
// Everything is PURE: callers pass the cadence they already computed and the day
// being read. Nothing here touches the database or the clock, so the Brief, the
// next step, the reaction model and the signal state cannot quietly disagree
// about what today's silence means.
//
// TWO REGISTERS, on the standing rule (CLAUDE.md): `wearAbsenceEvidence` is
// third-person evidence prose for the model and the provenance trail; everything
// else is athlete-facing and therefore a VARIANT SET rotated by `pickDayVariant`.

import { pickDayVariant } from "./brain/day-read-rules.js";
import type { SensorCadence, WearPattern } from "./sensor-cadence.js";
import { sensorAgeDays } from "./sensor-freshness.js";

export type WearAbsenceShape = "episodic" | "unworn" | "lapsed";

// The variant SETS are one finer than the shapes: an episodic wearer's silence is
// the same fact whichever series it is, but only the sleep series may be called a
// night. Every other shape's words are already field-neutral.
export type WearAbsenceVoiceSet = WearAbsenceShape | "episodic_nights";

/** What a surface needs to say absence well, derived once from a cadence. */
export interface WearAbsenceView {
  shape: WearAbsenceShape;
  pattern: WearPattern;
  readings: number;
  window_days: number;
  last_reading_date: string | null;
  /** Whole days from the last reading to the day being read. Null when unknown. */
  age_days: number | null;
  median_gap_days: number | null;
  /** Plain-words age of the last reading ("about 3 weeks ago"), or null. */
  age_phrase: string | null;
  /** Which recovery series this cadence describes ("sleep_min"/"hrv_ms"/…), or null. */
  field: string | null;
  /**
   * What the phrasing is allowed to CALL the thing the watch last caught.
   *
   * "nights" only when the series is sleep — a night is the one reading a person
   * recognizes as a night. Every other series, and an unknown one, is "readings",
   * which is true of all of them.
   *
   * This exists because the cadence spoken for is the DENSEST series, and on a live
   * payload that was resting HR while the sentence said "the watch last caught a
   * night today" — on a day with no sleep row at all. The prose must be keyed to the
   * series it names, not to the series that happens to have the most samples.
   */
  measures: "nights" | "readings";
}

/** The recovery-quality field whose readings a person would call nights. */
export const SLEEP_CADENCE_FIELD = "sleep_min";

// ---- plain-words age --------------------------------------------------------

// Deliberately COARSE, and coarser the further back it goes. An exact day count
// on a three-week-old night is precision the athlete has no use for, and it reads
// like a countdown — "twenty days" invites "you should have worn it by now".
// Weeks and months are the register a person actually keeps a habit in.
export function readingAgePhrase(ageDays: number | null | undefined): string | null {
  const n = Number(ageDays);
  if (ageDays == null || !Number.isFinite(n) || n < 0) return null;
  const days = Math.round(n);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days <= 6) return `${days} days ago`;
  if (days <= 10) return "about a week ago";
  if (days <= 27) return `about ${Math.round(days / 7)} weeks ago`;
  if (days <= 45) return "about a month ago";
  if (days <= 350) return `about ${Math.round(days / 30)} months ago`;
  return "more than a year ago";
}

// ---- the view ---------------------------------------------------------------

/**
 * Which shape of absence is this, and what does a surface need to say it?
 *
 * `cadence` is whatever `classifyWearPattern` produced for the series in
 * question (or the `cadence` object Track C hangs off `getRecoverySummary`'s
 * quality entries). A null/garbage cadence resolves to `unworn`, which is the
 * safe direction: it says less than we know rather than more.
 */
export function wearAbsenceView(
  cadence: Partial<SensorCadence> | null | undefined,
  asOf: string,
  // WHICH recovery series this cadence is. Optional, and its absence is the
  // conservative direction: an unnamed series may only be spoken of as "readings",
  // never as nights.
  field?: string | null
): WearAbsenceView {
  const readings = Math.max(0, Math.trunc(Number(cadence?.readings)) || 0);
  const lastDate = typeof cadence?.last_reading_date === "string" ? cadence.last_reading_date : null;
  const pattern: WearPattern =
    cadence?.pattern === "continuous" || cadence?.pattern === "intermittent" || cadence?.pattern === "spot_check"
      ? cadence.pattern
      : "none";
  const age = sensorAgeDays(lastDate, asOf);
  // A future-dated reading is a clock problem, not evidence — same ruling
  // sensorIsCurrent makes. Treat its age as unknown rather than negative.
  const ageDays = age == null || age < 0 ? null : age;
  // `!= null` first, deliberately: `Number(null)` is 0 and passes isFinite, which
  // would report "readings typically 0 days apart" for a series with no readings
  // at all — a fabricated rhythm, which is the exact failure mode this module is
  // here to prevent.
  const medianGap =
    cadence?.median_gap_days != null && Number.isFinite(Number(cadence.median_gap_days))
      ? Number(cadence.median_gap_days)
      : null;
  const windowDays = Math.max(1, Math.trunc(Number(cadence?.window_days)) || 90);
  // The shape. `unworn` needs BOTH no readings and no date: a series with one
  // reading still has a history, and claiming otherwise is the error this module
  // exists to stop.
  const shape: WearAbsenceShape =
    pattern === "none" || readings === 0 || lastDate == null
      ? "unworn"
      : pattern === "continuous"
        ? "lapsed"
        : "episodic";
  return {
    shape,
    pattern,
    readings,
    window_days: windowDays,
    last_reading_date: lastDate,
    age_days: ageDays,
    median_gap_days: medianGap,
    age_phrase: readingAgePhrase(ageDays),
    field: typeof field === "string" && field ? field : null,
    measures: field === SLEEP_CADENCE_FIELD ? "nights" : "readings",
  };
}

/**
 * The wear cadence to speak for, out of `getRecoverySummary().quality`.
 *
 * Track C hangs a `cadence` on each of the three delta fields, and they can
 * disagree — an athlete whose watch reports HRV on every run but sleep only on a
 * baseline night has two honest, different cadences. The densest series wins
 * (ties broken by the most recent reading), because absence phrasing should
 * describe the habit at its strongest: saying "your watch last caught something
 * three weeks ago" when a run-day reading landed on Tuesday would be the same
 * overclaim in the other direction.
 */
export function dominantSensorCadence(quality: unknown): SensorCadence | null {
  return dominantSensorCadenceEntry(quality)?.cadence ?? null;
}

/**
 * The same choice, WITH the name of the series that won it.
 *
 * The field matters to the words: the winning series is routinely resting HR, and
 * only the sleep series may be spoken of as nights (see `WearAbsenceView.measures`).
 * `dominantSensorCadence` above is this function with the name thrown away, kept for
 * callers that only need the numbers.
 */
export function dominantSensorCadenceEntry(quality: unknown): { field: string; cadence: SensorCadence } | null {
  const map = quality && typeof quality === "object" ? (quality as Record<string, any>) : {};
  let best: { field: string; cadence: SensorCadence } | null = null;
  for (const [field, entry] of Object.entries(map)) {
    const cadence = entry && typeof entry === "object" ? (entry.cadence as SensorCadence | undefined) : undefined;
    if (!cadence || typeof cadence !== "object") continue;
    if (!best) {
      best = { field, cadence };
      continue;
    }
    const better =
      Number(cadence.readings || 0) > Number(best.cadence.readings || 0) ||
      (Number(cadence.readings || 0) === Number(best.cadence.readings || 0) &&
        String(cadence.last_reading_date ?? "") > String(best.cadence.last_reading_date ?? ""));
    if (better) best = { field, cadence };
  }
  return best;
}

// ---- the athlete's words ----------------------------------------------------
//
// `{}` is the age phrase, substituted the same way SIGNAL_VOICE substitutes its
// subject. Every set is at least three phrasings, because a stable input fires a
// stable branch and a single literal would print verbatim for weeks (CLAUDE.md).
//
// Vocabulary constraints these must keep, all of them enforced elsewhere:
//   • the reading grammar (DAY_READ_GRAMMAR_RULES) bans "baseline" as engineering
//     prose, so "your last baseline night" is not sayable — "the last night your
//     watch recorded" says the same thing in the athlete's register;
//   • second person, never "the athlete" (test/dayRead.test.js pins this for the
//     sentence set, which is registered in SIGNAL_VOICE);
//   • no ask. None of these tells anyone to wear anything.

/** Full sentences — the signal state's voice, and the next step's `why`. */
export const WEAR_ABSENCE_SENTENCES = {
  // The FIELD-NEUTRAL episodic set: true of whichever series the cadence describes,
  // and therefore the default. `episodic_nights` below is the same fact said about a
  // night, and is reachable only when the series really is sleep (see `measures`).
  episodic: [
    "The last reading your watch took was {}, which is the rhythm you wear it in — so today goes by how you feel.",
    "Nothing new from the watch since {}, and that's normal for how you use it; how you feel is the read today.",
    "Your watch picks things up here and there and the last one was {} — so today leans on your own sense of it.",
  ],
  episodic_nights: [
    "The last night your watch recorded was {}, which is the rhythm you wear it in — so today goes by how you feel.",
    // Distinct from the field-neutral set on purpose: the two rotate on the same day
    // index, and the neutral-vs-nights voices must never collapse into one literal.
    "No night on the watch since {}, and that's normal for how you wear it; how you feel is the read today.",
    "Your watch catches nights here and there and the last one was {} — so today leans on your own sense of it.",
  ],
  unworn: [
    "No wearable is connected, so how you feel is the whole read today.",
    "There's no watch data on file, which just means today goes by your own sense of it.",
    "Nothing from a wearable yet — a morning check-in is the sharpest read you can give today.",
  ],
  lapsed: [
    "Your watch usually reports most days and its last reading was {}, so today leans on how you feel.",
    "The last reading came in {}, which is a longer quiet stretch than usual for you; how you feel carries today.",
    "The watch went quiet {}, unlike its usual run of days — so go by your own sense of today.",
  ],
} as const satisfies Record<WearAbsenceVoiceSet, readonly [string, ...string[]]>;

/** Lowercase FRAGMENTS for the Brief's contributor row, which supplies the label. */
export const WEAR_ABSENCE_ROW_STATES = {
  episodic: [
    "last reading {} — your usual rhythm, not a gap",
    "the watch last picked something up {}; that's how you wear it",
    "nothing new from the watch since {} — normal for your pattern",
  ],
  episodic_nights: [
    "last recorded night {} — your usual rhythm, not a gap",
    "the watch last caught a night {}; that's how you wear it",
    "no night recorded since {} — normal for your pattern",
  ],
  unworn: [
    "no wearable connected — a morning check-in sharpens the read",
    "nothing from a wearable yet — a morning check-in sharpens the read",
    "no watch data on file — a morning check-in is the read today",
  ],
  lapsed: [
    "last reading {} — a morning check-in sharpens the read",
    "the watch went quiet {}; a morning check-in fills it in",
    "nothing synced since the last reading {} — a morning check-in sharpens the read",
  ],
} as const satisfies Record<WearAbsenceVoiceSet, readonly [string, ...string[]]>;

// The subject a set renders with when no age is known — and the sample the static
// registries render for the constitution tests.
export const WEAR_ABSENCE_SAMPLE_AGE = "a while back";

function render(variants: readonly [string, ...string[]], view: WearAbsenceView | null, date: string, key: string) {
  const subject = view?.age_phrase || WEAR_ABSENCE_SAMPLE_AGE;
  const spoken = variants.map((variant) => variant.replace(/\{\}/g, subject)) as [string, ...string[]];
  return pickDayVariant(spoken, date, key);
}

/**
 * Which variant set speaks for this view. A "night" claim is licensed only by the
 * sleep series; anything else — including a view whose field was never named — takes
 * the field-neutral episodic words.
 */
export function wearAbsenceVoiceSet(view: WearAbsenceView | null | undefined): WearAbsenceVoiceSet {
  const shape = view?.shape ?? "unworn";
  return shape === "episodic" && view?.measures === "nights" ? "episodic_nights" : shape;
}

/** One athlete-facing SENTENCE about today's silence, rotating by day. */
export function wearAbsenceWhy(view: WearAbsenceView | null | undefined, date: string, key = "wear_absence"): string {
  const set = wearAbsenceVoiceSet(view);
  return render(WEAR_ABSENCE_SENTENCES[set], view ?? null, date, `${key}:${set}`);
}

/** One athlete-facing FRAGMENT for the Brief's contributor row, rotating by day. */
export function wearAbsenceRowState(
  view: WearAbsenceView | null | undefined,
  date: string,
  key = "wear_absence:row"
): string {
  const set = wearAbsenceVoiceSet(view);
  return render(WEAR_ABSENCE_ROW_STATES[set], view ?? null, date, `${key}:${set}`);
}

// ---- the machine register ---------------------------------------------------

/**
 * Third-person evidence prose for the coach context, the reaction model's
 * statement and the signal state's `reason`. Dated and counted on purpose: the
 * agent's whole job on a thin morning is to know WHY it is thin, and "no current
 * evidence" told it nothing it could reason from.
 *
 * Never rendered to the athlete.
 */
export function wearAbsenceEvidence(view: WearAbsenceView | null | undefined): string {
  if (!view || view.shape === "unworn") return "No wearable readings on record.";
  const patternWords =
    view.pattern === "continuous"
      ? "daily-wear pattern"
      : view.pattern === "intermittent"
        ? "intermittent-wear pattern"
        : "spot-check pattern";
  const gap =
    view.median_gap_days != null && view.median_gap_days > 0 ? `, typically ~${view.median_gap_days}d apart` : "";
  const dated = view.last_reading_date ? `last reading ${view.last_reading_date}` : "no dated reading";
  const age = view.age_days != null ? ` (${view.age_days}d ago)` : "";
  return `No reading in the freshness window; ${dated}${age} — ${patternWords}, ${view.readings} readings/${view.window_days}d${gap}.`;
}

/**
 * Is this a working episodic habit rather than a gap to flag?
 *
 * The predicate a surface uses to decide whether to say anything at all. True
 * only when there is a real, recent-enough history: readings on record, an
 * episodic pattern, and a last reading no older than the window itself. An
 * athlete who wore the watch twice last spring is not on a cadence — they are
 * unworn with residue, and pretending otherwise fabricates a habit.
 */
export function isWorkingEpisodicPattern(view: WearAbsenceView | null | undefined): boolean {
  if (!view || view.shape !== "episodic") return false;
  if (view.readings < 2) return false;
  return view.age_days != null && view.age_days <= view.window_days;
}
