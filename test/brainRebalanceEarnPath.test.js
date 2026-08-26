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

// An easy morning the athlete took well above easy, and rated fine.
const seedOverriddenEasy = (date, performance = 4) => {
  seedMorningRead(date, "easy");
  seedTrainingDay(date);
  if (performance != null) repo.setSessionFeedback(date, { performance });
};

// A world the ladder can actually MOVE. Two conditions have to hold at once, and
// only one of them is about the pattern:
//
//   1. today's rule read is an EASY one in SOFTENABLE_EASY_CODES, and
//   2. there is a real plan day due, because the ladder opens the session that was
//      already programmed and never invents one — with nothing programmed the read
//      stays easy movement on the easy clock, whatever the history says.
//
// Five consecutive loading days is the accumulated-load CEILING, which with nothing
// corroborating reads easy under `accumulated_load_rest` — an easy read that, unlike
// the chronic-sleep watch and the unprogrammed floor, survives a due plan day. So this
// is the shape where the ladder has both an easy read to open and a session to open it
// to, and it is the shape the ceiling comment names: at the ceiling the day may still
// be opened, but only by `overridden_and_fine` evidence.
const seedOpenableWorld = (performance = 4) => {
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  for (const back of [1, 2, 3, 4, 5]) seedOverriddenEasy(dayBefore(REF, back), performance);
};
const OPENABLE_MORNINGS = [5, 4, 3, 2, 1].map((back) => dayBefore(REF, back));

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

test("easy mornings taken above easy without cost open today's easy read to a training day", () => {
  seedOpenableWorld();

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
  assert.deepEqual(r.signals.easy_outcome_feedback.overridden_and_fine, OPENABLE_MORNINGS);
  assert.equal(r.signals.easy_outcome_feedback.last_honored_easy, null);
});

test("the opened day takes the session that was actually due", () => {
  seedOpenableWorld();

  const r = repo.dayRead(REF, thinSleep());
  assert.equal(r.kind, "train");
  assert.equal(r.decision.rule_code, "outcome_feedback_open");
  assert.equal(r.focus, "Lower body", "an opened day with nothing in it would be worse than the easy read");
  assert.equal(r.est_minutes, 60);
});

