import { clinicianNoteText } from "../../brain/autonomy.js";
import { recordDecision } from "../../repo/brain-decisions.js";
import { recordAsyncFailure } from "../../diagnostics.js";

// ---- THE CLINICAL HALF OF A CONFERENCE BUNDLE --------------------------------------
//
// A conference is routed action by action (2026-09-25 ruling): the clinician floor is
// judged on its executable revision alone, and a clinical sentence elsewhere in the
// bundle — a medication, a referral, a clinical test — is filed for the athlete AND THEIR
// DOCTOR as its own `observed` row at the clinician tier: information to take to a visit,
// nothing to approve, nothing held behind it (awaitingBrainDecisions lists it as
// `for_clinician`). The ledger fingerprint covers the notes, so the same sentence from
// next week's conference folds into the existing row instead of stacking a second one.
export function conferenceClinicianNotes(lines: readonly unknown[]): string[] {
  return [
    ...new Set(lines.map((line) => String(line ?? "").trim()).filter((line) => line && clinicianNoteText(line))),
  ].slice(0, 6);
}

export function recordConferenceClinicianNotes(
  notes: readonly string[],
  input: { rationale?: string | null; conference_decision_id?: number | null; snapshot_id?: string | null }
): void {
  if (!notes.length) return;
  try {
    recordDecision({
      effective_date: null,
      kind: "case_conference",
      domain: "health",
      summary: notes[0].slice(0, 300),
      rationale: input.rationale ?? null,
      source: "case_conference",
      source_ref_type: null,
      source_ref_key: null,
      status: "observed",
      autonomy_tier: "clinician",
      risk_class: "clinical",
      reversible: true,
      input_fingerprint: null,
      context: {
        snapshot_id: input.snapshot_id ?? null,
        for_clinician: true,
        deterministic_clinical: true,
        advisory_only: true,
        conference_decision_id: input.conference_decision_id ?? null,
      },
      action: { user_explanation: notes.join(" ").slice(0, 700), clinician_notes: [...notes] },
      specialist: null,
      applied_at: null,
      reverted_at: null,
      superseded_by: null,
      evaluator_version: null,
    });
  } catch (err) {
    // The note is the informational half; losing it must never undo the decision beside it.
    recordAsyncFailure("apply", "conference_clinician_note", err);
  }
}
