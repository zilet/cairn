// The weekly dose: the week's working sets per muscle group, counted off the log (the
// ONE honest counter, effectiveVolumeByGroup) against the contextual floor, plus what
// today and the rest of the week still plan. A genuine shortfall lands on today's card as
// at most one extra set per item and two per day — accessories before anchors, never on
// an untested slot, never on a recovering/reduced/excluded group, never in a light week
// or for an endurance-carried group, never moving a load, never on a run day, never
// breaking the duration cap, and never before a reach has taken its budget.
// Synthetic fixtures only. Deterministic and offline (see test/run.mjs). Dates are
// relative to the real clock (last week's Monday–Wednesday), because the progression
// engine reads its recent windows off today.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { applyWeeklyDose, DOSE_FILL_NOTES, doseFillNote } from "../dist/repo/composition-dose.js";
import { CARD_NOTE_BUDGET } from "../dist/repo/composition-pairing.js";
import {
  deterministicComposedSession,
  normalizeComposedSession,
  reconcileEnvelopeDose,
} from "../dist/repo/daily-composition.js";
import { buildDailySessionDecision, gatherDailyDecisionSnapshot } from "../dist/repo/daily-decision.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { buildProgressionProposal, planDayProgression } from "../dist/repo/progression.js";
import { scheduleRecoveryCycle } from "../dist/repo/recovery-cycles.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { readVolumeFloorContext } from "../dist/repo/volume-floor-context.js";
import {
  WEEKLY_DOSE_MAX_FILLS_PER_DAY,
  WEEKLY_DOSE_RATIONALE,
  weeklyDoseDecision,
  weeklyDoseLedger,
} from "../dist/repo/weekly-dose-ledger.js";
import { mondayOf } from "../dist/lib/dates.js";
import { db, repo, resetTables, settlePlanPrescriptions } from "./_seed.js";

// Last week, so every date is in the past whatever weekday the suite runs on.
const MON = addDaysISO(mondayOf(localDateISO()), -7);
const TUE = addDaysISO(MON, 1);
const WED = addDaysISO(MON, 2);
const NOW = `${WED}T09:00:00.000Z`;

beforeEach(() => {
  resetTables(
    "daily_session_decisions",
    "daily_session_compositions",
    "daily_session_outcomes",
    "logged_sets",
    "session_skips",
    "sessions",
    "day_reads",
    "activities",
    "recovery_cycles",
    "program_blocks",
    "plan_proposals",
    "brain_decisions",
    "plan_items",
    "plan_days",
    "exercises",
    "profile"
  );
});

const EXERCISES = [
  ["Barbell Bench Press", "chest"],
  ["Incline Dumbbell Press", "chest"],
  ["Overhead Press", "shoulders"],
  ["Pendlay Row", "back"],
  ["Lat Pulldown", "back"],
  ["Ankle Rocker", "mobility"],
  ["Back Squat", "quads"],
  ["Romanian Deadlift", "hamstrings"],
  ["Leg Extension", "quads"],
  ["Lying Leg Curl", "hamstrings"],
  ["Chest-Supported Row", "back"],
  ["Dumbbell Shoulder Press", "shoulders"],
  ["Bulgarian Split Squat", "quads"],
  ["Hip Thrust", "glutes"],
];

const item = (exercise, sets, rep_low, rep_high, target_weight) => ({
  exercise,
  sets,
  rep_low,
  rep_high,
  target_weight,
});

// Mon–Fri lifting over five strength days. Every major group clears its floor across the
// week except quads: squat 3 + leg extension 2 on Wednesday, split squat 2 on Friday —
// seven planned against a floor of eight (the live plan-quality warning's shape).
function lowerWeekPlan({ legExtensionSets = 2 } = {}) {
  return [
    {
      day_number: 1,
      name: "Push",
      items: [
        item("Barbell Bench Press", 5, 5, 7, 135),
        item("Incline Dumbbell Press", 5, 8, 10, 50),
        item("Overhead Press", 4, 6, 8, 95),
      ],
    },
    { day_number: 2, name: "Pull", items: [item("Pendlay Row", 5, 6, 8, 150), item("Lat Pulldown", 5, 8, 10, 140)] },
    {
      day_number: 3,
      name: "Lower A",
      items: [
        { exercise: "Ankle Rocker", sets: 2, rep_low: 10, rep_high: 10 },
        item("Back Squat", 3, 5, 7, 185),
        item("Romanian Deadlift", 4, 8, 10, 205),
        item("Leg Extension", legExtensionSets, 10, 12, 135),
        item("Lying Leg Curl", 3, 10, 12, 120),
      ],
    },
    {
      day_number: 4,
      name: "Upper",
      items: [item("Chest-Supported Row", 3, 8, 10, 85), item("Dumbbell Shoulder Press", 3, 8, 10, 50)],
    },
    {
      day_number: 5,
      name: "Lower B",
      items: [item("Bulgarian Split Squat", 2, 8, 10, 60), item("Hip Thrust", 3, 8, 10, 225)],
    },
  ];
}

