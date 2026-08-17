// The plan-shaping proposal paths now route through the autonomy layer (the
// "lead & start" round): under lead_mode='lead' a bounded, reversible adaptation
// (auto-progression target nudges; a weekly evolution) is applied by the existing
// autonomy-service machinery at its natural boundary — with the decision + one-tap
// Undo bookkeeping it already owns — while a structural restructure announces first
// and goal/clinical still ask. These tests pin that wiring end to end, offline:
//   (1)  lead + a progression draft → quiet-applies now with a decision + undo
//   (1b) lead + a progression waiting on an active session → lands at the boundary pass
//   (2)  review_everything → nothing auto-applies (the draft parks exactly as before)
//   (3)  lead + a structural days-restructure → ANNOUNCES first, never quiet-applies
//   (4)  lead + the recovery-week proposal → a bounded cycle overlay lands without replacing the plan
// evolveProgram itself needs a CLI agent, so its structural/evolution wiring is proven
// at the layer it delegates to (applyProposalWithAutonomy) — the same call it now makes.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDueAnnouncedDecisions,
  applyProposalWithAutonomy,
  buildProgressionWithAutonomy,
  revertDecision,
} from "../dist/domain/brain/autonomy-service.js";
import * as repo from "../dist/repo.js";
import { localDateISO } from "../dist/repo/shared.js";
import { db } from "../dist/db.js";

function isoDaysAgo(n) {
  return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
}

// Direct logged_sets insert via the shared DB singleton (there's no public raw-set
// repo API; mirrors the seeding in test/progression.test.js).
function dbInsertSet(sessionId, exId, { set_number = 1, weight = null, reps = null, rir = null, duration_sec = null }) {
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir, duration_sec)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(sessionId, exId, set_number, weight, reps, rir, duration_sec);
}

// A bench lift with a history that EARNS a clamped overload (+5 lb) on the next
// exposure: three progressing sessions, the last at the top of the 6–8 range at RIR 2,
// all ≥10 days ago so the acute-recovery brake never trips.
function seedEarnedOverload() {
  repo.upsertExercise({ name: "Barbell Bench Press", muscle_group: "chest" });
  repo.savePlanDay(1, "Push", "Push", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 },
  ]);
  const ex = repo.findExercise("Barbell Bench Press");
  for (const [daysAgo, w] of [
    [28, 175],
    [21, 180],
    [10, 185],
  ]) {
    const sess = repo.getOrCreateSession(isoDaysAgo(daysAgo), null);
    dbInsertSet(sess.id, ex.id, { set_number: 1, weight: w, reps: 8, rir: 2 });
  }
}

test("lead mode: an auto-progression draft quiet-applies now with a decision + one-tap undo", () => {
  seedEarnedOverload();
  repo.setSettings({ lead_mode: "lead" });

  const out = buildProgressionWithAutonomy(1);
  assert.equal(out.ok, true);
  assert.equal(out.autonomy.tier, "quiet_apply");
  assert.equal(out.autonomy.ok, true, "no lived-in session today → applies immediately");
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 190, "the earned +5 lb landed");
  assert.equal(out.autonomy.decision.context.rollback_available, true);
  assert.ok(repo.getBrainRollback(out.autonomy.decision.id), "an undo snapshot was stored");

  const reverted = revertDecision(out.autonomy.decision.id, "put it back");
  assert.equal(reverted.ok, true);
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 185, "one-tap Undo restores the plan");
  assert.equal(repo.getBrainDecision(out.autonomy.decision.id).status, "reverted");
});

test("lead mode: a progression waiting on an active session lands at the boundary pass", () => {
  seedEarnedOverload();
  // An unfinished session TODAY (an unrelated lift) makes the bounded change WAIT for
  // the next natural boundary rather than change a day the athlete is mid-way through.
  repo.upsertExercise({ name: "Plank", muscle_group: "core", mode: "timed" });
  const plank = repo.getOrCreateSession(localDateISO(), null);
  dbInsertSet(plank.id, repo.findExercise("Plank").id, { set_number: 1, duration_sec: 60 });
  repo.setSettings({ lead_mode: "lead" });

  const out = buildProgressionWithAutonomy(1);
  assert.equal(out.ok, true);
  assert.equal(out.autonomy.pending, true);
  assert.equal(out.autonomy.tier, "quiet_apply");
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 185, "not changed until the boundary");

  const due = applyDueAnnouncedDecisions(out.autonomy.effective_date);
  assert.deepEqual(due.applied, [out.autonomy.decision.id]);
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 190, "the boundary pass applied it, no tap");
  assert.ok(repo.getBrainRollback(out.autonomy.decision.id), "the boundary apply stored an undo snapshot");
});

