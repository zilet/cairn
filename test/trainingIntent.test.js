import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../dist/db.js";
import * as repo from "../dist/repo.js";
import { MIGRATIONS } from "../dist/migrate.js";

const MAX_VERSION = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);

const MILOS_INTENT = {
  priorities: ["longevity", "muscle", "leanness", "endurance", "muscle", "unknown"],
  endurance_role: "supporting",
  endurance_capacity: {
    sport: "MTB",
    target_duration_min: 120,
    context: "Keep two-hour trail rides comfortably available.",
  },
};

test("training intent normalizes, persists, resolves explicitly, and clears back to a derived legacy view", () => {
  const saved = repo.setProfile({
    primary_discipline: "hybrid",
    goal_mode: "lose",
    training_intent: MILOS_INTENT,
  });
  assert.equal(typeof saved.training_intent_json, "string");
  assert.deepEqual(repo.getTrainingIntent(), {
    priorities: ["longevity", "muscle", "leanness", "endurance"],
    endurance_role: "supporting",
    endurance_capacity: {
      sport: "MTB",
      target_duration_min: 120,
      context: "Keep two-hour trail rides comfortably available.",
    },
    source: "explicit",
  });

  repo.setProfile({ training_intent: null });
  const derived = repo.getTrainingIntent();
  assert.equal(derived.source, "derived");
  assert.equal(derived.endurance_role, "co_primary", "legacy hybrid defaults co-primary only without explicit intent");
  assert.ok(derived.priorities.includes("leanness"));
});

test("invalid stored intent derives safely and explicit no-endurance never invents a capacity read", () => {
  db.prepare(
    `INSERT INTO profile (id, primary_discipline, goal_mode, training_intent_json)
     VALUES (1, 'strength', 'maintain', '{not-json')`
  ).run();
  assert.equal(repo.getTrainingIntent().source, "derived");
  assert.equal(repo.getTrainingIntent().endurance_role, "none");

  repo.setProfile({
    training_intent: {
      priorities: ["longevity", "muscle", "strength"],
      endurance_role: "none",
      endurance_capacity: { sport: "ride", target_duration_min: 120 },
    },
  });
  assert.equal(repo.getEnduranceCapacity(repo.getTrainingIntent(), { asOf: "2026-07-28" }), null);
});

test("an invalid incoming intent cannot erase a valid explicit hierarchy", () => {
  repo.setProfile({ training_intent: MILOS_INTENT });
  repo.setProfile({
    training_intent: {
      priorities: [],
      endurance_role: "sometimes",
    },
  });
  assert.equal(repo.getTrainingIntent().source, "explicit");
  assert.deepEqual(repo.getTrainingIntent().priorities, ["longevity", "muscle", "leanness", "endurance"]);
});

test("MTB capability recognizes ride tokens and a recent outing above the target as ready", () => {
  repo.setProfile({ training_intent: MILOS_INTENT });
  db.prepare(
    `INSERT INTO activities (date, type, raw_text, duration_min, source)
     VALUES ('2026-07-20', 'mountain_biking', 'MTB trail ride', 151, 'manual')`
  ).run();
  const read = repo.getEnduranceCapacity(repo.getTrainingIntent(), { asOf: "2026-07-28" });
  assert.ok(read);
  assert.equal(read.status, "ready");
  assert.equal(read.sport, "MTB");
  assert.equal(read.target_duration_min, 120);
  assert.deepEqual(read.evidence, { date: "2026-07-20", duration_min: 151 });
  assert.doesNotMatch(JSON.stringify(read), /score|percent|%/i);
});

test("structured sport type wins over incidental cross-sport words in the activity note", () => {
  repo.setProfile({ training_intent: MILOS_INTENT });
  db.prepare(
    `INSERT INTO activities (date, type, raw_text, duration_min, source)
     VALUES ('2026-07-20', 'ride', 'Easy MTB; legs fresh after yesterday run', 125, 'manual')`
  ).run();
  const read = repo.getEnduranceCapacity(repo.getTrainingIntent(), { asOf: "2026-07-28" });
  assert.equal(read.status, "ready");
  assert.equal(read.evidence.duration_min, 125);
});

test("capacity reads building, rebuilding, and no-data calmly without changing the plan", () => {
  repo.setProfile({ training_intent: MILOS_INTENT });
  const noData = repo.getEnduranceCapacity(repo.getTrainingIntent(), { asOf: "2026-07-28" });
  assert.equal(noData.status, "no_data");

  db.prepare(`INSERT INTO activities (date, type, duration_min) VALUES ('2026-07-15', 'mountain_biking', 55)`).run();
  const building = repo.getEnduranceCapacity(repo.getTrainingIntent(), { asOf: "2026-07-28" });
  assert.equal(building.status, "building");
  assert.match(building.next_step, /easy outing|minutes/i);

  const rebuilding = repo.getEnduranceCapacity(repo.getTrainingIntent(), {
    asOf: "2026-09-20",
    recentDays: 30,
    historyDays: 180,
  });
  assert.equal(rebuilding.status, "rebuilding");
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM plan_days`).get().n, 0, "the read never mutates the plan");
});

test("coach context carries the resolved intent and capacity read", () => {
  repo.setProfile({ training_intent: MILOS_INTENT });
  const ctx = repo.getCoachContext();
  assert.equal(ctx.training_intent.source, "explicit");
  assert.deepEqual(ctx.training_intent.priorities, ["longevity", "muscle", "leanness", "endurance"]);
  assert.ok(Object.hasOwn(ctx, "endurance_capacity"));
});

test("fresh schema keeps the training intent column through the v81 profile migration", () => {
  const columns = db
    .prepare(`PRAGMA table_info(profile)`)
    .all()
    .map((row) => row.name);
  assert.ok(columns.includes("training_intent_json"));
  // Computed dynamically (not hardcoded — CLAUDE.md) so a later migration never
  // breaks this test; what matters is that a fresh DB reaches the CURRENT top of
  // the ladder, not any specific historical version number.
  assert.equal(db.prepare(`PRAGMA user_version`).get().user_version, MAX_VERSION);
});