function log(date, exercise, weight, reps, n, day_number) {
  for (let i = 0; i < n; i++) repo.logSetByName({ date, exercise, weight, reps, day_number });
}

// Two earlier weeks trained as written (so every slot is TESTED and holds its load on a
// rep step), then this week's Monday Push and Tuesday Pull. `lowerSets` overrides what
// was actually logged on a lift in the earlier Lower A sessions.
function seedWeek({ intent = ["strength", "longevity"], lowerSets = {} } = {}) {
  for (const [name, muscle_group] of EXERCISES) repo.upsertExercise({ name, muscle_group, mode: "reps" });
  repo.replacePlan(lowerWeekPlan());
  settlePlanPrescriptions();
  repo.setProfile({
    strength_schedule: { days: [1, 2, 3, 4, 5].map((dow) => ({ dow })), source: "athlete" },
    training_intent: { priorities: intent, endurance_role: "none" },
  });
  const plan = repo.getPlan();
  for (const back of [14, 7]) {
    for (const day of plan) {
      const date = addDaysISO(MON, day.day_number - 1 - back);
      for (const it of day.items) {
        const sets = day.day_number === 3 && lowerSets[it.exercise] != null ? lowerSets[it.exercise] : it.sets;
        log(date, it.exercise, it.target_weight ?? null, it.rep_low + 1, sets, day.day_number);
      }
    }
  }
  for (const it of plan[0].items) log(MON, it.exercise, it.target_weight, it.rep_low + 1, it.sets, 1);
  for (const it of plan[1].items) log(TUE, it.exercise, it.target_weight, it.rep_low + 1, it.sets, 2);
}

function decideWednesday(mutate = (s) => s) {
  const snapshot = mutate(gatherDailyDecisionSnapshot(WED));
  return { snapshot, envelope: buildDailySessionDecision(snapshot, { now: NOW }) };
}

const byName = (session, name) => session.items.find((i) => i.exercise === name);
const clone = (v) => JSON.parse(JSON.stringify(v));
function withoutDose(envelope) {
  const copy = clone(envelope);
  delete copy.dose;
  return copy;
}

// ---------- (a) the live week: a quads gap fills on the accessory ----------

test("(a) a week short on quads fills one set on Leg Extension; the squat is untouched", () => {
  seedWeek();
  const ledger = weeklyDoseLedger(WED);
  assert.equal(ledger.applies, true);
  const quads = ledger.groups.find((g) => g.group === "quads");
  assert.deepEqual(
    { done: quads.done, today: quads.today_planned, later: quads.later_planned, short: quads.short },
    { done: 0, today: 5, later: 2, short: 1 },
    "Mon–Tue logged no quads; Lower A plans five, Lower B two — one short of eight"
  );
  const chest = ledger.groups.find((g) => g.group === "chest");
  assert.equal(chest.done, 10, "Monday's logged pressing counts toward the week");
  assert.equal(chest.short, 0);

  const { snapshot, envelope } = decideWednesday();
  assert.equal(snapshot.plan.day_number, 3);
  assert.deepEqual(snapshot.weekly_dose.gaps, [{ group: "quads", short: 1 }]);
  assert.equal(snapshot.weekly_dose.eligible[0].exercise, "Leg Extension", "the accessory is first in line");
  assert.deepEqual(envelope.dose.fills, [{ exercise: "Leg Extension", group: "quads", add_sets: 1, sets: 2 }]);
  assert.ok(envelope.precedence.includes("weekly_dose_fill"));
  assert.ok(envelope.rationale.some((r) => r.code === "weekly_dose_fill" && WEEKLY_DOSE_RATIONALE.includes(r.text)));
  assert.notEqual(envelope.rationale[0].code, "weekly_dose_fill", "the day's own read keeps the headline");

  const session = deterministicComposedSession(envelope);
  const legExt = byName(session, "Leg Extension");
  assert.equal(legExt.sets, 3, "two planned sets become three");
  assert.equal(legExt.target_weight, 135);
  // The fill's line leads the note; the pairing hint (the curl is its antagonist) follows.
  assert.ok(legExt.note.startsWith(doseFillNote("quads", WED, "Leg Extension")), legExt.note);
  assert.equal(legExt.superset_group, byName(session, "Lying Leg Curl").superset_group);
  assert.equal(legExt.brain_change_reason ?? null, null, "the fill speaks in the note, not the brain reason");
  const squat = byName(session, "Back Squat");
  assert.equal(squat.sets, 3);
  assert.equal(squat.target_weight, 185);
  assert.equal(squat.note ?? null, null);
});

