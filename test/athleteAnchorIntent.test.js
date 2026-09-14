// Multi-anchor strength objectives (R1) and the chat -> coach-lane hand-off (R2/R4).
//
// The live failure this covers: the athlete said in chat that he wanted to rebuild six
// anchor lifts in parallel, the reply promised to "flag it to your coach lane", and
// nothing at all was written — no decision, no job, no proposal. And even had it been
// written, the schema allowed exactly ONE active objective in the whole database, so
// five of the six anchors could not have existed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { db, repo } from "./_seed.js";
import {
  applyChatActions,
  reconcileTrainingStructureReply,
  TRAINING_STRUCTURE_NOT_FLAGGED_VARIANTS,
  TRAINING_STRUCTURE_UNVERIFIED_VARIANTS,
} from "../dist/chatTurns.js";
import { normalizeChatAction, normalizeChatActions, CHAT_ACTION_TYPES } from "../dist/chatActions.js";
import { settleStructureBuild } from "../dist/domain/brain/structure-request.js";
import { trainingLogRouter } from "../dist/routes/training-log.js";
import { localDateISO } from "../dist/repo/shared.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const back = (n) => new Date(new Date(`${localDateISO()}T00:00:00Z`).getTime() - n * 864e5).toISOString().slice(0, 10);
const log = (exercise, weight, reps, daysAgo, rir = 2) =>
  repo.logSetByName({ exercise, weight, reps, rir, date: back(daysAgo) });

// The athlete's own six anchors, his pre-injury 10-rep marks, and a rebuild target
// safely above the est-1RM those marks imply (so creation never auto-completes).
const ANCHORS = [
  ["Back Squat", 225, 400],
  ["Deadlift", 255, 450],
  ["Bent-over Row", 155, 280],
  ["Barbell Bench Press", 155, 280],
  ["DB Curl", 50, 120],
  ["Overhead Press", 75, 160],
];

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use("/api", trainingLogRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        resolve(await fn(base));
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}

// ---- (a) migration + multi-anchor invariant ---------------------------------

