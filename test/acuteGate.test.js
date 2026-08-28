// acuteGate — ONE acute-recovery question, asked the same way everywhere.
// Four consumers used to ask it four different ways (`heavy` alone, `heavy &&
// days_ago <= 2`, `heavy && days_ago <= 1`, and a bare `heavy` in the progression
// brake), so the same muscle could read "recovering" to the plan-day picker and
// "fresh" to the envelope on the same morning. Two surfaces that shape what the
// athlete READS — the forward look and the week-ahead floor — never asked at all,
// which is how the Brief could say "quads due" the morning after the long run
// that flattened them. Pinned here: every consumer agrees, and those two surfaces
// now ask.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import {
  acuteGate,
  acuteGates,
  legLoadGroupsPhrase,
  muscleLoadPayload,
  strengthLegLoad,
  suppressSaturatedDue,
} from "../dist/repo/hybrid-load.js";
import { renderProgramState } from "../dist/prompt/shared.js";
import { forwardLook, weekAheadPlan } from "../dist/repo/day-read.js";
import { programAdjustments, programBalance } from "../dist/repo/progression.js";
import { gatherDailyDecisionSnapshot } from "../dist/repo/daily-decision.js";
import { selectAdaptivePlanDay } from "../dist/repo/plan-selection.js";

const REF = "2026-05-15";

function reset() {
  resetTables(
    "logged_sets",
    "sessions",
    "exercises",
    "activities",
    "garmin_activities",
    "plan_items",
    "plan_days",
    "day_reads",
    "checkins",
    "profile"
  );
}
beforeEach(reset);

// A plan that programs legs and pull, so programBalance has groups to call due
// and the plan-day picker has two genuinely different days to choose between.
function seedSplit() {
  repo.setProfile({ primary_discipline: "strength" });
  repo.savePlanDay(1, "Lower", "Lower", [
    { exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 8 },
    { exercise: "Romanian Deadlift", sets: 3, rep_low: 8, rep_high: 10 },
  ]);
  repo.savePlanDay(2, "Pull", "Pull", [
    { exercise: "Lat Pulldown", sets: 3, rep_low: 8, rep_high: 12 },
    { exercise: "Barbell Row", sets: 3, rep_low: 8, rep_high: 12 },
  ]);
}

// The long run that flattens the legs without touching logged_sets — the exact
// shape the strength-only balance read is blind to.
function longRun(date = REF) {
  repo.addActivity({ type: "run", duration_min: 95, distance_km: 16, date });
}

// ── the two surfaces that never asked ────────────────────────────────────────

test("the forward look stops naming a group that yesterday's long run flattened", () => {
  seedSplit();
  const before = forwardLook(REF);
  assert.ok(before.due.includes("quads"), "with no running, quads read as due");

  longRun();
  assert.equal(acuteGate("quads", REF).saturated, true, "the run saturated the quads");
  const after = forwardLook(REF);
  assert.ok(!after.due.includes("quads"), `quads must not be offered as due (got ${JSON.stringify(after.due)})`);
  assert.ok(
    !/quads/i.test(after.text ?? ""),
    `and must not appear in the athlete-facing line (got ${after.text})`
  );
});

test("the forward look still names the groups the run did NOT touch", () => {
  seedSplit();
  longRun();
  const look = forwardLook(REF);
  assert.equal(acuteGate("back", REF).saturated, false, "a run does not saturate the back");
  assert.ok(look.due.includes("back"), `back stays due and actionable (got ${JSON.stringify(look.due)})`);
});

test("the week-ahead floor applies the same gate to its due note", () => {
  seedSplit();
  const before = weekAheadPlan(REF);
  assert.match(before.summary, /quads/i, "with no running the floor names quads");

  longRun();
  const after = weekAheadPlan(REF);
  assert.doesNotMatch(after.summary, /quads/i, `the flattened group is not a "go work it in" note: ${after.summary}`);
  assert.match(after.summary, /back/i, "the fresh group still is");
});

