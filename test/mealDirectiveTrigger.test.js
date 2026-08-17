// Meal-plan reactivity to a new material nutrition directive
// (src/repo/meal-directive-trigger.ts + mealPlanFreshness in src/repo/nutrition.ts).
// When directive derivation produces a NEW material nutrition/watch directive that
// postdates the current accepted meal plan, the trigger enqueues a regeneration
// through the EXISTING owned-refresh channel (the scheduler drafts it via
// draftMealPlan → the autonomy policy). Anti-pileup mirrors programEvolutionTrigger:
// one request per NEW directive-set signature, with a cooldown + single-slot dedup,
// and NEVER an inline agent run. Offline — no agent CLIs.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, tsDaysAgo, localDaysAgo } from "./_seed.js";
import { addDaysISO } from "../dist/repo/shared.js";
import { decideAutonomyTier } from "../dist/brain/autonomy.js";
import { roundMinutesToHalfHour } from "../dist/prompt/day.js";

const REQUEST_KEY = "meal_plan_refresh_requested";
const INSTRUCTION_KEY = "meal_plan_refresh_instruction";

beforeEach(() => {
  repo.resetTables?.("meal_plans", "health_directives");
  // Clear the durable request/dedup app_state this suite drives.
  for (const k of [REQUEST_KEY, INSTRUCTION_KEY, "meal_directive_refresh_sig", "meal_directive_refresh_date"]) {
    repo.setAppState(k, "");
  }
});

function seedAcceptedPlan(createdDaysAgo = 3, status = "accepted") {
  db.prepare(`INSERT INTO meal_plans (created_at, status, parsed_json) VALUES (?, ?, ?)`).run(
    tsDaysAgo(createdDaysAgo),
    status,
    JSON.stringify({ source_ts: localDaysAgo(createdDaysAgo), days: [] })
  );
}

function seedNutritionDirective(createdDaysAgo = 0, key = "apob:nutrition:lever", domain = "nutrition") {
  db.prepare(
    `INSERT INTO health_directives (created_at, source, domain, marker, directive, directive_key, status)
     VALUES (?, 'markers', ?, 'ApoB', 'Cut saturated fat; add soluble fiber.', ?, 'active')`
  ).run(tsDaysAgo(createdDaysAgo), domain, key);
}

test("a new nutrition directive postdating the accepted plan enqueues one refresh request", () => {
  seedAcceptedPlan(3);
  seedNutritionDirective(0); // created now, postdates the 3-day-old plan
  const fired = repo.maybeRequestMealRefreshForDirectives({ agentsAvailable: true });
  assert.equal(fired, true);
  // Lands at tomorrow's food-day boundary (the established owned-refresh semantics).
  assert.equal(repo.getAppState(REQUEST_KEY), addDaysISO(localDaysAgo(0), 1));
  assert.match(repo.getAppState(INSTRUCTION_KEY), /new health directive/i);
});

test("skips when no agent is available (nothing could run the refresh)", () => {
  seedAcceptedPlan(3);
  seedNutritionDirective(0);
  const fired = repo.maybeRequestMealRefreshForDirectives({ agentsAvailable: false });
  assert.equal(fired, false);
  assert.equal(repo.getAppState(REQUEST_KEY), "");
});

test("fires once per signature — a second call for the same directive set is a no-op", () => {
  seedAcceptedPlan(3);
  seedNutritionDirective(0);
  assert.equal(repo.maybeRequestMealRefreshForDirectives({ agentsAvailable: true }), true);
  assert.equal(repo.maybeRequestMealRefreshForDirectives({ agentsAvailable: true }), false);
});

test("does not stack while an owned refresh is already pending", () => {
  seedAcceptedPlan(3);
  seedNutritionDirective(0);
  repo.setAppState(REQUEST_KEY, addDaysISO(localDaysAgo(0), 1)); // a request is already pending
  assert.equal(repo.maybeRequestMealRefreshForDirectives({ agentsAvailable: true }), false);
});

test("a directive that PREDATES the accepted plan does not fire", () => {
  seedAcceptedPlan(0); // plan created now
  seedNutritionDirective(3); // directive is 3 days old — older than the plan
  assert.equal(repo.maybeRequestMealRefreshForDirectives({ agentsAvailable: true }), false);
});

test("no accepted plan to regenerate against → quiet no-op (a fresh install drafts its first plan directly)", () => {
  seedAcceptedPlan(3, "draft"); // only a draft exists
  seedNutritionDirective(0);
  assert.equal(repo.maybeRequestMealRefreshForDirectives({ agentsAvailable: true }), false);
});

