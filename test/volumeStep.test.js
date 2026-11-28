// The volume step: when the athlete's own log has earned it, the coach adds ONE set to ONE
// lift already in the plan, through the ordinary autonomy path, with Undo — and otherwise
// does nothing. It edits a real person's plan by itself, so when in doubt it does nothing.
// Invariants:
//   1. lead: one set quiet-applies with the server-owned Undo and a falsifiable expectation;
//      announce_first announces; review_everything holds exactly one draft; one change in flight;
//   2. one step a pass, one group a calendar week, and the next step only once the last was
//      trained twice (settling);
//   3. bounds: ~1.2x the lift's own habit (and the catch-up's four sets), twenty effective sets
//      a group, no habit on record means no raise;
//   4. every protective state holds it (an affirmed cut, cut pressure, fuel protection, an owed
//      volume restore, a plan adaptation, a recovery week upcoming or drafted, deload-due, the
//      race taper, a trip) — and the owner's affirmed cut keeps it dormant;
//   5. pain, an injury, a constraint note, an untested slot, a session composed on the day,
//      a regressing or grinding lift, and a harm day each keep the group or lift untouched;
//   6. Undo / Hold / discard is remembered per group until the intent changes or six weeks pass;
//   7. any read that fails changes nothing; the premise check says fits / gone / held / unknown;
//   8. the words keep the reading grammar.
// State is built from REAL rows through the repo's writers; no read is stubbed. Synthetic
// fixtures only. Deterministic and offline (see test/run.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db, repo } from "./_seed.js";
import {
  VOLUME_STEP_AGENT,
  VOLUME_STEP_INSTRUCTION,
  groupHabitualWeeklySets,
  previewVolumeStep,
  rankVolumeStepGroups,
  settleVolumeStep,
  volumeStepProposalPayload,
  volumeStepStillFits,
  volumeStepWords,
} from "../dist/domain/brain/volume-step.js";
import { applyDueAnnouncedDecisions, revertDecision } from "../dist/domain/brain/autonomy-service.js";
import { readPlanCoverage } from "../dist/repo/plan-coverage.js";
import { plannedWeeklyGroupSets } from "../dist/repo/plan-quality.js";
import { awaitingBrainDecisions, listBrainExpectations } from "../dist/repo/brain-decisions.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { volumeToleranceRead } from "../dist/repo/volume-tolerance.js";
import { getProgramState } from "../dist/repo/program-state.js";
import { lightWeekExemption } from "../dist/repo/volume-floor-context.js";
import { cutReaffirmation } from "../dist/repo/cut-target.js";
import { readCutPressureStrict } from "../dist/repo/progression.js";
import { currentUnderfuelingRead } from "../dist/repo/underfueling-snapshot.js";
import { upsertAttentionSchedule } from "../dist/repo/attention.js";
import { scheduleRecoveryCycle } from "../dist/repo/recovery-cycles.js";
import { RECOVERY_WEEK_INSTRUCTION } from "../dist/repo/recovery-week.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";

const STRENGTH = { training_intent: { priorities: ["strength", "longevity"], endurance_role: "none" } };
const today = () => localDateISO();
const day = (delta) => addDaysISO(today(), delta);

// A week that clears every floor for a strength priority. Chest is Bench 3 + Incline 3 +
// Cable Fly 4 (ten sets, at its floor): nothing is short, so coverage has no gap to close
// and the volume step is the only thing that can move the week.
function week({ chestFill = 0, flySets = 4, benchSets = 3, inclineSets = 3 } = {}) {
  return [
    {
      day_number: 1,
      name: "Upper",
      items: [
        { exercise: "Barbell Bench Press", muscle_group: "chest", sets: benchSets, rep_low: 6, rep_high: 8 },
        { exercise: "Incline Dumbbell Press", muscle_group: "chest", sets: inclineSets, rep_low: 8, rep_high: 10 },
        { exercise: "Cable Fly", muscle_group: "chest", sets: flySets, rep_low: 10, rep_high: 12 },
        ...(chestFill > 0
          ? [{ exercise: "Machine Chest Press", muscle_group: "chest", sets: chestFill, rep_low: 8, rep_high: 12 }]
          : []),
        { exercise: "Barbell Overhead Press", muscle_group: "shoulders", sets: 4, rep_low: 6, rep_high: 8 },
        { exercise: "Dumbbell Lateral Raise", muscle_group: "shoulders", sets: 4, rep_low: 12, rep_high: 15 },
      ],
    },
    {
      day_number: 2,
      name: "Lower",
      items: [
        { exercise: "Back Squat", muscle_group: "quads", sets: 4, rep_low: 5, rep_high: 8 },
        { exercise: "Bulgarian Split Squat", muscle_group: "quads", sets: 4, rep_low: 8, rep_high: 10 },
        { exercise: "Romanian Deadlift", muscle_group: "hamstrings", sets: 4, rep_low: 8, rep_high: 10 },
        { exercise: "Lying Leg Curl", muscle_group: "hamstrings", sets: 2, rep_low: 10, rep_high: 12 },
        { exercise: "Hip Thrust", muscle_group: "glutes", sets: 4, rep_low: 8, rep_high: 12 },
      ],
    },
    {
      day_number: 3,
      name: "Pull",
      items: [
        { exercise: "Seated Cable Row", muscle_group: "back", sets: 5, rep_low: 8, rep_high: 12 },
        { exercise: "Lat Pulldown", muscle_group: "back", sets: 5, rep_low: 8, rep_high: 12 },
        { exercise: "Hanging Leg Raise", muscle_group: "core", sets: 3, rep_low: 8, rep_high: 12 },
      ],
    },
  ];
}
// The same plan with chest cut to a gap: coverage's own read then stands (the parity check).
const shortChestWeek = () =>
  week().map((d) => ({ ...d, items: d.items.map((i) => (i.muscle_group === "chest" ? { ...i, sets: 1 } : i)) }));

const CHEST_LIFTS = ["Barbell Bench Press", "Incline Dumbbell Press", "Cable Fly"];
const LOG_DAYS = [40, 33, 26, 12, 5]; // one gap in the weeks: no six-week loaded streak
const OUTCOME_DAYS = [26, 12, 5]; // three reconciled sessions inside the tolerance window

// One lift's session: `sets` working sets at `weight`.
function logLift(exercise, daysAgo, weight, sets, rir) {
  for (let i = 0; i < sets; i++)
    repo.logSetByName({ exercise, weight, reps: 8, date: day(-daysAgo), ...(rir == null ? {} : { rir }) });
}

// A reconciled outcome for one session, the shape daily-reconciliation writes (as
// test/volumeTolerance.test.js seeds it): every authored set carried at a held-or-rising load.
function seedOutcome(date, doses) {
  const session = repo.getOrCreateSession(date, null);
  const composition = db
    .prepare(
      `INSERT INTO daily_session_compositions
        (version, session_id, date, source, status, plan_day_id, title, items_json, request_fingerprint)
       VALUES (1, ?, ?, 'athlete_override', 'active', NULL, 'Fixture', '[]', ?)`
    )
    .run(session.id, date, `vs-${date}`);
  db.prepare(
    `INSERT INTO daily_session_outcomes (composition_id, session_id, date, status, facts_json) VALUES (?, ?, ?, 'completed', ?)`
  ).run(
    composition.lastInsertRowid,
    session.id,
    date,
    JSON.stringify({
      schema_version: 4,
      dose_context: { comparable: true, non_comparable_reasons: [] },
      dose_evidence: doses,
      skipped: [],
    })
  );
  db.prepare(`UPDATE daily_session_compositions SET status = 'superseded' WHERE id = ?`).run(
    composition.lastInsertRowid
  );
}

