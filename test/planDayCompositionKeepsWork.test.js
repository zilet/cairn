// A train-anyway card composed from the athlete's OWN plan day never silently loses
// authored work (incident 2026-11-12): a reduced day's twelve-set budget, spent in plan
// order, deleted the last four lifts of a nine-lift day without a word, the title was the
// plan day's stale free-text focus, and a 70 s plank the athlete had just asked for came
// back as last week's 68. Synthetic fixtures only; deterministic and offline.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { applyProposalWithAutonomy } from "../dist/domain/brain/autonomy-service.js";
import {
  DAY_BUDGET_TRIM_NOTES,
  deterministicComposedSession,
  normalizeComposedSession,
} from "../dist/repo/daily-composition.js";
import { buildDailySessionDecision, gatherDailyDecisionSnapshot } from "../dist/repo/daily-decision.js";
import { activePlanAdaptations, sameDayAthleteRequest } from "../dist/repo/plan-adaptations.js";
import { datedPlanDayFocus, focusWithoutAbsentMovements } from "../dist/repo/plan-day-focus.js";
import { localDateISO } from "../dist/repo/shared.js";
import { repo, resetTables, savePlanDaySettled } from "./_seed.js";

const DATE = "2031-07-01";
const DAY = 4;
const DAY_NAME = "Upper B — the week's one press day";
const STALE_FOCUS =
  "Seated dumbbell press, flat dumbbell bench, upright row, carry and plank. The threshold run is the next day.";

const EXERCISES = [
  ["Landmine Press", "shoulders", "reps"],
  ["Dumbbell Bench Press", "chest", "reps"],
  ["Upright Row", "shoulders", "reps"],
  ["Front Plank", "core", "timed"],
  ["Wide-Grip Pulldown", "back", "reps"],
  ["Chest-Supported Row", "back", "reps"],
  ["Face Pull", "rear delts", "reps"],
  ["Dumbbell Biceps Curl", "biceps", "reps"],
  ["Triceps Rope Pushdown", "triceps", "reps"],
];