// ---------- (b) an untested slot never takes the set ----------

test("(b) an untested slot never takes a set, and the heavy anchor is never the fallback", () => {
  seedWeek();
  // Leg Extension re-prescribed after it was last trained: untested until run at it.
  db.prepare(
    `UPDATE plan_items SET prescribed_at = ? WHERE exercise_id = (SELECT id FROM exercises WHERE name = 'Leg Extension')`
  ).run(TUE);
  const legExtRx = planDayProgression(3).find((p) => p.exercise === "Leg Extension");
  assert.equal(legExtRx.untested, true);
  // The only other quads work today is the Back Squat: the day's anchor, strength-range
  // reps (5–7). It never takes the week's extra set, so nothing fills at all.
  const { snapshot, envelope } = decideWednesday();
  assert.equal("weekly_dose" in snapshot, false, "no eligible quads item: the slice stays off");
  assert.equal("dose" in envelope, false);
  const card = deterministicComposedSession(envelope);
  assert.equal(byName(card, "Leg Extension").sets, 2);
  assert.equal(byName(card, "Back Squat").sets, 3, "the anchor keeps its prescription");

  // Every quads slot untested: nothing to fill at all, and the snapshot stays idle.
  db.prepare(`UPDATE plan_items SET prescribed_at = ?`).run(TUE);
  const idle = decideWednesday();
  assert.equal("weekly_dose" in idle.snapshot, false);
  assert.equal("dose" in idle.envelope, false);
});

// ---------- (c) light weeks and endurance-carried groups ----------

test("(c) a recovery week, the race taper and an endurance-carried group take no fill", () => {
  seedWeek();
  const floor = readVolumeFloorContext(WED);
  assert.equal(floor.exempt, null);
  for (const exempt of ["recovery_week", "race_taper", "deload_phase", "deload_due"]) {
    const ledger = weeklyDoseLedger(WED, { floor: { ...floor, exempt } });
    assert.equal(ledger.applies, false, exempt);
    assert.deepEqual(ledger.groups, [], exempt);
  }
  const carried = weeklyDoseLedger(WED, { floor: { ...floor, endurance_carried: ["quads"] } });
  assert.equal(carried.applies, true);
  assert.equal(
    carried.groups.some((g) => g.group === "quads"),
    false,
    "a carried group is not measured"
  );

  // Live: a recovery week scheduled into this week stands the whole dose down.
  scheduleRecoveryCycle({ effective_on: addDaysISO(WED, 3), reason: "a planned light week" });
  assert.equal(weeklyDoseLedger(WED).exempt, "recovery_week");
  const { snapshot, envelope } = decideWednesday();
  assert.equal("weekly_dose" in snapshot, false);
  assert.equal("dose" in envelope, false);
  assert.equal(byName(deterministicComposedSession(envelope), "Leg Extension").sets, 2);
});

// ---------- (d) recovering / reduced groups ----------

