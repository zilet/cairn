// Durable agent-job lifecycle (src/repo.ts agent_jobs CRUD) + crash recovery.
// These back the generalized background-job spine: a job persisted here is what
// lets a backgrounded agentic op (session-suggest, meal plan/swap/recipe,
// nutrition check-in, insight, health review, chat distill) survive a tab switch
// / reload / restart. The agent itself never runs in the harness (offline,
// deterministic), so we exercise the state machine directly:
//   - createAgentJob → queued; round-trips kind/input/agent
//   - listActiveAgentJobs: queued+running only, oldest-first
//   - markAgentJobRunning is guarded (won't revive a canceled-while-queued job)
//   - setAgentJobPhase moves only a running job (+ determinate meta round-trips)
//   - finish / fail / cancel state transitions + result hydration
//   - recoverAgentJobs: interrupted 'running' → error, queued re-listed
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";

beforeEach(() => {
  try { db.prepare(`DELETE FROM agent_jobs`).run(); } catch { /* table may not exist */ }
});

test("createAgentJob opens a queued job and round-trips its fields", () => {
  const j = repo.createAgentJob({ kind: "session_suggest", input: { minutes: 45, focus: "legs" }, agent: "stub" });
  assert.equal(j.status, "queued");
  assert.equal(j.phase, "queued");
  assert.equal(j.kind, "session_suggest");
  assert.equal(j.agent, "stub");
  assert.deepEqual(j.input, { minutes: 45, focus: "legs" }, "input_json hydrates back to the typed object");
  assert.equal(j.started_at, null);
  assert.equal(repo.getAgentJob(j.id).kind, "session_suggest");
});

test("listActiveAgentJobs returns queued+running oldest-first, excludes terminal", () => {
  const a = repo.createAgentJob({ kind: "meal_plan" });
  const b = repo.createAgentJob({ kind: "recipe" });
  const c = repo.createAgentJob({ kind: "insight" });
  repo.markAgentJobRunning(a.id);                            // running
  repo.finishAgentJob(c.id, { result: { ok: true } });       // terminal → excluded
  const active = repo.listActiveAgentJobs();
  assert.deepEqual(active.map((t) => t.id), [a.id, b.id], "running a + queued b, in id order; finished c gone");
  assert.equal(active[0].status, "running");
  assert.equal(active[1].status, "queued");
});

test("markAgentJobRunning is guarded — a canceled-while-queued job is never revived", () => {
  const j = repo.createAgentJob({ kind: "meal_swap" });
  repo.cancelAgentJob(j.id);
  assert.equal(repo.getAgentJob(j.id).status, "canceled");
  repo.markAgentJobRunning(j.id); // no-op: only flips from 'queued'
  assert.equal(repo.getAgentJob(j.id).status, "canceled", "still canceled — the worker can't pick it up");
});

test("setAgentJobPhase moves only a running job and round-trips determinate meta", () => {
  const j = repo.createAgentJob({ kind: "meal_plan" });
  repo.setAgentJobPhase(j.id, "drafting"); // ignored while still queued
  assert.equal(repo.getAgentJob(j.id).phase, "queued");
  repo.markAgentJobRunning(j.id);
  assert.ok(repo.getAgentJob(j.id).started_at, "started_at stamped on run");
  repo.setAgentJobPhase(j.id, "checking", { frac: { done: 1, total: 2 } });
  const running = repo.getAgentJob(j.id);
  assert.equal(running.phase, "checking");
  assert.deepEqual(running.meta, { frac: { done: 1, total: 2 } }, "determinate progress meta hydrates");
});

test("finishAgentJob stamps done + records the contract body as job.result", () => {
  const j = repo.createAgentJob({ kind: "session_suggest" });
  repo.markAgentJobRunning(j.id);
  const result = { ok: true, session: { items: [{ exercise: "Squat" }], est_minutes: 45 } };
  const done = repo.finishAgentJob(j.id, { result, chosen_agent: "stub", ref_table: "plan_proposals", ref_id: 7 });
  assert.equal(done.status, "done");
  assert.equal(done.chosen_agent, "stub");
  assert.equal(done.ref_table, "plan_proposals");
  assert.equal(done.ref_id, 7);
  assert.deepEqual(done.result, result, "result_json hydrates back as job.result, byte-for-byte the sync body");
  assert.ok(done.finished_at);
});

test("failAgentJob marks error; a non-terminal-only cancel returns null once terminal", () => {
  const j = repo.createAgentJob({ kind: "health_review" });
  repo.markAgentJobRunning(j.id);
  const failed = repo.failAgentJob(j.id, "agent down");
  assert.equal(failed.status, "error");
  assert.match(failed.error, /agent down/);
  assert.equal(repo.cancelAgentJob(j.id), null, "cancel is a no-op on an already-terminal job");
});

test("cancelAgentJob flips a running job; a queued one too", () => {
  const running = repo.createAgentJob({ kind: "recipe" });
  repo.markAgentJobRunning(running.id);
  assert.equal(repo.cancelAgentJob(running.id).status, "canceled");
  const queued = repo.createAgentJob({ kind: "recipe" });
  assert.equal(repo.cancelAgentJob(queued.id).status, "canceled", "a never-started job cancels cleanly too");
});

test("recoverAgentJobs errors interrupted runs and re-lists queued ones", () => {
  const interrupted = repo.createAgentJob({ kind: "meal_plan" });
  repo.markAgentJobRunning(interrupted.id);
  const queued = repo.createAgentJob({ kind: "insight" });

  const { requeue, interrupted: n } = repo.recoverAgentJobs();

  assert.equal(n, 1, "one interrupted run");
  assert.deepEqual(requeue, [queued.id], "the queued job is handed back to re-drain");
  const after = repo.getAgentJob(interrupted.id);
  assert.equal(after.status, "error", "interrupted run marked error (coachOp may have partially persisted a draft)");
  assert.match(after.error, /interrupted by a restart/i);
});
