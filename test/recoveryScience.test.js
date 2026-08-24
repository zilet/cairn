// Round W3.4, rules 4 and 5 — the two ADVISORY session constraints.
//
// Both exist because the naive instinct is backwards. Short sleep reads as a reason
// to cancel the session; what it actually costs is injury EXPOSURE, so the session is
// kept and the max attempts and the plyometrics come out. A stressful stretch reads as
// a reason to go lighter; what it actually costs is recovery capacity, so the SETS
// come down and the top-set load stays where the progression put it.
//
// What these pin: each fires on its own fixture, both stay silent on absent and thin
// data, a stale night behaves as absent rather than as current, and the constraint
// text reaches the prompt that prescribes the session.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { localDaysAgo, resetTables, seedSleep } from "./_seed.js";
import {
  sleepDebtRead,
  sustainedStressRead,
  trainingConstraintsRead,
  SHORT_NIGHT_MIN,
  STRESS_MIN_LOW_CHECKINS,
} from "../dist/repo/recovery-science.js";
import { renderTrainingConstraints } from "../dist/prompt/shared.js";

const REF = "2026-05-15";
const shift = (days) => new Date(Date.parse(`${REF}T00:00:00Z`) - days * 864e5).toISOString().slice(0, 10);

beforeEach(() => {
  resetTables("checkins", "daily_metrics", "garmin_daily_metrics", "garmin_sources", "context_events");
});

// A recovery snapshot in the shape getRecoverySummary returns, hand-built so these
// tests are about the RULE rather than about the summary's own plumbing.
function recovery({ lastNight = null, avg = null, nightDate = REF, samples = 7 } = {}) {
  return {
    recovery: { sleep_min: lastNight, avg_sleep_min: avg },
    quality: { sleep_min: { latest_date: nightDate, sample_count: samples, source: "apple" } },
  };
}

const keys = (read) => (read?.items ?? []).map((item) => item.key);

// ---- (4) sleep debt ---------------------------------------------------------

test("a short night is a finding; a normal one is not", () => {
  assert.equal(sleepDebtRead(recovery({ lastNight: 320 }), REF).shape, "short_night");
  assert.equal(sleepDebtRead(recovery({ lastNight: 470 }), REF), null);
  assert.equal(sleepDebtRead(recovery({ lastNight: SHORT_NIGHT_MIN }), REF), null, "six hours is the line, not under it");
});

test("an accumulating window is its own shape, and needs enough nights to be a window", () => {
  assert.equal(sleepDebtRead(recovery({ lastNight: 400, avg: 330 }), REF).shape, "debt");
  assert.equal(sleepDebtRead(recovery({ lastNight: 320, avg: 330 }), REF).shape, "both");
  assert.equal(
    sleepDebtRead(recovery({ lastNight: 400, avg: 330, samples: 2 }), REF),
    null,
    "a mean built from two nights is not a pattern"
  );
});

test("a stale night behaves as absent, never as current", () => {
  // The reading is genuinely short — and it is ten days old, which makes it history.
  assert.equal(sleepDebtRead(recovery({ lastNight: 300, nightDate: shift(10) }), REF), null);
  // …and the window average behind it goes quiet with it, rather than outliving it.
  assert.equal(sleepDebtRead(recovery({ lastNight: 300, avg: 330, nightDate: shift(10) }), REF), null);
});

test("absent sleep data fires nothing at all", () => {
  assert.equal(sleepDebtRead(null, REF), null);
  assert.equal(sleepDebtRead({}, REF), null);
  assert.equal(sleepDebtRead(recovery({}), REF), null, "no reading is never a short one");
});

test("the sleep constraint keeps the session and downgrades only the exposed work", () => {
  const read = trainingConstraintsRead({ date: REF, recovery: recovery({ lastNight: 320 }) });
  assert.deepEqual(keys(read), ["sleep_debt_exposure"]);
  const item = read.items[0];
  assert.match(item.constraint, /KEEP the session/);
  assert.match(item.constraint, /do not cancel/i);
  assert.match(item.constraint, /one-rep-max|PR attempts/i);
  assert.match(item.constraint, /plyometric/i);
  assert.match(item.constraint, /technique work stay/i);
  assert.doesNotMatch(item.constraint, /\brest day\b|\bskip the session\b/i);
  assert.match(item.evidence.join(" "), /5\.3 hours/, "the evidence cites the night it read");
});

// ---- (5) sustained life stress ---------------------------------------------

const checkin = (days, values) => ({ date: shift(days), ...values });

test("a run of low mornings inside a window that has a trend counts as sustained", () => {
  const read = sustainedStressRead({
    date: REF,
    checkins: [
      checkin(1, { mood: 2 }),
      checkin(3, { energy: 2 }),
      checkin(5, { mood: 1 }),
      checkin(7, { mood: 4 }),
      checkin(9, { mood: 3 }),
    ],
  });
  assert.ok(read);
  assert.match(read.reasons[0], new RegExp(`${STRESS_MIN_LOW_CHECKINS} of the last 5`));
});

