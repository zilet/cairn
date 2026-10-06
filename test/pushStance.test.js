// The athlete's DATED push stance ("I can push way harder than the program is
// recommending"): src/repo/training-drive.ts (the read), src/domain/training/
// training-drive.ts (the door, the ledger row and its one-tap Undo), the widened
// licenses in daily-decision.ts / daily-composition.ts / day-read.ts / progression.ts,
// and the honest "why not more" read (src/repo/training-drive-read.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { db, repo } from "./_seed.js";
import { addDaysISO } from "../dist/lib/dates.js";
import { localDateISO } from "../dist/repo/shared.js";
import {
  PUSH_STANCE_CONSEC_CEILING,
  PUSH_STANCE_ENDED_SAY_DAYS,
  PUSH_STANCE_REACH_HOSTS,
  effectiveTrainingDrive,
  pushStanceActive,
  trainingDriveState,
} from "../dist/repo/training-drive.js";
import { setTrainingDrive } from "../dist/domain/training/training-drive.js";
import { revertDecision } from "../dist/domain/brain/autonomy-service.js";
import {
  getBrainDecision,
  getBrainRollback,
  listBrainExpectations,
  rollbackEvidenceByKind,
} from "../dist/repo/brain-decisions.js";
import { buildReactionModel } from "../dist/repo/reaction-model.js";
import { pushStanceHarmFree, pushStanceInForce } from "../dist/repo/push-stance-open.js";
import { PUSH_STANCE_RATIONALE, REACH_STANCE_WHY, buildDailySessionDecision } from "../dist/repo/daily-decision.js";
import { pushHolds, trainingDriveRead, trainingDriveForCoach } from "../dist/repo/training-drive-read.js";
import { renderTrainingDriveLine } from "../dist/prompt/shared.js";
import { hasExplicitTrainingDriveIntent } from "../dist/chat-intent.js";
import { normalizeChatAction } from "../dist/chatActions.js";
import { createBlock } from "../dist/repo/program-blocks.js";
import { nextPrescription } from "../dist/repo/progression.js";

const today = () => localDateISO();

// ---------- the read: dated, read-time expiry, the toggle ----------

test("a push stance is dated, recorded, and in force through its last day", () => {
  const until = addDaysISO(today(), 10);
  const res = setTrainingDrive({ drive: "push", until, words: "I think I can push way harder", via: "athlete" });
  assert.equal(res.ok, true);
  assert.equal(repo.getSettings().training_drive, "push");
  const state = trainingDriveState(today());
  assert.equal(state.drive, "push");
  assert.equal(state.stance.until, until);
  assert.equal(state.stance.previous_drive, "steady");
  assert.equal(state.stance.words, "I think I can push way harder");
  assert.equal(pushStanceActive(until), true, "the last day is covered");
  // Past the end it simply stops reading: back to steady with no write.
  assert.equal(pushStanceActive(addDaysISO(until, 1)), false);
  assert.equal(effectiveTrainingDrive(addDaysISO(until, 1)), "steady");
  assert.equal(repo.getSettings().training_drive, "push", "expiry is read-time, never a write");

  // The ledger: an observe-tier, reversible, applied training decision with its Undo.
  const decision = getBrainDecision(res.decision_id);
  assert.equal(decision.status, "applied");
  assert.equal(decision.autonomy_tier, "observe");
  assert.equal(decision.reversible, true);
  assert.equal(decision.context.training_drive_stance, true);
  assert.equal(decision.action.until, until);
  assert.equal(getBrainRollback(res.decision_id).kind, "training_stance");
  assert.equal(state.stance.decision_id, res.decision_id);
});

test("the stance carries falsifiable expectations when the athlete logs the signals", () => {
  // Two rated sessions with feedback in the lookback → the feedback guards can mature.
  for (const back of [3, 5]) {
    const session = repo.getOrCreateSession(addDaysISO(today(), -back), null);
    db.prepare(`UPDATE sessions SET performance = 4, soreness = 2 WHERE id = ?`).run(session.id);
  }
  const res = setTrainingDrive({ drive: "push", scope: "date", via: "mcp" });
  const metrics = listBrainExpectations({ decisionId: res.decision_id })
    .map((e) => e.metric_key)
    .sort();
  assert.deepEqual(metrics, ["joint_pain_or_soreness", "session_performance_feedback"]);
});

