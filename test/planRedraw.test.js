// REDRAW MY WEEK HAS A DOOR ON THE PLAN TAB.
//
// A training-STRUCTURE request ("build my week around my six anchors", "drop to three
// days", "move heavy legs to Thursday") used to be reachable only by knowing the magic
// words in chat. POST /api/plan/redraw is the same hand-off in plain sight — and because
// it writes through the SAME function, the two doors can never build the week twice:
// a request typed on Plan and the same words later said in chat resolve to ONE standing
// flag with ONE background build behind it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { planExercisesRouter } from "../dist/routes/plan-exercises.js";
import { applyChatActions } from "../dist/chatTurns.js";
import {
  MAX_REDRAW_REQUEST_CHARS,
  registerStructureBuildEnqueuer,
  settleStructureBuild,
} from "../dist/domain/brain/structure-request.js";
import { TRAINING_STRUCTURE_REQUEST_MAX } from "../dist/chatActions.js";

// The runner seam: these assert the durable job row and the ledger, never a spawned CLI.
const enqueued = [];
registerStructureBuildEnqueuer((id) => enqueued.push(id));

const REQUEST = "Move heavy legs to Thursday and keep Tuesday easy.";

function callRoute(method, path, { body = {}, params = {}, query = {} } = {}) {
  const layer = planExercisesRouter.stack.find(
    (entry) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  assert.ok(layer, `missing ${method.toUpperCase()} ${path}`);
  let status = 200;
  let payload;
  const res = {
    status(value) {
      status = value;
      return this;
    },
    json(value) {
      payload = value;
      return this;
    },
  };
  layer.route.stack.at(-1).handle({ body, params, query }, res);
  return { status, payload };
}

const redraw = (request) => callRoute("post", "/plan/redraw", { body: { request } });
const redrawStatus = () => callRoute("get", "/plan/redraw").payload;

function structureFlags() {
  return ["review", "observed", "superseded"]
    .flatMap((status) => repo.listBrainDecisions({ status, kind: "training_structure", limit: 100 }))
    .filter((row) => row?.action?.kind === "training_structure_request");
}

function structureJobs() {
  return db
    .prepare(`SELECT id, kind, input_json FROM agent_jobs WHERE kind = 'evolve_program' ORDER BY id`)
    .all()
    .map((row) => ({ id: Number(row.id), input: JSON.parse(row.input_json || "{}") }));
}

test("a redraw typed on Plan records one request row and hands it to the coach", () => {
  enqueued.length = 0;
  repo.setSettings({ lead_mode: "lead" });

  const { status, payload } = redraw(REQUEST);
  assert.equal(status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.verified, true, "the receipt is a server-owned readback, not a claim");
  assert.equal(payload.posture, "lands", "under lead the built week announces and lands with Undo");
  assert.ok(payload.lands_on, "and it says which day");

  const flags = structureFlags();
  assert.equal(flags.length, 1, "exactly one request row");
  const [flag] = flags;
  assert.equal(flag.id, payload.decision_id);
  assert.equal(flag.source, "plan", "the door it came through is recorded");
  assert.equal(flag.context.requested_on_plan, true);
  assert.equal(flag.rationale, REQUEST, "the athlete's words, verbatim");
  assert.equal(flag.action.kind, "training_structure_request");
  assert.equal(flag.status, "review");

  const jobs = structureJobs();
  assert.equal(jobs.length, 1, "exactly one background build");
  assert.equal(jobs[0].input.structure_flag_decision_id, flag.id, "linked back to the flag it settles");
  assert.equal(payload.build.job_id, jobs[0].id);
  assert.deepEqual(enqueued, [jobs[0].id], "the coach was genuinely handed the work");
});

test("asking again in different capitalisation never builds the week twice", () => {
  enqueued.length = 0;
  repo.setSettings({ lead_mode: "lead" });
  const first = redraw(REQUEST).payload;

  const again = redraw("  MOVE HEAVY LEGS TO THURSDAY AND KEEP TUESDAY EASY.  ").payload;
  assert.equal(again.decision_id, first.decision_id, "the same ask, the same row");
  assert.equal(again.ok, true);
  assert.equal(again.build.job_id, first.build.job_id, "and the same build — nothing stacks");
  assert.equal(structureFlags().length, 1);
  assert.equal(structureJobs().length, 1);
  assert.deepEqual(enqueued, [first.build.job_id]);
});

test("the same words said in chat reuse the flag typed on Plan — one standing ask, two doors", () => {
  enqueued.length = 0;
  repo.setSettings({ lead_mode: "lead" });
  const onPlan = redraw(REQUEST).payload;

  const inChat = applyChatActions(
    { actions: [{ type: "flag_training_structure", request: REQUEST }] },
    { agent: "stub", message: REQUEST, enqueueJob: (id) => enqueued.push(id) }
  ).applied.find((row) => row.type === "flag_training_structure");

  assert.equal(inChat.result.decision_id, onPlan.decision_id, "chat points back at the Plan row");
  assert.equal(inChat.result.verified, true);
  assert.equal(structureFlags().length, 1, "no second request row");
  assert.equal(structureJobs().length, 1, "no second week drafted");
});

test("GET reports the standing request, its live build and the coach's own sentence", () => {
  repo.setSettings({ lead_mode: "lead" });
  const receipt = redraw(REQUEST).payload;

  const status = redrawStatus();
  assert.equal(status.posture, "lands");
  // The bound travels with the read so the PWA's composer never keeps its own copy of it.
  assert.equal(status.max_chars, MAX_REDRAW_REQUEST_CHARS);
  assert.equal(status.standing.length, 1);
  const [row] = status.standing;
  assert.equal(row.decision_id, receipt.decision_id);
  assert.equal(row.request, REQUEST);
  assert.equal(row.source, "plan");
  assert.equal(row.build.status, "queued");
  assert.equal(row.outcome, null);
  assert.equal(row.error, null);
  assert.equal(row.review_required, false, "under lead an in-flight build is the coach's work");
  assert.match(row.explanation, /rebuilding the week/i);
  assert.ok(row.asked_at, "and when it was asked");
});

test("a build the coach could not do is visible, not silent", () => {
  repo.setSettings({ lead_mode: "lead" });
  const receipt = redraw(REQUEST).payload;

  settleStructureBuild(receipt.decision_id, { ok: false, error: "the coach was unavailable" });

  const [row] = redrawStatus().standing;
  assert.equal(row.decision_id, receipt.decision_id);
  assert.equal(row.outcome, "failed");
  assert.equal(row.review_required, true, "a failure is the one state the athlete has to see");
  assert.match(row.error, /unavailable/);
  assert.equal(row.build, null, "nothing is still running");
  // Calm, and never a gate: it says what happened and where the door is.
  assert.match(row.explanation, /Nothing changed/);
  assert.doesNotMatch(row.explanation, /you must|failed to|error/i);
});

test("an empty or too-short ask is a designed ok:false at 200, not an HTTP error", () => {
  for (const request of ["", "   ", "do"]) {
    const { status, payload } = redraw(request);
    assert.equal(status, 200, "the PWA's api() helper resolves to the body regardless of status");
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "say what to change");
  }
  assert.equal(structureFlags().length, 0, "nothing was written");
  assert.equal(structureJobs().length, 0);

  // A non-STRING body is not a request either. `String(anything)` used to turn an object
  // into "[object Object]", store that as the athlete's own words, and enqueue a real
  // build behind it.
  for (const body of [{ request: { text: REQUEST } }, { request: [REQUEST] }, { request: 42 }, {}]) {
    const { status, payload } = callRoute("post", "/plan/redraw", { body });
    assert.equal(status, 200);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "say what to change");
  }
  // And an agent that is not a name is refused rather than coerced into one.
  const badAgent = callRoute("post", "/plan/redraw", { body: { request: REQUEST, agent: { name: "stub" } } });
  assert.equal(badAgent.status, 200);
  assert.equal(badAgent.payload.ok, false);

  assert.equal(structureFlags().length, 0, "nothing was written by any of them");
  assert.equal(structureJobs().length, 0);
});

