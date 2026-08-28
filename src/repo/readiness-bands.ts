// READINESS BANDS — the two thresholds the morning read holds a wearable
// readiness number to, in ONE place.
//
// They live here rather than in day-read.ts because two modules now have to
// agree about them and neither may import the other: day-read decides today's
// posture from a fresh reading, and read-adherence asks the mirror question
// about YESTERDAY's divergence ("did the body answer badly the next morning?").
// A second literal in the second module is exactly how a band drifts.
//
// Neither constant is a score and neither is ever rendered. They gate a
// suggestion; the athlete still drives.
//
// FRESHNESS IS NOT HANDLED HERE. A reading may only speak for a day when
// `sensorIsCurrent("training_readiness", …)` says so (src/repo/sensor-freshness.ts);
// these predicates answer only "what does this NUMBER say", and a caller that
// forgets the age gate is asking the wrong question, not getting a wrong answer.

// The long-standing subdued band. A fresh reading under this reads as a
// recovery constraint in the signal state, which on the production path ships
// the day as a protective EASY read.
export const LOW_READINESS = 35;

// The deep band, below the subdued one: a reading this low is the watch saying
// the night did not restore anything. Where LOW_READINESS earns an easy day,
// this earns a REST read — the outcome-softening ladder may still ease it, but
// only as far as easy MOVEMENT (see day-read's rest ladder), never to a
// training day and never to a run.
//
// Twenty rather than "some fraction of low": Garmin's own readiness scale bottoms
// out in the single digits on a genuinely wrecked morning (the live case that
// prompted this rule read 1/100 the morning after a longest-ever threshold run),
// and the band has to be far enough below the subdued one that an ordinary poor
// night cannot reach it.
export const REST_GRADE_READINESS = 20;

function numeric(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Is this reading in the subdued band? Absence is absence — never a caution.
export function readsLowReadiness(value: unknown): boolean {
  const n = numeric(value);
  return n != null && n < LOW_READINESS;
}

// Is this reading in the deep, rest-grade band?
export function readsRestGradeReadiness(value: unknown): boolean {
  const n = numeric(value);
  return n != null && n <= REST_GRADE_READINESS;
}
