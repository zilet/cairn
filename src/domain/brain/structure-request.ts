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
import { getBrainDecision, patchBrainDecision } from "../../repo/brain-decisions.js";
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
  patchBrainDecision(flagDecisionId, {
    context: {
      ...context,
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
