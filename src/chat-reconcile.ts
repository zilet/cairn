// Reply reconcilers — the athlete-facing truth about what did and did not happen on a
// chat turn, extracted verbatim from chatTurns.ts. Each one takes the model's prose plus
// the server's own record of what was applied, and returns the reply the athlete actually
// sees: a receipt appended under truthful prose, or an honest correction replacing a
// false claim. The refusal VARIANT sets they rotate through live here too.
//
// chatTurns.ts re-exports every public name below, so existing importers are unchanged.
import * as repo from "./repo.js";
import type { ChatActionType } from "./chatActions.js";
import {
  hasExplicitPlanEditIntent,
  hasExplicitRunEditIntent,
  hasExplicitStrengthObjectiveIntent,
} from "./chat-intent.js";
import { pickDayVariant } from "./repo/brain/day-read-rules.js";
import type { StoredRun } from "./repo/run-edit.js";
import { localDateISO } from "./repo/shared.js";

export function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function describeRun(run: StoredRun | null | undefined): string {
  if (!run) return "that run";
  const trim = (value: number) => String(Math.round(value * 100) / 100);
  const dose =
    run.target_distance_km != null
      ? `${trim(run.target_distance_km)} km`
      : run.target_duration_min != null
        ? `${trim(run.target_duration_min)} min`
        : null;
  return [run.label, dose, run.target_zone].filter(Boolean).join(" · ");
}

function replyClaimsPlanSuccess(reply: string): boolean {
  return /\b(?:i(?:['’]ve| have)?\s+(?:now\s+)?(?:updated|adjusted|saved|applied|pushed|changed|removed|added)|(?:updated|adjusted|saved|applied|pushed|changed)\s+(?:your|today['’]?s|the)\s+(?:live\s+)?(?:plan|program|session|workout)|(?:plan|program|session|workout)\s+is\s+(?:now\s+)?(?:updated|saved|live))\b/i.test(
    reply
  );
}

// ── CHAT_REFUSAL_VARIANTS ────────────────────────────────────────────────────
// The reconcilers below are the athlete-facing truth about what did NOT happen,
// and their inputs are deterministic: the same guard, the same review posture, the
// same off-contract model response produces the same branch. A single literal there
// prints the identical sentence in the chat bubble every time the athlete walks into
// it — the same failure the day read had before its prose became a variant set
// (`src/repo/brain/day-read-rules.ts`). Add a PHRASING to a set here; never add a
// literal at the call site.
//
// Every set carries a stable invariant phrase — "your current plan is unchanged",
// "held for review", "this week's runs are unchanged", "your existing objective is
// unchanged" — because the thing that must survive rotation is the FACT, not the
// wording. Index 0 is the canonical phrasing. Keys are per-site so two sets never
// rotate in lockstep.
export const RESTRUCTURE_HELD_FOR_REVIEW_VARIANTS = [
  "That structural plan change is held for review under the current policy; it is not live yet.",
  "That reshape is held for review, so your week is still exactly as it was.",
  "That structural plan change sits held for review for now; nothing about your week has moved.",
  "A change to the shape of your week is held for review under your current setting, so it isn't live.",
] as const;

export const RESTRUCTURE_NOT_SCHEDULED_VARIANTS: ReadonlyArray<(reason: string) => string> = [
  (reason) => `That structural plan change was not scheduled, so your current plan is unchanged: ${reason}`,
  (reason) => `Nothing went on the calendar from that reshape — your current plan is unchanged: ${reason}`,
  (reason) => `The structural change never got a date, so your current plan is unchanged: ${reason}`,
  (reason) => `That reshape didn't take, and your current plan is unchanged: ${reason}`,
] as const;

export const RESTRUCTURE_DRAFT_VARIANTS = [
  "That structural plan change is a draft for review; it is not live yet.",
  "What came back is a draft for review rather than a live change — your week is untouched.",
  "That reshape landed as a draft for review, so nothing has moved on your plan.",
  "It's a draft for review at this point; the structural change isn't live.",
] as const;

export const PLAN_NOT_SAVED_VARIANTS = [
  "I didn't save a plan change from that response, so your current plan is unchanged.",
  "Nothing from that response reached the plan — your current plan is unchanged.",
  "No plan write came out of that, so your current plan is unchanged.",
  "I stopped short of writing anything there; your current plan is unchanged.",
] as const;

