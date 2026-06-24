// The ONE next-best-step arbiter (src/repo/next-step.ts) — a pure, deterministic,
// cross-domain producer. Invariants under test:
//   - SCORING ORDER: the agentic health-synthesis `one_change` lever (leverage 3)
//     beats a raw per-marker directive group (leverage 2)
//   - a QUIET day (no labs, no food logged, recovered, no context) → null
//   - SNOOZE cooldown suppresses a step for its window (then it returns)
//   - an ACUTE/stale CRP/ESR finding NEVER yields a training-cap step — at most a
//     calm leverage-1 "recheck"; the `domain` is recheck, never train
//   - step_key is STABLE + coarse across calls
// Deterministic, offline, temp DB (see test/run.mjs). Imports next-step.js
// directly (the barrel re-export is the integration owner's wire-up).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { saveHealthSynthesis } from "../dist/repo/propagation.js";
import {
  nextBestStep,
  snoozeNextStep,
  nextStepDone,
} from "../dist/repo/next-step.js";

const TODAY = new Date().toISOString().slice(0, 10);

function reset() {
  for (const t of [
    "logged_sets", "plan_items", "plan_days", "sessions", "exercises",
    "bodyweight_log", "activities", "garmin_activities", "food_notes",
    "health_documents", "health_directives", "context_events", "daily_metrics",
    "garmin_daily_metrics", "checkins", "app_state", "profile",
  ]) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist */ }
  }
  // A clean, recovered, no-goal profile so the deterministic floors are quiet
  // unless a test seeds a signal.
}

beforeEach(reset);

// Seed a dated lab document carrying markers[] (drives prioritizeMarkers/healthFocus).
function seedLab(markers) {
  return repo.addHealthDocument({
    kind: "bloodwork",
    doc_date: TODAY,
    parsed_json: { markers },
    enrichment_status: "done",
  });
}

// A full profile so computeGoalCheck() returns a protein target.
function seedProfile() {
  repo.setProfile({
    age: 35, height_cm: 180, weight_lb: 180, sex: "male",
    activity_factor: 1.5, goal_weight_lb: 170, goal_date: null,
  });
}

// A food note logged TODAY (this era keys the day off created_at's date prefix).
function seedFoodToday(parsed) {
  db.prepare(
    `INSERT INTO food_notes (meal, raw_output, parsed_json, enrichment_status, created_at)
     VALUES ('meal', '', ?, NULL, ?)`
  ).run(JSON.stringify(parsed), new Date().toISOString().slice(0, 19).replace("T", " "));
}

// ---------------------------------------------------------------------------

test("quiet day → null (no labs, no food, recovered, no context)", () => {
  const step = nextBestStep(TODAY);
  assert.equal(step, null, "a genuinely quiet day surfaces nothing");
});

test("scoring order: synthesis one_change (lev 3) beats a raw directive group (lev 2)", () => {
  // A chronic off-optimal lab → healthFocus would yield a leverage-2 recheck.
  seedLab([{ name: "ApoB", value: 110, unit: "mg/dL", flag: "high" }]);
  // Without the synthesis, the lead step is the chronic lab group.
  const withoutSynth = nextBestStep(TODAY);
  assert.ok(withoutSynth, "a chronic off-optimal lab yields a step");
  assert.equal(withoutSynth.domain, "recheck");
  assert.equal(withoutSynth.step_key.startsWith("recheck:group:"), true);
  assert.equal(withoutSynth.leverage, 2);

  // Now layer the agentic synthesis — its one_change is the highest lever.
  saveHealthSynthesis({ found: true, headline: "Lipids lead.", one_change: "Swap red meat for oily fish 3x/wk." });
  const withSynth = nextBestStep(TODAY);
  assert.ok(withSynth);
  assert.equal(withSynth.domain, "recheck");
  assert.equal(withSynth.step_key, "recheck:synthesis-one-change");
  assert.equal(withSynth.leverage, 3, "the synthesis lever outranks the raw directive");
  assert.match(withSynth.why, /oily fish/);
});