test("one-tap Undo puts the drive back and ends the stance", () => {
  const res = setTrainingDrive({ drive: "push", until: addDaysISO(today(), 5) });
  const undone = revertDecision(res.decision_id);
  assert.equal(undone.ok, true, undone.error);
  assert.equal(repo.getSettings().training_drive, "steady");
  assert.equal(pushStanceActive(today()), false);
  assert.equal(getBrainDecision(res.decision_id).status, "reverted");
});

test("Undo refuses once the athlete has moved the drive since — their newer word stands", () => {
  const first = setTrainingDrive({ drive: "push", until: addDaysISO(today(), 5) });
  const second = setTrainingDrive({ drive: "push", until: addDaysISO(today(), 20) });
  assert.equal(getBrainDecision(first.decision_id).status, "superseded");
  const refused = revertDecision(first.decision_id);
  assert.equal(refused.ok, false);
  assert.equal(trainingDriveState(today()).stance.until, addDaysISO(today(), 20));
  // Undoing the newer stance re-opens the one it replaced.
  const undone = revertDecision(second.decision_id);
  assert.equal(undone.ok, true, undone.error);
  assert.equal(trainingDriveState(today()).stance.until, addDaysISO(today(), 5));
});

test("stepping back ends the stance and is itself undoable", () => {
  setTrainingDrive({ drive: "push", until: addDaysISO(today(), 9) });
  const back = setTrainingDrive({ drive: "steady", words: "back to steady" });
  assert.equal(back.ok, true);
  assert.equal(effectiveTrainingDrive(today()), "steady");
  const undone = revertDecision(back.decision_id);
  assert.equal(undone.ok, true, undone.error);
  assert.equal(trainingDriveState(today()).stance?.until, addDaysISO(today(), 9));
});

test("a renewed stance falls back to what stood BEFORE any stance", () => {
  setTrainingDrive({ drive: "push", until: addDaysISO(today(), 3) });
  setTrainingDrive({ drive: "push", until: addDaysISO(today(), 6) });
  assert.equal(trainingDriveState(today()).stance.previous_drive, "steady");
  assert.equal(effectiveTrainingDrive(addDaysISO(today(), 7)), "steady");
});

test("the Settings toggle ends any open stance — the athlete's newest word wins", () => {
  setTrainingDrive({ drive: "push", until: addDaysISO(today(), 9) });
  repo.setSettings({ training_drive: "steady" });
  assert.equal(pushStanceActive(today()), false);
  repo.setSettings({ training_drive: "push" });
  assert.equal(pushStanceActive(today()), false, "re-toggling push is the standing drive, not the old stance");
  assert.equal(effectiveTrainingDrive(today()), "push");
});

test("dates: past refused, a far date capped and said, the block's end, and a default", () => {
  assert.equal(setTrainingDrive({ drive: "push", until: addDaysISO(today(), -1) }).ok, false);
  assert.equal(setTrainingDrive({ drive: "push", until: "2030-02-31" }).ok, false);
  assert.equal(setTrainingDrive({ drive: "sideways" }).ok, false);
  const far = setTrainingDrive({ drive: "push", until: addDaysISO(today(), 400) });
  assert.equal(far.ok, true);
  assert.ok(far.notes.some((n) => /at most/.test(n)));
  assert.equal(trainingDriveState(today()).stance.until, addDaysISO(today(), 84));
  const def = setTrainingDrive({ drive: "push" });
  assert.equal(trainingDriveState(today()).stance.until, addDaysISO(today(), 27), def.notes.join(" "));
  createBlock({ goal: "Strength", focus: "strength", total_weeks: 6, week_index: 6 });
  const block = setTrainingDrive({ drive: "push", scope: "block" });
  const stance = trainingDriveState(today()).stance;
  assert.equal(stance.scope, "block");
  assert.ok(stance.until >= today() && stance.until <= addDaysISO(today(), 6), stance.until);
  assert.ok(
    block.notes.some((n) => /block ends/.test(n)),
    "a block ending inside the week says so"
  );
});

