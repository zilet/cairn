// The coverage pass must do NOTHING while the athlete is protected: an under-fuelling
// protection, cut pressure, an affirmed cut, a volume restore still owed, an active plan
// adaptation. Each state is built from REAL rows through the repo's own writers (no stubbed
// read), and for each one: the preview reports the hold, an acting pass writes no proposal,
// no brain decision and no plan change, and a strict safety read that throws makes the pass
// `unavailable` with everything left as it was.
// Synthetic fixtures only. Deterministic and offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { closePlanCoverageGap, previewPlanCoverageChange } from "../dist/domain/brain/coverage-change.js";
import { COVERAGE_AGENT, planCoverageGap } from "../dist/repo/plan-coverage.js";
import { cutReaffirmation } from "../dist/repo/cut-target.js";
import { readCutPressureStrict, cutPressureRefusesSetIncrease } from "../dist/repo/progression.js";
import { currentUnderfuelingRead } from "../dist/repo/underfueling-snapshot.js";
import { upsertAttentionSchedule } from "../dist/repo/attention.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";

const STRENGTH = { training_intent: { priorities: ["strength", "longevity"], endurance_role: "none" } };
const today = () => localDateISO();
const day = (delta) => addDaysISO(today(), delta);

function fedWeek() {
  return [
    {
      day_number: 1,
      name: "Upper",
      items: [
        { exercise: "Barbell Bench Press", muscle_group: "chest", sets: 5, rep_low: 6, rep_high: 8 },
        { exercise: "Incline Dumbbell Press", muscle_group: "chest", sets: 5, rep_low: 8, rep_high: 10 },
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
const shortWeek = () =>
  fedWeek().map((d, i) =>
    i === 0 ? { ...d, items: d.items.map((item) => (item.muscle_group === "chest" ? { ...item, sets: 3 } : item)) } : d
  );

function seedHabit(exercise, sets) {
  for (const daysAgo of [10, 17]) {
    for (let i = 0; i < sets; i++) repo.logSetByName({ exercise, weight: 100, reps: 8, date: day(-daysAgo) });
  }
}

// Chest short with room to step: without a protection the pass WOULD change the plan.
function shortChestPlan() {
  repo.setSettings({ lead_mode: "lead" });
  repo.setProfile(STRENGTH);
  repo.replacePlan(shortWeek());
  seedHabit("Barbell Bench Press", 4);
  seedHabit("Incline Dumbbell Press", 4);
  assert.deepEqual(planCoverageGap().elements.map((e) => e.key), ["group:chest"], "precondition: chest is short");
}

// Everything a pass could write, in one comparable value.
function snapshot() {
  const count = (sql) => db.prepare(sql).get().n;
  return JSON.stringify({
    plan: repo.getPlan(),
    coverage_proposals: db.prepare(`SELECT id, status FROM plan_proposals WHERE agent = ?`).all(COVERAGE_AGENT),
    proposals: count(`SELECT COUNT(*) AS n FROM plan_proposals`),
    decisions: count(`SELECT COUNT(*) AS n FROM brain_decisions`),
    rollbacks: count(`SELECT COUNT(*) AS n FROM brain_rollbacks`),
  });
}

function assertHeld(code) {
  const before = snapshot();
  const preview = previewPlanCoverageChange();
  assert.equal(preview.status, "held", `preview: held under ${code}`);
  assert.equal(preview.hold, code);
  assert.equal(snapshot(), before, "a preview writes nothing");
  const out = closePlanCoverageGap({ act: true });
  assert.equal(out.status, "held");
  assert.equal(out.hold, code);
  assert.equal(out.proposal_id, null, "no proposal");
  assert.equal(out.decision_id, null, "no decision");
  assert.deepEqual(out.withdrawn, []);
  assert.equal(snapshot(), before, "no proposal, no brain decision, no plan change");
}

// Each listed table made unreadable in turn: the pass is `unavailable`, nothing changes.
function assertFailsClosed(tables) {
  const before = snapshot();
  for (const table of tables) {
    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_unreadable`);
    let out;
    let preview;
    try {
      out = closePlanCoverageGap({ act: true });
      preview = previewPlanCoverageChange();
    } finally {
      db.exec(`ALTER TABLE ${table}_unreadable RENAME TO ${table}`);
    }
    assert.equal(out.status, "unavailable", `${table} unreadable: acting pass`);
    assert.equal(preview.status, "unavailable", `${table} unreadable: preview`);
    assert.equal(snapshot(), before, `${table} unreadable: nothing written`);
  }
}

// ---- under-fuelling protection: the logged shortfall plus two rough sessions holds training ----
function seedFuelProtection() {
  db.prepare(
    `INSERT INTO nutrition_targets (effective_date, target_kcal, protein_g, carbs_g, fat_g, source) VALUES (?, 2200, 175, 240, 70, 'test')`
  ).run(day(-30));
  for (const delta of [-1, -2, -3, -4]) {
    for (const [meal, share] of [
      ["breakfast", 0.45],
      ["dinner", 0.55],
    ]) {
      db.prepare(`INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status) VALUES (?, ?, '', ?, NULL)`).run(
        day(delta),
        meal,
        JSON.stringify({ kcal: Math.round(1750 * share), protein_g: 60 })
      );
    }
  }
  for (const delta of [-1, -2]) {
    db.prepare(`INSERT INTO sessions (date, performance, soreness, finished_at) VALUES (?, 2, 4, datetime('now'))`).run(day(delta));
  }
}

test("fuel protection holds the pass: nothing proposed, decided or changed", () => {
  shortChestPlan();
  seedFuelProtection();
  assert.notEqual(currentUnderfuelingRead(today()).action.training, "proceed", "precondition: fuel is protecting training");
  assertHeld("fuel_protection");
});

test("an unreadable fuel read makes the pass unavailable, and nothing changes", () => {
  shortChestPlan();
  seedFuelProtection();
  assertFailsClosed(["nutrition_targets", "food_notes"]);
});

// ---- an affirmed cut ----
test("an affirmed cut holds the pass", () => {
  shortChestPlan();
  repo.setProfile({ goal_mode: "lose", weight_lb: 200, goal_weight_lb: 180 });
  assert.equal(cutReaffirmation().reaffirmed, true, "precondition: an affirmed cut");
  assertHeld("affirmed_cut");
});

// ---- cut pressure: a SLIDING cut (anchor lifts drifting down while the scale falls) ----
// Real rows: a weight downtrend with a complete diary behind it (a confident trend), three
// anchor lifts whose estimated 1RM falls across five sessions, a lose goal whose
// reaffirmation is OPEN (so the affirmed-cut hold, which comes first, stands aside).
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
      db.prepare(`INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status) VALUES (?, ?, '', ?, NULL)`).run(
        day(delta),
        meal,
        JSON.stringify({ kcal, protein_g: 60 })
      );
    }
  }
  for (const exercise of ["Pause Squat", "Pendlay Row", "Trap Bar Deadlift"]) {
    [26, 20, 14, 8, 2].forEach((daysAgo, i) => {
      for (let s = 0; s < 3; s++) repo.logSetByName({ exercise, weight: 200 - i * 12, reps: 8, date: day(-daysAgo) });
    });
  }
}

test("cut pressure (a sliding cut) holds the pass", () => {
  shortChestPlan();
  seedSlidingCut();
  assert.equal(cutReaffirmation().reaffirmed, false, "precondition: no affirmed cut");
  const cut = readCutPressureStrict(today());
  assert.equal(currentUnderfuelingRead(today()).action.training, "proceed", "precondition: the fuel read is not what holds");
  assert.equal(cut.sliding, true, `precondition: the cut is sliding ${JSON.stringify(cut)}`);
  assert.equal(cutPressureRefusesSetIncrease(cut) || cut.sliding, true);
  assertHeld("cut_pressure");
});

test("an unreadable cut read makes the pass unavailable, and nothing changes", () => {
  shortChestPlan();
  seedSlidingCut();
  assertFailsClosed(["nutrition_targets", "bodyweight_log"]);
});

// ---- a volume restore still owed ----
test("a volume restore still owed holds the pass, and an unreadable ledger makes it unavailable", () => {
  shortChestPlan();
  db.prepare(
    `INSERT INTO brain_decisions (kind, domain, summary, source, status, autonomy_tier, risk_class, action_json)
     VALUES ('training_target', 'training', 'Fuel protection', 'auto-progression', 'applied', 'quiet_apply', 'low', ?)`
  ).run(
    JSON.stringify({
      volume_restore: [
        { day_number: 1, exercise: "Incline Dumbbell Press", applied_sets: 3, restore_to: 5, prior_sets: 5, cause: "fuel" },
      ],
    })
  );
  assertHeld("volume_restore");
  assertFailsClosed(["brain_decisions"]);
});

// ---- an active plan adaptation ----
test("an active plan adaptation holds the pass, and an unreadable ledger makes it unavailable", () => {
  shortChestPlan();
  // A scoped change an agent landed: the hamstring curl is eased until a date ahead.
  const proposal = repo.createProposal("stub", "background: chat signal", "", {
    summary: "Ease the leg curl for the next ten days",
    rationale: "A lighter week for the hamstrings.",
    changes: [{ day_number: 2, exercise: "Lying Leg Curl", target_weight: 40, until: day(10), reason: "Lighter hamstrings for ten days" }],
  });
  const applied = repo.applyProposal(Number(proposal.id));
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM plan_adaptations WHERE status = 'active'`).get().n, 1, "precondition");
  assertHeld("plan_adaptation");
  assertFailsClosed(["plan_adaptations"]);
});
