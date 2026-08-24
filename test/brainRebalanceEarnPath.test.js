// THE BRAKE/ACCELERATOR REBALANCE, AND THE EARN PATH (owner ruling, 2026-08-17).
//
// Four mechanisms had drifted into a coach that could only ever get quieter, and one
// gap the read never closed at all. Each case below pins the NEW behaviour, and the
// comments say what it replaced, because every one of these is a deliberate reversal
// rather than a bug fix:
//
//   1. recoveryDown read the SIGN of a difference of noisy medians, so a one-millisecond
//      HRV move eased the week. It now needs a band.
//   2. The outcome loop could soften a rest to easy and stop there, so an athlete whose
//      easy mornings kept becoming real sessions was handed an easy morning forever.
//   3. Any caveat at all withdrew the push, and on a real block something is always
//      worth mentioning — so the one positive direction was unreachable.
//   4. A single dimension at `watch` — the softest brake this layer raises — counselled
//      holding load and volume everywhere. (Pinned in runIntensityDiscipline.test.js,
//      which owns that fixture; the read-level consequence is pinned here.)
//   5. Nothing that held the day back ever said what would open it again.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, seedSleep, seedTrainingDay } from "./_seed.js";
import {
  DAY_READ_EARN_PATH_CONCEPT,
  DAY_READ_EARN_PATH_VARIANTS,
  DAY_READ_LEAD_CONCEPT,
  DAY_READ_LEAD_VARIANTS,
  DAY_READ_OUTCOMES,
  DAY_READ_REQUIRED_CONCEPT,
  DAY_READ_WHY_VARIANTS,
  violatesReadingGrammar,
} from "../dist/repo/day-read.js";
import {
  hrvReadsDown,
  RUN_VOLUME_LEARNED_EASE_UNLOCK,
  RUN_VOLUME_RECOVERY_UNLOCK,
  weeklyRunPlan,
} from "../dist/repo/run-progression.js";
import { easyOverrideSoftening } from "../dist/repo/brain/read-adherence.js";
import { buildUnifiedSignalState, signalVoice } from "../dist/repo/signal-state.js";
import { pickDayVariant } from "../dist/repo/brain/day-read-rules.js";

const REF = "2026-03-15";
const dayBefore = (base, n) => new Date(new Date(base + "T00:00:00Z").getTime() - n * 864e5).toISOString().slice(0, 10);

const WORLD = [
  "logged_sets",
  "sessions",
  "plan_items",
  "plan_days",
  "exercises",
  "checkins",
  "daily_metrics",
  "garmin_daily_metrics",
  "garmin_sources",
  "activities",
  "context_events",
  "recovery_cycles",
  "app_state",
];
beforeEach(() => resetTables(...WORLD));

// The morning ledger row readAdherenceModel reads back (day_reads holds END-of-day
// state and answers a different question) — the same seam dayRead.test.js uses for the
// rest ladder.
const seedMorningRead = (date, kind, signals = {}) =>
  repo.saveDayRead(date, {
    kind,
    headline: `${kind} today.`,
    why: "A calm sentence about the day.",
    focus: null,
    est_minutes: kind === "rest" ? null : 45,
    signals,
    source: "deterministic",
    override: null,
  });

// An easy morning the athlete took well above easy, and rated fine. Deliberately
// spaced two days apart everywhere it is used: three CONSECUTIVE loading days would
// trip the accumulated-load rest and put a different rule on today's read entirely.
const seedOverriddenEasy = (date, performance = 4) => {
  seedMorningRead(date, "easy");
  seedTrainingDay(date);
  if (performance != null) repo.setSessionFeedback(date, { performance });
};