function dose(exercise, { planned, done, target, recent }) {
  return {
    exercise,
    prescribed: { sets: planned, rep_low: 6, rep_high: 8, target_weight: target, target_seconds: null },
    achieved: {
      sets: done,
      top_weight: target,
      top_reps: 8,
      top_seconds: null,
      sets_detail: Array.from({ length: done }, () => ({ weight: target, reps: 8, duration_sec: null })),
    },
    comparable: true,
    non_comparable_reasons: [],
    challenge_verdict: "met",
    full_load_reference: {
      sets: planned,
      target_weight: target,
      target_seconds: null,
      rep_low: 6,
      recent_working_weight: recent,
      recent_working_seconds: null,
    },
  };
}

// The chest as the log has it: five sessions of rising weights at `sets` working sets a
// lift (the habit), and a reconciled outcome for the last three that carried every set.
// `logDays` can sit past the 56-day habit window (no habit on record).
// `planned` is what the plan authors for each lift (the log carried `sets` of each); `extra` is
// a further chest lift the athlete does that the plan does not carry (it shapes the group's
// habitual weekly volume, not any plan lift's habit).
function seedChest({
  sets = 4,
  logDays = LOG_DAYS,
  flyWeights = null,
  flyRir = null,
  planned = { "Barbell Bench Press": 3, "Incline Dumbbell Press": 3, "Cable Fly": 4 },
  extra = 4,
} = {}) {
  for (const name of [...CHEST_LIFTS, "Pec Deck"]) repo.upsertExercise({ name, muscle_group: "chest", mode: "reps" });
  const weights = { "Barbell Bench Press": 100, "Incline Dumbbell Press": 60, "Cable Fly": 30 };
  logDays.forEach((daysAgo, i) => {
    for (const name of CHEST_LIFTS) {
      // HELD loads (the volume step is for a movement that is holding: a climbing one needs
      // nothing), every set carried.
      const weight = name === "Cable Fly" && flyWeights ? flyWeights[i] : weights[name];
      logLift(name, daysAgo, weight, sets, name === "Cable Fly" ? flyRir : null);
    }
    if (extra > 0) logLift("Pec Deck", daysAgo, 50, extra);
  });
  for (const daysAgo of OUTCOME_DAYS) {
    seedOutcome(
      day(-daysAgo),
      CHEST_LIFTS.map((name) => {
        const w = weights[name];
        return dose(name, { planned: planned[name], done: sets, target: w, recent: w });
      })
    );
  }
}

// The plan with settled prescriptions (written long ago, trained since), a lead mode and the
// priority, and the chest log. Returns nothing; preconditions are asserted.
function base({ leadMode = "lead", plan = week(), chest = {}, drivePlan = true } = {}) {
  repo.setSettings({ lead_mode: leadMode });
  repo.setProfile(STRENGTH);
  repo.replacePlan(plan);
  // Prescriptions written long ago (before every log below): each slot is tested.
  db.prepare(`UPDATE plan_items SET prescribed_at = ?`).run(day(-200));
  seedChest(chest);
  if (drivePlan) {
    assert.deepEqual(
      readPlanCoverage().standing,
      [],
      "precondition: the plan leaves no gap, coverage has nothing to close"
    );
    assert.ok(volumeToleranceRead(today()), "precondition: the log vouches for the plan's sets");
    if (!chest.logDays) {
      // A log long past the read's window forms no unit at all (the no-habit case below).
      const flat = getProgramState(today()).capability?.units?.find((u) => u.key === "horizontal-push:flat");
      assert.equal(flat?.verdict, "holding", "precondition: the flat press is holding");
      assert.equal(flat?.in_plan, true);
      assert.deepEqual(flat?.qualifiers, [], "precondition: nothing explains the hold");
    }
    assert.equal(lightWeekExemption(today()), null, "precondition: no light week");
    assert.notEqual(getProgramState(today()).mesocycle.phase, "deload-due", "precondition: no deload is earned");
  }
}

const rows = () =>
  db.prepare(`SELECT id, status FROM plan_proposals WHERE agent = ? ORDER BY id`).all(VOLUME_STEP_AGENT);
const openRows = () => rows().filter((row) => row.status === "draft");
const setsOf = (name, dayNumber = 1) =>
  repo
    .getPlan()
    .find((d) => d.day_number === dayNumber)
    .items.find((i) => i.exercise === name)?.sets;
const benchSets = () => setsOf("Barbell Bench Press");

// Everything a pass could write, in one comparable value.
function snapshot() {
  const count = (sql) => db.prepare(sql).get().n;
  return JSON.stringify({
    plan: repo.getPlan(),
    steps: rows(),
    proposals: count(`SELECT COUNT(*) AS n FROM plan_proposals`),
    decisions: count(`SELECT COUNT(*) AS n FROM brain_decisions`),
    rollbacks: count(`SELECT COUNT(*) AS n FROM brain_rollbacks`),
  });
}

// A step older than this week: its answer and its settling are what is left of it.
function ageStep(proposalId, daysAgo) {
  db.prepare(`UPDATE plan_proposals SET created_at = datetime('now', ?) WHERE id = ?`).run(
    `-${daysAgo} days`,
    proposalId
  );
  db.prepare(
    `UPDATE brain_decisions SET created_at = datetime('now', ?), effective_date = ?
      WHERE source_ref_type = 'plan_proposal' AND source_ref_key = ?`
  ).run(`-${daysAgo} days`, day(-daysAgo), String(proposalId));
}

function assertHouseVoice(...texts) {
  for (const text of texts) {
    assert.equal(violatesReadingGrammar(text), null, text);
    assert.doesNotMatch(text, /\bmust\b|\bshould\b|\bscore\b|\d/i, text);
  }
}

// ---- 1. the step ----------------------------------------------------------------

test("lead: one set on one lift quiet-applies, with Undo and an expectation, and says what earned it", () => {
  base();
  const out = settleVolumeStep({ act: true });
  assert.equal(out.status, "routed");
  assert.equal(out.tier, "quiet_apply");
  assert.equal(out.group, "chest");
  assert.equal(out.lift, "Barbell Bench Press");
  assert.equal(benchSets(), 4, "one set on one lift");
  assert.equal(setsOf("Incline Dumbbell Press"), 3, "and nothing else");
  assert.equal(setsOf("Cable Fly"), 4);
  assert.match(out.summary, /one more set/i);
  assert.match(out.summary, /Barbell Bench Press/);
  assert.match(out.explanation, /\bchest\b/);
  assert.match(out.explanation, /held or rising|same weight or heavier|steady or rising/);
  assert.match(out.explanation, /Undo/);
  assertHouseVoice(out.summary, out.explanation);

  const proposal = repo.getProposal(out.proposal_id);
  assert.equal(proposal.status, "applied");
  assert.equal(proposal.agent, VOLUME_STEP_AGENT);
  assert.equal(proposal.instruction, VOLUME_STEP_INSTRUCTION);
  const decision = db.prepare(`SELECT * FROM brain_decisions WHERE id = ?`).get(out.decision_id);
  assert.equal(
    decision.autonomy_tier,
    "quiet_apply",
    "a plus-one-set change on an existing lift is a bounded training_target"
  );
  assert.equal(decision.reversible, 1, "the server-owned Undo rides along");
  assert.ok(
    db.prepare(`SELECT 1 FROM brain_rollbacks WHERE decision_id = ?`).get(out.decision_id),
    "with its snapshot"
  );
  assert.ok(
    listBrainExpectations({ decisionId: out.decision_id }).some(
      (e) => e.metric_key === "exercise_target_completion" && e.subject_key === "Barbell Bench Press"
    ),
    "a falsifiable expectation: the lift gets done"
  );
  assert.equal(awaitingBrainDecisions().length, 0, "nothing is waiting on the athlete");
});

