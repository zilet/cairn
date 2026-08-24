// ---------------------------------------------------------------------------
// Recovery science: the five evidence-graded reads the deterministic layer owes
// the rest of the brain, in ONE place so the signal state, the Brief and the
// prompt constraints cannot each grow their own opinion of the same physiology.
//
// Everything here is a PURE function over snapshots the callers already hold (a
// `getRecoverySummary` view, the training-signals rollup, the check-in list, the
// context events). No DB access, no clock: a read of an earlier date gets that
// date's inputs from its caller and nothing here reaches around them.
//
// The standing laws every read below obeys:
//   • ABSENT DATA FIRES NOTHING. Every read returns a null/false shape on thin
//     evidence, and thin is the default — the sample floors are explicit and are
//     never inferred from "well, there was something".
//   • NOTHING HERE IS A GATE. These are cautions and coach-prompt constraints.
//     A constraint downgrades EXPOSURE or trims VOLUME; none of them cancels a
//     session, and none of them is a score.
// ---------------------------------------------------------------------------
import { sensorIsCurrent } from "./sensor-freshness.js";

// ---------- (1) the HRV decision band ----------
//
// The DECISION channel for HRV is the 7-day rolling median against the athlete's
// own 30-day baseline — `getRecoverySummary`'s `delta.hrv`, which is already that
// comparison and already refuses to speak below its own sample floors
// (DELTA_MIN_RECENT_N / DELTA_MIN_BASELINE_N). What was missing was the BAND: the
// bar was a flat 5% of the baseline, which is a statement about the metric rather
// than about this athlete's own night-to-night noise.
//
// The evidence-based band is the smallest worthwhile change — a fraction of the
// athlete's OWN dispersion — so a runner whose HRV swings 20 ms between ordinary
// mornings needs a bigger move to mean something than one who sits inside 4 ms.
// Half an SD is the standard smallest-worthwhile-change fraction and is what
// `recoveryTrendBars` now uses whenever the dispersion is available.
//
// It can only ever WIDEN the band: the former constants stay as floors (see
// recovery-trend.ts), so a low-variance athlete keeps exactly the sensitivity they
// have today and a noisy one stops being told their noise is a finding. A band
// that could narrow would be the dangerous direction — it would manufacture
// cautions out of an athlete whose watch happens to be consistent.
export const SWC_SD_FRACTION = 0.5;
// The dispersion itself needs a sample floor of its own: an SD over two readings
// is not a description of anyone's variability. Matched to the baseline-median
// floor in getRecoverySummary, which is the window the SD is taken over.
export const DISPERSION_MIN_N = 5;

/** Population-free sample standard deviation. Null below the floor. */
export function sampleSd(values: readonly number[], minN = DISPERSION_MIN_N): number | null {
  const finite = values.map(Number).filter((value) => Number.isFinite(value));
  if (finite.length < minN) return null;
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  const variance = finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (finite.length - 1);
  return Number.isFinite(variance) && variance > 0 ? Math.sqrt(variance) : null;
}

export type HrvTrendDirection = "below" | "steady" | "high";

export interface HrvTrendRead {
  /** Where the 7-day rolling median sits against the athlete's own baseline band. */
  direction: HrvTrendDirection;
  /** The delta itself (7-day median − baseline median), ms. */
  delta: number;
  /** The half-width of the band the delta was judged against, ms. */
  band: number;
  /** The athlete's own baseline dispersion, when there was enough of it to take. */
  sd: number | null;
}

/**
 * The 7-day rolling HRV read, or null when the comparison is not entitled to speak.
 * `bar` is the band from `recoveryTrendBars` — passed in rather than recomputed so
 * this and the observation that voices it can never disagree.
 */
export function hrvTrendRead(recovery: any, bar: number): HrvTrendRead | null {
  // `delta.hrv` is NULL exactly when getRecoverySummary's sample floors refused the
  // comparison — that null IS the floor, and it must reach here as "no read". Coercing
  // first would turn it into 0, a finite number that reads "steady", and a thin series
  // would speak as supportive evidence. Absent data fires nothing.
  const raw = recovery?.delta?.hrv;
  if (raw == null) return null;
  const delta = Number(raw);
  if (!Number.isFinite(delta)) return null;
  const sd = Number(recovery?.dispersion?.hrv);
  return {
    direction: delta < -bar ? "below" : delta > bar ? "high" : "steady",
    delta,
    band: bar,
    sd: Number.isFinite(sd) && sd > 0 ? sd : null,
  };
}

