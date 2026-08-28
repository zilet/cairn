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
import { applyChatActions, reconcileTrainingStructureReply } from "../dist/chatTurns.js";
import { normalizeChatAction, normalizeChatActions, CHAT_ACTION_TYPES } from "../dist/chatActions.js";
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
  const migrate = readFileSync(join(root, "src/migrate.ts"), "utf8");
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

test("flag_training_structure records an ask-tier training_structure decision with the athlete's words", () => {
  const { applied } = applyChatActions(
    {
      actions: [{ type: "flag_training_structure", request: REQUEST, summary: "Rebuild six anchor lifts in parallel" }],
    },
    { agent: "stub", message: REQUEST }
  );
  const entry = applied.find((row) => row.type === "flag_training_structure");
  assert.ok(entry, "the promise left a trace");
  assert.equal(entry.result.ok, true);
  assert.equal(entry.result.verified, true);

  const decision = repo.getBrainDecision(entry.result.decision_id);
  assert.equal(decision.kind, "training_structure");
  assert.equal(decision.domain, "training");
  assert.equal(decision.autonomy_tier, "ask", "never quiet_apply, never announce");
  assert.equal(decision.status, "review");
  assert.equal(decision.source, "chat");
  assert.equal(decision.rationale, REQUEST, "the athlete's own sentence, verbatim");
  assert.equal(decision.summary, "Rebuild six anchor lifts in parallel");
  assert.equal(decision.context.requested_in_chat, true);
  assert.equal(decision.applied_at, null, "an ask tier applies nothing by itself");

  // It is genuinely queued on the surfaces the athlete already reads.
  assert.ok(
    repo.listBrainDecisions({ status: "review", limit: 50 }).some((row) => row.id === decision.id),
    "the decision sits in the review queue"
  );
  assert.ok(
    repo.awaitingBrainDecisions(50).some((row) => row.id === decision.id),
    "and it surfaces as something awaiting the athlete"
  );
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
    { agent: "stub", message: "Should I train all six of my anchor lifts at once?" }
  );
  assert.equal(applied.filter((row) => row.type === "flag_training_structure").length, 0);
  assert.equal(repo.listBrainDecisions({ status: "review", limit: 100 }).length, before);
});

test("re-flagging the same request does not stack up duplicate asks", () => {
  const run = () =>
    applyChatActions(
      { actions: [{ type: "flag_training_structure", request: REQUEST }] },
      { agent: "stub", message: REQUEST }
    ).applied.find((row) => row.type === "flag_training_structure");
  const first = run();
  const second = run();
  assert.equal(first.result.decision_id, second.result.decision_id, "the same standing ask is reused");
  assert.equal(repo.listBrainDecisions({ status: "review", kind: "training_structure", limit: 100 }).length, 1);
});

test("a NEAR-duplicate re-ask reuses the standing flag; a materially different ask is flagged fresh", () => {
  // An exact repeat already collapses on the decision fingerprint. What used to stack
  // was the same sentence retyped — different spacing, different capitalisation.
  const flag = (request, message = request) =>
    applyChatActions(
      { actions: [{ type: "flag_training_structure", request }] },
      { agent: "stub", message }
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
  assert.match(corrected, /unchanged|Nothing was actually flagged|no request reached/i);

  // Applied but unverified: the claim is withdrawn with a reason.
  const unverified = reconcileTrainingStructureReply(promise, [
    { type: "flag_training_structure", result: { ok: false, verified: false }, error: "the decision did not store" },
  ]);
  assert.match(unverified, /the decision did not store/);
  assert.doesNotMatch(unverified, /I'll flag it/);

  // Verified: the prose survives and the receipt says it is WAITING, not done.
  const verified = reconcileTrainingStructureReply(promise, [
    { type: "flag_training_structure", result: { ok: true, verified: true, decision_id: 1 } },
  ]);
  assert.match(verified, /I'll flag it/);
  assert.match(verified, /waiting for you to confirm/);
  assert.match(verified, /nothing in your plan has changed yet/i);

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
  assert.match(spec, /confirm/i, "and says plainly that it changes nothing by itself");
});

// ---- anchor-slide cut pressure regression -------------------------------------

test("cut-quality anchor slide still reads every representative lift, not one", () => {
  const source = readFileSync(join(root, "src/repo/cut-quality.ts"), "utf8");
  // The cut read's anchors are program-state lifts, deliberately independent of
  // strength_objectives — this change must not have coupled them.
  assert.doesNotMatch(source, /strength_objectives|getActiveStrengthObjective/);
  assert.match(source, /anchors: CutQualityAnchor\[\]/);
});