test("suppressSaturatedDue keeps a list it cannot read rather than emptying a surface", () => {
  assert.deepEqual(suppressSaturatedDue([], REF), []);
  assert.deepEqual(suppressSaturatedDue(["back", "chest"], REF), ["back", "chest"]);
  longRun();
  assert.deepEqual(suppressSaturatedDue(["quads", "back"], REF), ["back"]);
  // Free-form casing folds onto the canon before the gate is read.
  assert.deepEqual(suppressSaturatedDue(["Quads"], REF), []);
});

// ── every consumer gives the same answer ─────────────────────────────────────

test("the daily-decision snapshot carries the gate verbatim, with no window of its own", () => {
  seedSplit();
  longRun();
  const snapshot = gatherDailyDecisionSnapshot(REF);
  const gates = acuteGates(REF);
  assert.ok(snapshot.muscle_load.length > 0, "the snapshot sees the load");
  for (const entry of snapshot.muscle_load) {
    assert.equal(
      entry.saturated,
      gates.get(entry.group)?.saturated === true,
      `${entry.group}: the envelope must read the same gate as everyone else`
    );
  }
  const quads = snapshot.muscle_load.find((m) => m.group === "quads");
  assert.ok(quads?.saturated, "quads are saturated in the snapshot");
});

test("a group saturated THREE days ago still reaches the envelope (the old 2-day window hid it)", () => {
  seedSplit();
  const threeBack = new Date(new Date(`${REF}T00:00:00Z`).getTime() - 3 * 864e5).toISOString().slice(0, 10);
  // A genuinely big hamstring day: slow-recovering group, large dose.
  const ex = repo.upsertExercise({ name: "Romanian Deadlift", muscle_group: "hamstrings", mode: "reps" });
  const sess = repo.getOrCreateSession(threeBack, null);
  for (let i = 1; i <= 14; i++) {
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sess.id, ex.id, i, 225, 8, 1);
  }
  assert.equal(acuteGate("hamstrings", REF).saturated, true, "that much work is still present three days on");
  const snapshot = gatherDailyDecisionSnapshot(REF);
  const hams = snapshot.muscle_load.find((m) => m.group === "hamstrings");
  assert.ok(hams, "the envelope can see a group last trained outside a 2-day window");
  assert.equal(hams.saturated, true);
});

test("plan-day selection and programAdjustments agree with the gate on what is recovering", () => {
  seedSplit();
  longRun();
  const gates = acuteGates(REF);

  const selected = selectAdaptivePlanDay(REF);
  for (const score of selected.selection.scores) {
    for (const group of score.recovering) {
      assert.equal(gates.get(group)?.saturated, true, `${group} is only "recovering" when the gate says so`);
    }
  }
  for (const entry of selected.selection.recent_load) {
    assert.equal(entry.saturated, gates.get(entry.group)?.saturated === true);
  }

  const adjustments = programAdjustments(programBalance(2, REF), gates);
  const recoveringRow = adjustments.find((a) => a.recovering);
  if (recoveringRow) {
    assert.equal(gates.get(recoveringRow.group)?.saturated, true);
  }
  // Whatever else it says, a saturated group is never put up as a fresh "do this".
  for (const row of adjustments) {
    if (row.kind !== "balance" || row.recovering || !row.group) continue;
    assert.notEqual(
      gates.get(row.group)?.saturated,
      true,
      `${row.group} is saturated and must not be offered as actionable`
    );
  }
});

test("the plan-day picker leans away from the day whose groups the run flattened", () => {
  seedSplit();
  longRun();
  const selected = selectAdaptivePlanDay(REF);
  const lower = selected.selection.scores.find((s) => s.day_number === 1);
  const pull = selected.selection.scores.find((s) => s.day_number === 2);
  assert.ok(lower && pull);
  assert.ok(lower.recovering.length > 0, "the lower day's groups are recovering");
  assert.equal(pull.recovering.length, 0, "the pull day's are not");
  assert.ok(pull.score > lower.score, `the fresher day scores higher (${pull.score} vs ${lower.score})`);
});

// ── endurance credit in the WEEKLY balance read ──────────────────────────────
// Different question, different window: the gate above asks "can this region take
// work today"; this asks "has it had enough work lately". programBalance read
// logged_sets only, so a 40-mile running week left legs permanently "due" and the
// system kept telling a runner to go add squat volume to quads it had been
// pounding daily.