// ---------- the envelope: what a stance widens, and what it never touches ----------

function snapshot(overrides = {}) {
  return {
    date: "2031-05-01",
    request: { override: null, train_anyway: false, equipment: null, minutes: null, goal: null },
    plan: {
      day_number: 1,
      focus: "Push",
      plan_day_id: 10,
      source: "adaptive",
      reason: "Push is due",
      due: ["chest"],
      over: [],
    },
    day_read: {
      kind: "train",
      focus: "Push",
      est_minutes: 55,
      consecutive_training_days: 5,
      recovery_week: false,
      trained_today: false,
    },
    recovery: { has_data: true, readiness: "high", hrv_drift: "flat", rhr_drift: "flat", sleep_drift: "flat" },
    muscle_load: [],
    endurance: [],
    checkin: null,
    feedback: null,
    constraints: { injuries: [], illness: false, travel: false },
    program: { mesocycle_phase: "intensification", adaptations_due: [], volume_low_groups: [], volume_high_groups: [] },
    progression: [],
    plan_items: [
      { exercise: "Barbell Bench Press", muscle_group: "chest", equipment: "barbell", mode: "reps", kind: "strength" },
      {
        exercise: "Barbell Overhead Press",
        muscle_group: "shoulders",
        equipment: "barbell",
        mode: "reps",
        kind: "strength",
      },
    ],
    training_intent: {
      endurance_role: "supporting",
      priorities: ["longevity", "muscle", "strength", "leanness", "endurance"],
      source: "explicit",
    },
    ...overrides,
  };
}

const NOW = "2031-05-01T12:00:00.000Z";
const support = (over = {}) => ({
  training_drive: "push",
  backed: false,
  backed_by: [],
  training_directive: "proceed",
  fresh_brake: false,
  ...over,
});
const STANCE = { until: "2031-05-20", harm_free: true };

test("without a stance, longevity-first holds the load on a stacked day and nothing reaches", () => {
  const env = buildDailySessionDecision(snapshot({ signal_support: support() }), { now: NOW });
  assert.equal(env.caps.intensity, "hold");
  assert.equal(env.reach.level, null);
  assert.ok(!env.precedence.includes("push_stance"));
});

test("a clean stance lifts the preference hold, backs the reach, and licenses two hosts", () => {
  const env = buildDailySessionDecision(snapshot({ signal_support: support({ push_stance: STANCE }) }), { now: NOW });
  assert.equal(env.caps.intensity, "normal");
  assert.equal(env.caps.volume, "normal");
  assert.equal(env.reach.level, "push");
  assert.equal(env.reach.hosts, PUSH_STANCE_REACH_HOSTS);
  assert.deepEqual(env.reach.backed_by, ["push_stance", "training_log"]);
  assert.ok(REACH_STANCE_WHY.includes(env.reach.why));
  assert.ok(env.precedence.includes("push_stance"));
  const line = env.rationale.find((r) => r.code === "push_stance");
  assert.ok(
    PUSH_STANCE_RATIONALE.some((v) => v("May 20") === line.text),
    line.text
  );
});

test("a deeply recovering main lift no longer parks a stance's reach (composition still refuses the host)", () => {
  const deep = [{ group: "chest", days_ago: 1, saturated: true, source: "strength", deep: true }];
  const plain = buildDailySessionDecision(
    snapshot({ signal_support: support({ backed: true, backed_by: ["session_quality"] }), muscle_load: deep }),
    { now: NOW }
  );
  assert.equal(plain.reach.level, null);
  const stance = buildDailySessionDecision(
    snapshot({ signal_support: support({ push_stance: STANCE }), muscle_load: deep }),
    { now: NOW }
  );
  assert.equal(stance.reach.level, "push");
  assert.ok(stance.muscles.saturated.includes("chest"), "the group stays saturated for composition");
});