test("cooldown + dedup: a NEW directive set within the cooldown waits, then fires once past it", () => {
  seedAcceptedPlan(6);
  seedNutritionDirective(0, "apob:nutrition:lever");
  const t0 = localDaysAgo(0);
  assert.equal(repo.maybeRequestMealRefreshForDirectives({ agentsAvailable: true, today: t0 }), true);

  // Scheduler consumed the request; the sig + date bookkeeping remains.
  repo.setAppState(REQUEST_KEY, "");
  repo.setAppState(INSTRUCTION_KEY, "");

  // Same set again → dedup on signature.
  assert.equal(repo.maybeRequestMealRefreshForDirectives({ agentsAvailable: true, today: t0 }), false);

  // A genuinely NEW directive set, but still within the cooldown window → wait.
  seedNutritionDirective(0, "ldl:nutrition:lever");
  assert.equal(repo.maybeRequestMealRefreshForDirectives({ agentsAvailable: true, today: t0 }), false);

  // Past the cooldown → the new set fires exactly once.
  const past = addDaysISO(t0, repo.MEAL_DIRECTIVE_REFRESH_COOLDOWN_DAYS + 1);
  assert.equal(repo.maybeRequestMealRefreshForDirectives({ agentsAvailable: true, today: past }), true);
});

// ---- the enqueued draft is tiered by lead_mode (the autonomy contract the trigger
// relies on: draftMealPlan → applyMealPlanWithAutonomy passes requested_tier 'announce') ----
test("respects lead_mode tiers: a meal-plan draft announces under lead, asks under review-everything", () => {
  const tierFor = (lead_mode) =>
    decideAutonomyTier({
      kind: "meal_plan",
      risk_class: "low",
      reversible: true,
      requested_tier: "announce",
      lead_mode,
    }).tier;
  assert.equal(tierFor("lead"), "announce");
  assert.equal(tierFor("announce_first"), "announce");
  assert.equal(tierFor("review_everything"), "ask");
});

// ---- mealPlanFreshness same-day boundary fix (nutrition.ts) ----
// Anchored a couple of days back rather than to a literal: mealPlanFreshness also calls a
// plan stale on calendar age alone past MEAL_PLAN_CALENDAR_STALE_DAYS, so a fixed date ages
// out of that window and both cases below start reporting stale for the wrong reason.
const FRESH_DAY = localDaysAgo(2);

test("mealPlanFreshness: a directive written intra-day AFTER the plan (same date) reads stale", () => {
  const day = FRESH_DAY;
  const plan = { created_at: `${day} 10:00:00`, parsed: { source_ts: day } };
  // A directive on the same date but created later in the day postdates the plan.
  db.prepare(
    `INSERT INTO health_directives (created_at, source, domain, directive, directive_key, status)
     VALUES (?, 'markers', 'nutrition', 'Cut saturated fat.', 'apob:nutrition:lever', 'active')`
  ).run(`${day} 14:00:00`);
  assert.equal(repo.mealPlanFreshness(plan).stale, true);
});

test("mealPlanFreshness: a directive written BEFORE the plan on the same date does not read stale", () => {
  const day = FRESH_DAY;
  const plan = { created_at: `${day} 10:00:00`, parsed: { source_ts: day } };
  db.prepare(
    `INSERT INTO health_directives (created_at, source, domain, directive, directive_key, status)
     VALUES (?, 'markers', 'nutrition', 'Cut saturated fat.', 'apob:nutrition:lever', 'active')`
  ).run(`${day} 08:00:00`);
  assert.equal(repo.mealPlanFreshness(plan).stale, false);
});

// ---- last-meal recency rounding (prompt/day.ts) ----
test("roundMinutesToHalfHour: nearest half hour, natural whole-number phrasing", () => {
  assert.equal(roundMinutesToHalfHour(90), 1.5);
  assert.equal(roundMinutesToHalfHour(120), 2);
  assert.equal(roundMinutesToHalfHour(105), 2); // 3.5 → 4 → 2
  assert.equal(roundMinutesToHalfHour(100), 1.5); // 3.33 → 3 → 1.5
  // Whole numbers render without a trailing ".0" (the phrasing requirement).
  assert.equal(String(roundMinutesToHalfHour(120)), "2");
  assert.equal(String(roundMinutesToHalfHour(90)), "1.5");
});