// ---------- (2) the performance channel ----------
//
// "Is the work itself costing more?" — the question the parasympathetic-saturation
// cross-check asks alongside the HRV trend. It is answered ONLY from channels that
// already exist: the athlete's own session ratings, and the personal HR model's
// read of whether easy running has drifted above its own ceiling. Nothing here
// invents a metric, and a fresh STRONG rating settles the question outright: the
// most recent thing the athlete said about their own training outranks an inference.
export interface PerformanceChannelRead {
  declining: boolean;
  /** MACHINE register — the evidence, third person, for the summary that names it. */
  reasons: string[];
}

export function performanceChannelRead(input: {
  trainingSignals?: any;
  runIntensity?: any;
}): PerformanceChannelRead {
  // A fresh strong session is present-tense evidence that the work is landing. It
  // wins outright rather than merely counting against, because the alternative is a
  // system that tells an athlete who just rated a session strongly that their
  // performance is declining.
  if (input.trainingSignals?.session_quality?.strong_flag) return { declining: false, reasons: [] };
  const reasons: string[] = [];
  if (input.trainingSignals?.autoregulation?.low_performance_flag)
    reasons.push("recent rated sessions came back below the athlete's usual");
  // The only pace-at-heart-rate reading this system actually takes: easy running
  // that keeps finishing above the athlete's own easy ceiling is the same work
  // costing more pulse. `compressed` is the acute fortnight read; `chronic.drifting`
  // is the three-week one (see runIntensityDiscipline).
  if (input.runIntensity?.status === "compressed" || input.runIntensity?.chronic?.drifting)
    reasons.push("easy running keeps finishing above the athlete's own easy ceiling");
  return { declining: reasons.length > 0, reasons };
}

// ---------- (4) sleep debt ----------
//
// Two shapes, one constraint. A SHORT NIGHT is last night under six hours; DEBT is
// the rolling window averaging under six. Either downgrades the injury-exposed
// elements of the session and nothing more — the session itself is kept, which is
// the existing law (one bad night never forces rest) with the half that used to go
// unsaid finally written down.
export const SHORT_NIGHT_MIN = 360;
/** A 14-day mean built from one night is not a pattern. Matches RECOVERY_SAMPLE_FLOOR. */
export const SLEEP_WINDOW_MIN_N = 3;

export interface SleepDebtRead {
  /** `short_night` is last night; `debt` is the window; `both` is both. */
  shape: "short_night" | "debt" | "both";
  last_night_min: number | null;
  window_avg_min: number | null;
}

export function sleepDebtRead(recovery: any, date: string): SleepDebtRead | null {
  const quality = recovery?.quality?.sleep_min ?? recovery?.recovery?.quality?.sleep_min ?? null;
  // A stale night behaves as absent, never as current — the sensor law, applied here
  // so a watch left in a drawer for a fortnight cannot keep constraining sessions.
  const nightFresh = sensorIsCurrent("sleep", quality?.latest_date ?? null, date);
  const lastNight = Number(recovery?.recovery?.sleep_min);
  const shortNight = nightFresh && Number.isFinite(lastNight) && lastNight > 0 && lastNight < SHORT_NIGHT_MIN;

  const avg = Number(recovery?.recovery?.avg_sleep_min);
  const samples = Number(quality?.sample_count);
  const debt =
    Number.isFinite(avg) &&
    avg > 0 &&
    avg < SHORT_NIGHT_MIN &&
    Number.isFinite(samples) &&
    samples >= SLEEP_WINDOW_MIN_N &&
    // The window is only a description of RECENT sleep while a recent night exists
    // to anchor it; past that it is a stale leftover, not accumulating debt.
    nightFresh;

  if (!shortNight && !debt) return null;
  return {
    shape: shortNight && debt ? "both" : shortNight ? "short_night" : "debt",
    last_night_min: shortNight ? Math.round(lastNight) : null,
    window_avg_min: debt ? Math.round(avg) : null,
  };
}

// ---------- (5) sustained life stress ----------
//
// SUSTAINED is the load-bearing word. A flat morning is not a training signal and
// the constitution says so; a fortnight of them beside a stretch the athlete has
// already told us about is a different fact. Two arms, both requiring duration:
//   • the check-in trend — enough low mornings inside a window that carries enough
//     check-ins to have a trend at all (a thin log lowers confidence, never blames);
//   • a stress-shaped dated commitment that has been running for days, not hours.
export const STRESS_WINDOW_DAYS = 14;
/** Below this many logged check-ins the window has no trend to read. */
export const STRESS_MIN_CHECKINS = 5;
/** How many of them must read low before a stretch counts as sustained. */
export const STRESS_MIN_LOW_CHECKINS = 3;
/** A commitment shorter than this is a day, not a stretch. */
export const STRESS_MIN_EVENT_DAYS = 5;
const STRESS_EVENT_KIND = /^(?:trip|life_event|family_event)$/;

