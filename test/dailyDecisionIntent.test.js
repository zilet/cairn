import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  buildDailySessionDecision,
  gatherDailyDecisionSnapshot,
} from "../dist/repo/daily-decision.js";
import { db, repo, resetTables } from "./_seed.js";

const DATE = "2031-07-15";
const NOW = "2031-07-15T12:00:00.000Z";

function resetIntentTables() {
  resetTables(
    "daily_session_decisions",
    "daily_session_compositions",
    "logged_sets",
    "session_skips",
    "sessions",
    "day_reads",
    "activities",
    "garmin_activities",
    "garmin_sources",
    "daily_metrics",
    "garmin_daily_metrics",
    "checkins",
    "context_events",
    "plan_items",
    "plan_days",
    "program_blocks",
    "profile"
  );
}

beforeEach(resetIntentTables);

function seedLowerPlan() {
  repo.savePlanDay(1, "Lower body", "Quads and hinge", [
    { exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 7, target_weight: 225, warmup_sets: 2 },
    { exercise: "Romanian Deadlift", sets: 3, rep_low: 8, rep_high: 10, target_weight: 185 },
  ]);
}

/** Pure envelope fixture — override training_intent / plan_items for role scenarios. */
function snapshot(overrides = {}) {
  return {
    date: DATE,
    request: { override: null, train_anyway: false, equipment: null, minutes: null, goal: null },
    plan: {
      day_number: 1,
      focus: "Lower body",
      plan_day_id: 10,
      source: "adaptive",
      reason: "Legs are due",
      due: ["quads"],
      over: [],
    },
    day_read: {
      kind: "train",
      focus: "Lower body",
      est_minutes: 55,
      consecutive_training_days: 1,
      recovery_week: false,
      trained_today: false,
    },
    recovery: { has_data: true, readiness: "high", hrv_drift: "flat", rhr_drift: "flat", sleep_drift: "flat" },
    recovery_cycle: null,
    muscle_load: [],
    endurance: [],
    checkin: null,
    feedback: null,
    constraints: { injuries: [], illness: false, travel: false },
    program: {
      mesocycle_phase: "accumulation",
      adaptations_due: [],
      volume_low_groups: [],
      volume_high_groups: [],
    },
    progression: [
      { exercise: "Back Squat", muscle_group: null, action: "overload", why: "Two clean sessions" },
      { exercise: "Romanian Deadlift", muscle_group: null, action: "hold", why: "Reps not consolidated" },
    ],
    plan_items: [
      { exercise: "Back Squat", muscle_group: "quads", equipment: "barbell", mode: "reps", kind: "strength" },
      {
        exercise: "Romanian Deadlift",
        muscle_group: "hamstrings",
        equipment: "barbell",
        mode: "reps",
        kind: "strength",
      },
    ],
    training_intent: {
      priorities: ["strength", "muscle", "longevity"],
      endurance_role: "none",
      source: "explicit",
    },
    open_key_run: null,
    ...overrides,
  };
}

test("explicit endurance_role none does not invent co-primary quality-run obligations", () => {
  // Same hard-lower + open quality template that primary would soft-protect —
  // with role none, no key-run conflict is assumed from the template alone.
  const env = buildDailySessionDecision(
    snapshot({
      training_intent: {
        priorities: ["strength", "muscle", "longevity", "leanness", "endurance"],
        endurance_role: "none",
        source: "explicit",
      },
      open_key_run: {
        intent_id: "2031-07-14:quality:1",
        kind: "quality",
        suggested_date: DATE,
      },
      plan_items: [
        { exercise: "Back Squat", muscle_group: "quads", equipment: "barbell", mode: "reps", kind: "strength" },
        {
          exercise: "Romanian Deadlift",
          muscle_group: "hamstrings",
          equipment: "barbell",
          mode: "reps",
          kind: "strength",
        },
        {
          exercise: "Tempo Run",
          muscle_group: null,
          equipment: null,
          mode: "reps",
          kind: "cardio",
          target_duration_min: 40,
          target_zone: "tempo",
        },
      ],
    }),
    { now: NOW }
  );

  assert.equal(env.training_intent.endurance_role, "none");
  assert.ok(
    !env.precedence.includes("endurance_lower_conflict"),
    "role none must not fire key-run / hybrid co-primary conflict from template alone"
  );
  assert.ok(
    !env.soft_preferences.some((s) => s.code === "endurance_lower_conflict"),
    "no co-primary quality-run debt language when endurance_role is none"
  );
  assert.ok(
    !env.rationale.some((r) => /key run|quality run|co-primary|hybrid obligation/i.test(r.text)),
    "athlete-facing prose must not assume quality-run obligations"
  );
  // KIND still train — intent is soft, never a gate.
  assert.equal(env.kind, "train");
  // Overload path on lower is not held solely for a phantom key-run protect.
  const squat = env.candidates.find((c) => c.exercise === "Back Squat");
  assert.equal(squat.action, "overload");
});

