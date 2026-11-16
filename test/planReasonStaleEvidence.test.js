import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import { db } from "../dist/db.js";
import { recordDecision } from "../dist/repo/brain-decisions.js";

const REASON = "140 went 5 and 7 with a rep or two left on 2026-10-13. The load holds until every set reaches 8 with two in hand.";

function seed() {
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Stale Reason Bench", sets: 3, rep_low: 6, rep_high: 8, target_weight: 140 },
  ]);
  return recordDecision({
    effective_date: "2026-10-15",
    kind: "training_target",
    domain: "training",
    summary: "Hold the bench load.",
    rationale: "Hold.",
    source: "legacy",
    source_ref_type: "plan_proposal",
    source_ref_key: "1",
    status: "applied",
    autonomy_tier: "quiet_apply",
    risk_class: "low",
    reversible: true,
    input_fingerprint: null,
    context: {},
    action: {
      changes: [
        {
          day_number: 1,
          exercise: "Stale Reason Bench",
          target_weight: 140,
          reason: REASON,
          reason_provenance: {
            reason_code: "hold_until_top_of_range",
            evidence_date: "2026-10-13",
            as_of_date: "2026-10-15",
            source_ref_type: "session",
            source_ref_key: "88",
          },
        },
      ],
    },
    specialist: null,
    applied_at: "2026-10-15T12:00:00Z",
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  });
}

const item = () => repo.getPlanDay(1).items[0];
const ledger = () => JSON.stringify(db.prepare(`SELECT action_json, rationale, summary FROM brain_decisions ORDER BY id`).all());
const log = (date, reps) =>
  repo.logSetByName({ date, exercise: "Stale Reason Bench", weight: 140, reps, day_number: null });

test("the reason stays while no newer exposure exists", () => {
  seed();
  assert.ok(item().brain_change_reason, "no logged exposure yet");
  log("2026-10-13", 7);
  assert.ok(item().brain_change_reason, "the evidence day itself is not newer");
  assert.ok(item().brain_change_reason_provenance);
});

test("a later exposure retires the dated sentence and leaves the ledger untouched", () => {
  seed();
  log("2026-10-13", 7);
  const before = ledger();
  log("2026-11-09", 8);
  const it = item();
  assert.equal(it.brain_change_reason, null);
  assert.equal(it.brain_change_reason_provenance, null);
  assert.ok(it.brain_decision_id, "the decision link (and its Undo) stays");
  assert.equal(ledger(), before);
  assert.match(before, /went 5 and 7/, "the stored sentence is still in the ledger");
});
