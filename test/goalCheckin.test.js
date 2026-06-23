// The periodic, gentle "is this still your goal?" check (VISION §12 item 5).
// Constitution-critical: RARE and GENTLE — never nags a new user, stays quiet for
// a long cooldown after a dismiss, modest priority (loses to anything actionable),
// dismissible, no score. State rides entirely in app_state (no migration). Timing
// is driven by app_state stamps the test controls, so it's fully deterministic.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";

const DAY_MS = 86_400_000;
const CONFIRMED_KEY = "goal_checkin_confirmed_at";
const DISMISSED_KEY = "goal_checkin_dismissed_at";

// A complete profile so effectiveGoalMode resolves a real mode.
function setProfile(extra = {}) {
  return repo.setProfile({ age: 35, height_cm: 180, weight_lb: 185, activity_factor: 1.5, ...extra });
}

// Write an epoch-ms stamp directly into app_state (what the module reads).
function stamp(key, msAgo) {
  repo.setAppState(key, String(Date.now() - msAgo));
}

beforeEach(() => {
  resetTables("app_state", "profile");
});

test("a fresh user is never nagged — first observation seeds the clock, returns null", () => {
  setProfile({ goal_mode: "maintain" });
  // No stamps yet → first call seeds goal_checkin_confirmed_at = now and stays quiet.
  assert.equal(repo.goalCheckinCandidate(), null);
  // The seed stamp now exists, so the FIRST prompt is ~90 days out, not on day one.
  assert.ok(repo.getAppState(CONFIRMED_KEY), "first observation seeds the confirm stamp");
  // A second call right after is still quiet (clock barely moved).
  assert.equal(repo.goalCheckinCandidate(), null);
});

test("no profile at all → null (nothing to check in on)", () => {
  assert.equal(repo.goalCheckinCandidate(), null);
});

test("after the goal's been stable ≥90 days → a calm, modest, dismissible candidate", () => {
  setProfile({ goal_mode: "maintain", weight_lb: 185 });
  stamp(CONFIRMED_KEY, 95 * DAY_MS); // confirmed/changed ~95 days ago — long stable

  const c = repo.goalCheckinCandidate();
  assert.ok(c, "due after a long stable period");
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
  stamp(CONFIRMED_KEY, 100 * DAY_MS);
  const lose = repo.goalCheckinCandidate();
  assert.ok(lose);
  assert.match(lose.title, /leaning out/i, "lose mode reads in lose language");
  assert.equal(lose.action.payload.goal_mode, "lose");

  resetTables("app_state", "profile");
  setProfile({ goal_mode: "gain", weight_lb: 185 });
  stamp(CONFIRMED_KEY, 100 * DAY_MS);
  const gain = repo.goalCheckinCandidate();
  assert.ok(gain);
  assert.match(gain.title, /building/i, "gain mode reads in gain language");
  assert.equal(gain.action.payload.goal_mode, "gain");
});

test("a goal stable only a little while → still quiet (no nag)", () => {
  setProfile({ goal_mode: "maintain" });
  stamp(CONFIRMED_KEY, 40 * DAY_MS); // only ~40 days — under the stable threshold
  assert.equal(repo.goalCheckinCandidate(), null);
});

test("a recent dismiss silences it for the cooldown, even when otherwise due", () => {
  setProfile({ goal_mode: "maintain" });
  stamp(CONFIRMED_KEY, 200 * DAY_MS); // long stable — would normally surface
  stamp(DISMISSED_KEY, 5 * DAY_MS); // but dismissed 5 days ago → cooldown
  assert.equal(repo.goalCheckinCandidate(), null, "dismiss cooldown keeps it quiet");

  // Once the cooldown has fully elapsed (~90 days ago dismiss), it can surface again.
  stamp(DISMISSED_KEY, 90 * DAY_MS);
  assert.ok(repo.goalCheckinCandidate(), "resurfaces after the cooldown passes");
});

test("confirmGoalCheckin / dismissGoalCheckin stamp app_state", () => {
  setProfile({ goal_mode: "maintain" });

  repo.confirmGoalCheckin();
  const confirmed = Number(repo.getAppState(CONFIRMED_KEY));
  assert.ok(Number.isFinite(confirmed) && confirmed > 0, "confirm stamps a timestamp");
  // A fresh confirm restarts the stable clock → quiet again.
  assert.equal(repo.goalCheckinCandidate(), null, "confirming restarts the clock");

  repo.dismissGoalCheckin();
  const dismissed = Number(repo.getAppState(DISMISSED_KEY));
  assert.ok(Number.isFinite(dismissed) && dismissed > 0, "dismiss stamps a timestamp");
});

// Defensive: the stored stamp is exactly what we can read back (a clean integer),
// so the integrator's confirm/dismiss handlers behave predictably across surfaces.
test("stamps persist as parseable integers", () => {
  repo.confirmGoalCheckin();
  const raw = repo.getAppState(CONFIRMED_KEY);
  assert.match(raw, /^\d+$/, "confirm stamp is a clean integer string");
  // app_state singleton is the same DB the runner points at a temp file.
  const row = db.prepare(`SELECT value FROM app_state WHERE key = ?`).get(CONFIRMED_KEY);
  assert.equal(row.value, raw);
});
