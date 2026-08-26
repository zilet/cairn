import { test } from "node:test";
import assert from "node:assert/strict";
import { RECOVERY_WEEK_INSTRUCTION, RECOVERY_WEEK_INSTRUCTION_PREFIX, shouldAutoDraftRecoveryWeek } from "../dist/repo/profile.js";

// The lead-mode recovery auto-draft (scheduler tick g) keys off the SAME conductor
// read that renders "your coach sets this up automatically" — these are the guards
// that keep that promise honest without ever double-drafting.

test("auto-drafts exactly when the conductor's recovery ASK is live under lead mode", () => {
  const asking = {
    lead_mode: "lead",
    focus_lead_domain: "recovery",
    recovery_active: false,
    status: null,
    deload_due: true,
  };
  assert.equal(shouldAutoDraftRecoveryWeek(asking), true);
  assert.equal(shouldAutoDraftRecoveryWeek({ ...asking, deload_due: undefined, mesocycle_phase: "deload-due" }), true);

  // Any other posture: the athlete drives it.
  assert.equal(shouldAutoDraftRecoveryWeek({ ...asking, lead_mode: "announce_first" }), false);
  assert.equal(shouldAutoDraftRecoveryWeek({ ...asking, lead_mode: "review_everything" }), false);
  // Recovery isn't the lead (nothing due) — no draft.
  assert.equal(shouldAutoDraftRecoveryWeek({ ...asking, focus_lead_domain: "training" }), false);
  assert.equal(shouldAutoDraftRecoveryWeek({ ...asking, focus_lead_domain: null }), false);
  // The week is already RUNNING — confirmation state, never a new draft.
  assert.equal(shouldAutoDraftRecoveryWeek({ ...asking, recovery_active: true }), false);
  // A draft (or applied week) already exists in the state machine — never stack.
  assert.equal(shouldAutoDraftRecoveryWeek({ ...asking, status: { state: "drafted", proposal_id: 7 } }), false);
  assert.equal(shouldAutoDraftRecoveryWeek({ ...asking, status: { state: "applied", applied_on: "2026-07-10" } }), false);
  // Without deload-due, recovering-down alone must not auto-draft a recovery week.
  assert.equal(shouldAutoDraftRecoveryWeek({ ...asking, deload_due: false }), false);
  assert.equal(shouldAutoDraftRecoveryWeek({ ...asking, deload_due: undefined }), false);
  assert.equal(shouldAutoDraftRecoveryWeek({ ...asking, deload_due: undefined, mesocycle_phase: "accumulation" }), false);
});

test("the canonical instruction is prefix-compatible with the recovery state machine", () => {
  // pendingRecoveryDraft / supersedeRecoveryWeekDrafts match on the PREFIX — the
  // auto-draft must be recognized as the same thing as the one-tap draft.
  assert.ok(RECOVERY_WEEK_INSTRUCTION.startsWith(RECOVERY_WEEK_INSTRUCTION_PREFIX));
});