export const PLAN_NO_CHANGE_APPENDED_VARIANTS = [
  "No plan change was saved from this response.",
  "For the record: no plan change was saved from this response.",
  "To be clear, no plan change was saved here.",
  "Nothing landed on the plan — no plan change was saved from this response.",
] as const;

export const PLAN_UNTOUCHED_BY_QUESTION_VARIANTS = [
  "I haven't changed or scheduled your plan from that question; your current training split is unchanged.",
  "That was a question, not a change — your current training split is unchanged.",
  "Nothing was written or put on the calendar from that question; your current training split is unchanged.",
  "I answered rather than acted there, so your current training split is unchanged.",
] as const;

export const PLAN_WRITE_UNVERIFIED_VARIANTS = [
  "The plan write completed, but I couldn't verify the full stored prescription. Reopen Today before training; I won't claim the displayed plan is confirmed.",
  "The write went through, but I couldn't read the whole stored prescription back. Reopen Today before training rather than taking my word for it.",
  "That change was written, though the full stored prescription didn't confirm. Reopen Today before training — I'd rather you see the real thing.",
  "The plan write landed but didn't fully confirm on readback. Reopen Today before training; I won't call the displayed plan confirmed.",
] as const;

export const PLAN_NOT_LIVE_VARIANTS: ReadonlyArray<(reason: string) => string> = [
  (reason) => `That plan change is not live. Your current plan is unchanged: ${reason}`,
  (reason) => `That one didn't land — it is not live, and your current plan is unchanged: ${reason}`,
  (reason) => `To be straight with you: that change is not live, so your current plan is unchanged: ${reason}`,
  (reason) => `Your current plan is unchanged, because that change is not live: ${reason}`,
] as const;

export const RUN_NOT_SAVED_VARIANTS = [
  "I didn't save a run change from that response, so this week's runs are unchanged.",
  "Nothing from that response reached your running — this week's runs are unchanged.",
  "No run write came out of that, so this week's runs are unchanged.",
  "I stopped short of writing a run there; this week's runs are unchanged.",
] as const;

export const RUN_HELD_FOR_REVIEW_VARIANTS = [
  "That run change is held for review under the current policy; it is not live yet.",
  "That run change is held for review, so it isn't live yet.",
  "Your review setting keeps that run change held for review rather than live.",
  "The run edit is held for review for now; nothing has moved on the week.",
] as const;

export const RUN_NOT_LIVE_VARIANTS: ReadonlyArray<(reason: string) => string> = [
  (reason) => `That run change is not live, so this week's runs are unchanged: ${reason}.`,
  (reason) => `That run change didn't land, so this week's runs are unchanged: ${reason}.`,
  (reason) => `This week's runs are unchanged — the run change is not live: ${reason}.`,
  (reason) => `Nothing moved on the running side; this week's runs are unchanged: ${reason}.`,
] as const;

export const STRENGTH_OBJECTIVE_NOT_SAVED_VARIANTS = [
  "I didn't save a strength objective from that response, so your existing objective is unchanged.",
  "No strength objective came out of that response — your existing objective is unchanged.",
  "Nothing was written to your strength goals there, so your existing objective is unchanged.",
  "I stopped short of saving an objective from that; your existing objective is unchanged.",
] as const;

export const STRENGTH_OBJECTIVE_NONE_SAVED_VARIANTS = [
  "No strength objective was saved from this response.",
  "For the record: no strength objective was saved from this response.",
  "To be clear, no strength objective was saved here.",
  "Nothing landed on your strength goals — no strength objective was saved.",
] as const;

export const GOAL_NOT_SAVED_VARIANTS = [
  'I didn\'t actually change your stored goal there — nothing is locked. Say it directly ("set my goal to 165 lb by June 1") or set it in Me → Profile, and it will stick.',
  "That didn't reach your stored goal — it's unchanged. A direct sentence (\"set my goal to 165 lb by June 1\") or Me → Profile will lock it for real.",
  'To be straight with you: the goal on file is unchanged. Tell me plainly — "set my goal to X lb by DATE" — or use Me → Profile, and it will save.',
  "Nothing was written to your goal just now, so the one on file still stands. Say it as a direct instruction or set it in Me → Profile to lock it.",
] as const;

export const GOAL_NONE_SAVED_VARIANTS = [
  "For the record: your stored goal didn't change from this.",
  "To be clear, no goal change was saved here — the one on file stands.",
  "Nothing landed on your stored goal from this exchange.",
  "Your goal on file is unchanged by this.",
] as const;

