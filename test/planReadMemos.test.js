// The cross-request memo layer over the three heaviest deterministic reads on the Today
// open — getPlan (repo/plan.ts), programAdjustments (repo/progression.ts) and the bare
// form of dayRead (repo/day-read.ts). Each follows getProgramState's pattern: a cheap
// signature key, a registered clear, and a value that is never allowed to outlive the
// data it was computed from. These lock the half that matters — INVALIDATION. A memo
// that serves a stale plan tells the athlete a prescription that is no longer theirs.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { applyProposalWithAutonomy } from "../dist/domain/brain/autonomy-service.js";
import { localDateISO } from "../dist/repo/shared.js";

beforeEach(() => {
  resetTables(
    "brain_expectations",
    "brain_rollbacks",
    "brain_decisions",
    "day_reads",
    "daily_session_outcomes",
    "daily_session_decisions",
    "daily_session_compositions",
    "logged_sets",
    "sessions",
    "activities",
    "plan_proposals",
    "plan_items",
    "plan_days",
    "exercises"
  );
});

const today = () => localDateISO();

function seedPlan(weight = 135) {
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Memo Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: weight },
  ]);
}

/** Run `fn`, returning [value, statements executed] — the memo-hit proof. */
function counted(fn) {
  let n = 0;
  const orig = db.prepare.bind(db);
  db.prepare = (sql) => {
    const st = orig(sql);
    for (const m of ["get", "all", "run", "iterate"]) {
      const inner = st[m].bind(st);
      st[m] = (...args) => {
        n++;
        return inner(...args);
      };
    }
    return st;
  };
  try {
    return [fn(), n];
  } finally {
    db.prepare = orig;
  }
}

function planTarget(plan) {
  return plan[0]?.items?.[0]?.target_weight ?? null;
}

function planSets(plan) {
  return plan[0]?.items?.[0]?.sets ?? null;
}

test("getPlan serves a memo hit for an unchanged plan, at a handful of statements", () => {
  seedPlan();
  const [first] = counted(() => repo.getPlan());
  const [second, statements] = counted(() => repo.getPlan());
  assert.deepEqual(second, first, "the hit equals the first computation");
  assert.ok(statements <= 5, `a memo hit should cost only the signature, got ${statements} statements`);
});

test("a plan edit is visible to the very next getPlan", () => {
  seedPlan(135);
  assert.equal(planTarget(repo.getPlan()), 135);
  seedPlan(150);
  assert.equal(planTarget(repo.getPlan()), 150, "the memo did not outlive the plan it described");
});

test("a logged set is visible to the very next programAdjustments", () => {
  seedPlan();
  // Twice, because the FIRST read of a cold process writes as it goes (a stamp, a
  // reconciliation row) and so invalidates its own key; from the second on, an
  // unchanged repeat must cost only the signature.
  repo.programAdjustments();
  const before = repo.programAdjustments();
  const [, statements] = counted(() => repo.programAdjustments());
  assert.ok(statements <= 8, `an unchanged repeat should hit the memo, got ${statements} statements`);

  repo.logSetByName({ exercise: "Memo Bench Press", weight: 135, reps: 8, rir: 2, date: today() });
  const after = repo.programAdjustments();
  assert.notDeepEqual(after, before, "the logged set reached the next read");
});

test("a logged set is visible to the very next bare dayRead", () => {
  seedPlan();
  repo.dayRead(today()); // see the note above: the first read of a cold process writes
  const before = repo.dayRead(today());
  assert.equal(Number(before.signals?.logged_today?.sets ?? 0), 0, "nothing logged yet");
  const [, statements] = counted(() => repo.dayRead(today()));
  assert.ok(statements <= 8, `an unchanged repeat should hit the memo, got ${statements} statements`);

  repo.logSetByName({ exercise: "Memo Bench Press", weight: 135, reps: 8, rir: 2, date: today() });
  const after = repo.dayRead(today());
  assert.ok(Number(after.signals?.logged_today?.sets ?? 0) > 0, "the memo did not hide the logged work");
});