// A recovery summary in the shape dayRead's `recovery` parameter takes. The chronic-
// sleep watch needs a SAMPLE-FLOORED mean under six hours AND a current night that
// is not itself short (a short last night is the REST path). n=1, or a window with
// no current night, is absence — never a trend.
function thinSleep(date = REF) {
  seedSleep(dayBefore(date, 1), 420);
  return {
    has_data: true,
    recovery: { avg_sleep_min: 300 },
    quality: {
      sleep_min: { sample_count: 5, expected_days: 14, window_days: 14, freshness: "fresh" },
    },
  };
}

// ── 1. recoveryDown wants a BAND, not a sign ────────────────────────────────

test("the HRV term needs a real drop, not merely a negative one", () => {
  // Against the athlete's own comparison median: 7% of it, either side of the line.
  assert.equal(hrvReadsDown(-1, 60), false, "one millisecond off a 60 ms median is noise");
  assert.equal(hrvReadsDown(-4, 60), false, "…and so is 6.7%");
  assert.equal(hrvReadsDown(-4.2, 60), true, "7% is the line, and it is inclusive");
  assert.equal(hrvReadsDown(-8, 60), true);

  // No comparison median to work from → the absolute millisecond floor stands.
  assert.equal(hrvReadsDown(-3, null), false);
  assert.equal(hrvReadsDown(-5, null), true);
  assert.equal(hrvReadsDown(-8, undefined), true);

  // Direction and absence are unchanged: only a DROP counts, and no reading says
  // nothing at all.
  assert.equal(hrvReadsDown(9, 60), false);
  assert.equal(hrvReadsDown(0, 60), false);
  assert.equal(hrvReadsDown(null, 60), false);
  assert.equal(hrvReadsDown(undefined, undefined), false);
  // A nonsense median falls back to the absolute floor rather than dividing by it.
  assert.equal(hrvReadsDown(-6, 0), true);
  assert.equal(hrvReadsDown(-2, 0), false);
});

test("a one-millisecond HRV move no longer eases the running week; a real drop still does", () => {
  for (let n = 7; n <= 35; n += 2) {
    db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'running', 50, 8)`).run(
      dayBefore(REF, n)
    );
  }
  const withHrv = (hrv) => ({
    has_data: true,
    recovery: {},
    quality: {},
    delta: { hrv, rhr: 0, sleep: 0 },
    baseline: { hrv: 60 },
  });
  const easedBy = (plan) => plan.rationale.filter((line) => /Recovery's down this week/.test(line));

  const noise = weeklyRunPlan(REF, { recovery: withHrv(-1) });
  assert.deepEqual(easedBy(noise), [], "the sign of a noisy median is not a reason to ease the week");

  const real = weeklyRunPlan(REF, { recovery: withHrv(-8) });
  assert.equal(easedBy(real).length, 1, "a genuine suppression still eases it");
  // …and the ordinary build is what the quiet week gets instead, so the brake coming
  // off does not silently become a bigger week than the standard step.
  assert.ok(
    noise.rationale.some((line) => /Building conservatively/.test(line)),
    `expected the standard build, got ${JSON.stringify(noise.rationale)}`
  );
  // The brake does more than write a line: it drops a run and pulls the quality
  // session. The noise week keeps both.
  assert.ok(
    noise.runs.length > real.runs.length,
    `the eased week should be the smaller one: ${noise.runs.length} vs ${real.runs.length}`
  );
});

test("the run-volume holds say what opens them again", () => {
  for (let n = 7; n <= 35; n += 2) {
    db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'running', 50, 8)`).run(
      dayBefore(REF, n)
    );
  }
  const plan = weeklyRunPlan(REF, {
    recovery: {
      has_data: true,
      recovery: {},
      quality: {},
      delta: { hrv: -8, rhr: 0, sleep: 0 },
      baseline: { hrv: 60 },
    },
  });
  const held = plan.rationale.find((line) => /Recovery's down this week/.test(line));
  assert.ok(held, "the recovery-down line is still there");
  const unlock = RUN_VOLUME_RECOVERY_UNLOCK.find((variant) => held.endsWith(variant));
  assert.ok(unlock, `no registered earn-path phrasing closes the line: ${JSON.stringify(held)}`);

  for (const [label, set] of [
    ["recovery", RUN_VOLUME_RECOVERY_UNLOCK],
    ["learned ease", RUN_VOLUME_LEARNED_EASE_UNLOCK],
  ]) {
    assert.ok(set.length >= 4, `${label}: a weekly line needs a rotation`);
    assert.equal(new Set(set).size, set.length, `${label}: duplicate phrasing`);
    for (const variant of set) {
      assert.equal(violatesReadingGrammar(variant), null, `${label} breaks the reading grammar: ${variant}`);
      assert.match(variant, /\b(?:build|step|mileage|room)\b/i, `${label} drifted off the concept: ${variant}`);
      assert.doesNotMatch(variant, /\b(?:must|have to|need to)\b/i, `${label} reads as an instruction: ${variant}`);
    }
  }
});