export const TRAINING_STRUCTURE_NOT_FLAGGED_VARIANTS = [
  "Nothing was actually flagged to the coach lane there, so your plan and its structure are unchanged.",
  "To be straight with you: no request reached the coach lane, and your training structure is unchanged.",
  "I didn't get that hand-off recorded, so nothing is waiting on the coach lane and your plan is unchanged.",
  "No structure request was saved from this — your plan and split stay exactly as they are.",
] as const;

export const TRAINING_STRUCTURE_UNVERIFIED_VARIANTS: ReadonlyArray<(reason: string) => string> = [
  (reason) => `I couldn't verify that hand-off, so I won't claim it's waiting: ${reason}.`,
  (reason) => `That request didn't read back cleanly, so I won't claim the coach lane has it: ${reason}.`,
  (reason) => `I can't confirm that reached the coach lane, so I won't say it did: ${reason}.`,
  (reason) => `That hand-off isn't confirmed on my side, so I won't claim it's queued: ${reason}.`,
] as const;

export const DECISION_REVERT_NOT_AUTHORIZED_VARIANTS: ReadonlyArray<(how: string) => string> = [
  (how) =>
    `I read that as a question rather than a go-ahead, so nothing was reverted. Say “${how}” and I'll roll it back.`,
  (how) =>
    `To be straight with you: nothing was reverted, and that decision is still standing. “${how}” is the word that puts it back.`,
  (how) => `Nothing was reverted here — I wait for the direct ask on an Undo. Say “${how}” and it goes back.`,
  (how) => `That one is still live: nothing was reverted. When you want it undone for real, say “${how}”.`,
] as const;

export const DECISION_REVERT_FAILED_VARIANTS: ReadonlyArray<(reason: string) => string> = [
  (reason) => `The Undo didn't go through, so nothing was reverted: ${reason}.`,
  (reason) => `That rollback didn't land — nothing was reverted: ${reason}.`,
  (reason) => `Nothing was reverted; the Undo couldn't complete: ${reason}.`,
  (reason) => `I couldn't put that one back, so nothing was reverted: ${reason}.`,
] as const;

export const STRENGTH_OBJECTIVE_UNVERIFIED_VARIANTS: ReadonlyArray<(reason: string) => string> = [
  (reason) => `I couldn't verify that strength objective, so I won't claim it was saved: ${reason}.`,
  (reason) => `That strength objective didn't read back cleanly, so I won't claim it was saved: ${reason}.`,
  (reason) =>
    `I couldn't match that strength objective against what's stored, so I won't claim it was saved: ${reason}.`,
  (reason) => `That objective isn't confirmed on my side, so I won't claim it was saved: ${reason}.`,
] as const;

// ── the appended-receipt shape ───────────────────────────────────────────────
// A reconciler that keeps the model's prose puts its receipt UNDER it, and the last
// reconciler in the chain (reconcileChatRevertReply) has to take that reply apart
// again to drop a false sentence without dropping the receipts below it. Join and
// split are therefore one contract: every append goes through `appendReceipt`, every
// split through `splitAppendedReceipts`, and neither may hand-roll the separator.
// When these two drifted apart the split silently stopped matching and a verified
// plan receipt vanished from the bubble for a change that had really landed.
const RECEIPT_JOIN = "\n\n";

function appendReceipt(reply: string, receipt: string): string {
  return `${reply.trim()}${RECEIPT_JOIN}${receipt}`.trim();
}

// The inverse. `null` means this reply was not built by appendReceipt from that head
// — an earlier reconciler replaced the prose outright — and the caller must not treat
// any part of it as a receipt it can keep.
function splitAppendedReceipts(reply: string, head: string): { head: string; receipts: string } | null {
  const prose = head.trim();
  const body = reply.trim();
  if (!prose || !body.startsWith(prose)) return null;
  const rest = body.slice(prose.length);
  if (!rest) return { head: prose, receipts: "" };
  if (!rest.startsWith(RECEIPT_JOIN)) return null;
  return { head: prose, receipts: rest.slice(RECEIPT_JOIN.length).trim() };
}

