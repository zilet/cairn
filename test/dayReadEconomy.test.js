// Day-read RECOMPUTE ECONOMY. Every day_read recompute spawns a coaching CLI, so an
// invalidation that isn't a real change costs the athlete an agent call and writes a
// brain_decisions row that says nothing new. One live evening produced ten-plus
// day_read recomputes between 20:30 and 23:45 — roughly one every two or three
// minutes, on a day whose read was already terminal ("done") — because the decision
// fingerprint hashed the raw logged-set COUNT and every logged set DELETED the cached
// row outright, before that fingerprint was ever consulted.
//
// Three things stop it, and all three are pinned here:
//   - the fingerprint moves only on decision-relevant change (set 12 → 13 cannot;
//     the evening run appearing still does)
//   - the training-log writes go through the GUARDED invalidation, which compares
//     POST-write state even when a request has already warmed the signal-state memo
//   - concurrent recomputes for one date share ONE lane, so a cold cache does not
//     turn a burst of opens into a burst of agent calls
import assert from "node:assert/strict";
import test from "node:test";
import { readToday } from "../dist/domain/brain/day-read-use-case.js";
import { computeCanonicalDayRead } from "../dist/dayread.js";
import { configureDayReadRefresh, flushDayReadRefresh, scheduleDayReadRefresh } from "../dist/dayread-refresh.js";
import { runWithBrainSnapshot } from "../dist/brain/snapshot.js";
import { evaluateMatureExpectations } from "../dist/brainEvaluator.js";
import { db, localDaysAgo, repo, resetTables } from "./_seed.js";

const TRAINING_TABLES = [
  "day_reads",
  "suggestions",
  "plan_days",
  "plan_items",
  "sessions",
  "logged_sets",
  "activities",
  "daily_metrics",
  "brain_decisions",
];

// ---------------------------------------------------------------------------
// The projection itself (pure — no DB, no clock).
// ---------------------------------------------------------------------------

const REF = "2026-05-14";

// A day already read as done: a real session on the board, hard grade, nothing else
// in play. `sets` and `activities` are the two fields the projection reduces.
const doneDay = (sets, activities = []) => ({
  kind: "done",
  focus: null,
  signals: {
    today_load: "hard",
    trained_today: true,
    recent_load: [{ date: "2026-05-13", load: "easy" }],
    logged_today: { sets, activities },
  },
});

const fingerprint = (read) => repo.dayReadInputFingerprint(REF, read);

test("another set of a session already read as done cannot move the fingerprint", () => {
  const twelve = fingerprint(doneDay(12));
  for (const count of [13, 14, 20, 31]) {
    assert.equal(fingerprint(doneDay(count)), twelve, `set ${count} is the same day, not a new decision`);
  }
  // The one thing the set COUNT still has to say is whether any set exists at all —
  // the fact that the athlete has started training today.
  assert.notEqual(fingerprint(doneDay(0)), twelve, "0 → 1 sets is a genuinely different day");
});

test("a re-synced effort rewritten by a hair does not move the fingerprint", () => {
  const run = (duration_min, distance_km) => doneDay(12, [{ type: "running", duration_min, distance_km }]);
  const first = fingerprint(run(44, 8.02));

  assert.equal(fingerprint(run(45, 8.03)), first, "a provider re-sync is not a new decision");
  assert.equal(fingerprint(run(43, 7.98)), first);

  // Order is not a decision either — the source query orders by row id, which moves
  // when an earlier effort is corrected or re-imported.
  const walk = { type: "walk", duration_min: 25, distance_km: 1.8 };
  const both = (...list) => doneDay(12, list);
  assert.equal(
    fingerprint(both({ type: "running", duration_min: 44, distance_km: 8.02 }, walk)),
    fingerprint(both(walk, { type: "running", duration_min: 44, distance_km: 8.02 }))
  );

  // A genuinely different effort still moves it.
  assert.notEqual(fingerprint(run(70, 13.4)), first, "a long run is not the same effort as a 8 km one");
  // So does the evening run APPEARING on a day that had none...
  assert.notEqual(fingerprint(doneDay(12)), first, "a new activity must still retire the morning read");
  // ...and a second effort landing beside the first.
  assert.notEqual(fingerprint(both({ type: "running", duration_min: 44, distance_km: 8.02 }, walk)), first);
});