test("Undo puts the week back", () => {
  base();
  const out = settleVolumeStep({ act: true });
  assert.equal(benchSets(), 4);
  assert.equal(revertDecision(out.decision_id).ok, true);
  assert.equal(benchSets(), 3, "the plan is as it was");
});

test("one group a calendar week: a second pass the same week changes nothing", () => {
  base();
  assert.equal(settleVolumeStep({ act: true }).status, "routed");
  const before = snapshot();
  const again = settleVolumeStep({ act: true });
  assert.equal(again.status, "held");
  assert.equal(again.hold, "week_used");
  assert.equal(snapshot(), before);
  assert.equal(rows().length, 1);
});

test("settling: the next step waits until the last was trained twice, then comes on the next lift", () => {
  base({ chest: { extra: 0 } });
  const first = settleVolumeStep({ act: true });
  assert.equal(first.lift, "Barbell Bench Press");
  ageStep(first.proposal_id, 9); // last week's step; the bench was trained once since (day -5)
  const waiting = settleVolumeStep({ act: true });
  assert.equal(waiting.status, "settling");
  assert.ok(waiting.blocked.some((b) => b.group === "chest" && b.code === "settling"));
  assert.equal(rows().length, 1);
  // Trained a second time since it landed, every written set carried at the held load: settled.
  // The bench (four sets, a habit of four) may take one more, to five — one above its habit —
  // since the flat press is still holding (a climb would need nothing).
  logLift("Barbell Bench Press", 3, 100, 4);
  const next = settleVolumeStep({ act: true });
  assert.equal(next.status, "routed", JSON.stringify(next));
  assert.equal(next.lift, "Barbell Bench Press");
  assert.equal(benchSets(), 5);
});

// A step may now sit above the habit, so it must be CARRIED: the first two sessions since it
// landed took every written set at a held-or-risen load, or the group does not step again.
function landAndAge() {
  base();
  const first = settleVolumeStep({ act: true });
  assert.equal(first.status, "routed");
  ageStep(first.proposal_id, 9); // the bench was trained once since (day -5)
  return first;
}

test("a step that was not carried blocks the next: a session short of the written sets", () => {
  landAndAge();
  // The session since the step landed (day -5) dropped a set: three of the four written.
  db.prepare(
    `DELETE FROM logged_sets WHERE id = (SELECT MAX(ls.id) FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
       JOIN exercises e ON e.id = ls.exercise_id WHERE e.name = 'Barbell Bench Press' AND s.date = ?)`
  ).run(day(-5));
  logLift("Barbell Bench Press", 3, 100, 4);
  const out = settleVolumeStep({ act: true });
  assert.equal(out.status, "settling");
  assert.ok(
    out.blocked.some((b) => b.group === "chest" && b.code === "step_not_carried"),
    JSON.stringify(out.blocked)
  );
  assert.equal(rows().length, 1, "no further step");
  assert.equal(benchSets(), 4, "and the earlier step is not reverted from here");
});

test("a step that was not carried blocks the next: the load fell", () => {
  landAndAge();
  db.prepare(
    `UPDATE logged_sets SET weight = 80 WHERE id IN (SELECT ls.id FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
       JOIN exercises e ON e.id = ls.exercise_id WHERE e.name = 'Barbell Bench Press' AND s.date = ?)`
  ).run(day(-5));
  logLift("Barbell Bench Press", 3, 100, 4);
  const out = settleVolumeStep({ act: true });
  assert.equal(out.status, "settling");
  assert.ok(
    out.blocked.some((b) => b.code === "step_not_carried"),
    JSON.stringify(out.blocked)
  );
  assert.equal(rows().length, 1);
});

test("a coverage change on the group settles the same way", () => {
  base();
  // A coverage change that landed on chest (as plan-coverage.ts writes it) and has not been trained twice.
  const draft = repo.createProposal("coverage-check", "coverage: the plan as written leaves a gap", "", {
    summary: "On Upper, one more set of Cable Fly.",
    rationale: "x",
    changes: [{ day_number: 1, exercise: "Cable Fly", sets: 4, reason: "x" }],
    coverage_gap: {
      version: 3,
      as_of: today(),
      elements: [{ key: "group:chest", kind: "group", fingerprint: "fp", group: "chest" }],
      basis: [],
    },
  });
  db.prepare(`UPDATE plan_proposals SET status = 'applied' WHERE id = ?`).run(draft.id);
  db.prepare(
    `INSERT INTO brain_decisions (kind, domain, summary, source, status, autonomy_tier, risk_class, source_ref_type, source_ref_key, effective_date)
     VALUES ('training_target', 'training', 'coverage', 'coverage-check', 'applied', 'quiet_apply', 'low', 'plan_proposal', ?, ?)`
  ).run(String(draft.id), day(-2));
  const out = settleVolumeStep({ act: true });
  assert.equal(out.status, "settling");
  assert.equal(rows().length, 0);
});

test("one change in flight: announce_first announces, never doubles, and lands at its boundary", () => {
  base({ leadMode: "announce_first" });
  const announced = settleVolumeStep({ act: true });
  assert.equal(announced.status, "routed");
  assert.equal(announced.tier, "announce");
  assert.equal(benchSets(), 3, "nothing lands before its boundary");
  const again = settleVolumeStep({ act: true });
  assert.equal(again.status, "standing", "the change in flight is not doubled");
  assert.equal(again.proposal_id, announced.proposal_id);
  assert.equal(rows().length, 1);
  const tomorrow = addDaysISO(today(), 1);
  assert.deepEqual(applyDueAnnouncedDecisions(tomorrow).applied, [announced.decision_id]);
  assert.equal(benchSets(), 4);
});

test("review_everything holds exactly one draft, asked in the asking register", () => {
  base({ leadMode: "review_everything" });
  const asked = settleVolumeStep({ act: true });
  assert.equal(asked.status, "routed");
  assert.equal(asked.tier, "ask");
  assert.equal(asked.asked, true);
  assert.equal(benchSets(), 3);
  assert.equal(openRows().length, 1);
  assertHouseVoice(asked.explanation);
  assert.match(asked.explanation, /\bchest\b/);
  const hold = db
    .prepare(
      `SELECT id FROM brain_decisions WHERE source_ref_type = 'plan_proposal' AND source_ref_key = ? AND status = 'review'`
    )
    .all(String(asked.proposal_id));
  assert.equal(hold.length, 1, "one live hold, on the ledger");
  // Whether the hold also reads on the "waiting on you" surface depends on autonomy-service's
  // volumeFloorHoldReason speaking volume_step.explanation (the integration line in the report).
  const second = settleVolumeStep({ act: true });
  assert.equal(second.status, "standing");
  assert.equal(rows().length, 1, "never a second draft");
});

