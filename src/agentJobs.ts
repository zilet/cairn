import { createProgressBus, createSerialRunner } from "./jobRunner.js";
import { isAgentJobKind } from "./agentJobKinds.js";
import * as repo from "./repo.js";
import {
  suggestSession,
  draftCoachProposal,
  evolveProgram,
  draftMealPlan,
  swapMealAgentic,
  generateRecipe,
  nutritionCheckin,
  generateInsight,
  runHealthReview,
  synthesizeHealth,
  distillChat,
} from "./coachOps.js";
import { computeDayRead, localToday } from "./dayread.js";

// Durable, in-process agent-job engine — the GENERALIZATION of chatTurns.ts for
// the other blocking agentic ops. An op is no longer a request held open for
// 90–300s on a CLI subprocess: the API persists an `agent_jobs` row (status
// 'queued') and hands the id here. This SERIAL worker (one CLI agent at a time,
// like enrich.ts / chatTurns.ts) drains the queue, runs the existing coachOp,
// records a thin pointer to the already-persisted result row + the contract body,
// and emits live progress on an event bus the SSE endpoint forwards. Because the
// job lives in SQLite, an op interrupted by a tab switch / reload / restart
// survives (the PWA rebuilds in-flight + queued jobs from listActiveAgentJobs).
//
// Degrades exactly like the rest of the loop: no enabled agent → the coachOp
// returns its designed ok:false, recorded as the job's `done` result (NOT an
// error — ok:false is a valid outcome the client renders); a real throw → the
// job is marked 'error', nothing escapes the drain loop.

// ---------- progress bus ----------
// One emitter, one event name per job ("job:<id>"). The SSE handler subscribes
// for the job it's streaming; the worker emits on every phase change and on the
// terminal transition. Unlike chat there is NO `delta` — these are one-shot JSON
// ops, so progress is phase captions (optionally with a determinate `frac`).
export type JobEvent =
  | { type: "phase"; job: any }
  | { type: "done"; job: any; result: any }
  | { type: "error"; job: any; message: string }
  | { type: "canceled"; job: any };

const jobBus = createProgressBus<JobEvent>("job");
function emit(id: number, payload: JobEvent): void { jobBus.emit(id, payload); }
export function onJobEvent(id: number, listener: (e: JobEvent) => void): () => void {
  return jobBus.on(id, listener);
}

// ---------- serial queue ----------
// Live AbortControllers keyed by job id, so a Stop can SIGKILL the running CLI.
// processAgentJob releases its own controller in a finally; the runner backstop
// below only records a failure that escaped processAgentJob's own handling.
const controllers = new Map<number, AbortController>();

const runner = createSerialRunner(processAgentJob, (id, e) => {
  // A failing job must never break the loop. processAgentJob already persists its
  // own failure; this is the last-resort backstop.
  try {
    const cur = repo.getAgentJob(id) as any;
    if (cur && (cur.status === "queued" || cur.status === "running")) {
      const failed = repo.failAgentJob(id, e?.message ?? String(e));
      emit(id, { type: "error", job: failed, message: e?.message ?? String(e) });
    }
  } catch { /* ignore */ }
  console.error(`[jobs] job#${id} failed: ${e?.message ?? e}`);
});

export function enqueueAgentJob(id: number): void {
  runner.enqueue(id);
}

