// The periodic, gentle "is this still your goal?" check (VISION §12 item 5).
// Constitution-critical: RARE and GENTLE — never nags a new user, modest priority
// (loses to anything actionable), dismissible, no score. CADENCE now rides the
// shared K5 attention engine as a `journey`-domain signal (NO fixed 90-day
// interval): every "still my goal" is a clean check that STRETCHES the next ask
// and, repeated, RELEASES it — a stable goal converges to no scheduled check.
// Timing is driven off the attention entry's next_due (an ISO date), so the test
// simulates "later" by passing an asOf date — fully deterministic.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";

const SIGNAL_KEY = "journey:goal-checkin";

// A complete profile so effectiveGoalMode resolves a real mode.
function setProfile(extra = {}) {
  return repo.setProfile({ age: 35, height_cm: 180, weight_lb: 185, activity_factor: 1.5, ...extra });
}

function addDaysISO(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Days between last_checked and next_due — the scheduled interval of an entry.
function daysUntil(entry) {
  if (!entry || !entry.next_due) return 0;
  const a = Date.parse(`${entry.last_checked}T00:00:00Z`);
  const b = Date.parse(`${entry.next_due}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

beforeEach(() => {
  resetTables("app_state", "profile", "attention_schedule");
});

test("a fresh user is never nagged — first call seeds the active clock, returns null", () => {
  setProfile({ goal_mode: "maintain" });
  // No attention entry yet → first call seeds an active entry (~90 days out) and stays quiet.
  assert.equal(repo.goalCheckinCandidate(), null);
  const entry = repo.getAttentionSchedule(SIGNAL_KEY);
  assert.ok(entry, "first observation seeds the attention entry");
  assert.equal(entry.tier, "active");
  assert.ok(entry.next_due, "the first prompt is scheduled ~90 days out, not day one");
  // A second call right after is still quiet (next_due hasn't arrived).
  assert.equal(repo.goalCheckinCandidate(), null);
});

test("no profile at all → null (nothing to check in on, no entry seeded)", () => {
  assert.equal(repo.goalCheckinCandidate(), null);
  assert.equal(repo.getAttentionSchedule(SIGNAL_KEY), null);
});

test("once the scheduled check arrives → a calm, modest, dismissible candidate", () => {
  setProfile({ goal_mode: "maintain", weight_lb: 185 });
  assert.equal(repo.goalCheckinCandidate(), null); // seed
  const nextDue = repo.getAttentionSchedule(SIGNAL_KEY).next_due;

  // Before next_due → still quiet.
  assert.equal(repo.goalCheckinCandidate(addDaysISO(nextDue, -1)), null);

  // On/after next_due → the gentle card.
  const c = repo.goalCheckinCandidate(addDaysISO(nextDue, 5));
  assert.ok(c, "due once the scheduled check arrives");
  assert.equal(c.id, "goal-checkin");
  assert.equal(c.kind, "goal");
  assert.equal(c.tier, "primary");
  assert.equal(c.dismissible, true);
  // Modest priority — it should lose to anything actionable, win only on a quiet day.
  assert.ok(c.priority > 0 && c.priority <= 30, `priority is modest, got ${c.priority}`);
  // Calm, plain-language title with NO score / number-as-grade.
  assert.ok(typeof c.title === "string" && c.title.length > 0);
  assert.doesNotMatch(c.title, /\b\d{1,3}\s*\/\s*100\b/, "no x/100 score");
  assert.doesNotMatch(c.title, /score/i, "no 'score' framing");
  assert.match(c.title, /holding steady/i, "maintain mode reads in maintain language");
  // You-drive: a confirm + change path, nothing auto-applies.
  assert.ok(c.action, "offers an action");
  assert.equal(c.action.payload.goal_mode, "maintain");
});

test("phrasing fits the goal mode (lose / gain)", () => {
  setProfile({ goal_mode: "lose", weight_lb: 185, goal_weight_lb: 175 });
  assert.equal(repo.goalCheckinCandidate(), null); // seed
  let nextDue = repo.getAttentionSchedule(SIGNAL_KEY).next_due;
  const lose = repo.goalCheckinCandidate(addDaysISO(nextDue, 5));
  assert.ok(lose);
  assert.match(lose.title, /leaning out/i, "lose mode reads in lose language");
  assert.equal(lose.action.payload.goal_mode, "lose");

  resetTables("app_state", "profile", "attention_schedule");
  setProfile({ goal_mode: "gain", weight_lb: 185 });
  assert.equal(repo.goalCheckinCandidate(), null); // seed
  nextDue = repo.getAttentionSchedule(SIGNAL_KEY).next_due;
  const gain = repo.goalCheckinCandidate(addDaysISO(nextDue, 5));
  assert.ok(gain);
  assert.match(gain.title, /building/i, "gain mode reads in gain language");
  assert.equal(gain.action.payload.goal_mode, "gain");
});

test("confirming stretches the next ask, then releases — converges to no scheduled check (rule 2a)", () => {
  setProfile({ goal_mode: "maintain" });
  assert.equal(repo.goalCheckinCandidate(), null); // seed → active
  const activeInterval = daysUntil(repo.getAttentionSchedule(SIGNAL_KEY));

  // A clean confirm advances active → confirming → surveillance, stretching the interval.
  repo.confirmGoalCheckin(); // → confirming
  repo.confirmGoalCheckin(); // → surveillance
  const survEntry = repo.getAttentionSchedule(SIGNAL_KEY);
  assert.equal(survEntry.tier, "surveillance");
  assert.ok(daysUntil(survEntry) > activeInterval, "surveillance interval is longer than the active one (it stretches)");

  // Keep confirming — the tier machine eventually RELEASES (no scheduled check).
  let released = false;
  for (let i = 0; i < 6 && !released; i++) {
    repo.confirmGoalCheckin();
    released = repo.getAttentionSchedule(SIGNAL_KEY).tier === "released";
  }
  assert.ok(released, "repeated clean confirms release the signal");
  const rel = repo.getAttentionSchedule(SIGNAL_KEY);
  assert.equal(rel.next_due, null, "a released signal has no scheduled check");
  // Even far in the future, a released goal stays quiet (event-driven only now).
  assert.equal(repo.goalCheckinCandidate("2099-01-01"), null);
});

test("a real goal change re-seeds the active clock (a fresh goal gets a fresh cadence)", () => {
  setProfile({ goal_mode: "maintain" });
  assert.equal(repo.goalCheckinCandidate(), null); // seed
  // Stretch it out with a couple of confirms so it's no longer at active.
  repo.confirmGoalCheckin();
  repo.confirmGoalCheckin();
  assert.equal(repo.getAttentionSchedule(SIGNAL_KEY).tier, "surveillance");

  // A goal change (goal_change event) reactivates at the active tier.
  repo.reactivateGoalCheckin();
  const entry = repo.getAttentionSchedule(SIGNAL_KEY);
  assert.equal(entry.tier, "active", "a goal change re-seeds at active");
  assert.ok(entry.next_due, "and re-schedules the first gentle check ~90 days out");
});

test("dismissing quiets the card (it does not immediately resurface)", () => {
  setProfile({ goal_mode: "maintain" });
  assert.equal(repo.goalCheckinCandidate(), null); // seed
  const nextDue = repo.getAttentionSchedule(SIGNAL_KEY).next_due;
  assert.ok(repo.goalCheckinCandidate(addDaysISO(nextDue, 5)), "due once scheduled");

  repo.dismissGoalCheckin();
  const after = repo.getAttentionSchedule(SIGNAL_KEY);
  // A dismiss is a clean check → the next ask is stretched out again; not due right after.
  assert.ok(after.next_due, "still scheduled (a dismiss stretches, does not delete)");
  assert.equal(repo.goalCheckinCandidate(addDaysISO(after.last_checked, 1)), null, "quiet right after a dismiss");
});
