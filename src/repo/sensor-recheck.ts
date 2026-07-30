// SENSOR RECHECK — when the picture of the athlete's own recovery range has gone
// stale enough to be worth ONE calm, optional word about it.
//
// This is the third question in the sensor family, and the three are easy to
// confuse:
//
//   sensor-freshness.ts  — how OLD may ONE datum be before it stops being
//                          evidence? (stale behaves as absent)
//   sensor-cadence.ts    — is there ENOUGH of a SERIES to describe a trend?
//                          (a thin sample may describe itself, never a trend)
//   sensor-recheck.ts    — has the whole PICTURE aged past the point where one
//                          night would visibly sharpen it, and if so, is now a
//                          good moment to say so ONCE?
//
// The athlete this exists for wears the watch episodically — every run, the
// occasional deliberate night. Track B made the personal recovery range
// sample-anchored so it survives their absence; Track C made the comparisons go
// quiet rather than lie when coverage thins. Both are about the system behaving
// well while the watch is off. Neither ever says the one useful thing: that a
// single night would bring the whole read back into focus.
//
// The law here is the same one the body-composition rescan read already obeys
// (`bodyCompStaleness`, src/repo/propagation.ts): a measurement has a shelf life,
// and when it expires the honest move is to reframe the picture as provisional
// and name the cheap thing that would refresh it — never to nag, never to gate,
// never to withhold anything in the meantime. So:
//
//   ABSENCE IS STILL NEUTRAL. THIS IS AN OFFER, NOT A DEBT.
//
// Concretely that means: nothing downstream may branch on this read; its absence
// changes no posture, no plan and no prose; it never notifies; it says its piece
// at most a handful of times, spaced further apart each time, and then stops
// asking entirely until a reading actually lands. It is filed as an ordinary
// `recovery`-domain entry on the shared attention schedule, so the escalate/decay
// discipline is the SAME machine the lab rechecks and the goal check-in ride
// rather than a second, private cooldown nobody can see.
//
// The decision core is PURE — callers hand over the dates and counts they already
// have, and nothing in it reads the database or the clock. One thin DB-facing
// function assembles that state, mirroring sensor-cadence.ts's shape.

import { db } from "../db.js";
import {
  type CadencePolicy,
  applyAttentionObservation,
  deleteAttentionSchedule,
  getAttentionSchedule,
} from "./attention.js";
import { RECOVERY_BASELINE_LOOKBACK_DAYS, RECOVERY_BASELINE_MIN_POINTS } from "./baseline-bands.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { CADENCE_WINDOW_DAYS, type WearPattern, classifyWearPattern } from "./sensor-cadence.js";
import { addDaysISO, localDateISO } from "./shared.js";
import type { TodayAgendaCandidate } from "./today-agenda.js";

// ---- thresholds --------------------------------------------------------------

// How old the newest recovery-relevant reading may be before one night would
// visibly sharpen the read. FIVE WEEKS, and the number is argued rather than
// picked: `getRecoverySummary` measures "recent vs your norm" over a 7-day window
// against a 30-day one, so by day 30 of silence BOTH windows are empty and every
// vs-norm sentence in the product has already gone quiet on its own. Thirty-five
// days is that point plus a week of grace, so a wearer who is simply between
// baseline nights is never spoken to for a gap they were about to close anyway.
export const SENSOR_RECHECK_SOFT_DAYS = 35;
// Where the same sentence is allowed to lean very slightly harder. TEN WEEKS is
// half of RECOVERY_BASELINE_LOOKBACK_DAYS (180): past it, the newest reading in
// the personal range is nearer to falling out of the sample than to being current,
// so the range has stopped being "lately" and become "that stretch last season".
// Still no urgency language — the wording firms, the register does not change.
export const SENSOR_RECHECK_FIRM_DAYS = 70;
// The history floor. Deliberately RECOVERY_BASELINE_MIN_POINTS: below the number
// of readings that earns a personal range there is no picture to sharpen, and
// asking would be onboarding ("start wearing this"), which is a different product
// conversation and not this module's business.
export const SENSOR_RECHECK_MIN_HISTORY_READINGS = RECOVERY_BASELINE_MIN_POINTS;
// How far back the DB-facing read reaches for history. A year: long enough that a
// ten-week lapse still finds the wearer's whole record, short enough that someone
// who stopped a year ago reads as a never-wearer again rather than as a "recheck".
export const SENSOR_RECHECK_LOOKBACK_DAYS = 365;

// ---- the pure decision core --------------------------------------------------