test("a dry run says exactly what the next pass would do, and writes nothing", () => {
  base();
  const before = snapshot();
  const preview = previewVolumeStep();
  assert.equal(preview.status, "would_route");
  assert.equal(preview.lift, "Barbell Bench Press");
  assert.equal(preview.from_sets, 3);
  assert.equal(preview.to_sets, 4);
  assert.equal(snapshot(), before, "no draft, no decision, no plan write");
  const deferred = settleVolumeStep({ act: false });
  assert.equal(deferred.status, "deferred");
  assert.equal(snapshot(), before);
  const acted = settleVolumeStep({ act: true });
  assert.equal(acted.lift, preview.lift);
  assert.equal(acted.summary, preview.summary);
});

// ---- 2. the bounds --------------------------------------------------------------

test("ranking: the group furthest below its bound relative to its range, ties by plan order, a full group out", () => {
  const g = (group, planned, low, high, order) => ({ group, planned, low, high, order });
  const ranked = rankVolumeStepGroups([
    g("chest", 12, 10, 22, 0), // (20-12)/(20-10) = 0.8
    g("back", 10, 10, 25, 1), // 1.0
    g("quads", 20, 8, 20, 2), // at the bound: no room
    g("shoulders", 12, 8, 22, 3), // 8/12 = 0.67
    g("glutes", 10, 6, 16, 4), // 6/10 = 0.6
    g("hamstrings", 12, 6, 16, 5), // 4/10 = 0.4
  ]);
  assert.deepEqual(
    ranked.map((x) => x.group),
    ["back", "chest", "shoulders", "glutes", "hamstrings"]
  );
  const tie = rankVolumeStepGroups([g("back", 10, 10, 25, 3), g("chest", 10, 10, 22, 1)]);
  assert.deepEqual(
    tie.map((x) => x.group),
    ["chest", "back"],
    "equal headroom: the group whose lift comes first in the plan"
  );
});

// The lift's ceiling is ONE set above its habit, never past five: a step can rise above what
// he habitually does (the proportional bound is the group's, tested below).
test("lift ceiling: a habit of three steps to four", () => {
  base({
    plan: week({ benchSets: 3, inclineSets: 3, flySets: 3, chestFill: 1 }),
    chest: { sets: 3, planned: { "Barbell Bench Press": 3, "Incline Dumbbell Press": 3, "Cable Fly": 3 } },
  });
  const out = settleVolumeStep({ act: true });
  assert.equal(out.status, "routed", JSON.stringify(out));
  assert.equal(out.lift, "Barbell Bench Press");
  assert.equal(benchSets(), 4, "one set above the habit of three");
});

test("lift ceiling: a habit of four steps to five", () => {
  base({
    plan: week({ benchSets: 4 }),
    chest: { sets: 4, planned: { "Barbell Bench Press": 4, "Incline Dumbbell Press": 3, "Cable Fly": 4 } },
  });
  const out = settleVolumeStep({ act: true });
  assert.equal(out.status, "routed", JSON.stringify(out));
  assert.equal(out.lift, "Barbell Bench Press");
  assert.equal(benchSets(), 5, "one set above the habit of four");
});

test("lift ceiling: a habit of five is already at the five-set cap, so nothing steps", () => {
  base({
    plan: week({ benchSets: 5, inclineSets: 5, flySets: 5 }),
    chest: { sets: 5, planned: { "Barbell Bench Press": 5, "Incline Dumbbell Press": 5, "Cable Fly": 5 } },
  });
  const before = snapshot();
  const out = settleVolumeStep({ act: true });
  assert.equal(out.status, "none");
  assert.ok(
    out.blocked.some((b) => b.code === "at_ceiling"),
    JSON.stringify(out.blocked)
  );
  assert.equal(snapshot(), before);
});

test("a lift already one set above its habit does not step again", () => {
  // Habit of three, bench written at four: its ceiling (habit + 1) is reached.
  base({
    plan: week({ benchSets: 4, inclineSets: 3, flySets: 3, chestFill: 1 }),
    chest: { sets: 3, planned: { "Barbell Bench Press": 3, "Incline Dumbbell Press": 3, "Cable Fly": 3 } },
  });
  const out = settleVolumeStep({ act: true });
  assert.notEqual(out.lift, "Barbell Bench Press");
  assert.ok(
    out.blocked.some((b) => b.lift === "Barbell Bench Press" && b.code === "at_ceiling"),
    JSON.stringify(out.blocked)
  );
});

test("the group bound: a group already at 1.2x its habitual weekly sets takes no step, though the lift has room", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.setProfile(STRENGTH);
  repo.replacePlan(week());
  const counted = plannedWeeklyGroupSets(repo.getPlan()).get("chest");
  base({ plan: week({ chestFill: 1 }), chest: { extra: 0 }, drivePlan: false });
  const habit = groupHabitualWeeklySets("chest", today());
  assert.ok(habit > 0, "precondition: the group has a habit");
  const bound = Math.ceil(habit * 1.2 - 1e-9);
  // At the bound: one more set would take the week past ceil(1.2 x habit).
  repo.replacePlan(week({ chestFill: Math.ceil(bound - counted) }));
  db.prepare(`UPDATE plan_items SET prescribed_at = ?`).run(day(-200));
  assert.ok(plannedWeeklyGroupSets(repo.getPlan()).get("chest") >= bound - 1e-9, "precondition: chest at its bound");
  assert.equal(benchSets(), 3, "precondition: the bench has room under habit + 1");
  const before = snapshot();
  const blocked = settleVolumeStep({ act: true });
  assert.equal(blocked.status, "none");
  assert.ok(
    blocked.blocked.some((b) => b.group === "chest" && b.code === "group_habit_bound"),
    JSON.stringify(blocked.blocked)
  );
  assert.equal(snapshot(), before);
  // One set under the bound: the same lift takes it.
  repo.replacePlan(week({ chestFill: Math.max(1, Math.floor(bound - 1 - counted)) }));
  db.prepare(`UPDATE plan_items SET prescribed_at = ?`).run(day(-200));
  assert.ok(plannedWeeklyGroupSets(repo.getPlan()).get("chest") + 1 <= bound + 1e-9, "precondition: room for one");
  const open = settleVolumeStep({ act: true });
  assert.equal(open.status, "routed", JSON.stringify(open));
  assert.equal(benchSets(), 4);
});

test("no habit on record, no raise: a group trained only long ago has nothing to measure a step against", () => {
  base({ chest: { logDays: [100, 93, 86, 79, 72] } });
  assert.equal(groupHabitualWeeklySets("chest", today()), null, "precondition: no group habit");
  const out = settleVolumeStep({ act: true });
  assert.equal(out.status, "none");
  assert.ok(
    out.blocked.some((b) => b.code === "group_habit_bound"),
    JSON.stringify(out.blocked)
  );
  assert.equal(benchSets(), 3);
  assert.equal(rows().length, 0);
});

