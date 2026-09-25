import { clinicianFloorHolds, decideAutonomyTier, leadModelCeiling, type CairnLeadMode } from "../../brain/autonomy.js";
import type { AutonomyTier, BrainDecision, BrainRiskClass } from "../../brain/decision-contract.js";
import { patchBrainDecision } from "../../repo/brain-decisions.js";
import { getCoachContext } from "../../repo/coach.js";
import { listTrainingSymptoms } from "../../repo/training-symptoms.js";
import { localDateISO } from "../../repo/shared.js";
import {
  conferenceConflictInputs,
  revisionFromProposalPayload,
  revisionHoldsClinicalFloor,
  type ConferenceConflictInputs,
} from "./conference-conflicts.js";
import { conferenceClinicianNotes, recordConferenceClinicianNotes } from "./conference-clinician-notes.js";
import { serverClinicalProvenance } from "./clinical-provenance.js";

// ---- WHAT THE THAW RE-READS ON A PARKED ROW BY TODAY'S RULE ------------------------
//
// The thaw (thawParkedReviewDecisions, autonomy-service.ts) walks decisions parked at
// `review` and re-offers them through today's policy. These are the reads it makes
// before a re-offer: the tier a hold was first asked at, a conference-marked clinician
// floor judged again on its revision, and a parked conference reading re-filed as the
// observation it is. The thaw itself owns the loop, the stamps and every re-offer.

// A conductor's bare `clinical` risk with nothing the server finds clinical reads as
// moderate on a re-read — the clinician floor is clinicianFloorHolds' alone.
export function nonClinicalRisk(risk: BrainRiskClass): BrainRiskClass {
  return risk === "clinical" ? "moderate" : risk;
}

// The requested tier a held draft was routed with, as the re-offer should carry it. A
// requested `clinician` is an opinion, never the floor (that is clinicianFloorHolds',
// already checked before any re-offer), so it reads as an ask; under lead an ask is a
// heads-up (leadModelCeiling). Nothing recorded — or an unknown value — carries nothing.
export function thawRequestedTier(context: Record<string, any>, leadMode: CairnLeadMode): AutonomyTier | undefined {
  const requested = String(context.policy_inputs?.requested_tier ?? "");
  if (!["quiet_apply", "announce", "ask", "clinician"].includes(requested)) return undefined;
  return leadModelCeiling((requested === "clinician" ? "ask" : requested) as AutonomyTier, leadMode);
}

// The one-off re-read of a conference-marked clinician floor (see the thaw). Versioned so
// a later rule change can re-read again without a migration.
export const CONFERENCE_FLOOR_REREAD_VERSION = 1;

export function conferenceFloorNeedsReread(
  decision: BrainDecision,
  context: Record<string, any>,
  proposal: any
): boolean {
  if (String(decision.source ?? "") !== "case_conference") return false;
  if (context.user_locked === true) return false;
  if (Number(context.floor_reread?.version) >= CONFERENCE_FLOOR_REREAD_VERSION) return false;
  // A clinical mark the CHAT detector put on the athlete's own words is not the
  // conference's to re-read.
  if (serverClinicalProvenance(proposal?.parsed?.clinical_provenance) !== null) return false;
  return clinicianFloorHolds(decision);
}

function defaultConflictInputsToday(): ConferenceConflictInputs {
  const on = localDateISO();
  let symptomAreas: string[] | null = null;
  try {
    symptomAreas = listTrainingSymptoms({ on, include_resolved: false, seed_legacy: false })
      .filter((event) => event.status === "active" && event.scope !== "systemic" && !event.legacy_unconfirmed)
      .map((event) => event.area_text);
  } catch {
    symptomAreas = null;
  }
  return conferenceConflictInputs(getCoachContext(), { activeSymptomAreas: symptomAreas });
}

/** Today's conflict question sheet, built lazily and at most once a sweep (only a
 * conference-marked floor row ever needs it); null when it cannot be built. */