test("the schema enforces one active objective PER LIFT, not one overall", () => {
  const created = ANCHORS.map(([exercise, weight, target]) => {
    log(exercise, weight, 10, 21);
    return repo.setStrengthObjective({ exercise, target_kind: "explicit_est_1rm", target_est_1rm: target });
  });
  const active = repo.listActiveStrengthObjectives();
  assert.equal(active.length, 6, "all six anchors run in parallel");
  assert.deepEqual([...active.map((row) => row.exercise)].sort(), ANCHORS.map(([exercise]) => exercise).sort());
  // Every objective keeps its own snapped finish line.
  for (const objective of created) {
    assert.equal(repo.getStrengthObjective(objective.id).status, "active");
  }

  // Two actives on the SAME lift are refused by the index and superseded by the writer.
  const replacement = repo.setStrengthObjective({
    exercise: "Back Squat",
    target_kind: "explicit_est_1rm",
    target_est_1rm: 405,
  });
  const squats = repo.listStrengthObjectives().filter((row) => row.exercise_key === replacement.exercise_key);
  assert.equal(squats.filter((row) => row.status === "active").length, 1);
  assert.equal(repo.listActiveStrengthObjectives().length, 6, "the other five anchors are untouched");
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO strength_objectives (exercise, exercise_key, target_kind, target_est_1rm, status)
           VALUES ('Back Squat', ?, 'explicit_est_1rm', 405, 'active')`
        )
        .run(replacement.exercise_key),
    /UNIQUE|constraint/i,
    "the unique index still refuses a second active row on one lift"
  );
});

test("migration v98 is idempotent, additive, and preserves a v97-shaped active objective", () => {
  const migrate = readFileSync(join(root, "src/migrations/v051-100.ts"), "utf8");
  const source = migrate.slice(migrate.indexOf("version: 98"));
  assert.match(source, /DROP INDEX IF EXISTS idx_strength_objectives_one_active\b/);
  assert.match(source, /CREATE UNIQUE INDEX IF NOT EXISTS idx_strength_objectives_one_active_per_lift/);
  assert.doesNotMatch(
    source.slice(0, source.includes("version: 99") ? source.indexOf("version: 99") : source.indexOf("},\n];")),
    /\b(?:DELETE|DROP TABLE|UPDATE strength_objectives)\b/,
    "v98 is additive: it never rewrites or removes an objective row"
  );

  // Rebuild a v97-shaped table (one-active-overall index) and run the migration body.
  db.exec(`DROP TABLE IF EXISTS v97_probe_objectives`);
  db.exec(`CREATE TABLE v97_probe_objectives (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             exercise TEXT NOT NULL, exercise_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active')`);
  db.exec(`CREATE UNIQUE INDEX v97_probe_one_active ON v97_probe_objectives(status) WHERE status='active'`);
  db.prepare(
    `INSERT INTO v97_probe_objectives (exercise, exercise_key) VALUES ('Overhead Press','overhead press')`
  ).run();
  assert.throws(
    () => db.prepare(`INSERT INTO v97_probe_objectives (exercise, exercise_key) VALUES ('Deadlift','deadlift')`).run(),
    /UNIQUE|constraint/i,
    "the v97 shape genuinely blocked a second anchor"
  );
  // The v98 transform, twice — the second pass must be a no-op.
  for (const _pass of [1, 2]) {
    db.exec(`DROP INDEX IF EXISTS v97_probe_one_active`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS v97_probe_one_active_per_lift
               ON v97_probe_objectives(exercise_key) WHERE status='active'`);
  }
  const kept = db
    .prepare(`SELECT exercise, status FROM v97_probe_objectives`)
    .all()
    .map((row) => `${row.exercise}:${row.status}`);
  assert.deepEqual(kept, ["Overhead Press:active"], "the existing objective is untouched");
  db.prepare(`INSERT INTO v97_probe_objectives (exercise, exercise_key) VALUES ('Deadlift','deadlift')`).run();
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM v97_probe_objectives WHERE status='active'`).get().c, 2);
  assert.throws(
    () => db.prepare(`INSERT INTO v97_probe_objectives (exercise, exercise_key) VALUES ('Deadlift','deadlift')`).run(),
    /UNIQUE|constraint/i,
    "two actives on the same lift stay refused"
  );
  db.exec(`DROP TABLE v97_probe_objectives`);
});

test("logging one anchor closes ITS objective and leaves the other anchors open", () => {
  log("Overhead Press", 75, 10, 30);
  log("Deadlift", 255, 10, 30);
  const press = repo.setStrengthObjective({
    exercise: "Overhead Press",
    target_kind: "explicit_est_1rm",
    target_est_1rm: 110,
  });
  const deadlift = repo.setStrengthObjective({
    exercise: "Deadlift",
    target_kind: "explicit_est_1rm",
    target_est_1rm: 400,
  });
  assert.equal(repo.getStrengthObjective(press.id).status, "active");

  log("Overhead Press", 95, 8, 0);
  assert.equal(repo.getStrengthObjective(press.id).status, "completed", "the press objective closed on its own log");
  assert.equal(repo.getStrengthObjective(deadlift.id).status, "active", "the deadlift anchor is still open");
});

test("every journey carries the parallel anchor set, and getStrengthJourneys reads them all", () => {
  for (const [exercise, weight, target] of ANCHORS.slice(0, 3)) {
    log(exercise, weight, 10, 20);
    repo.setStrengthObjective({ exercise, target_kind: "explicit_est_1rm", target_est_1rm: target });
  }
  const journeys = repo.getStrengthJourneys();
  assert.equal(journeys.length, 3);
  assert.deepEqual([...journeys.map((journey) => journey.objective.exercise)].sort(), [
    "Back Squat",
    "Bent-over Row",
    "Deadlift",
  ]);
  for (const journey of journeys) {
    assert.equal(journey.available, true);
    assert.equal(journey.active_objectives.length, 3, "each journey can see the whole parallel set");
  }
  // The single-journey surface still answers, and names the primary anchor.
  assert.equal(repo.getStrengthJourney().objective.id, repo.getActiveStrengthObjective().id);
  assert.equal(repo.getStrengthJourney({ exercise: "Back Squat" }).objective.exercise, "Back Squat");
});

// ---- (c) REST and MCP mirror --------------------------------------------------

test("REST and MCP mirror the multi-anchor list/create surfaces", async () => {
  const mcp = readFileSync(join(root, "src/surfaces/mcp/training-log.ts"), "utf8");
  const rest = readFileSync(join(root, "src/routes/training-log.ts"), "utf8");
  for (const marker of [
    /get\("\/strength-journeys"/,
    /get\("\/strength-objectives"/,
    /post\("\/strength-objectives"/,
  ]) {
    assert.match(rest, marker);
  }
  assert.match(mcp, /"get_strength_journeys"/);
  assert.match(mcp, /"list_strength_objectives"/);
  assert.match(mcp, /"set_strength_objective"/);

  await withServer(async (base) => {
    for (const [exercise, weight, target] of ANCHORS) {
      log(exercise, weight, 10, 25);
      const res = await fetch(`${base}/api/strength-objectives`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ exercise, target_kind: "explicit_est_1rm", target_est_1rm: target }),
      });
      assert.equal(res.status, 200, `${exercise} objective created over REST`);
      const body = await res.json();
      assert.equal(body.objective.exercise, exercise);
      assert.equal(body.journey.objective.exercise, exercise, "the create path answers with THAT lift's journey");
    }
    const listed = await (await fetch(`${base}/api/strength-objectives`)).json();
    assert.equal(listed.active.length, 6, "six anchors, one REST call each");

    const restJourneys = await (await fetch(`${base}/api/strength-journeys`)).json();
    // The MCP tool body is the same domain call the route makes — same answer, both surfaces.
    assert.deepEqual(
      restJourneys.journeys.map((journey) => journey.objective.exercise).sort(),
      repo
        .getStrengthJourneys()
        .map((journey) => journey.objective.exercise)
        .sort()
    );
    assert.deepEqual(
      listed.active.map((row) => row.id).sort(),
      repo
        .listActiveStrengthObjectives()
        .map((row) => row.id)
        .sort()
    );
    // A bad create is a 400 on the surface, not a silent no-op.
    const bad = await fetch(`${base}/api/strength-objectives`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exercise: "Back Squat", target_kind: "not_a_kind" }),
    });
    assert.equal(bad.status, 400);
  });
});

