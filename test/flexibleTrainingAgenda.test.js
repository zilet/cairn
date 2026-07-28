import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { projectCoachContext } from "../dist/prompt/context-projection.js";
import { renderDiscipline, renderRunPlan } from "../dist/prompt/shared.js";

const MONDAY = "2026-04-20";
const TUESDAY = "2026-04-21";
const WEDNESDAY = "2026-04-22";

function run(day_number, kind, km = 6) {
  return {
    day_number,
    label: kind === "quality" ? "Tempo run" : kind === "long" ? "Long run" : "Easy run",
    kind_label: kind,
    target_distance_km: km,
    target_duration_min: null,
    target_zone: kind === "quality" ? "Z3" : "Z2",
    note: null,
    day_name: `${kind} run`,
    focus: "Endurance",
    interval: null,
  };
}

function plan(runs) {
  return {
    available: true,
    week_start: MONDAY,
    runs,
    rationale: [],
    quality_focus: runs.some((item) => item.kind_label === "quality") ? "Tempo run" : null,
    mix_summary: "flexible test week",
    why: "A movable test week.",
  };
}

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
    "profile"
  );
}

function addQualityEvidence(activity, { label = "TEMPO", aerobicTe = 3.2 } = {}) {
  const source = db
    .prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin', ?)`)
    .run(`agenda-${activity.id}`);
  db.prepare(
    `INSERT INTO garmin_activities
       (source_id, external_id, activity_id, date, type, te_label, aerobic_te)
     VALUES (?, ?, ?, ?, 'running', ?, ?)`
  ).run(source.lastInsertRowid, `agenda-run-${activity.id}`, activity.id, activity.date, label, aerobicTe);
}

beforeEach(resetAll);

test("an early or late easy run closes one compatible weekly intention without an exact-day penalty", () => {
  repo.addActivity({ type: "run", date: MONDAY, duration_min: 32, distance_km: 5 });
  const early = repo.flexibleTrainingAgenda(TUESDAY, { runPlan: plan([run(5, "easy", 6)]) });
  assert.equal(early.intents[0].status, "completed");
  assert.equal(early.intents[0].completion.date, MONDAY);
  assert.match(early.intents[0].rationale, /does not need to match the provisional anchor/i);

  resetAll();
  repo.addActivity({ type: "run", date: TUESDAY, duration_min: 32, distance_km: 5 });
  const late = repo.flexibleTrainingAgenda(TUESDAY, { runPlan: plan([run(1, "easy", 6)]) });
  assert.equal(late.intents[0].status, "completed");
  assert.equal(late.intents[0].completion.date, TUESDAY);
  assert.doesNotMatch(JSON.stringify(late), /\bmissed\b/i);
});

test("quality completion requires positive intensity evidence", () => {
  const activity = repo.addActivity({ type: "run", date: MONDAY, duration_min: 38, distance_km: 6 });
  const withoutEvidence = repo.flexibleTrainingAgenda(TUESDAY, { runPlan: plan([run(2, "quality", 7)]) });
  assert.equal(withoutEvidence.intents[0].status, "open", "distance alone is not a quality signal");

  addQualityEvidence(activity);
  const withEvidence = repo.flexibleTrainingAgenda(TUESDAY, { runPlan: plan([run(2, "quality", 7)]) });
  assert.equal(withEvidence.intents[0].status, "completed");
  assert.equal(withEvidence.intents[0].completion.intensity, "quality");
});

test("a completed intention is consumed once and cannot be recommended again", () => {
  repo.addActivity({ type: "run", date: MONDAY, duration_min: 35, distance_km: 6 });
  const agenda = repo.flexibleTrainingAgenda(TUESDAY, {
    runPlan: plan([run(1, "easy", 6), run(6, "long", 12)]),
  });
  const easy = agenda.intents.find((intent) => intent.kind === "easy");
  assert.equal(easy.status, "completed");
  assert.equal(easy.suggested_date, null);
  assert.notEqual(agenda.next?.intent_id, easy.id);
});