test("the twenty-set bound: a group at twenty is left alone; one with room for a set takes it", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.setProfile(STRENGTH);
  // How many chest sets the plan counts without the filler, then a filler that lands the week at/over twenty.
  repo.replacePlan(week());
  const counted = plannedWeeklyGroupSets(repo.getPlan()).get("chest");
  assert.ok(counted >= 10 && counted < 15, `precondition: ${counted}`);
  const full = Math.ceil(20 - counted);
  base({ plan: week({ chestFill: full }), drivePlan: false });
  assert.ok(plannedWeeklyGroupSets(repo.getPlan()).get("chest") >= 20 - 1e-9, "precondition: chest counted at twenty");
  const none = settleVolumeStep({ act: true });
  assert.equal(none.status, "none");
  assert.equal(benchSets(), 3, "twenty is the bound");

  repo.replacePlan(week({ chestFill: Math.floor(19 - counted) }));
  db.prepare(`UPDATE plan_items SET prescribed_at = ?`).run(day(-200));
  assert.ok(plannedWeeklyGroupSets(repo.getPlan()).get("chest") <= 19 + 1e-9, "precondition: room for one");
  const out = settleVolumeStep({ act: true });
  assert.equal(out.status, "routed", JSON.stringify(out));
  assert.equal(out.group, "chest");
});

// ---- 3. the holds ---------------------------------------------------------------

// Held under `code`: a preview and an acting pass change nothing, and — for the codes the
// coverage pass shares — coverage's own read says the same word on a plan that has a gap.
function assertHeld(code, { parity = true } = {}) {
  const before = snapshot();
  const preview = previewVolumeStep();
  assert.equal(preview.status, "held", `preview: held under ${code}: ${JSON.stringify(preview)}`);
  assert.equal(preview.hold, code);
  assert.equal(snapshot(), before, "a preview writes nothing");
  const out = settleVolumeStep({ act: true });
  assert.equal(out.status, "held");
  assert.equal(out.hold, code);
  assert.equal(out.proposal_id, null, "no proposal");
  assert.equal(out.decision_id, null, "no decision");
  assert.deepEqual(out.withdrawn, []);
  assert.equal(snapshot(), before, "no proposal, no brain decision, no plan change");
  assert.equal(benchSets(), 3);
  if (parity) {
    repo.replacePlan(shortChestWeek());
    assert.equal(readPlanCoverage().hold, code, "the same hold coverage keeps");
  }
}

// Each listed table made unreadable in turn: the pass is `unavailable`, nothing changes.
function assertFailsClosed(tables) {
  const before = snapshot();
  for (const table of tables) {
    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_unreadable`);
    let out;
    let preview;
    try {
      out = settleVolumeStep({ act: true });
      preview = previewVolumeStep();
    } finally {
      db.exec(`ALTER TABLE ${table}_unreadable RENAME TO ${table}`);
    }
    assert.equal(out.status, "unavailable", `${table} unreadable: acting pass`);
    assert.equal(preview.status, "unavailable", `${table} unreadable: preview`);
    assert.equal(snapshot(), before, `${table} unreadable: nothing written`);
  }
}

// The owner is in an affirmed cut right now: the step must do nothing at every lead mode.
for (const leadMode of ["lead", "announce_first", "review_everything"]) {
  test(`DORMANT under an affirmed cut (${leadMode}): nothing is proposed, decided or changed`, () => {
    base({ leadMode });
    // Without the cut the pass WOULD step (the control).
    assert.equal(previewVolumeStep().status, "would_route");
    repo.setProfile({ goal_mode: "lose", weight_lb: 200, goal_weight_lb: 180 });
    assert.equal(cutReaffirmation().reaffirmed, true, "precondition: an affirmed cut");
    assertHeld("affirmed_cut", { parity: leadMode === "lead" });
    assert.equal(openRows().length, 0);
    assert.equal(rows().length, 0);
  });
}

function seedFuelProtection() {
  db.prepare(
    `INSERT INTO nutrition_targets (effective_date, target_kcal, protein_g, carbs_g, fat_g, source) VALUES (?, 2200, 175, 240, 70, 'test')`
  ).run(day(-30));
  for (const delta of [-1, -2, -3, -4]) {
    for (const [meal, share] of [
      ["breakfast", 0.45],
      ["dinner", 0.55],
    ]) {
      db.prepare(
        `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status) VALUES (?, ?, '', ?, NULL)`
      ).run(day(delta), meal, JSON.stringify({ kcal: Math.round(1750 * share), protein_g: 60 }));
    }
  }
  for (const delta of [-1, -2]) {
    db.prepare(`INSERT INTO sessions (date, performance, soreness, finished_at) VALUES (?, 2, 4, datetime('now'))`).run(
      day(delta)
    );
  }
}

test("fuel protection holds it", () => {
  base();
  seedFuelProtection();
  assert.notEqual(
    currentUnderfuelingRead(today()).action.training,
    "proceed",
    "precondition: fuel is protecting training"
  );
  assertHeld("fuel_protection");
});

function seedSlidingCut() {
  repo.setProfile({ goal_mode: "lose", weight_lb: 195, goal_weight_lb: 175, age: 35, height_cm: 178 });
  upsertAttentionSchedule({
    signal_key: "journey:goal-checkin",
    domain: "journey",
    tier: "active",
    next_due: day(-1),
    last_checked: day(-30),
    reason: "fixture",
    release_condition: "fixture",
    source: "test",
    state: { clean_checks: 0, confirming_checks: 0, surveillance_checks: 0, surveillance_interval_days: 7 },
  });
  for (let i = 0; i <= 21; i++) repo.logWeight(Math.round((195 - 0.06 * i) * 100) / 100, day(-(21 - i)));
  db.prepare(
    `INSERT INTO nutrition_targets (effective_date, target_kcal, protein_g, carbs_g, fat_g, source) VALUES (?, 2300, 175, 240, 70, 'test')`
  ).run(day(-40));
  for (let delta = -1; delta >= -21; delta--) {
    for (const [meal, kcal] of [
      ["breakfast", 700],
      ["lunch", 700],
      ["dinner", 900],
    ]) {
      db.prepare(
        `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status) VALUES (?, ?, '', ?, NULL)`
      ).run(day(delta), meal, JSON.stringify({ kcal, protein_g: 60 }));
    }
  }
  for (const exercise of ["Pause Squat", "Pendlay Row", "Trap Bar Deadlift"]) {
    [26, 20, 14, 8, 2].forEach((daysAgo, i) => {
      for (let s = 0; s < 3; s++) repo.logSetByName({ exercise, weight: 200 - i * 12, reps: 8, date: day(-daysAgo) });
    });
  }
}

test("cut pressure (a sliding cut) holds it", () => {
  base();
  seedSlidingCut();
  assert.equal(cutReaffirmation().reaffirmed, false, "precondition: no affirmed cut");
  assert.equal(readCutPressureStrict(today()).sliding, true, "precondition: the cut is sliding");
  // Any running cut holds the step, its check-in open or answered, so the cut itself is
  // the hold that speaks; cut pressure can only exist inside one.
  assertHeld("affirmed_cut", { parity: false });
});

test("a volume restore still owed holds it, and an unreadable ledger makes the pass unavailable", () => {
  base();
  db.prepare(
    `INSERT INTO brain_decisions (kind, domain, summary, source, status, autonomy_tier, risk_class, action_json)
     VALUES ('training_target', 'training', 'Fuel protection', 'auto-progression', 'applied', 'quiet_apply', 'low', ?)`
  ).run(
    JSON.stringify({
      volume_restore: [
        {
          day_number: 1,
          exercise: "Incline Dumbbell Press",
          applied_sets: 3,
          restore_to: 5,
          prior_sets: 5,
          cause: "fuel",
        },
      ],
    })
  );
  // (No coverage parity: the restore is open only while the slot still sits at the cut set count,
  // and the parity plan rewrites the slot.)
  assertHeld("volume_restore", { parity: false });
  assertFailsClosed(["brain_decisions"]);
});

test("an active plan adaptation holds it", () => {
  base();
  const proposal = repo.createProposal("stub", "background: chat signal", "", {
    summary: "Ease the leg curl for the next ten days",
    rationale: "A lighter week for the hamstrings.",
    changes: [
      {
        day_number: 2,
        exercise: "Lying Leg Curl",
        target_weight: 40,
        until: day(10),
        reason: "Lighter hamstrings for ten days",
      },
    ],
  });
  assert.equal(repo.applyProposal(Number(proposal.id)).ok, true);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM plan_adaptations WHERE status = 'active'`).get().n,
    1,
    "precondition"
  );
  assertHeld("plan_adaptation");
});