// Plan-position order, as the athlete asked for it.
const ITEMS = [
  { exercise: "Landmine Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 45 },
  { exercise: "Dumbbell Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 50 },
  { exercise: "Upright Row", sets: 2, rep_low: 10, rep_high: 12, target_weight: 40 },
  { exercise: "Front Plank", sets: 2, mode: "timed", target_seconds: 70 },
  { exercise: "Wide-Grip Pulldown", sets: 3, rep_low: 8, rep_high: 10, target_weight: 120 },
  { exercise: "Chest-Supported Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 45 },
  { exercise: "Face Pull", sets: 2, rep_low: 12, rep_high: 15, target_weight: 30 },
  { exercise: "Dumbbell Biceps Curl", sets: 2, rep_low: 10, rep_high: 12, target_weight: 25 },
  { exercise: "Triceps Rope Pushdown", sets: 2, rep_low: 10, rep_high: 12, target_weight: 40 },
];
const AUTHORED_SETS = ITEMS.reduce((sum, item) => sum + item.sets, 0);

beforeEach(() => {
  resetTables(
    "brain_decisions",
    "plan_adaptations",
    "plan_proposals",
    "daily_session_decisions",
    "daily_session_compositions",
    "logged_sets",
    "session_skips",
    "sessions",
    "day_reads",
    "plan_items",
    "plan_days",
    "exercises"
  );
});

function seedDay({ focus = STALE_FOCUS } = {}) {
  for (const [name, group, mode] of EXERCISES) repo.upsertExercise({ name, muscle_group: group, mode });
  savePlanDaySettled(DAY, DAY_NAME, focus, ITEMS);
  // Last week's plank went 68 s: the hold anchors a timed target on the log.
  repo.logSetByName({ date: "2031-06-24", exercise: "Front Plank", duration_sec: 68, day_number: null });
}

// The incident's envelope: a rest read the athlete trained through — volume reduced,
// intensity held, a 40-minute clock.
function trainAnywayEnvelope(requestExtras = {}) {
  return {
    policy_version: "daily_decision_v7",
    input_fingerprint: "test-fp",
    generated_at: "2031-07-01T09:00:00.000Z",
    date: DATE,
    kind: "train",
    baseline_kind: "rest",
    request: { override: null, train_anyway: true, equipment: null, minutes: null, goal: null, ...requestExtras },
    template: { day_number: DAY, plan_day_id: null, focus: STALE_FOCUS, intent: "template" },
    muscles: { required: [], allowed: [], reduced: [], excluded: [], saturated: [], deep: [] },
    caps: { volume: "reduced", intensity: "hold", duration_min: 40 },
    candidates: [],
    hard_constraints: [],
    soft_preferences: [],
    rationale: [{ code: "athlete_override", text: "Training by choice." }],
    precedence: ["athlete_override"],
  };
}

const SAME_DAY_REQUEST = {
  day_number: DAY,
  exercises: ITEMS.map((item) => item.exercise.toLowerCase()).sort(),
  decision_ids: [1],
};

function setsByName(session) {
  return Object.fromEntries(session.items.map((item) => [item.exercise, item.sets]));
}

test("a reduced train-anyway day keeps every one of the plan day's nine lifts, trims recorded", () => {
  seedDay();
  const envelope = trainAnywayEnvelope();
  const session = deterministicComposedSession(envelope);
  assert.deepEqual(
    session.items.map((item) => item.exercise).sort(),
    ITEMS.map((item) => item.exercise).sort(),
    "no authored lift is deleted by the day's budget or its item cap"
  );
  const sets = setsByName(session);
  assert.ok(
    Object.values(sets).every((n) => n >= 1),
    "every lift keeps at least one working set"
  );
  assert.equal(
    Object.values(sets).reduce((sum, n) => sum + n, 0),
    12,
    "the reduced day's twelve-set budget still binds"
  );
  // Largest first, ties to the lift later in effect order: the compounds keep more, and
  // the tail keeps a set rather than vanishing.
  assert.equal(sets["Landmine Press"], 2);
  assert.equal(sets["Dumbbell Bench Press"], 2);
  assert.equal(sets["Wide-Grip Pulldown"], 2);
  assert.equal(sets["Upright Row"], 1);
  assert.equal(sets["Front Plank"], 1);
  assert.equal(sets["Triceps Rope Pushdown"], 1);

  // The same composition, with its validation: every reduction is on the record.
  const raw = {
    name: DAY_NAME,
    focus: STALE_FOCUS,
    why: "Training by choice.",
    est_minutes: 40,
    items: ITEMS.map((item) => ({ ...item })),
  };
  const { session: snap, validation } = normalizeComposedSession(raw, envelope, { planSnapshot: true });
  assert.equal(snap.items.length, ITEMS.length);
  const trims = validation.rejected.filter((entry) => entry.reason === "day_set_budget");
  assert.equal(
    trims.reduce((sum, entry) => sum + (entry.sets_from - entry.sets_to), 0),
    AUTHORED_SETS - 12,
    "every set the budget took is recorded"
  );
  assert.ok(trims.every((entry) => entry.sets_to >= 1 && entry.sets_to < entry.sets_from));
  assert.ok(
    validation.rejected.every((entry) => entry.reason === "day_set_budget"),
    "nothing was dropped, only trimmed"
  );
  const trimmedCard = snap.items.find((item) => item.exercise === trims[0].exercise);
  assert.ok(
    DAY_BUDGET_TRIM_NOTES.some((note) => String(trimmedCard.note).includes(note)),
    "a trimmed card says why it is shorter"
  );
});

test("the plan day's card is titled by its name, and its focus names only lifts it carries", () => {
  seedDay();
  const session = deterministicComposedSession(trainAnywayEnvelope());
  assert.equal(session.name, "Upper B", "the plan day's display name, never the stale focus prose");
  assert.equal(
    session.focus,
    "Flat dumbbell bench, upright row and plank. The threshold run is the next day.",
    "the rotated-out seated press and the removed carry are not claimed"
  );
});

test("the session the athlete asked for today keeps its authored sets and the 70 s plank; the load holds", () => {
  seedDay();
  const envelope = trainAnywayEnvelope({ same_day_request: SAME_DAY_REQUEST });
  const session = deterministicComposedSession(envelope);
  assert.deepEqual(
    setsByName(session),
    Object.fromEntries(ITEMS.map((item) => [item.exercise, item.sets])),
    "every authored set count stands"
  );
  const plank = session.items.find((item) => item.exercise === "Front Plank");
  assert.equal(plank.target_seconds, 70, "the hold does not shorten the hold they set (68 s in the log)");
  for (const item of ITEMS.filter((it) => it.target_weight != null)) {
    const card = session.items.find((c) => c.exercise === item.exercise);
    assert.ok(card.target_weight <= item.target_weight, `${item.exercise} is never raised`);
    assert.equal(card.reach, undefined, "no reach on a held day");
  }
  assert.equal(session.items.filter((item) => item.reach).length, 0);
  // 22 working sets at the composition's per-set clock: longer than the 40-minute clamp,
  // so the card says the work's own length.
  assert.equal(session.est_minutes, Math.round(AUTHORED_SETS * 2.5));
  assert.ok(session.est_minutes > envelope.caps.duration_min);
  // With the pull and arm work back on the card, its antagonist pairs come back too.
  const groupOf = (name) => session.items.find((item) => item.exercise === name).superset_group;
  assert.ok(groupOf("Dumbbell Bench Press") != null);
  assert.equal(groupOf("Dumbbell Bench Press"), groupOf("Chest-Supported Row"));
  assert.ok(groupOf("Dumbbell Biceps Curl") != null);
  assert.equal(groupOf("Dumbbell Biceps Curl"), groupOf("Triceps Rope Pushdown"));
});

test("without the request the 68 s log still holds the plank, and est_minutes stays the clamp", () => {
  seedDay();
  const session = deterministicComposedSession(trainAnywayEnvelope());
  assert.equal(session.items.find((item) => item.exercise === "Front Plank").target_seconds, 68);
  assert.equal(session.est_minutes, 40, "twelve trimmed sets fit inside the clock");
});

test("an agent-authored session keeps the plain clamp, request or not", () => {
  seedDay();
  const agent = {
    name: "Composed",
    focus: "Upper",
    why: "Fits.",
    est_minutes: 40,
    items: ITEMS.map((item) => ({ ...item })),
  };
  const { session } = normalizeComposedSession(agent, trainAnywayEnvelope({ same_day_request: SAME_DAY_REQUEST }));
  assert.ok(session.items.length <= 7, "the agent's output is never loosened by the athlete's request");
  assert.ok(session.items.reduce((sum, item) => sum + item.sets, 0) <= 12);
  assert.equal(session.name, "Composed");
});

test("a today-scoped change the athlete asked for is their same-day request; the coach's own is not", () => {
  const today = localDateISO();
  repo.setSettings({ lead_mode: "lead" });
  for (const [name, group, mode] of EXERCISES) repo.upsertExercise({ name, muscle_group: group, mode });
  savePlanDaySettled(1, "Upper B", STALE_FOCUS, ITEMS.slice(0, 4));
  const ask = (exercise, explicit) =>
    applyProposalWithAutonomy(
      Number(
        repo.createProposal("stub", "background: chat signal", "", {
          summary: "A longer session today",
          changes: [{ day_number: 1, exercise, sets: 3, rep_low: 8, rep_high: 10, target_weight: 45, until: today }],
        }).id
      ),
      { requested_tier: "quiet_apply", ...(explicit ? { explicit_user_request: true } : {}) }
    );

  const coach = ask("Chest-Supported Row", false);
  assert.equal(coach.ok, true, JSON.stringify(coach));
  assert.equal(activePlanAdaptations(today).length, 1, "the coach's change is a live today-scoped adaptation");
  assert.equal(sameDayAthleteRequest(1, today), null, "a coach change scoped to today is not the athlete's ask");

  const theirs = ask("Wide-Grip Pulldown", true);
  assert.equal(theirs.ok, true, JSON.stringify(theirs));
  assert.equal(theirs.applied !== false, true, "an explicit request lands now");
  assert.equal(theirs.decision.context.explicit_user_request, true, "the immediate apply keeps the athlete's flag");
  const request = sameDayAthleteRequest(1, today);
  assert.deepEqual(request?.exercises, ["wide-grip pulldown"], "only the lift the athlete's own request wrote");
  assert.equal(sameDayAthleteRequest(1, "2099-01-01"), null, "only the day it was scoped to");

  // The decision carries it on a train-anyway request — in the fingerprint and visible.
  const plain = gatherDailyDecisionSnapshot(today);
  assert.equal("same_day_request" in plain.request, false, "omit-when-idle without train-anyway");
  const snapshot = gatherDailyDecisionSnapshot(today, { train_anyway: true });
  assert.deepEqual(snapshot.request.same_day_request?.exercises, ["wide-grip pulldown"]);
  const envelope = buildDailySessionDecision(snapshot, { now: `${today}T09:00:00.000Z` });
  assert.deepEqual(envelope.request.same_day_request, snapshot.request.same_day_request);
  assert.ok(envelope.precedence.includes("athlete_same_day_request"));
  assert.ok(envelope.soft_preferences.some((entry) => entry.code === "athlete_same_day_request"));
});

test("the focus reader drops only the movements no card lift matches", () => {
  const cards = ["Dumbbell Bench Press", "Upright Row", "Front Plank", "Back Squat"];
  assert.equal(focusWithoutAbsentMovements("Squat-led lower body", cards), "Squat-led lower body");
  assert.equal(focusWithoutAbsentMovements("Push and pull, upper back", cards), "Push and pull, upper back");
  assert.equal(focusWithoutAbsentMovements("Squat day with a carry finisher.", cards), "Squat day.");
  assert.equal(focusWithoutAbsentMovements("Carry and deadlift.", cards), null);
  assert.equal(focusWithoutAbsentMovements("Close-grip bench", cards), null, "a qualifier no card lift carries");
  assert.equal(focusWithoutAbsentMovements(STALE_FOCUS, []), STALE_FOCUS, "nothing to hold it to");
  assert.equal(
    datedPlanDayFocus("Seated dumbbell press and plank.", "2031-07-01", { exercises: cards }),
    "Plank.",
    "the dated reader takes the card's lifts"
  );
  assert.equal(datedPlanDayFocus("Seated dumbbell press and plank.", "2031-07-01"), "Seated dumbbell press and plank.");
});