test("(d) a saturated or reduced group takes no fill, at decision and at composition", () => {
  seedWeek();
  const saturated = decideWednesday((s) => ({
    ...s,
    muscle_load: [...s.muscle_load, { group: "quads", days_ago: 1, saturated: true, source: "strength" }],
  }));
  assert.ok(saturated.envelope.muscles.saturated.includes("quads"));
  assert.equal("dose" in saturated.envelope, false);

  const reduced = decideWednesday((s) => ({ ...s, program: { ...s.program, volume_high_groups: ["quads"] } }));
  assert.ok(reduced.envelope.muscles.reduced.includes("quads"));
  assert.equal("dose" in reduced.envelope, false);

  // Composition re-checks on its own: an envelope that still carries a fill for a
  // group the card reads saturated, or an item in a reduced area, lands nothing.
  const { envelope } = decideWednesday();
  const items = [{ exercise: "Leg Extension", sets: 2, rep_low: 10, rep_high: 12, target_weight: 135, mode: "reps" }];
  const base = {
    envelope,
    date: WED,
    budget: { remainingSets: 10, itemSetCap: 6, cap: 12, minutesCap: 60, estMinutes: 30 },
    reducedExercises: new Set(),
    saturatedGroups: new Set(),
    excludedGroups: new Set(),
    candidates: new Map(),
  };
  assert.equal(applyWeeklyDose(items, base).changed, true, "the control lands");
  assert.equal(applyWeeklyDose(items, { ...base, saturatedGroups: new Set(["quads"]) }).changed, false);
  assert.equal(applyWeeklyDose(items, { ...base, excludedGroups: new Set(["quads"]) }).changed, false);
  assert.equal(applyWeeklyDose(items, { ...base, reducedExercises: new Set(["leg extension"]) }).changed, false);
});

// ---------- (e) loads byte-identical ----------

test("(e) the fill never moves a load: every other field is byte-identical", () => {
  seedWeek();
  const { envelope } = decideWednesday();
  const plain = deterministicComposedSession(withoutDose(envelope));
  const dosed = deterministicComposedSession(clone(envelope));
  assert.equal(plain.items.length, dosed.items.length);
  for (const [i, before] of plain.items.entries()) {
    const after = dosed.items[i];
    assert.equal(after.exercise, before.exercise, "no reorder, nothing added or dropped");
    for (const key of ["target_weight", "target_seconds", "rep_low", "rep_high", "warmup_sets", "mode", "position"]) {
      assert.equal(JSON.stringify(after[key]), JSON.stringify(before[key]), `${after.exercise} ${key}`);
    }
    if (after.exercise === "Leg Extension") {
      assert.equal(after.sets, before.sets + 1);
    } else {
      assert.equal(JSON.stringify(after), JSON.stringify(before), `${after.exercise} is untouched`);
    }
  }
});

// ---------- (f) reach keeps its budget first ----------

test("(f) a reach keeps its budget first: a tight day lands the reach and skips the fill", () => {
  seedWeek();
  const { envelope } = decideWednesday();
  const reachEnvelope = () => ({
    ...clone(envelope),
    reach: { level: "push", backed_by: ["fresh_readiness"], why: "Backed for a heavier look." },
  });
  // 23 working sets against the day's 24: the reach's single takes the last one.
  const tight = {
    name: "Lower A",
    focus: "Lower A",
    why: "x",
    est_minutes: 50,
    items: [
      { exercise: "Back Squat", sets: 6, rep_low: 5, rep_high: 7, target_weight: 185 },
      { exercise: "Romanian Deadlift", sets: 6, rep_low: 8, rep_high: 10, target_weight: 205 },
      { exercise: "Leg Extension", sets: 2, rep_low: 10, rep_high: 12, target_weight: 135 },
      { exercise: "Lying Leg Curl", sets: 6, rep_low: 10, rep_high: 12, target_weight: 120 },
      { exercise: "Hip Thrust", sets: 3, rep_low: 8, rep_high: 10, target_weight: 225 },
    ],
  };
  const tightResult = normalizeComposedSession(clone(tight), reachEnvelope());
  assert.equal(tightResult.validation.reach_landed, true, "the reach lands");
  assert.ok(
    tightResult.session.items.some((i) => i.reach),
    "the heavier look is on the card"
  );
  assert.equal(byName(tightResult.session, "Leg Extension").sets, 2, "no budget left for the fill");

  // With room, both land: the reach first, the fill after it.
  const roomy = clone(tight);
  roomy.items[0].sets = 3;
  const roomyResult = normalizeComposedSession(roomy, reachEnvelope());
  assert.equal(roomyResult.validation.reach_landed, true);
  assert.equal(byName(roomyResult.session, "Leg Extension").sets, 3);
});