export interface SustainedStressRead {
  /** MACHINE register — third-person evidence for the constraint that names it. */
  reasons: string[];
}

function isoDay(value: unknown): number | null {
  const ms = Date.parse(`${String(value ?? "").slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 864e5) : null;
}

export function sustainedStressRead(input: {
  date: string;
  checkins?: any[];
  contextEvents?: any[];
}): SustainedStressRead | null {
  const today = isoDay(input.date);
  if (today == null) return null;
  const reasons: string[] = [];

  const window = (Array.isArray(input.checkins) ? input.checkins : []).filter((row) => {
    const day = isoDay(row?.date);
    return day != null && day <= today && today - day < STRESS_WINDOW_DAYS;
  });
  const rated = window.filter((row) => row?.mood != null || row?.energy != null);
  const low = rated.filter(
    (row) => (row?.mood != null && Number(row.mood) <= 2) || (row?.energy != null && Number(row.energy) <= 2)
  );
  if (rated.length >= STRESS_MIN_CHECKINS && low.length >= STRESS_MIN_LOW_CHECKINS)
    reasons.push(
      `${low.length} of the last ${rated.length} morning check-ins read low on mood or energy over the past ${STRESS_WINDOW_DAYS} days`
    );

  for (const event of Array.isArray(input.contextEvents) ? input.contextEvents : []) {
    if (!event || !STRESS_EVENT_KIND.test(String(event.kind ?? ""))) continue;
    const start = isoDay(event.start_date);
    const end = event.end_date ? isoDay(event.end_date) : null;
    if (start == null || start > today) continue;
    if (end != null && end < today) continue;
    // Measured to TODAY, not to the event's own end: a three-week trip on its second
    // day has not yet cost the athlete anything, and dating it forward would let a
    // calendar entry assert a stretch that has not happened.
    if (today - start + 1 < STRESS_MIN_EVENT_DAYS) continue;
    reasons.push(
      `${String(event.title || "A current commitment").trim()} has been running for ${today - start + 1} days`
    );
    break;
  }

  return reasons.length ? { reasons } : null;
}

// ---------- the coach-prompt constraints (rules 4 + 5) ----------
//
// ADVISORY, and the word is enforced by what they say rather than by a flag: each
// one names what to trade, never what to cancel. They inform selection; progression
// keeps its own authority (the existing law for subjective and recovery signals),
// and no surface renders them as a verdict.
export interface TrainingConstraint {
  key: "sleep_debt_exposure" | "sustained_stress_volume";
  /** MACHINE register — the evidence, third person. */
  reason: string;
  /** What the coach should DO with the session. Imperative, bounded, never a cancel. */
  constraint: string;
  evidence: string[];
}

export interface TrainingConstraintsRead {
  items: TrainingConstraint[];
}

export function trainingConstraintsRead(input: {
  date: string;
  recovery?: any;
  checkins?: any[];
  contextEvents?: any[];
}): TrainingConstraintsRead | null {
  const items: TrainingConstraint[] = [];

  const sleep = sleepDebtRead(input.recovery, input.date);
  if (sleep) {
    const evidence = [
      sleep.last_night_min != null
        ? `the most recent night came in at about ${Math.round(sleep.last_night_min / 6) / 10} hours`
        : null,
      sleep.window_avg_min != null
        ? `sleep across the recent window is averaging about ${Math.round(sleep.window_avg_min / 6) / 10} hours`
        : null,
    ].filter(Boolean) as string[];
    items.push({
      key: "sleep_debt_exposure",
      reason: `Short sleep is on record (${evidence.join("; ")}), which raises injury exposure without changing what the athlete can absorb at ordinary intensities.`,
      constraint:
        "KEEP the session — do not cancel it or swap it for rest. DOWNGRADE the injury-exposed elements only: no new one-rep-max or PR attempts, and trim plyometric, jumping and maximum-velocity work. Easy volume and technique work stay exactly as planned.",
      evidence,
    });
  }

  const stress = sustainedStressRead(input);
  if (stress) {
    items.push({
      key: "sustained_stress_volume",
      reason: `Sustained life stress is evidenced (${stress.reasons.join("; ")}), which costs recovery capacity rather than the ability to express force.`,
      constraint:
        "TRIM SETS, PRESERVE INTENSITY — the reverse of the usual instinct. Drop a set or two from the accessory work and keep the top-set load where the progression put it. Volume is what a stressed stretch cannot afford; intensity is what keeps the adaptation. This informs selection only: it never overrides progression and never changes the plan by itself.",
      evidence: stress.reasons,
    });
  }

  return items.length ? { items } : null;
}