test("hybrid primary_discipline with explicit role none still stamps none on the snapshot", () => {
  repo.setProfile({
    primary_discipline: "hybrid",
    endurance_sport: "running",
    training_intent: {
      priorities: ["strength", "muscle", "longevity", "endurance"],
      endurance_role: "none",
    },
  });
  // Quality cardio on a lower template — co_primary would soft-protect; none must not.
  repo.savePlanDay(1, "Lower body", "Quads and hinge", [
    { exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 7, target_weight: 225 },
    {
      exercise: "Tempo Run",
      kind: "cardio",
      target_duration_min: 35,
      target_zone: "tempo",
    },
  ]);
  const snap = gatherDailyDecisionSnapshot(DATE);
  assert.equal(snap.training_intent.endurance_role, "none");
  assert.equal(snap.training_intent.source, "explicit");
  assert.ok(snap.plan_items.some((it) => it.kind === "cardio"));
  // Derived hybrid would be co_primary — explicit none must win.
  const env = buildDailySessionDecision(snap, { now: NOW });
  assert.equal(env.training_intent.endurance_role, "none");
  assert.ok(!env.precedence.includes("endurance_lower_conflict"));
  assert.ok(!env.soft_preferences.some((s) => /key run/i.test(s.detail)));
});

test("supporting endurance with strength-leading priorities keeps muscle_due eligible without elevating missing quality", () => {
  const env = buildDailySessionDecision(
    snapshot({
      training_intent: {
        priorities: ["strength", "muscle", "longevity", "endurance"],
        endurance_role: "supporting",
        source: "explicit",
      },
      open_key_run: {
        intent_id: "2031-07-14:quality:1",
        kind: "quality",
        suggested_date: DATE,
      },
      plan_items: [
        { exercise: "Back Squat", muscle_group: "quads", equipment: "barbell", mode: "reps", kind: "strength" },
        {
          exercise: "Romanian Deadlift",
          muscle_group: "hamstrings",
          equipment: "barbell",
          mode: "reps",
          kind: "strength",
        },
        {
          exercise: "Tempo Run",
          muscle_group: null,
          equipment: null,
          mode: "reps",
          kind: "cardio",
          target_duration_min: 35,
          target_zone: "tempo",
        },
      ],
    }),
    { now: NOW }
  );

  assert.equal(env.kind, "train");
  assert.equal(env.training_intent.endurance_role, "supporting");
  assert.ok(env.precedence.includes("muscle_due"), "strength-leading still surfaces due muscle work");
  assert.ok(
    env.soft_preferences.some((s) => s.code === "muscle_due"),
    "muscle_due remains a soft preference when signals say so"
  );
  assert.ok(
    env.soft_preferences.some((s) => s.code === "training_intent") ||
      env.rationale.some((r) => r.code === "training_intent"),
    "supporting cardio is noted as optional context"
  );
  // Missing quality is never framed as plan failure.
  const failureLanguage = [...env.soft_preferences.map((s) => s.detail), ...env.rationale.map((r) => r.text)].join(
    " "
  );
  assert.ok(!/\b(failed|missed|behind|debt|must run|quality overdue)\b/i.test(failureLanguage));
  // Template strength candidates still eligible (not excluded).
  const squat = env.candidates.find((c) => c.exercise === "Back Squat");
  assert.ok(squat);
  assert.notEqual(squat.action, "exclude");
});

test("supporting endurance names open long work as long, never quality", () => {
  const env = buildDailySessionDecision(
    snapshot({
      training_intent: {
        priorities: ["strength", "muscle", "longevity", "endurance"],
        endurance_role: "supporting",
        source: "explicit",
      },
      open_key_run: {
        intent_id: "2031-07-14:long:1",
        kind: "long",
        suggested_date: DATE,
      },
    }),
    { now: NOW }
  );
  const supportingCopy = [
    ...env.soft_preferences.filter((item) => item.code === "training_intent").map((item) => item.detail),
    ...env.rationale.filter((item) => item.code === "training_intent").map((item) => item.text),
  ].join(" ");
  assert.match(supportingCopy, /\blong run\b/i);
  assert.doesNotMatch(supportingCopy, /\bquality\b/i);
});

