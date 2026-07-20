import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { prepareDailySessionUseCase } from "../dist/domain/training/adaptive-session-use-case.js";
import { db, repo, resetTables } from "./_seed.js";

const DATE = "2031-04-14";

beforeEach(() => {
  resetTables(
    "daily_session_compositions",
    "logged_sets",
    "session_skips",
    "sessions",
    "day_reads",
    "plan_items",
    "plan_days"
  );
});

function seedPlan() {
  repo.savePlanDay(1, "Push + hinge", "Chest and posterior chain", [
    { exercise: "Barbell Bench Press", sets: 4, rep_low: 5, rep_high: 7, target_weight: 185, warmup_sets: 2 },
    { exercise: "Barbell Deadlift", sets: 3, rep_low: 3, rep_high: 5, target_weight: 315, note: "Brace first" },
    {
      kind: "cardio",
      exercise: "Easy run",
      target_duration_min: 25,
      target_distance_km: 4.5,
      target_zone: "Z2",
      interval: { finish: "4 strides" },
    },
  ]);
  repo.savePlanDay(2, "Pull", "Back and arms", [
    { exercise: "Lat Pulldown", sets: 3, rep_low: 8, rep_high: 12, target_weight: 120 },
  ]);
}

function suggestedSession(name = "Chest + deadlift") {
  return {
    name,
    focus: "Chest and hinge",
    why: "Fits the athlete's requested focus today.",
    est_minutes: 30,
    items: [
      { exercise: "Barbell Deadlift", sets: 3, rep_low: 3, rep_high: 5, target_weight: 315, note: "Crisp reps" },
      { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 },
      { exercise: "Pallof Press", sets: 3, rep_low: 10, rep_high: 12, target_weight: null },
    ],
  };
}

function prepare(input) {
  const result = repo.prepareDailySession(input);
  return { ...result, session: repo.getSessionDetail(result.session_id) };
}

function completedSuggestionJob(session = suggestedSession(), input = {}) {
  const job = repo.createAgentJob({ kind: "session_suggest", input: { date: DATE, ...input } });
  return repo.finishAgentJob(job.id, {
    chosen_agent: "codex",
    result: { ok: true, session, agent: "codex", tried: [{ agent: "codex" }] },
  });
}

function prepareAgent(session = suggestedSession(), extra = {}) {
  const job = completedSuggestionJob(session, extra.job_input);
  return prepare({
    date: DATE,
    source: "agent_suggest",
    agent_job_id: job.id,
    replace: extra.replace,
    // These are intentionally ignored in favor of canonical job data.
    session: extra.client_session,
    constraints: extra.client_constraints,
    provenance: extra.client_provenance,
  });
}