test("the day's load GRADE still moves the fingerprint", () => {
  const graded = (today_load) => fingerprint({ ...doneDay(12), signals: { ...doneDay(12).signals, today_load } });
  const seen = new Set(["none", "easy", "moderate", "hard"].map(graded));
  assert.equal(seen.size, 4, "each grade is its own decision — that is where logged volume enters the hash");
});

test("recovery-dose bookkeeping is not a decision, but the grade and an overdose are", () => {
  const yesterday = (load, recovery_dose) => ({
    ...doneDay(12),
    signals: { ...doneDay(12).signals, recent_load: [{ date: "2026-05-13", load, ...(recovery_dose ? { recovery_dose } : {}) }] },
  });
  const compliant = fingerprint(
    yesterday("moderate", [
      { session_id: 4, classification: "compliant", volume_ratio: 0.94, median_rir: 4, reason: "held to the reduced plan" },
    ])
  );

  assert.equal(
    fingerprint(
      yesterday("moderate", [
        {
          session_id: 4,
          classification: "compliant",
          volume_ratio: 0.97,
          median_rir: 3,
          reason: "held to the reduced plan, one extra back-off set",
        },
      ])
    ),
    compliant,
    "a re-derived ratio and a re-worded reason are the same decision"
  );
  assert.notEqual(
    fingerprint(yesterday("moderate", [{ session_id: 4, classification: "overdose", volume_ratio: 1.6 }])),
    compliant,
    "an overdose is what the recovery_dose_overrun rule actually branches on"
  );
  assert.notEqual(fingerprint(yesterday("hard")), fingerprint(yesterday("easy")), "and each day's own grade still counts");
});

// ---------------------------------------------------------------------------
// The real write path.
// ---------------------------------------------------------------------------

// A fake timer that only COUNTS. The debounce keeps at most one live timer, so
// `armed` is the number of times a background recompute was (re)armed, and
// `pending` is how many are actually outstanding.
function armCounter() {
  const state = { armed: 0, cleared: 0, live: new Set(), seq: 0 };
  return {
    state,
    hooks: {
      setTimer: () => {
        state.armed += 1;
        state.seq += 1;
        state.live.add(state.seq);
        return state.seq;
      },
      clearTimer: (id) => {
        state.cleared += 1;
        state.live.delete(id);
      },
    },
  };
}

// Six near-failure sets of a loaded compound: tonnage 6750 across 6 hard sets, which
// dayLoad grades `hard` — the ceiling, so further identical sets cannot raise it.
function logHardSession(date, sets = 6) {
  for (let i = 0; i < sets; i++) {
    repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date });
  }
}

function seedPlan() {
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Back Squat", sets: 5, rep_low: 5, rep_high: 5 }]);
}

function warmAgenticRead(date, read) {
  repo.saveDayRead(date, {
    ...read,
    headline: "You're done for today.",
    why: "Squats are in and they moved well — refuel and let it settle.",
    source: "agent",
    agent: "claude",
    override: null,
  });
  return repo.getCachedDayRead(date);
}

test("a burst of sets on a day already read as done costs ZERO recomputes", () => {
  resetTables(...TRAINING_TABLES);
  const date = localDaysAgo(0);
  const timer = armCounter();
  configureDayReadRefresh({ today: () => date, ...timer.hooks });
  seedPlan();
  logHardSession(date);

  const baseline = repo.dayRead(date);
  assert.equal(baseline.kind, "done", "fixture check: a loaded session makes the day terminal");
  const warm = warmAgenticRead(date, baseline);
  assert.equal(warm.source, "agent");
  timer.state.armed = 0;

  // The evening continues: ten more sets through the REAL write path.
  logHardSession(date, 10);

  const after = repo.getCachedDayRead(date);
  assert.ok(after, "the warm agentic read must survive a burst on an already-terminal day");
  assert.equal(after.source, "agent", "and it is still the coach's sentence, not the deterministic floor");
  assert.equal(after.why, warm.why);
  assert.equal(after.input_fingerprint, warm.input_fingerprint);
  assert.equal(timer.state.armed, 0, "no background recompute was armed at all — 10 sets, 0 agent calls");
});

test("but the FIRST set of the day still retires the read and arms one recompute", () => {
  resetTables(...TRAINING_TABLES);
  const date = localDaysAgo(0);
  const timer = armCounter();
  configureDayReadRefresh({ today: () => date, ...timer.hooks });
  seedPlan();

  const baseline = repo.dayRead(date);
  assert.equal(baseline.kind, "train", "fixture check: a blank day");
  warmAgenticRead(date, baseline);
  timer.state.armed = 0;

  repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date });

  assert.equal(repo.getCachedDayRead(date), null, "starting to train is a fact the morning read has to give way to");
  assert.equal(timer.state.armed, 1, "and exactly one background re-warm is armed");
});