test("a thin log lowers confidence rather than blaming — it never fires the rule", () => {
  // Three low mornings out of three logged. The fraction is worse, and the window has
  // no trend in it: adherence-neutral means a sparse log cannot become an accusation.
  assert.equal(
    sustainedStressRead({ date: REF, checkins: [checkin(1, { mood: 1 }), checkin(2, { mood: 2 }), checkin(4, { energy: 1 })] }),
    null
  );
  // …and a well-logged window that reads fine says nothing either.
  assert.equal(
    sustainedStressRead({
      date: REF,
      checkins: [1, 2, 3, 4, 5, 6].map((days) => checkin(days, { mood: 4, energy: 4 })),
    }),
    null
  );
});

test("only a commitment that has actually been RUNNING for days counts as a stretch", () => {
  const event = (startDays) => [{ kind: "life_event", title: "Product launch", start_date: shift(startDays) }];
  assert.equal(sustainedStressRead({ date: REF, contextEvents: event(1) }), null, "day two of a trip has cost nothing yet");
  const read = sustainedStressRead({ date: REF, contextEvents: event(6) });
  assert.match(read.reasons[0], /Product launch has been running for 7 days/);
  // A stretch that has already ended is not a current one.
  assert.equal(
    sustainedStressRead({
      date: REF,
      contextEvents: [{ kind: "life_event", title: "Old crunch", start_date: shift(30), end_date: shift(9) }],
    }),
    null
  );
  // And an ordinary appointment is not a stressful stretch whatever its length.
  assert.equal(
    sustainedStressRead({ date: REF, contextEvents: [{ kind: "appointment", title: "Dentist", start_date: shift(9) }] }),
    null
  );
});

test("the stress constraint trims SETS and holds intensity — the reverse of the instinct", () => {
  const read = trainingConstraintsRead({
    date: REF,
    contextEvents: [{ kind: "trip", title: "Fieldwork", start_date: shift(8) }],
  });
  assert.deepEqual(keys(read), ["sustained_stress_volume"]);
  const item = read.items[0];
  assert.match(item.constraint, /TRIM SETS/);
  assert.match(item.constraint, /PRESERVE INTENSITY/);
  assert.match(item.constraint, /keep the top-set load/i);
  assert.match(item.constraint, /never overrides progression/i);
});

test("an ordinary day carries no constraints at all", () => {
  assert.equal(trainingConstraintsRead({ date: REF }), null);
  assert.equal(trainingConstraintsRead({ date: REF, recovery: recovery({ lastNight: 470 }), checkins: [] }), null);
});

test("both can hold at once, and each keeps its own words", () => {
  const read = trainingConstraintsRead({
    date: REF,
    recovery: recovery({ lastNight: 300 }),
    contextEvents: [{ kind: "trip", title: "Fieldwork", start_date: shift(8) }],
  });
  assert.deepEqual(keys(read), ["sleep_debt_exposure", "sustained_stress_volume"]);
});

// ---- the render helper ------------------------------------------------------

test("the constraints block is empty on an ordinary day and names its own standing when it is not", () => {
  assert.equal(renderTrainingConstraints({}), "");
  assert.equal(renderTrainingConstraints({ training_constraints: null }), "");
  assert.equal(renderTrainingConstraints({ training_constraints: { items: [] } }), "");

  const block = renderTrainingConstraints({
    training_constraints: trainingConstraintsRead({ date: REF, recovery: recovery({ lastNight: 300 }) }),
  });
  assert.match(block, /SESSION CONSTRAINTS/);
  assert.match(block, /advisory/);
  assert.match(block, /never override(s)? progression/);
  assert.match(block, /KEEP the session/);
});

// ---- and the whole way through the live context -----------------------------

test("a short night reaches the session-suggest prompt as a constraint on the session's SHAPE", async () => {
  const { buildSessionPrompt } = await import("../dist/prompt.js");
  seedSleep(localDaysAgo(0), 310);

  const prompt = buildSessionPrompt(undefined, { minutes: 45 });
  assert.match(prompt, /SESSION CONSTRAINTS/, "the rendered block ships");
  assert.match(prompt, /KEEP the session/);
  assert.match(prompt, /"training_constraints"/, "…and the structured read lands in DATA");
});

test("with nothing to constrain, the session prompt is exactly what it was", async () => {
  const { buildSessionPrompt } = await import("../dist/prompt.js");
  seedSleep(localDaysAgo(0), 470);
  const prompt = buildSessionPrompt(undefined, { minutes: 45 });
  assert.doesNotMatch(prompt, /SESSION CONSTRAINTS/);
});