test("accepted agent session reloads with the same session id and complete prescribed items", () => {
  seedPlan();
  // Trustworthy recent loads let the guard keep the two known working weights;
  // Pallof Press is new, so its load remains null.
  repo.logSetByName({ date: "2031-04-01", exercise: "Barbell Deadlift", weight: 315, reps: 3, day_number: null });
  repo.logSetByName({ date: "2031-04-02", exercise: "Barbell Bench Press", weight: 185, reps: 6, day_number: null });
  const planBefore = repo.getPlan();

  const prepared = prepareAgent(suggestedSession(), {
    job_input: { minutes: 30, focus: "chest + deadlift" },
    client_session: { name: "spoofed", why: "spoofed", items: [] },
    client_provenance: { agent: "spoofed" },
  });
  const reloaded = repo.getSessionByDate(DATE);
  const direct = repo.getActiveDailySession(DATE);

  assert.equal(prepared.session.id, reloaded.id);
  assert.equal(prepared.daily_session.session_id, reloaded.id);
  assert.deepEqual(reloaded.daily_session.items, prepared.daily_session.items);
  assert.deepEqual(direct.items, prepared.daily_session.items);
  assert.deepEqual(
    direct.items.map((item) => item.exercise),
    ["Barbell Deadlift", "Barbell Bench Press", "Pallof Press"]
  );
  assert.deepEqual(
    direct.items.map((item) => item.target_weight),
    [315, 185, null]
  );
  assert.deepEqual(
    direct.items.map(({ exercise, sets, rep_low, rep_high, target_weight, note }) => ({
      exercise,
      sets,
      rep_low,
      rep_high,
      target_weight,
      note,
    })),
    [
      {
        exercise: "Barbell Deadlift",
        sets: 3,
        rep_low: 3,
        rep_high: 5,
        target_weight: 315,
        note: "Crisp reps",
      },
      {
        exercise: "Barbell Bench Press",
        sets: 3,
        rep_low: 6,
        rep_high: 8,
        target_weight: 185,
        note: null,
      },
      {
        exercise: "Pallof Press",
        sets: 3,
        rep_low: 10,
        rep_high: 12,
        target_weight: null,
        note: null,
      },
    ]
  );
  assert.equal(reloaded.plan_day_id, null);
  assert.deepEqual(direct.constraints, { focus: "chest + deadlift", minutes: 30 });
  assert.equal(direct.provenance.verification, "verified_agent_job");
  assert.equal(direct.provenance.agent, "codex");
  assert.deepEqual(repo.getPlan(), planBefore, "custom preparation never mutates the weekly template");
});

test("adaptive prepare snapshots the selected plan day, keeps cardio fields, and is idempotent", () => {
  seedPlan();
  const otherDay = repo.getPlanDay(2);
  db.prepare(`DELETE FROM plan_items WHERE plan_day_id = ?`).run(otherDay.id);
  db.prepare(`DELETE FROM plan_days WHERE id = ?`).run(otherDay.id);
  const selected = repo.selectedPlanDayForDate(DATE);
  const first = prepare({ date: DATE });
  const second = prepare({ date: DATE, source: "agent_suggest", session: suggestedSession() });

  assert.equal(first.daily_session.source, "adaptive_plan");
  assert.equal(first.daily_session.plan_day_id, selected.plan_day_id);
  assert.equal(first.session.plan_day_id, selected.plan_day_id);
  assert.equal(second.reused, true);
  assert.equal(second.daily_session.id, first.daily_session.id);
  assert.equal(second.session.id, first.session.id);
  const bench = first.daily_session.items.find((item) => item.exercise === "Barbell Bench Press");
  assert.deepEqual(
    {
      sets: bench.sets,
      rep_low: bench.rep_low,
      rep_high: bench.rep_high,
      target_weight: bench.target_weight,
      warmup_sets: bench.warmup_sets,
    },
    { sets: 4, rep_low: 5, rep_high: 7, target_weight: 185, warmup_sets: 2 }
  );
  const cardio = first.daily_session.items.find((item) => item.kind === "cardio");
  assert.deepEqual(
    {
      exercise: cardio.exercise,
      target_duration_min: cardio.target_duration_min,
      target_distance_km: cardio.target_distance_km,
      target_zone: cardio.target_zone,
      interval: cardio.interval,
    },
    {
      exercise: "Easy run",
      target_duration_min: 25,
      target_distance_km: 4.5,
      target_zone: "Z2",
      interval: { finish: "4 strides" },
    }
  );
  repo.logSetByName({ date: DATE, exercise: "Barbell Bench Press", weight: 185, reps: 5, day_number: 1 });
  const replaceRetry = prepare({ date: DATE, source: "adaptive_plan", replace: true });
  assert.equal(replaceRetry.reused, true);
  assert.equal(replaceRetry.daily_session.id, first.daily_session.id);
});