export function reconcileChatPlanReply(
  reply: string,
  message: string | null | undefined,
  applied: Array<{ type: ChatActionType; result?: unknown; error?: string }>,
  drafts: unknown[]
): string {
  const explicit = hasExplicitPlanEditIntent(message);
  const today = localDateISO();
  const restructureEntries = applied.filter((entry) => entry.type === "plan_restructure");
  const planEntries = applied.filter((entry) => entry.type === "plan_update");
  const restructureDraft = drafts.some((draft: any) => Array.isArray(draft?.parsed?.days));

  if (restructureEntries.length) {
    const result = recordOrNull(restructureEntries[0].result) ?? {};
    const decision = recordOrNull(result.decision);
    const status = String(decision?.status ?? "");
    if (result.scheduled === true || status === "announced" || status === "pending") {
      const boundary = String(result.effective_date ?? decision?.effective_date ?? "the next training boundary");
      const receipt = `Scheduled for ${boundary}; Cairn will adapt the structural plan automatically. Use Discuss with coach on Today to work through it, or say Undo before it lands.`;
      return replyClaimsPlanSuccess(reply) ? receipt : appendReceipt(reply, receipt);
    }
    if (result.review_required === true || status === "review") {
      const receipt = pickDayVariant(RESTRUCTURE_HELD_FOR_REVIEW_VARIANTS, today, "chat-restructure-held");
      return replyClaimsPlanSuccess(reply) ? receipt : appendReceipt(reply, receipt);
    }
    if (result.persisted === true || status === "applied") {
      return "The structural plan change is live and recorded with its Undo history.";
    }
    const reason = String(result.error ?? restructureEntries[0].error ?? "the server could not own the change");
    return pickDayVariant(RESTRUCTURE_NOT_SCHEDULED_VARIANTS, today, "chat-restructure-not-scheduled")(reason);
  }

  if (!planEntries.length) {
    // A run edit IS this turn's plan change; reconcileChatRunReply owns its receipt.
    // Without this the athlete would read "No plan change was saved" directly above
    // the verified run receipt.
    if (applied.some((entry) => entry.type === "set_run")) return reply;
    if (restructureDraft && (explicit || replyClaimsPlanSuccess(reply))) {
      return pickDayVariant(RESTRUCTURE_DRAFT_VARIANTS, today, "chat-restructure-draft");
    }
    if (explicit && replyClaimsPlanSuccess(reply)) {
      return pickDayVariant(PLAN_NOT_SAVED_VARIANTS, today, "chat-plan-not-saved");
    }
    if (explicit) {
      const note = pickDayVariant(PLAN_NO_CHANGE_APPENDED_VARIANTS, today, "chat-plan-no-change-note");
      return appendReceipt(reply, note);
    }
    if (replyClaimsPlanSuccess(reply)) {
      return pickDayVariant(PLAN_UNTOUCHED_BY_QUESTION_VARIANTS, today, "chat-plan-question-no-op");
    }
    return reply;
  }

  const results = planEntries.map((entry) => recordOrNull(entry.result) ?? {});
  const verifiedResults = results.filter((result) => result.ok === true && result.verified === true);
  const verified = results.length > 0 && verifiedResults.length === results.length;
  if (verified) {
    if (!explicit && !replyClaimsPlanSuccess(reply)) return reply;
    const days = [
      ...new Set(
        results.flatMap((result: any) =>
          Array.isArray(result.verification?.days)
            ? result.verification.days.map((day: any) => Number(day?.day_number)).filter(Number.isFinite)
            : []
        )
      ),
    ];
    const receipt = `Saved and verified${days.length ? ` plan day${days.length > 1 ? "s" : ""} ${days.join(", ")}` : " the plan change"}.`;
    const adjustments = results.flatMap((result: any) => (Array.isArray(result.clamped) ? result.clamped : []));
    const clampReceipt = adjustments.length
      ? ` Adjusted ${adjustments
          .slice(0, 3)
          .map(
            (entry: any) =>
              `${String(entry.field).replaceAll("_", " ")} from ${entry.requested} to ${entry.applied == null ? "no prescribed load" : entry.applied}`
          )
          .join("; ")} to supported safe bounds.`
      : "";
    return appendReceipt(reply, `${receipt}${clampReceipt}`);
  }

  // Although the chat contract asks the model for one atomic plan_update, remain
  // truthful when an off-contract response emits several. Each proposal is atomic,
  // but a later one may commit after an earlier one failed. Never collapse that
  // mixed outcome into "your plan is unchanged" (the exact failure that makes the
  // live Today screen and coach prose disagree).
  if (verifiedResults.length) {
    repo.invalidateDayRead();
    const days = [
      ...new Set(
        verifiedResults.flatMap((result: any) =>
          Array.isArray(result.verification?.days)
            ? result.verification.days.map((day: any) => Number(day?.day_number)).filter(Number.isFinite)
            : []
        )
      ),
    ];
    const failed = results.filter((result) => !(result.ok === true && result.verified === true));
    const firstFailed = failed[0] as any;
    const failedEntry = planEntries[results.indexOf(firstFailed)];
    const reason =
      Array.isArray(firstFailed?.reasons) && firstFailed.reasons.length
        ? String(firstFailed.reasons[0])
        : String(firstFailed?.error ?? failedEntry?.error ?? "that part did not verify against the stored plan");
    return `Part of that request is live: saved and verified${days.length ? ` plan day${days.length > 1 ? "s" : ""} ${days.join(", ")}` : " the successful plan change"}. Another requested plan change was not saved: ${reason} The stored plan reflects only the verified change${verifiedResults.length > 1 ? "s" : ""}.`;
  }

  const first = results[0] as any;
  const reason =
    Array.isArray(first?.reasons) && first.reasons.length
      ? String(first.reasons[0])
      : String(first?.error ?? planEntries[0]?.error ?? "the stored plan did not verify the requested final state");
  // Do not retain model prose that claimed a write succeeded. The server receipt is
  // authoritative and is what gets persisted/displayed after the streamed draft.
  if (first?.ok === true && (Array.isArray(first?.applied) || first?.restructured === true)) {
    return pickDayVariant(PLAN_WRITE_UNVERIFIED_VARIANTS, today, "chat-plan-write-unverified");
  }
  if (explicit || replyClaimsPlanSuccess(reply)) {
    return pickDayVariant(PLAN_NOT_LIVE_VARIANTS, today, "chat-plan-not-live")(reason);
  }
  return reply;
}

