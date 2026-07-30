import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  applyDueAnnouncedDecisions,
  applyProposalWithAutonomy,
  revertDecision,
} from "../dist/domain/brain/autonomy-service.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { repo, resetTables } from "./_seed.js";

beforeEach(() => {
  resetTables(
    "brain_evaluations",
    "brain_expectations",
    "brain_rollbacks",
    "brain_decisions",
    "daily_session_outcomes",
    "daily_session_decisions",
    "daily_session_compositions",
    "logged_sets",
    "session_skips",
    "sessions",
    "day_reads",
    "recovery_cycles",
    "app_state",
    "plan_proposals",
    "plan_items",
    "plan_days",
    "exercises",
    "program_blocks",
    "settings"
  );
});

function basePlan() {
  repo.savePlanDay(1, "Full body", "Strength", [
    { exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 5, target_weight: 225 },
    { exercise: "Barbell Bench Press", sets: 4, rep_low: 5, rep_high: 5, target_weight: 185 },
  ]);
}

function recoveryProposal(summary = "An earned recovery week") {
  return repo.createProposal(
    "auto",
    `${repo.RECOVERY_WEEK_INSTRUCTION_PREFIX} week — preserve the block and temporarily reduce the dose.`,
    "",
    {
      summary,
      days: [
        {
          day_number: 1,
          name: "Recovery full body",
          focus: "Recovery",
          items: [
            { exercise: "Back Squat", sets: 2, rep_low: 5, rep_high: 5, target_weight: 190 },
            { exercise: "Barbell Bench Press", sets: 2, rep_low: 5, rep_high: 5, target_weight: 155 },
          ],
        },
      ],
    }
  );
}

test("a recovery proposal applies a reversible cycle overlay without replacing the weekly plan", () => {
  basePlan();
  repo.setSettings({ lead_mode: "lead" });
  const before = structuredClone(repo.getPlan());
  const proposal = recoveryProposal();

  const scheduled = applyProposalWithAutonomy(proposal.id);
  assert.equal(scheduled.announced, true);
  const due = applyDueAnnouncedDecisions(scheduled.effective_date);
  assert.deepEqual(due.applied, [scheduled.decision.id]);

  assert.deepEqual(repo.getPlan(), before, "the stable weekly plan remains byte-for-byte unchanged");
  const decision = repo.getBrainDecision(scheduled.decision.id);
  const cycle = repo.getRecoveryCycle(decision.action.recovery_cycle_id, scheduled.effective_date);
  assert.equal(cycle.effective_status, "active");
  assert.equal(cycle.overlay.source_proposal_id, proposal.id);
  assert.equal(cycle.overlay.source_decision_id, decision.id);
  assert.equal(decision.context.base_plan_mutated, false);
  assert.equal(repo.getBrainRollback(decision.id).kind, "recovery_cycle");

  const undo = revertDecision(decision.id, "keep building");
  assert.equal(undo.ok, true);
  assert.deepEqual(repo.getPlan(), before, "Undo cancels the overlay without writing the base plan");
  assert.equal(repo.getRecoveryCycle(cycle.id, scheduled.effective_date).effective_status, "canceled");
  assert.equal(repo.getProposal(proposal.id).status, "reverted");
});

test("an active cycle adapts the selected plan day and snapshots durable cycle provenance", () => {
  basePlan();
  const date = localDateISO();
  const cycle = repo.scheduleRecoveryCycle({
    effective_on: date,
    exit_on: addDaysISO(date, 7),
    reason: "Absorb the block",
  });
  repo.activateRecoveryCycle(cycle.id, date);
  const before = structuredClone(repo.getPlanDay(1));

  const prepared = repo.prepareDailySession({ date, source: "adaptive_plan" });
  assert.equal(prepared.daily_session.plan_day_id, before.id);
  assert.equal(prepared.daily_session.items[0].exercise, "Back Squat");
  assert.equal(prepared.daily_session.items[0].sets, 2);
  assert.equal(
    prepared.daily_session.items[0].target_weight,
    172.35,
    "the recovery overlay is retained inside the stricter day-level easy cap"
  );
  assert.equal(prepared.daily_session.provenance.daily_decision.recovery_cycle.id, cycle.id);
  assert.equal(prepared.daily_session.provenance.daily_decision.recovery_cycle.effective_status, "active");
  assert.deepEqual(repo.getPlanDay(1), before, "composition never writes the adapted dose back to the plan");

  const persistedDecision = repo.getLatestDailySessionDecision(date);
  assert.equal(persistedDecision.recovery_cycle.id, cycle.id);
  repo.cancelRecoveryCycle(cycle.id, date);
  const historical = repo.getActiveDailySession(date);
  assert.equal(
    historical.provenance.daily_decision.recovery_cycle.id,
    cycle.id,
    "later cycle state changes do not rewrite historical composition provenance"
  );
});