test("review_everything: a progression stays a plain reviewable draft — nothing auto-applies", () => {
  seedEarnedOverload();
  repo.setSettings({ lead_mode: "review_everything" });

  const out = buildProgressionWithAutonomy(1);
  assert.equal(out.ok, true);
  assert.equal(out.autonomy.applied, false);
  assert.equal(out.autonomy.tier, "ask");
  assert.equal(repo.getProposal(out.proposal.id).status, "draft", "the draft parks exactly as today");
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 185, "the plan is untouched");
  const reviews = repo.listBrainDecisions({ kind: "training_target" });
  assert.equal(reviews.length, 1, "review_everything persists why the athlete's decision is required");
  assert.equal(reviews[0].status, "review");
  assert.equal(reviews[0].context?.review_reason_code, "review_posture");
});

test("lead mode: a structural days-restructure announces first, never quiet-applies", () => {
  repo.savePlanDay(1, "Full", "Full", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 115 },
  ]);
  repo.setSettings({ lead_mode: "lead" });
  // evolveProgram persists a parsed.days proposal for a split/frequency change, then makes
  // exactly this call (no requested_tier). A structural change → kind 'training_structure'.
  const proposal = repo.createProposal("auto", repo.AUTO_EVOLUTION_INSTRUCTION, "", {
    summary: "Move to a 2-day upper/lower split",
    days: [
      {
        day_number: 1,
        name: "Upper",
        focus: "Upper",
        items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 115 }],
      },
      {
        day_number: 2,
        name: "Lower",
        focus: "Lower",
        items: [{ exercise: "Back Squat", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 }],
      },
    ],
  });

  const out = applyProposalWithAutonomy(proposal.id);
  assert.equal(out.announced, true, "structural change announces first, even in lead mode");
  assert.equal(out.tier, "announce");
  assert.equal(repo.getPlan().length, 1, "the split is not restructured until the boundary");

  const due = applyDueAnnouncedDecisions(out.effective_date);
  assert.deepEqual(due.applied, [out.decision.id]);
  assert.equal(repo.getPlan().length, 2, "the boundary pass applied the restructure");
});

test("lead mode: a recovery proposal lands as a reversible overlay without replacing the plan", () => {
  repo.savePlanDay(1, "Full", "Full", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 },
  ]);
  repo.createBlock({ goal: "Build strength", focus: "strength", phase: "accumulation", week_index: 2, total_weeks: 6 });
  repo.setSettings({ lead_mode: "lead" });
  // The one-tap recovery week is a structural reshape tagged by the stable instruction prefix.
  const proposal = repo.createProposal(
    "auto",
    `${repo.RECOVERY_WEEK_INSTRUCTION_PREFIX} week — pull the volume back so the body absorbs the block.`,
    "",
    {
      summary: "A lighter recovery week.",
      days: [
        {
          day_number: 1,
          name: "Recovery Full",
          focus: "Recovery",
          items: [{ exercise: "Barbell Bench Press", sets: 2, rep_low: 5, rep_high: 6, target_weight: 155 }],
        },
      ],
    }
  );

  const out = applyProposalWithAutonomy(proposal.id);
  assert.equal(out.announced, true);
  assert.equal(
    repo.recoveryWeekStatus().state,
    "upcoming",
    "it waits with an effective date, visible as an automatically scheduled recovery week"
  );

  const due = applyDueAnnouncedDecisions(out.effective_date);
  assert.deepEqual(due.applied, [out.decision.id]);
  assert.equal(repo.getProposal(proposal.id).status, "applied");
  assert.equal(
    repo.recoveryWeekStatus(out.effective_date).state,
    "applied",
    "the cycle is active at the server-owned boundary"
  );
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 185, "the base weekly plan remains unchanged");

  const undone = revertDecision(out.decision.id, "continue the prior build");
  assert.equal(undone.ok, true);
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 185, "Undo does not rewrite the base plan");
  assert.equal(repo.getProposal(proposal.id).status, "reverted", "the recovery proposal is no longer authoritative");
  assert.equal(repo.recoveryWeekStatus(out.effective_date), null, "Undo cancels the owned recovery cycle");
  assert.equal(repo.blockForCoach()?.phase, "accumulation", "the prior program phase resumes");
});

