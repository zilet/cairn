// Inspectable beliefs (W3.6): the durable "that's not right" ledger over the
// coach's derived belief sources (src/repo/belief-dispositions.ts,
// src/repo/beliefs.ts) and its wiring into the three belief-producing consumers:
//   - learned-models.ts's learnedModelsForCoach() (the ONE prompt/day-line read)
//   - felt-signals.ts's feltSignalsForCoach() (ditto)
//   - reaction-model.ts's whatWorksForYou() (personal-response modifier application)
// Invariants under test:
//   - a disputed belief disappears from the coach-facing read (prompts/day-lines/
//     modifier application) but stays visible under listBeliefs().set_aside
//   - un-dispute restores it to both
//   - a rebuild (saveLearnedModels/saveFeltSignals, or a fresh whatWorksForYou()
//     compute) never resurrects a disputed belief in the coach-facing read, even
//     though the deterministic builder recomputes the identical statement
//   - migration 94 (belief_dispositions) is idempotent
// Deterministic, offline, temp DB (see test/run.mjs). Imports from dist.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, isoDaysAgo } from "./_seed.js";
import { MIGRATIONS } from "../dist/migrate.js";
import {
  isBeliefDisputed,
  learnedModelBeliefId,
  feltSignalBeliefId,
  personalModifierBeliefId,
} from "../dist/repo/belief-dispositions.js";
import { disputeBelief, undisputeBelief, listBeliefs } from "../dist/repo/beliefs.js";
import { buildLearnedModels, learnedModelsForCoach, saveLearnedModels } from "../dist/repo/learned-models.js";
import { buildFeltSignals, feltSignalsForCoach, saveFeltSignals } from "../dist/repo/felt-signals.js";
import { personalResponseModifierFor, whatWorksForYou } from "../dist/repo/reaction-model.js";
import { recordDecision } from "../dist/repo/brain-decisions.js";
import { insertBrainEvaluation } from "../dist/repo/brain-evaluations.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";

function reset() {
  for (const t of [
    "belief_dispositions",
    "checkins",
    "fueling_feedback",
    "daily_metrics",
    "app_state",
    "brain_decisions",
    "brain_evaluations",
    "brain_expectations",
  ]) {
    try {
      db.prepare(`DELETE FROM ${t}`).run();
    } catch {
      /* table may not exist */
    }
  }
}
beforeEach(reset);

// ---------------------------------------------------------------------------
// migration idempotency
// ---------------------------------------------------------------------------
test("migration 94 (belief_dispositions) is idempotent", () => {
  const migration = MIGRATIONS.find((m) => m.version === 94);
  assert.ok(migration, "migration 94 is registered");
  migration.up(db);
  migration.up(db); // a second pass must not throw
  const columns = new Set(db.prepare("PRAGMA table_info(belief_dispositions)").all().map((r) => r.name));
  for (const col of ["id", "source", "status", "disputed_at", "created_at", "updated_at"]) {
    assert.ok(columns.has(col), `belief_dispositions has ${col}`);
  }
});

// ---------------------------------------------------------------------------
// learned models
// ---------------------------------------------------------------------------
function seedSleepFuelCorrelation() {
  for (let i = 1; i <= 5; i++) {
    db.prepare(
      `INSERT INTO daily_metrics (source, date, sleep_min, updated_at) VALUES ('apple', ?, 300, datetime('now'))`
    ).run(isoDaysAgo(i));
    db.prepare(`INSERT INTO fueling_feedback (date, hunger, decision_id) VALUES (?, 3, 1)`).run(isoDaysAgo(i));
  }
  for (let i = 6; i <= 10; i++) {
    db.prepare(
      `INSERT INTO daily_metrics (source, date, sleep_min, updated_at) VALUES ('apple', ?, 480, datetime('now'))`
    ).run(isoDaysAgo(i));
    db.prepare(`INSERT INTO fueling_feedback (date, hunger, decision_id) VALUES (?, 1, 1)`).run(isoDaysAgo(i));
  }
}

