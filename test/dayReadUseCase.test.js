import assert from "node:assert/strict";
import test from "node:test";
import { readToday, recordDayReadSuggestion } from "../dist/domain/brain/day-read-use-case.js";
import { configureDayReadRefresh, resetDayReadRefresh } from "../dist/dayread-refresh.js";
import { buildDayReadPrompt } from "../dist/prompt.js";
import { runWithBrainSnapshot } from "../dist/brain/snapshot.js";
import { DAY_READ_HEADLINE_VARIANTS } from "../dist/repo/day-read.js";
import { db, localDaysAgo, repo, resetTables } from "./_seed.js";

const countDayReads = (date) =>
  db.prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE kind='day_read' AND date=?`).get(date).n;

test("readToday serves cached canonical Brief with context and records it once", async () => {
  resetTables("day_reads", "suggestions", "plan_days", "plan_items", "sessions", "logged_sets");
  const date = localDaysAgo(0);
  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });
  const baseline = repo.dayRead(date);
  repo.saveDayRead(date, {
    ...baseline,
    headline: baseline.kind === "train" ? "Train today." : "Easy today.",
    source: "deterministic",
    override: null,
  });

  const first = await readToday({ date, recordOutcome: true });
  const second = await readToday({ date, recordOutcome: true });

  assert.equal(first.cached, true);
  assert.equal(first.kind, baseline.kind);
  assert.equal(first.forward, null);
  assert.ok(first.arc === null || typeof first.arc === "string");
  assert.equal(typeof first.agent_status, "string");
  assert.equal(typeof first.input_fingerprint, "string");
  assert.equal(typeof first.decision?.rule_code, "string");
  assert.ok(first.periodization_context);
  assert.deepEqual(second.signals, baseline.signals);
  assert.equal(countDayReads(date), 1);
});

test("a legacy cached row self-heals once against the complete decision fingerprint", async () => {
  resetTables("day_reads", "suggestions", "plan_days", "plan_items", "sessions", "logged_sets", "program_blocks");
  const date = localDaysAgo(0);
  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  db.prepare(
    `INSERT INTO day_reads
      (date, kind, headline, why, focus, est_minutes, signals, source, override, computed_at)
     VALUES (?, 'rest', 'Rest today.', 'Legacy broad-context copy.', NULL, NULL, '{}', 'agent', NULL, datetime('now'))`
  ).run(date);

  const healed = await readToday({ date });
  const stable = await readToday({ date });

  assert.equal(healed.kind, "train");
  assert.equal(healed.cached, undefined);
  assert.equal(healed.decision.basis, "deterministic");
  assert.match(healed.input_fingerprint, /^[a-f0-9]{24}$/);
  assert.equal(stable.cached, true, "the healed metadata prevents endless same-date churn");
  assert.equal(stable.input_fingerprint, healed.input_fingerprint);
});

test("material truth replaces a stale persisted athlete steer once, then remains stable", async () => {
  resetTables(
    "day_reads",
    "suggestions",
    "checkins",
    "plan_days",
    "plan_items",
    "sessions",
    "logged_sets",
    "program_blocks"
  );
  const date = localDaysAgo(0);
  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const baseline = repo.dayRead(date);
  repo.saveDayRead(date, {
    ...baseline,
    kind: "easy",
    headline: "Take it easy.",
    why: "You asked for an easier day.",
    focus: null,
    est_minutes: 20,
    source: "agent",
    override: "give me an easy day",
  });
  const steered = repo.getCachedDayRead(date);
  assert.equal(steered.override, "give me an easy day");

  // Bypass the normal write-side invalidator to exercise readToday's factual
  // compare-and-replace path, matching a late/racing provider write.
  db.prepare(
    `INSERT INTO checkins (date, mood, energy, sleep_feel, soreness, note)
     VALUES (?, 2, 1, 2, 4, 'run down')`
  ).run(date);

  const healed = await readToday({ date });
  const persistedAfterHeal = repo.getCachedDayRead(date);
  const stable = await readToday({ date });

  assert.equal(healed.kind, "rest");
  assert.equal(healed.cached, undefined);
  assert.equal(persistedAfterHeal.override, null, "only the now-stale steer is cleared");
  assert.notEqual(healed.input_fingerprint, steered.input_fingerprint);
  assert.equal(stable.cached, true, "the reconciled row does not refresh on every read");
  assert.equal(stable.input_fingerprint, healed.input_fingerprint);
  assert.equal(stable.computed_at, healed.computed_at, "a stable second read does not churn computed_at");
});

test("Today context keeps the calendar block and recovery overlay as separate clocks", async () => {
  resetTables(
    "day_reads",
    "suggestions",
    "plan_days",
    "plan_items",
    "sessions",
    "logged_sets",
    "program_blocks",
    "plan_proposals",
    "app_state"
  );
  const date = localDaysAgo(0);
  const appliedOn = localDaysAgo(2);
  const block = repo.createBlock({
    goal: "Build squat + aerobic durability",
    focus: "strength",
    phase: "accumulation",
    week_index: 3,
    total_weeks: 6,
    started_at: `${localDaysAgo(14)}T08:00:00.000Z`,
  });
  const proposal = repo.createProposal("stub", repo.RECOVERY_WEEK_INSTRUCTION, "", {
    summary: "Reduced recovery prescription.",
    days: [],
  });
  repo.setProposalStatus(proposal.id, "applied");
  repo.setAppState("recovery_week_applied", JSON.stringify({ applied_on: appliedOn, proposal_id: proposal.id }));
  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });
  const baseline = repo.dayRead(date);
  repo.saveDayRead(date, {
    ...baseline,
    headline: baseline.focus ? `${baseline.focus}.` : "Today.",
    source: "deterministic",
    override: null,
  });

  const read = await readToday({ date });
  const context = read.periodization_context;

  assert.deepEqual(context.program_block, {
    goal: block.goal,
    focus: "strength",
    stored_phase: "accumulation",
    effective_phase: "deload",
    week_index: 3,
    total_weeks: 6,
    started_at: block.started_at,
    counter_basis: "calendar_program_block",
  });
  assert.deepEqual(context.recovery_overlay, {
    applied_on: appliedOn,
    until: repo.activeRecoveryWeek(date).until,
    day_index: 3,
    total_days: 7,
    proposal_id: proposal.id,
    label: "reduced volume",
  });
  assert.equal("parsed" in context.recovery_overlay, false, "raw proposal JSON never crosses the read boundary");
  assert.equal(typeof read.arc === "string" || read.arc === null, true, "the old arc remains additive compatibility");
});

test("a recovery_cycles-only row drives both Today context and the reduced Session prescription", async (t) => {
  resetTables(
    "day_reads",
    "suggestions",
    "plan_days",
    "plan_items",
    "sessions",
    "logged_sets",
    "exercises",
    "program_blocks",
    "plan_proposals",
    "app_state",
    "daily_session_compositions",
    "recovery_cycles",
    "daily_metrics",
    "garmin_daily_metrics",
    "checkins",
    "activities",
    "garmin_activities",
    "context_events"
  );
  t.after(() => {
    resetDayReadRefresh();
    resetTables("day_reads", "daily_session_compositions", "recovery_cycles", "app_state");
  });
  const date = localDaysAgo(0);
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads" });
  repo.savePlanDay(1, "Lower", "Lower body", [
    { exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 5, target_weight: 200 },
  ]);
  const cycle = repo.scheduleRecoveryCycle({
    effective_on: localDaysAgo(1),
    recheck_on: localDaysAgo(-5),
    exit_on: localDaysAgo(-6),
    overlay: { working_set_fraction: 0.5 },
    reason: "A planned lighter week.",
  });
  repo.activateRecoveryCycle(cycle.id, date);
  assert.equal(
    db.prepare(`SELECT value FROM app_state WHERE key = 'recovery_week_applied'`).get(),
    undefined,
    "the fixture has no legacy recovery-week stamp"
  );

  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });
  const baseline = repo.dayRead(date);
  repo.saveDayRead(date, {
    ...baseline,
    headline: baseline.focus ? `${baseline.focus}.` : "Today.",
    source: "deterministic",
    override: null,
  });
  const read = await readToday({ date });
  assert.equal(read.signals.recovery_week.cycle_id, cycle.id, "Today reads the canonical recovery cycle");
  assert.equal(read.periodization_context.recovery_overlay.cycle_id, cycle.id);
  assert.equal(read.periodization_context.recovery_overlay.proposal_id, null);
  assert.match(read.why, /lighter|recovery|reduced/i, "the Brief voices the planned reduced shape");

  const prepared = repo.prepareDailySession({ date, source: "adaptive_plan", train_anyway: true });
  assert.equal(prepared.daily_session.decision.recovery_cycle.id, cycle.id);
  assert.equal(prepared.daily_session.items[0].sets, 2, "the Session applies the same cycle's set fraction");
  assert.ok(
    prepared.daily_session.items[0].target_weight < 200,
    "the same cycle eases the prescribed load without coupling the test to the exact conservative clamp"
  );
});

test("a cached deterministic Brief arms one self-healing re-warm without extending it on every read", async () => {
  resetTables("day_reads", "suggestions", "plan_days", "plan_items", "sessions", "logged_sets");
  const date = localDaysAgo(0);
  let armed = 0;
  configureDayReadRefresh({
    today: () => date,
    setTimer: () => {
      armed += 1;
      return 0;
    },
    clearTimer: () => {},
  });
  const baseline = repo.dayRead(date);
  repo.saveDayRead(date, {
    ...baseline,
    headline: baseline.kind === "train" ? "Train today." : "Cairn's safe baseline.",
    why: baseline.why,
    source: "deterministic",
    override: null,
  });

  const first = await readToday({ date });
  const second = await readToday({ date });

  assert.equal(first.cached, true);
  assert.equal(second.cached, true);
  assert.equal(armed, 1, "screen re-renders must not keep pushing the recovery retry farther away");
});

test("recordDayReadSuggestion dedupes canonical reads but keeps override reads distinct", () => {
  resetTables("suggestions");
  const date = localDaysAgo(0);

  recordDayReadSuggestion(date, { kind: "train", focus: "Lower body", est_minutes: 60 }, null);
  recordDayReadSuggestion(date, { kind: "train", focus: "Lower body", est_minutes: 60 }, null);
  assert.equal(countDayReads(date), 1);

  recordDayReadSuggestion(date, { kind: "easy", focus: null, est_minutes: 25 }, "rough night");
  recordDayReadSuggestion(date, { kind: "easy", focus: null, est_minutes: 25 }, "short on time");
  assert.equal(countDayReads(date), 3);
});

test("recordDayReadSuggestion's dedup guard recognizes a canonical row even with a different JSON key order", () => {
  // The guard now checks json_extract(payload_json, '$.override') IS NULL instead
  // of a payload_json LIKE '%"override":null%' substring match, precisely so a
  // differently-serialized (but semantically identical) canonical payload still
  // dedupes — a legacy row, or one written by a future caller that assembles the
  // payload object with a different key order, must not silently defeat the guard.
  resetTables("suggestions");
  const date = localDaysAgo(0);
  db.prepare(`INSERT INTO suggestions (kind, date, payload_json) VALUES ('day_read', ?, ?)`).run(
    date,
    JSON.stringify({ override: null, est_minutes: 60, kind: "train", focus: "Lower body" })
  );
  assert.equal(countDayReads(date), 1);
  recordDayReadSuggestion(date, { kind: "train", focus: "Lower body", est_minutes: 60 }, null);
  assert.equal(countDayReads(date), 1, "reordered keys still dedupe — no duplicate row inserted");
});

test("recordDayReadSuggestion's dedup guard survives a pretty-printed (whitespace-formatted) canonical payload", () => {
  // The old payload_json LIKE '%"override":null%' substring guard was silently
  // defeated by ANY whitespace change in the serialized payload — a pretty-printed
  // JSON.stringify(x, null, 2) never contains the literal substring '"override":null'
  // with no space after the colon, so the old guard would have re-inserted a
  // duplicate canonical row here. json_extract(payload_json, '$.override') has no
  // such fragility. This is the sharpest evidence for the swap; pin it as a
  // permanent regression rather than leaving it as a one-off proof.
  resetTables("suggestions");
  const date = localDaysAgo(0);
  db.prepare(`INSERT INTO suggestions (kind, date, payload_json) VALUES ('day_read', ?, ?)`).run(
    date,
    JSON.stringify({ kind: "train", focus: "Lower body", est_minutes: 60, override: null }, null, 2)
  );
  assert.equal(countDayReads(date), 1);
  recordDayReadSuggestion(date, { kind: "train", focus: "Lower body", est_minutes: 60 }, null);
  assert.equal(countDayReads(date), 1, "a pretty-printed canonical payload still dedupes — no duplicate row inserted");
});

test("a live completed run overrides stale cached prospective copy immediately", async () => {
  resetTables(
    "day_reads",
    "suggestions",
    "activities",
    "plan_days",
    "plan_items",
    "sessions",
    "logged_sets",
    "profile"
  );
  const date = localDaysAgo(0);
  repo.setProfile({ primary_discipline: "hybrid" });
  repo.saveDayRead(date, {
    kind: "train",
    headline: "Easy long run.",
    why: "A conversational run fits today.",
    focus: "Long",
    est_minutes: 25,
    signals: { logged_today: { sets: 0, activities: [] } },
    source: "agent",
    override: null,
  });
  // Simulate a late provider write racing an older warm: the row exists while the
  // prospective cache is still present. readToday must let the activity fact win.
  db.prepare(
    `INSERT INTO activities (date, type, duration_min, distance_km, source) VALUES (?, 'run', 30, 5, 'garmin')`
  ).run(date);

  const read = await readToday({ date, recordOutcome: true });

  assert.equal(read.kind, "done");
  // The headline rotates by calendar day like the rest of the Brief's vocabulary (it
  // was the last unrotated literal, and the most prominent string on the card), so this
  // pins the whole registered set rather than the phrasing that lands today.
  assert.ok(
    DAY_READ_HEADLINE_VARIANTS.done.includes(read.headline),
    `unexpected done headline ${JSON.stringify(read.headline)}`
  );
  assert.equal(read.focus, null);
  assert.equal(read.est_minutes, null);
  assert.equal(read.cached, undefined);
  assert.match(read.why, /\brun\b/i);
});

test("a materially harder live run replaces stale done copy that still calls it easy", async () => {
  resetTables(
    "day_reads",
    "suggestions",
    "activities",
    "plan_days",
    "plan_items",
    "sessions",
    "logged_sets",
    "profile"
  );
  const date = localDaysAgo(0);
  repo.setProfile({ primary_discipline: "hybrid" });
  db.prepare(
    `INSERT INTO activities (date, type, duration_min, distance_km, source) VALUES (?, 'run', 30, 5, 'garmin')`
  ).run(date);
  repo.saveDayRead(date, {
    kind: "done",
    headline: "Run complete.",
    why: "That run keeps your easy rhythm ticking along.",
    focus: null,
    est_minutes: null,
    signals: {
      logged_today: { sets: 0, activities: [{ type: "run" }] },
      trained_today: true,
      today_load: "moderate",
    },
    source: "agent",
    override: null,
  });

  const read = await readToday({ date });

  assert.equal(read.kind, "done");
  assert.equal(read.signals.today_load, "moderate");
  assert.equal(read.source, "deterministic");
  assert.equal(read.cached, undefined);
  assert.match(read.why, /\brun\b/i);
  assert.doesNotMatch(read.why, /easy rhythm/i);
  assert.equal(repo.getCachedDayRead(date)?.signals?.today_load, "moderate");
});

test("future easy-work advice survives the completed-load consistency guard", async () => {
  resetTables(
    "day_reads",
    "suggestions",
    "activities",
    "plan_days",
    "plan_items",
    "sessions",
    "logged_sets",
    "profile"
  );
  const date = localDaysAgo(0);
  repo.setProfile({ primary_discipline: "hybrid" });
  db.prepare(
    `INSERT INTO activities (date, type, duration_min, distance_km, source) VALUES (?, 'run', 30, 5, 'garmin')`
  ).run(date);
  const baseline = repo.dayRead(date);
  repo.saveDayRead(date, {
    ...baseline,
    headline: "Tempo work complete.",
    why: "That run was a solid moderate effort. Keep tomorrow's run easy so it can settle.",
    source: "agent",
    override: null,
  });

  const read = await readToday({ date });

  assert.equal(read.cached, true);
  assert.equal(read.source, "agent");
  assert.match(read.why, /tomorrow's run easy/i);
});

test("the factual race-fix save arms a background agentic re-warm (never pins floor prose)", async () => {
  resetTables(
    "day_reads",
    "suggestions",
    "activities",
    "plan_days",
    "plan_items",
    "sessions",
    "logged_sets",
    "profile"
  );
  const date = localDaysAgo(0);
  repo.setProfile({ primary_discipline: "hybrid" });
  let armed = 0;
  configureDayReadRefresh({
    today: () => date,
    setTimer: () => {
      armed += 1;
      return 0;
    },
    clearTimer: () => {},
  });
  repo.saveDayRead(date, {
    kind: "train",
    headline: "Easy long run.",
    why: "A conversational run fits today.",
    focus: "Long",
    est_minutes: 25,
    signals: { logged_today: { sets: 0, activities: [] } },
    source: "agent",
    override: null,
  });
  db.prepare(
    `INSERT INTO activities (date, type, duration_min, distance_km, source) VALUES (?, 'run', 30, 5, 'garmin')`
  ).run(date);

  const read = await readToday({ date });

  assert.equal(read.kind, "done");
  assert.equal(read.source, "deterministic");
  assert.ok(armed >= 1, "the debounced background re-warm must be armed so the warm DONE debrief still arrives");
});

test("an unchanged Garmin re-sync leaves the cached day read alone; a material change retires it", () => {
  resetTables("day_reads", "suggestions", "activities", "garmin_activities", "garmin_sources");
  const date = localDaysAgo(0);
  const input = { external_id: "act-1", date, type: "running", name: "Morning run", duration_min: 40, distance_km: 8 };

  repo.upsertGarminActivity(input); // first sight — a new fact, invalidation is correct
  repo.saveDayRead(date, {
    kind: "done",
    headline: "You're done for today.",
    why: "Solid run in — recover well.",
    focus: null,
    est_minutes: null,
    signals: { logged_today: { sets: 0, activities: ["run"] } },
    source: "agent",
    override: null,
  });

  repo.upsertGarminActivity(input); // the 6-hour auto-sync re-upserting the same effort
  assert.ok(repo.getCachedDayRead(date), "an unchanged re-sync must not clear the cached Brief");

  repo.upsertGarminActivity({ ...input, duration_min: 55 }); // provider enriched the effort
  assert.equal(repo.getCachedDayRead(date), null, "a materially changed effort must retire the cached read");
});

test("a lunch that meets the protein target heals a cached 'behind' fuel read", async () => {
  resetTables(
    "day_reads",
    "suggestions",
    "food_notes",
    "profile",
    "bodyweight_log",
    "nutrition_targets",
    "plan_days",
    "plan_items",
    "sessions",
    "logged_sets"
  );
  const date = localDaysAgo(0);
  let armed = 0;
  configureDayReadRefresh({
    today: () => date,
    setTimer: () => {
      armed += 1;
      return 0;
    },
    clearTimer: () => {},
  });
  // A complete-enough profile so a protein target derives (maintain → ~162 g).
  repo.setProfile({
    age: 40,
    height_cm: 178,
    weight_lb: 180,
    sex: "male",
    activity_factor: 1.5,
    goal_mode: "maintain",
  });
  // This morning's cached read said protein was light. Nothing else has moved.
  repo.saveDayRead(date, {
    kind: "train",
    headline: "Train today.",
    why: "You're recovered and due.",
    focus: "Lower body",
    est_minutes: 60,
    signals: {
      fuel: { bucket: "behind", protein_so_far_g: 20, target_g: 162 },
      logged_today: { sets: 0, activities: [] },
    },
    source: "agent",
    override: null,
  });
  // A protein-dense lunch lands — the live fuel bucket is now 'met' (target-independent
  // of the clock), so the cached 'behind' must no longer pin.
  db.prepare(
    `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status) VALUES (?, 'lunch', '', ?, 'done')`
  ).run(date, JSON.stringify({ summary: "chicken & rice", protein_g: 170, kcal: 700 }));

  const read = await readToday({ date });

  assert.equal(read.source, "deterministic", "a fuel-bucket flip retires the stale cached prose");
  assert.equal(read.cached, undefined);
  assert.equal(read.signals.fuel.bucket, "met", "the healed factual row carries the fresh bucket");
  assert.equal(repo.getCachedDayRead(date)?.signals?.fuel?.bucket, "met");
  assert.ok(armed >= 1, "a background agentic re-warm is armed so the DONE/updated prose still arrives");
});

test("a pre-deploy cached read with no fuel signal is never churned by the fuel recheck", async () => {
  resetTables(
    "day_reads",
    "suggestions",
    "food_notes",
    "profile",
    "bodyweight_log",
    "nutrition_targets",
    "plan_days",
    "plan_items",
    "sessions",
    "logged_sets"
  );
  const date = localDaysAgo(0);
  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });
  repo.setProfile({
    age: 40,
    height_cm: 178,
    weight_lb: 180,
    sex: "male",
    activity_factor: 1.5,
    goal_mode: "maintain",
  });
  // A row cached before this feature existed: signals carry NO fuel key.
  const liveShape = repo.dayRead(date);
  const { fuel: _liveFuel, ...signalsWithoutFuel } = liveShape.signals;
  repo.saveDayRead(date, {
    ...liveShape,
    headline: liveShape.kind === "train" ? "Train today." : "Easy today.",
    why: "The visible cached read predates fuel context.",
    signals: signalsWithoutFuel,
    source: "agent",
    override: null,
    input_fingerprint: undefined,
  });
  const saved = repo.getCachedDayRead(date);
  db.prepare(
    `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status) VALUES (?, 'lunch', '', ?, 'done')`
  ).run(date, JSON.stringify({ summary: "chicken & rice", protein_g: 170, kcal: 700 }));

  const first = await readToday({ date });
  const second = await readToday({ date });

  assert.equal(first.cached, true, "a missing cached fuel signal must read as no-change, not a flip");
  assert.equal(first.source, "agent");
  assert.equal(first.input_fingerprint, saved.input_fingerprint);
  assert.equal(second.cached, true, "the compatibility read remains stable on the next open");
  assert.equal(second.input_fingerprint, saved.input_fingerprint);
  assert.equal(second.computed_at, saved.computed_at, "live fuel does not churn the legacy row's timestamp");
});

test("a done read still carries the day-ahead forward line (the so-what after the work)", async () => {
  resetTables(
    "day_reads",
    "suggestions",
    "activities",
    "plan_days",
    "plan_items",
    "sessions",
    "logged_sets",
    "profile"
  );
  const date = localDaysAgo(0);
  repo.setProfile({ primary_discipline: "hybrid" });
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
  ]);
  repo.savePlanDay(2, "Pull", "Back", [{ exercise: "Row", sets: 3, rep_low: 8, rep_high: 12, target_weight: 135 }]);
  db.prepare(
    `INSERT INTO activities (date, type, duration_min, distance_km, source) VALUES (?, 'run', 30, 5, 'garmin')`
  ).run(date);

  const read = await readToday({ date });

  assert.equal(read.kind, "done");
  assert.equal(read.focus, null, "done never carries a same-day prescription");
  assert.match(String(read.forward || ""), /Next: /, "the forward line names tomorrow's lean");
});

test("a curated Brief survives the first open instead of being overwritten by the floor", async () => {
  resetTables("day_reads", "suggestions", "plan_days", "plan_items", "sessions", "logged_sets", "profile");
  const date = localDaysAgo(0);
  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });
  // A real plan exists, so the live deterministic read is a plain "train" floor.
  repo.savePlanDay(1, "Pull", "Pull — back, rear delts, biceps", [
    { exercise: "Row", sets: 3, rep_low: 8, rep_high: 12, target_weight: 135 },
  ]);
  // The demo seed's hand-authored Brief: warm prose over ILLUSTRATIVE signals, so
  // no live recompute can ever reproduce its fingerprint.
  const curated = {
    kind: "train",
    headline: "A strong, controlled Pull day.",
    why: "You slept just under 7 hours and your HRV's back in range — recovered and due.",
    focus: "Pull — back, rear delts, biceps",
    est_minutes: 55,
    signals: { consecutive_training_days: 0, has_recovery_data: true },
    source: "agent",
    agent: "claude",
    curated: true,
  };
  assert.equal(repo.saveDayRead(date, curated), true);

  const first = await readToday({ date });
  const second = await readToday({ date });

  for (const read of [first, second]) {
    assert.equal(read.cached, true, "a curated read is served as written");
    assert.equal(read.source, "agent");
    assert.equal(read.headline, curated.headline);
    assert.equal(read.why, curated.why);
    assert.equal(read.est_minutes, 55);
  }
  assert.equal(repo.getCachedDayRead(date).headline, curated.headline, "and it is still curated in the cache");

  // A canonical recompute cannot quietly clobber it either...
  assert.equal(repo.saveDayRead(date, { ...repo.dayRead(date), source: "deterministic", override: null }), false);
  assert.equal(repo.getCachedDayRead(date).headline, curated.headline);
  // ...but the explicit retire path still works.
  repo.invalidateDayRead(date);
  assert.equal(repo.getCachedDayRead(date), null);
});

test("a recovery-metrics-only sync does not churn a warm agentic read", async () => {
  resetTables(
    "day_reads",
    "suggestions",
    "plan_days",
    "plan_items",
    "sessions",
    "logged_sets",
    "daily_metrics",
    "profile"
  );
  const date = localDaysAgo(0);
  let armed = 0;
  configureDayReadRefresh({
    today: () => date,
    setTimer: () => {
      armed += 1;
      return 0;
    },
    clearTimer: () => {},
  });
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  // Last night already synced: a perfectly ordinary 7h20m night.
  repo.recordDailyMetrics("apple", localDaysAgo(1), { sleep_min: 440, hrv: 62, resting_hr: 52 });

  const baseline = repo.dayRead(date);
  repo.saveDayRead(date, {
    ...baseline,
    headline: "Lower body.",
    why: "You're recovered and due — bar speed honest, stop a rep shy.",
    source: "agent",
    agent: "claude",
    override: null,
  });
  const warm = await readToday({ date });
  assert.equal(warm.cached, true);
  assert.equal(warm.source, "agent");
  armed = 0; // ignore the arming that plan/metric seeding above already did

  // The 6-hourly watch sync lands: sleep, HRV and resting HR all move a little.
  // Nothing crosses a threshold the day-read branches on. Through the REAL write
  // path — recordDailyMetrics used to DELETE the cached row outright, so the warm
  // agentic read was gone long before the serve-time fingerprint comparison could
  // protect it. Both halves have to hold for the athlete to keep their sentence.
  repo.recordDailyMetrics("apple", localDaysAgo(1), { sleep_min: 452, hrv_ms: 58, resting_hr: 54 });

  assert.ok(repo.getCachedDayRead(date), "the write itself must not retire the read");

  const after = await readToday({ date });

  assert.equal(after.cached, true, "telemetry noise must not retire a warm agentic read");
  assert.equal(after.source, "agent");
  assert.equal(after.why, warm.why);
  assert.equal(after.input_fingerprint, warm.input_fingerprint);
  assert.equal(armed, 0, "and nothing needed re-warming");
  assert.equal(repo.getCachedDayRead(date).source, "agent");
});

test("recovery data that DOES move the decision still retires the cached read", async () => {
  resetTables(
    "day_reads",
    "suggestions",
    "plan_days",
    "plan_items",
    "sessions",
    "logged_sets",
    "daily_metrics",
    "profile"
  );
  const date = localDaysAgo(0);
  let armed = 0;
  configureDayReadRefresh({
    today: () => date,
    setTimer: () => {
      armed += 1;
      return 0;
    },
    clearTimer: () => {},
  });
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  repo.recordDailyMetrics("apple", localDaysAgo(1), { sleep_min: 440 });
  const baseline = repo.dayRead(date);
  assert.equal(baseline.kind, "train");
  repo.saveDayRead(date, {
    ...baseline,
    headline: "Lower body.",
    why: "You're recovered and due.",
    source: "agent",
    agent: "claude",
    override: null,
  });
  armed = 0;

  // Last night comes in at five hours — a predicate the rules genuinely branch on.
  repo.recordDailyMetrics("apple", localDaysAgo(1), { sleep_min: 300 });

  assert.equal(repo.getCachedDayRead(date), null, "a real change must still bust the Brief");
  assert.equal(armed, 1, "and arm the background re-warm");
  const after = await readToday({ date });
  assert.equal(after.kind, "rest");
});

// ---------------------------------------------------------------------------
// The rich/thin seam. buildDayReadPrompt used to compute its OWN baseline from
// the coach context's signal state, while computeDayRead clamped, persisted and
// fingerprinted a DIFFERENT baseline it had computed itself — so on a divergent
// day the agent was shown one state and the server acted on another. Two things
// close it, and both are pinned here: the caller threads its baseline in
// (the only thing that works on the scheduler's warm, which runs outside any
// request scope), and inside a request there is ONE memoized signal state per
// date, so every consumer that recomputes still lands on the same one.
// ---------------------------------------------------------------------------

test("the prompt's baseline is the caller's baseline, not a second one", () => {
  resetTables("day_reads", "plan_days", "plan_items", "sessions", "logged_sets", "daily_metrics", "profile");
  const date = localDaysAgo(0);
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  repo.recordDailyMetrics("apple", localDaysAgo(1), { sleep_min: 440 });

  const live = repo.dayRead(date);
  assert.equal(live.kind, "train");

  // A baseline that deliberately disagrees with anything the prompt could derive
  // on its own. If the prompt still re-derives, this string can never appear.
  const threaded = { ...live, kind: "rest", focus: null };
  const prompt = buildDayReadPrompt(undefined, { date, baseline: threaded });
  assert.match(prompt, /A rules-only baseline suggested: kind="rest"/);
  assert.ok(
    !/A rules-only baseline suggested: kind="train"/.test(prompt),
    "the prompt must not describe a baseline the server will never clamp or persist"
  );
});

test("one signal state per date per request — the Brief and the coach share it", () => {
  resetTables("day_reads", "plan_days", "plan_items", "sessions", "logged_sets", "daily_metrics", "profile");
  const date = localDaysAgo(0);
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  repo.recordDailyMetrics("apple", localDaysAgo(1), { sleep_min: 440 });

  runWithBrainSnapshot(() => {
    const first = repo.dayRead(date);
    const context = repo.getCoachContext();
    const second = repo.dayRead(date);
    assert.equal(
      first.signals.signal_state,
      context.signal_state,
      "the athlete-facing read and the coach context must be the same object, not two builds"
    );
    assert.equal(second.signals.signal_state, first.signals.signal_state);
    assert.equal(second.input_fingerprint, first.input_fingerprint);
  });
});
