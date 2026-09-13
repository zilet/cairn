// Stated run days (`endurance_schedule` on profile) — parse/normalize, weeklyRunPlan
// anchoring, flexible agenda openings, and the chat write path.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";
import { applyChatActions } from "../dist/chatTurns.js";
import { normalizeChatAction } from "../dist/chatActions.js";

const MONDAY = "2026-04-20";
const THURSDAY = "2026-04-23";
const FRIDAY = "2026-04-24";
const SATURDAY = "2026-04-25";

const STATED = {
  days: [
    { dow: 2, kind: "quality" },
    { dow: 4, kind: "easy" },
    { dow: 6, kind: "long" },
  ],
  source: "athlete",
};

function resetAll() {
  resetTables(
    "logged_sets",
    "sessions",
    "activities",
    "garmin_activities",
    "garmin_sources",
    "exercises",
    "plan_items",
    "plan_days",
    "daily_metrics",
    "garmin_daily_metrics",
    "program_blocks",
    "plan_proposals",
    "app_state",
    "chat_turns",
    "chat_messages",
    "profile"
  );
}

function seedRunner({ weeks = 10, perWeek = 3, km = 9, from = MONDAY } = {}) {
  const before = (n) => new Date(new Date(from + "T00:00:00Z").getTime() - n * 864e5).toISOString().slice(0, 10);
  for (let wk = 0; wk < weeks; wk++) {
    const offsets = [1, 3, 5].slice(0, perWeek);
    for (const off of offsets) {
      repo.addActivity({ type: "run", duration_min: Math.round(km * 6), distance_km: km, date: before(wk * 7 + off) });
    }
  }
}

beforeEach(resetAll);

test("normalizeEnduranceSchedule round-trips a valid schedule", () => {
  const normalized = repo.normalizeEnduranceSchedule({
    days: [
      { dow: 2, kind: "quality" },
      { dow: 4, kind: "easy" },
      { dow: 6, kind: "long" },
    ],
    note: "three runs around lifting",
    source: "chat",
  });
  assert.ok(normalized);
  assert.equal(normalized.source, "chat");
  assert.equal(normalized.note, "three runs around lifting");
  assert.deepEqual(
    normalized.days,
    [
      { dow: 2, kind: "quality" },
      { dow: 4, kind: "easy" },
      { dow: 6, kind: "long" },
    ]
  );
  const again = repo.normalizeEnduranceSchedule(JSON.stringify(normalized));
  assert.deepEqual(again.days, normalized.days);
  assert.equal(again.source, normalized.source);
  assert.equal(again.note, normalized.note);
});

test("normalizeEnduranceSchedule rejects a bad dow or unknown kind", () => {
  assert.equal(repo.normalizeEnduranceSchedule({ days: [{ dow: 9, kind: "quality" }] }), null);
  assert.equal(repo.normalizeEnduranceSchedule({ days: [{ dow: -1, kind: "easy" }] }), null);
  assert.equal(repo.normalizeEnduranceSchedule({ days: [{ dow: 2.5, kind: "easy" }] }), null);
  assert.equal(repo.normalizeEnduranceSchedule({ days: [{ dow: 2, kind: "tempo" }] }), null);
  assert.equal(repo.normalizeEnduranceSchedule({ days: [{ dow: 2 }] }), null);
  assert.equal(repo.normalizeEnduranceSchedule({ days: [] }), null);
  assert.equal(repo.normalizeEnduranceSchedule("not-json"), null);
  assert.equal(repo.normalizeEnduranceSchedule(null), null);
});

test("normalizeEnduranceSchedule dedupes duplicate dows (first kind wins)", () => {
  const normalized = repo.normalizeEnduranceSchedule({
    days: [
      { dow: 2, kind: "quality" },
      { dow: 2, kind: "easy" },
      { dow: 6, kind: "long" },
    ],
  });
  assert.ok(normalized);
  assert.deepEqual(normalized.days, [
    { dow: 2, kind: "quality" },
    { dow: 6, kind: "long" },
  ]);
});

test("weeklyRunPlan with a stated schedule lands day_numbers on those dows", () => {
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_goal: { mode: "standing", label: "10k-ready", weekly_km: 30, weekly_sessions: 3 },
    endurance_schedule: STATED,
  });
  seedRunner();
  const plan = repo.weeklyRunPlan(MONDAY);
  assert.equal(plan.available, true);
  const byKind = Object.fromEntries(plan.runs.map((r) => [r.kind_label, r.day_number]));
  assert.equal(byKind.quality, 2, "quality lands on Tuesday");
  assert.equal(byKind.easy, 4, "easy lands on Thursday");
  assert.equal(byKind.long, 6, "long lands on Saturday");
  assert.deepEqual(
    [...new Set(plan.runs.map((r) => r.day_number))].sort(),
    [2, 4, 6]
  );
  assert.ok(!plan.runs.some((r) => r.day_number === 5), "Friday is not a run day");
});

