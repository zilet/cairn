import { test } from "node:test";
import assert from "node:assert/strict";
import { recordDecision } from "../dist/domain/brain/decision-service.js";
import {
  awaitingBrainDecisions,
  landedBrainDecisions,
  recentAppliedRotations,
  upcomingBrainDecisions,
} from "../dist/repo/brain-decisions.js";
import { db } from "../dist/db.js";
import { runWithTimeZone } from "../dist/tz.js";

function decision(overrides = {}) {
  return {
    effective_date: "2026-07-13",
    kind: "training_structure",
    domain: "training",
    summary: "Recovery week — volume halves, same movements.",
    rationale: null,
    source: "autonomy",
    source_ref_type: "plan_proposal",
    source_ref_key: "7",
    status: "announced",
    autonomy_tier: "announce",
    risk_class: "moderate",
    reversible: true,
    input_fingerprint: null,
    context: {},
    action: { proposal_id: 7 },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
    ...overrides,
  };
}

test("upcomingBrainDecisions returns announced + quiet-pending inside the forward window, sorted by date", () => {
  recordDecision(decision({ effective_date: "2026-07-15", summary: "later announce" }));
  recordDecision(decision({ effective_date: "2026-07-11", summary: "sooner announce" }));
  recordDecision(
    decision({
      effective_date: "2026-07-12",
      status: "pending",
      autonomy_tier: "quiet_apply",
      kind: "training_target",
      risk_class: "low",
      summary: "quiet pending change",
    })
  );
  // Excluded: pending but ask-tier, past effective_date, beyond the window.
  recordDecision(
    decision({ effective_date: "2026-07-12", status: "pending", autonomy_tier: "ask", summary: "ask pending" })
  );
  recordDecision(decision({ effective_date: "2026-07-09", summary: "already landed" }));
  recordDecision(decision({ effective_date: "2026-08-30", summary: "far future" }));

  const upcoming = upcomingBrainDecisions(10, "2026-07-10");
  assert.deepEqual(
    upcoming.map((d) => d.summary),
    ["sooner announce", "quiet pending change", "later announce"]
  );
  assert.equal(upcoming[0].effective_date, "2026-07-11");
  assert.ok(upcoming.every((d) => d.domain === "training"));
});

test("recentAppliedRotations reads structured action.swaps and legacy instruction text", () => {
  recordDecision(
    decision({
      status: "applied",
      kind: "exercise_rotation",
      autonomy_tier: "ask",
      effective_date: "2026-07-10",
      applied_at: "2026-07-10T12:00:00.000Z",
      summary: "Rotate DB Bench Press → Incline Bench Press on day 2",
      action: { proposal_id: 9, swaps: [{ day_number: 2, from: "DB Bench Press", to: "Incline Bench Press" }] },
    })
  );
  recordDecision(
    decision({
      status: "applied",
      kind: "training_target",
      autonomy_tier: "ask",
      risk_class: "low",
      effective_date: "2026-07-08",
      applied_at: "2026-07-08T09:00:00.000Z",
      summary: "legacy swap decision",
      context: { instruction: "swap Barbell Bench Press -> DB Bench Press" },
      action: { proposal_id: 4 },
    })
  );
  // Excluded: outside the window, and a non-swap applied decision.
  recordDecision(
    decision({
      status: "applied",
      kind: "training_target",
      autonomy_tier: "ask",
      effective_date: "2026-05-01",
      applied_at: "2026-05-01T09:00:00.000Z",
      summary: "old swap",
      context: { instruction: "swap Old Lift -> New Lift" },
      action: { proposal_id: 2 },
    })
  );
  recordDecision(
    decision({
      status: "applied",
      kind: "training_target",
      autonomy_tier: "ask",
      effective_date: "2026-07-09",
      applied_at: "2026-07-09T09:00:00.000Z",
      summary: "plain target bump",
      context: { instruction: "weekly auto-evolution" },
      action: { proposal_id: 5 },
    })
  );

  const rotations = recentAppliedRotations(21, "2026-07-10");
  assert.deepEqual(
    rotations.map((r) => `${r.from} -> ${r.to}`).sort(),
    ["Barbell Bench Press -> DB Bench Press", "DB Bench Press -> Incline Bench Press"]
  );
  const structured = rotations.find((r) => r.to === "Incline Bench Press");
  assert.equal(structured.date, "2026-07-10");
});

// `applied_at`/`created_at` are INSTANTS, stamped by datetime('now') in UTC, while
// every window in this module is a LOCAL calendar day. West of Greenwich the two
// disagree all evening: 05:00 UTC on the 11th is 6 PM on the 10th in a UTC-11 zone.
// Reading the instant's first ten characters dated those decisions a day into the
// future — the landed window (whose far edge is today) dropped them entirely, and a
// rotation the athlete made this evening was reported as tomorrow's.
const EVENING_ZONE = "Pacific/Midway"; // UTC-11
const LOCAL_DAY = "2026-07-10";
const EVENING_INSTANT = "2026-07-11T05:00:00.000Z"; // 18:00 on LOCAL_DAY in that zone

test("a change that landed this evening is dated to the local day, not tomorrow's UTC one", () => {
  recordDecision(
    decision({
      status: "applied",
      effective_date: null,
      applied_at: EVENING_INSTANT,
      summary: "evening landing",
    })
  );

  const landed = runWithTimeZone(EVENING_ZONE, () => landedBrainDecisions(7, LOCAL_DAY));
  assert.equal(landed.length, 1, "the change belongs to the window it landed inside");
  assert.equal(landed[0].landed_date, LOCAL_DAY);
});

test("an evening rotation is reported on the local day it was made", () => {
  recordDecision(
    decision({
      status: "applied",
      kind: "exercise_rotation",
      effective_date: null,
      applied_at: EVENING_INSTANT,
      summary: "Rotate DB Bench Press → Incline Bench Press on day 2",
      action: { proposal_id: 9, swaps: [{ day_number: 2, from: "DB Bench Press", to: "Incline Bench Press" }] },
    })
  );

  const rotations = runWithTimeZone(EVENING_ZONE, () => recentAppliedRotations(21, LOCAL_DAY));
  assert.equal(rotations.length, 1);
  assert.equal(rotations[0].date, LOCAL_DAY);
});

test("an open question raised this evening is dated to the local day it was raised", () => {
  const recorded = recordDecision(
    decision({
      status: "review",
      effective_date: null,
      summary: "a question that is still waiting",
      action: { proposal_id: 7, user_explanation: "Your calorie target would move; say the word." },
    })
  );
  // created_at is written by SQLite in UTC and cannot be passed in, so it is stamped
  // here the way an evening decision would carry it.
  db.prepare(`UPDATE brain_decisions SET created_at = ? WHERE id = ?`).run(
    "2026-07-11 05:00:00",
    Number(recorded.decision.id),
  );

  const waiting = runWithTimeZone(EVENING_ZONE, () => awaitingBrainDecisions());
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].decided_date, LOCAL_DAY);
});