test("a live-shaped threshold run today reserves today and moves the remaining easy intention to tomorrow", () => {
  const activity = repo.addActivity({
    type: "run",
    date: TUESDAY,
    duration_min: 46.9,
    distance_km: 7,
  });
  addQualityEvidence(activity, { label: "LACTATE_THRESHOLD", aerobicTe: 3.5 });
  const agenda = repo.flexibleTrainingAgenda(TUESDAY, {
    // No quality intention remains in this supporting shape, so this sufficiently
    // long threshold effort closes the compatible long intention exactly once.
    runPlan: plan([run(1, "easy", 6), run(6, "long", 8)]),
  });
  const completed = agenda.intents.find((intent) => intent.status === "completed");
  const easy = agenda.intents.find((intent) => intent.kind === "easy");
  assert.equal(completed.kind, "long");
  assert.equal(completed.completion.activity_id, activity.id);
  assert.equal(completed.completion.date, TUESDAY);
  assert.equal(easy.status, "open");
  assert.equal(easy.suggested_date, WEDNESDAY, "today's real run reserves today from a second run suggestion");
  assert.equal(agenda.today_guidance, "not_first_choice");
  assert.equal(agenda.next.intent_id, easy.id);
  assert.equal(agenda.next.suggested_date, WEDNESDAY);
  assert.match(agenda.next.guidance, /logged cardio already fills today's opening/i);
  assert.doesNotMatch(agenda.next.guidance, /key run/i);
});

test("a matched easy-effort completion date cannot be reused for another run intention", () => {
  const activity = repo.addActivity({
    type: "run",
    date: TUESDAY,
    duration_min: 50,
    distance_km: 8,
  });
  const agenda = repo.flexibleTrainingAgenda(TUESDAY, {
    runPlan: plan([run(1, "easy", 6), run(6, "long", 8)]),
  });
  const long = agenda.intents.find((intent) => intent.kind === "long");
  const easy = agenda.intents.find((intent) => intent.kind === "easy");
  assert.equal(long.status, "completed");
  assert.equal(long.completion.intensity, "easy", "the completion itself carries no hard-effort grade");
  assert.equal(easy.suggested_date, WEDNESDAY);
  assert.notEqual(agenda.next.suggested_date, TUESDAY);
});

test("a short unmatched run still reserves its actual date from another run suggestion", () => {
  repo.addActivity({
    type: "run",
    date: TUESDAY,
    duration_min: 8,
    distance_km: 1,
  });
  const agenda = repo.flexibleTrainingAgenda(TUESDAY, {
    runPlan: plan([run(2, "easy", 6)]),
  });
  assert.equal(agenda.intents[0].status, "open", "the short run does not complete the intended dose");
  assert.equal(agenda.intents[0].suggested_date, WEDNESDAY);
  assert.equal(agenda.today_guidance, "not_first_choice");
});

test("a completed key run preserves separation before another key run", () => {
  repo.addActivity({
    type: "run",
    date: TUESDAY,
    duration_min: 10,
    distance_km: 1.5,
  });
  const agenda = repo.flexibleTrainingAgenda(TUESDAY, {
    runPlan: plan([run(2, "long", 2), run(2, "quality", 7)]),
  });
  const quality = agenda.intents.find((intent) => intent.kind === "quality");
  const long = agenda.intents.find((intent) => intent.kind === "long");
  assert.equal(long.status, "completed");
  assert.equal(long.completion.intensity, "easy");
  assert.equal(quality.status, "open");
  assert.equal(quality.suggested_date, "2026-04-23", "the next key run keeps a clear intervening day");
});

test("cross-training informs load but cannot complete half-marathon running", () => {
  repo.addActivity({ type: "mountain_biking", date: MONDAY, duration_min: 120, distance_km: 30 });
  const agenda = repo.flexibleTrainingAgenda(TUESDAY, { runPlan: plan([run(2, "easy", 6)]) });
  assert.equal(agenda.intents[0].status, "open");
  assert.equal(agenda.intents[0].completion, null);
});

test("light cross-training can share an easy-run day without blocking the week", () => {
  repo.addActivity({ type: "ride", date: TUESDAY, duration_min: 10, distance_km: 2 });
  const agenda = repo.flexibleTrainingAgenda(TUESDAY, { runPlan: plan([run(2, "easy", 6)]) });
  assert.equal(agenda.intents[0].status, "open");
  assert.equal(agenda.intents[0].suggested_date, TUESDAY);
  assert.equal(agenda.today_guidance, "open");
});

test("moderate cross-training reserves today from another run suggestion", () => {
  repo.addActivity({ type: "ride", date: TUESDAY, duration_min: 30, distance_km: 5 });
  const agenda = repo.flexibleTrainingAgenda(TUESDAY, { runPlan: plan([run(2, "easy", 6)]) });
  assert.equal(agenda.intents[0].status, "open");
  assert.equal(agenda.intents[0].suggested_date, WEDNESDAY);
  assert.equal(agenda.today_guidance, "not_first_choice");
});

test("an actually shifted lower-body lift moves a key run away from the new conflict", () => {
  for (let set_number = 1; set_number <= 3; set_number++) {
    repo.logSetByName({
      exercise: "Back Squat",
      date: TUESDAY,
      set_number,
      weight: 200,
      reps: 5,
      rir: 2,
    });
  }
  db.prepare(`UPDATE exercises SET muscle_group = 'quads' WHERE name = 'Back Squat'`).run();
  const agenda = repo.flexibleTrainingAgenda(TUESDAY, {
    runPlan: plan([run(2, "quality", 7), run(6, "long", 12)]),
  });
  const quality = agenda.intents.find((intent) => intent.kind === "quality");
  assert.equal(quality.provisional_date, TUESDAY);
  assert.equal(quality.suggested_date, "2026-04-23", "today and the following day stay clear of the shifted lift");
  assert.equal(agenda.today_guidance, "not_first_choice");
  assert.match(quality.rationale, /moves the quality run around actual lower-body/i);
});

test("a lower-body-only date remains available for optional easy running", () => {
  for (let set_number = 1; set_number <= 3; set_number++) {
    repo.logSetByName({
      exercise: "Back Squat",
      date: TUESDAY,
      set_number,
      weight: 200,
      reps: 5,
      rir: 2,
    });
  }
  db.prepare(`UPDATE exercises SET muscle_group = 'quads' WHERE name = 'Back Squat'`).run();
  const agenda = repo.flexibleTrainingAgenda(TUESDAY, {
    runPlan: plan([run(2, "easy", 6)]),
  });
  assert.equal(agenda.intents[0].suggested_date, TUESDAY);
  assert.equal(agenda.today_guidance, "easy_only");
});

test("supporting endurance stays at three runs and falls to two when recovery is constrained", () => {
  repo.setProfile({
    age: 44,
    primary_discipline: "strength",
    endurance_sport: "running",
    training_intent: {
      priorities: ["longevity", "muscle", "leanness", "endurance"],
      endurance_role: "supporting",
      endurance_capacity: { sport: "running", target_duration_min: 120 },
    },
    endurance_goal: {
      mode: "race",
      event: "Test Half Marathon",
      date: "2026-07-20",
      distance_km: 21.1,
      weekly_km: 35,
      weekly_sessions: 5,
      target: "Sub 1:45",
    },
  });
  for (let week = 0; week < 6; week++) {
    for (const offset of [1, 3, 5]) {
      const date = new Date(Date.parse(`${MONDAY}T00:00:00Z`) - (week * 7 + offset) * 864e5).toISOString().slice(0, 10);
      repo.addActivity({ type: "run", date, duration_min: 55, distance_km: 9 });
    }
  }
  const steadyRecovery = {
    quality: {
      training_readiness: { freshness: "fresh" },
      training_status: { freshness: "fresh" },
    },
    recovery: { readiness_band: "steady", training_status: "PRODUCTIVE" },
    delta: { hrv: null, rhr: null, sleep: null },
  };
  const lowRecovery = {
    ...steadyRecovery,
    recovery: { readiness_band: "low", training_status: "PRODUCTIVE" },
  };
  const steady = repo.weeklyRunPlan(MONDAY, { recovery: steadyRecovery, block: { week_index: 1 } });
  const constrained = repo.weeklyRunPlan(MONDAY, { recovery: lowRecovery, block: { week_index: 1 } });
  assert.equal(steady.runs.length, 3);
  assert.deepEqual(
    new Set(steady.runs.map((item) => item.kind_label)),
    new Set(["easy", "quality", "long"]),
    "minimum-effective supporting shape is easy + quality + long when evidence supports it"
  );
  assert.equal(constrained.runs.length, 2);
  assert.equal(constrained.quality_focus, null);
  assert.match(constrained.rationale.join(" "), /two useful runs/i);

  repo.setProfile({
    endurance_goal: {
      mode: "race",
      event: "Test Half Marathon",
      date: "2026-07-20",
      distance_km: 21.1,
      weekly_km: 35,
      weekly_sessions: 5,
      target: "Sub 1:30 stretch",
    },
  });
  const stretchTarget = repo.weeklyRunPlan(MONDAY, { recovery: steadyRecovery, block: { week_index: 1 } });
  assert.equal(stretchTarget.runs.length, steady.runs.length, "a stretch time target does not add frequency");
  assert.equal(
    stretchTarget.runs.reduce((sum, item) => sum + Number(item.target_distance_km || 0), 0),
    steady.runs.reduce((sum, item) => sum + Number(item.target_distance_km || 0), 0),
    "a stretch time target does not add volume"
  );
});

test("a constrained two-run supporting week reduces total volume and caps each run to recent exposure", () => {
  repo.setProfile({
    age: 44,
    primary_discipline: "strength",
    endurance_sport: "running",
    training_intent: {
      priorities: ["muscle", "strength", "longevity", "endurance"],
      endurance_role: "supporting",
    },
    endurance_goal: {
      mode: "race",
      event: "Test Half Marathon",
      date: "2026-07-20",
      distance_km: 21.1,
      weekly_sessions: 5,
    },
  });
  // A 35 km recent base made of five ordinary 7 km runs.
  for (const offset of [1, 2, 3, 4, 5]) {
    const date = new Date(Date.parse(`${MONDAY}T00:00:00Z`) - offset * 864e5).toISOString().slice(0, 10);
    repo.addActivity({ type: "run", date, duration_min: 42, distance_km: 7 });
  }
  const steadyRecovery = {
    quality: {
      training_readiness: { freshness: "fresh" },
      training_status: { freshness: "fresh" },
    },
    recovery: { readiness_band: "steady", training_status: "PRODUCTIVE" },
    delta: { hrv: null, rhr: null, sleep: null },
  };
  const lowRecovery = {
    ...steadyRecovery,
    recovery: { readiness_band: "low", training_status: "PRODUCTIVE" },
  };
  const steady = repo.weeklyRunPlan(MONDAY, { recovery: steadyRecovery, block: { week_index: 1 } });
  const constrained = repo.weeklyRunPlan(MONDAY, { recovery: lowRecovery, block: { week_index: 1 } });
  const total = (weekly) => weekly.runs.reduce((sum, item) => sum + Number(item.target_distance_km || 0), 0);
  assert.equal(constrained.runs.length, 2);
  assert.ok(total(constrained) < total(steady), "dropping frequency also reduces total weekly volume");
  assert.ok(
    constrained.runs.every((item) => Number(item.target_distance_km || 0) <= 7.7),
    "no remaining run exceeds 110% of the recent 7 km per-run exposure"
  );
  assert.match(
    constrained.why,
    new RegExp(`~${Math.round(total(constrained))} km`),
    "headline reports prescribed total"
  );
  assert.match(constrained.rationale.join(" "), /nothing gets concentrated into catch-up mileage/i);
});

test("an active race remains compatible with a legacy no-endurance durable role", () => {
  repo.setProfile({
    primary_discipline: "strength",
    endurance_sport: "",
    training_intent: {
      priorities: ["strength", "muscle", "longevity"],
      endurance_role: "none",
    },
    endurance_goal: {
      mode: "race",
      event: "Test Half Marathon",
      date: "2026-07-20",
      distance_km: 21.1,
      weekly_sessions: 3,
    },
  });
  const racePlan = repo.weeklyRunPlan(MONDAY, { block: { week_index: 1 } });
  assert.equal(racePlan.available, true);
  assert.ok(racePlan.runs.length >= 2);
});

test("Saturday cannot receive both open key runs and the later intention stays undated without catch-up", () => {
  const saturday = "2026-04-25";
  const agenda = repo.flexibleTrainingAgenda(saturday, {
    runPlan: plan([run(2, "quality", 7), run(6, "long", 12)]),
  });
  const dated = agenda.intents.filter((intent) => intent.suggested_date);
  assert.equal(dated.length, 1, "only one separated key-run opening remains this late in the week");
  assert.equal(dated[0].suggested_date, saturday);
  const undated = agenda.intents.find((intent) => intent.suggested_date == null);
  assert.ok(undated);
  assert.match(undated.rationale, /without catch-up volume/i);
  assert.equal(agenda.next.intent_id, dated[0].id);
  assert.equal(agenda.next.suggested_date, saturday);
  assert.equal(new Set(dated.map((intent) => intent.suggested_date)).size, dated.length);
});

test("the rolling agenda is projected and rendered as movable, actual-log-controlled work", () => {
  const agenda = repo.flexibleTrainingAgenda(WEDNESDAY, {
    runPlan: plan([run(1, "easy", 6), run(6, "long", 12)]),
  });
  const ctx = {
    run_plan: plan([run(1, "easy", 6), run(6, "long", 12)]),
    flexible_training_agenda: agenda,
    run_variety: null,
    endurance_tests: [],
  };
  const projected = projectCoachContext(ctx, "coach");
  assert.equal(projected.flexible_training_agenda, agenda);
  const rendered = renderRunPlan(ctx);
  assert.match(rendered, /provisional anchors, not fixed-day obligations/i);
  assert.match(rendered, /actual logs and the rolling read control/i);
  assert.match(rendered, /never call an off-day run missed/i);
});

test("sport context preserves terrain and seasonal identity without inventing weather or skiing subtype", () => {
  const rendered = renderDiscipline(
    {
      profile: { age: 44 },
      discipline: { primary: "hybrid", endurance_sport: "trail MTB; skiing in winter" },
      training_intent: {
        priorities: ["longevity", "muscle", "leanness", "endurance"],
        endurance_role: "supporting",
      },
    },
    "training"
  );
  assert.match(rendered, /mixed climbing and descending, never downhill-only/i);
  assert.match(rendered, /off-season work is minimum-effective maintenance, not identity loss/i);
  assert.match(rendered, /do not assume alpine, Nordic or touring/i);
  assert.match(rendered, /never invent current weather without a fresh weather source/i);
  assert.match(rendered, /never treat weather as a gate/i);

  const unrelated = renderDiscipline(
    {
      profile: { age: 44 },
      discipline: { primary: "strength", endurance_sport: null },
      training_intent: {
        priorities: ["longevity", "muscle", "strength"],
        endurance_role: "none",
      },
      memory: [{ content: "Had a fall last week; shoulder is settling." }],
    },
    "training"
  );
  assert.doesNotMatch(unrelated, /SPORT CONTEXT|PLACE & WEATHER/i);
});