async function processAgentJob(id: number): Promise<void> {
  const job = repo.getAgentJob(id) as any;
  if (!job || job.status !== "queued") return; // canceled while queued, or already handled

  repo.markAgentJobRunning(id);
  emit(id, { type: "phase", job: repo.getAgentJob(id) });

  const controller = new AbortController();
  controllers.set(id, controller);

  const onPhase = (phase: string, meta?: any) => {
    if (controller.signal.aborted) return;
    repo.setAgentJobPhase(id, phase, meta);
    emit(id, { type: "phase", job: repo.getAgentJob(id) });
  };
  const hooks = { signal: controller.signal, onPhase };
  const input = job.input ?? {};
  const agent: string | undefined = job.agent ?? input.agent ?? undefined;

  try {
    if (!isAgentJobKind(job.kind)) throw new Error(`unknown job kind: ${job.kind}`);

    // Each kind runs the existing coachOp threading the hooks. The op's RETURN
    // VALUE is the contract body — byte-for-byte what the sync endpoint returned
    // before this change — so the client's done-handler reuses its old rendering.
    let result: any;
    let ref: { ref_table?: string | null; ref_id?: number | null } = {};
    let chosen: string | null = null;

    switch (job.kind) {
      case "session_suggest": {
        result = await suggestSession(agent, {
          minutes: input.minutes != null ? Number(input.minutes) : undefined,
          equipment: input.equipment != null ? String(input.equipment) : undefined,
          focus: input.focus != null ? String(input.focus) : undefined,
          constraints: input.constraints != null ? String(input.constraints) : undefined,
          date: input.date != null ? String(input.date) : undefined,
        }, hooks);
        chosen = result?.agent ?? null;
        break;
      }
      case "proposal": {
        result = await draftCoachProposal(agent, input.instruction != null ? String(input.instruction) : undefined, hooks);
        chosen = result?.agent ?? null;
        if (result?.proposal?.id) ref = { ref_table: "plan_proposals", ref_id: result.proposal.id };
        break;
      }
      case "evolve_program": {
        result = await evolveProgram(agent, input.instruction != null ? String(input.instruction) : undefined, hooks);
        chosen = result?.agent ?? null;
        if (result?.proposal?.id) ref = { ref_table: "plan_proposals", ref_id: result.proposal.id };
        break;
      }
      case "meal_plan": {
        result = await draftMealPlan(agent, input.instruction, hooks);
        chosen = result?.agent ?? null;
        ref = { ref_table: "meal_plans", ref_id: result?.plan?.id ?? null };
        break;
      }
      case "meal_swap": {
        // The plan must be resolved here (the API only did a pre-check before
        // enqueue) so a long queue still swaps against the current plan state.
        const plan = repo.getMealPlan(Number(input.id));
        if (!plan) { result = { ok: false, error: "not found" }; break; }
        result = await swapMealAgentic(agent, {
          plan, id: Number(input.id), day: String(input.day ?? ""),
          mealIndex: Number(input.meal_index), hint: input.hint,
        }, hooks);
        chosen = result?.agent ?? null;
        ref = { ref_table: "meal_plans", ref_id: Number(input.id) };
        break;
      }
      case "recipe": {
        const plan = repo.getMealPlan(Number(input.id));
        if (!plan) { result = { ok: false, error: "not found" }; break; }
        result = await generateRecipe(agent, {
          plan, id: Number(input.id), day: String(input.day ?? ""), mealIndex: Number(input.meal_index),
        }, hooks);
        chosen = result?.agent ?? null;
        ref = { ref_table: "meal_plans", ref_id: Number(input.id) };
        break;
      }
      case "nutrition_checkin": {
        result = await nutritionCheckin(agent, input.window != null ? Number(input.window) : undefined, hooks);
        chosen = result?.agent ?? null;
        if (result?.proposal?.id) ref = { ref_table: "plan_proposals", ref_id: result.proposal.id };
        break;
      }
      case "insight":
      case "weekly_read": {
        result = await generateInsight(agent, job.kind === "weekly_read" ? "weekly_read" : "connection", hooks);
        chosen = result?.agent ?? null;
        if (result?.insight?.id) ref = { ref_table: "insights", ref_id: result.insight.id };
        break;
      }
      case "health_review": {
        result = await runHealthReview(agent, hooks);
        chosen = result?.agent ?? null;
        if (result?.review?.id) ref = { ref_table: "health_reviews", ref_id: result.review.id };
        break;
      }
      case "health_synthesis": {
        result = await synthesizeHealth(agent, hooks);
        chosen = result?.agent ?? null;
        break;
      }
      case "day_read_override": {
        const date = input.date != null ? String(input.date) : undefined;
        const override = input.override != null ? String(input.override) : undefined;
        onPhase("rereading your day");
        // The `done` result MUST be byte-for-byte what GET /api/today-read?override=
        // returns (the read object incl. source + the persisted override), so the
        // PWA reuses its Brief-from-read render unchanged. computeDayRead persists
        // the steer (no-clobber guard) so it survives a reload.
        result = await computeDayRead({ date, override, agent });
        chosen = result?.agent ?? null;
        ref = { ref_table: "day_reads", ref_id: null };
        // Outcome learning, mirroring the synchronous handler's fresh-compute path.
        try { repo.recordSuggestion("day_read", date || localToday(), { kind: result?.kind ?? null, focus: result?.focus ?? null, est_minutes: result?.est_minutes ?? null, override: override ?? null }); } catch { /* never block the job */ }
        break;
      }
      case "chat_distill": {
        // The conversation was archived BEFORE this job was enqueued; the
        // pre-archive history rides in input_json so the distill still sees it.
        // Read it RAW — the hydrated `input` strips `history` from client echoes.
        const hist = repo.getAgentJobRawInput(id)?.history;
        result = await distillChat(agent, Array.isArray(hist) ? hist : [], hooks);
        break;
      }
      default:
        throw new Error(`unknown job kind: ${job.kind}`);
    }

    // Canceled mid-run: cancelAgentJob already flipped status + emitted the event.
    const cur = repo.getAgentJob(id) as any;
    if (cur?.status === "canceled" || controller.signal.aborted) return;

    const finished = repo.finishAgentJob(id, {
      result, chosen_agent: chosen, ref_table: ref.ref_table ?? null, ref_id: ref.ref_id ?? null,
    });
    emit(id, { type: "done", job: finished, result });
  } catch (e: any) {
    const cur = repo.getAgentJob(id) as any;
    if (cur?.status === "canceled" || controller.signal.aborted) return; // Stop, not a failure
    const failed = repo.failAgentJob(id, e?.message ?? String(e));
    emit(id, { type: "error", job: failed, message: e?.message ?? String(e) });
  } finally {
    controllers.delete(id);
  }
}

// User-requested Stop. Flips the job state first (so the worker's catch knows not
// to write an error), then aborts any live subprocess, then emits the terminal
// event. No-op if the job already finished. Returns the job or null.
export function cancelAgentJob(id: number) {
  const job = repo.cancelAgentJob(id);
  if (!job) return null;
  try { controllers.get(id)?.abort(); } catch { /* not running */ }
  emit(id, { type: "canceled", job });
  return job;
}

// Shutdown helper: abort every live agent-job subprocess (see chatTurns.abortAllTurns).
export function abortAllJobs() {
  for (const c of controllers.values()) {
    try { c.abort(); } catch { /* not running */ }
  }
}

// Crash recovery (boot): mark interrupted 'running' jobs errored (their coachOp
// may have partially persisted a draft — re-running risks duplicates) and
// re-enqueue the 'queued' ones that never started. Mirrors recoverChatTurns.
export function recoverAgentJobs(): { requeued: number; interrupted: number } {
  const { requeue, interrupted } = repo.recoverAgentJobs();
  for (const id of requeue) enqueueAgentJob(id);
  if (requeue.length || interrupted) {
    console.log(`[jobs] recovered ${requeue.length} queued + ${interrupted} interrupted job(s).`);
  }
  return { requeued: requeue.length, interrupted };
}

// Re-export so the scheduler / boot can stamp the local date consistently.
export { localToday };