test("disputing a learned model excludes it from the coach read but keeps it in set_aside", () => {
  seedSleepFuelCorrelation();
  saveLearnedModels();
  const id = learnedModelBeliefId("sleep_fuel_correlation");

  assert.ok(
    learnedModelsForCoach().patterns.some((p) => p.id === "sleep_fuel_correlation"),
    "active before any dispute"
  );

  const disputed = disputeBelief(id);
  assert.ok(disputed, "dispute returns the row");
  assert.equal(disputed.disputed, true);
  assert.ok(isBeliefDisputed(id));

  assert.ok(
    !learnedModelsForCoach().patterns.some((p) => p.id === "sleep_fuel_correlation"),
    "excluded from the coach-facing read once disputed"
  );

  const view = listBeliefs();
  const learnedGroup = view.groups.find((g) => g.kind === "learned_model");
  assert.ok(!learnedGroup.rows.some((r) => r.id === id), "not in the active group");
  assert.ok(view.set_aside.some((r) => r.id === id), "visible under set_aside");

  const restored = undisputeBelief(id);
  assert.equal(restored.disputed, false);
  assert.ok(
    learnedModelsForCoach().patterns.some((p) => p.id === "sleep_fuel_correlation"),
    "restored to the coach-facing read"
  );
});

test("a rebuild never resurrects a disputed learned model into the coach-facing read", () => {
  seedSleepFuelCorrelation();
  saveLearnedModels();
  disputeBelief(learnedModelBeliefId("sleep_fuel_correlation"));
  assert.ok(!learnedModelsForCoach().patterns.some((p) => p.id === "sleep_fuel_correlation"));

  // The deterministic builder recomputes the SAME statement from the same data —
  // rebuilding must not un-dispute it.
  const fresh = buildLearnedModels().patterns.find((p) => p.id === "sleep_fuel_correlation");
  assert.ok(fresh, "the builder itself is unaware of dispute state and recomputes it verbatim");
  saveLearnedModels();
  assert.ok(
    !learnedModelsForCoach().patterns.some((p) => p.id === "sleep_fuel_correlation"),
    "the coach-facing read still excludes it after the rebuild"
  );
});

// ---------------------------------------------------------------------------
// felt signals
// ---------------------------------------------------------------------------
function seedCheckinSignal() {
  for (let i = 1; i <= 6; i++) {
    db.prepare(`INSERT INTO checkins (date, energy) VALUES (?, 1)`).run(isoDaysAgo(i));
  }
}

test("disputing a felt-signal correlation excludes it from the coach read but keeps it in set_aside", () => {
  seedCheckinSignal();
  saveFeltSignals();
  const id = feltSignalBeliefId("checkin_energy");

  assert.ok(feltSignalsForCoach().patterns.some((p) => p.id === "checkin_energy"), "active before dispute");
  disputeBelief(id);
  assert.ok(!feltSignalsForCoach().patterns.some((p) => p.id === "checkin_energy"), "excluded once disputed");

  const view = listBeliefs();
  assert.ok(view.set_aside.some((r) => r.id === id));

  undisputeBelief(id);
  assert.ok(feltSignalsForCoach().patterns.some((p) => p.id === "checkin_energy"), "restored");
});

test("a felt-signal rebuild never resurrects a disputed pattern into the coach-facing read", () => {
  seedCheckinSignal();
  saveFeltSignals();
  disputeBelief(feltSignalBeliefId("checkin_energy"));
  const fresh = buildFeltSignals().patterns.find((p) => p.id === "checkin_energy");
  assert.ok(fresh, "the builder recomputes the same pattern");
  saveFeltSignals();
  assert.ok(!feltSignalsForCoach().patterns.some((p) => p.id === "checkin_energy"));
});