test("explicit day override snapshots that day and links its existing session", () => {
  seedPlan();
  const legacy = repo.getOrCreateSession(DATE, repo.getPlanDay(1).id);
  const prepared = prepare({ date: DATE, source: "manual_plan", day_number: 2 });

  assert.equal(prepared.session.id, legacy.id);
  assert.equal(prepared.daily_session.plan_day_id, repo.getPlanDay(2).id);
  assert.equal(prepared.session.plan_day_id, repo.getPlanDay(2).id);
  assert.equal(prepared.daily_session.items[0].exercise, "Lat Pulldown");
});

test("expected_active_id only returns the matching composition and never mutates history", () => {
  const prepared = prepare({
    date: DATE,
    source: "athlete_override",
    session: { name: "Identity", why: "Cached identity fixture.", items: [{ exercise: "Squat", sets: 3, rep_low: 5 }] },
  });
  const before = db
    .prepare(
      `SELECT id, version, status, superseded_at FROM daily_session_compositions WHERE date = ? ORDER BY version`
    )
    .all(DATE)
    .map((row) => ({ ...row }));

  const direct = repo.prepareDailySession({ date: DATE, expected_active_id: prepared.daily_session.id });
  assert.equal(direct.reused, true);
  assert.equal(direct.daily_session.id, prepared.daily_session.id);
  assert.equal(direct.session_id, prepared.session.id);
  const throughUseCase = prepareDailySessionUseCase({ date: DATE, expected_active_id: prepared.daily_session.id });
  assert.equal(throughUseCase.daily_session.id, prepared.daily_session.id);
  assert.equal(throughUseCase.session.id, prepared.session.id);

  assert.throws(
    () => repo.prepareDailySession({ date: DATE, expected_active_id: prepared.daily_session.id + 1 }),
    (error) => error?.code === "daily_session_changed"
  );
  assert.throws(
    () => repo.prepareDailySession({ date: "2031-04-30", expected_active_id: prepared.daily_session.id }),
    (error) => error?.code === "daily_session_missing"
  );
  const after = db
    .prepare(
      `SELECT id, version, status, superseded_at FROM daily_session_compositions WHERE date = ? ORDER BY version`
    )
    .all(DATE)
    .map((row) => ({ ...row }));
  assert.deepEqual(after, before);
});

