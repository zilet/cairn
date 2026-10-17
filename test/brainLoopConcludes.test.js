// A LEARNING LOOP THAT CAN CONCLUDE, AND A CONFERENCE THAT EARNS ITS COST (2026-10-17).
//
//   1. A closed window settles: once its window closed past the late-evidence grace and
//      it has an answer on record, a long-window expectation leaves the nightly
//      candidate set — except a `next_draw` prediction still waiting for its draw.
//   2. A conference carries a seat forward when nothing in its domain moved, spends
//      nothing when no seat has anything new over a conference that concluded, and
//      convenes everyone when the deterministic picture (the conflicts) changed.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { db, repo, resetTables, localDaysAgo, seedTrainingDay } from "./_seed.js";
import { recordDecision } from "../dist/repo/brain-decisions.js";
import { evaluateMatureExpectations, LATE_EVIDENCE_GRACE_DAYS } from "../dist/domain/brain/evaluation-service.js";
import {
  CONFERENCE_CARRY_MAX_AGE_DAYS,
  conferenceGlobalSignature,
  runCaseConference,
} from "../dist/domain/brain/case-conference.js";
import { applyCaseConferenceSchedulerSuccess } from "../dist/agentJobs.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";

beforeEach(() =>
  resetTables(
    "brain_evaluations",
    "brain_expectations",
    "brain_decisions",
    "sessions",
    "logged_sets",
    "plan_items",
    "plan_days",
    "agent_jobs",
    "app_state",
    "health_documents",
    "health_directives",
    "context_events",
    "checkins",
    "activities",
    "food_notes",
    "program_blocks",
    "strength_objectives",
    "training_stances"
  )
);

// ---------------------------------------------------------------- 1. settling

const AS_OF = "2026-06-30";

function applied(windowEnd, overrides = {}) {
  const windowStart = addDaysISO(windowEnd, -14);
  return recordDecision(
    {
      effective_date: windowStart,
      kind: "training_target",
      domain: "training",
      summary: `A bounded step judged by ${windowEnd}.`,
      rationale: "Test.",
      source: "test",
      source_ref_type: null,
      source_ref_key: null,
      status: "applied",
      autonomy_tier: "quiet_apply",
      risk_class: "low",
      reversible: true,
      input_fingerprint: null,
      context: {},
      action: {},
      specialist: null,
      applied_at: `${windowStart}T12:00:00.000Z`,
      reverted_at: null,
      superseded_by: null,
      evaluator_version: "test-v1",
    },
    [
      {
        metric_key: "plan_day_adherence",
        subject_key: null,
        direction: "complete",
        baseline: null,
        target: { rate: 0.75 },
        window_start: windowStart,
        window_end: windowEnd,
        minimum_data: { sessions: 2 },
        confounder_policy: "exclude_context_events",
        confidence: "tentative",
        evaluator: "plan_adherence",
        evaluator_version: "test-v1",
        ...overrides,
      },
    ]
  );
}

test("a window closed past the grace, with an answer on record, settles", () => {
  // Far enough apart that the two windows never overlap (arbitration would retire one).
  const old = applied(addDaysISO(AS_OF, -(LATE_EVIDENCE_GRACE_DAYS + 26))).expectations[0].id;
  const recent = applied(addDaysISO(AS_OF, -3)).expectations[0].id;
  const first = evaluateMatureExpectations(AS_OF);
  assert.equal(first.scanned, 2, "a never-evaluated window is always asked once");
  // Nothing was logged: both come back inconclusive.
  const second = evaluateMatureExpectations(AS_OF);
  assert.equal(second.scanned, 1, "only the window still inside its late-evidence grace is re-asked");
  assert.ok(old && recent);
});

test("a next-draw prediction keeps waiting for its draw until it concludes", () => {
  applied(addDaysISO(AS_OF, -60), {
    metric_key: "marker_direction",
    subject_key: "LDL",
    direction: "decrease",
    target: {},
    minimum_data: { draws: 2 },
    confounder_policy: "next_draw",
    evaluator: "marker_direction",
  });
  evaluateMatureExpectations(AS_OF);
  assert.equal(evaluateMatureExpectations(AS_OF).scanned, 1, "still waiting on the follow-up draw");
});

// ---------------------------------------------------------------- 2. the conference

