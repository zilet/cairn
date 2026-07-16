// Wave 2 — the pre-session primer (src/repo/session-primer.ts). A calm, DETERMINISTIC
// "a coach was already here" read composed for the /app/session surface on open:
//   - why_today  : reused from the day read (never recomputed)
//   - changed[]  : earned targets (rx path) + recovery-driven caps
//   - watch[]    : active training/watch directives + a recent joint/soreness echo
//                  + a low-recovery note
//   - fresh[]    : movements new this week (against an established base), with a why
//   - approach   : ONE calm line
// Null when there's nothing worth saying beyond the Brief. Deterministic, offline,
// temp DB (the harness wipes before every test).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, localDaysAgo, seedSleep } from "./_seed.js";
import { sessionPrimer } from "../dist/repo/session-primer.js";
import { recordDecision } from "../dist/repo/brain-decisions.js";

function reset() {
  for (const t of [
    "logged_sets", "plan_items", "plan_days", "sessions", "exercises",
    "bodyweight_log", "activities", "garmin_activities", "health_directives",
    "daily_metrics", "garmin_daily_metrics", "memory", "day_reads",
  ]) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist */ }
  }
}
beforeEach(reset);

function makeExercise(name, muscle_group) {
  repo.upsertExercise({ name, muscle_group });
  return repo.findExercise(name);
}
function planDay(dayNumber, focus, items) {
  return repo.savePlanDay(dayNumber, focus, focus, items);
}
function logSet(name, date, { weight = null, reps = null, rir = null, setNum = 1 } = {}) {
  const ex = repo.findExercise(name);
  const sess = repo.getOrCreateSession(date, null);
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sess.id, ex.id, setNum, weight, reps, rir);
}

// ---------------------------------------------------------------------------
test("rx-change day: an earned overload surfaces as a target change + the 'step up' approach", () => {
  makeExercise("Barbell Bench Press", "chest");
  planDay(1, "Push", [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 }]);
  logSet("Barbell Bench Press", localDaysAgo(28), { weight: 175, reps: 8, rir: 2 });
  logSet("Barbell Bench Press", localDaysAgo(21), { weight: 180, reps: 8, rir: 2 });
  logSet("Barbell Bench Press", localDaysAgo(10), { weight: 185, reps: 8, rir: 2 });

  const primer = sessionPrimer(undefined, { dayNumber: 1 });
  assert.ok(primer, "a primer is produced");
  assert.equal(primer.day_number, 1);
  assert.ok(primer.changed.some((c) => c.kind === "target" && /bench press/i.test(c.exercise)), "the earned target is a change");
  assert.match(primer.approach, /earned/i, "the approach names the earned step");
  assert.ok(primer.why_today.length > 0, "why_today is reused from the day read");
});

test("recovery cap: an autoregulation brake reads as a recovery-driven cap, not a target bump", () => {
  makeExercise("Back Squat", "quads");
  planDay(1, "Lower", [{ exercise: "Back Squat", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 }]);
  // A progressing history that WOULD earn a step up …
  logSet("Back Squat", localDaysAgo(21), { weight: 175, reps: 8, rir: 2 });
  logSet("Back Squat", localDaysAgo(14), { weight: 180, reps: 8, rir: 2 });
  logSet("Back Squat", localDaysAgo(7), { weight: 185, reps: 8, rir: 2 });
  // … but a recent sore knee this lift loads brakes the earned overload to a hold.
  repo.setSessionFeedback(localDaysAgo(0), { soreness: null, performance: null, joint_pain: "left knee" });

  const primer = sessionPrimer(undefined, { dayNumber: 1 });
  assert.ok(primer, "a primer is produced");
  assert.ok(
    primer.changed.some((c) => c.kind === "recovery_cap" && /squat/i.test(c.exercise)),
    "the braked step is a recovery cap, not a target bump"
  );
  assert.ok(
    !primer.changed.some((c) => c.kind === "target" && /squat/i.test(c.exercise)),
    "the earned overload did not surface as a target"
  );
});

test("directive + soreness present: both surface in watch[], tied to a movement on the day", () => {
  makeExercise("Back Squat", "quads");
  planDay(1, "Lower", [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 }]);
  logSet("Back Squat", localDaysAgo(6), { weight: 225, reps: 5, rir: 2 });
  repo.addDirective({ domain: "training", directive: "Ease off heavy spinal loading for a couple of weeks." });
  repo.setSessionFeedback(localDaysAgo(0), { soreness: 4, performance: null, joint_pain: "left knee" });

  const primer = sessionPrimer(undefined, { dayNumber: 1 });
  assert.ok(primer, "a primer is produced");
  const watchText = primer.watch.map((w) => w.text).join(" | ").toLowerCase();
  assert.match(watchText, /spinal loading/, "the active training directive is in watch");
  assert.match(watchText, /knee/, "the recent joint echo is tied to the knee-loading squat");
});