test("deleting the LAST set of a done day retires the read and arms one recompute", () => {
  resetTables(...TRAINING_TABLES);
  const date = localDaysAgo(0);
  const timer = armCounter();
  configureDayReadRefresh({ today: () => date, ...timer.hooks });
  seedPlan();

  // One heavy top set: 3150 lb of tonnage grades the day `moderate`, which alongside a
  // logged session is enough to make the read terminal.
  const only = repo.logSetByName({ exercise: "Deadlift", weight: 315, reps: 10, rir: 2, date });
  assert.equal(repo.dayRead(date).kind, "done", "fixture check: one heavy set is a day's work");
  warmAgenticRead(date, repo.dayRead(date));
  timer.state.armed = 0;

  repo.deleteSet(only.id);

  assert.equal(
    repo.getCachedDayRead(date),
    null,
    "a done read must not survive on a day whose only logged work has been removed"
  );
  assert.equal(timer.state.armed, 1, "and exactly one background re-warm is armed");
  assert.notEqual(repo.dayRead(date).kind, "done", "the day is open again");
});

test("deleting one of several sets arms nothing", () => {
  resetTables(...TRAINING_TABLES);
  const date = localDaysAgo(0);
  const timer = armCounter();
  configureDayReadRefresh({ today: () => date, ...timer.hooks });
  seedPlan();

  // Ten hard sets — 11250 lb of tonnage, clear of the `hard` threshold on both sides of
  // a single deletion, so the day's grade cannot move underneath the test.
  logHardSession(date, 10);
  const sets = db
    .prepare(`SELECT ls.id FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id WHERE s.date = ? ORDER BY ls.id`)
    .all(date);
  assert.equal(sets.length, 10);
  const warm = warmAgenticRead(date, repo.dayRead(date));
  timer.state.armed = 0;

  repo.deleteSet(sets[0].id);

  const after = repo.getCachedDayRead(date);
  assert.ok(after, "a mistyped set removed from a session is a correction, not a new decision");
  assert.equal(after.source, "agent");
  assert.equal(after.why, warm.why);
  assert.equal(after.input_fingerprint, warm.input_fingerprint);
  assert.equal(timer.state.armed, 0);
});

test("a Garmin re-sync of an effort already on the board does not retire the read; a new one does", () => {
  resetTables(...TRAINING_TABLES, "garmin_activities", "garmin_sources");
  const date = localDaysAgo(0);
  const timer = armCounter();
  configureDayReadRefresh({ today: () => date, ...timer.hooks });
  seedPlan();

  repo.upsertGarminActivity({
    external_id: "evening-run",
    date,
    type: "run",
    name: "Evening run",
    duration_min: 44,
    distance_km: 8.02,
  });
  const warm = warmAgenticRead(date, repo.dayRead(date));
  timer.state.armed = 0;

  // The provider re-syncs the SAME effort, landing a hair differently. `material` in
  // upsertGarminActivity compares raw columns and says yes; the banded fingerprint
  // says no, and the fingerprint is what now decides.
  repo.upsertGarminActivity({
    external_id: "evening-run",
    date,
    type: "run",
    name: "Evening run",
    duration_min: 45,
    distance_km: 8.03,
  });
  assert.ok(repo.getCachedDayRead(date), "a re-sync of an effort already on the board is not a new decision");
  assert.equal(repo.getCachedDayRead(date).why, warm.why);
  assert.equal(timer.state.armed, 0);

  // A different effort entirely.
  repo.upsertGarminActivity({
    external_id: "evening-walk",
    date,
    type: "walk",
    name: "Evening walk",
    duration_min: 30,
    distance_km: 2.4,
  });
  assert.equal(repo.getCachedDayRead(date), null, "a second, different effort must reach the Brief");
  assert.ok(timer.state.armed >= 1, "and it arms the background re-warm");
});

test("the guard compares POST-write state even when the request memo is already warm", () => {
  resetTables(...TRAINING_TABLES);
  const date = localDaysAgo(0);
  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });
  seedPlan();
  warmAgenticRead(date, repo.dayRead(date));

  // Every real set-logging request builds the unified signal state before it writes
  // (the route reads, reconciles, then logs). That state is memoized per (date,
  // request) — so a guard that compared it as-is would be reading the PRE-write world
  // and would conclude, forever, that nothing had moved.
  runWithBrainSnapshot(() => {
    repo.dayRead(date); // warms signal_state / training_signals / program_state
    repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date });
    assert.equal(
      repo.getCachedDayRead(date),
      null,
      "a guard reading the stale request snapshot would have pinned a Brief that is now wrong"
    );
  });
});