test("replacement supersedes history before logging and refuses after logging starts", () => {
  seedPlan();
  const first = prepareAgent(suggestedSession("First"));
  const second = prepare({
    date: DATE,
    source: "athlete_override",
    session: {
      ...suggestedSession("Athlete version"),
      items: [{ exercise: "Overhead Press", sets: 3, rep_low: 5, rep_high: 8 }],
    },
    replace: true,
  });
  const old = db
    .prepare(`SELECT status, superseded_at FROM daily_session_compositions WHERE id = ?`)
    .get(first.daily_session.id);

  assert.equal(second.session.id, first.session.id);
  assert.equal(second.daily_session.version, 2);
  assert.equal(old.status, "superseded");
  assert.ok(old.superseded_at);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM daily_session_compositions WHERE date = ? AND status = 'active'`).get(DATE).n,
    1
  );

  repo.logSetByName(repo.resolveImplicitPlanDay({ date: DATE, exercise: "Overhead Press", weight: 95, reps: 5 }));
  assert.equal(repo.getSessionByDate(DATE).plan_day_id, null, "implicit logging preserves custom provenance");
  assert.throws(() => prepare({ date: DATE, source: "adaptive_plan", replace: true }), /already has logged sets/);
  assert.equal(repo.getActiveDailySession(DATE).id, second.daily_session.id);
});

test("an explicit stale plan day cannot relink a prepared custom session", () => {
  seedPlan();
  repo.savePlanDay(3, "Inherited card day", "Stale weekly provenance", [
    { exercise: "Hammer Curl", sets: 3, rep_low: 8, rep_high: 12 },
  ]);
  const prepared = prepareAgent();

  const logged = repo.logSetByName({
    date: DATE,
    exercise: "Barbell Deadlift",
    weight: 315,
    reps: 3,
    day_number: 3,
  });
  const reloaded = repo.getSessionByDate(DATE);

  assert.equal(logged.session_id, prepared.session.id);
  assert.equal(reloaded.plan_day_id, null);
  assert.equal(reloaded.daily_session.id, prepared.daily_session.id);
});

test("replace retries reuse an exact normalized request before and after the first set", () => {
  seedPlan();
  const session = {
    name: "Open upper",
    why: "Athlete-authored session.",
    ignored_noise: "first",
    items: [{ exercise: "Barbell Bench Press", sets: 3, rep_high: 8, rep_low: 6 }],
  };
  const first = prepare({
    date: DATE,
    source: "athlete_override",
    session,
    constraints: { equipment: "  barbell   only ", minutes: 30 },
    provenance: { click: 1 },
  });
  const beforeSet = prepare({
    date: DATE,
    source: "athlete_override",
    replace: true,
    session: {
      items: [{ rep_low: 6, rep_high: 8, sets: 3, exercise: "Barbell Bench Press", extra: "ignored" }],
      why: "Athlete-authored session.",
      name: "Open upper",
    },
    constraints: { minutes: 30, equipment: "barbell only" },
    provenance: { click: 999, noise: true },
  });
  assert.equal(beforeSet.reused, true);
  assert.equal(beforeSet.daily_session.id, first.daily_session.id);

  repo.logSetByName({ date: DATE, exercise: "Barbell Bench Press", weight: 185, reps: 6, day_number: 1 });
  const afterSet = prepare({
    date: DATE,
    source: "athlete_override",
    replace: true,
    session: {
      why: "Athlete-authored session.",
      name: "Open upper",
      items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8 }],
    },
    constraints: { equipment: "barbell only", minutes: 30 },
  });
  assert.equal(afterSet.reused, true);
  assert.equal(afterSet.daily_session.id, first.daily_session.id);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM daily_session_compositions`).get().n, 1);
  assert.match(
    db.prepare(`SELECT request_fingerprint FROM daily_session_compositions WHERE id = ?`).get(first.daily_session.id)
      .request_fingerprint,
    /^[a-f0-9]{64}$/
  );
});

test("canonical agent-job retry is idempotent after logging starts", () => {
  seedPlan();
  const job = completedSuggestionJob();
  const first = prepare({ date: DATE, source: "agent_suggest", agent_job_id: job.id, replace: true });
  repo.logSetByName({ date: DATE, exercise: "Barbell Deadlift", weight: 315, reps: 3, day_number: 2 });
  const retry = prepare({ date: DATE, source: "agent_suggest", agent_job_id: job.id, replace: true });
  assert.equal(retry.reused, true);
  assert.equal(retry.daily_session.id, first.daily_session.id);
  assert.equal(retry.session.id, first.session.id);
});

test("distinct canonical agent jobs create distinct versions even with identical prescriptions", () => {
  seedPlan();
  const firstJob = completedSuggestionJob();
  const secondJob = completedSuggestionJob();
  const first = prepare({ date: DATE, source: "agent_suggest", agent_job_id: firstJob.id });
  const second = prepare({
    date: DATE,
    source: "agent_suggest",
    agent_job_id: secondJob.id,
    replace: true,
  });
  const retry = prepare({
    date: DATE,
    source: "agent_suggest",
    agent_job_id: secondJob.id,
    replace: true,
  });

  assert.equal(first.daily_session.provenance.agent_job_id, firstJob.id);
  assert.equal(second.reused, false);
  assert.equal(second.daily_session.version, 2);
  assert.equal(second.daily_session.provenance.agent_job_id, secondJob.id);
  assert.notEqual(second.daily_session.id, first.daily_session.id);
  assert.equal(retry.reused, true);
  assert.equal(retry.daily_session.id, second.daily_session.id);
});