test("open cycles and cooldown suppress duplicate recovery drafts and applies", () => {
  basePlan();
  const today = localDateISO();
  const open = repo.scheduleRecoveryCycle({ effective_on: today, exit_on: addDaysISO(today, 7) });
  repo.activateRecoveryCycle(open.id, today);
  assert.equal(
    repo.shouldAutoDraftRecoveryWeek({
      lead_mode: "lead",
      focus_lead_domain: "recovery",
      recovery_active: false,
      status: null,
    }),
    false
  );
  assert.throws(() => repo.applyProposal(recoveryProposal("Duplicate").id), /recovery cycle blocked: cycle_open/);

  repo.cancelRecoveryCycle(open.id, today);
  const effectiveOn = addDaysISO(today, -17);
  const exitOn = addDaysISO(today, -10);
  const completed = repo.scheduleRecoveryCycle({ effective_on: effectiveOn, exit_on: exitOn });
  repo.activateRecoveryCycle(completed.id, effectiveOn);
  repo.completeRecoveryCycle(completed.id, exitOn);
  assert.equal(repo.recoveryCycleCooldown(today).reason, "cooldown");
  assert.equal(
    repo.shouldAutoDraftRecoveryWeek({
      lead_mode: "lead",
      focus_lead_domain: "recovery",
      recovery_active: false,
      status: null,
    }),
    false
  );
});

function acceptDose(date, { setsLogged, rir, targetOffset = 0 }) {
  const items = [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 }];
  const session = { name: "Squat", focus: "Strength", why: "Comparable dose.", items };
  const job = repo.createAgentJob({ kind: "session_compose", input: { date } });
  repo.finishAgentJob(job.id, {
    chosen_agent: "codex",
    result: { ok: true, session, agent: "codex", tried: [{ agent: "codex" }] },
  });
  const accepted = repo.prepareDailySession({
    date,
    source: "agent_suggest",
    agent_job_id: job.id,
  });
  const workingWeight = (accepted.daily_session.items[0]?.target_weight ?? 225) + targetOffset;
  for (let i = 0; i < setsLogged; i++) {
    repo.logSetByName({ date, exercise: "Back Squat", weight: workingWeight, reps: 5, rir, day_number: null });
  }
  repo.finishSession(accepted.session_id, null);
}

test("recent comparable movement response brakes but never compounds progression", () => {
  repo.savePlanDay(1, "Squat", "Strength", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
  ]);
  const today = localDateISO();
  acceptDose(addDaysISO(today, -3), { setsLogged: 3, rir: 3, targetOffset: -5 });
  acceptDose(addDaysISO(today, -1), { setsLogged: 3, rir: 3, targetOffset: -5 });

  const held = repo.nextPrescription("Back Squat", undefined, { autoreg: null, acute: null });
  assert.equal(held.movement_response, "earned_hold");
  assert.equal(held.dose_eligibility.reason, "under_prescribed");
  assert.equal(
    held.action,
    "hold",
    "the latest authoritative under-dose and recent response brake an otherwise earned overload exactly one step"
  );
  assert.equal(held.suggested.weight, 225);

  resetTables(
    "daily_session_outcomes",
    "daily_session_decisions",
    "daily_session_compositions",
    "logged_sets",
    "session_skips",
    "sessions",
    "day_reads"
  );
  acceptDose(addDaysISO(today, -3), { setsLogged: 3, rir: 3 });
  acceptDose(addDaysISO(today, -1), { setsLogged: 3, rir: 3 });
  const absorbed = repo.nextPrescription("Back Squat", undefined, { autoreg: null, acute: null });
  assert.equal(absorbed.movement_response, "earned_absorbed");
  assert.equal(absorbed.action, "overload");
  assert.equal(absorbed.suggested.weight, 235, "absorbed evidence supports the normal single step only");
});