// ---------------------------------------------------------------------------
// The economy applies to the READ CACHE only — never to re-judging a closed day.
// ---------------------------------------------------------------------------

const dayExpectation = (date) =>
  db
    .prepare(
      `SELECT expectation.id AS id, expectation.status AS status
         FROM brain_expectations expectation
         JOIN brain_decisions decision ON decision.id = expectation.decision_id
        WHERE decision.kind = 'day_read' AND decision.source_ref_key = ?
        ORDER BY expectation.id DESC LIMIT 1`
    )
    .get(date);

// Three light sets: 600 lb of tonnage at RIR 8 grades `easy`, so the day is logged
// but not terminal — which is what leaves a PREDICTIVE read (and therefore a
// falsifiable expectation) behind. A fourth set of the same keeps it under every
// threshold, so the decision fingerprint cannot move.
function logLightSession(date, sets) {
  for (let i = 0; i < sets; i++) {
    repo.logSetByName({ exercise: "Band Pull-Apart", weight: 20, reps: 10, rir: 8, date });
  }
}

test("a late set on an already-judged PAST day re-opens the verdict even though the fingerprint holds", () => {
  resetTables(...TRAINING_TABLES, "brain_expectations", "brain_evaluations");
  const date = localDaysAgo(2);
  const timer = armCounter();
  configureDayReadRefresh({ today: () => localDaysAgo(0), ...timer.hooks });
  seedPlan();
  logLightSession(date, 3);

  // Save the live read, so the cached row's fingerprint matches what a recompute
  // produces — the precondition for the guard's early return — and so the ledger
  // gets a real decision + expectation through the production path.
  const judged = repo.dayRead(date);
  repo.saveDayRead(date, { ...judged, source: "agent", agent: "claude", override: null });
  const expectation = dayExpectation(date);
  assert.ok(expectation, "precondition: a predictive read leaves a falsifiable expectation");

  // The nightly sweep matures and closes it.
  evaluateMatureExpectations(localDaysAgo(0));
  assert.equal(dayExpectation(date).status, "evaluated", "precondition: the day has been judged");

  const fingerprintBefore = repo.getCachedDayRead(date).input_fingerprint;

  // A missed set is added to that day two days later — a Garmin sync landing late, or
  // a correction. It moves the RAW logged-set count, which is exactly what the
  // adherence verdict was reached from, and moves nothing the decision fingerprint
  // still looks at.
  logLightSession(date, 1);

  const cached = repo.getCachedDayRead(date);
  assert.ok(cached, "the read-cache economy still applies — the warm read survives");
  assert.equal(cached.input_fingerprint, fingerprintBefore, "and the fingerprint genuinely did not move");
  assert.equal(
    dayExpectation(date).status,
    "pending",
    "but the verdict must be re-opened: gating this on the fingerprint turns a diverged day into a stale aligned one"
  );
});

// ---------------------------------------------------------------------------
// The scheduler: a signal that lands mid-flight.
// ---------------------------------------------------------------------------

// Let the scheduler's own awaits (the agent gate) settle without a real clock.
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a signal landing DURING a recompute arms exactly one follow-up, not a second stacked run", async () => {
  const date = localDaysAgo(0);
  let release;
  let recomputes = 0;
  const timer = {
    armed: 0,
    fns: [],
    set(fn) {
      this.armed += 1;
      this.fns.push(fn);
      return this.fns.length;
    },
    clear() {},
  };
  configureDayReadRefresh({
    today: () => date,
    setTimer: (fn) => timer.set(fn),
    clearTimer: (id) => timer.clear(id),
    agentsAvailable: () => true,
    recompute: () =>
      new Promise((resolve) => {
        recomputes += 1;
        release = resolve;
      }),
  });

  scheduleDayReadRefresh(date);
  assert.equal(timer.armed, 1);
  timer.fns[0](); // the debounce fires
  await tick(); // ...and the agent gate resolves, so the recompute is genuinely in flight

  // Three more signals arrive while the agent is still working.
  scheduleDayReadRefresh(date);
  scheduleDayReadRefresh(date);
  scheduleDayReadRefresh(date);
  assert.equal(timer.armed, 1, "nothing is armed on top of a run that is already reading this state");
  assert.equal(recomputes, 1);

  release();
  await flushDayReadRefresh();

  assert.equal(timer.armed, 2, "the run landing arms exactly ONE follow-up for what arrived mid-flight");
  assert.equal(recomputes, 1, "and nothing ran until that follow-up's own debounce fires");
});