test("the stance widens nothing over harm, a deciding brake, the ceiling, or a signal hold", () => {
  const harmed = buildDailySessionDecision(
    snapshot({ signal_support: support({ push_stance: { ...STANCE, harm_free: false } }) }),
    { now: NOW }
  );
  assert.equal(harmed.caps.intensity, "hold");
  assert.equal(harmed.reach.level, null);

  const braked = buildDailySessionDecision(
    snapshot({ signal_support: support({ push_stance: STANCE, fresh_brake: true }) }),
    { now: NOW }
  );
  assert.equal(braked.reach.level, null);
  assert.equal(braked.caps.intensity, "hold");

  const ceiling = buildDailySessionDecision(
    snapshot({
      signal_support: support({ push_stance: STANCE }),
      day_read: { ...snapshot().day_read, consecutive_training_days: PUSH_STANCE_CONSEC_CEILING },
    }),
    { now: NOW }
  );
  assert.equal(ceiling.caps.intensity, "hold", "past the stance's own ceiling the stack is pressure again");

  const sore = buildDailySessionDecision(
    snapshot({ signal_support: support({ push_stance: STANCE }), checkin: { soreness: 5 } }),
    { now: NOW }
  );
  assert.equal(sore.caps.intensity, "hold", "soreness keeps its own cap");

  const steady = buildDailySessionDecision(
    snapshot({ signal_support: support({ training_drive: "steady", push_stance: STANCE }) }),
    { now: NOW }
  );
  assert.equal(steady.reach.level, null, "a stance under a steady drive is no stance");
});

// ---------- the "why not more" read ----------

test("pushHolds names the quiet day's own reason first, then the lifts in their own words", () => {
  const env = buildDailySessionDecision(snapshot({ signal_support: support() }), { now: NOW });
  env.candidates = [
    {
      exercise: "Barbell Bench Press",
      muscle_group: "chest",
      action: "hold",
      reason_code: "progression_hold",
      progression_evidence: { why: "The reps were there at a lighter load; 140 lb is where they need to land next." },
    },
  ];
  const holds = pushHolds({
    envelope: env,
    read: { kind: "train", why: "", decision: null },
    brakeFields: [],
    stanceActive: false,
    stanceHarm: null,
    consecutive: 5,
  });
  const codes = holds.map((h) => h.code);
  assert.ok(codes.includes("preference"));
  assert.ok(codes.includes("not_vouched"));
  assert.ok(holds.some((h) => h.code === "lift_hold" && /^Barbell Bench Press: The reps were there/.test(h.words)));

  const quiet = pushHolds({
    envelope: null,
    read: { kind: "rest", why: "x", decision: { reason: "Readiness is rest-grade this morning." } },
    brakeFields: ["training_readiness"],
    stanceActive: true,
    stanceHarm: "a recent session came in under par",
    consecutive: 2,
  });
  assert.equal(quiet[0].code, "quiet_day");
  assert.equal(quiet[0].words, "Readiness is rest-grade this morning");
  assert.ok(quiet.some((h) => h.code === "stance_harm"));
  for (const hold of [...holds, ...quiet]) assert.doesNotMatch(hold.words, /\b\d+\s*\/\s*100\b|score/i);
});

test("the read: licenses, never-overrides, stance line; steady says nothing extra", () => {
  const steady = trainingDriveRead(today(), { withToday: false });
  assert.equal(steady.drive, "steady");
  assert.deepEqual(steady.licenses, []);
  assert.ok(steady.never_overrides.length >= 5);
  setTrainingDrive({ drive: "push", until: addDaysISO(today(), 10), words: "push me" });
  const pushed = trainingDriveRead(today(), { withToday: false });
  assert.equal(pushed.drive, "push");
  assert.equal(pushed.stance.days_left, 10);
  assert.ok(pushed.licenses.some((l) => /two heavier top sets/.test(l)));
  assert.match(pushed.stance.line, /through/);
  const coach = trainingDriveForCoach(today());
  assert.equal(coach.stance.words, "push me");
  const line = renderTrainingDriveLine({ training_drive: coach });
  assert.match(line, /THEIR OWN STANCE — PUSH/);
  assert.match(line, /never overrides/);
  assert.equal(renderTrainingDriveLine({ training_drive: { ...coach, drive: "steady", stance: null } }), "");
});