test("a call that overrides an input never reads the bare form's memo", () => {
  seedPlan();
  repo.dayRead(today());
  const bare = repo.dayRead(today());
  assert.equal(repo.dayRead(today()), bare, "the bare form shares one build while nothing changes");

  // A caller-supplied view is that caller's own; it must never be served from — or
  // written into — the shared slot.
  const overridden = repo.dayRead(today(), { has_data: false });
  assert.notEqual(overridden, bare, "the override form recomputed instead of reading the memo");
  assert.equal(repo.dayRead(today()), bare, "and it left the bare form's build in place");
});

test("an applied proposal's accountability reaches the next getPlan", () => {
  seedPlan();
  repo.logSetByName({ exercise: "Memo Bench Press", weight: 135, reps: 8, rir: 2, date: today() });
  assert.equal(repo.getPlan()[0].items[0].brain_decision_id, undefined, "nothing applied yet");

  const proposal = repo.createProposal("stub", "memo invalidation", "", {
    summary: "Step this up.",
    changes: [
      {
        day_number: 1,
        exercise: "Memo Bench Press",
        target_weight: 140,
        reason: "The work supports a small step.",
      },
    ],
  });
  const applied = applyProposalWithAutonomy(proposal.id, {
    requested_tier: "quiet_apply",
    explicit_user_request: true,
  });
  assert.equal(applied.applied.length, 1);

  // The decision row is INSERTed and then rewritten in place (patchBrainDecision fills
  // action_json once the changes are walked), so a count/max-only key would serve the
  // pre-apply map here and the athlete would see a step with no "why" attached.
  const item = repo.getPlan()[0].items[0];
  assert.equal(item.target_weight, 140, "the new prescription is on the plan");
  assert.ok(Number(item.brain_decision_id) > 0, "the applied decision decorates the item");
  assert.match(String(item.brain_change_reason ?? ""), /step/i, "the change's own reason came with it");
});

test("an in-place plan edit that defers its cache bump still moves the plan memo", () => {
  seedPlan(135);
  assert.equal(planTarget(repo.getPlan()), 135, "the seeded prescription is memoized");

  // `defer_cache_bump` is what proposal application uses: the training-version bump waits
  // for the apply savepoint to commit, so between the write and that commit the plan's own
  // mutation odometer is the ONLY thing that can move the key. This edit is a pure in-place
  // UPDATE — no row count changes, no MAX(id) moves — which is exactly the shape both the
  // training backstop and the accountability signature are blind to. Without the odometer
  // the next read is served the PRE-mutation plan, and the post-apply quality gate (which
  // is the next reader) validates a plan that no longer exists.
  repo.applyPlanChange(
    { day_number: 1, exercise: "Memo Bench Press", target_weight: 145 },
    { defer_cache_bump: true, defer_day_read_invalidation: true }
  );

  assert.equal(planTarget(repo.getPlan()), 145, "the memo reflects the mutation, not the pre-mutation plan");
});

test("a deferred in-place edit that breaks the plan is visible to the quality validator", () => {
  seedPlan(135);
  repo.applyPlanChange(
    { day_number: 1, exercise: "Memo Bench Press", sets: 3, rep_low: 5, rep_high: 8 },
    { defer_cache_bump: true, defer_day_read_invalidation: true }
  );
  assert.equal(repo.validateTrainingPlan(repo.getPlan()).errors.length, 0, "a sane edit reads clean");

  // The reviewer's scenario, at the seam that matters: a structural error introduced by an
  // in-place UPDATE has to reach validateTrainingPlan through getPlan(). Written directly
  // so the assertion is about the MEMO, not about which prescriptions applyPlanChange is
  // willing to clamp on the way in.
  const day = db.prepare(`SELECT id FROM plan_days WHERE day_number = 1`).get();
  db.prepare(`UPDATE plan_items SET sets = 25 WHERE plan_day_id = ?`).run(day.id);

  const stored = db.prepare(`SELECT sets FROM plan_items WHERE plan_day_id = ?`).get(day.id);
  assert.equal(stored.sets, 25, "the database really holds the broken prescription");
  assert.equal(planSets(repo.getPlan()), 25, "and getPlan() reports what the database holds");
  const report = repo.validateTrainingPlan(repo.getPlan());
  assert.equal(report.ok, false, "the gate sees the breach instead of a clean pre-mutation copy");
  assert.ok(
    report.errors.some((entry) => entry.code === "invalid_sets"),
    "and names it"
  );
});