test("a recovery week upcoming holds it", () => {
  base();
  scheduleRecoveryCycle({ effective_on: day(1), reason: "a planned light week" });
  assertHeld("recovery_week");
});

test("a recovery week DRAFTED holds it too (the floor context alone does not see a draft)", () => {
  base();
  repo.createProposal("claude", RECOVERY_WEEK_INSTRUCTION, "", { summary: "A lighter week", days: week() });
  assertHeld("recovery_week", { parity: false });
});

test("a trip holds it", () => {
  base();
  const trip = repo.addContextEvent({ kind: "trip", title: "Work trip", start_date: today(), end_date: day(4) });
  assert.ok(trip?.id, "precondition: a trip");
  assertHeld("trip");
});

test("deload-due holds it: a deload that is earned is never met with more volume", () => {
  // Eight straight weekly sessions of loaded chest work, no light week among them: the
  // loaded-weeks evidence calls for a deload.
  base({ drivePlan: false, chest: { logDays: [54, 47, 40, 33, 26, 19, 12, 5] } });
  assert.equal(
    getProgramState(today()).mesocycle.phase,
    "deload-due",
    JSON.stringify(getProgramState(today()).mesocycle)
  );
  assertHeld("deload_due");
});

test("the race taper holds it", () => {
  base({ drivePlan: false });
  const race = day(9);
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    training_intent: { priorities: ["strength", "muscle", "endurance"], endurance_role: "co_primary" },
    strength_schedule: { days: [1, 2, 3, 4, 5].map((dow) => ({ dow })), source: "athlete" },
    endurance_schedule: {
      days: [
        { dow: 2, kind: "easy" },
        { dow: 4, kind: "quality" },
        { dow: 0, kind: "long" },
      ],
    },
    endurance_goal: { mode: "race", event: "Riverside Half", date: race, distance_km: 21.1, target: "sub-2:00" },
  });
  assert.equal(lightWeekExemption(today()), "race_taper", "precondition: this is the taper");
  assertHeld("race_taper", { parity: false });
});

// ---- 4. the lift and the group --------------------------------------------------

test("pain reported in words keeps every lift it loads untouched", () => {
  base();
  repo.reportTrainingSymptom({
    area_text: "left shoulder",
    onset_on: today(),
    report_text: "my left shoulder aches when I press",
  });
  const out = settleVolumeStep({ act: true });
  assert.equal(out.status, "held");
  assert.equal(out.hold, "pain");
  assert.equal(benchSets(), 3);
  assert.equal(setsOf("Incline Dumbbell Press"), 3);
  assert.equal(rows().length, 0);
});

test("an open injury keeps the step off the lifts it loads", () => {
  base();
  repo.addContextEvent({ kind: "injury", title: "Shoulder strain", start_date: today() });
  const out = settleVolumeStep({ act: true });
  assert.notEqual(out.status, "routed");
  assert.equal(benchSets(), 3);
  assert.equal(setsOf("Incline Dumbbell Press"), 3);
  assert.equal(rows().length, 0);
});

test("a constraint note keeps a lift untouched", () => {
  base();
  db.prepare(
    `UPDATE exercises SET constraint_note = 'neck strain under load' WHERE name IN ('Barbell Bench Press','Incline Dumbbell Press','Cable Fly')`
  ).run();
  const out = settleVolumeStep({ act: true });
  assert.equal(out.status, "held");
  assert.equal(out.hold, "constraint_note");
  assert.equal(benchSets(), 3);
});

test("an untested slot is never stepped: nothing has been trained at it since it was written", () => {
  base();
  db.prepare(`UPDATE plan_items SET prescribed_at = ?`).run(new Date().toISOString());
  const out = settleVolumeStep({ act: true });
  assert.equal(out.status, "held");
  assert.equal(out.hold, "untested_slot");
  assert.equal(benchSets(), 3);
});

test("a session already composed on the lift's plan day waits for the boundary", () => {
  base();
  const session = repo.getOrCreateSession(today());
  const dayId = db.prepare(`SELECT id FROM plan_days WHERE day_number = 1`).get().id;
  db.prepare(
    `INSERT INTO daily_session_compositions (version, session_id, date, source, status, plan_day_id, items_json, request_fingerprint)
     VALUES (1, ?, ?, 'manual_plan', 'active', ?, '[]', 'fixture')`
  ).run(session.id, today(), dayId);
  const out = settleVolumeStep({ act: true });
  assert.equal(out.status, "held");
  assert.equal(out.hold, "session_composed");
  assert.equal(benchSets(), 3, "today's composed Upper is untouched");
});

test("a slipping movement in the group blocks the group (more volume is the wrong lever for a slide)", () => {
  base({ chest: { flyWeights: [60, 55, 50, 45, 40] } });
  const st = getProgramState(today());
  assert.equal(st.lifts.find((l) => l.exercise === "Cable Fly")?.status, "regressing", "precondition");
  const flyUnit = st.capability.units.find((u) => u.lifts.some((l) => l.exercise === "Cable Fly"));
  assert.equal(flyUnit?.verdict, "slipping", "precondition: the fly movement is slipping");
  const out = settleVolumeStep({ act: true });
  assert.equal(out.status, "held");
  assert.equal(out.hold, "unit_slipping");
  assert.equal(benchSets(), 3);
});

test("a lift plateaued and grinding in the group blocks the group", () => {
  base({ chest: { flyWeights: [40, 40, 40, 40, 40], flyRir: 0 } });
  const fly = getProgramState(today()).lifts.find((l) => l.exercise === "Cable Fly");
  assert.equal(fly?.status, "plateaued", "precondition");
  assert.ok(
    fly.stall_signals.some((s) => /grinding/.test(s)),
    "precondition: grinding"
  );
  const out = settleVolumeStep({ act: true });
  assert.equal(out.status, "held");
  assert.equal(out.hold, "plateau_grinding");
  assert.equal(benchSets(), 3);
});

