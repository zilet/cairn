import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { applyCaseConferenceSchedulerSuccess, enqueueAgentJob, onJobEvent } from "../dist/agentJobs.js";
import {
  persistBrainReviewEvent,
  startBrainReviewJobSubscriber,
  stopBrainReviewJobSubscriber,
} from "../dist/brainReviewJobs.js";
import { emitBrainEvent, flushBrainEventsForTest, resetBrainEventsForTest } from "../dist/brainEvents.js";
import { db, repo } from "./_seed.js";

afterEach(() => stopBrainReviewJobSubscriber());

function routed(overrides = {}) {
  return {
    kind: "session_finished",
    domain: "training",
    date: "2026-07-09",
    entity_id: 12,
    subject_key: null,
    reason: "session reached its natural review boundary",
    material: false,
    clinical: false,
    fingerprint: "a".repeat(64),
    review: true,
    emitted_at: "2026-07-09T18:00:00.000Z",
    ...overrides,
  };
}

async function runJob(id) {
  const done = new Promise((resolve, reject) => {
    const off = onJobEvent(id, (event) => {
      if (event.type === "done") {
        off();
        resolve(event);
      } else if (event.type === "error") {
        off();
        reject(new Error(event.message));
      }
    });
  });
  enqueueAgentJob(id);
  let timer;
  try {
    return await Promise.race([
      done,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`agent job#${id} timed out`)), 3_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("durable brain-review creation deduplicates one fingerprint inside the cooldown", async () => {
  const enqueued = [];
  const deps = { enqueue: (id) => enqueued.push(id), cooldownMs: 10 * 60_000 };
  const first = persistBrainReviewEvent(routed(), deps);
  const second = persistBrainReviewEvent(routed(), deps);
  await Promise.resolve();

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.job.id, first.job.id);
  assert.deepEqual(enqueued, [first.job.id]);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM agent_jobs WHERE kind = 'brain_review'`).get().n, 1);
  assert.equal(first.job.input.fingerprint, "a".repeat(64));
  assert.equal(first.job.input.event.reason, "session reached its natural review boundary");

  db.prepare(`UPDATE agent_jobs SET created_at = datetime('now', '-1 day') WHERE id = ?`).run(first.job.id);
  const afterCooldown = persistBrainReviewEvent(routed(), deps);
  await Promise.resolve();
  assert.equal(afterCooldown.created, true);
  assert.notEqual(afterCooldown.job.id, first.job.id);
  assert.deepEqual(enqueued, [first.job.id, afterCooldown.job.id]);
});

test("the startup subscriber ignores non-review food/set signals and queues only quiet brain-review jobs", async () => {
  resetBrainEventsForTest();
  const enqueued = [];
  startBrainReviewJobSubscriber({ enqueue: (id) => enqueued.push(id) });

  emitBrainEvent({ kind: "food_logged", domain: "nutrition", date: "2026-07-09", entity_id: 1 });
  emitBrainEvent({ kind: "set_logged", domain: "training", date: "2026-07-09", entity_id: 12 });
  flushBrainEventsForTest(1_000, 0);
  await Promise.resolve();
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM agent_jobs`).get().n, 0);

  const session = { kind: "session_finished", domain: "training", date: "2026-07-09", entity_id: 12 };
  emitBrainEvent(session);
  flushBrainEventsForTest(2_000, 0);
  emitBrainEvent(session);
  flushBrainEventsForTest(3_000, 0); // bus cooldown disabled; durable cooldown still dedupes
  await Promise.resolve();

  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM agent_jobs`).get().n, 1);
  assert.equal(repo.getAgentJob(enqueued[0]).kind, "brain_review");

  // Even an explicitly material nutrition correction can enqueue only the quiet
  // review kind — never proposal/evolve_program or a plan write.
  emitBrainEvent({
    kind: "food_corrected",
    domain: "nutrition",
    date: "2026-07-09",
    entity_id: 1,
    material: true,
  });
  flushBrainEventsForTest(4_000, 0);
  await Promise.resolve();
  const kinds = db
    .prepare(`SELECT kind FROM agent_jobs ORDER BY id`)
    .all()
    .map((row) => row.kind);
  assert.deepEqual(kinds, ["brain_review", "brain_review"]);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM plan_proposals`).get().n, 0);
});

test("the brain-review worker completes through the quiet insight operation without drafting plans", async () => {
  const job = repo.createAgentJob({
    kind: "brain_review",
    agent: "stub",
    input: { fingerprint: "b".repeat(64), event: routed({ fingerprint: undefined }) },
  });
  await runJob(job.id);

  const stored = repo.getAgentJob(job.id);
  assert.equal(stored.status, "done");
  assert.equal(stored.kind, "brain_review");
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM plan_proposals`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM meal_plans`).get().n, 0);
});

test("the case-conference job returns advisory output without persisting specialist or plan writes", async () => {
  const job = repo.createAgentJob({
    kind: "case_conference",
    agent: "stub",
    input: {
      question: "Review the next phase across training, nutrition, and recovery.",
      domains: ["training", "nutrition", "recovery", "operator"],
    },
  });
  await runJob(job.id);

  const stored = repo.getAgentJob(job.id);
  assert.equal(stored.status, "done");
  assert.equal(stored.kind, "case_conference");
  assert.equal(stored.result.ok, false, "the proposal-shaped offline stub is not accepted as specialist output");
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM plan_proposals`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM brain_decisions`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM insights`).get().n, 0);
});

test("scheduler revision stamps are committed only after a successful conference result", () => {
  const input = {
    scheduler_success: {
      brain_revision_last_month: "2026-07",
      brain_revision_phase_sig: '{"name":"build"}',
      brain_revision_regression_sig: "recovery_wellbeing",
      unrelated_key: "must not write",
    },
  };
  assert.equal(applyCaseConferenceSchedulerSuccess(input, { ok: false }), false);
  assert.equal(repo.getAppState("brain_revision_last_month"), null);

  assert.equal(applyCaseConferenceSchedulerSuccess(input, { ok: true }), true);
  assert.equal(repo.getAppState("brain_revision_last_month"), "2026-07");
  assert.equal(repo.getAppState("brain_revision_phase_sig"), '{"name":"build"}');
  assert.equal(repo.getAppState("brain_revision_regression_sig"), "recovery_wellbeing");
  assert.equal(repo.getAppState("unrelated_key"), null);
});
