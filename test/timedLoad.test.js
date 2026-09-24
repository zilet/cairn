// Loaded timed work — a carry or weighted hold is a LOAD plus a TIME. Invariants:
//   - a timed plan item may carry target_weight (lb; negative = assist) beside its
//     target_seconds; timed + reps stays an error
//   - composition passes the load through, with load_basis "loaded"
//   - progression moves seconds first, then — once every set owns the hold ceiling —
//     one load step with the seconds reset. Never both at once.
//   - a timed PR is load × time; log_set keeps the load; Garmin gets it too
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, isoDaysAgo, resetTables } from "./_seed.js";
import { nextPrescription, buildProgressionProposal } from "../dist/repo/progression.js";
import { isTimedPr } from "../dist/repo/sessions.js";
import { prepareDailySessionUseCase } from "../dist/domain/training/adaptive-session-use-case.js";
import { registerTrainingLogTools } from "../dist/surfaces/mcp/training-log.js";
import { normalizeChatAction } from "../dist/chatActions.js";
import { buildGarminExerciseSetsPayload } from "../dist/garminExport.js";

beforeEach(() => {
  resetTables(
    "daily_session_outcomes",
    "daily_session_compositions",
    "daily_session_decisions",
    "logged_sets",
    "session_skips",
    "sessions",
    "plan_items",
    "plan_days",
    "plan_proposals",
    "exercises"
  );
  try {
    repo.setSettings({ training_drive: "steady" });
  } catch {
    /* settings row may be absent */
  }
});

function carry(name = "Farmer's Carry") {
  repo.upsertExercise({ name, muscle_group: "forearms", mode: "timed" });
  return repo.findExercise(name);
}

function planCarry(item, name = "Farmer's Carry") {
  const day = repo.savePlanDay(1, "Carry", "Grip", [{ exercise: name, ...item }]);
  db.prepare(`UPDATE plan_items SET prescribed_at = ? WHERE plan_day_id = ?`).run(isoDaysAgo(90), day.id);
  return day;
}

