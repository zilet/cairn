import { test } from "node:test";
import assert from "node:assert/strict";
import { recordDecision } from "../dist/domain/brain/decision-service.js";
import { planUpcomingNote } from "../dist/domain/training/plan-upcoming.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import * as repo from "../dist/repo.js";

// Dates are relative to the real "today" because planUpcomingNote() reads the
// live clock (no asOf param) — a fixed date would drift as the calendar moves.
const inDays = (n) => addDaysISO(localDateISO(), n);

function decision(overrides = {}) {
  return {
    effective_date: inDays(3),
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

test("planUpcomingNote surfaces training + recovery changes, dropping other domains, soonest-first", () => {
  recordDecision(decision({ effective_date: inDays(2), summary: "training tweak", domain: "training", action: { proposal_id: 11 } }));
  recordDecision(decision({ effective_date: inDays(4), summary: "recovery week lands", domain: "recovery", action: { proposal_id: 12 } }));
  // Off the Plan tab: nutrition/health live on their own surfaces.
  recordDecision(decision({ effective_date: inDays(3), summary: "nutrition target", domain: "nutrition", action: { proposal_id: 13 } }));
  recordDecision(decision({ effective_date: inDays(3), summary: "lab flag", domain: "health", action: { proposal_id: 14 } }));

  const note = planUpcomingNote();
  assert.ok(note, "a note is present");
  assert.deepEqual(
    note.items.map((i) => i.summary),
    ["training tweak", "recovery week lands"]
  );
  assert.ok(note.items.every((i) => i.domain === "training" || i.domain === "recovery"));
});

test("planUpcomingNote dedupes against the recovery banner's draft proposal", () => {
  const draft = repo.createProposal(
    "auto",
    `${repo.RECOVERY_WEEK_INSTRUCTION_PREFIX} week — pull the volume back so the body absorbs the block.`,
    "",
    { summary: "A lighter recovery week.", days: [{ day_number: 1, name: "Recovery", focus: "Recovery", items: [] }] }
  );
  const rs = repo.recoveryWeekStatus();
  assert.equal(rs.state, "drafted");
  assert.equal(rs.proposal_id, draft.id);

  // The announced decision FOR that same recovery draft — the recovery banner
  // already shows it, so the forward note must not repeat it.
  recordDecision(decision({ effective_date: inDays(2), summary: "recovery draft (already on banner)", domain: "recovery", action: { proposal_id: rs.proposal_id } }));
  // A distinct training change still surfaces.
  recordDecision(decision({ effective_date: inDays(5), summary: "distinct training change", domain: "training", action: { proposal_id: 999 } }));

  const note = planUpcomingNote();
  assert.ok(note);
  assert.deepEqual(
    note.items.map((i) => i.summary),
    ["distinct training change"]
  );
});

test("planUpcomingNote is null when nothing training/recovery is waiting in the window", () => {
  assert.equal(planUpcomingNote(), null);
  // Beyond the 10-day forward window → still null.
  recordDecision(decision({ effective_date: inDays(40), summary: "far future" }));
  assert.equal(planUpcomingNote(), null);
  // Only an off-tab domain waiting → still null on the Plan surface.
  recordDecision(decision({ effective_date: inDays(3), summary: "nutrition only", domain: "nutrition", action: { proposal_id: 21 } }));
  assert.equal(planUpcomingNote(), null);
});
