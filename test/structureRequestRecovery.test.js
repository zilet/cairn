// A TRAINING-STRUCTURE REQUEST CAN NEVER BE SILENTLY LOST.
//
// The hand-off writes a `training_structure` flag and hands the athlete's words to the
// program-evolution op as a background job. Three ways that used to end in silence:
//
//   1. A restart between "job created" and "job settled". The worker is the only thing
//      that settles a flag, so the ask kept a null outcome and a dead job id. Worse, the
//      decision fingerprint is UNIQUE and only canceled/rejected/reverted/superseded are
//      walked past — so re-asking those exact words resolved right back onto that row,
//      enqueued nothing, and replied "the request did not read back" forever.
//   2. A build that FAILED wrote its explanation into a `review` row with no
//      `review_required`, which the "Waiting on you" reader skips for a structure
//      request (under lead an in-flight ask is the coach's work, not a question). The
//      sentence existed; no surface rendered it.
//   3. The thaw sweep re-files an unanswered ask as `observed`, and every reader treated
//      that as terminal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import { applyChatActions } from "../dist/chatTurns.js";
import { recoverAgentJobs } from "../dist/agentJobs.js";
import {
  MAX_AUTOMATIC_STRUCTURE_REBUILDS,
  recoverStructureBuilds,
  registerStructureBuildEnqueuer,
  settleStructureBuild,
} from "../dist/domain/brain/structure-request.js";
import { localDateISO } from "../dist/repo/shared.js";

// The runner seam: the tests assert the durable job row and the ledger, never a spawned
// CLI. chatTurns' own path takes the same seam through ctx.enqueueJob.
const enqueued = [];
registerStructureBuildEnqueuer((id) => enqueued.push(id));
const noRunner = { enqueueJob: (id) => enqueued.push(id) };

const REQUEST = "Rebuild my week around Tuesday and Thursday runs.";

function flagRow(words, { status = "review", context = {} } = {}) {
  return repo.recordDecision({
    effective_date: null,
    kind: "training_structure",
    domain: "training",
    summary: words.slice(0, 60),
    rationale: words,
    source: "chat",
    source_ref_type: null,
    source_ref_key: null,
    status,
    autonomy_tier: "ask",
    risk_class: "moderate",
    reversible: false,
    input_fingerprint: null,
    context: { review_required: false, requested_in_chat: true, athlete_request: words, ...context },
    action: { kind: "training_structure_request", request: words, user_explanation: `You asked: “${words}”.` },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  }).decision;
}

// A flag whose build job exists in whatever terminal shape the test needs.
function flagWithBuild(words, shape, extraContext = {}) {
  const job = repo.createAgentJob({ kind: "evolve_program", input: { instruction: words } });
  const flag = flagRow(words, {
    context: { structure_build_job_id: Number(job.id), structure_build_outcome: null, ...extraContext },
  });
  if (shape === "error") repo.failAgentJob(Number(job.id), "interrupted by a restart");
  if (shape === "canceled") repo.cancelAgentJob(Number(job.id));
  return { flag, job };
}

function announcedChange() {
  return repo.recordDecision({
    effective_date: localDateISO(),
    kind: "training_structure",
    domain: "training",
    summary: "Rebuilt week",
    rationale: null,
    source: "stub",
    source_ref_type: "plan_proposal",
    source_ref_key: "4242",
    status: "announced",
    autonomy_tier: "announce",
    risk_class: "moderate",
    reversible: false,
    input_fingerprint: null,
    context: {},
    action: { proposal_id: 4242 },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  }).decision;
}

test("a build the restart killed is handed back to the coach, not left holding a dead job", () => {
  enqueued.length = 0;
  const { flag, job } = flagWithBuild(REQUEST, "error");
  const recovered = recoverStructureBuilds();
  assert.deepEqual(recovered.resumed, [flag.id], "the ask is put back in flight");
  assert.deepEqual(recovered.settled, []);

  const after = repo.getBrainDecision(flag.id);
  const rebuildId = Number(after.context.structure_build_job_id);
  assert.ok(rebuildId > Number(job.id), "a fresh build job, not the dead one");
  assert.equal(after.context.structure_build_outcome, null, "and it is genuinely in flight again");
  assert.equal(after.context.structure_auto_rebuild_attempts, 1, "the server's own retry is counted");
  assert.deepEqual(enqueued, [rebuildId], "handed to the runner exactly once");
  const rebuild = repo.getAgentJob(rebuildId);
  assert.equal(rebuild.kind, "evolve_program");
  assert.equal(rebuild.status, "queued");
  assert.equal(rebuild.input.structure_flag_decision_id, flag.id, "linked back so the outcome can settle");
  assert.ok(rebuild.input.task.includes(REQUEST), "with the athlete's own words");
});