// ---------- (g) the athlete's own plan snapshot ----------

test("(g) a plan snapshot of the day takes no fill", () => {
  seedWeek();
  const { envelope } = decideWednesday();
  assert.ok(envelope.dose);
  const snapshot = deterministicComposedSession(clone(envelope), { planSnapshot: true });
  assert.equal(byName(snapshot, "Leg Extension").sets, 2);
  assert.ok(!snapshot.items.some((i) => String(i.note ?? "").includes("extra set")));
});

// ---------- (h) the log carries the fill into the plan ----------

test("(h) two logged fills raise the plan a set, and the plan's quads warning clears", () => {
  repo.setProfile({ training_intent: { priorities: ["strength", "longevity"], endurance_role: "none" } });
  // The two earlier Lower A sessions each carried the fill: three good sets on a
  // two-set slot.
  seedWeek({ lowerSets: { "Leg Extension": 3 } });
  const before = repo.getPlanQuality();
  assert.ok(
    before.warnings.some((w) => w.code === "muscle_density_low" && w.muscle_group === "quads"),
    "quads plan under their floor"
  );

  const legExt = planDayProgression(3, { forNextSession: true }).find((p) => p.exercise === "Leg Extension");
  assert.deepEqual(legExt.set_step, { from: 2, to: 3 }, "setCatchUp reads the logged fills");
  const built = buildProgressionProposal(3, { forNextSession: true });
  assert.equal(built.ok, true);
  assert.equal(built.proposal.parsed.changes.find((c) => c.exercise === "Leg Extension").sets, 3);
  assert.equal(repo.applyProposal(built.proposal.id).ok, true);
  assert.equal(repo.getPlanDay(3).items.find((i) => i.exercise === "Leg Extension").sets, 3);

  const after = repo.getPlanQuality();
  assert.ok(
    !after.warnings.some((w) => w.code === "muscle_density_low" && w.muscle_group === "quads"),
    "the plan now carries the week's quads"
  );
  // And the week's ledger has nothing left to fill: the fill retires itself.
  assert.equal(weeklyDoseLedger(WED).groups.find((g) => g.group === "quads").short, 0);
});

// ---------- (i) the athlete-facing lines hold the reading grammar ----------

test("(i) the note and rationale variants are calm, number-free and grammar-clean", () => {
  assert.ok(DOSE_FILL_NOTES.length >= 4);
  assert.ok(WEEKLY_DOSE_RATIONALE.length >= 4);
  assert.equal(new Set(WEEKLY_DOSE_RATIONALE).size, WEEKLY_DOSE_RATIONALE.length);
  const groups = ["chest", "back", "shoulders", "quads", "hamstrings", "glutes", "biceps", "triceps", "calves"];
  for (const group of groups) {
    const lines = DOSE_FILL_NOTES.map((render) => render(group));
    assert.equal(new Set(lines).size, lines.length, group);
    for (const line of lines) {
      assert.equal(violatesReadingGrammar(line), null, line);
      assert.doesNotMatch(line, /\d/, line);
      assert.doesNotMatch(line, /\b(?:must|should|behind schedule|failed|missed)\b/i, line);
    }
  }
  assert.match(DOSE_FILL_NOTES[0]("back"), /your back is/);
  assert.match(DOSE_FILL_NOTES[0]("quads"), /your quads are/);
  for (const line of WEEKLY_DOSE_RATIONALE) {
    assert.equal(violatesReadingGrammar(line), null, line);
    assert.doesNotMatch(line, /\d/, line);
  }
});

// ---------- (j) one wording per lift per day, and one fill per card ----------

test("(j) the same date prints the same note, and a card normalized twice takes one set", () => {
  seedWeek();
  const { envelope } = decideWednesday();
  const first = deterministicComposedSession(clone(envelope));
  const second = deterministicComposedSession(clone(envelope));
  assert.equal(byName(first, "Leg Extension").note, byName(second, "Leg Extension").note);
  assert.equal(doseFillNote("quads", WED, "Leg Extension"), doseFillNote("quads", WED, "leg extension"));
  const days = new Set(Array.from({ length: 8 }, (_, i) => doseFillNote("quads", addDaysISO(WED, i), "Leg Extension")));
  assert.ok(days.size > 1, "the wording rotates across days");

  // An agent's composed session accepted later is re-normalized against the same
  // envelope: the fill already landed, so it never lands twice.
  const again = normalizeComposedSession(
    { name: first.name, focus: first.focus, why: first.why, est_minutes: first.est_minutes, items: first.items },
    clone(envelope)
  );
  assert.equal(byName(again.session, "Leg Extension").sets, 3);
  assert.equal(byName(again.session, "Leg Extension").note, byName(first, "Leg Extension").note);
});