function replyClaimsRunSuccess(reply: string): boolean {
  if (!/\b(?:runs?|running|mileage|tempo|intervals?)\b/i.test(reply)) return false;
  return /\b(?:i(?:['’]ve| have)?\s+(?:now\s+)?(?:set|saved|updated|changed|adjusted|moved|shortened|lengthened|scheduled|swapped|added)|(?:is|are)\s+(?:now\s+)?(?:set|saved|updated|changed|on\s+the\s+plan|live|scheduled))\b/i.test(
    reply
  );
}

// The run counterpart to reconcileChatPlanReply: whatever the model said it would do,
// the athlete-facing receipt is composed from the stored run READ BACK after the
// apply. A run that did not land — refused as ambiguous, held for review, or verified
// against the store and found missing — says so in plain words.
export function reconcileChatRunReply(
  reply: string,
  message: string | null | undefined,
  applied: Array<{ type: ChatActionType; result?: unknown; error?: string }>
): string {
  const today = localDateISO();
  const entries = applied.filter((entry) => entry.type === "set_run");
  if (!entries.length) {
    if (hasExplicitRunEditIntent(message) && replyClaimsRunSuccess(reply)) {
      return pickDayVariant(RUN_NOT_SAVED_VARIANTS, today, "chat-run-not-saved");
    }
    return reply;
  }
  const results = entries.map((entry) => recordOrNull(entry.result) ?? {});
  const verified = results.filter((result) => result.verified === true);
  const scheduled = results.filter((result) => result.verified !== true && result.scheduled === true);
  const held = results.filter(
    (result) => result.verified !== true && result.scheduled !== true && result.review_required === true
  );
  const failed = results.filter(
    (result) => result.verified !== true && result.scheduled !== true && result.review_required !== true
  );

  const lines: string[] = [];
  if (verified.length) {
    const receipts = verified.map((result: any) => {
      const check = recordOrNull(result.verification) as any;
      return `day ${check?.day_number}: ${describeRun(check?.run)}`;
    });
    lines.push(
      `Saved and verified — ${receipts.join("; ")}. Your lifting on ${verified.length > 1 ? "those days" : "that day"} is untouched.`
    );
  }
  for (const result of scheduled) {
    const decision = recordOrNull((result as any).decision);
    const boundary = String((result as any).effective_date ?? decision?.effective_date ?? "the next training boundary");
    lines.push(
      `That run change is scheduled for ${boundary}; say Undo before it lands if you'd rather keep this week as it is.`
    );
  }
  if (held.length) {
    lines.push(pickDayVariant(RUN_HELD_FOR_REVIEW_VARIANTS, today, "chat-run-held"));
  }
  for (const result of failed) {
    const check = recordOrNull((result as any).verification) as any;
    const mismatches = Array.isArray(check?.mismatches) ? check.mismatches : [];
    const reason = String(
      (result as any).error ??
        (mismatches.length && !mismatches.includes("not_applied")
          ? `the stored run doesn't match what you asked for (${mismatches.join(", ")})`
          : "the run write did not land")
    );
    lines.push(pickDayVariant(RUN_NOT_LIVE_VARIANTS, today, "chat-run-not-live")(reason));
  }
  const receipt = lines.join(" ");
  // Model prose that claimed the write already happened is replaced, not decorated —
  // the server receipt is the only truthful account of what is stored.
  if (!verified.length && replyClaimsRunSuccess(reply)) return receipt;
  return appendReceipt(reply, receipt);
}

export function reconcileStrengthObjectiveReply(
  reply: string,
  message: string | null | undefined,
  applied: Array<{ type: ChatActionType; result?: unknown; error?: string }>
): string {
  if (!hasExplicitStrengthObjectiveIntent(message)) return reply;
  const today = localDateISO();
  const entries = applied.filter((entry) => entry.type === "set_strength_objective");
  if (!entries.length) {
    if (
      /\b(?:i(?:['’]ve| have)?\s+(?:saved|set|updated|created)|(?:strength\s+)?(?:goal|target|objective)\s+is\s+(?:now\s+)?(?:saved|set|active|live))\b/i.test(
        reply
      )
    ) {
      return pickDayVariant(STRENGTH_OBJECTIVE_NOT_SAVED_VARIANTS, today, "chat-objective-not-saved");
    }
    const note = pickDayVariant(STRENGTH_OBJECTIVE_NONE_SAVED_VARIANTS, today, "chat-objective-none-saved");
    return appendReceipt(reply, note);
  }
  const results = entries.map((entry) => recordOrNull(entry.result) ?? {});
  const verified = results.length > 0 && results.every((result) => result.ok === true && result.verified === true);
  if (!verified) {
    const reason = String(entries.find((entry) => entry.error)?.error ?? "the stored objective did not verify");
    return pickDayVariant(STRENGTH_OBJECTIVE_UNVERIFIED_VARIANTS, today, "chat-objective-unverified")(reason);
  }
  const objective = results.at(-1)?.objective as any;
  const exercise = String(objective?.exercise ?? "the anchor lift");
  const target = Number(objective?.target_est_1rm);
  const receipt = Number.isFinite(target)
    ? `Strength objective saved and verified: ${exercise} to ${target} lb estimated 1RM.`
    : `Strength objective saved and verified: ${exercise}.`;
  return appendReceipt(reply, receipt);
}

// Prose claiming the structure request was handed off. Subject-anchored the same way
// replyClaimsRunSuccess is: an honest sentence ("I can't change your split from here")
// shares vocabulary with the false claim, so only the hand-off ASSERTION counts.
function replyClaimsStructureFlagged(reply: string): boolean {
  return /\b(?:i(?:['’]ve| have| will|['’]ll)?\s+(?:now\s+)?(?:flagged|flag|pass(?:ed)?|sen[dt]|rout(?:ed|e)|hand(?:ed)?\s+(?:it|that|this)\s+(?:off|over))\b[\s\S]{0,60}\b(?:coach|coaching)\s+lane\b|\b(?:coach|coaching)\s+lane\b[\s\S]{0,40}\b(?:has|got|will get|picks? (?:it|that) up)\b)/i.test(
    reply
  );
}

// Prose asserting a goal is locked/saved. Subject-anchored like replyClaimsRunSuccess:
// the honest corrections above share vocabulary ("goal", "unchanged", "will save"), so
// only the positive ASSERTION counts — "locking in", "your goal is now set".
function replyClaimsGoalSaved(reply: string): boolean {
  return /\block(?:ing|ed)?\s+(?:it\s+|that\s+)?in\b|\bgoal\b.{0,30}\b(?:is\s+)?(?:now\s+)?(?:set|saved|updated|locked|active|live)\b|\b(?:i(?:['’]ve| have)?\s+)?(?:set|saved|updated|locked)\b.{0,25}\bgoal\b/i.test(
    reply
  );
}

// The goal-identity counterpart to reconcileStrengthObjectiveReply. The failure this
// closes is real and quiet: the athlete negotiates a goal over several messages, the
// per-message gate strips the fields, and the model's prose says "locking it in" over
// a write that never happened — the athlete walks away believing a goal the brain
// cannot see. When goal fields APPLIED, a receipt states exactly what was saved; when
// they were DROPPED, a lock-claiming reply is replaced with the honest correction and
// any other reply gets a quiet for-the-record line.
export function reconcileGoalIdentityReply(
  reply: string,
  droppedGoalFields: readonly string[],
  appliedGoalPatch: Record<string, unknown> | null
): string {
  const today = localDateISO();
  if (appliedGoalPatch && Object.keys(appliedGoalPatch).length) {
    const weight = Number(appliedGoalPatch.goal_weight_lb);
    const date = String(appliedGoalPatch.goal_date ?? "").trim();
    const mode = String(appliedGoalPatch.goal_mode ?? "").trim();
    const parts = [
      Number.isFinite(weight) ? `${weight} lb` : null,
      date ? `by ${date}` : null,
      mode ? `(${mode})` : null,
    ].filter(Boolean);
    const receipt = parts.length ? `Goal saved: ${parts.join(" ")}.` : "Goal saved.";
    return appendReceipt(reply, receipt);
  }
  if (!droppedGoalFields.length) return reply;
  if (replyClaimsGoalSaved(reply)) return pickDayVariant(GOAL_NOT_SAVED_VARIANTS, today, "chat-goal-not-saved");
  return appendReceipt(reply, pickDayVariant(GOAL_NONE_SAVED_VARIANTS, today, "chat-goal-none-saved"));
}

// The counterpart to reconcileStrengthObjectiveReply for the structure hand-off. Chat
// promising to "flag it to your coach lane" and writing nothing is exactly the failure
// flag_training_structure exists to close, so the reply may only make that claim when
// the hand-off genuinely happened — and when it did, the receipt says what the SERVER
// will do with it, not what the model guessed: under lead / announce_first the coach is
// building the change and it lands at the named boundary with an Undo; under
// review_everything it will wait to be confirmed. Either way nothing has changed yet.
function structureHandOffReceipt(result: Record<string, unknown>): string {
  const posture = String(result.posture ?? "");
  const built = result.built_decision as Record<string, unknown> | null | undefined;
  if (posture === "lands") {
    const landsOn = String(built?.effective_date ?? result.lands_on ?? "").trim();
    const when = landsOn ? ` on ${landsOn}` : " at the next natural boundary";
    return built
      ? `Already in hand — your coach built that change and it lands${when} with a one-tap Undo. Nothing in your plan has changed yet.`
      : `Handed to your coach — it's rebuilding your week around this now, and the change lands${when} with a one-tap Undo. Nothing in your plan has changed yet.`;
  }
  if (posture === "asks") {
    return built
      ? "Already in hand — your coach drafted that change and it's waiting for you to confirm. Nothing in your plan has changed yet."
      : "Handed to your coach — it's drafting the change now, and because you review everything it will wait for you to confirm. Nothing in your plan has changed yet.";
  }
  return "Flagged to your coach lane — it's waiting for you to confirm, and nothing in your plan has changed yet.";
}

export function reconcileTrainingStructureReply(
  reply: string,
  applied: Array<{ type: ChatActionType; result?: unknown; error?: string }>
): string {
  const today = localDateISO();
  const entries = applied.filter((entry) => entry.type === "flag_training_structure");
  if (!entries.length) {
    if (replyClaimsStructureFlagged(reply)) {
      return pickDayVariant(TRAINING_STRUCTURE_NOT_FLAGGED_VARIANTS, today, "chat-structure-not-flagged");
    }
    return reply;
  }
  const results = entries.map((entry) => recordOrNull(entry.result) ?? {});
  const verified = results.length > 0 && results.every((result) => result.ok === true && result.verified === true);
  if (!verified) {
    const reason = String(entries.find((entry) => entry.error)?.error ?? "the request did not read back");
    return pickDayVariant(TRAINING_STRUCTURE_UNVERIFIED_VARIANTS, today, "chat-structure-unverified")(reason);
  }
  return appendReceipt(reply, structureHandOffReceipt(results.at(-1) ?? {}));
}

// Prose claiming the Undo already happened. Subject-anchored on purpose, exactly as
// replyClaimsRunSuccess is topic-anchored: an honest sentence ("nothing was reverted",
// "I couldn't put that back") shares every verb with the false claim and differs only
// in who is doing what, so a bare verb match would correct the truthful reply too.
function replyClaimsRevertSuccess(reply: string): boolean {
  return /\b(?:i(?:['’]ve| have)?\s+(?:now\s+|already\s+)?(?:reverted|undone|undid|restored|cancell?ed|rolled\s+(?:it|that|this|them|the\s+\S+|your\s+\S+)\s+back|put\s+(?:it|that|this|them|the\s+\S+|your\s+\S+)\s+back)|(?:it|that|this|the\s+(?:change|decision|update|plan|split|program)|your\s+(?:plan|split|program))(?:['’]s)?\s+(?:has\s+been|have\s+been|been|is|was|are|were)\s+(?:now\s+)?(?:reverted|rolled\s+back|undone|cancell?ed|put\s+back|restored))\b/i.test(
    reply
  );
}

// The Undo counterpart to reconcileChatPlanReply / reconcileChatRunReply. A
// revert_decision the athlete never authorized (the shared question guard) leaves no
// trace in `applied` — a refused action is not an applied one, and `applied` is the
// chat bubble's own receipt ledger — so the refused decision ids ride their own
// channel out of applyChatActions. Either way the decision is still live, so the false
// sentence never survives — the same rule reconcileChatRunReply applies to a run write
// that did not land, for the same reason: leaving it at the top of the bubble makes
// the server's account argue with itself. A reply that never claimed the Undo happened
// is returned untouched.
//
// This reconciler runs LAST, so what it reads is rarely what the model wrote: one
// bubble can claim both a plan/run change and an Undo, and the earlier reconcilers
// either REPLACE the whole prose (their write did not land) or APPEND a receipt under
// it (their write did). Both shapes used to lose something.
//
//   - Replaced: the revert claim went with the discarded prose, and a claim-only guard
//     reading the rewritten text then said nothing about a decision the athlete asked
//     to undo and that is still live. So the claim is judged against the ORIGINAL model
//     reply, and the correction is APPENDED under the receipt — that receipt is
//     truthful and must not be thrown away.
//   - Appended: the reply is the model's prose followed by receipts, so replacing the
//     whole thing deleted a verified plan/objective receipt along with the false
//     sentence — the athlete's bench really did change and the bubble no longer said
//     so. Every append goes through `appendReceipt`, so `splitAppendedReceipts` can
//     take the same reply apart on the same shape: the correction takes the top and
//     the receipts keep their place below it.
//
// Both arms therefore keep every truthful receipt and drop only the false claim.
export function reconcileChatRevertReply(
  reply: string,
  applied: Array<{ type: ChatActionType; result?: unknown; error?: string }>,
  refusedReverts: readonly number[],
  proposedReply: string
): string {
  const today = localDateISO();
  const failed = applied.filter(
    (entry) => entry.type === "revert_decision" && (recordOrNull(entry.result)?.ok !== true || !!entry.error)
  );
  // Nothing to correct: a true claim about a revert that really applied passes through.
  if (!failed.length && !refusedReverts.length) return reply;
  const claimsNow = replyClaimsRevertSuccess(reply);
  // Judged on the model's own words, not on the data alone: a reply that never claimed
  // the Undo happened stays untouched, deliberately.
  if (!claimsNow && !replyClaimsRevertSuccess(proposedReply)) return reply;
  let correction: string;
  if (failed.length) {
    const reason = String(
      recordOrNull(failed[0].result)?.error ?? failed[0].error ?? "the decision could not be rolled back"
    );
    correction = pickDayVariant(DECISION_REVERT_FAILED_VARIANTS, today, "chat-revert-failed")(reason);
  } else {
    const id = refusedReverts.find((value) => Number.isInteger(value) && value > 0);
    const how = id ? `undo decision ${id}` : "undo that decision";
    correction = pickDayVariant(DECISION_REVERT_NOT_AUTHORIZED_VARIANTS, today, "chat-revert-not-authorized")(how);
  }
  if (!claimsNow) return appendReceipt(reply, correction);
  return withoutLeadingProse(reply, proposedReply, correction);
}

// The claim is still standing, so the model's prose is still the head of the reply and
// anything appendReceipt put after it is a receipt to keep. Swap the head for the
// correction and re-append the rest. No receipts — or a reply this head did not build
// (no receipt variant reads as a revert claim, so a standing claim means the prose
// survived and that cannot happen today) — collapses to a plain replace.
function withoutLeadingProse(reply: string, proposedReply: string, correction: string): string {
  const split = splitAppendedReceipts(reply, proposedReply);
  if (!split?.receipts) return correction;
  return appendReceipt(correction, split.receipts);
}