test("recovery-low day: a low-recovery note lands in watch[] and softens the approach", () => {
  makeExercise("Back Squat", "quads");
  planDay(1, "Lower", [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 }]);
  seedSleep(localDaysAgo(0), 300);
  seedSleep(localDaysAgo(1), 305);
  seedSleep(localDaysAgo(2), 295);

  const primer = sessionPrimer(undefined, { dayNumber: 1 });
  assert.ok(primer, "a primer is produced");
  assert.ok(primer.watch.some((w) => /recovery|conservative|reserve/i.test(w.text) && w.soft), "a soft low-recovery note is present");
  assert.match(primer.approach, /quality day|reserve/i, "the approach softens on a low-recovery day");
});

test("fresh day: a movement new this week surfaces in fresh[] against an established base", () => {
  makeExercise("Back Squat", "quads");
  makeExercise("Bulgarian Split Squat", "quads");
  planDay(1, "Lower", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
    { exercise: "Bulgarian Split Squat", sets: 3, rep_low: 8, rep_high: 12 },
  ]);
  // An established base: Back Squat logged across many weeks (6 distinct session-days).
  for (const d of [35, 30, 25, 20, 15, 10]) logSet("Back Squat", localDaysAgo(d), { weight: 225, reps: 5, rir: 2 });
  // The fresh movement: logged for the very first time this week.
  logSet("Bulgarian Split Squat", localDaysAgo(2), { weight: 40, reps: 10, rir: 2 });

  const primer = sessionPrimer(undefined, { dayNumber: 1 });
  assert.ok(primer, "a primer is produced");
  assert.ok(primer.fresh.some((f) => /bulgarian/i.test(f.exercise)), "the new movement is flagged fresh");
  assert.ok(!primer.fresh.some((f) => /back squat/i.test(f.exercise)), "the established movement is not fresh");
  assert.ok(primer.fresh.every((f) => f.why && f.why.length > 0), "every fresh row carries a rationale");
});

test("an applied rotation reads as 'Swapped in X for Y' in changed[] and suppresses its fresh[] duplicate", () => {
  makeExercise("Back Squat", "quads");
  makeExercise("Front Squat", "quads");
  // An established training base (6 distinct session-days on Back Squat, the lift that
  // was later rotated out) so the fresh signal is active — Front Squat would otherwise
  // read as "fresh on your plan".
  for (const d of [35, 30, 25, 20, 15, 10]) logSet("Back Squat", localDaysAgo(d), { weight: 225, reps: 5, rir: 2 });
  // Post-swap the plan carries Front Squat (Back Squat was rotated out).
  planDay(1, "Lower", [{ exercise: "Front Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 185 }]);

  // The applied exercise-rotation decision + its source proposal carrying the swap.
  const proposal = repo.createProposal("exercise-swap", "rotate a same-pattern variation", "", {
    summary: "Rotated Front Squat in for Back Squat to break the plateau.",
    changes: [
      { day_number: 1, swap: { from: "Back Squat", to: "Front Squat" }, reason: "Rotate a same-pattern variation in for Back Squat." },
    ],
  });
  recordDecision({
    effective_date: localDaysAgo(3),
    kind: "exercise_rotation",
    domain: "training",
    summary: "Rotated Front Squat in for Back Squat to break the plateau.",
    rationale: "The lift stalled; a same-pattern variation keeps the stimulus fresh.",
    source: "exercise-swap",
    source_ref_type: "plan_proposal",
    source_ref_key: String(proposal.id),
    status: "applied",
    autonomy_tier: "quiet_apply",
    risk_class: "low",
    reversible: true,
    input_fingerprint: null,
    context: {},
    action: { proposal_id: proposal.id },
    specialist: null,
    applied_at: `${localDaysAgo(3)}T12:00:00.000Z`,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  });

  const primer = sessionPrimer(undefined, { dayNumber: 1 });
  assert.ok(primer, "a primer is produced");
  const rotation = primer.changed.find((c) => c.kind === "rotation");
  assert.ok(rotation, "the applied rotation surfaces as a rotation change");
  assert.match(rotation.text, /Swapped in Front Squat for Back Squat/i, "it names the swap in/out");
  assert.ok(
    !primer.fresh.some((f) => /front squat/i.test(f.exercise)),
    "the swapped-in movement is NOT also listed as a mysteriously-fresh row"
  );
  assert.match(primer.approach, /fresh/i, "the approach reflects the fresh variation");
});

test("bare inputs: no plan → null, and a plan day with no signals → null (silence beats filler)", () => {
  assert.equal(sessionPrimer(), null, "no plan at all → nothing to prime");

  makeExercise("Overhead Press", "shoulders");
  planDay(1, "Push", [{ exercise: "Overhead Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 95 }]);
  // No logged history, no directives, no feedback, no recovery signal → no changes,
  // no watch, no fresh → the primer would only echo the Brief, so it's null.
  assert.equal(sessionPrimer(undefined, { dayNumber: 1 }), null, "a bare plan day with no signals → null");
});

test("an explicit day that isn't on the plan → null", () => {
  makeExercise("Back Squat", "quads");
  planDay(1, "Lower", [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 }]);
  assert.equal(sessionPrimer(undefined, { dayNumber: 9 }), null, "day 9 doesn't exist → nothing to prime");
});