// ---------- the pure rule: caps, day kinds, the per-day limit ----------

function pureCtx(overrides = {}) {
  const candidate = (exercise) => ({
    exercise,
    muscle_group: null,
    action: "hold",
    reason_code: "progression_hold",
    substitution_for: null,
    note: null,
    authorized_target: { mode: "reps", sets: 2, rep_low: 10, rep_high: 12, target_weight: 50, target_seconds: null },
    current_target: { mode: "reps", sets: 2, rep_low: 10, rep_high: 12, target_weight: 50, target_seconds: null },
  });
  return {
    date: WED,
    kind: "train",
    dayType: "training",
    runDay: false,
    trainAnyway: false,
    caps: { volume: "normal", intensity: "normal", duration_min: 60 },
    muscles: { required: [], allowed: [], reduced: [], excluded: [], saturated: [], deep: [] },
    candidates: ["Leg Extension", "Sissy Squat", "Lying Leg Curl", "Cable Fly"].map(candidate),
    recoveryWeek: false,
    mesocyclePhase: "accumulation",
    snapshot: { muscle_load: [], day_read: { recovery_week: false }, recovery_cycle: null },
    ...overrides,
  };
}

const PURE_SNAPSHOT = {
  gaps: [
    { group: "quads", short: 3 },
    { group: "hamstrings", short: 2 },
    { group: "chest", short: 0.3 },
  ],
  eligible: [
    { exercise: "Leg Extension", group: "quads", sets: 2 },
    { exercise: "Sissy Squat", group: "quads", sets: 2 },
    { exercise: "Lying Leg Curl", group: "hamstrings", sets: 2 },
    { exercise: "Cable Fly", group: "chest", sets: 2 },
  ],
};

test("the rule: at most one set per item and two per day, only toward a real gap", () => {
  const decision = weeklyDoseDecision(PURE_SNAPSHOT, pureCtx());
  assert.equal(decision.dose.fills.length, WEEKLY_DOSE_MAX_FILLS_PER_DAY);
  assert.deepEqual(
    decision.dose.fills.map((f) => f.exercise),
    ["Leg Extension", "Sissy Squat"],
    "fill order is the snapshot's ranking"
  );
  assert.ok(decision.dose.fills.every((f) => f.add_sets === 1));
  assert.equal(violatesReadingGrammar(decision.rationale), null);

  // A gap of one fills once, whatever else the group has eligible.
  const one = weeklyDoseDecision({ ...PURE_SNAPSHOT, gaps: [{ group: "quads", short: 1 }] }, pureCtx());
  assert.deepEqual(
    one.dose.fills.map((f) => f.exercise),
    ["Leg Extension"]
  );
  // Noise under half a set is not a gap.
  const noise = weeklyDoseDecision(
    { gaps: [{ group: "chest", short: 0.3 }], eligible: PURE_SNAPSHOT.eligible },
    pureCtx()
  );
  assert.equal(noise.dose, null);
});