test("a heavy running week stops legs reading as due — while the pull day still does", () => {
  seedSplit();
  const bare = programBalance(2, REF);
  assert.ok(bare.due.includes("quads"), "with no running, quads are due");

  for (let d = 0; d < 12; d++) longRun(new Date(new Date(`${REF}T00:00:00Z`).getTime() - d * 864e5).toISOString().slice(0, 10));
  const loaded = programBalance(2, REF);
  assert.ok(!loaded.due.includes("quads"), `quads are loaded, not neglected (${JSON.stringify(loaded.due)})`);
  assert.ok(!loaded.due.includes("calves"), "so are calves");
  assert.ok(loaded.due.includes("back"), "the back is genuinely untrained and still says so");
});

test("endurance credit is kept OUT of the working-set count — landmarks are resistance-calibrated", () => {
  seedSplit();
  for (let d = 0; d < 12; d++) longRun(new Date(new Date(`${REF}T00:00:00Z`).getTime() - d * 864e5).toISOString().slice(0, 10));
  const bal = programBalance(2, REF);
  const quads = bal.groups.find((g) => g.group === "quads");
  assert.ok(quads);
  assert.equal(quads.sets, 0, "a run is never counted as a working set");
  assert.equal(quads.band, "low", "the resistance-volume band stays honest");
  assert.ok(quads.endurance_sessions > 0, "the endurance load is carried in its own field");
  assert.equal(quads.endurance_supported, true);
  assert.equal(quads.status, "ok", "…and that is what keeps it off the due list");
});

test("a light week of running is not enough to suppress a due group", () => {
  seedSplit();
  repo.addActivity({ type: "walk", duration_min: 20, distance_km: 1.5, date: REF });
  const bal = programBalance(2, REF);
  assert.ok(bal.due.includes("quads"), "one short stroll does not carry the quads");
  const quads = bal.groups.find((g) => g.group === "quads");
  assert.equal(quads.endurance_supported, false);
});

test("the balance summary says a carried region is light on lifting, not neglected", () => {
  seedSplit();
  for (let d = 0; d < 12; d++) longRun(new Date(new Date(`${REF}T00:00:00Z`).getTime() - d * 864e5).toISOString().slice(0, 10));
  const bal = programBalance(2, REF);
  if (bal.groups.some((g) => g.endurance_supported) && !bal.broad_low) {
    assert.match(bal.summary, /carrying your endurance work/i, bal.summary);
  }
  assert.doesNotMatch(bal.summary, /\bquads\b.*\bdue\b/i, "and never calls a pounded region due");
});

// ── fatigue-aware plan-day preference ────────────────────────────────────────
// When today's programmed day is still carrying work and another plan day is
// not, the picker prefers the fresher day and SAYS SO in plain muscle words.
// It is a suggestion about WHICH day, never about whether to train: the day
// read's kind (rest / easy / train) is contractually informational here and
// stays untouched.

import { violatesReadingGrammar } from "../dist/repo/day-read.js";

test("the reason for preferring a fresher day speaks plain muscle words, not canonical keys", () => {
  repo.setProfile({ primary_discipline: "strength" });
  repo.savePlanDay(1, "Shoulder detail", "Shoulder detail", [
    { exercise: "Rear Delt Fly", sets: 3, rep_low: 10, rep_high: 15 },
  ]);
  repo.savePlanDay(2, "Pull", "Pull", [{ exercise: "Lat Pulldown", sets: 3, rep_low: 8, rep_high: 12 }]);
  // Saturate the rear delts, so whichever day leads with them is the tired one.
  const ex = repo.upsertExercise({ name: "Rear Delt Fly", muscle_group: "rear delts", mode: "reps" });
  const sess = repo.getOrCreateSession(REF, null);
  for (let i = 1; i <= 6; i++) {
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sess.id, ex.id, i, 30, 12, 1);
  }
  assert.equal(acuteGate("rear delts", REF).saturated, true);
  const reason = selectAdaptivePlanDay(REF)?.selection?.reason;
  if (reason) {
    assert.doesNotMatch(reason, /rear delts/i, `the canonical key must not reach the athlete: ${reason}`);
    assert.match(reason, /rear shoulders/i, `it says the friendly name instead: ${reason}`);
  }
});