test("a harm day on a day the group was trained blocks it", () => {
  base();
  db.prepare(`UPDATE sessions SET performance = 1 WHERE date = ?`).run(day(-5));
  const out = settleVolumeStep({ act: true });
  assert.equal(out.status, "held");
  assert.equal(out.hold, "recent_harm");
  assert.equal(benchSets(), 3);
  // The same rating beyond the fortnight is old news.
  db.prepare(`UPDATE sessions SET performance = NULL WHERE date = ?`).run(day(-5));
  db.prepare(`UPDATE sessions SET performance = 1 WHERE date = ?`).run(day(-26));
  assert.equal(settleVolumeStep({ act: true }).status, "routed");
});

test("the log must vouch: a session that slipped withholds the step", () => {
  base();
  const outcome = db.prepare(`SELECT id, facts_json FROM daily_session_outcomes WHERE date = ?`).get(day(-12));
  const facts = JSON.parse(outcome.facts_json);
  facts.dose_evidence[0].achieved.sets = 2; // fewer sets than the plan authored
  db.prepare(`UPDATE daily_session_outcomes SET facts_json = ? WHERE id = ?`).run(JSON.stringify(facts), outcome.id);
  assert.equal(volumeToleranceRead(today()), null, "precondition");
  const out = settleVolumeStep({ act: true });
  assert.equal(out.status, "held");
  assert.equal(out.hold, "tolerance_unproven");
  assert.equal(benchSets(), 3);
});

test("intent: with neither muscle nor strength a stated priority there is nothing to do", () => {
  base();
  repo.setProfile({ training_intent: { priorities: ["longevity"], endurance_role: "none" } });
  const before = snapshot();
  assert.equal(settleVolumeStep({ act: true }).status, "none");
  assert.equal(snapshot(), before);
});

// ---- 5. the athlete's answer ----------------------------------------------------

test("Undo is remembered per group, then released by a change of intent", () => {
  base();
  const out = settleVolumeStep({ act: true });
  assert.equal(revertDecision(out.decision_id).ok, true);
  ageStep(out.proposal_id, 9); // not this week
  const declined = settleVolumeStep({ act: true });
  assert.equal(declined.status, "declined");
  assert.ok(declined.blocked.some((b) => b.group === "chest" && b.code === "declined"));
  assert.equal(benchSets(), 3, "a reverted step is not re-applied");
  assert.equal(rows().length, 1);
  // The athlete changes what they are training for: the no is released.
  repo.setProfile({ training_intent: { priorities: ["muscle", "strength"], endurance_role: "none" } });
  const again = settleVolumeStep({ act: true });
  assert.equal(again.status, "routed", JSON.stringify(again));
  assert.equal(again.group, "chest");
  assert.equal(benchSets(), 4);
});

test("a no is released after six weeks", () => {
  base();
  const out = settleVolumeStep({ act: true });
  assert.equal(revertDecision(out.decision_id).ok, true);
  ageStep(out.proposal_id, 9);
  assert.equal(settleVolumeStep({ act: true }).status, "declined");
  ageStep(out.proposal_id, 50);
  assert.equal(settleVolumeStep({ act: true }).status, "routed");
});

test("a held draft set aside (review_everything) and an announced change held are the same no", () => {
  base({ leadMode: "review_everything" });
  const asked = settleVolumeStep({ act: true });
  repo.setProposalStatus(asked.proposal_id, "discarded");
  assert.equal(settleVolumeStep({ act: true }).status, "declined", "a discarded draft is a no");
  assert.equal(rows().length, 1);

  db.exec(`DELETE FROM brain_decisions; DELETE FROM plan_proposals;`);
  repo.setSettings({ lead_mode: "announce_first" });
  const announced = settleVolumeStep({ act: true });
  assert.equal(announced.tier, "announce");
  assert.equal(revertDecision(announced.decision_id).ok, true, "'Hold this'");
  ageStep(announced.proposal_id, 9);
  assert.equal(settleVolumeStep({ act: true }).status, "declined");
  assert.equal(applyDueAnnouncedDecisions(addDaysISO(today(), 1)).applied.length, 0, "nothing lands at the boundary");
});

test("a gap or change the person authored on the group (coverage_person_kept_v1) is left alone", () => {
  base();
  const fingerprint = crypto
    .createHash("sha1")
    .update(["group", "chest", "strength:1|muscle:0"].join("\u0000"))
    .digest("hex")
    .slice(0, 16);
  db.prepare(
    `INSERT INTO app_state (key, value, updated_at) VALUES ('coverage_person_kept_v1', ?, datetime('now'))`
  ).run(JSON.stringify({ [fingerprint]: { planned: 10 } }));
  const out = settleVolumeStep({ act: true });
  assert.equal(out.status, "declined");
  assert.equal(benchSets(), 3);
  assert.equal(rows().length, 0);
});

// ---- 6. reads fail closed -------------------------------------------------------

test("a read that fails changes nothing and withdraws nothing", () => {
  base();
  assertFailsClosed(["plan_days", "context_events", "logged_sets"]);
  // With a draft already open, a failed read never withdraws it.
  db.exec(`DELETE FROM brain_decisions; DELETE FROM plan_proposals;`);
  repo.setSettings({ lead_mode: "review_everything" });
  const asked = settleVolumeStep({ act: true });
  assert.equal(asked.status, "routed");
  db.exec(`ALTER TABLE context_events RENAME TO context_events_unreadable`);
  let out;
  try {
    out = settleVolumeStep({ act: true });
  } finally {
    db.exec(`ALTER TABLE context_events_unreadable RENAME TO context_events`);
  }
  assert.notEqual(out.status, "routed");
  assert.deepEqual(out.withdrawn, []);
  assert.deepEqual(
    openRows().map((row) => row.id),
    [asked.proposal_id],
    "the open draft is still exactly the one ask"
  );
  assert.equal(rows().length, 1);
});

// ---- 7. the premise -------------------------------------------------------------

function heldStepParsed() {
  base({ leadMode: "review_everything" });
  const asked = settleVolumeStep({ act: true });
  assert.equal(asked.status, "routed");
  return repo.getProposal(asked.proposal_id).parsed;
}

test("volumeStepStillFits: fits while the slot, the intent and the week stand", () => {
  const parsed = heldStepParsed();
  assert.equal(volumeStepStillFits(parsed, today()), "fits");
});

test("volumeStepStillFits: gone when the slot moved under it", () => {
  const parsed = heldStepParsed();
  db.prepare(
    `UPDATE plan_items SET sets = 5 WHERE exercise_id = (SELECT id FROM exercises WHERE name = 'Barbell Bench Press')`
  ).run();
  assert.equal(
    volumeStepStillFits(parsed, today()),
    "gone",
    "an absolute count written over a slot the athlete edited"
  );
});

test("volumeStepStillFits: gone when the intent changed under it", () => {
  const parsed = heldStepParsed();
  repo.setProfile({ training_intent: { priorities: ["muscle", "strength"], endurance_role: "none" } });
  assert.equal(volumeStepStillFits(parsed, today()), "gone", "made under another intent");
  repo.setProfile({ training_intent: { priorities: ["longevity"], endurance_role: "none" } });
  assert.equal(volumeStepStillFits(parsed, today()), "gone", "no longer a priority at all");
});