const DOMAINS = ["training", "recovery", "health"];
const opinion = (domain, recommendation = "Keep the change bounded.") => ({
  domain,
  recommendation,
  rationale: "The shared snapshot supports a cautious next step.",
  evidence_keys: [`${domain}:evidence`],
  risks: [],
  contraindications: [],
  uncertainties: [],
  expected_outcomes: [],
  autonomy_ceiling: "quiet_apply",
});
const decision = {
  kind: "case_conference",
  domain: "training",
  summary: "Keep the next change bounded.",
  rationale: "The shared snapshot supports one reversible step.",
  risk_class: "low",
  reversible: true,
  autonomy_tier: "quiet_apply",
  parallel_actions: [],
  resolved_conflicts: [],
  deferred: [],
  expectations: [],
  review_window: "Review in two weeks.",
  user_explanation: "Nothing to change this week.",
  revision: null,
};
const WATERMARKS = { training: "t1", recovery: "r1", health: "h1" };
const STANDING = "standing-1";
const today = () => localDateISO();

function prior({ watermarks = WATERMARKS, formedOn = today(), concluded = true, conflicts = [] } = {}) {
  return () => ({
    signal: {
      version: 1,
      global: conferenceGlobalSignature({
        conflicts,
        trajectory: null,
        leadMode: repo.getSettings().lead_mode,
        standing: STANDING,
      }),
      watermarks,
      opinion_dates: Object.fromEntries(DOMAINS.map((domain) => [domain, formedOn])),
    },
    opinions: DOMAINS.map((domain) => opinion(domain, `Last time's ${domain} read.`)),
    concluded,
  });
}

async function conference(deps) {
  const convened = [];
  const result = await runCaseConference(
    "stub",
    { question: "Weekly team review.", domains: DOMAINS },
    {
      context: () => ({}),
      specialistRun: async (_agent, _prompt, domain) => {
        convened.push(domain);
        return opinion(domain);
      },
      conductorRun: async () => decision,
      watermarks: () => WATERMARKS,
      standingInputs: () => STANDING,
      ...deps,
    }
  );
  return { result, convened };
}

test("nothing moved in any seat since a conference that concluded: a no-op, no spawn", async () => {
  const { result, convened } = await conference({ priorConference: prior() });
  assert.deepEqual(convened, []);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, "unchanged_input");
  assert.deepEqual(result.carried_forward, DOMAINS);
  assert.equal(result.decision, null);
  // The scheduler records it as complete work, so the slot is not retried.
  assert.equal(
    applyCaseConferenceSchedulerSuccess({ scheduler_success: { team_review_last_slot: "2026-10-12" } }, result),
    true
  );
  assert.equal(repo.getAppState("team_review_last_slot"), "2026-10-12");
});

test("only the seat whose domain moved is convened; the others' last opinions stand", async () => {
  const { result, convened } = await conference({
    priorConference: prior({ watermarks: { ...WATERMARKS, recovery: "r0" } }),
  });
  assert.deepEqual(convened, ["recovery"]);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, undefined);
  assert.deepEqual(result.carried_forward, ["training", "health"]);
  const reasons = Object.fromEntries(result.specialist_outcomes.map((o) => [o.domain, o.reason]));
  assert.deepEqual(reasons, { training: "carried_forward", recovery: "ok", health: "carried_forward" });
  assert.equal(result.opinions.find((o) => o.domain === "training").recommendation, "Last time's training read.");
  assert.equal(result.unavailable.length, 0, "a carried seat is a delivered seat");
  assert.ok(result.input_signal.opinion_dates.recovery === today());
});

test("a changed picture, a stale opinion, or an unconcluded last conference convenes everyone it must", async () => {
  // The conflicts the last conference argued over are not today's.
  const changed = await conference({ priorConference: prior({ conflicts: ["deficit_recovery"] }) });
  assert.deepEqual(changed.convened.sort(), [...DOMAINS].sort());
  // An opinion older than the carry bound is not carried.
  const stale = await conference({
    priorConference: prior({ formedOn: addDaysISO(today(), -(CONFERENCE_CARRY_MAX_AGE_DAYS + 1)) }),
  });
  assert.deepEqual(stale.convened.sort(), [...DOMAINS].sort());
  // A last conference that did not conclude cleanly is never the basis of a no-op —
  // but its seats can still be carried, so a retry re-asks only what is missing.
  const retry = await conference({ priorConference: prior({ concluded: false }) });
  assert.equal(retry.result.skipped, undefined);
  assert.deepEqual(retry.convened, []);
  assert.deepEqual(retry.result.carried_forward, DOMAINS);
  // No prior at all: everyone.
  const first = await conference({ priorConference: () => null });
  assert.deepEqual(first.convened.sort(), [...DOMAINS].sort());
});