// A structural two-day proposal used by the retired-draft tests below.
function structuralParsed(name = "Two-day structure") {
  return {
    summary: name,
    days: [
      {
        day_number: 1,
        name: "Upper",
        focus: "Upper",
        items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 115 }],
      },
      {
        day_number: 2,
        name: "Lower",
        focus: "Lower",
        items: [{ exercise: "Back Squat", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 }],
      },
    ],
  };
}

function seedOneDayPlan() {
  repo.savePlanDay(1, "Full", "Full", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 115 },
  ]);
}

test("a changes[]-with-swap proposal classifies as an exercise rotation (quiet_apply, low risk)", () => {
  // A lived-in session today forces the bounded change to WAIT — the pending path
  // records the decision with the classified kind, independent of the swap apply.
  repo.upsertExercise({ name: "Plank", muscle_group: "core", mode: "timed" });
  const plank = repo.getOrCreateSession(localDateISO(), null);
  dbInsertSet(plank.id, repo.findExercise("Plank").id, { set_number: 1, duration_sec: 60 });
  repo.setSettings({ lead_mode: "lead" });

  const proposal = repo.createProposal("stub", "rotate the stalled bench out", "", {
    summary: "Rotate DB Bench Press in for Barbell Bench Press",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", swap: "DB Bench Press" }],
  });
  const out = applyProposalWithAutonomy(proposal.id);
  assert.equal(out.tier, "quiet_apply", "a reversible rotation quiet-applies under lead mode");
  assert.equal(out.pending, true, "held for the boundary behind the lived-in session");

  const rotations = repo.listBrainDecisions({ kind: "exercise_rotation" });
  assert.equal(rotations.length, 1, "the swap proposal is ledgered as an exercise rotation");
  assert.equal(rotations[0].domain, "training");
  assert.equal(rotations[0].risk_class, "low");
  // A swap must NOT read as a bare target tweak.
  assert.equal(repo.listBrainDecisions({ kind: "training_target" }).length, 0);
});

test("a discarded proposal's standing announcement cancels at once and the boundary never applies it", () => {
  seedOneDayPlan();
  repo.setSettings({ lead_mode: "lead" });
  const proposal = repo.createProposal("auto", "restructure", "", structuralParsed());
  const out = applyProposalWithAutonomy(proposal.id);
  assert.equal(out.announced, true);

  // The user's explicit veto (the /proposals/:id/discard path).
  repo.setProposalStatus(proposal.id, "discarded");
  assert.equal(
    repo.getBrainDecision(out.decision.id).status,
    "canceled",
    "retiring the draft cancels the standing announcement immediately"
  );

  const due = applyDueAnnouncedDecisions(out.effective_date);
  assert.deepEqual(due.applied, [], "the vetoed restructure never lands at the boundary");
  assert.equal(repo.getPlan().length, 1, "the plan is untouched");
});

