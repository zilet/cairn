// MOOD AS CONTEXT, NEVER POSTURE.
//
// `checkins.mood` has been written since the first check-in and read by nothing that
// reasons: it reached the day-read's signals for display and stopped, so the coach could
// not notice a run of low mood beside a hard block. It now enters the signal state as a
// CONTEXT-ONLY observation.
//
// The constitution is explicit that subjective signals inform and never override, and
// mood is the fuzziest of them — a bad morning is not a training verdict. So the whole
// test here is the A/B: the decided half of the state must be byte-identical with and
// without a mood on record, at every mood value, on both a thin day and a loaded one.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { planningSignalState, buildUnifiedSignalState } from "../dist/repo/signal-state.js";
import { resetTables } from "./_seed.js";

beforeEach(() => resetTables("checkins", "profile"));

const DATE = "2026-07-30";

// Everything a posture is computed FROM. `coverage`, `provenance` and `evidence` are
// deliberately excluded: that is exactly where context-only evidence is allowed to show.
function decidedHalf(state) {
  return {
    action: state.action,
    conflicts: state.conflicts,
    dimensions: Object.fromEntries(
      Object.entries(state.dimensions).map(([key, d]) => [
        key,
        {
          status: d.status,
          confidence: d.confidence,
          latest_date: d.latest_date,
          reason: d.reason,
          voice: d.voice,
          conflicts: d.conflicts,
        },
      ])
    ),
  };
}

const withMood = (mood, checkin = {}) => planningSignalState({ date: DATE, checkin: { ...checkin, mood } });
const withoutMood = (checkin = {}) => planningSignalState({ date: DATE, checkin: { ...checkin } });

test("mood changes NOTHING about the decided state, at every value, on a bare day", () => {
  const base = decidedHalf(withoutMood());
  for (const mood of [1, 2, 3, 4, 5]) {
    assert.deepEqual(
      decidedHalf(withMood(mood)),
      base,
      `mood ${mood} left posture, readiness, directives and every dimension untouched`
    );
  }
});

test("mood changes NOTHING about the decided state beside real recovery evidence", () => {
  // The case that actually matters: a low mood next to signals that DO decide. Mood must
  // not deepen a protective read, and must not soften one either.
  for (const checkin of [
    { energy: 1, sleep_feel: 1, soreness: 5 },
    { energy: 5, sleep_feel: 5, soreness: 1 },
    { energy: 3, sleep_feel: 4 },
    { soreness: 4 },
  ]) {
    const base = decidedHalf(withoutMood(checkin));
    for (const mood of [1, 3, 5]) {
      assert.deepEqual(decidedHalf(withMood(mood, checkin)), base, `mood ${mood} beside ${JSON.stringify(checkin)}`);
    }
  }
});

test("a LOW mood never creates a protective posture on its own", () => {
  const state = withMood(1);
  assert.equal(state.action.posture, "train", "a bad morning is not a training verdict");
  assert.notEqual(state.action.readiness, "protect");
  assert.equal(state.action.directives.training, "proceed");
  assert.equal(state.dimensions.recovery_capacity.status, "unknown", "mood alone leaves the dimension undecided");
});

test("mood does not flip an evidence-free day from unknown to ready", () => {
  // The trap a plain `neutral` direction would have walked into: a neutral observation
  // still makes `active` non-empty, and the posture ladder's last rung reads exactly
  // that. Without the context-only exclusion this day would report "ready" and swap its
  // fallback voice from unvoiced_open to unvoiced_clear.
  assert.equal(withoutMood().action.readiness, "unknown");
  assert.equal(withMood(4).action.readiness, "unknown", "still nothing decisive on record");
  assert.equal(withMood(4).action.voice.key, withoutMood().action.voice.key);
});

test("mood cannot earn a BACKED day", () => {
  // A backed day requires positive evidence from the athlete's own lane. A good mood is
  // not a licence to push.
  const good = withMood(5, { energy: 4, sleep_feel: 4 });
  const plain = withoutMood({ energy: 4, sleep_feel: 4 });
  assert.deepEqual(good.action.support, plain.action.support, "mood adds nothing to the support tier");
  assert.equal(withMood(5).action.support, null, "and cannot produce one alone");
});

test("mood IS carried where the coach can read it: evidence, coverage and provenance", () => {
  const state = withMood(2);
  const recovery = state.dimensions.recovery_capacity;
  const mood = recovery.evidence.find((item) => item.field === "felt_mood");
  assert.ok(mood, "the observation reaches the dimension's evidence");
  assert.equal(mood.context_only, true);
  assert.equal(mood.direction, "neutral");
  assert.ok(!mood.safety_override, "no safety override — the whole point");
  assert.match(mood.summary, /^The athlete/, "third-person machine register, like every sibling summary");
  assert.match(mood.summary, /low mood/i);
  assert.ok(recovery.coverage.observed_fields.includes("felt_mood"));
  assert.ok(
    state.provenance.some((line) => line.startsWith("felt_mood:user_checkin:")),
    "and the provenance trail records where it came from"
  );
});

test("mood carries NO athlete voice — a context-only observation can never be spoken", () => {
  // Context-only evidence can never become a dimension's `strongest` nor the action's
  // lead evidence, so a voice key here would be dead vocabulary (see the note at the end
  // of SIGNAL_VOICE).
  const mood = withMood(1).dimensions.recovery_capacity.evidence.find((i) => i.field === "felt_mood");
  assert.equal(mood.voice, undefined);
  for (const value of [1, 3, 5]) {
    const state = withMood(value);
    assert.notEqual(state.action.voice.key, "felt_mood");
    assert.notEqual(state.dimensions.recovery_capacity.voice.key, "felt_mood");
  }
});

test("the context_only primitive is generic, not a mood special-case", () => {
  // Asserted directly against the builder so the guarantee is a property of the layer
  // rather than of one field name.
  const decisive = {
    dimension: "training_load_tolerance",
    field: "felt_soreness",
    date: DATE,
    source: "user_checkin",
    direction: "constraint",
    summary: "The athlete reports high soreness today.",
    safety_override: true,
    max_age_days: 0,
  };
  const noisy = {
    dimension: "training_load_tolerance",
    field: "some_future_context",
    date: DATE,
    source: "user_checkin",
    direction: "constraint",
    summary: "Context that must not decide anything.",
    safety_override: true,
    context_only: true,
    max_age_days: 0,
  };
  const base = decidedHalf(buildUnifiedSignalState(DATE, [decisive]));
  const withContext = decidedHalf(buildUnifiedSignalState(DATE, [decisive, noisy]));
  assert.deepEqual(withContext, base, "even a constraint-shaped context-only item decides nothing");

  // And alone, a context-only constraint with a safety override still decides nothing.
  const alone = buildUnifiedSignalState(DATE, [noisy]);
  assert.equal(alone.action.posture, "train");
  assert.equal(alone.action.readiness, "unknown");
  assert.equal(alone.dimensions.training_load_tolerance.status, "unknown");
  assert.equal(alone.dimensions.training_load_tolerance.confidence, "none");
});
