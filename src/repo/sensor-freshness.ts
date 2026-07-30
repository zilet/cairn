// SENSOR TIMESTAMP DISCIPLINE — the one place the "how old may this datum be"
// question is answered.
//
// A wearable is not a subscription to the truth: the watch comes off, the phone
// stops syncing, a trip happens. Every sensor reading therefore carries a DATE,
// and that date decides whether it may speak at all. The law this module exists
// to enforce is a single sentence:
//
//   STALE SENSOR DATA BEHAVES AS ABSENT, NEVER AS CURRENT.
//
// "As absent" is exact, and it cuts both ways. Absence is already NEUTRAL
// everywhere in this codebase — a missing watch never reads as caution, never
// forces a rest day, never manufactures a verdict (VISION.md: absent signals
// never force anything). Ageing a datum out therefore lands it in that same
// neutral place: it does not become a soft caution, and it does not keep its old
// vote at a discount. It simply stops being evidence.
//
// The bounded-window aggregates elsewhere in the repo (getRecoverySummary's 14
// days, the evaluators' expectation windows, baseline-bands' 28) are already
// self-gating: when the watch goes quiet their window empties and the read goes
// inconclusive on its own. The dangerous shape is the OTHER one — "give me the
// most recent row" with no lower bound, which happily hands back a month-old
// night as though it were last night. Those sites gate through here.
//
// Ages live here rather than at each call site so the Brief, the coach prompt and
// the health surfaces cannot quietly disagree about when a night stopped counting
// (CLAUDE.md: the Brief and the coach prompt can no longer see different states).

// How many days old a reading may be and still count as CURRENT, per signal.
// The spread is physiological, not arbitrary — the faster a signal moves, the
// sooner a stored value stops describing today:
//  • sleep — a night describes ONE night. Two days is already generous; day-read
//    has long used this bound ("a 25-day-old night is not last night"), and this
//    is also where reaction-model's data_gap pattern starts calling the signal
//    quiet. signal-state used to inherit an unconsidered 3 from its helper's
//    default, which let it voice a night the Brief had already dropped.
//  • training_readiness — the watch recomputes it every morning, so yesterday's
//    is the oldest that can speak to today. Matches day-read's own readiness gate.
//  • hrv / resting_hr — noisy day to day but read against a personal norm, so a
//    couple of days of slack is honest.
//  • training_load — Garmin's acute load and training-status phrase, recomputed
//    daily off a decaying window. run-progression already declared this bound by
//    accepting only its fresh/recent freshness words.
//  • fitness_marker — VO2max, RHR and HRV read as TRENDING marker series in the
//    connected brain. Slow-moving, but a series whose newest dot is a fortnight
//    old can no longer claim a direction for today.
//
// Body composition is deliberately NOT here. A DEXA scan already has its own
// recency rule (`bodyCompStaleness`, src/repo/propagation.ts), and it is a richer
// one than an age bound: a three-week-old scan only decays once bodyweight has
// actually moved since, and it decays into a "worth a fresh scan to confirm"
// framing rather than to silence. A flat number here would be a second answer to
// a question that already has a better one.
export const SENSOR_MAX_AGE_DAYS = {
  sleep: 2,
  training_readiness: 1,
  hrv: 3,
  resting_hr: 3,
  training_load: 3,
  fitness_marker: 14,
} as const;

export type SensorSignal = keyof typeof SENSOR_MAX_AGE_DAYS;

// Whole days between an ISO reading date and the day being read. Null when the
// date is missing or unparseable — callers treat that as "cannot vouch for it",
// which resolves the same way stale does. A future-dated reading yields a
// negative age and is NOT clamped: `sensorIsCurrent` rejects it, because a datum
// dated after the day being read is a clock problem, not fresh evidence.
export function sensorAgeDays(readingDate: string | null | undefined, asOf: string): number | null {
  if (!readingDate || !asOf) return null;
  const reading = Date.parse(`${String(readingDate).slice(0, 10)}T00:00:00Z`);
  const reference = Date.parse(`${String(asOf).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(reading) || !Number.isFinite(reference)) return null;
  return Math.round((reference - reading) / 864e5);
}

// May this reading speak for `asOf`? False for a missing/unparseable date and
// for anything beyond the signal's window — in both cases the caller must fall
// through to whatever it already does when the datum is absent entirely.
export function sensorIsCurrent(signal: SensorSignal, readingDate: string | null | undefined, asOf: string): boolean {
  const age = sensorAgeDays(readingDate, asOf);
  if (age == null || age < 0) return false;
  return age <= SENSOR_MAX_AGE_DAYS[signal];
}
