/**
 * The coach's push offer — filing it, accepting it, and "not now". The evaluator and the
 * ledger read live in src/repo/push-offer.ts; this is the write side.
 *
 * An offer is an ASK the coach files on its own initiative, so it never applies anything:
 * it is a `training_structure` decision at autonomy tier `ask`, status `observed` (a
 * question waiting in the read, never a parked change the thaw could re-offer or land),
 * `context.push_offer = true`, carrying its evidence in plain words and FALSIFIABLE
 * expectations — the claim "you are carrying this" is a claim that the carried lifts keep
 * stepping up, so it is written as the lift-progression expectations on those lifts.
 *
 *   • accept → setTrainingDrive({drive:"push", until: two weeks}) — the SAME door as the
 *     athlete saying it, with the same Undo; the stance decision supersedes the offer.
 *   • dismiss → the offer is `rejected` with `dismissed_on`, remembered for
 *     OFFER_DISMISS_COOLDOWN_DAYS; its expectations stay live (the claim about the lifts
 *     is still checkable whether or not the athlete took it up).
 *   • unanswered → it stops showing after OFFER_TTL_DAYS, and the nightly pass retires it
 *     (`canceled`, `lapsed`) before it would ever file a new one.
 */
import type { ClientPushOfferAnswerResponse } from "../../contracts/training-drive.js";
import {
  getBrainDecision,
  patchBrainDecision,
  recordDecision,
  transitionBrainDecision,
} from "../../repo/brain-decisions.js";
import { buildLiftProgressionExpectations, liftProgressionSubjects } from "../../repo/brain/change-expectations.js";
import {
  OFFER_STANCE_DAYS,
  OFFER_TTL_DAYS,
  isPushOfferDecision,
  openPushOfferDecision,
  pushOfferRead,
  pushOfferView,
} from "../../repo/push-offer.js";
import { listBrainDecisions } from "../../repo/brain-decisions.js";
import { addDaysISO, daysBetweenISO, localDateISO } from "../../repo/shared.js";
import { trainingDriveRead } from "../../repo/training-drive-read.js";
import type { PushStanceVia } from "../../repo/training-drive.js";
import { setTrainingDrive } from "./training-drive.js";

export interface PushOfferFiling {
  filed: boolean;
  decision_id: number | null;
  reason: string;
  lapsed: number;
}