test("one long ask is ONE ask, whichever door it comes through", () => {
  // Chat slices a flag_training_structure request to TRAINING_STRUCTURE_REQUEST_MAX
  // before it is ever handed over. The Plan door used to cap higher and refuse instead,
  // so the SAME 1,100-character sentence arrived as two different strings — one sliced,
  // one whole — matched nothing in the standing lookup, and built the week twice.
  enqueued.length = 0;
  repo.setSettings({ lead_mode: "lead" });
  const long = `${"Rebuild my week around my six anchors. ".repeat(30)}`.slice(0, 1_100);
  assert.equal(long.length, 1_100);

  // The anti-drift contract itself: chat's historical name and the domain's constant are
  // the SAME number, because chat now imports it rather than keeping a copy.
  assert.equal(TRAINING_STRUCTURE_REQUEST_MAX, MAX_REDRAW_REQUEST_CHARS, "one bound, two names");

  const onPlan = redraw(long).payload;
  assert.equal(onPlan.ok, true, "a long ask is accepted, not refused");
  const [flag] = structureFlags();
  assert.equal(flag.rationale.length, MAX_REDRAW_REQUEST_CHARS, "stored at the shared bound");

  const inChat = applyChatActions(
    { actions: [{ type: "flag_training_structure", request: long }] },
    { agent: "stub", message: long, enqueueJob: (id) => enqueued.push(id) }
  ).applied.find((row) => row.type === "flag_training_structure");

  assert.equal(inChat.result.decision_id, onPlan.decision_id, "one flag");
  assert.equal(structureFlags().length, 1);
  assert.equal(structureJobs().length, 1, "one build");
});