test("every plan-selection reason passes the reading grammar", () => {
  seedSplit();
  longRun();
  const reason = selectAdaptivePlanDay(REF)?.selection?.reason;
  if (reason) {
    assert.equal(violatesReadingGrammar(reason), null, `reason must read as coaching prose: ${reason}`);
    assert.match(reason, /^[a-z]/, "a lowercase-starting fragment, spliced into the Brief's why");
    assert.doesNotMatch(reason, /[.!?]$/, "with no terminal punctuation");
  }
});

test("the fatigue-aware reason rotates rather than printing one literal every morning", () => {
  const seen = new Set();
  for (let d = 0; d < 12; d++) {
    reset();
    seedSplit();
    const day = new Date(new Date(`${REF}T00:00:00Z`).getTime() + d * 864e5).toISOString().slice(0, 10);
    longRun(day);
    const reason = selectAdaptivePlanDay(day)?.selection?.reason;
    if (reason) seen.add(reason);
  }
  assert.ok(seen.size >= 4, `a stable state must not read as a stuck app (saw ${seen.size} phrasings)`);
  for (const reason of seen) {
    assert.equal(violatesReadingGrammar(reason), null, reason);
  }
});

test("the plan-day picker answers WHICH day and nothing else — it carries no kind", () => {
  seedSplit();
  longRun();
  const selected = selectAdaptivePlanDay(REF);
  assert.deepEqual(Object.keys(selected).sort(), ["day_number", "day_type", "focus", "selection"]);
  assert.doesNotMatch(JSON.stringify(selected), /"kind"/, "the picker never speaks about rest / easy / train");
});

test("whether the preference fires does not move the day read's kind", () => {
  // Identical signals, two plans: with a split there is a fresher day to prefer,
  // with one plan day there is nothing to prefer. The read's kind must not care.
  seedSplit();
  longRun();
  const withAlternative = repo.dayRead(REF, { has_data: false, recovery: {} });
  const adapted = selectAdaptivePlanDay(REF);

  reset();
  repo.setProfile({ primary_discipline: "strength" });
  repo.savePlanDay(1, "Lower", "Lower", [
    { exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 8 },
    { exercise: "Romanian Deadlift", sets: 3, rep_low: 8, rep_high: 10 },
  ]);
  longRun();
  const noAlternative = repo.dayRead(REF, { has_data: false, recovery: {} });

  assert.equal(selectAdaptivePlanDay(REF).selection.adapted, false, "with one plan day nothing can be preferred");
  assert.equal(
    withAlternative.kind,
    noAlternative.kind,
    `the preference is about WHICH day, never whether to train (adapted=${adapted.selection.adapted})`
  );
});

test("with nothing saturated the picker leaves the normal rotation alone", () => {
  seedSplit();
  const selected = selectAdaptivePlanDay(REF);
  const recovering = selected.selection.scores.flatMap((s) => s.recovering);
  assert.deepEqual(recovering, [], "nothing is recovering");
  assert.doesNotMatch(
    String(selected.selection.reason ?? ""),
    /carrying recent work|another day|recover/i,
    "so it never invents a freshness reason"
  );
});

// ── strengthLegLoad: what the LIFTING left in the running legs ────────────────
// The run builder's half of the same question. It reads the STRENGTH-sourced share
// of the residual on purpose — the run week already sees its own lane from every
// angle, so counting the athlete's running here would defer every build week their
// running earned.

test("a real lower-body session reads saturated, and names the groups in plain words", () => {
  for (let i = 0; i < 4; i++) repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date: REF });
  for (let i = 0; i < 3; i++)
    repo.logSetByName({ exercise: "Romanian Deadlift", weight: 185, reps: 8, rir: 2, date: REF });
  const load = strengthLegLoad(REF);
  assert.equal(load.band, "saturated");
  assert.equal(load.saturated, true);
  assert.ok(load.saturated_groups.includes("quads"), "the squat's prime mover is at the bar");
  assert.ok(load.saturated_groups.length + load.loaded_groups.length >= 2, "and a second group is carrying work");
  const phrase = legLoadGroupsPhrase(load);
  assert.match(phrase, /^your /, "plain second-person words");
  assert.doesNotMatch(phrase, /\d|residual|saturat/i, "no number and no engineering vocabulary");
});