test("supersedeAutoEvolutionDrafts cancels the retired draft's announcement — the boundary skips it", () => {
  seedOneDayPlan();
  repo.setSettings({ lead_mode: "lead" });
  const older = repo.createProposal("auto", repo.AUTO_EVOLUTION_INSTRUCTION, "", structuralParsed("Stale evolution"));
  const out = applyProposalWithAutonomy(older.id);
  assert.equal(out.announced, true);

  // A fresh weekly auto-evolution draft retires the prior one (the scheduler's dedup).
  const newer = repo.createProposal("auto", repo.AUTO_EVOLUTION_INSTRUCTION, "", structuralParsed("Fresh evolution"));
  repo.supersedeAutoEvolutionDrafts(newer.id);
  assert.equal(repo.getProposal(older.id).status, "superseded");
  assert.equal(
    repo.getBrainDecision(out.decision.id).status,
    "canceled",
    "superseding the draft cancels its standing announcement"
  );

  const due = applyDueAnnouncedDecisions(out.effective_date);
  assert.deepEqual(due.applied, [], "the superseded restructure never lands");
  assert.equal(repo.getPlan().length, 1, "the stale restructure cannot clobber the plan");
});

test("defense in depth: the boundary refuses any proposal that is no longer a live draft", () => {
  seedOneDayPlan();
  repo.setSettings({ lead_mode: "lead" });
  const proposal = repo.createProposal("auto", "restructure", "", structuralParsed());
  const out = applyProposalWithAutonomy(proposal.id);
  assert.equal(out.announced, true);

  // Flip the status BEHIND the repo's back (no cancellation hook fires) — the boundary
  // pass itself must still refuse and cancel, never apply.
  db.prepare(`UPDATE plan_proposals SET status = 'discarded' WHERE id = ?`).run(proposal.id);
  assert.equal(repo.getBrainDecision(out.decision.id).status, "announced", "the announcement is still standing");

  const due = applyDueAnnouncedDecisions(out.effective_date);
  assert.deepEqual(due.applied, []);
  assert.equal(repo.getBrainDecision(out.decision.id).status, "canceled", "the boundary cancels instead of applying");
  assert.equal(repo.getPlan().length, 1, "the retired restructure never lands");
});

test("the boundary applies due decisions oldest-first so the newest read lands last", () => {
  seedOneDayPlan();
  repo.setSettings({ lead_mode: "lead" });
  // Older: a training structural announce. Newer: a nutrition announce (different domain,
  // so the surprise budget cannot mask the ordering being tested).
  const training = repo.createProposal("auto", "restructure", "", structuralParsed());
  const a = applyProposalWithAutonomy(training.id);
  assert.equal(a.announced, true);
  const nutrition = repo.createProposal("stub", "weekly nutrition response", "", {
    kind: "nutrition_target",
    summary: "Small measured intake adjustment",
    nutrition: { target_kcal: 2_250, protein_g: 170, reason: "Measured drift." },
  });
  const b = applyProposalWithAutonomy(nutrition.id, { requested_tier: "announce" });
  assert.equal(b.announced, true);
  assert.ok(Number(a.decision.id) < Number(b.decision.id), "ids ascend in creation order");

  // Both due at the later of the two boundaries.
  const asOf = [a.effective_date, b.effective_date].sort().pop();
  const due = applyDueAnnouncedDecisions(asOf);
  assert.deepEqual(due.applied, [a.decision.id, b.decision.id], "oldest first (id ASC), newest lands last");
});

test("a pending quiet-apply counts against the same-week surprise budget at decision time", () => {
  seedEarnedOverload();
  // An unfinished session today forces the first bounded change to WAIT (pending).
  repo.upsertExercise({ name: "Plank", muscle_group: "core", mode: "timed" });
  const plank = repo.getOrCreateSession(localDateISO(), null);
  dbInsertSet(plank.id, repo.findExercise("Plank").id, { set_number: 1, duration_sec: 60 });
  repo.setSettings({ lead_mode: "lead" });

  // A GENUINE agentic bounded change spends the budget — a routine auto-progression is
  // budget-exempt (Ruling A), so it would not gate the second change.
  const firstProposal = repo.createProposal("stub", "first bounded change", "", {
    summary: "First bench change",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 190 }],
  });
  const first = applyProposalWithAutonomy(firstProposal.id, { requested_tier: "quiet_apply" });
  assert.equal(first.pending, true, "the first bounded change is committed, waiting for its boundary");

  // Two more fill the week: a scheduled-but-unlanded change already spends the domain's
  // budget, so all three count even though none has landed.
  for (const [index, weight] of [195, 200].entries()) {
    const filler = repo.createProposal("stub", `filler bounded change ${index}`, "", {
      summary: `Filler bench change ${index}`,
      changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: weight }],
    });
    assert.equal(applyProposalWithAutonomy(filler.id, { requested_tier: "quiet_apply" }).pending, true);
  }

  // The fourth overruns the week. It WAITS at an announced boundary rather than being
  // demoted to an ask (2026-08-17 ruling).
  const overrun = repo.createProposal("stub", "the change that overruns the week", "", {
    summary: "A fourth bench change",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 205 }],
  });
  const deferred = applyProposalWithAutonomy(overrun.id, { requested_tier: "quiet_apply" });
  assert.equal(deferred.applied, false);
  assert.equal(deferred.review_required, undefined);
  assert.notEqual(deferred.tier, "ask");
  assert.equal(deferred.announced, true);
  assert.equal(deferred.budget_deferred, true);
  assert.equal(repo.getProposal(overrun.id).status, "draft");
});