test("primary endurance soft-protects the key-run opening when hard lower conflicts", () => {
  const env = buildDailySessionDecision(
    snapshot({
      training_intent: {
        priorities: ["endurance", "longevity", "strength"],
        endurance_role: "primary",
        source: "explicit",
      },
      open_key_run: {
        intent_id: "2031-07-14:quality:1",
        kind: "quality",
        suggested_date: DATE,
      },
      plan: {
        day_number: 1,
        focus: "Hybrid lower + quality",
        plan_day_id: 10,
        source: "adaptive",
        reason: "Quality day",
        due: [],
        over: [],
      },
      plan_items: [
        { exercise: "Back Squat", muscle_group: "quads", equipment: "barbell", mode: "reps", kind: "strength" },
        {
          exercise: "Threshold Run",
          muscle_group: null,
          equipment: null,
          mode: "reps",
          kind: "cardio",
          target_duration_min: 40,
          target_zone: "threshold",
        },
      ],
    }),
    { now: NOW }
  );

  assert.equal(env.kind, "train");
  assert.equal(env.training_intent.endurance_role, "primary");
  assert.ok(env.muscles.reduced.includes("quads"), "lower groups soft-reduced to protect the key run");
  assert.ok(env.precedence.includes("endurance_lower_conflict"));
  assert.ok(
    env.soft_preferences.some(
      (s) => s.code === "endurance_lower_conflict" && /key[- ]run/i.test(s.detail)
    )
  );
  assert.ok(env.rationale.some((r) => /key endurance|key[- ]run/i.test(r.text)));
  const squat = env.candidates.find((c) => c.exercise === "Back Squat");
  assert.equal(squat.action, "hold", "conflicting lower holds rather than overloads");
  assert.equal(squat.reason_code, "endurance_lower_conflict");
});

test("key-run protection requires an actually open current or next opening", () => {
  const base = {
    training_intent: {
      priorities: ["endurance", "longevity", "strength"],
      endurance_role: "primary",
      source: "explicit",
    },
  };
  const undatedOrCompleted = buildDailySessionDecision(snapshot({ ...base, open_key_run: null }), { now: NOW });
  const laterOpening = buildDailySessionDecision(
    snapshot({
      ...base,
      open_key_run: {
        intent_id: "2031-07-14:quality:1",
        kind: "quality",
        suggested_date: "2031-07-18",
      },
    }),
    { now: NOW }
  );
  assert.ok(!undatedOrCompleted.precedence.includes("endurance_lower_conflict"));
  assert.ok(!laterOpening.precedence.includes("endurance_lower_conflict"));
  assert.notEqual(
    undatedOrCompleted.input_fingerprint,
    laterOpening.input_fingerprint,
    "the compact agenda fact remains part of decision identity even outside today's protection window"
  );
});

test("gathered snapshot stamps compact training_intent for fingerprint stability", () => {
  repo.setProfile({
    primary_discipline: "strength",
    training_intent: {
      priorities: ["muscle", "strength", "longevity"],
      endurance_role: "supporting",
      endurance_capacity: { sport: "running", target_duration_min: 60 },
    },
  });
  seedLowerPlan();
  const a = gatherDailyDecisionSnapshot(DATE);
  const b = gatherDailyDecisionSnapshot(DATE);
  assert.deepEqual(a.training_intent, {
    endurance_role: "supporting",
    priorities: ["muscle", "strength", "longevity"],
    source: "explicit",
  });
  // Capacity free-text must never land on the decision snapshot.
  assert.equal("endurance_capacity" in a.training_intent, false);
  assert.deepEqual(a.training_intent, b.training_intent);
});

