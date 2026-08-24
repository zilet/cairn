// The periodic, gentle "is this still your goal?" check (VISION §12 item 5).
// Constitution-critical: RARE and GENTLE — never nags a new user, modest priority
// (loses to anything actionable), dismissible, no score.
//
// TRIGGER (round W2.2): fires on OBSERVED DIVERGENCE between the measured
// bodyweight trend and the declared goal mode over a sustained window, not a
// fixed timer — a stale/absent-log period never fires it by itself. A
// long-horizon BACKSTOP (~6 months since last checked) still fires
// independent of weight evidence, so a genuine silent change of heart is
// caught even with a bare scale. Once shown/confirmed/dismissed, a short
// cooldown holds it quiet so it never re-asks the next day.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedWeight, localDaysAgo } from "./_seed.js";

const SIGNAL_KEY = "journey:goal-checkin";

// A complete profile so effectiveGoalMode resolves a real mode.
function setProfile(extra = {}) {
  return repo.setProfile({ age: 35, height_cm: 180, weight_lb: 185, activity_factor: 1.5, ...extra });
}

const today = () => localDaysAgo(0);

// Seed the attention entry with last_checked set N days in the past (bypassing
// the real-time cooldown deterministically).
function seedDaysAgo(n) {
  assert.equal(repo.goalCheckinCandidate(localDaysAgo(n)), null, "seeding call always returns null");
}

// Log a flat run of weigh-ins spanning `spanDays`, ending `endDaysAgo` days
// ago, with `n` evenly-spaced points — adequate coverage by default (6 points
// over ~24 days). `driftLb` is the total change from first to last point.
function logWeighIns({ endDaysAgo, spanDays = 24, n = 7, base = 185, driftLb = 0 }) {
  const step = spanDays / (n - 1);
  for (let i = 0; i < n; i++) {
    const daysAgo = endDaysAgo + spanDays - Math.round(i * step);
    const weight = base + (driftLb * i) / (n - 1);
    seedWeight(localDaysAgo(daysAgo), Math.round(weight * 100) / 100);
  }
}

beforeEach(() => {
  resetTables("app_state", "profile", "attention_schedule", "bodyweight_log");
});

test("a fresh user is never nagged — first call seeds silently, returns null", () => {
  setProfile({ goal_mode: "maintain" });
  assert.equal(repo.goalCheckinCandidate(), null);
  const entry = repo.getAttentionSchedule(SIGNAL_KEY);
  assert.ok(entry, "first observation seeds the attention entry");
  assert.equal(entry.last_checked, today());
  // Immediately calling again is still quiet (cooldown + no divergence evidence yet).
  assert.equal(repo.goalCheckinCandidate(), null);
});

test("no profile at all → null (nothing to check in on, no entry seeded)", () => {
  assert.equal(repo.goalCheckinCandidate(), null);
  assert.equal(repo.getAttentionSchedule(SIGNAL_KEY), null);
});

test("timer alone does not fire — no divergence, backstop not due, still quiet", () => {
  setProfile({ goal_mode: "maintain" });
  seedDaysAgo(60); // well past the cooldown, well short of the ~6-month backstop
  // No weigh-ins logged at all (thin/absent coverage) — never nag about missing logs.
  assert.equal(repo.goalCheckinCandidate(), null);
});

test("divergence fires: goal is 'lose' but the trend is flat with adequate coverage", () => {
  setProfile({ goal_mode: "lose", goal_weight_lb: 170 });
  seedDaysAgo(60);
  logWeighIns({ endDaysAgo: 1, base: 185, driftLb: 0.2 }); // essentially flat, not clearing the loss floor
  const c = repo.goalCheckinCandidate();
  assert.ok(c, "diverges: trying to lose but not trending down");
  assert.equal(c.id, "goal-checkin");
  assert.equal(c.kind, "goal");
  assert.equal(c.tier, "primary");
  assert.equal(c.dismissible, true);
  assert.ok(c.priority > 0 && c.priority <= 30, `priority is modest, got ${c.priority}`);
  assert.doesNotMatch(c.title, /\b\d{1,3}\s*\/\s*100\b/, "no x/100 score");
  assert.doesNotMatch(c.title, /score/i, "no 'score' framing");
  assert.match(c.title, /leaning out/i, "lose mode reads in lose language");
  assert.ok(c.action, "offers an action");
  assert.equal(c.action.payload.goal_mode, "lose");
});