export function lazyConflictInputs(
  build: () => ConferenceConflictInputs | null = defaultConflictInputsToday
): () => ConferenceConflictInputs | null {
  let inputs: ConferenceConflictInputs | null | undefined;
  return () => {
    if (inputs === undefined) {
      try {
        inputs = build();
      } catch {
        inputs = null;
      }
    }
    return inputs;
  };
}

/**
 * A CONFERENCE-MARKED FLOOR IS RE-READ BY TODAY'S RULE, once (conferenceFloorNeedsReread
 * decides which). The held revision is judged again by revisionHoldsClinicalFloor against
 * today's findings. Still clinical: the row is stamped and stays. Not clinical: the older
 * rule's marks are lifted and the decision to re-offer is returned. Null means skip it —
 * the floor holds, or there is nothing to judge it with today.
 */
export function rereadConferenceFloor(
  decision: BrainDecision,
  context: Record<string, any>,
  proposal: any,
  conflictInputsToday: () => ConferenceConflictInputs | null
): BrainDecision | null {
  const revision = revisionFromProposalPayload(proposal?.parsed);
  const inputs = revision ? conflictInputsToday() : null;
  if (!inputs || !revision) return null;
  const reread = { version: CONFERENCE_FLOOR_REREAD_VERSION, at: new Date().toISOString() };
  if (revisionHoldsClinicalFloor(inputs, revision)) {
    patchBrainDecision(decision.id!, { context: { ...context, floor_reread: { ...reread, clinical: true } } });
    return null;
  }
  return (
    patchBrainDecision(decision.id!, {
      autonomy_tier: "ask",
      risk_class: "moderate",
      context: {
        ...context,
        clinical: false,
        deterministic_clinical: false,
        policy_inputs: { ...((context.policy_inputs ?? {}) as Record<string, any>), clinical: false },
        review_reason_code: "floor_reread",
        // A stamp an older pass carried onto this row must not stop the one
        // re-offer the lifted floor is owed.
        thaw_attempted: false,
        floor_reread: { ...reread, clinical: false, lifted_reason_code: context.review_reason_code ?? null },
      },
    }) ?? decision
  );
}

// A parked conference reading with no live change behind it, re-filed as what it is: an
// observation. Its clinical sentences (if any) become the athlete-and-doctor note; the
// rest is the ordinary reading. Returns false only when the write failed.
export function refileParkedConferenceAdvice(
  decision: BrainDecision,
  context: Record<string, any>,
  leadMode: CairnLeadMode
): boolean {
  const action = (decision.action ?? {}) as Record<string, any>;
  const notes = conferenceClinicianNotes([
    decision.summary,
    ...(Array.isArray(action.parallel_actions) ? action.parallel_actions : []),
  ]);
  const riskClass = nonClinicalRisk(decision.risk_class);
  const policy = decideAutonomyTier({
    kind: decision.kind,
    risk_class: riskClass,
    reversible: true,
    lead_mode: leadMode,
  });
  const refiled = patchBrainDecision(decision.id!, {
    status: "observed",
    autonomy_tier: leadModelCeiling(policy.tier, leadMode),
    risk_class: riskClass,
    context: {
      ...context,
      review_required: false,
      thaw_outcome: "observed",
      thaw_reasons: ["advice changes nothing, so it never waits on the athlete"],
      deterministic_clinical: false,
      floor_reread: {
        version: CONFERENCE_FLOOR_REREAD_VERSION,
        at: new Date().toISOString(),
        clinical: false,
        advisory: true,
        was_tier: decision.autonomy_tier ?? null,
        was_deterministic_clinical: context.deterministic_clinical ?? null,
      },
    },
  });
  if (!refiled) return false;
  recordConferenceClinicianNotes(notes, {
    rationale: decision.rationale ?? null,
    conference_decision_id: decision.id ?? null,
  });
  return true;
}