test("with nothing programmed there is no session to open — the pattern holds and the day stays easy", () => {
  // Same pattern, same evidence, no plan. The ladder opens the session that was
  // already due; it never invents one, so the read keeps its own easy clock and the
  // pattern stays on the board unapplied.
  for (const back of [2, 4, 6]) seedOverriddenEasy(dayBefore(REF, back));

  const r = repo.dayRead(REF, thinSleep());
  assert.equal(r.kind, "easy");
  assert.equal(r.decision.rule_code, "chronic_sleep_watch");
  assert.equal(r.focus, null);
  assert.equal(r.est_minutes, 25, "the easy clock, not an invented sixty-minute session");
  assert.equal(r.signals.easy_outcome_feedback.active, true, "the pattern is still on the board…");
  assert.equal(r.signals.easy_outcome_feedback.applied, false, "…and it had nothing to move this day to");
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
  seedOpenableWorld(null);

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
  // and the read would relapse on a ten-day cycle. The two unread days either side are
  // load only — they carry the streak to the ceiling so there is an easy read to open,
  // and say nothing about the pattern.
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  for (const back of [4, 5]) seedTrainingDay(dayBefore(REF, back));
  for (const back of [1, 3]) seedOverriddenEasy(dayBefore(REF, back));
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

// ── 2b. …and what the athlete said THIS MORNING outranks all of it ─────────
//
// The clinical floor the ladder consults (`clinicallyDriven`) probes
// `health_constraints`, and a morning check-in does not land there — energy and
// sleep_feel go to `recovery_capacity`, soreness to `training_load_tolerance`. So an
// athlete who had just reported feeling wrecked could have their easy read opened into
// a full session by a twelve-day pattern, with a `why` that never mentioned the thing
// they had said an hour earlier. Check-ins INFORM; they are never the thing overruled.
//
// A fresh same-day statement now HOLDS the softening. It is a veto and nothing else:
// the read stays exactly where the rules put it, and the sentence gains a clause
// saying whose word kept it there.

// The documented `unifiedState` seam: a state built from no observations at all, so
// what the DB check-in does to the read is the veto's doing rather than the posture's.
const openState = (date) => buildUnifiedSignalState(date, []);

test("a sore morning holds the softening, and the read says whose word held it", () => {
  // The live production path. soreness >= 4 is a constraint on load tolerance, which
  // makes the day easy through the protect rule — a SOFTENABLE_EASY code — so this is
  // exactly the shape the defect was reported against: the athlete says they are wrecked
  // and a twelve-day pattern hands them a sixty-minute session anyway.
  for (const back of [2, 4, 6]) seedOverriddenEasy(dayBefore(REF, back));
  repo.addCheckin(REF, { energy: 3, sleep_feel: 3, mood: 3, soreness: 5 });

  const r = repo.dayRead(REF, thinSleep());

  assert.equal(r.kind, "easy", "the day they said was heavy is not opened by a fortnight of other days");
  assert.equal(r.decision.rule_code, "acute_signal_protection", "the rule's own read stands, untouched");
  assert.equal(r.signals.easy_outcome_feedback.active, true, "the pattern is still on the board…");
  assert.equal(r.signals.easy_outcome_feedback.applied, false, "…and it did not get to move this day");
  assert.equal(r.signals.easy_outcome_feedback.held_by_statement, "felt_soreness");
  // The rule still says what today is about, and the held clause says why history did
  // not argue with it — a registered phrasing, not a literal, holding the grammar.
  assert.ok(
    signalVoice({ key: "soreness_high" }).some((variant) => r.why.startsWith(variant)),
    `the rule's own sentence should open the read: ${JSON.stringify(r.why)}`
  );
  assert.ok(
    DAY_READ_WHY_VARIANTS.outcome_feedback_held.some((variant) => r.why.endsWith(variant)),
    `no registered held phrasing closed the read: ${JSON.stringify(r.why)}`
  );
  assert.equal(violatesReadingGrammar(r.why), null, r.why);
});

test("a run-down check-in is never opened into a session, by either mechanism", () => {
  // TWO mechanisms answer this morning, and the athlete is entitled to both. On the
  // ordinary path `lowSubjective` produces a rest read from a rule ABOVE the easy
  // ladder, which is what this case pins; the veto's own energy arm is what answers the
  // day a caller SCOPES the state past that rule (the documented `unifiedState` seam,
  // where a protect posture can land on easy with a run-down check-in still in the DB).
  // Neither is redundant, and the law they enforce between them is the one the athlete
  // experiences: a morning they called wrecked is never opened into a session.
  for (const back of [2, 4, 6]) seedOverriddenEasy(dayBefore(REF, back));
  repo.addCheckin(REF, { energy: 2, sleep_feel: 3, mood: 3, soreness: 2 });

  const r = repo.dayRead(REF, thinSleep(), openState(REF));
  assert.equal(r.kind, "rest");
  assert.equal(r.decision.rule_code, "felt_run_down_rest");
  assert.equal(r.signals.easy_outcome_feedback.applied, false);
});

test("a symptom they reported TODAY holds it; the same watch left unspoken does not", () => {
  seedOpenableWorld();
  repo.reportTrainingSymptom({ area_text: "left knee", onset_on: REF, report_text: "left knee is grumbling today" });

  const spoken = repo.dayRead(REF, thinSleep(), openState(REF));
  assert.equal(spoken.kind, "easy");
  assert.equal(spoken.signals.easy_outcome_feedback.held_by_statement, "symptom_report");
  // The sentence follows the door the veto came through. There is no check-in on this
  // morning at all, so a phrasing that named one would be describing something the
  // athlete never did.
  assert.ok(
    DAY_READ_WHY_VARIANTS.outcome_feedback_held_symptom.some((variant) => spoken.why.endsWith(variant)),
    `no registered symptom-arm phrasing closed the read: ${JSON.stringify(spoken.why)}`
  );
  assert.doesNotMatch(spoken.why, /check-in/i, "there is no check-in on this morning to credit");
  assert.equal(violatesReadingGrammar(spoken.why), null, spoken.why);

  // The SAME open watch, last spoken about a fortnight ago. `stated_freshness` is the
  // ladder that means "how current is their own account", and an old account is not a
  // statement about this morning — so the pattern opens the day exactly as it would
  // with no watch at all.
  resetTables(...WORLD, "training_symptom_events", "symptom_reports", "movement_tolerance_observations");
  seedOpenableWorld();
  repo.reportTrainingSymptom({ area_text: "left knee", onset_on: dayBefore(REF, 14) });

  const stale = repo.dayRead(REF, thinSleep(), openState(REF));
  assert.equal(stale.kind, "train", "a fortnight-old account cannot hold today");
  assert.equal(stale.signals.easy_outcome_feedback.applied, true);
  assert.equal(stale.signals.easy_outcome_feedback.held_by_statement, undefined);
});

test("no check-in changes nothing — absence of a statement is not a statement", () => {
  seedOpenableWorld();

  const r = repo.dayRead(REF, thinSleep(), openState(REF));
  assert.equal(r.kind, "train", "the softening behaves exactly as it did before the veto existed");
  assert.equal(r.decision.rule_code, "outcome_feedback_open");
  assert.equal(r.signals.easy_outcome_feedback.applied, true);
  assert.equal(r.signals.easy_outcome_feedback.held_by_statement, undefined);
});

test("a fine morning is not a veto — a good check-in still opens the day", () => {
  seedOpenableWorld();
  repo.addCheckin(REF, { energy: 4, sleep_feel: 4, mood: 4, soreness: 2 });

  const r = repo.dayRead(REF, thinSleep(), openState(REF));
  assert.equal(r.kind, "train");
  assert.equal(r.decision.rule_code, "outcome_feedback_open");
  assert.equal(r.signals.easy_outcome_feedback.applied, true);
  assert.equal(r.signals.easy_outcome_feedback.held_by_statement, undefined);
});

test("the veto only ever HOLDS — it never brakes a day the rules read as train", () => {
  // Nothing for the pattern to open: the day already reads train off the plan, and the
  // athlete has a symptom on record they spoke about this morning. A veto that could
  // reach here would be a new rule, and it is not one.
  planDay();
  repo.reportTrainingSymptom({ area_text: "left knee", onset_on: REF });

  const r = repo.dayRead(REF, thinSleep(), openState(REF));
  assert.equal(r.kind, "train");
  assert.equal(r.decision.rule_code, "planned_training");
  assert.equal(r.signals.easy_outcome_feedback?.held_by_statement, undefined);
  assert.ok(
    ![...DAY_READ_WHY_VARIANTS.outcome_feedback_held, ...DAY_READ_WHY_VARIANTS.outcome_feedback_held_symptom].some(
      (variant) => r.why.includes(variant)
    ),
    "the held sentence belongs to a held softening, not to every read with a statement on it"
  );
});

test("both held sets rotate, credit the athlete, and hold the constitution", () => {
  for (const key of ["outcome_feedback_held", "outcome_feedback_held_symptom"]) {
    const arm = DAY_READ_WHY_VARIANTS[key];
    assert.ok(arm.length >= 3, `${key}: a stable input fires a stable rule — one literal reads as a broken app`);
    assert.equal(new Set(arm).size, arm.length);
    for (const text of arm) {
      assert.equal(violatesReadingGrammar(text), null, `${key} breaks the reading grammar: ${JSON.stringify(text)}`);
      assert.match(text, DAY_READ_REQUIRED_CONCEPT[key], `${key} lost the sentence's own meaning: ${text}`);
      assert.match(text, /[.!?]$/);
      assert.doesNotMatch(text, /\b(?:must|have to|need to|should)\b/i, `${key} reads as an instruction: ${text}`);
    }
    const rotation = ["2026-03-15", "2026-03-16", "2026-03-17", "2026-03-18"].map((day) =>
      pickDayVariant(arm, day, key)
    );
    for (let i = 1; i < rotation.length; i++) {
      assert.notEqual(rotation[i], rotation[i - 1], `${key}: repeated the previous morning's sentence`);
    }
  }
  // The symptom arm may never claim a check-in — the veto fires there with no check-in
  // row on the day at all, which is the defect this split exists for.
  for (const text of DAY_READ_WHY_VARIANTS.outcome_feedback_held_symptom) {
    assert.doesNotMatch(text, /check-in/i, `the symptom arm named a check-in that may not exist: ${text}`);
  }
  const set = DAY_READ_WHY_VARIANTS.outcome_feedback_held;
  const days = ["2026-03-15", "2026-03-16", "2026-03-17", "2026-03-18"];
  const landed = days.map((day) => pickDayVariant(set, day, "outcome_feedback_held"));
  for (let i = 1; i < landed.length; i++) {
    assert.notEqual(landed[i], landed[i - 1], `${days[i]} repeated the previous morning's sentence`);
  }
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