// ── 2. the outcome loop, one rung up: easy → train ──────────────────────────

test("three easy mornings taken above easy without cost open today's easy read to a training day", () => {
  for (const back of [2, 4, 6]) seedOverriddenEasy(dayBefore(REF, back));

  const r = repo.dayRead(REF, thinSleep());

  assert.equal(r.kind, "train");
  assert.equal(r.decision.rule_code, "outcome_feedback_open");
  assert.ok(DAY_READ_WHY_VARIANTS.outcome_feedback_open.includes(r.why), `unexpected wording ${JSON.stringify(r.why)}`);
  assert.ok(DAY_READ_OUTCOMES.outcome_feedback_open.reasons.includes(r.decision.reason));
  assert.equal(violatesReadingGrammar(r.why), null, `opened why broke the grammar: ${r.why}`);
  assert.equal(violatesReadingGrammar(r.decision.reason), null, `opened reason: ${r.decision.reason}`);
  // The evidence rides in signals, so the prompt and the audit trail can both see WHY
  // the day opened rather than being asked to trust it.
  assert.equal(r.signals.easy_outcome_feedback.active, true);
  assert.equal(r.signals.easy_outcome_feedback.applied, true);
  assert.deepEqual(r.signals.easy_outcome_feedback.overridden_and_fine, [
    dayBefore(REF, 6),
    dayBefore(REF, 4),
    dayBefore(REF, 2),
  ]);
  assert.equal(r.signals.easy_outcome_feedback.last_honored_easy, null);
});

test("the opened day takes the session that was actually due", () => {
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  for (const back of [2, 4, 6]) seedOverriddenEasy(dayBefore(REF, back));

  const r = repo.dayRead(REF, thinSleep());
  assert.equal(r.kind, "train");
  assert.equal(r.focus, "Lower body", "an opened day with nothing in it would be worse than the easy read");
  assert.equal(r.est_minutes, 60);
});

test("two is a coincidence — the easy read stands", () => {
  for (const back of [2, 4]) seedOverriddenEasy(dayBefore(REF, back));

  const r = repo.dayRead(REF, thinSleep());
  assert.equal(r.kind, "easy");
  assert.notEqual(r.decision.rule_code, "outcome_feedback_open");
  assert.equal(r.signals.easy_outcome_feedback.active, false);
  assert.equal(r.signals.easy_outcome_feedback.applied, false);
});

test("an easy morning they actually took easy resets the count", () => {
  // Three overruled mornings a week ago...
  for (const back of [6, 8, 10]) seedOverriddenEasy(dayBefore(REF, back));
  // ...then one they agreed with — an easy read, nothing above easy logged.
  seedMorningRead(dayBefore(REF, 4), "easy");

  const r = repo.dayRead(REF, thinSleep());
  assert.equal(r.kind, "easy", "agreeing with the read starts the count over");
  assert.equal(r.signals.easy_outcome_feedback.active, false);
  assert.equal(r.signals.easy_outcome_feedback.last_honored_easy, dayBefore(REF, 4));
  assert.deepEqual(r.signals.easy_outcome_feedback.overridden_and_fine, []);
});