test("volumeStepStillFits: held when it stands but this is no week to land it", () => {
  const parsed = heldStepParsed();
  scheduleRecoveryCycle({ effective_on: day(1), reason: "a planned light week" });
  assert.equal(volumeStepStillFits(parsed, today()), "held");
  db.prepare(`DELETE FROM recovery_cycles`).run();
  assert.equal(volumeStepStillFits(parsed, today()), "fits");
  db.prepare(`UPDATE sessions SET performance = 1 WHERE date = ?`).run(day(-5));
  assert.equal(volumeStepStillFits(parsed, today()), "held", "a harm day since");
});

test("volumeStepStillFits: unknown when a read fails or the payload carries no basis", () => {
  const parsed = heldStepParsed();
  assert.equal(volumeStepStillFits({ changes: [] }, today()), "unknown");
  assert.equal(volumeStepStillFits({ volume_step: { group: "chest", basis: [] }, changes: [] }, today()), "unknown");
  db.exec(`ALTER TABLE context_events RENAME TO context_events_unreadable`);
  try {
    assert.equal(volumeStepStillFits(parsed, today()), "unknown");
  } finally {
    db.exec(`ALTER TABLE context_events_unreadable RENAME TO context_events`);
  }
});

test("a premise gone withdraws an open draft quietly on the next pass", () => {
  const parsed = heldStepParsed();
  const [open] = openRows();
  db.prepare(
    `UPDATE plan_items SET sets = 5 WHERE exercise_id = (SELECT id FROM exercises WHERE name = 'Barbell Bench Press')`
  ).run();
  assert.equal(volumeStepStillFits(parsed, today()), "gone");
  const out = settleVolumeStep({ act: true });
  assert.deepEqual(out.withdrawn, [open.id]);
  assert.equal(repo.getProposal(open.id).status, "superseded");
  const stillAsking = db
    .prepare(
      `SELECT id FROM brain_decisions WHERE source_ref_type = 'plan_proposal' AND source_ref_key = ? AND status = 'review'`
    )
    .all(String(open.id));
  assert.equal(stillAsking.length, 0, "the stale question is gone, not parked");
});

// ---- 8. the words ---------------------------------------------------------------

test("every phrasing keeps the reading grammar, in both registers, with the numbers as words", () => {
  const seen = new Set();
  for (let offset = 0; offset < 9; offset++) {
    const date = addDaysISO("2026-01-01", offset);
    for (const group of [
      "chest",
      "back",
      "shoulders",
      "quads",
      "hamstrings",
      "glutes",
      "biceps",
      "triceps",
      "calves",
    ]) {
      for (const lift of ["Barbell Bench Press", "Cable Fly", "Back Squat"]) {
        const words = volumeStepWords(date, group, lift, "Upper");
        assertHouseVoice(words.summary, words.explanation, words.ask_explanation);
        assert.match(words.explanation, /Undo/, "the acting register says Undo puts the week back");
        assert.match(words.summary, /one more set/i);
        seen.add(words.explanation.replace(group, "G").replace(lift, "L"));
      }
    }
  }
  assert.ok(seen.size >= 3, "the wording rotates");
  const payload = volumeStepProposalPayload(
    {
      group: "chest",
      intent: "strength:1|muscle:0",
      to: 4,
      lift: { day_number: 1, day_name: "Upper", exercise: "Barbell Bench Press", sets: 3 },
    },
    "2026-01-01"
  );
  assert.equal(payload.changes[0].sets, 4);
  assert.equal(payload.volume_step.basis[0].sets, 3);
});

// ---- the group condition is read per movement unit (the capability read) -------------

test("the set goes to a lift of the HOLDING movement: a climbing flat press needs nothing, the incline takes it", () => {
  base({ chest: { extra: 0 } });
  // The flat press now climbs: two heavier sessions at the same reps.
  logLift("Barbell Bench Press", 3, 115, 3);
  logLift("Barbell Bench Press", 2, 120, 3);
  const units = getProgramState(today()).capability.units;
  assert.equal(units.find((u) => u.key === "horizontal-push:flat")?.verdict, "climbing", "precondition");
  assert.equal(units.find((u) => u.key === "horizontal-push:incline")?.verdict, "holding", "precondition");
  const out = settleVolumeStep({ act: true, dry: true });
  assert.equal(out.status, "would_route", JSON.stringify(out));
  assert.equal(out.lift, "Incline Dumbbell Press");
  assert.ok(out.blocked.some((b) => b.lift === "Barbell Bench Press" && b.code === "unit_not_holding"));
});

test("the premise applies the same unit rule: a step whose movement now climbs is gone", () => {
  base({ leadMode: "review_everything" });
  const out = settleVolumeStep({ act: true });
  assert.equal(out.status, "routed");
  assert.equal(out.lift, "Barbell Bench Press");
  const parsed = repo.getProposal(out.proposal_id).parsed;
  assert.equal(volumeStepStillFits(parsed), "fits");
  logLift("Barbell Bench Press", 3, 115, 4);
  logLift("Barbell Bench Press", 2, 120, 4);
  assert.equal(volumeStepStillFits(parsed), "gone", "a climbing movement needs no added set");
});

// ---- one server-owned structural change per lift per week (lift-structural-change.ts) ----

// A plateau-ladder change on a lift, as unit-plateau-change.ts writes it: open (a draft), or
// applied with its landing decision.
function plateauChangeRow(lift, { status = "draft" } = {}) {
  const info = db
    .prepare(
      `INSERT INTO plan_proposals (agent, instruction, raw_output, parsed_json, status)
       VALUES ('unit-plateau', 'x', '', ?, ?)`
    )
    .run(
      JSON.stringify({ unit_plateau: { unit_key: "horizontal-push:flat", lever: "rep_scheme", lift, day_number: 1 } }),
      status
    );
  const id = Number(info.lastInsertRowid);
  if (status === "applied") {
    db.prepare(
      `INSERT INTO brain_decisions
         (kind, domain, summary, status, autonomy_tier, risk_class, source_ref_type, source_ref_key, effective_date)
       VALUES ('plan_change', 'training', 'x', 'applied', 'quiet_apply', 'low', 'plan_proposal', ?, ?)`
    ).run(String(id), today());
  }
  return id;
}

test("a plateau-ladder change open on the lift holds the step off it: one structural change a lift a week", () => {
  base();
  plateauChangeRow("Barbell Bench Press");
  const out = settleVolumeStep({ act: true });
  assert.notEqual(out.lift, "Barbell Bench Press", JSON.stringify(out));
  assert.ok(
    out.blocked.some((b) => b.lift === "Barbell Bench Press" && b.code === "lift_changed_this_week"),
    JSON.stringify(out)
  );
  assert.equal(benchSets(), 3, "the bench keeps its sets");
});

test("at landing: a plateau change landed this week on the lift holds the step; one written after the step does not", () => {
  base({ leadMode: "review_everything" });
  const out = settleVolumeStep({ act: true });
  assert.equal(out.status, "routed");
  assert.equal(out.lift, "Barbell Bench Press");
  const parsed = repo.getProposal(out.proposal_id).parsed;
  const later = plateauChangeRow("Barbell Bench Press");
  assert.equal(volumeStepStillFits(parsed, today(), out.proposal_id), "fits", "the step came first");
  db.prepare(`DELETE FROM plan_proposals WHERE id = ?`).run(later);
  plateauChangeRow("Barbell Bench Press", { status: "applied" });
  assert.equal(volumeStepStillFits(parsed, today(), out.proposal_id), "held");
});