// ---------------------------------------------------------------------------
// personal-response modifiers (whatWorksForYou)
// ---------------------------------------------------------------------------
function seedNutritionStepModifier() {
  for (const key of ["a", "b"]) {
    const recorded = recordDecision(
      {
        effective_date: "2026-01-01",
        kind: "nutrition_target",
        domain: "training",
        summary: `weight_trend_lb_wk ${key}.`,
        rationale: "A bounded change, measured before the default moves again.",
        source: "test",
        source_ref_type: null,
        source_ref_key: null,
        status: "applied",
        autonomy_tier: "quiet_apply",
        risk_class: "low",
        reversible: true,
        input_fingerprint: null,
        context: {},
        action: { slot: `nutrition-${key}` },
        specialist: null,
        applied_at: "2026-01-01T12:00:00.000Z",
        reverted_at: null,
        superseded_by: null,
        evaluator_version: "belief-test-v1",
      },
      [
        {
          metric_key: "weight_trend_lb_wk",
          subject_key: null,
          direction: "within_band",
          baseline: { value: -1.2, recomposition_stage: "mid_cut" },
          target: { min: -1, max: -0.2 },
          window_start: "2026-01-01",
          window_end: "2026-01-29",
          minimum_data: null,
          confounder_policy: "standard",
          confidence: "tentative",
          evaluator: "weight_trend",
          evaluator_version: "belief-test-v1",
        },
      ]
    );
    const evaluation = insertBrainEvaluation({
      expectation_id: recorded.expectations[0].id,
      verdict: "aligned",
      actual: { value: -0.5, weigh_ins: 8 },
      evidence_keys: [`weight_trend_lb_wk:2026-01-01..2026-01-29:n=8`],
      confounders: [],
      explanation: "The observed result landed within the expectation.",
      evaluator_version: "belief-test-v1",
    });
    db.prepare(`UPDATE brain_evaluations SET evaluated_at = ? WHERE id = ?`).run(
      `${addDaysISO(localDateISO(), 0)} 12:00:00`,
      evaluation.id
    );
  }
}

test("disputing a personal-response modifier excludes it from modifier application but keeps it in set_aside", () => {
  seedNutritionStepModifier();
  const before = whatWorksForYou();
  const modifier = before.modifiers.find((m) => m.target === "nutrition_step");
  assert.ok(modifier, "the modifier was learned");
  const id = personalModifierBeliefId(modifier.key);

  disputeBelief(id);
  const after = whatWorksForYou();
  assert.ok(
    !after.modifiers.some((m) => m.key === modifier.key),
    "excluded from whatWorksForYou() once disputed"
  );
  assert.equal(
    personalResponseModifierFor("nutrition_step"),
    null,
    "the consumer-facing lookup no longer resolves"
  );

  const view = listBeliefs();
  assert.ok(view.set_aside.some((r) => r.id === id), "visible under set_aside");
  const modifierGroup = view.groups.find((g) => g.kind === "personal_modifier");
  assert.ok(!modifierGroup.rows.some((r) => r.id === id));

  undisputeBelief(id);
  assert.ok(
    whatWorksForYou().modifiers.some((m) => m.key === modifier.key),
    "restored to whatWorksForYou() after un-dispute"
  );
});

// ---------------------------------------------------------------------------
// listBeliefs() shape
// ---------------------------------------------------------------------------
test("listBeliefs groups the three sources and links (never duplicates) directives", () => {
  const view = listBeliefs();
  const kinds = view.groups.map((g) => g.kind);
  assert.deepEqual(kinds, ["learned_model", "felt_signal", "personal_modifier"]);
  assert.equal(typeof view.directives.active_count, "number");
  assert.equal(typeof view.directives.note, "string");
  assert.ok(Array.isArray(view.set_aside));
});

test("evidence is spoken in words, never a bare digit, on a belief row", () => {
  seedSleepFuelCorrelation();
  saveLearnedModels();
  const view = listBeliefs();
  const row = view.groups.find((g) => g.kind === "learned_model").rows.find((r) => r.id.includes("sleep_fuel"));
  assert.ok(row, "the row is present");
  assert.doesNotMatch(row.why, /\b\d+\b/, "the why-line carries no bare number");
});