test("weeklyRunPlan without a schedule keeps the existing heuristic slots", () => {
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_goal: { mode: "standing", label: "10k-ready", weekly_km: 30, weekly_sessions: 3 },
  });
  seedRunner();
  const plan = repo.weeklyRunPlan(MONDAY);
  assert.equal(plan.available, true);
  const long = plan.runs.find((r) => r.kind_label === "long");
  const quality = plan.runs.find((r) => r.kind_label === "quality");
  assert.equal(long.day_number, 6, "heuristic long run stays late-week");
  assert.equal(quality.day_number, 2, "heuristic quality stays mid-week");
});

test("flexibleTrainingAgenda as-of Friday does not spill a run onto Friday", () => {
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_goal: { mode: "standing", label: "10k-ready", weekly_km: 30, weekly_sessions: 3 },
    endurance_schedule: STATED,
  });
  seedRunner();
  const weekPlan = repo.weeklyRunPlan(MONDAY);
  const easyTarget = weekPlan.runs.find((r) => r.kind_label === "easy")?.target_distance_km ?? 8;
  const longTarget = weekPlan.runs.find((r) => r.kind_label === "long")?.target_distance_km ?? 14;
  const easyFloor = easyTarget * 0.5;
  const longCap = longTarget * 0.75;
  const thursdayKm = Math.round((easyFloor + 0.4) * 10) / 10;
  assert.ok(
    thursdayKm >= easyFloor && thursdayKm < longCap,
    `Thursday dose ${thursdayKm} km should close easy (>= ${easyFloor}) without claiming long (< ${longCap})`
  );
  repo.addActivity({
    type: "run",
    date: THURSDAY,
    duration_min: Math.round(thursdayKm * 6.5),
    distance_km: thursdayKm,
  });

  const agenda = repo.flexibleTrainingAgenda(FRIDAY);
  assert.equal(agenda.available, true);
  const open = agenda.intents.filter((intent) => intent.status === "open");
  assert.ok(
    open.every((intent) => intent.suggested_date !== FRIDAY),
    "no open intent is suggested for Friday"
  );
  const long = agenda.intents.find((intent) => intent.kind === "long");
  assert.ok(long);
  assert.equal(long.status, "open");
  assert.equal(long.suggested_date, SATURDAY);
  const easy = agenda.intents.find((intent) => intent.kind === "easy");
  assert.equal(easy.status, "completed", "Thursday's logged run still closes the easy intention");
  assert.equal(easy.completion.date, THURSDAY);
});

test("set_endurance_schedule writes the column; a malformed payload does not", () => {
  assert.equal(repo.getEnduranceSchedule(), null);

  const written = applyChatActions(
    {
      actions: [
        {
          type: "set_endurance_schedule",
          days: [
            { dow: 2, kind: "quality" },
            { dow: 4, kind: "easy" },
            { dow: 6, kind: "long" },
          ],
        },
      ],
    },
    { agent: "stub", message: "plan my strength around 3 runs — Tue/Thu and a long run on the weekend" }
  );
  assert.equal(written.applied[0]?.type, "set_endurance_schedule");
  const stored = repo.getEnduranceSchedule();
  assert.ok(stored);
  assert.equal(stored.source, "chat");
  assert.deepEqual(
    stored.days.map((d) => ({ dow: d.dow, kind: d.kind })),
    [
      { dow: 2, kind: "quality" },
      { dow: 4, kind: "easy" },
      { dow: 6, kind: "long" },
    ]
  );

  assert.equal(normalizeChatAction({ type: "set_endurance_schedule", days: [{ dow: 9, kind: "quality" }] }), null);
  const rejected = applyChatActions(
    { actions: [{ type: "set_endurance_schedule", days: [{ dow: 9, kind: "quality" }] }] },
    { agent: "stub", message: "run on the ninth day of the week" }
  );
  assert.equal(rejected.applied.length, 0, "malformed action is dropped before write");
  const still = repo.getEnduranceSchedule();
  assert.ok(still, "the previously written schedule is intact");
  assert.equal(still.days.length, 3);
});
