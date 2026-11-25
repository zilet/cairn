import { test } from "node:test";
import assert from "node:assert/strict";
import { RECOVERY_WEEK_INSTRUCTION, RECOVERY_WEEK_INSTRUCTION_PREFIX } from "../dist/repo/recovery-week.js";
import { recoveryWeekHold } from "../dist/repo/recovery-week-earned.js";
import { nextNaturalBoundary } from "../dist/brain/autonomy.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { db } from "./_seed.js";

// The earned recovery week (scheduler tick g) is set up by the server itself
// (recovery-week-change.ts, covered end to end in recoveryWeekChange.test.js). These are
// the two contracts it keeps with the rest of the recovery-week state machine.

test("the canonical instruction is prefix-compatible with the recovery state machine", () => {
  // pendingRecoveryDraft / supersedeRecoveryWeekDrafts match on the PREFIX — the
  // earned week must be recognized as the same thing as the one-tap draft.
  assert.ok(RECOVERY_WEEK_INSTRUCTION.startsWith(RECOVERY_WEEK_INSTRUCTION_PREFIX));
});

test("the athlete's standing 'no' to a recovery week holds the earned week until a safety-grade signal", () => {
  const today = localDateISO();
  const landsOn = nextNaturalBoundary("training_structure", today);
  const refusedOn = addDaysISO(today, -3);
  db.prepare(
    `INSERT INTO brain_decisions (effective_date, kind, domain, summary, status, autonomy_tier, risk_class, context_json, created_at)
     VALUES (?, 'training_structure', 'recovery', 'Recovery week', 'canceled', 'announce', 'structural', ?, ?)`
  ).run(refusedOn, JSON.stringify({ held_by_user: true, held_by_user_on: refusedOn }), `${refusedOn} 08:00:00`);
  const held = recoveryWeekHold(today, landsOn);
  assert.equal(held.status, "hold");
  assert.equal(held.reason, "refused", "deload-due alone does not argue with the refusal");

  const yesterday = addDaysISO(today, -1);
  // A tap alone only eases a day (owner ruling, 2026-09-29), so alone it is not news.
  db.prepare(`INSERT INTO checkins (date, energy, sleep_feel) VALUES (?, 2, 3)`).run(yesterday);
  assert.equal(recoveryWeekHold(today, landsOn).reason, "refused", "a lone low tap does not argue with the refusal");
  // Corroborated by something objective about the same 24 hours, it is.
  db.prepare(`INSERT INTO daily_metrics (source, date, sleep_min) VALUES ('apple', ?, 270)`).run(yesterday);
  assert.equal(recoveryWeekHold(today, landsOn).status, "clear", "a corroborated low check-in since is news the refusal did not answer");
});