// The boot path itself: the job recovery pass is where a restart is noticed, so that is
// where the flags have to be reconciled. Wired there, an interrupted ask can never
// survive a restart holding a null outcome.
test("boot recovery reconciles the flags, not only the jobs", () => {
  enqueued.length = 0;
  const { flag, job } = flagWithBuild(REQUEST, "error");
  const recovered = recoverAgentJobs();
  assert.equal(recovered.structure_resumed, 1, "the interrupted ask is rebuilt by the boot pass");
  assert.equal(recovered.structure_settled, 0);
  const after = repo.getBrainDecision(flag.id);
  assert.ok(Number(after.context.structure_build_job_id) > Number(job.id));
  assert.equal(after.context.structure_build_outcome, null);
});

test("a build that finished but never settled is settled from its own stored result", () => {
  enqueued.length = 0;
  const { flag, job } = flagWithBuild(REQUEST, "queued");
  const change = announcedChange();
  repo.finishAgentJob(Number(job.id), { result: { ok: true, proposal: { id: 4242 }, autonomy: { decision: change } } });

  const recovered = recoverStructureBuilds();
  assert.deepEqual(recovered.settled, [flag.id]);
  assert.deepEqual(recovered.resumed, [], "nothing is rebuilt — the week already exists");
  const after = repo.getBrainDecision(flag.id);
  assert.equal(after.status, "superseded");
  assert.equal(after.superseded_by, change.id, "the change itself is the one row the athlete reads");
  assert.equal(after.context.structure_build_outcome, "built");
  assert.deepEqual(enqueued, []);
});

test("a queued build is still the runner's — recovery leaves it alone", () => {
  enqueued.length = 0;
  const { flag } = flagWithBuild(REQUEST, "queued");
  const recovered = recoverStructureBuilds();
  assert.deepEqual(recovered, { resumed: [], settled: [] });
  assert.equal(repo.getBrainDecision(flag.id).context.structure_build_outcome, null);
  assert.deepEqual(enqueued, []);
});

test("a build the athlete stopped is never restarted behind them — it becomes a question they can see", () => {
  enqueued.length = 0;
  const { flag } = flagWithBuild(REQUEST, "canceled");
  const recovered = recoverStructureBuilds();
  assert.deepEqual(recovered.settled, [flag.id]);
  assert.deepEqual(enqueued, [], "nothing is rebuilt over a Stop");
  const after = repo.getBrainDecision(flag.id);
  assert.equal(after.status, "review");
  assert.equal(after.context.structure_build_outcome, "failed");
  assert.ok(
    repo.awaitingBrainDecisions(50).some((row) => row.id === flag.id),
    "and the athlete has it in front of them"
  );
});

test("a build whose job row aged out is a question, not a week rebuilt from a month-old sentence", () => {
  enqueued.length = 0;
  const flag = flagRow(REQUEST, { context: { structure_build_job_id: 99_999, structure_build_outcome: null } });
  const recovered = recoverStructureBuilds();
  assert.deepEqual(recovered.settled, [flag.id]);
  assert.deepEqual(enqueued, [], "nothing is drafted off an ask that old");
  assert.equal(repo.getBrainDecision(flag.id).context.structure_build_outcome, "failed");
  assert.ok(repo.awaitingBrainDecisions(50).some((row) => row.id === flag.id));
});

test("a request the coach was never handed is left alone — the server resumes, it does not start", () => {
  enqueued.length = 0;
  const relic = flagRow(REQUEST, { status: "observed" });
  assert.deepEqual(recoverStructureBuilds(), { resumed: [], settled: [] });
  assert.deepEqual(enqueued, []);
  const after = repo.getBrainDecision(relic.id);
  assert.equal(after.status, "observed", "a relic stays a record");
  assert.equal(after.context.structure_build_job_id, undefined);
});

test("the server stops retrying at the cap and hands the question back instead of looping", () => {
  enqueued.length = 0;
  const { flag } = flagWithBuild(REQUEST, "error", {
    structure_auto_rebuild_attempts: MAX_AUTOMATIC_STRUCTURE_REBUILDS,
  });
  const recovered = recoverStructureBuilds();
  assert.deepEqual(recovered.resumed, [], "no third attempt");
  assert.deepEqual(recovered.settled, [flag.id]);
  assert.deepEqual(enqueued, []);
  const after = repo.getBrainDecision(flag.id);
  assert.equal(after.context.structure_build_outcome, "failed");
  assert.equal(after.context.review_required, true);
  assert.equal(after.context.review_reason_code, "structure_build_failed");
  // A second recovery pass finds a settled flag and does nothing at all.
  assert.deepEqual(recoverStructureBuilds(), { resumed: [], settled: [] });
});