test("no divergence: goal is 'lose' and the trend is genuinely trending down — stays quiet", () => {
  setProfile({ goal_mode: "lose", goal_weight_lb: 170 });
  seedDaysAgo(60);
  // ~1 lb/wk down over the window clears the loss floor easily.
  logWeighIns({ endDaysAgo: 1, base: 189, driftLb: -3.5 });
  assert.equal(repo.goalCheckinCandidate(), null);
});

test("divergence fires: goal is 'gain' but the trend is flat/down", () => {
  setProfile({ goal_mode: "gain" });
  seedDaysAgo(60);
  logWeighIns({ endDaysAgo: 1, base: 165, driftLb: -0.3 });
  const c = repo.goalCheckinCandidate();
  assert.ok(c, "diverges: trying to gain but not trending up");
  assert.match(c.title, /building/i, "gain mode reads in gain language");
  assert.equal(c.action.payload.goal_mode, "gain");
});

test("divergence fires: goal is 'maintain' but weight has drifted past the calm band", () => {
  setProfile({ goal_mode: "maintain" });
  seedDaysAgo(60);
  logWeighIns({ endDaysAgo: 1, base: 180, driftLb: 6 }); // clear sustained drift
  const c = repo.goalCheckinCandidate();
  assert.ok(c, "diverges: maintain goal but a real sustained drift");
  assert.match(c.title, /holding steady/i, "maintain mode reads in maintain language");
});

test("no divergence: 'maintain' with only a small wobble inside the calm band", () => {
  setProfile({ goal_mode: "maintain" });
  seedDaysAgo(60);
  logWeighIns({ endDaysAgo: 1, base: 180, driftLb: 0.8 }); // well inside the band
  assert.equal(repo.goalCheckinCandidate(), null);
});

test("thin weigh-in coverage reads as absent, never as divergence — no nag about missing logs", () => {
  setProfile({ goal_mode: "lose", goal_weight_lb: 170 });
  seedDaysAgo(60);
  // Only 2 points — below the coverage floor — even though the apparent trend disagrees.
  logWeighIns({ endDaysAgo: 1, spanDays: 24, n: 2, base: 185, driftLb: 2 });
  assert.equal(repo.goalCheckinCandidate(), null);
});

test("the long-horizon backstop fires even with zero weight evidence (~6 months)", () => {
  setProfile({ goal_mode: "maintain" });
  seedDaysAgo(200); // past the ~6-month backstop
  const c = repo.goalCheckinCandidate();
  assert.ok(c, "backstop catches a silent change of heart even with a bare scale");
});

test("backstop does not fire early — short of ~6 months and no divergence stays quiet", () => {
  setProfile({ goal_mode: "maintain" });
  seedDaysAgo(150); // short of the ~180-day backstop
  assert.equal(repo.goalCheckinCandidate(), null);
});

test("confirming resets the cooldown — no re-ask the next call even while still due", () => {
  setProfile({ goal_mode: "lose", goal_weight_lb: 170 });
  seedDaysAgo(60);
  logWeighIns({ endDaysAgo: 1, base: 185, driftLb: 0.2 });
  assert.ok(repo.goalCheckinCandidate(), "due to fire");
  repo.confirmGoalCheckin();
  assert.equal(repo.goalCheckinCandidate(), null, "confirming quiets it — no daily nag");
});

test("dismissing quiets the card (it does not immediately resurface)", () => {
  setProfile({ goal_mode: "lose", goal_weight_lb: 170 });
  seedDaysAgo(60);
  logWeighIns({ endDaysAgo: 1, base: 185, driftLb: 0.2 });
  assert.ok(repo.goalCheckinCandidate(), "due to fire");
  repo.dismissGoalCheckin();
  assert.equal(repo.goalCheckinCandidate(), null, "quiet right after a dismiss");
});

test("a real goal change resets the cooldown under the new goal", () => {
  setProfile({ goal_mode: "maintain" });
  seedDaysAgo(60);
  repo.reactivateGoalCheckin();
  // Freshly reactivated today — even if some future divergence check would fire,
  // the cooldown holds it quiet immediately after a goal change.
  assert.equal(repo.goalCheckinCandidate(), null);
});