function logTimed(name, date, sets) {
  const ex = repo.findExercise(name);
  const sess = repo.getOrCreateSession(date, null);
  sets.forEach(([weight, seconds], i) => {
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, duration_sec) VALUES (?, ?, ?, ?, ?)`
    ).run(sess.id, ex.id, i + 1, weight, seconds);
  });
}

test("a timed plan item may carry a load; timed + reps is still an error", () => {
  const ok = repo.validateTrainingPlan([
    { day_number: 1, items: [{ exercise: "Farmer's Carry", mode: "timed", sets: 2, target_seconds: 40, target_weight: 55 }] },
  ]);
  assert.equal(ok.errors.length, 0, JSON.stringify(ok.errors));

  const assisted = repo.validateTrainingPlan([
    { day_number: 1, items: [{ exercise: "Dead Hang", mode: "timed", sets: 2, target_seconds: 30, target_weight: -20 }] },
  ]);
  assert.equal(assisted.errors.length, 0, "an assisted hold is valid too");

  const reps = repo.validateTrainingPlan([
    { day_number: 1, items: [{ exercise: "Farmer's Carry", mode: "timed", sets: 2, target_seconds: 40, rep_low: 8 }] },
  ]);
  assert.ok(reps.errors.some((e) => e.code === "timed_load_incoherence"));
});

test("checked saves and target edits persist a load on timed work", () => {
  carry();
  const saved = repo.savePlanDayChecked(1, "Carry", "Grip", [
    { exercise: "Farmer's Carry", sets: 2, target_seconds: 40, target_weight: 55 },
  ]);
  assert.equal(saved.day.items[0].mode, "timed");
  assert.equal(saved.day.items[0].target_weight, 55);
  assert.equal(saved.day.items[0].target_seconds, 40);

  repo.updateTarget(1, "Farmer's Carry", 60, 45);
  const item = repo.getPlanDay(1).items[0];
  assert.equal(item.target_weight, 60);
  assert.equal(item.target_seconds, 45);
});

test("composition passes a timed item's load through as loaded work", () => {
  carry();
  repo.savePlanDay(1, "Carry", "Grip", [{ exercise: "Farmer's Carry", sets: 2, target_seconds: 40, target_weight: 50 }]);
  const accepted = prepareDailySessionUseCase({ date: "2031-04-14", source: "adaptive_plan", day_number: 1 });
  const item = accepted.daily_session.items.find((it) => it.exercise === "Farmer's Carry");
  assert.ok(item, "the carry is on the composed session");
  assert.equal(item.mode, "timed");
  assert.equal(item.target_weight, 50);
  assert.equal(item.target_seconds, 40);
  assert.equal(item.load_basis, "loaded");
});

test("loaded timed work extends the time first and holds the load", () => {
  carry();
  planCarry({ sets: 3, target_seconds: 40, target_weight: 50 });
  logTimed("Farmer's Carry", isoDaysAgo(3), [[50, 45], [50, 44], [50, 42]]);
  const p = nextPrescription("Farmer's Carry");
  assert.equal(p.action, "overload");
  assert.equal(p.suggested.weight, 50, "load held while seconds climb");
  assert.equal(p.suggested.seconds, 44, "40 + a proportional 4s step");
  assert.equal(p.delta_text, "+4s");
});

test("the seconds step stops at the hold ceiling", () => {
  carry();
  planCarry({ sets: 3, target_seconds: 58, target_weight: 50 });
  logTimed("Farmer's Carry", isoDaysAgo(3), [[50, 60], [50, 60], [50, 59]]);
  const p = nextPrescription("Farmer's Carry");
  assert.equal(p.suggested.seconds, 60, "capped at the 60s ceiling, not 58 + 6");
  assert.equal(p.suggested.weight, 50);
});

test("every set owning the ceiling steps the load once and resets the seconds", () => {
  carry();
  planCarry({ sets: 3, target_seconds: 60, target_weight: 50 });
  logTimed("Farmer's Carry", isoDaysAgo(3), [[50, 60], [50, 62], [50, 61]]);
  const p = nextPrescription("Farmer's Carry");
  assert.equal(p.action, "overload");
  assert.ok(p.suggested.weight > 50 && p.suggested.weight <= 55, `one load step (got ${p.suggested.weight})`);
  assert.equal(p.suggested.seconds, 40, "seconds reset to the lower target");
  assert.match(p.delta_text, /^\+[\d.]+ lb, 40s$/);

  const prop = buildProgressionProposal(1);
  assert.equal(prop.ok, true);
  const change = prop.proposal.parsed.changes.find((c) => c.exercise === "Farmer's Carry");
  assert.equal(change.target_weight, p.suggested.weight, "the load step travels on the proposal");
  assert.equal(change.target_seconds, 40);
});

test("a set short of the ceiling holds both load and time", () => {
  carry();
  planCarry({ sets: 3, target_seconds: 60, target_weight: 50 });
  logTimed("Farmer's Carry", isoDaysAgo(3), [[50, 62], [50, 60], [50, 48]]);
  const p = nextPrescription("Farmer's Carry");
  assert.equal(p.action, "hold");
  assert.equal(p.suggested.weight, 50);
  assert.equal(p.suggested.seconds, 60);
});

test("an assisted hold at the ceiling peels assist, never flipping to a load", () => {
  repo.upsertExercise({ name: "Assisted Dead Hang", muscle_group: "forearms", mode: "timed" });
  planCarry({ sets: 2, target_seconds: 60, target_weight: -30 }, "Assisted Dead Hang");
  logTimed("Assisted Dead Hang", isoDaysAgo(3), [[-30, 60], [-30, 61]]);
  const p = nextPrescription("Assisted Dead Hang");
  assert.ok(p.suggested.weight == null || (p.suggested.weight > -30 && p.suggested.weight < 0), `less assist (got ${p.suggested.weight})`);
  assert.equal(p.suggested.seconds, 40);
});

test("unloaded holds keep pure seconds progression", () => {
  repo.upsertExercise({ name: "Plank", muscle_group: "core", mode: "timed" });
  planCarry({ sets: 3, target_seconds: 60 }, "Plank");
  logTimed("Plank", isoDaysAgo(3), [[null, 60], [null, 60], [null, 60]]);
  const p = nextPrescription("Plank");
  assert.equal(p.suggested.weight, undefined);
  assert.equal(p.suggested.seconds, 66, "no ceiling on unloaded work");
});

test("a timed PR is load × time", () => {
  const prior = [{ weight: 50, duration_sec: 60 }, { weight: 40, duration_sec: 90 }];
  assert.equal(isTimedPr({ weight: 50, duration_sec: 61 }, prior), true, "longer at the same load");
  assert.equal(isTimedPr({ weight: 50, duration_sec: 60 }, prior), false, "a tie is not a PR");
  assert.equal(isTimedPr({ weight: 55, duration_sec: 60 }, prior), true, "heavier at the previous time");
  assert.equal(isTimedPr({ weight: 55, duration_sec: 30 }, prior), false, "heavier but much shorter");
  assert.equal(isTimedPr({ weight: 45, duration_sec: 70 }, prior), true, "longest ever at 45+ lb");
  assert.equal(isTimedPr({ weight: 40, duration_sec: 80 }, prior), false, "shorter than 40 × 90");
  assert.equal(isTimedPr({ weight: null, duration_sec: 99 }, [{ weight: null, duration_sec: 90 }]), true);
  assert.equal(isTimedPr({ weight: -20, duration_sec: 60 }, [{ weight: -30, duration_sec: 60 }]), true, "less assist");
  assert.equal(isTimedPr({ weight: 50, duration_sec: 60 }, []), false, "no baseline");
});

test("log_set keeps the load on timed work (MCP and chat) and flags a load × time PR", async () => {
  carry();
  const tools = new Map();
  registerTrainingLogTools({ tool: (name, _d, _s, handler) => tools.set(name, handler) });
  const call = async (args) => JSON.parse((await tools.get("log_set")(args)).content[0].text);

  const first = await call({ exercise: "Farmer's Carry", weight: 50, duration_sec: 58, exercise_mode: "timed", date: isoDaysAgo(2) });
  assert.equal(first.weight, 50);
  assert.equal(first.duration_sec, 58);
  assert.equal(first.pr, false, "first log has no baseline");

  const heavier = await call({ exercise: "Farmer's Carry", weight: 55, duration_sec: 58, exercise_mode: "timed", date: isoDaysAgo(1) });
  assert.equal(heavier.weight, 55);
  assert.equal(heavier.pr, true);

  const highlights = repo.sessionHighlights(heavier.session_id);
  assert.ok(highlights.prs.some((pr) => /55 lb × 58s/.test(pr.label)), JSON.stringify(highlights.prs));

  const action = normalizeChatAction({ type: "log_set", exercise: "Farmer's Carry", weight: 50, duration_sec: 50, exercise_mode: "timed" });
  assert.equal(action.weight, 50);
  assert.equal(action.duration_sec, 50);
});

test("Garmin export sends a timed set's load beside its duration", () => {
  const payload = buildGarminExerciseSetsPayload({
    sets: [
      { exercise: "Farmer's Carry", set_number: 1, weight: 50, reps: null, duration_sec: 45, mode: "timed", garmin_category: "CARRY", garmin_exercise: "FARMERS_CARRY" },
      { exercise: "Plank", set_number: 2, weight: null, reps: null, duration_sec: 60, mode: "timed", garmin_category: "PLANK", garmin_exercise: "PLANK" },
    ],
    sessionStartIso: "2031-04-14T07:30:00",
    durationMin: 20,
  });
  const [loaded, plank] = payload.body.exerciseSets;
  assert.equal(loaded.weight, Math.round((50 / 2.20462) * 1000));
  assert.equal(loaded.repetitionCount, null);
  assert.equal(loaded.duration, 45);
  assert.equal(plank.weight, null);
});