test("the rule stands down on every day that is not an ordinary full training day", () => {
  const none = (ctx) => weeklyDoseDecision(PURE_SNAPSHOT, pureCtx(ctx)).dose;
  assert.equal(none({ kind: "easy" }), null, "an easy read");
  assert.equal(none({ kind: "rest" }), null, "a rest read");
  assert.equal(none({ dayType: "run", runDay: true }), null, "a stated run day");
  assert.equal(none({ trainAnyway: true }), null, "train-anyway");
  assert.equal(none({ caps: { volume: "reduced", intensity: "normal", duration_min: 60 } }), null, "trimmed volume");
  assert.equal(none({ caps: { volume: "normal", intensity: "hold", duration_min: 60 } }), null, "held intensity");
  assert.equal(none({ recoveryWeek: true }), null, "a recovery week");
  assert.equal(none({ mesocyclePhase: "deload-due" }), null, "a deload earned");
  assert.equal(weeklyDoseDecision(undefined, pureCtx()).dose, null, "no snapshot slice");
  // A protective hold, a deload, a load step, or a set count already moving never fills.
  const guarded = pureCtx();
  guarded.candidates[0] = { ...guarded.candidates[0], reason_code: "recent_underperformance" };
  guarded.candidates[1] = { ...guarded.candidates[1], action: "deload", reason_code: "progression_deload" };
  guarded.candidates[2] = {
    ...guarded.candidates[2],
    action: "overload",
    reason_code: "progression_overload",
    authorized_target: { ...guarded.candidates[2].authorized_target, target_weight: 55 },
  };
  assert.equal(weeklyDoseDecision(PURE_SNAPSHOT, guarded).dose, null);
  const setStep = pureCtx();
  setStep.candidates[0] = {
    ...setStep.candidates[0],
    authorized_target: { ...setStep.candidates[0].authorized_target, sets: 3 },
  };
  assert.ok(!weeklyDoseDecision(PURE_SNAPSHOT, setStep).dose.fills.some((f) => f.exercise === "Leg Extension"));
});

test("composition never breaks the day's clock or the per-item cap", () => {
  const envelope = {
    date: WED,
    dose: {
      gaps: [{ group: "quads", short: 2 }],
      fills: [
        { exercise: "Leg Extension", group: "quads", add_sets: 1, sets: 2 },
        { exercise: "Sissy Squat", group: "quads", add_sets: 1, sets: 6 },
      ],
    },
  };
  const items = [
    { exercise: "Leg Extension", sets: 2, rep_low: 10, rep_high: 12, target_weight: 135, mode: "reps" },
    { exercise: "Sissy Squat", sets: 6, rep_low: 10, rep_high: 12, target_weight: null, mode: "reps" },
  ];
  const ctx = (budget) => ({
    envelope,
    date: WED,
    budget: { remainingSets: 10, itemSetCap: 6, cap: 12, minutesCap: 60, estMinutes: 20, ...budget },
    reducedExercises: new Set(),
    saturatedGroups: new Set(),
    excludedGroups: new Set(),
    candidates: new Map(),
  });
  const open = applyWeeklyDose(items, ctx({}));
  assert.equal(open.items[0].sets, 3);
  assert.equal(open.items[1].sets, 6, "already at the per-item cap");
  assert.equal(open.estAddMin > 0, true);
  assert.equal(items[0].sets, 2, "the caller's items are not mutated");
  // Eight sets on the card price at twenty minutes; a twenty-minute cap has no room.
  assert.equal(applyWeeklyDose(items, ctx({ minutesCap: 20 })).changed, false);
  assert.equal(applyWeeklyDose(items, ctx({ remainingSets: 0 })).changed, false);
  assert.equal(applyWeeklyDose(items, ctx({ minutesCap: null })).items[0].sets, 3, "no clock, no clock limit");
});

test("a fill whose line would push the card's note past what Today shows keeps the set and drops the line", () => {
  const envelope = {
    date: WED,
    dose: { gaps: [{ group: "quads", short: 2 }], fills: [{ exercise: "Leg Extension", group: "quads", add_sets: 1, sets: 2 }] },
  };
  // The athlete's own cue: short enough to print on the card on its own.
  const cue =
    "Pause for a full second at the top of every rep and keep the pad just above the ankle, never on the shin; slow the lowering to three seconds and stop if the knee pinches at all.";
  assert.ok(cue.length <= CARD_NOTE_BUDGET && cue.length > CARD_NOTE_BUDGET - 60, String(cue.length));
  const items = [{ exercise: "Leg Extension", sets: 2, rep_low: 10, rep_high: 12, target_weight: 135, mode: "reps", note: cue }];
  const ctx = {
    envelope,
    date: WED,
    budget: { remainingSets: 10, itemSetCap: 6, cap: 12, minutesCap: 60, estMinutes: 20 },
    reducedExercises: new Set(),
    saturatedGroups: new Set(),
    excludedGroups: new Set(),
    candidates: new Map(),
  };
  const out = applyWeeklyDose(items, ctx);
  assert.equal(out.items[0].sets, 3, "the set still lands");
  assert.equal(out.items[0].note, cue, "the athlete's cue is untouched and still fits the card");
  assert.ok(out.items[0].note.length <= CARD_NOTE_BUDGET);
  // A short cue has room: the line leads it.
  const short = applyWeeklyDose([{ ...items[0], note: "Slow lowering." }], ctx).items[0].note;
  assert.ok(short.startsWith(doseFillNote("quads", WED, "Leg Extension").replace(/[.]+$/, "")), short);
  assert.ok(short.endsWith("Slow lowering."), short);
});

