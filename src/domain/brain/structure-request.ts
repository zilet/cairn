// The chat → coach-lane hand-off for a training-STRUCTURE request, made real.
//
// `flag_training_structure` used to record an ask-tier `training_structure` decision
// holding the athlete's sentence — and stop. Nothing consumed it: no surface offered a
// confirm, no producer read it, and the thaw sweep eventually re-filed it as an
// `observed` advisory. The athlete asked for a rebuilt week and got a receipt that said
// "waiting for you to confirm" over a queue with no door.
//
// Autonomy is server policy (VISION.md, Amendment 1): a structural change ANNOUNCES
// under the default lead posture and lands at the next natural boundary with a one-tap
// Undo; it asks only under review_everything. So the flag now does what the receipt
// promised — it hands the athlete's own words to the program-evolution op as a
// background job. The op drafts the restructure, `applyProposalWithAutonomy` routes it
// through the ONE policy, and when a decision exists for the built change the flag is
// superseded by it, so the athlete sees exactly one thing: the change itself, landing
// or waiting, never a second "request" row beside it.
import { createAgentJob, getAgentJob } from "../../repo/chat.js";
import { getBrainDecision, listBrainDecisions, patchBrainDecision } from "../../repo/brain-decisions.js";
import { getProposal } from "../../repo/proposals.js";
import { getSettings } from "../../repo/settings.js";
import { getSessionByDate } from "../../repo/sessions.js";
import { addDaysISO, localDateISO } from "../../repo/shared.js";

// Stored on the proposal as `instruction` — deliberately readable prose, because a
// proposal's instruction is the athlete-facing fallback for a decision's reason when the
// agent writes no rationale (recordAppliedProposalDecision). The prefix is the stable
// key any dedup pass can match on; the athlete's words follow.
export const STRUCTURE_REQUEST_INSTRUCTION_PREFIX = "restructure the week as the athlete asked";

export function structureRequestInstruction(request: string): string {
  return `${STRUCTURE_REQUEST_INSTRUCTION_PREFIX} — ${request.trim()}`.slice(0, 1_200);
}

// A restructure the ATHLETE asked for, recognisable by the instruction the hand-off
// stored on it. This is the provenance every special ruling below keys on: an ask is
// never a surprise, so it is exempt from the surprise budget; it lands at the athlete's
// own boundary, not the week's; and evidence drift is answered by REBUILDING it, never
// by setting it aside. Anything else — the weekly auto-evolution, a recovery week, a
// data-triggered draft — keeps the ordinary compare-and-set rulings unchanged.
export function isAthleteRequestedRestructure(proposal: { instruction?: unknown } | null | undefined): boolean {
  return String(proposal?.instruction ?? "").startsWith(STRUCTURE_REQUEST_INSTRUCTION_PREFIX);
}

// The athlete's words back out of a stored instruction (the inverse of
// structureRequestInstruction), so a rebuild can frame the same task again.
export function requestFromInstruction(instruction: unknown): string {
  const text = String(instruction ?? "");
  if (!text.startsWith(STRUCTURE_REQUEST_INSTRUCTION_PREFIX)) return text.trim();
  return text
    .slice(STRUCTURE_REQUEST_INSTRUCTION_PREFIX.length)
    .replace(/^\s*[—-]\s*/, "")
    .trim();
}