test("sessions that went badly are not evidence that outrunning the read was fine", () => {
  for (const back of [2, 4, 6]) seedOverriddenEasy(dayBefore(REF, back), 2);

  const r = repo.dayRead(REF, thinSleep());
  assert.equal(r.signals.easy_outcome_feedback.active, false);
  assert.deepEqual(r.signals.easy_outcome_feedback.overridden_and_fine, []);
  assert.notEqual(r.decision.rule_code, "outcome_feedback_open");
});

test("an unrated session still counts — silence is not evidence of harm", () => {
  for (const back of [2, 4, 6]) seedOverriddenEasy(dayBefore(REF, back), null);

  const r = repo.dayRead(REF, thinSleep());
  assert.equal(r.decision.rule_code, "outcome_feedback_open");
  assert.equal(r.kind, "train");
});

test("nothing clinical is ever opened, whatever the history says", () => {
  for (const back of [2, 4, 6]) seedOverriddenEasy(dayBefore(REF, back));
  repo.addContextEvent({ kind: "injury", title: "Achilles niggle", start_date: dayBefore(REF, 5) });

  const r = repo.dayRead(REF, thinSleep());
  assert.notEqual(r.kind, "train");
  assert.equal(r.signals.easy_outcome_feedback.active, true, "the pattern is still on the board…");
  assert.equal(r.signals.easy_outcome_feedback.applied, false, "…and it is still not allowed to move this day");
});

test("a reduced week is a structure the athlete signed up for, not a read to outrun", () => {
  for (const back of [2, 4, 6]) seedOverriddenEasy(dayBefore(REF, back));
  const cycle = repo.scheduleRecoveryCycle({
    effective_on: dayBefore(REF, 1),
    recheck_on: dayBefore(REF, -5),
    exit_on: dayBefore(REF, -6),
    overlay: { working_set_fraction: 0.5 },
    reason: "A planned lighter week.",
  });
  repo.activateRecoveryCycle(cycle.id, REF);

  const r = repo.dayRead(REF, thinSleep());
  assert.equal(r.signals.easy_outcome_feedback.applied, false);
  assert.notEqual(r.decision.rule_code, "outcome_feedback_open");
});

test("the two ladders never compose into rest → train", () => {
  // Mornings this loop's SIBLING eased from rest to easy. They are the rest ladder's
  // evidence; counting them here would take the day two rungs in one window.
  for (const back of [2, 4, 6]) {
    seedMorningRead(dayBefore(REF, back), "easy", { outcome_feedback: { active: true, applied: true } });
    seedTrainingDay(dayBefore(REF, back));
    repo.setSessionFeedback(dayBefore(REF, back), { performance: 4 });
  }

  const r = repo.dayRead(REF, thinSleep());
  assert.equal(r.signals.easy_outcome_feedback.active, false, "a softened easy morning belongs to the rest ladder");
  assert.notEqual(r.decision.rule_code, "outcome_feedback_open");
});

test("the softening sustains itself: its own opened mornings keep the evidence alive", () => {
  // Two ordinary overruled easy mornings, then one this rule already opened and the
  // athlete trained through. Without that third kind counting, the window would empty
  // and the read would relapse on a ten-day cycle.
  for (const back of [6, 8]) seedOverriddenEasy(dayBefore(REF, back));
  seedMorningRead(dayBefore(REF, 2), "train", { easy_outcome_feedback: { active: true, applied: true } });
  seedTrainingDay(dayBefore(REF, 2));
  repo.setSessionFeedback(dayBefore(REF, 2), { performance: 4 });

  const r = repo.dayRead(REF, thinSleep());
  assert.equal(r.signals.easy_outcome_feedback.active, true);
  assert.equal(r.decision.rule_code, "outcome_feedback_open");
});