// ---------- the persisted envelope says only what the card carries ----------

const doseTrail = (envelope) => ({
  dose: "dose" in envelope,
  precedence: envelope.precedence.includes("weekly_dose_fill"),
  soft: envelope.soft_preferences.some((s) => s.code === "weekly_dose_fill"),
  rationale: envelope.rationale.some((r) => r.code === "weekly_dose_fill"),
});
const NO_TRAIL = { dose: false, precedence: false, soft: false, rationale: false };

test("a plan snapshot lands no fill, so the persisted envelope carries no dose and no dose line", () => {
  seedWeek();
  const { envelope } = decideWednesday();
  assert.equal(doseTrail(envelope).dose, true);
  deterministicComposedSession(envelope, { planSnapshot: true });
  assert.deepEqual(doseTrail(envelope), NO_TRAIL);
});

test("a card whose set count no longer matches the plan lands no fill, and the envelope drops the dose", () => {
  seedWeek();
  const { envelope } = decideWednesday();
  const fromEnvelope = deterministicComposedSession(clone(envelope));
  // An agent's card that wrote the leg extension down a set: the fill is not the
  // server's to re-add, so nothing lands.
  const agentCard = clone(fromEnvelope);
  const legExt = byName(agentCard, "Leg Extension");
  legExt.sets = 1;
  legExt.note = null;
  const out = normalizeComposedSession(agentCard, envelope);
  assert.equal(byName(out.session, "Leg Extension").sets, 1);
  assert.deepEqual(doseTrail(envelope), NO_TRAIL);
});

test("a fill that does land keeps the dose; a card normalized twice keeps it too", () => {
  seedWeek();
  const { envelope } = decideWednesday();
  const first = deterministicComposedSession(envelope);
  assert.equal(byName(first, "Leg Extension").sets, 3);
  assert.deepEqual(doseTrail(envelope), { dose: true, precedence: true, soft: true, rationale: true });
  // The composed card comes back through composition (an accepted card): the set is
  // already there, so the fill's work stands on the card and the dose stays.
  const again = normalizeComposedSession(clone(first), envelope);
  assert.equal(byName(again.session, "Leg Extension").sets, 3);
  assert.equal(doseTrail(envelope).dose, true);
  assert.deepEqual(envelope.dose.fills.map((f) => f.exercise), ["Leg Extension"]);
});

test("when only some fills land, the envelope's fills and soft line name only those", () => {
  const envelope = {
    date: WED,
    kind: "train",
    precedence: ["template", "weekly_dose_fill"],
    soft_preferences: [
      {
        code: "weekly_dose_fill",
        detail: "The week would end short on quads and hamstrings; one extra working set on Leg Extension and Lying Leg Curl, load unchanged.",
      },
    ],
    rationale: [{ code: "weekly_dose_fill", text: "The week has come up a little short, so today adds a set where it fits." }],
    dose: {
      gaps: [
        { group: "quads", short: 1 },
        { group: "hamstrings", short: 1 },
      ],
      fills: [
        { exercise: "Leg Extension", group: "quads", add_sets: 1, sets: 2 },
        { exercise: "Lying Leg Curl", group: "hamstrings", add_sets: 1, sets: 3 },
      ],
    },
  };
  // The curl's card carries a set count the plan never wrote: only the extension lands.
  reconcileEnvelopeDose(envelope, new Set(["leg extension"]));
  assert.deepEqual(envelope.dose.fills.map((f) => f.exercise), ["Leg Extension"]);
  const soft = envelope.soft_preferences.find((s) => s.code === "weekly_dose_fill").detail;
  assert.ok(/Leg Extension/.test(soft) && !/Leg Curl/.test(soft) && !/hamstrings/.test(soft), soft);
  assert.ok(envelope.precedence.includes("weekly_dose_fill"));
  reconcileEnvelopeDose(envelope, new Set());
  assert.deepEqual(doseTrail(envelope), NO_TRAIL);
});