// ---- (b) chat -> coach lane ---------------------------------------------------

const REQUEST = "I want to rebuild strength across all six of my anchor lifts in parallel.";

// The build job is handed to the runner through this seam so the test never spawns the
// stub CLI in the background; what it asserts is the durable job row and the ledger.
const enqueued = [];
const noRunner = { enqueueJob: (id) => enqueued.push(id) };

test("flag_training_structure records the request AND hands it to the coach as an evolve_program job", () => {
  enqueued.length = 0;
  repo.setSettings({ lead_mode: "lead" });
  const { applied } = applyChatActions(
    {
      actions: [{ type: "flag_training_structure", request: REQUEST, summary: "Rebuild six anchor lifts in parallel" }],
    },
    { agent: "stub", message: REQUEST, ...noRunner }
  );
  const entry = applied.find((row) => row.type === "flag_training_structure");
  assert.ok(entry, "the promise left a trace");
  assert.equal(entry.result.ok, true);
  assert.equal(entry.result.verified, true);
  assert.equal(entry.result.posture, "lands", "lead mode: the built change lands, it is not an ask");
  assert.match(String(entry.result.lands_on), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(new Date(`${entry.result.lands_on}T12:00:00Z`).getUTCDay(), 1, "a structural change lands on a Monday");

  const decision = repo.getBrainDecision(entry.result.decision_id);
  assert.equal(decision.kind, "training_structure");
  assert.equal(decision.domain, "training");
  assert.equal(decision.status, "review", "the request row waits only while the coach builds");
  assert.equal(decision.source, "chat");
  assert.equal(decision.rationale, REQUEST, "the athlete's own sentence, verbatim");
  assert.equal(decision.summary, "Rebuild six anchor lifts in parallel");
  assert.equal(decision.context.requested_in_chat, true);
  assert.equal(decision.context.review_required, false, "nothing is asked of the athlete under lead");
  assert.equal(decision.applied_at, null, "the request row applies nothing by itself");
  assert.match(decision.action.user_explanation, /rebuilding the week/);
  assert.match(decision.action.user_explanation, /one-tap Undo/);
  assert.doesNotMatch(decision.action.user_explanation, /confirm/);

  // THE HAND-OFF: a durable evolve_program job carrying the athlete's words, linked
  // back to the request row, actually handed to the runner.
  const jobId = Number(decision.context.structure_build_job_id);
  assert.ok(jobId > 0, "the request carries its build job");
  assert.deepEqual(enqueued, [jobId], "and the job was handed to the runner exactly once");
  assert.equal(entry.result.build.job_id, jobId);
  const job = repo.getAgentJob(jobId);
  assert.equal(job.kind, "evolve_program");
  assert.equal(job.status, "queued");
  assert.equal(job.input.structure_flag_decision_id, decision.id);
  assert.match(job.input.instruction, /restructure the week as the athlete asked/);
  assert.ok(job.input.instruction.includes(REQUEST), "the athlete's words ride on the proposal instruction");
  assert.ok(job.input.task.includes(REQUEST), "and frame the task");
  assert.match(job.input.task, /"days" restructure/);

  // While the build is in flight it is visible on the surfaces the athlete already reads.
  assert.ok(
    repo.awaitingBrainDecisions(50).some((row) => row.id === decision.id),
    "the in-flight request is readable, with the sentence that says what happens next"
  );
});

test("under review_everything the request says it will wait to be confirmed", () => {
  enqueued.length = 0;
  repo.setSettings({ lead_mode: "review_everything" });
  try {
    const { applied } = applyChatActions(
      { actions: [{ type: "flag_training_structure", request: REQUEST }] },
      { agent: "stub", message: REQUEST, ...noRunner }
    );
    const entry = applied.find((row) => row.type === "flag_training_structure");
    assert.equal(entry.result.verified, true);
    assert.equal(entry.result.posture, "asks");
    assert.equal(entry.result.lands_on, null);
    const decision = repo.getBrainDecision(entry.result.decision_id);
    assert.equal(decision.context.review_required, true);
    assert.match(decision.action.user_explanation, /wait here for you to confirm/);
    assert.equal(enqueued.length, 1, "the coach still drafts it — the posture only decides how it lands");
  } finally {
    repo.setSettings({ lead_mode: "lead" });
  }
});

test("when the build produces a decision, the request row is superseded by the change itself", () => {
  enqueued.length = 0;
  const { applied } = applyChatActions(
    { actions: [{ type: "flag_training_structure", request: REQUEST }] },
    { agent: "stub", message: REQUEST, ...noRunner }
  );
  const flagId = applied.find((row) => row.type === "flag_training_structure").result.decision_id;
  // Stand in for the announced restructure the autonomy layer would record.
  const change = repo.recordDecision({
    effective_date: localDateISO(),
    kind: "training_structure",
    domain: "training",
    summary: "Rebuilt week",
    rationale: null,
    source: "stub",
    source_ref_type: "plan_proposal",
    source_ref_key: "999",
    status: "announced",
    autonomy_tier: "announce",
    risk_class: "moderate",
    reversible: false,
    input_fingerprint: null,
    context: {},
    action: { proposal_id: 999 },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  }).decision;
  settleStructureBuild(flagId, { ok: true, proposal: { id: 999 }, autonomy: { decision: change } });
  const flag = repo.getBrainDecision(flagId);
  assert.equal(flag.status, "superseded");
  assert.equal(flag.superseded_by, change.id);
  assert.equal(flag.context.structure_build_outcome, "built");
  assert.equal(flag.context.structure_build_proposal_id, 999);
  assert.ok(!repo.awaitingBrainDecisions(50).some((row) => row.id === flagId), "the request row leaves the queue");

  // Re-asking while the built change is still announced points back at it — no second build.
  const again = applyChatActions(
    { actions: [{ type: "flag_training_structure", request: REQUEST }] },
    { agent: "stub", message: REQUEST, ...noRunner }
  ).applied.find((row) => row.type === "flag_training_structure");
  assert.equal(again.result.verified, true);
  assert.equal(again.result.decision_id, flagId);
  assert.equal(again.result.built_decision.id, change.id);
  assert.equal(again.result.build, null);
  assert.equal(enqueued.length, 1, "nothing was enqueued a second time");
});

test("when the build fails, the request row stays and says so — and a re-ask retries it", () => {
  enqueued.length = 0;
  const first = applyChatActions(
    { actions: [{ type: "flag_training_structure", request: REQUEST }] },
    { agent: "stub", message: REQUEST, ...noRunner }
  ).applied.find((row) => row.type === "flag_training_structure");
  const flagId = first.result.decision_id;
  const jobId = first.result.build.job_id;
  repo.failAgentJob(jobId, "no agent");
  settleStructureBuild(flagId, { ok: false, error: "no agent" });
  const flag = repo.getBrainDecision(flagId);
  assert.equal(flag.status, "review", "still standing");
  assert.equal(flag.context.structure_build_outcome, "failed");
  assert.match(flag.action.user_explanation, /could not build it just now \(no agent\)/);
  assert.doesNotMatch(flag.action.user_explanation, /lands/);

  const retry = applyChatActions(
    { actions: [{ type: "flag_training_structure", request: REQUEST }] },
    { agent: "stub", message: REQUEST, ...noRunner }
  ).applied.find((row) => row.type === "flag_training_structure");
  assert.equal(retry.result.decision_id, flagId, "the same request row");
  assert.ok(retry.result.build.job_id > jobId, "with a fresh build job");
  assert.equal(enqueued.length, 2);
  assert.equal(repo.getBrainDecision(flagId).context.structure_build_outcome, null, "the failure is cleared for the retry");
  assert.match(repo.getBrainDecision(flagId).action.user_explanation, /rebuilding the week/);
});

test("a malformed or unauthorized structure flag writes nothing", () => {
  const before = repo.listBrainDecisions({ status: "review", limit: 100 }).length;
  // Shape: a blank request has nothing to route.
  assert.equal(normalizeChatAction({ type: "flag_training_structure", request: "   " }), null);
  assert.equal(normalizeChatAction({ type: "flag_training_structure" }), null);
  assert.equal(normalizeChatAction({ type: "flag_training_structure", request: 12 }), null);
  assert.equal(normalizeChatActions([{ type: "flag_training_structure", request: "" }]).length, 0);
  // Long prose is bounded rather than stored whole.
  const long = normalizeChatAction({ type: "flag_training_structure", request: "x".repeat(5000) });
  assert.equal(long.request.length, 1000);

  // Authorization: a leading question is a conversation, not an ask.
  const { applied } = applyChatActions(
    { actions: [{ type: "flag_training_structure", request: REQUEST }] },
    { agent: "stub", message: "Should I train all six of my anchor lifts at once?", ...noRunner }
  );
  assert.equal(applied.filter((row) => row.type === "flag_training_structure").length, 0);
  assert.equal(repo.listBrainDecisions({ status: "review", limit: 100 }).length, before);
});

test("re-flagging the same request does not stack up duplicate asks", () => {
  const run = () =>
    applyChatActions(
      { actions: [{ type: "flag_training_structure", request: REQUEST }] },
      { agent: "stub", message: REQUEST, ...noRunner }
    ).applied.find((row) => row.type === "flag_training_structure");
  enqueued.length = 0;
  const first = run();
  const second = run();
  assert.equal(first.result.decision_id, second.result.decision_id, "the same standing ask is reused");
  assert.equal(repo.listBrainDecisions({ status: "review", kind: "training_structure", limit: 100 }).length, 1);
  assert.equal(enqueued.length, 1, "and the coach was asked to build it exactly once");
  assert.equal(second.result.build.job_id, first.result.build.job_id, "the re-ask points at the live build");
});

test("a NEAR-duplicate re-ask reuses the standing flag; a materially different ask is flagged fresh", () => {
  // An exact repeat already collapses on the decision fingerprint. What used to stack
  // was the same sentence retyped — different spacing, different capitalisation.
  const flag = (request, message = request) =>
    applyChatActions(
      { actions: [{ type: "flag_training_structure", request }] },
      { agent: "stub", message, ...noRunner }
    ).applied.find((row) => row.type === "flag_training_structure");

  const first = flag(REQUEST);
  assert.equal(first.result.verified, true);
  const nearDuplicate = flag("  i want to REBUILD strength   across all six of my anchor lifts in parallel. ");
  assert.equal(
    nearDuplicate.result.decision_id,
    first.result.decision_id,
    "a retyped version of the same ask points back at the one standing flag",
  );
  assert.equal(
    repo.listBrainDecisions({ status: "review", kind: "training_structure", limit: 100 }).length,
    1,
    "nothing stacked up",
  );
  // The athlete's ORIGINAL words are what stands — the near-duplicate never rewrites them.
  assert.equal(repo.getBrainDecision(first.result.decision_id).rationale, REQUEST);

  const different = flag("Drop my training week to three days and build it around the deadlift.");
  assert.notEqual(different.result.decision_id, first.result.decision_id, "a different ask is its own flag");
  assert.equal(different.result.verified, true);
  assert.equal(repo.listBrainDecisions({ status: "review", kind: "training_structure", limit: 100 }).length, 2);
});

// ---- (d) reply truthfulness (R4) ----------------------------------------------

test("the reply may only claim the hand-off when a decision actually landed", () => {
  const promise = "That's a training-structure change — I'll flag it to your coach lane so it can build that in.";
  // Nothing applied: the false promise is replaced, not decorated.
  const corrected = reconcileTrainingStructureReply(promise, []);
  assert.doesNotMatch(corrected, /I'll flag it/);
  // The correction rotates through a variant set by date (pickDayVariant), so assert
  // against the WHOLE set — a regex covering only some phrasings passes or fails by
  // what day it is. Every variant must also carry the honest "nothing was flagged"
  // meaning, which is what the rotation is allowed to vary the wording of.
  assert.ok(
    TRAINING_STRUCTURE_NOT_FLAGGED_VARIANTS.includes(corrected),
    `the correction must be one of the variant set, got: ${corrected}`,
  );
  for (const variant of TRAINING_STRUCTURE_NOT_FLAGGED_VARIANTS) {
    assert.match(variant, /unchanged|nothing (?:is|was)|no (?:structure )?request/i, variant);
    assert.doesNotMatch(variant, /I'll flag it/);
  }

  // Applied but unverified: the claim is withdrawn with a reason.
  const unverified = reconcileTrainingStructureReply(promise, [
    { type: "flag_training_structure", result: { ok: false, verified: false }, error: "the decision did not store" },
  ]);
  assert.match(unverified, /the decision did not store/);
  assert.doesNotMatch(unverified, /I'll flag it/);
  // Same rotation on the unverified arm: every variant must name the reason and
  // refuse the claim, whichever one today picks.
  assert.ok(
    TRAINING_STRUCTURE_UNVERIFIED_VARIANTS.some((v) => v("the decision did not store") === unverified),
    `the withdrawal must be one of the variant set, got: ${unverified}`,
  );
  for (const variant of TRAINING_STRUCTURE_UNVERIFIED_VARIANTS) {
    const text = variant("the decision did not store");
    assert.match(text, /the decision did not store/);
    assert.match(text, /won't (?:claim|say)/i, text);
  }

  // Verified under lead: the prose survives and the receipt says the coach is BUILDING it
  // and names the landing day — never "done", never "confirm".
  const verified = reconcileTrainingStructureReply(promise, [
    {
      type: "flag_training_structure",
      result: { ok: true, verified: true, decision_id: 1, posture: "lands", lands_on: "2026-09-14", build: { job_id: 7 } },
    },
  ]);
  assert.match(verified, /I'll flag it/);
  assert.match(verified, /rebuilding your week/);
  assert.match(verified, /lands on 2026-09-14 with a one-tap Undo/);
  assert.doesNotMatch(verified, /confirm/);
  assert.match(verified, /nothing in your plan has changed yet/i);

  // Re-asked once the change is already built: the receipt points at it, with its own date.
  const built = reconcileTrainingStructureReply(promise, [
    {
      type: "flag_training_structure",
      result: {
        ok: true,
        verified: true,
        decision_id: 1,
        posture: "lands",
        lands_on: "2026-09-14",
        build: null,
        built_decision: { id: 9, status: "announced", effective_date: "2026-09-21" },
      },
    },
  ]);
  assert.match(built, /Already in hand/);
  assert.match(built, /lands on 2026-09-21/);

  // Under review_everything the receipt says it will WAIT to be confirmed.
  const asks = reconcileTrainingStructureReply(promise, [
    { type: "flag_training_structure", result: { ok: true, verified: true, decision_id: 1, posture: "asks", build: { job_id: 7 } } },
  ]);
  assert.match(asks, /wait for you to confirm/);
  assert.match(asks, /nothing in your plan has changed yet/i);

  // An unrelated reply is never rewritten.
  const untouched = "Squats looked strong today.";
  assert.equal(reconcileTrainingStructureReply(untouched, []), untouched);
});

test("the chat action contract advertises flag_training_structure to the model", () => {
  assert.ok(CHAT_ACTION_TYPES.includes("flag_training_structure"));
  const source = readFileSync(join(root, "src/chatActions.ts"), "utf8");
  const spec = source.slice(source.indexOf("flag_training_structure: {"));
  assert.match(spec, /coach lane/i, "the guidance names the hand-off the reply promises");
  assert.match(spec, /verbatim/i, "and demands the athlete's own words");
  assert.match(spec, /never say "done"/i, "and says plainly that it changes nothing in the turn");
  assert.match(spec, /one-tap Undo/i, "and that the built change lands with an Undo under lead");
});

// ---- anchor-slide cut pressure regression -------------------------------------

test("cut-quality anchor slide still reads every representative lift, not one", () => {
  const source = readFileSync(join(root, "src/repo/cut-quality.ts"), "utf8");
  // The cut read's anchors are program-state lifts, deliberately independent of
  // strength_objectives — this change must not have coupled them.
  assert.doesNotMatch(source, /strength_objectives|getActiveStrengthObjective/);
  assert.match(source, /anchors: CutQualityAnchor\[\]/);
});
