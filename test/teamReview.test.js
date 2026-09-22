// The weekly team review (owner ruling, 2026-09-22): on the coach slot (Sunday evening by
// default) the specialists — strength coach, endurance coach, dietitian, physio, and the
// physician in an informational seat — each name the next step toward their goal's
// milestone, and the conductor reconciles them in the block's priority order. These
// cases pin the cadence (once per week, only in its grace window, ~6 spawns), the
// endurance seat and its charter, and that the result stamps its own slot on success.
// Offline: the job is never run here — enqueue is injected.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { enqueueTeamReviewIfDue, TEAM_REVIEW_DOMAINS } from "../dist/scheduler.js";
import { applyCaseConferenceSchedulerSuccess } from "../dist/agentJobs.js";
import { runCaseConference } from "../dist/domain/brain/case-conference.js";

const SETTINGS = { proactive_enabled: true, coach_day: 0, coach_hour: 20 };
// 2031-05-18 is a Sunday; local wall-clock times, as the owner's scheduler reads them.
const sundayEvening = new Date(2031, 4, 18, 20, 30);
const mondayMorning = new Date(2031, 4, 19, 8, 0);
const wednesday = new Date(2031, 4, 21, 9, 0);

beforeEach(() => {
  resetTables("agent_jobs", "scheduler_operations", "app_state", "plan_items", "plan_days");
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
});

function jobInput(id) {
  return JSON.parse(db.prepare(`SELECT input_json FROM agent_jobs WHERE id = ?`).get(id).input_json);
}

test("the review is queued once for its week, with every seat at one call each", () => {
  const queued = [];
  const id = enqueueTeamReviewIfDue(sundayEvening, SETTINGS, (jobId) => queued.push(jobId));
  assert.ok(id, "Sunday evening queues the review");
  assert.deepEqual(queued, [id]);
  const input = jobInput(id);
  assert.deepEqual(input.domains, [...TEAM_REVIEW_DOMAINS]);
  assert.ok(input.domains.includes("endurance"), "the race build has its own seat");
  assert.equal(input.max_calls_per_specialist, 1, "five seats plus the conductor stays ~6 spawns");
  assert.equal(input.scheduler_operation.operation, "team_review_conference");

  // While its attempt holds the lease, the minute poll never queues a second one.
  assert.equal(
    enqueueTeamReviewIfDue(new Date(2031, 4, 18, 21, 30), SETTINGS, () => {}),
    null,
    "never twice at once"
  );
  assert.equal(
    enqueueTeamReviewIfDue(sundayEvening, { ...SETTINGS, proactive_enabled: false }, () => {}),
    null
  );
});

test("a server that slept through the review's window does not hold it mid-week", () => {
  assert.equal(
    enqueueTeamReviewIfDue(wednesday, SETTINGS, () => {}),
    null
  );
  assert.ok(
    enqueueTeamReviewIfDue(mondayMorning, SETTINGS, () => {}),
    "the morning after is still its window"
  );
});

test("a complete review stamps its own slot, and only its own", () => {
  const id = enqueueTeamReviewIfDue(sundayEvening, SETTINGS, () => {});
  const input = jobInput(id);
  const complete = {
    ok: true,
    opinions: TEAM_REVIEW_DOMAINS.map((domain) => ({ domain })),
    unavailable: [],
    unresolved_conflicts: [],
    decision: {
      kind: "case_conference",
      domain: "training",
      summary: "Step the squat and keep the long run.",
      rationale: "The team agrees on the lead goal's next step.",
      risk_class: "low",
      reversible: true,
      autonomy_tier: "announce",
      parallel_actions: [],
      resolved_conflicts: [],
      deferred: [],
      expectations: [],
      review_window: "One week.",
      user_explanation: "One bounded step toward the squat target.",
      revision: null,
    },
  };
  assert.equal(applyCaseConferenceSchedulerSuccess(input, complete), true);
  assert.equal(repo.getAppState("team_review_last_slot"), "2031-05-18");
  assert.equal(repo.getAppState("brain_revision_last_month"), null, "the monthly revision's stamps are untouched");
});

test("the conference seats the endurance coach, speaks each charter, and reconciles by priority", async () => {
  const specialistPrompts = {};
  let conductorPrompt = "";
  const result = await runCaseConference(
    "stub",
    { question: "Weekly team review.", domains: ["training", "endurance"], maxCallsPerSpecialist: 1 },
    {
      context: () => ({ road_ahead: { priority: { order: ["muscle", "race", "cut"] }, next_milestones: [] } }),
      specialistRun: async (_agent, prompt, domain, _snapshot, maxCalls) => {
        specialistPrompts[domain] = { prompt, maxCalls };
        return {
          domain,
          recommendation:
            domain === "endurance" ? "Keep Sunday's long run at the ladder's rung." : "Step the squat 5 lb.",
          rationale: "The next step toward this seat's milestone.",
          evidence_keys: [`${domain}:evidence`],
          risks: ["Asks a little of the other goal."],
          contraindications: [],
          uncertainties: [],
          expected_outcomes: [],
          autonomy_ceiling: "announce",
        };
      },
      conductorRun: async (_agent, prompt) => {
        conductorPrompt = prompt;
        return null;
      },
    }
  );
  assert.deepEqual(result.opinions.map((opinion) => opinion.domain).sort(), ["endurance", "training"]);
  assert.match(specialistPrompts.endurance.prompt, /ENDURANCE COACH/);
  assert.match(specialistPrompts.training.prompt, /STRENGTH COACH/);
  assert.match(specialistPrompts.training.prompt, /next step/i, "every seat is asked for its next step");
  assert.equal(specialistPrompts.training.maxCalls, 1);
  assert.match(conductorPrompt, /muscle & strength > the race > the cut/);
  // The degraded fallback follows the lead goal's seat rather than defaulting to recovery.
  assert.equal(result.decision.summary, "Step the squat 5 lb.");
  assert.equal(result.decision.domain, "training");
});