test("a run that lands with nothing waiting leaves the scheduler free, not suppressed", async () => {
  const date = localDaysAgo(0);
  const timer = { armed: 0, fns: [] };
  let recomputes = 0;
  configureDayReadRefresh({
    today: () => date,
    setTimer: (fn) => {
      timer.armed += 1;
      timer.fns.push(fn);
      return timer.fns.length;
    },
    clearTimer: () => {},
    agentsAvailable: () => true,
    recompute: () => {
      recomputes += 1;
    },
  });

  scheduleDayReadRefresh(date);
  timer.fns[0]();
  await flushDayReadRefresh();
  assert.equal(recomputes, 1);
  assert.equal(timer.armed, 1, "a quiet run arms no follow-up of its own");

  // There is deliberately no time cooldown: the next genuine change arms immediately.
  scheduleDayReadRefresh(date);
  assert.equal(timer.armed, 2, "a genuinely new fingerprint change is never suppressed by a recent run");
});

// ---------------------------------------------------------------------------
// One canonical recompute per date at a time.
// ---------------------------------------------------------------------------

// Every agent disabled: computeDayRead falls to the deterministic floor without
// spawning a CLI, which keeps this offline and fast. The lane is what's under test,
// not what the agent says.
function offlineAgents() {
  repo.setSettings({ disabled_agents: ["claude", "codex", "antigravity", "grok", "stub"] });
}

test("concurrent canonical recomputes for one date share ONE lane", async () => {
  resetTables(...TRAINING_TABLES);
  offlineAgents();
  const date = localDaysAgo(0);
  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });
  seedPlan();

  const first = computeCanonicalDayRead({ date });
  const second = computeCanonicalDayRead({ date });
  assert.equal(second, first, "the second caller joins the run in flight instead of spawning a second agent call");

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b, "and both get the same read");

  const later = computeCanonicalDayRead({ date });
  assert.notEqual(later, first, "once a run lands the lane is free again");
  await later;
});

test("an explicit refresh runs its own recompute but still publishes the lane", async () => {
  resetTables(...TRAINING_TABLES);
  offlineAgents();
  const date = localDaysAgo(0);
  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });
  seedPlan();

  const background = computeCanonicalDayRead({ date });
  const forced = computeCanonicalDayRead({ date, force: true });
  assert.notEqual(forced, background, "an athlete asking for a new read is not answered by a run that predates them");

  const behind = computeCanonicalDayRead({ date });
  assert.equal(behind, forced, "and anything arriving behind the refresh joins it rather than adding a third");
  await Promise.all([background, forced, behind]);
});

test("a cache-miss open joins the recompute already in flight", async () => {
  resetTables(...TRAINING_TABLES);
  offlineAgents();
  const date = localDaysAgo(0);
  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });
  seedPlan();
  assert.equal(repo.dayRead(date).kind, "train");

  // The background re-warm an invalidation arms starts against a blank day...
  const warming = computeCanonicalDayRead({ date });
  // ...and before it lands, a full session goes in. A SECOND compute started now
  // would read `done`, so the kind is a sharp discriminator for which one ran.
  logHardSession(date);
  assert.equal(repo.dayRead(date).kind, "done", "fixture check: a fresh compute would now disagree");

  const open = await readToday({ date });
  const warmed = await warming;

  assert.equal(open.kind, warmed.kind);
  assert.equal(open.kind, "train", "the open joined the run in flight rather than paying for a second one");
});

// ---------------------------------------------------------------------------
// The whole evening, end to end.
// ---------------------------------------------------------------------------