function stampDay(value: unknown): string | null {
  const text = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

/** Retire unanswered offers past their TTL. Returns how many were retired. */
export function lapseStalePushOffers(today: string = localDateISO()): number {
  let lapsed = 0;
  for (const decision of listBrainDecisions({ status: "observed", kind: "training_structure", limit: 50 })) {
    if (!isPushOfferDecision(decision) || !decision.id) continue;
    const offered = String(decision.effective_date ?? "") || stampDay(decision.created_at);
    const age = offered ? daysBetweenISO(today, offered) : null;
    if (age == null || age <= OFFER_TTL_DAYS) continue;
    try {
      transitionBrainDecision(decision.id, "canceled", { keepExpectations: true });
      patchBrainDecision(decision.id, {
        context: { ...((decision.context as Record<string, unknown>) ?? {}), lapsed: true, lapsed_on: today },
      });
      lapsed += 1;
    } catch {
      /* bookkeeping; the read already hides it past its TTL */
    }
  }
  return lapsed;
}

/**
 * The nightly evaluator's write: file ONE offer when the log has earned it and none is
 * open. Idempotent per day and per open offer. Never touches the drive.
 */
export function offerPushStanceIfEarned(
  today: string = localDateISO(),
  // Test seam: the verdict (the scheduler always reads the live log).
  opts: { read?: (date: string) => ReturnType<typeof pushOfferRead> } = {}
): PushOfferFiling {
  const lapsed = lapseStalePushOffers(today);
  if (openPushOfferDecision(today)) return { filed: false, decision_id: null, reason: "open_offer", lapsed };
  const verdict = (opts.read ?? pushOfferRead)(today);
  if (!verdict.eligible)
    return { filed: false, decision_id: null, reason: verdict.blockers[0] ?? "not_earned", lapsed };
  const lifts = verdict.facts.lifts_carried;
  let expectations: ReturnType<typeof buildLiftProgressionExpectations> = [];
  try {
    expectations = buildLiftProgressionExpectations(liftProgressionSubjects(lifts, today, 3), today);
  } catch {
    expectations = [];
  }
  const { decision } = recordDecision(
    {
      effective_date: today,
      kind: "training_structure",
      domain: "training",
      summary: "You're carrying the program with room to spare — the coach asked whether to open the throttle.",
      rationale:
        "An ask, not a change: the log says the dose is under what you can take. Nothing moves unless you say yes.",
      source: "push_offer",
      source_ref_type: null,
      source_ref_key: null,
      status: "observed",
      autonomy_tier: "ask",
      risk_class: "low",
      reversible: true,
      input_fingerprint: null,
      context: {
        push_offer: true,
        evidence: verdict.evidence,
        lifts_carried: lifts,
        facts: {
          sessions: verdict.facts.sessions,
          strong_sessions: verdict.facts.strong_sessions,
          rir_reserve_sets: verdict.facts.rir_reserve_sets,
          recovery_supportive: verdict.facts.recovery_supportive,
        },
      },
      action: {
        kind: "push_offer",
        offer_days: OFFER_STANCE_DAYS,
        offered_on: today,
      },
      specialist: null,
      applied_at: null,
      reverted_at: null,
      superseded_by: null,
      evaluator_version: null,
    },
    expectations
  );
  return { filed: !!decision.id, decision_id: decision.id ?? null, reason: "filed", lapsed };
}

function openOfferOrError(today: string, decisionId?: unknown) {
  const open = openPushOfferDecision(today);
  if (!open?.id) return { error: "There's no open offer to answer." } as const;
  const wanted = Number(decisionId);
  if (decisionId != null && decisionId !== "" && Number.isFinite(wanted) && wanted !== open.id)
    return { error: "That offer has already been answered or replaced." } as const;
  return { open } as const;
}

/** "Push me for two weeks": the same door as saying it. */
export function acceptPushOffer(
  input: { decision_id?: unknown; via?: PushStanceVia; words?: unknown; today?: string } = {}
): ClientPushOfferAnswerResponse {
  const today = String(input.today || localDateISO()).slice(0, 10);
  const found = openOfferOrError(today, input.decision_id);
  if ("error" in found) return { ok: false, error: found.error };
  const words =
    typeof input.words === "string" && input.words.trim()
      ? input.words.trim().slice(0, 240)
      : "Yes — open the throttle for two weeks (the coach's offer).";
  const result = setTrainingDrive({
    drive: "push",
    until: addDaysISO(today, OFFER_STANCE_DAYS - 1) ?? today,
    words,
    via: input.via ?? "athlete",
    today,
  });
  if (!result.ok) return { ok: false, error: result.error ?? "The push could not be set." };
  // setTrainingDrive closes the open offer itself (closeOpenPushOffer) — re-read to report.
  return { ok: true, decision_id: result.decision_id ?? null, read: result.read ?? trainingDriveRead(today) };
}

/** "Not now": remembered, so the coach does not ask again for four weeks. */
export function dismissPushOffer(input: { decision_id?: unknown; today?: string } = {}): ClientPushOfferAnswerResponse {
  const today = String(input.today || localDateISO()).slice(0, 10);
  const found = openOfferOrError(today, input.decision_id);
  if ("error" in found) return { ok: false, error: found.error };
  const id = found.open.id as number;
  // The claim about the lifts stays checkable: keep the expectations.
  transitionBrainDecision(id, "rejected", { keepExpectations: true });
  const current = getBrainDecision(id);
  patchBrainDecision(id, {
    context: { ...((current?.context as Record<string, unknown>) ?? {}), dismissed_on: today, held_by_user: true },
  });
  return { ok: true, decision_id: id, read: trainingDriveRead(today) };
}

export { pushOfferView };