test("a failed build is a question the athlete can see, with a door and no gate language", () => {
  enqueued.length = 0;
  const flag = flagRow(REQUEST, { context: { structure_build_job_id: 1, structure_build_outcome: null } });
  settleStructureBuild(flag.id, { ok: false, error: "no agent" });

  const after = repo.getBrainDecision(flag.id);
  assert.equal(after.status, "review", "still standing");
  assert.equal(after.context.review_required, true, "and genuinely waiting on the athlete now");
  assert.equal(after.context.review_reason_code, "structure_build_failed");
  const waiting = repo.awaitingBrainDecisions(50).find((row) => row.id === flag.id);
  assert.ok(waiting, "a failure the athlete cannot see is a request lost");
  assert.match(waiting.explanation, /could not build it just now \(no agent\)/);
  assert.match(waiting.explanation, /ask again when you like/, "a door, not a dead end");
  // This sentence surfaces in "Waiting on you", which the PLAN tab renders — so a tail
  // pointing at the Plan tab sent the athlete to where they already were.
  assert.doesNotMatch(waiting.explanation, /from the Plan tab/);
  assert.doesNotMatch(waiting.explanation, /you must|you need to/i, "never a gate");
});

test("an OBSERVED request whose build failed comes back as a visible question", () => {
  enqueued.length = 0;
  const flag = flagRow(REQUEST, {
    status: "observed",
    context: { structure_build_job_id: 1, structure_build_outcome: null },
  });
  settleStructureBuild(flag.id, { ok: false, error: "the coach was unavailable" });
  const after = repo.getBrainDecision(flag.id);
  assert.equal(after.status, "review", "the thaw's advisory filing is not where a failure gets to hide");
  assert.ok(repo.awaitingBrainDecisions(50).some((row) => row.id === flag.id));
});

test("re-asking after a restart enqueues a build instead of replying that it did not read back", () => {
  enqueued.length = 0;
  repo.setSettings({ lead_mode: "lead" });
  const first = applyChatActions(
    { actions: [{ type: "flag_training_structure", request: REQUEST }] },
    { agent: "stub", message: REQUEST, ...noRunner }
  ).applied.find((row) => row.type === "flag_training_structure");
  const flagId = first.result.decision_id;
  const jobId = first.result.build.job_id;

  // The restart: the job dies, nothing settles the flag, and the thaw sweep re-files
  // the unanswered ask as an advisory.
  repo.failAgentJob(jobId, "interrupted by a restart");
  repo.patchBrainDecision(flagId, { status: "observed" });

  const again = applyChatActions(
    { actions: [{ type: "flag_training_structure", request: REQUEST }] },
    { agent: "stub", message: REQUEST, ...noRunner }
  ).applied.find((row) => row.type === "flag_training_structure");
  assert.equal(again.result.decision_id, flagId, "the same ask, the same row — nothing stacks");
  assert.equal(again.result.verified, true, "and the receipt is true this time");
  assert.ok(again.result.build.job_id > jobId, "a live build behind it");
  assert.equal(enqueued.length, 2, "the coach was actually handed the work again");

  const after = repo.getBrainDecision(flagId);
  assert.equal(after.status, "review", "an ask being built stands at review");
  assert.equal(after.context.structure_build_outcome, null);
  assert.equal(after.context.structure_auto_rebuild_attempts, 0, "an athlete's own re-ask is never rationed");
  assert.match(after.action.user_explanation, /rebuilding the week/);
});

test("re-asking after a build the coach could not do retries it, whatever the flag was re-filed as", () => {
  enqueued.length = 0;
  repo.setSettings({ lead_mode: "lead" });
  const flag = flagRow(REQUEST, {
    status: "observed",
    context: { structure_build_job_id: 1, structure_build_outcome: "failed", structure_build_error: "no agent" },
  });
  const again = applyChatActions(
    { actions: [{ type: "flag_training_structure", request: REQUEST }] },
    { agent: "stub", message: REQUEST, ...noRunner }
  ).applied.find((row) => row.type === "flag_training_structure");
  assert.equal(again.result.decision_id, flag.id, "the standing observed row IS the ask");
  assert.equal(again.result.verified, true);
  assert.equal(enqueued.length, 1);
  const after = repo.getBrainDecision(flag.id);
  assert.equal(after.context.structure_build_outcome, null, "the old failure is cleared for the retry");
  assert.equal(after.context.review_required, false, "under lead the coach is building it; nothing is asked");
  assert.ok(!repo.awaitingBrainDecisions(50).some((row) => row.id === flag.id));
});