// The three dimensions the recovery read is built from. Judged TOGETHER on
// purpose: one night puts all three on the wrist at once, so three separate
// suggestions would be three ways of saying the same sentence.
export type RecoveryDimKey = "hrv" | "rhr" | "sleep";
const RECOVERY_DIM_ORDER: readonly RecoveryDimKey[] = ["hrv", "rhr", "sleep"];
const RECOVERY_DIM_WORD: Record<RecoveryDimKey, string> = {
  hrv: "HRV",
  rhr: "resting heart rate",
  sleep: "sleep",
};

export interface SensorRecheckDimensionState {
  key: RecoveryDimKey;
  // Newest reading this dimension has ever produced (within the read's reach),
  // or null when it has never produced one.
  last_reading_date: string | null;
  // Readings available inside the personal-range lookback — i.e. exactly the
  // sample Track B would build a band from. >= RECOVERY_BASELINE_MIN_POINTS means
  // the athlete HAS a range for this dimension today.
  band_readings: number;
}

export interface SensorRecheckState {
  today: string;
  // How the athlete wears the sensor over the cadence window, judged across all
  // three dimensions at once.
  pattern: WearPattern;
  // Distinct dates carrying ANY recovery reading, over the module's reach. The
  // fallback proof of "a real history" for someone whose readings are spread too
  // thin inside the band lookback to have earned a band.
  history_readings: number;
  dimensions: SensorRecheckDimensionState[];
}

export type SensorRecheckTier = "soft" | "firm";
export type SensorRecheckReasonKey = "recovery_range_ageing" | "recovery_range_historical";

export interface SensorRecheck {
  // Every dimension one night would refresh, in display order.
  dimensions: RecoveryDimKey[];
  reason_key: SensorRecheckReasonKey;
  last_reading_date: string;
  last_reading_age_days: number;
  tier: SensorRecheckTier;
  // MACHINE register — third-person evidence prose for the schedule row and any
  // provenance trail. Never rendered to the athlete; `sensorRecheckLine` owns
  // what a person reads.
  reason: string;
}

const DAY_MS = 864e5;