test("agent suggestions reject noncanonical, unfinished, and wrong-date jobs", () => {
  const queued = repo.createAgentJob({ kind: "session_suggest", input: { date: DATE } });
  assert.throws(
    () => prepare({ date: DATE, source: "agent_suggest", agent_job_id: queued.id }),
    (error) => error?.code === "agent_job_not_ready"
  );

  const wrongKind = repo.createAgentJob({ kind: "day_read_override", input: { date: DATE } });
  assert.throws(
    () => prepare({ date: DATE, source: "agent_suggest", agent_job_id: wrongKind.id }),
    (error) => error?.code === "agent_job_invalid"
  );

  const wrongDate = completedSuggestionJob(suggestedSession(), { date: "2031-04-13" });
  assert.throws(
    () => prepare({ date: DATE, source: "agent_suggest", agent_job_id: wrongDate.id }),
    (error) => error?.code === "agent_job_date_mismatch"
  );
});

test("duplicate same-date sessions cannot hide meaningful state on a different row", () => {
  seedPlan();
  const empty = db.prepare(`INSERT INTO sessions (date) VALUES (?)`).run(DATE).lastInsertRowid;
  const started = db.prepare(`INSERT INTO sessions (date) VALUES (?)`).run(DATE).lastInsertRowid;
  const exercise = repo.findOrCreateExercise("Duplicate Session Squat");
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, 1, 135, 5)`
  ).run(started, exercise.id);

  assert.throws(
    () => prepare({ date: DATE, source: "manual_plan", day_number: 1 }),
    (error) => error?.code === "daily_session_locked" && /logged sets/.test(error.message)
  );
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM daily_session_compositions`).get().n, 0);
  assert.ok(Number(empty) < Number(started));
});

test("replacement stays on the active composition session even with duplicate empty rows", () => {
  seedPlan();
  const first = prepare({ date: DATE, source: "manual_plan", day_number: 1 });
  db.prepare(`INSERT INTO sessions (date) VALUES (?)`).run(DATE);
  const replacement = prepare({
    date: DATE,
    source: "athlete_override",
    replace: true,
    session: { name: "Open", why: "User chose something else.", items: [] },
  });
  assert.equal(replacement.session.id, first.session.id);
  assert.equal(replacement.daily_session.session_id, first.session.id);
});