// The athlete's sentence compared the way a PERSON compares two asks: case- and
// whitespace-insensitive, smart quotes folded. The chat hand-off owned this privately;
// the retirement rule below has to answer the same question ("is this the ask that just
// landed?"), and two normalizers drifting apart would retire the wrong row.
export function normalizeStructureRequestText(text: unknown): string {
  return String(text ?? "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// A flag's own words, whichever field the writer of the day used. `action.request` is
// what the chat hand-off stores; `rationale` is the athlete's verbatim sentence.
export function structureRequestText(
  decision: { action?: unknown; context?: unknown; rationale?: unknown } | null
): string {
  const action = (decision?.action ?? {}) as Record<string, any>;
  const context = (decision?.context ?? {}) as Record<string, any>;
  const candidates = [action.request, context.athlete_request, decision?.rationale];
  for (const candidate of candidates) {
    const text = String(candidate ?? "").trim();
    if (text) return text;
  }
  return "";
}

// The proposal a landed decision applied, however that decision recorded it.
function decisionProposalId(decision: {
  action?: unknown;
  source_ref_type?: unknown;
  source_ref_key?: unknown;
}): number {
  const fromAction = Number((decision.action as any)?.proposal_id);
  if (fromAction > 0) return fromAction;
  const fromRef = decision.source_ref_type === "plan_proposal" ? Number(decision.source_ref_key) : 0;
  return fromRef > 0 ? fromRef : 0;
}

// WHERE an athlete-requested restructure lands. The week boundary (next Monday) exists
// so a week the athlete is living through is never rewritten underneath them by a change
// they did not ask for. When they DID ask, that protection is upside down — waiting up to
// a week to honour a direct request is the delay this module exists to remove. So the
// ask lands today, unless training has already been logged today (a half-lived DAY is
// the one thing still worth protecting), in which case tomorrow.
export function athleteRestructureLandingDate(today = localDateISO()): string {
  let trainedToday = false;
  try {
    trainedToday = !!getSessionByDate(today);
  } catch {
    trainedToday = false;
  }
  return trainedToday ? (addDaysISO(today, 1) ?? today) : today;
}

export function describeLandingDay(date: string, today = localDateISO()): string {
  if (date === today) return "today";
  if (date === addDaysISO(today, 1)) return "tomorrow";
  return `on ${date}`;
}

// The TASK the evolution prompt is pointed at. The prompt already carries the run plan,
// the stated run days, the week layout read and the hybrid-placement rules, so this only
// has to say what the athlete asked and that the SHAPE of the week is on the table.
export function structureRequestTask(request: string, summary: string | null): string {
  const lines = [
    `The athlete has asked, in their own words: "${request.trim()}"`,
    summary && summary.trim() && summary.trim() !== request.trim() ? `In short: ${summary.trim()}.` : null,
    'This is a request to change the SHAPE of the training week, so a full "days" restructure is expected here — rebuild the Mon–Sun template around what they asked for, honouring their stated run days and the hybrid-placement rules, and carry every lift\'s CURRENT working load forward (never a stale plan number). Optimise the week toward their stated goals. Explain each placement in plain words in the rationale.',
  ].filter(Boolean);
  return lines.join("\n");
}

export type StructureRequestPosture = "lands" | "asks";

// Whether the built change will LAND (announce → boundary, Undo) or wait to be confirmed.
// Read once from the same setting the autonomy layer reads, so the chat receipt and the
// ledger can never disagree about what happens next.
export function structureRequestPosture(): StructureRequestPosture {
  return getSettings().lead_mode === "review_everything" ? "asks" : "lands";
}

export function structureRequestLandingDate(today = localDateISO()): string {
  return athleteRestructureLandingDate(today);
}

// The sentence the flag carries while the build is in flight, per posture.
export function structureRequestExplanation(
  request: string,
  posture: StructureRequestPosture,
  landsOn: string
): string {
  return posture === "lands"
    ? `You asked for a change to how your training is built: “${request}”. The coach is rebuilding the week around it now; it lands ${describeLandingDay(landsOn)} with a one-tap Undo. Nothing has changed yet.`
    : `You asked for a change to how your training is built: “${request}”. The coach is drafting it now; because you review everything, it will wait here for you to confirm. Nothing has changed yet.`;
}

// ---- rebuilding at the boundary --------------------------------------------------
//
// The boundary pass is deterministic and never calls an agent, but an athlete-requested
// restructure is agent-built, so when its evidence has moved the pass cannot rewrite it
// inline the way it rewrites a deterministic producer's draft. It hands the rewrite to
// the SAME job kind the chat hand-off uses, with the same instruction and task, and the
// job runner lands the fresh draft through the ordinary pass the moment it is built.
// The enqueuer is registered by the agent-job runner at load; with none registered
// (tests, a boot that has not reached the runner yet) the job row still exists at
// `queued`, and recoverAgentJobs picks it up exactly like any other queued job.
let structureBuildEnqueuer: ((jobId: number) => void) | null = null;

export function registerStructureBuildEnqueuer(fn: ((jobId: number) => void) | null): void {
  structureBuildEnqueuer = fn;
}

export function enqueueStructureRebuild(input: {
  proposal: { id?: unknown; instruction?: unknown; agent?: unknown };
  decision_id: number;
  reason: string;
}): { job_id: number } | null {
  const request = requestFromInstruction(input.proposal.instruction);
  if (!request) return null;
  const agent = String(input.proposal.agent ?? "");
  const job = createAgentJob({
    kind: "evolve_program",
    // The producer that built the stale draft is asked again; rotation if it was rotation.
    agent: agent && agent !== "auto" && !agent.startsWith("auto-") ? agent : null,
    input: {
      instruction: String(input.proposal.instruction ?? structureRequestInstruction(request)),
      task: structureRequestTask(request, null),
      structure_rebuild: {
        of_decision_id: input.decision_id,
        of_proposal_id: Number(input.proposal.id) || null,
        reason: input.reason.slice(0, 300),
      },
    },
  }) as any;
  const jobId = Number(job?.id);
  if (!(jobId > 0)) return null;
  try {
    structureBuildEnqueuer?.(jobId);
  } catch {
    /* the queued row is durable; the runner's recovery pass will pick it up */
  }
  return { job_id: jobId };
}

// ---- the ONE build hand-off ------------------------------------------------------
//
// Every way a standing request gets built goes through here: the chat hand-off, the
// boot recovery pass, and the "still unanswered" sweep a landing runs. One path means a
// flag can never end up with a job nobody settles, or an outcome nobody enqueued for.

// How many times the SERVER may re-try a build on its own before it stops and hands the
// question back to the athlete. The athlete's own re-ask is never capped — asking again
// is the door, and a door with a counter on it is not a door.
export const MAX_AUTOMATIC_STRUCTURE_REBUILDS = 2;

export type StructureBuildTrigger = "athlete" | "auto";

// The flag rows a request can still be standing in. `review` is the in-flight/held
// shape; `observed` is what the thaw sweep re-files an unanswered one as, and it is
// STILL an open ask — reading it as terminal is how a re-ask became a dead end.
const STANDING_FLAG_STATUSES = ["review", "observed"] as const;

function isStructureRequestRow(row: { action?: unknown } | null | undefined): boolean {
  return (row?.action as any)?.kind === "training_structure_request";
}

export function standingStructureRequests(): any[] {
  const rows: any[] = [];
  for (const status of STANDING_FLAG_STATUSES) {
    for (const row of listBrainDecisions({ status, kind: "training_structure", limit: 100 })) {
      if (isStructureRequestRow(row)) rows.push(row);
    }
  }
  return rows;
}

// Has this request already been BUILT into a change? `built` is the only outcome that
// means a week exists somewhere for it; every other state (unsettled, failed) means the
// ask is still owed a draft.
export function structureRequestWasBuilt(decision: { context?: unknown } | null | undefined): boolean {
  return String(((decision?.context ?? {}) as Record<string, any>).structure_build_outcome ?? "") === "built";
}

/**
 * Hand a standing request's words to the program-evolution op as a durable background
 * job, and stamp the flag with what is now in flight.
 *
 * `trigger: "athlete"` is a person asking (again) — always honoured, and it clears the
 * server's own retry count. `trigger: "auto"` is the server noticing an unanswered ask;
 * it is capped, and at the cap the flag settles as failed WITH a review flag so the
 * athlete reads one calm sentence instead of the coach retrying forever in silence.
 *
 * Returns null when nothing was enqueued (no words, capped, or the job row failed) —
 * the capped case has already settled the flag.
 */
export function enqueueStructureBuild(input: {
  decision: { id?: unknown; status?: unknown; action?: unknown; context?: unknown; rationale?: unknown };
  trigger: StructureBuildTrigger;
  agent?: string | null;
  task?: string | null;
  explanation?: string | null;
  reason?: string | null;
  enqueue?: ((jobId: number) => void) | null;
}): { job_id: number; decision: any } | null {
  const flagId = Number(input.decision?.id);
  if (!(flagId > 0)) return null;
  const flag = (getBrainDecision(flagId) ?? input.decision) as any;
  const request = structureRequestText(flag);
  if (!request) return null;
  const context = (flag.context ?? {}) as Record<string, any>;
  const autoAttempts = Number(context.structure_auto_rebuild_attempts) || 0;
  if (input.trigger === "auto" && autoAttempts >= MAX_AUTOMATIC_STRUCTURE_REBUILDS) {
    settleStructureBuild(flagId, { ok: false, error: "the coach could not build it after several tries" });
    return null;
  }
  const posture = structureRequestPosture();
  const landsOn = structureRequestLandingDate();
  const explanation = input.explanation ?? structureRequestExplanation(request, posture, landsOn);
  const agent = String(input.agent ?? "");
  const job = createAgentJob({
    kind: "evolve_program",
    agent: agent && agent !== "auto" && !agent.startsWith("auto-") ? agent : null,
    input: {
      instruction: structureRequestInstruction(request),
      task: input.task && input.task.trim() ? input.task : structureRequestTask(request, null),
      // The link the runner settles back through — without it the flag is orphaned.
      structure_flag_decision_id: flagId,
    },
  }) as any;
  const jobId = Number(job?.id);
  if (!(jobId > 0)) return null;
  const updated =
    patchBrainDecision(flagId, {
      // An ask with a build in flight stands at `review` whatever the thaw last filed it
      // as; a terminal row is history and is never reopened from here.
      status: String(flag.status) === "observed" ? "review" : flag.status,
      action: { ...((flag.action ?? {}) as Record<string, any>), user_explanation: explanation },
      context: {
        ...context,
        // Under lead this is the coach's work item, not the athlete's question; the
        // previous attempt's failure reason goes with the previous attempt.
        review_required: posture === "asks",
        review_reason_code: null,
        structure_build_job_id: jobId,
        structure_build_enqueued_at: new Date().toISOString(),
        structure_build_outcome: null,
        structure_build_error: null,
        structure_build_posture: posture,
        structure_build_lands_on: posture === "lands" ? landsOn : null,
        structure_build_trigger: input.trigger,
        structure_build_attempts: (Number(context.structure_build_attempts) || 0) + 1,
        structure_auto_rebuild_attempts: input.trigger === "auto" ? autoAttempts + 1 : 0,
        ...(input.reason ? { structure_build_reason: String(input.reason).slice(0, 300) } : {}),
      },
    }) ?? flag;
  try {
    (input.enqueue ?? structureBuildEnqueuer)?.(jobId);
  } catch {
    /* the queued row is durable; the runner's recovery pass will pick it up */
  }
  return { job_id: jobId, decision: updated };
}

// Was this ask ever actually handed to the coach? The server may only RESUME work it
// once started. A flag with no hand-off on it is either a relic of the era before this
// module existed or a row written by hand, and rebuilding the athlete's week off a
// sentence nobody ever promised to build is a surprise, not a repair. Their own re-ask
// is the door for those — `trigger: "athlete"`, which this never gates.
function wasHandedToTheCoach(decision: { context?: unknown } | null | undefined): boolean {
  const context = (decision?.context ?? {}) as Record<string, any>;
  return Number(context.structure_build_job_id) > 0 || !!context.structure_build_enqueued_at;
}

// A standing request with no live build and no built change is an ask nobody is working
// on. Put it back in flight rather than leaving it to be re-asked by an athlete who
// already asked. No-op when a build is running, a week already exists for it, or the
// coach was never handed it in the first place.
export function ensureStructureBuildInFlight(
  decision: { id?: unknown; status?: unknown; action?: unknown; context?: unknown; rationale?: unknown },
  reason: string
): { job_id: number; decision: any } | null {
  if (!wasHandedToTheCoach(decision)) return null;
  if (structureRequestWasBuilt(decision) || liveStructureBuild(decision)) return null;
  return enqueueStructureBuild({ decision, trigger: "auto", reason });
}

/**
 * Boot recovery for the hand-off itself (called from the agent-job recovery pass, after
 * interrupted jobs have been failed and queued ones re-enqueued).
 *
 * A restart between "job created" and "job settled" used to leave the flag holding a
 * null outcome and a dead job id forever: `liveStructureBuild` read the terminal job as
 * "no live build", nothing ever wrote an outcome, and every later re-ask of those words
 * found that row and enqueued nothing. This reconciles flags against real job state —
 * finish what finished, restart what died, settle what cannot be restarted.
 */
export function recoverStructureBuilds(): { resumed: number[]; settled: number[] } {
  const resumed: number[] = [];
  const settled: number[] = [];
  for (const row of standingStructureRequests()) {
    const id = Number(row.id);
    if (!(id > 0)) continue;
    const context = (row.context ?? {}) as Record<string, any>;
    if (context.structure_build_outcome) continue;
    const jobId = Number(context.structure_build_job_id);
    // No hand-off, nothing to recover: a restart cannot have interrupted a build that
    // was never started, and this pass does not start one (see wasHandedToTheCoach).
    if (!(jobId > 0)) continue;
    const job = getAgentJob(jobId) as any;
    if (!job) {
      // The job row is gone — retention prunes terminal jobs 30 days after they finish,
      // so this ask has been unbuilt for a month. Hand the question back; a week rebuilt
      // now from a month-old sentence would be a surprise, not an answer.
      settleStructureBuild(id, { ok: false, error: "the build was lost" });
      settled.push(id);
      continue;
    }
    const status = String(job.status ?? "");
    // The runner still owns it (recoverAgentJobs re-enqueues queued rows).
    if (status === "queued" || status === "running") continue;
    if (status === "done") {
      // It finished; only the settle was lost. The stored result is the same one the
      // worker would have handed over.
      settleStructureBuild(id, job.result);
      settled.push(id);
      continue;
    }
    // A cancel is the athlete's own Stop — never restarted behind them.
    if (status === "canceled") {
      settleStructureBuild(id, { ok: false, error: "the build was stopped" });
      settled.push(id);
      continue;
    }
    if (ensureStructureBuildInFlight(row, "the build was interrupted by a restart")) {
      resumed.push(id);
      continue;
    }
    // Nothing could be restarted (capped, or the job row would not write): the flag may
    // not be left with a null outcome and no door.
    const after = (getBrainDecision(id)?.context ?? {}) as Record<string, any>;
    if (!after.structure_build_outcome) {
      settleStructureBuild(id, { ok: false, error: "the build could not be restarted" });
    }
    settled.push(id);
  }
  return { resumed, settled };
}

// A landed restructure ANSWERS the request it was built for — and only that request.
//
// It used to answer every standing one, which reads right ("the week was rebuilt, so
// nothing about the week is still open") and is wrong: two different asks are two
// different weeks. An athlete who asked on Monday for their runs moved and on Thursday
// for a fourth lifting day would have the Thursday ask silently closed by Monday's
// landing, with a receipt saying it was answered. So a landing answers
//   (a) the request whose own build produced it — matched on build lineage, and
//   (b) any other standing request asking for the SAME thing in different words.
// Anything else stays open, and — since a standing ask with no build behind it is the
// bug this module exists to remove — is handed back to the coach to be built.
// Returns the ids retired.
export function retireAnsweredStructureRequests(landedDecisionId: number): number[] {
  const landed = getBrainDecision(landedDecisionId);
  if (!landed || landed.status !== "applied") return [];
  const landedProposalId = decisionProposalId(landed);
  const landedProposal = landedProposalId > 0 ? (getProposal(landedProposalId) as any) : null;
  // The athlete's own words, read back out of the instruction the hand-off stored.
  const landedWords = normalizeStructureRequestText(requestFromInstruction(landedProposal?.instruction));
  const retired: number[] = [];
  for (const row of standingStructureRequests()) {
    const id = Number(row.id);
    if (!(id > 0) || id === landedDecisionId) continue;
    const context = (row.context ?? {}) as Record<string, any>;
    const builtThis =
      (Number(context.structure_build_decision_id) > 0 &&
        Number(context.structure_build_decision_id) === landedDecisionId) ||
      (landedProposalId > 0 && Number(context.structure_build_proposal_id) === landedProposalId);
    const sameAsk = !!landedWords && normalizeStructureRequestText(structureRequestText(row)) === landedWords;
    if (!builtThis && !sameAsk) {
      // A DIFFERENT ask. The landing says nothing about it, so it keeps standing — and
      // if nothing is building it, that is put right here rather than waiting for the
      // athlete to notice they were never answered.
      try {
        ensureStructureBuildInFlight(row, `another restructure landed (decision ${landedDecisionId})`);
      } catch {
        /* the flag stays standing; the boot recovery pass sweeps it again */
      }
      continue;
    }
    // A request whose own build is still running settles through settleStructureBuild.
    if (liveStructureBuild(row)) continue;
    const updated = patchBrainDecision(id, {
      status: "superseded",
      superseded_by: landedDecisionId,
      context: {
        ...context,
        review_required: false,
        review_reason_code: null,
        structure_request_answered_by: landedDecisionId,
        structure_request_answered_at: new Date().toISOString(),
      },
    });
    if (updated) retired.push(id);
  }
  return retired;
}

export interface StructureBuildRef {
  job_id: number;
  status: string;
}

// The build job a flag carries, if it is still doing something. Terminal jobs (done /
// error / canceled) return null — their outcome has already been settled onto the flag.
export function liveStructureBuild(decision: { context?: unknown } | null | undefined): StructureBuildRef | null {
  const context = (decision?.context ?? {}) as Record<string, any>;
  const jobId = Number(context.structure_build_job_id);
  if (!(jobId > 0) || context.structure_build_outcome) return null;
  const job = getAgentJob(jobId) as any;
  if (!job) return null;
  const status = String(job.status ?? "");
  return status === "queued" || status === "running" ? { job_id: jobId, status } : null;
}

// Called by the agent-job runner when the evolve_program job that a flag enqueued has
// finished, whichever way. A decision for the built change (announced / pending /
// applied / a review hold) supersedes the flag — the change is now the one row the
// athlete reads. No decision means the coach could not build it: the flag stays where it
// is, and its sentence says so plainly instead of promising a landing that is not coming.
export function settleStructureBuild(flagDecisionId: number, result: any): void {
  const flag = getBrainDecision(flagDecisionId);
  if (!flag) return;
  const context = (flag.context ?? {}) as Record<string, any>;
  if (context.structure_build_outcome) return;
  const action = (flag.action ?? {}) as Record<string, any>;
  const request = String(action.request ?? flag.rationale ?? "");
  const builtDecisionId = Number(result?.autonomy?.decision?.id);
  const proposalId = Number(result?.proposal?.id);
  if (builtDecisionId > 0) {
    patchBrainDecision(flagDecisionId, {
      status: "superseded",
      superseded_by: builtDecisionId,
      context: {
        ...context,
        review_required: false,
        review_reason_code: null,
        structure_build_outcome: "built",
        structure_build_proposal_id: proposalId > 0 ? proposalId : null,
        structure_build_decision_id: builtDecisionId,
        structure_build_settled_at: new Date().toISOString(),
      },
    });
    return;
  }
  const reason = String(
    result?.error ?? (result?.ok ? "the draft came back without a change to apply" : "the coach was unavailable")
  ).slice(0, 200);
  // A FAILED build is the one state the athlete has to be able to see. It used to stay
  // at `review` with `review_required` unset, which the "Waiting on you" reader skips
  // for a structure request (under lead an in-flight request is the coach's work, not a
  // question) — so the sentence explaining the failure was written into a row nothing
  // rendered, and the ask vanished. Marking it review_required is what gives it a
  // surface again, and the sentence gives it a door: ask again, or use the Plan tab.
  // Only a STANDING flag is surfaced this way; a row already retired is history.
  const standing = String(flag.status) === "review" || String(flag.status) === "observed";
  patchBrainDecision(flagDecisionId, {
    status: String(flag.status) === "observed" ? "review" : flag.status,
    context: {
      ...context,
      ...(standing ? { review_required: true, review_reason_code: "structure_build_failed" } : {}),
      structure_build_outcome: "failed",
      structure_build_proposal_id: proposalId > 0 ? proposalId : null,
      structure_build_error: reason,
      structure_build_settled_at: new Date().toISOString(),
    },
    action: {
      ...action,
      user_explanation: `You asked for a change to how your training is built: “${request}”. The coach could not build it just now (${reason}). Nothing has changed — ask again, or evolve the plan from the Plan tab.`,
    },
  });
}