test("a long run does NOT read as leg load here — that lane is already visible to the run week", () => {
  longRun();
  assert.equal(acuteGate("quads", REF).saturated, true, "the run genuinely saturated the quads");
  const load = strengthLegLoad(REF);
  assert.equal(load.band, "fresh", "but the STRENGTH share is empty, so this read stays quiet");
  assert.equal(load.has_data, false);
  assert.equal(load.saturated, false);
});

test("one isolated accessory group is loaded, never saturated (a leg day is two groups)", () => {
  for (let i = 0; i < 6; i++)
    repo.logSetByName({ exercise: "Standing Calf Raise", weight: 120, reps: 12, rir: 1, date: REF });
  const load = strengthLegLoad(REF);
  assert.equal(load.saturated, false, "a calf block is not a reason to shrink a long run");
  assert.equal(load.band, "loaded");
});

test("strengthLegLoad is quiet and neutral with nothing logged at all", () => {
  const load = strengthLegLoad(REF);
  assert.deepEqual(load, { band: "fresh", saturated: false, saturated_groups: [], loaded_groups: [], has_data: false });
});

test("lower-body lifting fades: the same session read a week later no longer defers anything", () => {
  const weekAgo = new Date(new Date(`${REF}T00:00:00Z`).getTime() - 7 * 864e5).toISOString().slice(0, 10);
  for (let i = 0; i < 4; i++) repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date: weekAgo });
  for (let i = 0; i < 3; i++)
    repo.logSetByName({ exercise: "Romanian Deadlift", weight: 185, reps: 8, rir: 2, date: weekAgo });
  assert.equal(strengthLegLoad(weekAgo).saturated, true, "on the day, it defers");
  assert.equal(strengthLegLoad(REF).saturated, false, "a week later it does not");
});

test("muscle-load payload carries the gate for a group last loaded outside the 2-day window", () => {
  seedSplit();
  const threeBack = new Date(new Date(`${REF}T00:00:00Z`).getTime() - 3 * 864e5).toISOString().slice(0, 10);
  const ex = repo.upsertExercise({ name: "Romanian Deadlift", muscle_group: "hamstrings", mode: "reps" });
  const sess = repo.getOrCreateSession(threeBack, null);
  for (let i = 1; i <= 14; i++) {
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sess.id, ex.id, i, 225, 8, 1);
  }
  assert.equal(acuteGate("hamstrings", REF).saturated, true, "that much work is still present three days on");

  const payload = muscleLoadPayload(2, REF);
  const hams = payload.groups.find((g) => g.group === "hamstrings");
  assert.ok(hams, "the payload includes a group the 2-day recency window would have dropped");
  assert.equal(hams.saturated, true, "saturated is the acuteGate answer, not a days_ago heuristic");
  assert.equal(hams.heavy, true);
});

test("the do-NOT-program prompt block names a group the 2-day window would have hidden", () => {
  seedSplit();
  const threeBack = new Date(new Date(`${REF}T00:00:00Z`).getTime() - 3 * 864e5).toISOString().slice(0, 10);
  const ex = repo.upsertExercise({ name: "Romanian Deadlift", muscle_group: "hamstrings", mode: "reps" });
  const sess = repo.getOrCreateSession(threeBack, null);
  for (let i = 1; i <= 14; i++) {
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sess.id, ex.id, i, 225, 8, 1);
  }
  const gates = [...acuteGates(REF).values()].filter((g) => g.saturated);
  assert.ok(gates.some((g) => g.group === "hamstrings"));

  const text = renderProgramState({
    program_state: { headline: "the program is in a productive stretch." },
    acute_gates: gates.map(({ residual: _residual, ...rest }) => rest),
    recent_load: [],
  });
  assert.match(text, /do NOT program these/i);
  assert.match(text, /hamstrings/);
});