test("the derivation is null-safe and window-bounded", () => {
  assert.equal(easyOverrideSoftening(null, REF).active, false);
  assert.equal(easyOverrideSoftening({ recent: null }, REF).active, false);
  const outside = [12, 14, 16].map((back) => ({
    date: dayBefore(REF, back),
    read: "easy",
    outcome: "diverged",
    load: "hard",
    trained: true,
    softened: false,
    easy_softened: false,
  }));
  assert.equal(easyOverrideSoftening({ recent: outside }, REF).active, false, "ten closed days, and no further");
});

// ── 3. the push, and which caveats may still withdraw it ────────────────────

// A signal state the evidence positively backs, built from one strongly-rated session
// — the documented `unifiedState` seam, so the caveat classification is what is under
// test rather than whatever the fixture's wearable rows happen to imply.
const backedState = (date) =>
  buildUnifiedSignalState(date, [
    {
      dimension: "training_load_tolerance",
      field: "session_quality",
      date,
      source: "manual_session",
      direction: "support",
      summary: "Recent rated sessions came back strong.",
      voice: { key: "session_strong" },
    },
  ]);

const planDay = () =>
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);

test("a BOOKKEEPING caveat no longer withdraws the push", () => {
  planDay();
  const r = repo.dayRead(REF, thinSleep(), backedState(REF));

  assert.equal(r.kind, "train");
  assert.ok(r.signals.push_bias, "a chronic sleep trend is not a statement about today's capacity");
  assert.deepEqual(r.signals.push_bias.backed_by, ["session_quality"]);
  // The caveat is still SAID — the diet is about what vetoes, never about what is
  // hidden — and the sentence now opens with the reach rather than with a hedge.
  assert.match(r.why, /sleep/i);
  const lead = DAY_READ_LEAD_VARIANTS["planned_training:push_caveats"].find((variant) => r.why.startsWith(variant));
  assert.ok(lead, `expected a registered push lead, got ${JSON.stringify(r.why)}`);
  assert.equal(violatesReadingGrammar(r.why), null, r.why);
});

test("a SAFETY caveat still withdraws it — an injury being worked around", () => {
  planDay();
  repo.addContextEvent({ kind: "injury", title: "Shoulder strain", start_date: REF });

  const r = repo.dayRead(REF, thinSleep(), backedState(REF));
  assert.equal(r.signals.push_bias, undefined);
  for (const push of DAY_READ_WHY_VARIANTS.planned_training_push) {
    assert.equal(r.why.includes(push), false, `a day being worked around read as a push — ${push}`);
  }
  for (const lead of DAY_READ_LEAD_VARIANTS["planned_training:push_caveats"]) {
    assert.equal(r.why.startsWith(lead), false, `a day being worked around opened with the reach — ${lead}`);
  }
});

test("…and a reduced week still withdraws it", () => {
  planDay();
  const cycle = repo.scheduleRecoveryCycle({
    effective_on: dayBefore(REF, 1),
    recheck_on: dayBefore(REF, -5),
    exit_on: dayBefore(REF, -6),
    overlay: { working_set_fraction: 0.5 },
    reason: "A planned lighter week.",
  });
  repo.activateRecoveryCycle(cycle.id, REF);

  const r = repo.dayRead(REF, thinSleep(), backedState(REF));
  assert.equal(r.signals.push_bias, undefined, "reaching inside a reduced week is reaching against it");
});

test("a clean backed day is unchanged — it still takes the plain push wording", () => {
  planDay();
  const r = repo.dayRead(REF, { has_data: false, recovery: {} }, backedState(REF));
  assert.ok(r.signals.push_bias);
  assert.ok(DAY_READ_WHY_VARIANTS.planned_training_push.includes(r.why), `unexpected wording ${JSON.stringify(r.why)}`);
});

// ── 5. the earn path ───────────────────────────────────────────────────────