test("snooze cooldown suppresses the step for its window, then it returns", () => {
  seedLab([{ name: "ApoB", value: 110, unit: "mg/dL", flag: "high" }]);
  const first = nextBestStep(TODAY);
  assert.ok(first);
  const key = first.step_key;

  snoozeNextStep(key);
  const afterSnooze = nextBestStep(TODAY);
  // The snoozed lab step is suppressed. With nothing else live, the day is quiet.
  assert.equal(afterSnooze, null, "a snoozed step does not return inside its window");

  // Backdate the snooze stamp past the window → the step is free to surface again.
  const old = new Date(Date.now() - 10 * 864e5).toISOString();
  db.prepare(`UPDATE app_state SET value = ? WHERE key = ?`).run(old, `next_step:snooze:${key}`);
  const afterWindow = nextBestStep(TODAY);
  assert.ok(afterWindow, "once the cooldown passes the step can surface again");
  assert.equal(afterWindow.step_key, key);
});

test("nextStepDone suppresses for the longer window", () => {
  seedLab([{ name: "ApoB", value: 110, unit: "mg/dL", flag: "high" }]);
  const first = nextBestStep(TODAY);
  assert.ok(first);
  nextStepDone(first.step_key);
  assert.equal(nextBestStep(TODAY), null, "a done step stays quiet");
});

test("acute/stale CRP never yields a training-cap step — at most a calm recheck", () => {
  // ONLY an elevated hs-CRP is off-optimal (training-induced inflammation).
  seedLab([{ name: "hs-CRP", value: 3.2, unit: "mg/L", flag: "high" }]);
  const step = nextBestStep(TODAY);
  assert.ok(step, "an elevated CRP still surfaces something");
  assert.notEqual(step.domain, "train", "a high CRP never drives a training step");
  assert.equal(step.domain, "recheck");
  assert.equal(step.step_key, "recheck:acute-inflammation");
  assert.ok(step.leverage <= 1, "an acute inflammatory marker is at most leverage 1");
  // It must NOT read as a cap on training.
  assert.doesNotMatch(step.why, /\b(cap|stop|don't|avoid) (training|lifting)\b/i);
});

test("a chronic lab alongside CRP still leads on the chronic lever", () => {
  seedLab([
    { name: "hs-CRP", value: 3.2, unit: "mg/L", flag: "high" },
    { name: "ApoB", value: 115, unit: "mg/dL", flag: "high" },
  ]);
  const step = nextBestStep(TODAY);
  assert.ok(step);
  assert.equal(step.domain, "recheck");
  // The chronic ApoB group wins over the acute CRP.
  assert.equal(step.step_key.startsWith("recheck:group:"), true);
  assert.equal(step.leverage, 2);
});

test("fuel: a real protein gap on a logged day surfaces (and step_key is stable)", () => {
  seedProfile(); // protein target ~180 g
  // Logged food well under the protein anchor, but with macros to evaluate.
  seedFoodToday({ summary: "toast", kcal: 600, protein_g: 30 });
  const step = nextBestStep(TODAY);
  assert.ok(step, "a material protein gap on a logged day surfaces");
  assert.equal(step.domain, "fuel");
  assert.equal(step.step_key, "fuel:protein-gap");

  // Stable key across calls.
  const again = nextBestStep(TODAY);
  assert.equal(again.step_key, "fuel:protein-gap");
});

test("fuel never nudges capture: no food logged → no fuel step", () => {
  seedProfile();
  // No food_notes at all today.
  const step = nextBestStep(TODAY);
  assert.equal(step, null, "an empty food day is quiet (capture is never nudged)");
});

test("life: an active injury context event surfaces a work-around step", () => {
  db.prepare(
    `INSERT INTO context_events (kind, title, detail, start_date, end_date, archived)
     VALUES ('injury', 'Left shoulder', 'overhead aggravates it', ?, NULL, 0)`
  ).run(TODAY);
  const step = nextBestStep(TODAY);
  assert.ok(step);
  assert.equal(step.domain, "life");
  assert.equal(step.step_key.startsWith("life:injury:"), true);
});

test("never throws on missing/empty data", () => {
  // No profile, no labs, no food, no events — must be a clean null, not a throw.
  assert.doesNotThrow(() => {
    const s = nextBestStep();
    assert.equal(s, null);
  });
  assert.doesNotThrow(() => snoozeNextStep(""));
  assert.doesNotThrow(() => nextStepDone(""));
});