test("date reads and logging prefer the active composition's session over an earlier duplicate", () => {
  seedPlan();
  const earlier = Number(db.prepare(`INSERT INTO sessions (date) VALUES (?)`).run(DATE).lastInsertRowid);
  const owned = Number(db.prepare(`INSERT INTO sessions (date) VALUES (?)`).run(DATE).lastInsertRowid);
  db.prepare(
    `INSERT INTO daily_session_compositions
       (version, session_id, date, source, status, title, items_json, request_fingerprint)
     VALUES (1, ?, ?, 'athlete_override', 'active', 'Owned session', '[]', ?)`
  ).run(owned, DATE, "a".repeat(64));

  assert.equal(repo.getSessionByDate(DATE).id, owned);
  const logged = repo.logSetByName({
    date: DATE,
    exercise: "Barbell Bench Press",
    weight: 185,
    reps: 6,
    day_number: 1,
  });
  assert.equal(logged.session_id, owned);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM logged_sets WHERE session_id = ?`).get(earlier).n, 0);
  assert.equal(repo.getSessionByDate(DATE).plan_day_id, null);
});

test("skip and undo target the active composition session across duplicate legacy rows", () => {
  seedPlan();
  const earlier = Number(db.prepare(`INSERT INTO sessions (date) VALUES (?)`).run(DATE).lastInsertRowid);
  const owned = Number(db.prepare(`INSERT INTO sessions (date) VALUES (?)`).run(DATE).lastInsertRowid);
  db.prepare(
    `INSERT INTO daily_session_compositions
       (version, session_id, date, source, status, title, items_json, request_fingerprint)
     VALUES (1, ?, ?, 'athlete_override', 'active', 'Owned session', '[]', ?)`
  ).run(owned, DATE, "b".repeat(64));
  db.prepare(`INSERT INTO session_skips (session_id, exercise) VALUES (?, 'Earlier-row decoy')`).run(earlier);

  const skipped = repo.skipExercise("Barbell Bench Press", DATE);
  const undone = repo.unskipExercise("Barbell Bench Press", DATE);

  assert.equal(skipped.session_id, owned);
  assert.equal(undone.session_id, owned);
  assert.equal(undone.removed, 1);
  assert.deepEqual(undone.skips, []);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM session_skips WHERE session_id = ?`).get(owned).n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM session_skips WHERE session_id = ?`).get(earlier).n, 1);
});

test("finished and skipped session evidence lock a different replacement", () => {
  seedPlan();
  const finished = prepare({ date: DATE, source: "manual_plan", day_number: 1 });
  repo.finishSession(finished.session.id, null);
  assert.throws(
    () =>
      prepare({
        date: DATE,
        source: "athlete_override",
        replace: true,
        session: { name: "Different", why: "Changed", items: [] },
      }),
    /finished session/
  );

  const otherDate = "2031-04-15";
  const skipped = prepare({ date: otherDate, source: "manual_plan", day_number: 1 });
  repo.skipExercise("Barbell Bench Press", otherDate);
  assert.throws(
    () =>
      prepare({
        date: otherDate,
        source: "athlete_override",
        replace: true,
        session: { name: "Different", why: "Changed", items: [] },
      }),
    /session skips/
  );
  assert.ok(skipped.session.id);
});

test("unrelated cardio does not lock strength, while matching prepared cardio does", () => {
  seedPlan();
  prepare({
    date: DATE,
    source: "athlete_override",
    session: {
      name: "Strength",
      why: "Lift today.",
      items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6 }],
    },
  });
  repo.addActivity({ date: DATE, type: "run", duration_min: 25, distance_km: 4.5, text: "Easy run" });
  const changed = prepare({
    date: DATE,
    source: "athlete_override",
    replace: true,
    session: {
      name: "Other strength",
      why: "Changed before lifting.",
      items: [{ exercise: "Lat Pulldown", sets: 3, rep_low: 8 }],
    },
  });
  assert.equal(changed.daily_session.version, 2);

  const cardioDate = "2031-04-16";
  prepare({
    date: cardioDate,
    source: "athlete_override",
    session: {
      name: "Run",
      why: "Aerobic work.",
      items: [{ kind: "cardio", exercise: "Easy run", target_duration_min: 30, target_distance_km: 5 }],
    },
  });
  repo.addActivity({ date: cardioDate, type: "run", duration_min: 31, distance_km: 5.1, text: "Easy run" });
  assert.throws(
    () =>
      prepare({
        date: cardioDate,
        source: "athlete_override",
        replace: true,
        session: { name: "Open", why: "Changed", items: [] },
      }),
    /matching cardio work/
  );
});

test("strength item mode and target normalization is coherent", () => {
  repo.upsertExercise({ name: "Known Timer", mode: "timed" });
  repo.upsertExercise({ name: "Known Reps", mode: "reps" });
  const prepared = prepare({
    date: DATE,
    source: "athlete_override",
    session: {
      name: "Modes",
      why: "Test prescriptions.",
      items: [
        { exercise: "Known Timer", sets: 2, target_seconds: 45 },
        { exercise: "Unknown Timer", sets: 2, target_seconds: 30 },
        { exercise: "Target reps", sets: 2, target_reps: 8 },
      ],
    },
  });
  assert.deepEqual(
    prepared.daily_session.items.map(({ mode, rep_low, rep_high, target_seconds }) => ({
      mode,
      rep_low,
      rep_high,
      target_seconds,
    })),
    [
      { mode: "timed", rep_low: null, rep_high: null, target_seconds: 45 },
      { mode: "timed", rep_low: null, rep_high: null, target_seconds: 30 },
      { mode: "reps", rep_low: 8, rep_high: 8, target_seconds: null },
    ]
  );

  for (const session of [
    { items: [{ exercise: "Known Reps", mode: "timed", sets: 2, target_seconds: 30 }] },
    { items: [{ exercise: "No reps", sets: 2 }] },
    { items: [{ exercise: "No seconds", mode: "timed", sets: 2 }] },
  ]) {
    assert.throws(
      () =>
        prepare({
          date: "2031-04-17",
          source: "athlete_override",
          session: { name: "Invalid", why: "Invalid prescription.", ...session },
        }),
      /mode conflicts|positive rep target|target_seconds must be positive/
    );
  }
});

test("athlete override may deliberately open an empty session but adaptive plan may not", () => {
  const open = prepare({ date: DATE, source: "athlete_override", session: { items: [] } });
  assert.equal(open.daily_session.title, "Open session");
  assert.deepEqual(open.daily_session.items, []);

  const otherDate = "2031-04-18";
  repo.savePlanDay(1, "Empty template", null, []);
  assert.throws(() => prepare({ date: otherDate, source: "adaptive_plan" }), /session items are required/);
});

test("trust boundary rejects malformed payloads and bounds untrusted fields", () => {
  seedPlan();
  assert.throws(() => repo.prepareDailySession({ date: "2031-02-31" }), /valid calendar date/);
  assert.throws(
    () =>
      repo.prepareDailySession({
        date: DATE,
        source: "athlete_override",
        session: { name: "Bad", items: [{ exercise: "Run", kind: "cardio" }] },
      }),
    /needs a duration or distance/
  );
  assert.throws(
    () => repo.prepareDailySession({ date: DATE, source: "unknown", session: suggestedSession() }),
    /unsupported/
  );

  assert.throws(
    () => repo.prepareDailySession({ date: DATE, source: "agent_suggest", session: suggestedSession() }),
    /requires a completed session-suggest agent_job_id.*athlete_override/
  );

  const result = prepare({
    date: DATE,
    source: "athlete_override",
    provenance: JSON.parse('{"safe":"yes","__proto__":"drop","prototype":"drop","constructor":"drop"}'),
    session: {
      name: "x".repeat(500),
      focus: "y".repeat(500),
      why: "z".repeat(2000),
      est_minutes: 99999,
      items: [
        {
          exercise: "Brand New Lift",
          sets: 999,
          rep_low: 500,
          rep_high: 5,
          target_weight: null,
          note: "n".repeat(2000),
        },
        { kind: "cardio", exercise: "Long outing", target_duration_min: 999 },
      ],
    },
  });
  const item = result.daily_session.items[0];
  assert.equal(result.daily_session.title.length, 120);
  assert.equal(result.daily_session.focus.length, 160);
  assert.equal(result.daily_session.why.length, 600);
  assert.equal(result.daily_session.est_minutes, 360);
  assert.equal(item.sets, 20);
  assert.deepEqual([item.rep_low, item.rep_high], [5, 100]);
  assert.equal(item.target_weight, null);
  assert.equal(item.note.length, 500);
  assert.equal(result.daily_session.items[1].target_duration_min, 360);
  assert.deepEqual(result.daily_session.provenance, { safe: "yes" });
});

test("legacy sessions still read and log with an additive null daily_session", () => {
  seedPlan();
  const logged = repo.logSetByName({
    date: DATE,
    exercise: "Barbell Bench Press",
    weight: 175,
    reps: 6,
    day_number: 1,
  });
  const session = repo.getSessionDetail(logged.session_id);
  assert.equal(session.daily_session, null);
  assert.equal(session.sets.length, 1);
  assert.equal(session.plan_day_id, repo.getPlanDay(1).id);
});