test("an unseconded caution is spoken, leaves the day open, and says what clears it", () => {
  planDay();
  // One caution, alone on the board: a watch, no hold, and — before this ruling — no
  // way for the read to mention it at all once the hold stopped firing.
  const oneCaution = buildUnifiedSignalState(REF, [
    {
      dimension: "training_load_tolerance",
      field: "run_intensity_discipline",
      date: REF,
      source: "cairn_hr_model",
      direction: "caution",
      summary: "Recent runs finished above this athlete's own easy ceiling.",
      voice: { key: "run_intensity_compressed", subject: "148 bpm" },
    },
  ]);
  assert.equal(oneCaution.action.directives.training, "proceed", "the fixture is the unseconded case");

  const r = repo.dayRead(REF, { has_data: false, recovery: {} }, oneCaution);
  assert.equal(r.kind, "train", "a noted caution is not a hold");

  // It leads with the caution's OWN athlete voice, carrying the athlete's own ceiling.
  const spoken = signalVoice({ key: "run_intensity_compressed", subject: "148 bpm" }).find((variant) =>
    r.why.startsWith(variant)
  );
  assert.ok(spoken, `expected the caution's voice to lead, got ${JSON.stringify(r.why)}`);
  // …then the lead that keeps the day open…
  assert.ok(
    DAY_READ_LEAD_VARIANTS["planned_training:noted_lead"].some((variant) => r.why.includes(variant)),
    `expected a registered noted lead, got ${JSON.stringify(r.why)}`
  );
  // …and closes with the concrete unlock, naming the ceiling rather than a date.
  const earn = DAY_READ_EARN_PATH_VARIANTS["planned_training:earn_path_intensity"].find((variant) =>
    r.why.endsWith(variant)
  );
  assert.ok(earn, `expected the intensity earn path, got ${JSON.stringify(r.why)}`);
  assert.match(r.why, /148 bpm/);
  assert.doesNotMatch(r.why, /\bby (?:Monday|Friday|next week)\b/i, "an unlock is a condition, never a deadline");
  assert.equal(violatesReadingGrammar(r.why), null, r.why);
});

test("a brake with no concrete unlock still says the day opens back up", () => {
  planDay();
  const vague = buildUnifiedSignalState(REF, [
    {
      dimension: "energy_fueling",
      field: "protein_gap",
      date: REF,
      source: "cairn_nutrition",
      direction: "caution",
      summary: "Fuelling has been thin across the recent window.",
    },
  ]);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} }, vague);
  assert.ok(
    DAY_READ_EARN_PATH_VARIANTS["planned_training:earn_path"].some((variant) => r.why.endsWith(variant)),
    `expected the general earn path, got ${JSON.stringify(r.why)}`
  );
  assert.equal(violatesReadingGrammar(r.why), null, r.why);
});

test("a hold still holds, and now says what would lift it", () => {
  planDay();
  const seconded = buildUnifiedSignalState(REF, [
    {
      dimension: "training_load_tolerance",
      field: "run_intensity_discipline",
      date: REF,
      source: "cairn_hr_model",
      direction: "caution",
      summary: "Recent runs finished above this athlete's own easy ceiling.",
      voice: { key: "run_intensity_compressed", subject: "148 bpm" },
    },
    {
      dimension: "recovery_capacity",
      field: "sleep_trend",
      date: REF,
      source: "apple",
      direction: "caution",
      summary: "Sleep across the recent window is averaging under six hours.",
      voice: { key: "sleep_short" },
    },
  ]);
  assert.equal(seconded.action.directives.training, "hold_aggression");

  const r = repo.dayRead(REF, { has_data: false, recovery: {} }, seconded);
  // It still leads with the BRAKE's own voice — the dimension the hold names, not the
  // day's posture voice. (The unseconded branch's version of this is pinned in
  // dayRead.test.js, on the fixture where the posture voice is a SUPPORT one.)
  assert.equal(seconded.action.directives.training_source, "recovery_capacity");
  assert.ok(
    signalVoice({ key: "sleep_short" }).some((variant) => r.why.startsWith(variant)),
    `expected the brake's voice to lead, got ${JSON.stringify(r.why)}`
  );
  assert.ok(
    DAY_READ_LEAD_VARIANTS["planned_training:hold_lead"].some((variant) => r.why.includes(variant)),
    `expected the hold lead, got ${JSON.stringify(r.why)}`
  );
  // The hold's own caveat is still there — the earn path is added to it, never in
  // place of it.
  assert.match(r.why, /\b(?:load|volume)\b/i);
  const earn = DAY_READ_EARN_PATH_VARIANTS["planned_training:earn_path"].find((variant) => r.why.endsWith(variant));
  assert.ok(earn, `a hold must say what lifts it, got ${JSON.stringify(r.why)}`);
  assert.equal(violatesReadingGrammar(r.why), null, r.why);
});