// A material training change that already LANDED this week, recorded directly. The index
// keeps each seed a distinct decision (recordDecision fingerprints on
// kind + source_ref_type + source_ref_key + effective_date + action).
function seedLandedTrainingChange(index) {
  return repo.recordDecision({
    effective_date: null,
    kind: "training_target",
    domain: "training",
    summary: `A training change that already landed this week (${index})`,
    rationale: null,
    source: "stub",
    source_ref_type: null,
    source_ref_key: null,
    status: "applied",
    autonomy_tier: "quiet_apply",
    risk_class: "low",
    reversible: true,
    context: null,
    action: { seed: index },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  });
}

test("the boundary re-checks the budget: the oldest due change lands, the second waits", () => {
  seedEarnedOverload();
  // An unfinished session today forces both bounded changes to WAIT (pending).
  repo.upsertExercise({ name: "Plank", muscle_group: "core", mode: "timed" });
  const plank = repo.getOrCreateSession(localDateISO(), null);
  dbInsertSet(plank.id, repo.findExercise("Plank").id, { set_number: 1, duration_sec: 60 });
  repo.setSettings({ lead_mode: "lead" });
  // Two material changes already landed this week, so the pass-local landing below is
  // the third and the week is full for the sibling behind it.
  seedLandedTrainingChange(0);
  seedLandedTrainingChange(1);

  // A GENUINE agentic first change spends the budget at the boundary — a routine
  // auto-progression is exempt (Ruling A) and would not force the second to wait.
  const firstProposal = repo.createProposal("stub", "first bounded change", "", {
    summary: "First bench change",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 190 }],
  });
  const first = applyProposalWithAutonomy(firstProposal.id, { requested_tier: "quiet_apply" });
  assert.equal(first.pending, true);
  // The second gets scheduled only because it's a safety response (bypasses the
  // creation-time budget) — the boundary must still pace what LANDS in a week.
  const second = repo.createProposal("stub", "safety follow-up", "", {
    summary: "Second bench change",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 195 }],
  });
  const b = applyProposalWithAutonomy(second.id, { requested_tier: "quiet_apply", safety_response: true });
  assert.equal(b.pending, true);

  const asOf = [first.effective_date, b.effective_date].sort().pop();
  const due = applyDueAnnouncedDecisions(asOf);
  assert.deepEqual(due.applied, [first.decision.id], "the oldest change lands");
  assert.deepEqual(due.failed, [], "waiting is not failing");
  assert.deepEqual(due.delayed, [b.decision.id], "the second waits, not silently applied and not parked");
  const waiting = repo.getBrainDecision(b.decision.id);
  // 2026-08-17 ruling: a full week moves the boundary, it does not demote the change.
  assert.equal(waiting.status, "pending", "still owned by the ledger, never sent to review");
  assert.notEqual(waiting.autonomy_tier, "ask");
  assert.equal(waiting.context.surprise_budget_deferred, true);
  assert.match(waiting.context.surprise_budget_reason, /sibling/i);
  assert.ok(waiting.effective_date > b.effective_date, "its boundary moved forward");
  const siblingFreshness = repo.verifyProposalEvidenceSnapshot(waiting.context.proposal_evidence, asOf);
  assert.equal(siblingFreshness.status, "changed", "the first sibling's landing did change the second snapshot");
  assert.deepEqual(siblingFreshness.changed_components, ["plan"]);
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 190, "only the first change reached the plan");
  assert.equal(repo.getProposal(second.id).status, "draft", "the waiting sibling remains a live draft");
});