test("live gather includes cardio plan items so primary role can soft-protect a key run", () => {
  repo.setProfile({
    primary_discipline: "endurance",
    endurance_sport: "running",
    endurance_goal: {
      mode: "race",
      event: "Autumn 10K",
      date: "2031-10-15",
      distance_km: 10,
      weekly_km: 30,
      weekly_sessions: 4,
    },
    training_intent: {
      priorities: ["endurance", "longevity", "strength"],
      endurance_role: "primary",
    },
  });
  repo.savePlanDay(1, "Hybrid lower + quality", "Legs and threshold", [
    { exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 7, target_weight: 225 },
    {
      exercise: "Threshold Run",
      kind: "cardio",
      target_duration_min: 40,
      target_zone: "threshold",
    },
  ]);
  const generated = repo.weeklyRunPlan(DATE);
  const generatedQuality = generated.runs.find((run) => run.kind_label === "quality");
  assert.ok(generatedQuality, "the authoritative run engine generated a quality intention");
  assert.ok(
    /\bZ[3-5]\b/i.test(String(generatedQuality.target_zone ?? "")) ||
      /tempo|threshold|vo2|interval|hill/i.test(String(generatedQuality.label ?? "")) ||
      (Array.isArray(generatedQuality.interval) && generatedQuality.interval.length > 0),
    "real Z3/Z4-style zone, label, or interval cues identify the generated quality shape"
  );
  const snap = gatherDailyDecisionSnapshot(DATE);
  assert.equal(snap.training_intent.endurance_role, "primary");
  assert.ok(
    snap.plan_items.some((it) => it.kind === "cardio" && /threshold/i.test(String(it.target_zone ?? ""))),
    "cardio template rows must survive gather (label may live in note)"
  );
  assert.equal(snap.open_key_run?.kind, "quality", "generated Z3/Z4 or interval quality shapes come through agenda kind");
  assert.ok(
    [DATE, "2031-07-16"].includes(snap.open_key_run?.suggested_date),
    "only a current/next authoritative opening is relevant to today's protection"
  );
  const env = buildDailySessionDecision(snap, { now: NOW });
  assert.ok(env.muscles.reduced.includes("quads"));
  assert.ok(env.soft_preferences.some((s) => s.code === "endurance_lower_conflict" && /key[- ]run/i.test(s.detail)));
});

test("live gather drops completed and undated key-run intentions from the compact fact", () => {
  repo.setProfile({
    primary_discipline: "endurance",
    endurance_sport: "running",
    endurance_goal: {
      mode: "race",
      event: "Autumn 10K",
      date: "2031-10-15",
      distance_km: 10,
      weekly_km: 30,
      weekly_sessions: 4,
    },
  });
  seedLowerPlan();

  const before = gatherDailyDecisionSnapshot(DATE);
  assert.equal(before.open_key_run?.kind, "quality");
  const quality = repo.weeklyRunPlan(DATE).runs.find((run) => run.kind_label === "quality");
  const activity = repo.addActivity({
    type: "run",
    date: DATE,
    duration_min: 60,
    distance_km: Math.max(8, Number(quality.target_distance_km ?? 0)),
  });
  const source = db
    .prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin', 'decision-intent-quality')`)
    .run();
  db.prepare(
    `INSERT INTO garmin_activities
       (source_id, external_id, activity_id, date, type, te_label, aerobic_te)
     VALUES (?, 'decision-intent-quality', ?, ?, 'running', 'LACTATE_THRESHOLD', 3.6)`
  ).run(source.lastInsertRowid, activity.id, DATE);
  const afterCompletion = gatherDailyDecisionSnapshot(DATE);
  assert.notEqual(
    afterCompletion.open_key_run?.intent_id,
    before.open_key_run.intent_id,
    "the completed quality intention cannot remain the compact open fact"
  );

  resetIntentTables();
  repo.setProfile({
    primary_discipline: "endurance",
    endurance_sport: "running",
    endurance_goal: {
      mode: "race",
      event: "Autumn 10K",
      date: "2031-10-15",
      distance_km: 10,
      weekly_km: 30,
      weekly_sessions: 4,
    },
  });
  seedLowerPlan();
  const sunday = "2031-07-20";
  repo.addActivity({ type: "run", date: sunday, duration_min: 5, distance_km: 0.5 });
  const undated = gatherDailyDecisionSnapshot(sunday);
  const agenda = repo.flexibleTrainingAgenda(sunday);
  assert.ok(
    agenda.intents.some(
      (intent) => intent.status === "open" && intent.kind !== "easy" && intent.suggested_date == null
    ),
    "the live agenda retains unfinished key intent without inventing a catch-up date"
  );
  assert.equal(undated.open_key_run, null, "undated key intentions do not become decision protection facts");
});
