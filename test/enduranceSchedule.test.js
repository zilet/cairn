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
  assert.deepEqual(normalized.days, [
    { dow: 2, kind: "quality" },
    { dow: 4, kind: "easy" },
    { dow: 6, kind: "long" },
  ]);
  const again = repo.normalizeEnduranceSchedule(JSON.stringify(normalized));
  assert.deepEqual(again.days, normalized.days);
  assert.equal(again.source, normalized.source);
  assert.equal(again.note, normalized.note);
});

test("normalizeEnduranceSchedule rejects input where nothing named was understood", () => {
  // A `days` array is present but every single entry in it is unrecognized, so
  // there is nothing valid to fall back to — this is still a rejection (leave the
  // stored schedule alone), never confused with an athlete's explicit clear.
  assert.equal(repo.normalizeEnduranceSchedule({ days: [{ dow: 9, kind: "quality" }] }), null);
  assert.equal(repo.normalizeEnduranceSchedule({ days: [{ dow: -1, kind: "easy" }] }), null);
  assert.equal(repo.normalizeEnduranceSchedule({ days: [{ dow: 2.5, kind: "easy" }] }), null);
  assert.equal(repo.normalizeEnduranceSchedule({ days: [{ dow: 2, kind: "tempo" }] }), null);
  assert.equal(repo.normalizeEnduranceSchedule({ days: [{ dow: 2 }] }), null);
  // No `days` array at all, or unparseable / non-object input, is rejected the same way.
  assert.equal(repo.normalizeEnduranceSchedule("not-json"), null);
  assert.equal(repo.normalizeEnduranceSchedule(null), null);
  assert.equal(repo.normalizeEnduranceSchedule({}), null);
});

test("normalizeEnduranceSchedule drops one bad entry and KEEPS the valid ones alongside it", () => {
  // The bug this closes: one unrecognized dow/kind used to void the WHOLE
  // schedule, so a typo on one named day silently erased every day the athlete
  // got right. Only the bad entry is dropped now.
  const normalized = repo.normalizeEnduranceSchedule({
    days: [
      { dow: 2, kind: "quality" },
      { dow: 9, kind: "quality" }, // bad dow
      { dow: 4, kind: "tempo" }, // bad kind
      { dow: 6, kind: "long" },
    ],
  });
  assert.ok(normalized, "the two valid entries must still produce a schedule");
  assert.deepEqual(normalized.days, [
    { dow: 2, kind: "quality" },
    { dow: 6, kind: "long" },
  ]);
});

test("normalizeEnduranceSchedule treats an explicit days: [] as a real, empty schedule (a clear) — not a rejection", () => {
  const cleared = repo.normalizeEnduranceSchedule({ days: [], source: "chat" });
  assert.ok(cleared, "an explicit empty schedule is a real value, not null");
  assert.deepEqual(cleared.days, []);
  assert.equal(cleared.source, "chat");
  // Every existing consumer already gates on `schedule?.days.length`, so an empty
  // schedule reads exactly like "unset" downstream.
  assert.equal(cleared.days.length, 0);
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
  assert.deepEqual([...new Set(plan.runs.map((r) => r.day_number))].sort(), [2, 4, 6]);
  assert.ok(!plan.runs.some((r) => r.day_number === 5), "Friday is not a run day");
});

test("a constrained supporting week (fresh low readiness) keeps a named quality day as easy, not dropped", () => {
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    training_intent: {
      priorities: ["longevity", "muscle", "strength", "leanness", "endurance"],
      endurance_role: "supporting",
    },
    endurance_goal: {
      mode: "race",
      event: "Test Half Marathon",
      date: "2026-07-20",
      distance_km: 21.1,
      weekly_sessions: 3,
    },
    endurance_schedule: {
      days: [
        { dow: 0, kind: "long" },
        { dow: 2, kind: "easy" },
        { dow: 4, kind: "quality" },
        { dow: 6, kind: "long" },
      ],
      source: "athlete",
    },
  });
  seedRunner({ weeks: 8, perWeek: 3, km: 8 });
  const lowRecovery = {
    quality: {
      training_readiness: { freshness: "fresh", latest_date: MONDAY },
      training_status: { freshness: "fresh" },
    },
    recovery: { readiness_band: "low", training_status: "PRODUCTIVE" },
    delta: { hrv: null, rhr: null, sleep: null },
  };
  const plan = repo.weeklyRunPlan(MONDAY, { recovery: lowRecovery, block: { week_index: 1 } });
  assert.equal(plan.available, true);
  // A low readiness reading dated the plan day is FRESH strain, not a recovery dip read
  // off a median: it keeps the supporting role's constrained week, so the hard session
  // sits out (test/eliteDipFix "fresh strain"). A dip alone does not (same file).
  assert.equal(plan.quality_focus, null, "the hard session sits out");
  const byDay = Object.fromEntries(plan.runs.map((r) => [r.day_number, r]));
  assert.equal(byDay[2]?.kind_label, "easy", "Tuesday easy stays");
  assert.equal(byDay[4]?.kind_label, "easy", "Thursday quality becomes easy rather than disappearing");
  assert.equal(byDay[7]?.kind_label, "long", "Sunday keeps the long");
  assert.equal(byDay[6], undefined, "the spare Saturday long is not invented as a fourth run");
  assert.deepEqual(
    plan.runs.map((r) => r.day_number).sort((a, b) => a - b),
    [2, 4, 7]
  );
  assert.ok(
    byDay[2].target_distance_km <= 7 && byDay[4].target_distance_km <= 7,
    `named easies stay recovery-sized, got ${byDay[2].target_distance_km} / ${byDay[4].target_distance_km} km`
  );
  assert.ok(
    byDay[2].target_distance_km < byDay[7].target_distance_km &&
      byDay[4].target_distance_km < byDay[7].target_distance_km,
    "eased days stay shorter than the long"
  );
  assert.match(plan.rationale.join(" "), /keeps the days you named and eases them/i);
  assert.doesNotMatch(plan.rationale.join(" "), /two useful runs/i);
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

test("chat CAN clear a stated schedule with an explicit empty days: []", () => {
  // The bug this closes: normalizeEnduranceSchedule used to return null for BOTH
  // "invalid input" and "explicit days: []", so the chat action's `if (!schedule)`
  // guard read a genuine clear request as malformed and refused to write it —
  // an athlete could set a schedule but never clear one again from chat.
  repo.setProfile({
    endurance_schedule: {
      days: [
        { dow: 2, kind: "quality" },
        { dow: 4, kind: "easy" },
        { dow: 6, kind: "long" },
      ],
      source: "athlete",
    },
  });
  assert.equal(repo.getEnduranceSchedule().days.length, 3);

  const cleared = applyChatActions(
    { actions: [{ type: "set_endurance_schedule", days: [] }] },
    { agent: "stub", message: "clear my run schedule, just have the coach pick days" }
  );
  assert.equal(cleared.applied[0]?.type, "set_endurance_schedule");
  assert.equal(cleared.applied[0]?.error, undefined, "an explicit clear is not an error");
  const after = repo.getEnduranceSchedule();
  assert.ok(after, "an explicit clear returns a real (empty) schedule, not null");
  assert.equal(after.days.length, 0);
  assert.equal(repo.isStatedRunDay("2026-04-21"), null, "an emptied schedule reads exactly like unset downstream");
});