test("pre-pass budget use never hides a stale due proposal's freshness reason", () => {
  seedEarnedOverload();
  repo.upsertExercise({ name: "Plank", muscle_group: "core", mode: "timed" });
  const plank = repo.getOrCreateSession(localDateISO(), null);
  dbInsertSet(plank.id, repo.findExercise("Plank").id, { set_number: 1, duration_sec: 60 });
  repo.setSettings({ lead_mode: "lead" });

  const dueProposal = repo.createProposal("stub", "due before an explicit edit", "", {
    summary: "Scheduled bench change",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 190 }],
  });
  const scheduled = applyProposalWithAutonomy(dueProposal.id, { requested_tier: "quiet_apply" });
  assert.equal(scheduled.pending, true);

  // This lands outside applyDueAnnouncedDecisions. It both consumes the weekly
  // training budget and changes the scheduled proposal's authoritative plan input.
  const explicitProposal = repo.createProposal("stub", "athlete explicitly changed bench", "", {
    summary: "Explicit bench change",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 192.5 }],
  });
  const explicit = applyProposalWithAutonomy(explicitProposal.id, {
    requested_tier: "quiet_apply",
    explicit_user_request: true,
  });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.tier, "quiet_apply");
  assert.equal(explicit.applied.length, 1);
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 192.5);

  const due = applyDueAnnouncedDecisions(scheduled.effective_date);
  assert.deepEqual(due.applied, []);
  assert.deepEqual(due.failed, [scheduled.decision.id]);
  const parked = repo.getBrainDecision(scheduled.decision.id);
  assert.equal(parked.status, "review");
  assert.equal(parked.context.review_reason_code, "stale_snapshot");
  assert.deepEqual(parked.context.proposal_freshness.changed_components, ["plan"]);
  assert.deepEqual(parked.context.review_reasons, ["plan evidence changed before the apply boundary"]);
  assert.equal(parked.context.apply_error, undefined, "the pre-pass budget reason must not hide freshness");
  assert.equal(repo.getProposal(dueProposal.id).status, "draft");
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 192.5, "the stale due proposal never mutates the plan");
});

test("the canonical recovery-week draft is stamped domain 'recovery' at write time", () => {
  seedOneDayPlan();
  repo.setSettings({ lead_mode: "lead" });
  const proposal = repo.createProposal("stub", repo.RECOVERY_WEEK_INSTRUCTION, "", {
    summary: "Next week backs the volume off so the adaptation lands.",
    days: [
      {
        day_number: 1,
        name: "Full (light)",
        focus: "Full",
        items: [{ exercise: "Barbell Bench Press", sets: 2, rep_low: 6, rep_high: 8, target_weight: 95 }],
      },
    ],
  });
  const out = applyProposalWithAutonomy(proposal.id);
  assert.equal(out.tier, "announce", "a structural restructure announces under lead mode");
  const announced = repo.listBrainDecisions({ status: "announced" });
  assert.equal(announced.length, 1);
  assert.equal(announced[0].domain, "recovery", "structural marker, never inferred from the summary prose");
  assert.equal(announced[0].kind, "training_structure");

  // A non-recovery restructure keeps domain 'training' even when its prose says "lighter".
  const other = repo.createProposal("stub", "restructure the split", "", {
    summary: "Redistribute so legs get a lighter midweek touch.",
    days: [
      {
        day_number: 1,
        name: "Upper",
        focus: "Upper",
        items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 115 }],
      },
    ],
  });
  const out2 = applyProposalWithAutonomy(other.id);
  assert.equal(out2.tier, "announce");
  const all = repo.listBrainDecisions({ status: "announced" });
  const split = all.find((d) => d.id !== announced[0].id);
  assert.equal(split.domain, "training", "prose containing 'lighter' never earns the recovery stamp");
});