test("open → set → open → open on a done day arms nothing and spends nothing", async () => {
  resetTables(...TRAINING_TABLES);
  offlineAgents();
  const date = localDaysAgo(0);
  const timer = armCounter();
  let recomputes = 0;
  configureDayReadRefresh({
    today: () => date,
    ...timer.hooks,
    agentsAvailable: () => true,
    recompute: () => {
      recomputes += 1;
    },
  });
  seedPlan();
  logHardSession(date);
  const warm = warmAgenticRead(date, repo.dayRead(date));
  timer.state.armed = 0;

  const opened = await readToday({ date, recordOutcome: true });
  assert.equal(opened.cached, true);
  repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date });
  const again = await readToday({ date, recordOutcome: true });
  const third = await readToday({ date, recordOutcome: true });

  for (const read of [opened, again, third]) {
    assert.equal(read.source, "agent", "every open serves the same warm agentic read");
    assert.equal(read.why, warm.why);
  }
  assert.equal(timer.state.armed, 0, "nothing about the evening moved the decision");
  assert.equal(recomputes, 0);
  const ledgerRows = db
    .prepare(`SELECT COUNT(*) AS n FROM brain_decisions WHERE kind = 'day_read' AND source_ref_key = ?`)
    .get(date).n;
  assert.equal(ledgerRows, 1, "and the ledger holds ONE decision for the day, not one per set");
});

test("a deterministic reconciliation does not re-arm itself on every subsequent open", async () => {
  resetTables(...TRAINING_TABLES);
  offlineAgents();
  const date = localDaysAgo(0);
  const timer = armCounter();
  configureDayReadRefresh({
    today: () => date,
    ...timer.hooks,
    // No usable agent: the floor is what stays cached, which is exactly the state the
    // self-healing re-warm exists for — and exactly where a pump would hide.
    agentsAvailable: () => false,
  });
  seedPlan();

  // A cached row that has fallen behind reality — the shape a warm read written
  // before an unsynced session lands takes. The first open must reconcile it to the
  // deterministic factual read and arm one background re-warm.
  const morning = repo.dayRead(date);
  logHardSession(date);
  warmAgenticRead(date, morning);
  timer.state.armed = 0;

  const reconciled = await readToday({ date });
  assert.equal(reconciled.kind, "done");
  assert.equal(reconciled.source, "deterministic");
  const armedAfterReconcile = timer.state.armed;
  assert.ok(armedAfterReconcile >= 1, "the floor is served instantly, with a re-warm pending behind it");

  const second = await readToday({ date });
  const third = await readToday({ date });
  assert.equal(second.cached, true);
  assert.equal(third.cached, true);
  assert.equal(timer.state.armed, armedAfterReconcile, "later opens must not each arm another recompute");
  assert.equal(timer.state.live.size, 1, "exactly one re-warm is outstanding");
});

// ---------------------------------------------------------------------------
// The LEDGER economy: an invalidation that reaches the same call costs no row.
// ---------------------------------------------------------------------------

// The read cache and the decision ledger were paying the same tax from opposite
// directions. The cache stopped churning once the fingerprint banded its inputs — but
// the ledger kept hashing those inputs, so any invalidation that DID get through (a
// wearable sync, a fuel bucket) still wrote a fresh immutable decision, superseded the
// morning's, and cancelled the falsifiable prediction riding on it. The fingerprint now
// hashes the CLAIM, so a recompute that agrees with the morning is free on both sides.

const dayDecisionCount = (date) =>
  Number(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM brain_decisions
          WHERE kind = 'day_read' AND source_ref_type = 'day_read' AND source_ref_key = ?`
      )
      .get(date).n
  );

test("mid-day invalidations that reach the same call grow the ledger by ZERO", async () => {
  resetTables(...TRAINING_TABLES, "brain_expectations", "brain_evaluations", "garmin_daily_metrics", "daily_metrics");
  const date = localDaysAgo(0);
  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });
  seedPlan();

  const baseline = repo.dayRead(date);
  warmAgenticRead(date, baseline);
  const kind = baseline.kind;
  const before = dayDecisionCount(date);
  assert.equal(before, 1, "precondition: the morning read is one row");
  const expectationBefore = dayExpectation(date);

  // Eight wearable syncs across the day — each one genuinely invalidates the cached
  // Brief and forces a real recompute. None of them changes what the day is FOR.
  for (let n = 0; n < 8; n++) {
    repo.upsertGarminDailyMetric({ date, sleep_min: 400 + n, resting_hr: 50 + (n % 3) });
    const recomputed = await readToday({ date });
    assert.equal(recomputed.kind, kind, "fixture check: the recompute must reach the same call");
  }

  assert.equal(dayDecisionCount(date), before, "eight recomputes, zero new immutable observations");
  const expectationAfter = dayExpectation(date);
  if (expectationBefore) {
    assert.equal(Number(expectationAfter.id), Number(expectationBefore.id), "the same question, not a new one");
    assert.equal(expectationAfter.status, "pending", "and it is still being asked");
  }
});