// ── the vocabulary, held to the constitution ───────────────────────────────

test("every new phrasing rotates, and holds the reading grammar", () => {
  const sets = [
    ["why:outcome_feedback_open", DAY_READ_WHY_VARIANTS.outcome_feedback_open],
    ["reasons:outcome_feedback_open", DAY_READ_OUTCOMES.outcome_feedback_open.reasons],
    ["lead:noted", DAY_READ_LEAD_VARIANTS["planned_training:noted_lead"]],
    ["lead:push_caveats", DAY_READ_LEAD_VARIANTS["planned_training:push_caveats"]],
    ...Object.entries(DAY_READ_EARN_PATH_VARIANTS).map(([key, variants]) => [`earn:${key}`, variants]),
  ];
  for (const [label, variants] of sets) {
    assert.ok(Array.isArray(variants) && variants.length >= 4, `${label} needs at least four phrasings`);
    assert.equal(new Set(variants).size, variants.length, `${label} has a duplicate phrasing`);
    for (const text of variants) {
      assert.equal(violatesReadingGrammar(text), null, `${label} breaks the reading grammar: ${text}`);
      assert.doesNotMatch(text, /\bthe athlete\b/i, `${label} speaks about them, not to them: ${text}`);
      assert.doesNotMatch(text, /\byou (?:must|have to|need to)\b/i, `${label} reads as a gate: ${text}`);
    }
  }

  // …and each carries the one idea it exists to carry, whichever phrasing lands.
  for (const [key, concept] of Object.entries(DAY_READ_EARN_PATH_CONCEPT)) {
    for (const text of DAY_READ_EARN_PATH_VARIANTS[key]) assert.match(text, concept, `${key} drifted: ${text}`);
  }
  for (const key of ["planned_training:noted_lead", "planned_training:push_caveats"]) {
    for (const text of DAY_READ_LEAD_VARIANTS[key]) {
      assert.match(text, DAY_READ_LEAD_CONCEPT[key], `${key} drifted: ${text}`);
      assert.doesNotMatch(text, /[.!?]$/, `${key} is a lead, not a sentence: ${text}`);
    }
  }
  for (const text of [
    ...DAY_READ_WHY_VARIANTS.outcome_feedback_open,
    ...DAY_READ_OUTCOMES.outcome_feedback_open.reasons,
  ]) {
    assert.match(text, DAY_READ_REQUIRED_CONCEPT.outcome_feedback_open, `the opened read lost its evidence: ${text}`);
  }

  // Consecutive days always differ, so a stable pattern does not print one sentence
  // for a fortnight — the whole reason these are sets.
  for (const [key, variants] of Object.entries(DAY_READ_EARN_PATH_VARIANTS)) {
    const seen = [];
    for (let back = 6; back >= 0; back--) seen.push(pickDayVariant(variants, dayBefore(REF, back), key));
    assert.ok(new Set(seen).size >= 3, `${key}: a week must not cycle through one or two`);
  }
});