// ---- the gate reads the REAL tables: an in-place edit is new input ----
//
// No injected watermarks or standing inputs below: the fingerprints are the production
// ones. Each case runs a conference, records it as the prior, makes ONE in-place edit
// (no new row, no updated_at), and runs again — the seat that reads it must convene.

const ALL = ["training", "endurance", "nutrition", "recovery", "health", "lifestyle"];

async function realConference(prior) {
  const convened = [];
  const result = await runCaseConference(
    "stub",
    { question: "Weekly team review.", domains: ALL },
    {
      context: () => ({}),
      specialistRun: async (_agent, _prompt, domain) => {
        convened.push(domain);
        return opinion(domain);
      },
      conductorRun: async () => decision,
      priorConference: () => prior,
    }
  );
  return { result, convened };
}

const asPrior = (result) => ({ signal: result.input_signal, opinions: result.opinions, concluded: true });

function seedWorld() {
  const day = localDaysAgo(2);
  seedTrainingDay(day);
  db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'running', 40, 8)`).run(day);
  repo.addCheckin(day, { energy: 3 });
  db.prepare(`INSERT INTO food_notes (date, meal, raw_output) VALUES (?, 'lunch', 'rice and beans')`).run(day);
  db.prepare(
    `INSERT INTO health_directives (source, domain, marker, directive, status) VALUES ('markers', 'training', 'LDL-C', 'Keep zone 2 in the week.', 'active')`
  ).run();
  repo.addContextEvent({ kind: "trip", title: "Rome", start_date: localDaysAgo(5) });
  repo.setProfile({ goal_mode: "lose", goal_weight_lb: 170 });
  return day;
}

async function primed() {
  const day = seedWorld();
  const first = await realConference(null);
  assert.equal(first.convened.length, ALL.length);
  return { day, prior: asPrior(first.result) };
}

test("with nothing edited, the real fingerprints still skip", async () => {
  const { prior } = await primed();
  const again = await realConference(prior);
  assert.deepEqual(again.convened, []);
  assert.equal(again.result.skipped, "unchanged_input");
});

const IN_PLACE = [
  [
    "a trip resolved in place",
    "lifestyle",
    () => db.prepare(`UPDATE context_events SET resolved_at = datetime('now')`).run(),
  ],
  ["yesterday's run rated RPE 8", "endurance", () => db.prepare(`UPDATE activities SET rpe = 8`).run()],
  [
    "a session rated after the fact",
    "training",
    () => db.prepare(`UPDATE sessions SET performance = 2, soreness = 4`).run(),
  ],
  ["a logged set corrected", "training", () => db.prepare(`UPDATE logged_sets SET weight = weight + 10`).run()],
  ["a check-in changed", "recovery", () => db.prepare(`UPDATE checkins SET energy = 1`).run()],
  [
    "a food note corrected",
    "nutrition",
    () => db.prepare(`UPDATE food_notes SET raw_output = 'rice, beans and chicken'`).run(),
  ],
  [
    "a health finding resolved",
    "health",
    () => db.prepare(`UPDATE health_directives SET status = 'resolved', status_at = datetime('now')`).run(),
  ],
];

for (const [label, domain, edit] of IN_PLACE) {
  test(`an in-place edit convenes its seat: ${label}`, async () => {
    const { prior } = await primed();
    edit();
    const again = await realConference(prior);
    assert.equal(again.result.skipped, undefined, "never a no-op over an edited input");
    assert.ok(again.convened.includes(domain), `${domain} must convene, convened: ${again.convened.join(",")}`);
    assert.ok(!again.result.carried_forward?.includes(domain), `${domain} must not be carried`);
  });
}

const STANDING_EDITS = [
  ["the goal mode moves from lose to maintain", () => repo.setProfile({ goal_mode: "maintain" })],
  ["the training drive changes", () => repo.setSettings({ training_drive: "push" })],
  ["a program block starts", () => repo.createBlock({ goal: "Build squat", total_weeks: 6 })],
];

for (const [label, edit] of STANDING_EDITS) {
  test(`a standing input changing convenes the whole team: ${label}`, async () => {
    const { prior } = await primed();
    edit();
    const again = await realConference(prior);
    assert.equal(again.result.skipped, undefined);
    assert.deepEqual([...again.convened].sort(), [...ALL].sort());
  });
}