// Midnight-UTC epoch for a YYYY-MM-DD string; null when it is not one. Date-only
// strings parse in UTC because these are day KEYS, not instants (same reasoning
// as sensor-cadence.ts).
function dayEpoch(iso: unknown): number | null {
  const text = String(iso ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const t = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

function plainList(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * Should the system quietly offer that one night would sharpen the recovery read?
 *
 * Null is the common, calm answer. It fires only for an athlete who
 *   (a) does NOT wear the sensor continuously — a daily wearer's picture is fresh
 *       by construction and there is nothing to offer them;
 *   (b) HAS a real history — a personal range on at least one dimension, or
 *       enough readings on record to have nearly earned one. A never-wearer gets
 *       nothing here: that is onboarding, not a recheck; and
 *   (c) whose newest reading across sleep / HRV / resting heart rate has aged past
 *       SENSOR_RECHECK_SOFT_DAYS.
 *
 * PURE: no clock, no database, no writes. A future-dated reading is a clock
 * problem rather than freshness and is ignored, exactly as `sensorIsCurrent` and
 * `classifyWearPattern` already treat one.
 */
export function sensorRecheckDecision(state: SensorRecheckState): SensorRecheck | null {
  const today = dayEpoch(state?.today);
  if (today == null) return null;
  // A daily record is refreshed every morning; there is no picture to sharpen.
  if (state.pattern === "continuous") return null;

  const dims = (Array.isArray(state.dimensions) ? state.dimensions : [])
    .map((dim) => ({ dim, at: dayEpoch(dim?.last_reading_date) }))
    .filter(
      (entry): entry is { dim: SensorRecheckDimensionState; at: number } => entry.at != null && entry.at <= today
    );
  if (!dims.length) return null; // never worn → nothing to recheck

  const banded = dims.filter((entry) => Number(entry.dim.band_readings) >= RECOVERY_BASELINE_MIN_POINTS);
  const lifetime = Number(state.history_readings);
  const hasHistory =
    banded.length > 0 || (Number.isFinite(lifetime) && lifetime >= SENSOR_RECHECK_MIN_HISTORY_READINGS);
  if (!hasHistory) return null;

  const newest = dims.reduce((best, entry) => (entry.at > best.at ? entry : best), dims[0]);
  const ageDays = Math.round((today - newest.at) / DAY_MS);
  if (ageDays < SENSOR_RECHECK_SOFT_DAYS) return null;

  const covered = (banded.length ? banded : dims).map((entry) => entry.dim.key);
  const dimensions = RECOVERY_DIM_ORDER.filter((key) => covered.includes(key));
  const tier: SensorRecheckTier = ageDays >= SENSOR_RECHECK_FIRM_DAYS ? "firm" : "soft";
  const words = plainList(dimensions.map((key) => RECOVERY_DIM_WORD[key]));
  return {
    dimensions,
    reason_key: tier === "firm" ? "recovery_range_historical" : "recovery_range_ageing",
    last_reading_date: new Date(newest.at).toISOString().slice(0, 10),
    last_reading_age_days: ageDays,
    tier,
    reason: `Newest ${words} reading is ${ageDays} days old; the athlete's personal recovery range is drawn entirely from readings at least that old, and one measured night would refresh all of it.`,
  };
}

// ---- the words a person reads ------------------------------------------------
//
// Variant sets, not literals (VISION.md Amendment 2 — a stable input must not
// print the same sentence every time it is legitimately re-shown), rotated by
// `pickDayVariant` on the date so the same day always reads the same and two
// showings weeks apart never read identically.
//
// Register, deliberately: an OFFER. Never "you haven't worn your watch since…",
// never a streak, never a count of missed nights, never a reason the read is
// worse than it could be. The athlete's data is their business; the only thing
// said out loud is what one optional night would buy.
//
// Note the vocabulary constraint that shapes every line: the reading grammar
// (`violatesReadingGrammar`, src/repo/day-read.ts) treats the word "baseline" as
// engineering prose leaking into coaching, so these say "your usual range" — the
// same words the band rows already use — and never the internal term.

// FOUR phrasings per set, and the count is load-bearing rather than decorative.
// `pickDayVariant` indexes on the absolute day number, so two showings separated
// by a whole multiple of the set size land on the SAME sentence — which would put
// a verbatim repeat in front of the athlete weeks later, the exact failure
// Amendment 2 exists to prevent. Every gap in the cooldown ladder below (21 / 35 /
// 62 days) is therefore coprime with four. If you change the ladder or the set
// size, keep that true — `test/sensorRecheck.test.js` pins it.
const SOFT_TITLES: readonly string[] = [
  "A night with the watch on would sharpen your recovery read.",
  "Your usual range is running on older nights — one night would freshen it.",
  "One measured night would bring your usual range back up to date.",
  "A single night on the wrist would put your usual range back in focus.",
];

const FIRM_TITLES: readonly string[] = [
  "Your usual range is drawn entirely from older nights now — one night with the watch on would redraw it.",
  "It's been a while since a night landed; one would give the recovery read something current to stand on.",
  "A single measured night would let your usual range describe now rather than then.",
  "One night on the wrist would rebuild your usual range around where you actually are.",
];

const SOFT_BODIES: readonly string[] = [
  "Whenever it suits — one night is enough, and nothing here waits on it.",
  "No hurry. Everything works the same if you skip it; the read just gets sharper if you don't.",
  "One night, whenever it's convenient. Entirely optional.",
  "Any night that suits you. One is plenty, and none is fine too.",
];

const FIRM_BODIES: readonly string[] = [
  "One night is enough to redraw it, whenever it suits. Nothing here waits on it.",
  "A single night brings the comparison back. Skipping it costs nothing at all.",
  "Whenever it's convenient — one night, and the range speaks for now instead of then.",
  "One night, no particular night. Everything keeps working either way.",
];

// A fixed label, not a rotating one: this is a card KICKER — a UI row fragment in
// the same class as the band labels in baseline-bands.ts, which the repo keeps
// stable on purpose. The SENTENCES rotate; the label the eye uses to recognize
// the card does not.
const KICKER = "YOUR RECOVERY READ";

export interface SensorRecheckLine {
  kicker: string;
  title: string;
  body: string;
}

export function sensorRecheckLine(recheck: SensorRecheck, date: string): SensorRecheckLine {
  const firm = recheck.tier === "firm";
  return {
    kicker: KICKER,
    title: pickDayVariant(firm ? FIRM_TITLES : SOFT_TITLES, date, "sensor_recheck_title"),
    body: pickDayVariant(firm ? FIRM_BODIES : SOFT_BODIES, date, "sensor_recheck_body"),
  };
}

// One flat pool of every athlete-facing literal this module can produce, so the
// grammar test can enumerate the vocabulary wholesale rather than sampling it —
// the same contract `recoveryMenuGrammarPool()` provides for the recovery menu.
export function sensorRecheckGrammarPool(): string[] {
  return [KICKER, ...SOFT_TITLES, ...FIRM_TITLES, ...SOFT_BODIES, ...FIRM_BODIES];
}

// ---- the thin DB-facing read -------------------------------------------------

type RecoveryField = "hrv_ms" | "resting_hr" | "sleep_min";
const FIELD_BY_DIM: Record<RecoveryDimKey, RecoveryField> = {
  hrv: "hrv_ms",
  rhr: "resting_hr",
  sleep: "sleep_min",
};
type RecoveryDbRow = { date: string } & Partial<Record<RecoveryField, number | null>>;

/**
 * Assemble the state the decision core needs, from the same two tables the
 * unified recovery summary and the personal-range bands already merge
 * (`garmin_daily_metrics` + the source-agnostic `daily_metrics`). One bounded
 * pass over both; per-DATE presence is all that matters here, so no source
 * precedence is needed — a date carries a reading if either table has one.
 *
 * Deterministic and null-safe: no rows yields a `none` pattern with no dates,
 * which the core reads as "never worn".
 */
export function sensorRecheckState(asOf: string = localDateISO()): SensorRecheckState {
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(asOf)) ? String(asOf) : localDateISO();
  const since = addDaysISO(today, -Math.max(0, SENSOR_RECHECK_LOOKBACK_DAYS - 1)) ?? today;
  const bandSince = addDaysISO(today, -Math.max(0, RECOVERY_BASELINE_LOOKBACK_DAYS - 1)) ?? today;
  const cols = "date, resting_hr, hrv_ms, sleep_min";
  const rows = [
    ...(db
      .prepare(`SELECT ${cols} FROM daily_metrics WHERE date >= ? AND date <= ?`)
      .all(since, today) as RecoveryDbRow[]),
    ...(db
      .prepare(`SELECT ${cols} FROM garmin_daily_metrics WHERE date >= ? AND date <= ?`)
      .all(since, today) as RecoveryDbRow[]),
  ];

  const datesByField: Record<RecoveryField, Set<string>> = {
    hrv_ms: new Set(),
    resting_hr: new Set(),
    sleep_min: new Set(),
  };
  const anyDates = new Set<string>();
  for (const row of rows) {
    const date = String(row?.date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    for (const field of ["hrv_ms", "resting_hr", "sleep_min"] as const) {
      const raw = row[field];
      if (raw == null || !Number.isFinite(Number(raw))) continue;
      datesByField[field].add(date);
      anyDates.add(date);
    }
  }

  return {
    today,
    // The wear pattern is read over the UNION of the three dimensions: one night
    // produces all three, so a wearer is not "intermittent at sleep and spot-check
    // at HRV" — they are one person with one habit.
    pattern: classifyWearPattern([...anyDates], today, CADENCE_WINDOW_DAYS).pattern,
    history_readings: anyDates.size,
    dimensions: RECOVERY_DIM_ORDER.map((key) => {
      const dates = [...datesByField[FIELD_BY_DIM[key]]].sort();
      return {
        key,
        last_reading_date: dates.length ? dates[dates.length - 1] : null,
        band_readings: dates.filter((date) => date >= bandSince).length,
      };
    }),
  };
}

// The whole read in one call: assemble, then decide. Read-only.
export function sensorBaselineRecheck(asOf: string = localDateISO()): SensorRecheck | null {
  return sensorRecheckDecision(sensorRecheckState(asOf));
}

// ---- the quiet attention slot ------------------------------------------------
//
// The cooldown, the escalation and the eventual silence are NOT a private timer:
// they are the shared attention tier machine (src/repo/attention.ts), the same
// one the lab rechecks and the goal check-in ride, filed under a `recovery`-domain
// signal. Each surfacing is recorded as a CLEAN check — we said our piece and the
// world did not change — which is precisely the observation the machine stretches
// on: active -> confirming -> surveillance -> released. So the offer is made at
// most four times, ~3 then ~5 then ~9 weeks apart, and then it stops asking
// entirely. It comes back only when the athlete actually wears the watch again
// and later lapses, which clears the entry and starts a fresh episode.

const SIGNAL_KEY = "recovery:sensor-recheck";
export const SENSOR_RECHECK_SOURCE = "sensor-recheck";

const RECHECK_POLICY: CadencePolicy = {
  signal_class: "recovery:sensor-recheck",
  domain: "recovery",
  source: SENSOR_RECHECK_SOURCE,
  // Three weeks before the same offer may be made a second time. Long enough that
  // it never reads as a reminder, short enough to still be about this lapse.
  // Each gap (21 / 35 / 62) is coprime with the four phrasings above, so two
  // consecutive showings can never land on the same sentence.
  active_days: 21,
  confirming_days: 35,
  surveillance_initial_days: 62,
  surveillance_multiplier: 1.75,
  surveillance_max_days: 180,
  // ONE surveillance check, not the usual two: this is an optional convenience,
  // not a clinical signal, so it earns its silence faster than a marker does.
  surveillance_checks_before_release: 1,
  reason: "The personal recovery range is built entirely from older readings; one measured night would refresh it.",
  release_condition:
    "A new sleep / HRV / resting-heart-rate reading lands, which clears this entirely; until then the offer stops being repeated.",
};

/**
 * The Today-rail candidate — the ONE surface this ever reaches.
 *
 * Null is the common answer. Returns a card only when the read fires AND the
 * schedule says the offer may be made today.
 *
 * PURE READ — never writes. The candidate's own priority (14, deliberately below
 * `lately` at 15) means the salience arbiter's priority sort, not this function,
 * decides whether the card actually lands inline or behind the quiet "more"
 * disclosure — and that decision isn't known until every OTHER candidate has been
 * produced and ranked. So this function cannot itself decide whether the offer
 * was genuinely seen; call `reconcileSensorRecheckAttention` once placement is
 * known. See that function's own comment for why the two are split.
 */
export function sensorRecheckCandidate(asOf: string = localDateISO()): TodayAgendaCandidate | null {
  const recheck = sensorBaselineRecheck(asOf);
  if (!recheck) return null;

  const entry = getAttentionSchedule(SIGNAL_KEY);
  // Released (it has said its piece) or still inside the cooldown → quiet.
  if (entry && (entry.tier === "released" || !entry.next_due || entry.next_due > asOf)) return null;

  const line = sensorRecheckLine(recheck, asOf);
  return {
    id: "sensor-recheck",
    kind: "health",
    tier: "primary",
    // LOW on purpose — below `lately` (15), so on any day with something real to
    // show it sits behind the quiet "more" disclosure. It only reaches an inline
    // slot on a genuinely empty day, which is exactly when an optional offer is
    // welcome and never in the way.
    priority: 14,
    kicker: line.kicker,
    title: line.title,
    body: line.body,
    dismissible: true,
  };
}

/**
 * Reconcile the shared attention ladder against today's ACTUAL outcome. Call this
 * once, after the Today salience arbiter has produced and placed every candidate
 * — never while candidates are still being built. It reads the same pure decision
 * `sensorRecheckCandidate` does and:
 *
 *   - the picture has resolved (a reading landed, or there was never anything to
 *     recheck) → clear any stale schedule row outright, so a LATER lapse opens a
 *     fresh ladder instead of inheriting an exhausted one. This is bookkeeping,
 *     not spending an offer, so it runs regardless of `surfaced` — there is
 *     nothing to have been "seen" when there is no card in the first place.
 *   - the picture is still stale AND `surfaced` is true (the caller has confirmed
 *     the card actually reached the visible set — inline, never buried behind
 *     "more") → advance the ladder exactly once, exactly like a genuine offer.
 *
 * `surfaced: false` on a still-stale picture is a no-op: the card was produced
 * but nobody actually saw it, so nothing about the schedule may change — the same
 * offer is still available next time, whenever it does reach the visible set.
 *
 * Only ever called for a live day a human is actually looking at — never for a
 * routed historical date or an agent's read-only pass (same contract as the
 * salience arbiter's `markIntroduced`); the caller is responsible for that gate.
 */
export function reconcileSensorRecheckAttention(asOf: string, surfaced: boolean): void {
  const recheck = sensorBaselineRecheck(asOf);
  const entry = getAttentionSchedule(SIGNAL_KEY);

  if (!recheck) {
    if (entry) deleteAttentionSchedule(SIGNAL_KEY);
    return;
  }
  if (!surfaced) return;
  // Released or still inside the cooldown → nothing to advance (mirrors the
  // candidate's own quiet-window check; a caller passing `surfaced: true` here
  // should only ever do so for a card `sensorRecheckCandidate` actually returned).
  if (entry && (entry.tier === "released" || !entry.next_due || entry.next_due > asOf)) return;

  applyAttentionObservation({
    signal_key: SIGNAL_KEY,
    policy: RECHECK_POLICY,
    observation: {
      checked_at: asOf,
      // The FIRST offer opens the ladder at `active`; every repeat is a clean
      // check that stretches it toward silence.
      status: entry ? "clean" : "active",
      source: SENSOR_RECHECK_SOURCE,
      reason: recheck.reason,
    },
  });
}