test("a past stance is said once it runs out", () => {
  setTrainingDrive({ drive: "push", until: addDaysISO(today(), 2) });
  const later = trainingDriveRead(addDaysISO(today(), 3), { withToday: false });
  assert.equal(later.drive, "steady");
  assert.equal(later.ended.until, addDaysISO(today(), 2));
});

// ---------- progression: one rep in hand is strong enough under a stance ----------

test("under a stance, a top set capped with one rep in hand earns the step; RIR 0 never does", () => {
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  const day = repo.savePlanDay(1, "Push", "Push", [
    { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 },
  ]);
  db.prepare(`UPDATE plan_items SET prescribed_at = ? WHERE plan_day_id = ?`).run(addDaysISO(today(), -120), day.id);
  const logAt = (back, rir) => {
    const ex = repo.findExercise("Bench Press");
    const session = repo.getOrCreateSession(addDaysISO(today(), -back), null);
    for (let i = 1; i <= 3; i++)
      db.prepare(
        `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(session.id, ex.id, i, 185, 8, rir);
  };
  logAt(3, 1);
  const plain = nextPrescription("Bench Press", undefined, { drive: "push", pushStance: false });
  const stance = nextPrescription("Bench Press", undefined, { drive: "push", pushStance: true });
  assert.equal(plain.action, "hold", plain.why);
  assert.equal(stance.action, "overload", stance.why);
  assert.ok(stance.suggested.weight > 185);
  const steady = nextPrescription("Bench Press", undefined, { drive: "steady", pushStance: true });
  assert.equal(steady.action, "hold", "a stance under a steady drive buys nothing");

  db.prepare(`DELETE FROM logged_sets`).run();
  logAt(3, 0);
  const grind = nextPrescription("Bench Press", undefined, { drive: "push", pushStance: true });
  assert.equal(grind.action, "hold", "RIR 0 is a grind under any stance");
});

// ---------- chat: only the athlete's own words set it ----------

test("chat intent: a statement sets it, a question never does", () => {
  for (const yes of [
    "I think I can push way harder than the program is recommending.",
    "Push me harder until the block ends",
    "I can go harder than this",
    "back to steady please",
  ])
    assert.equal(hasExplicitTrainingDriveIntent(yes), true, yes);
  for (const no of ["Should I push harder?", "what do you think about pushing?", "I pushed the sled today"])
    assert.equal(hasExplicitTrainingDriveIntent(no), false, no);
  assert.deepEqual(normalizeChatAction({ type: "set_training_drive", drive: "Push", scope: "block" }), {
    type: "set_training_drive",
    drive: "push",
    scope: "block",
  });
  assert.equal(normalizeChatAction({ type: "set_training_drive", drive: "max" }), null);
});

// ---------- review fixes (2026-10-06) ----------

test("the one-rep strong-top-set bar opens only while the stance is in force AND the last three days are harm-free", () => {
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  const day = repo.savePlanDay(1, "Push", "Push", [
    { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 },
  ]);
  db.prepare(`UPDATE plan_items SET prescribed_at = ? WHERE plan_day_id = ?`).run(addDaysISO(today(), -120), day.id);
  const ex = repo.findExercise("Bench Press");
  const session = repo.getOrCreateSession(addDaysISO(today(), -3), null);
  for (let i = 1; i <= 3; i++)
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(session.id, ex.id, i, 185, 8, 1);
  setTrainingDrive({ drive: "push", until: addDaysISO(today(), 10) });
  assert.equal(pushStanceActive(today()), true);
  assert.equal(pushStanceInForce(today()), true, "a clean stance is in force");
  assert.equal(nextPrescription("Bench Press").action, "overload", "read for the day: the stance widens the bar");

  // A rest-grade morning yesterday charges harm to the day before it: the stance still
  // covers today, but it widens nothing — the same harm_free the day read and the daily
  // decision gate on (push-stance-open.ts).
  repo.upsertGarminDailyMetric({ date: addDaysISO(today(), -1), training_readiness: 11 });
  assert.equal(pushStanceHarmFree(today()), false);
  assert.equal(pushStanceActive(today()), true, "the stance itself still covers the day");
  assert.equal(pushStanceInForce(today()), false);
  const held = nextPrescription("Bench Press");
  assert.equal(held.action, "hold", held.why);
  // Only the read-for-the-day changed: an explicit in-force stance still widens it.
  assert.equal(nextPrescription("Bench Press", undefined, { drive: "push", pushStance: true }).action, "overload");
});

test("a settings write that re-sends the CURRENT standing drive never ends an open stance", () => {
  setTrainingDrive({ drive: "push", until: addDaysISO(today(), 9) });
  repo.setSettings({ training_drive: "push", lead_mode: "lead" });
  assert.equal(pushStanceActive(today()), true, "push → push is not a toggle");
  repo.setSettings({ lead_mode: "announce_first" });
  assert.equal(pushStanceActive(today()), true, "a save without training_drive leaves the stance alone");
  repo.setSettings({ training_drive: "steady" });
  assert.equal(pushStanceActive(today()), false, "an actual move to steady still ends it");
});

test("the athlete undoing their own push stance is never rollback evidence about the brain", () => {
  for (const days of [5, 8, 11]) {
    const res = setTrainingDrive({ drive: "push", until: addDaysISO(today(), days) });
    const undone = revertDecision(res.decision_id);
    assert.equal(undone.ok, true, undone.error);
  }
  const kinds = rollbackEvidenceByKind().map((g) => g.kind);
  assert.ok(!kinds.includes("training_structure"), kinds.join(","));
  const model = buildReactionModel();
  assert.ok(
    !model.patterns.some((p) => p.kind === "rollback_evidence"),
    "no 'you've undone a training structure change' read off his own statements"
  );
});

test("a past stance is said for a week after it ends, then the fall-back drive simply stands", () => {
  const until = addDaysISO(today(), 2);
  setTrainingDrive({ drive: "push", until });
  const lastSaid = addDaysISO(until, PUSH_STANCE_ENDED_SAY_DAYS);
  assert.equal(trainingDriveRead(lastSaid, { withToday: false }).ended?.until, until);
  assert.equal(trainingDriveForCoach(lastSaid).ended_until, until);
  const later = addDaysISO(lastSaid, 1);
  const read = trainingDriveRead(later, { withToday: false });
  assert.equal(read.ended, null, "the end is no longer news");
  assert.equal(read.drive, "steady", "the drive still falls back to what stood before");
  assert.equal(read.standing, "push", "the saved preference is not rewritten without a write");
  assert.equal(trainingDriveForCoach(later).ended_until, null);
  assert.doesNotMatch(renderTrainingDriveLine({ training_drive: trainingDriveForCoach(later) }), /ENDED/i);
});

test("chat intent: inability, pain narration and a 'back to normal' about sleep never set the drive", () => {
  for (const no of [
    "I can't push harder, my knee hurts",
    "I'm not taking the deload because my knee hurts",
    "I don't think I can go heavier this week",
    "my sleep is back to normal",
    "skipping the deload, my shoulder is sore",
  ])
    assert.equal(hasExplicitTrainingDriveIntent(no), false, no);
  for (const yes of [
    "I can push harder, my knee doesn't hurt anymore",
    "back to normal training please, no more pushing",
    "let's go back to normal intensity",
    "don't push me so hard, back to steady",
  ])
    assert.equal(hasExplicitTrainingDriveIntent(yes), true, yes);
});
