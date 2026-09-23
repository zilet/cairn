import { pickDayVariant } from "../../repo/brain/day-read-rules.js";
import { regenerationReceiptForDraft } from "../../repo/brain-decisions.js";
import { buildProgressionProposal, buildVolumeRestoreProposal } from "../../repo/progression.js";
import { createProposal } from "../../repo/proposals.js";
import { VOLUME_RESTORE_AGENT, type VolumeCutCause } from "../../repo/volume-guard.js";

// REGENERATE, DON'T ASK.
//
// A draft whose evidence snapshot no longer matches the current picture — or one that
// simply sat past its freshness horizon — used to be parked as an ask describing which
// components moved. Nobody but the producer can act on that: the athlete is being handed
// an evidence diff they never saw and asked to adjudicate arithmetic the system did. In
// production 43 of 54 such asks expired unanswered.
//
// So a stale draft from a producer that can be re-run MECHANICALLY is re-run instead of
// asked about. This module owns exactly one question — "who wrote this draft, and can
// that producer be invoked again from what the row still carries?" — and nothing about
// autonomy tiers, ledger rows or receipts, which stay in autonomy-service where the rest
// of the policy lives.
//
// Only DETERMINISTIC, offline producers qualify. An agent-authored draft (chat, the
// nutrition check-in, a case conference) cannot be re-run from a stored row without
// spawning a CLI subprocess mid-tick and inventing the inputs it was given, so those
// producers keep their existing holds.

export interface RegenerableProducer {
  // Stable identity of the producing operation, for the receipt's provenance.
  key: string;
  rerun: () => { ok: false; error: string } | { ok: true; proposal: any };
  // True when the "re-run" re-stamps the same changes against current evidence rather
  // than reading the question again (see rebaseProducer) — the receipt says which.
  rebase?: boolean;
}

// Only these components may have moved for a rebase. `plan` drift is the real premise
// change (the rows this draft edits are not the rows it was written against), and a
// nutrition fingerprint belongs to another kind of draft entirely.
const REBASE_TOLERATED_DRIFT = new Set(["training", "context"]);

// THE DAILY TRAINER'S DRAFT. Anyone who logs every day moves the `training` component
// every day, so an agent-authored target tweak drafted on Sunday was stale by Monday's
// thaw and set aside — three weekly evolutions died that way. An agent draft cannot be
// re-asked without a CLI spawn, but a NON-STRUCTURAL one (bounded `changes[]`, no
// `days`) against a plan that has not moved still edits exactly the rows it was written
// for. So it is re-stamped against the current evidence, once, and earns its tier fresh
// through the whole autonomy pipeline, every floor included.
function rebaseProducer(proposal: any, freshness: { status?: string; changed_components?: string[] } | null) {
  const parsed = proposal?.parsed;
  if (!parsed || !Array.isArray(parsed.changes) || Array.isArray(parsed.days) || parsed.kind === "nutrition_target")
    return null;
  const changed = freshness?.status === "changed" ? (freshness.changed_components ?? []) : [];
  if (!changed.length || !changed.every((component) => REBASE_TOLERATED_DRIFT.has(component))) return null;
  return {
    key: `rebase:${String(proposal.agent ?? "agent")}`,
    rebase: true,
    rerun: () => ({
      ok: true as const,
      proposal: createProposal(
        String(proposal.agent ?? ""),
        String(proposal.instruction ?? ""),
        String(proposal.raw_output ?? ""),
        restampablePayload(parsed)
      ),
    }),
  };
}

// The stored payload minus what was stamped against the OLD evidence: the snapshot
// itself, its date, and each reason's pointer to it. The reasons and their evidence
// dates stay — the new stamp re-points them at today's snapshot.
function restampablePayload(parsed: any): any {
  const payload = JSON.parse(JSON.stringify(parsed));
  delete payload.proposal_truth;
  delete payload.as_of_date;
  const owners = [payload, ...(Array.isArray(payload.changes) ? payload.changes : []), ...(Array.isArray(payload.cardio) ? payload.cardio : [])];
  for (const owner of owners) {
    for (const field of ["reason_provenance", "rationale_provenance"]) {
      const provenance = owner?.[field];
      if (provenance && typeof provenance === "object") {
        delete provenance.as_of_date;
        delete provenance.source_ref_key;
      }
    }
  }
  return payload;
}

function progressionDay(proposal: any): number {
  // The instruction is the producer's own stable contract text ("day 3 progression");
  // the payload's day_number is the same fact written by the same builder. Either
  // answers "which day was this for", and a draft that answers neither is not
  // mechanically re-runnable.
  const fromInstruction = /^day\s+(\d+)\s+progression$/i.exec(String(proposal?.instruction ?? "").trim());
  if (fromInstruction) return Number(fromInstruction[1]);
  const changes = Array.isArray(proposal?.parsed?.changes) ? proposal.parsed.changes : [];
  const day = Number(changes[0]?.day_number);
  return Number.isFinite(day) ? day : Number.NaN;
}

function volumeRestoreCause(proposal: any): VolumeCutCause | null {
  const entries = Array.isArray(proposal?.parsed?.volume_restore) ? proposal.parsed.volume_restore : [];
  const cause = String(entries[0]?.cause ?? "");
  return cause === "fuel" || cause === "policy" ? cause : null;
}

// The producing op behind a draft, when the row still carries everything the op needs.
// Null means "leave this one's holds alone" — never a fabricated input.
export function regenerableProducer(
  proposal: any,
  freshness: { status?: string; changed_components?: string[] } | null = null
): RegenerableProducer | null {
  const agent = String(proposal?.agent ?? "");
  if (agent === "auto-progression") {
    const day = progressionDay(proposal);
    if (!Number.isFinite(day)) return null;
    // Deliberately WITHOUT `forNextSession`: that option reads the progression against
    // the session that had just finished when the original draft was written, and the
    // whole point of regenerating is to read against the picture as it stands now.
    return { key: `auto-progression:day:${day}`, rerun: () => buildProgressionProposal(day) };
  }
  // An "auto-run-plan" draft has no producer any more: runs are never plan items
  // (migration 110 supersedes any such draft), so there is nothing to re-run.
  if (agent === VOLUME_RESTORE_AGENT) {
    const cause = volumeRestoreCause(proposal);
    return {
      key: `volume-restore:${cause ?? "any"}`,
      rerun: () => buildVolumeRestoreProposal(cause ? { cause } : {}),
    };
  }
  return rebaseProducer(proposal, freshness);
}

// ONE regeneration per draft. The replacement carries its lineage in the receipt that
// retired the draft it replaced, so a replacement that is ITSELF stale is held the old
// way rather than regenerated again — churning evidence can never loop.
export function draftIsRegenerationProduct(proposalId: number): boolean {
  return regenerationReceiptForDraft(proposalId) != null;
}

// Athlete-facing. A receipt is read once, but it is still a person reading it, so the
// sentence rotates rather than printing one literal for every draft this ever touches.
export function regenerationReceiptRationale(changedComponents: string[], aged: boolean, date: string): string {
  const changed = changedComponents.join(" and ");
  const moved = aged
    ? [
        "This had been waiting long enough that it no longer described where you are",
        "This sat unanswered past the point where it still matched your week",
        "Time had moved on from what this was written against",
      ]
    : [
        `Your ${changed || "training"} picture moved after this was drafted`,
        `What this was written against — your ${changed || "training"} picture — has since changed`,
        `The ${changed || "training"} picture behind this is not the one you are in now`,
      ];
  const replaced = [
    "so it was rewritten from where you are now instead of being handed to you to judge.",
    "so a fresh read replaced it rather than asking you to compare the two.",
    "so it was drafted again against today's picture instead of becoming a question.",
  ];
  return `${pickDayVariant(moved, date, "regen-why")}, ${pickDayVariant(replaced, date, "regen-what")}`;
}

// The same sentence for the case where the fresh read had nothing left to propose:
// the draft is set aside, nothing changes, and nothing is asked.
export function regenerationEmptyRationale(changedComponents: string[], aged: boolean, date: string): string {
  const changed = changedComponents.join(" and ");
  const moved = aged
    ? [
        "This had been waiting long enough that it no longer described where you are",
        "This sat unanswered past the point where it still matched your week",
      ]
    : [
        `Your ${changed || "training"} picture moved after this was drafted`,
        `The ${changed || "training"} picture behind this is not the one you are in now`,
      ];
  const nothing = [
    "and reading it again from where you are now turns up nothing to change, so nothing did.",
    "and a fresh read of the same question came back with no change worth making.",
  ];
  return `${pickDayVariant(moved, date, "regen-empty-why")}, ${pickDayVariant(nothing, date, "regen-empty-what")}`;
}

// The rebase receipt: the same changes, re-checked — not a fresh read, so it never says one.
export function regenerationRebaseRationale(changedComponents: string[], date: string): string {
  const changed = changedComponents.join(" and ");
  const moved = [
    `Your ${changed || "training"} picture moved after this was drafted, but the plan it changes has not`,
    `New ${changed || "training"} came in after this was drafted; the plan days it edits are the same`,
  ];
  const rechecked = [
    "so it was re-checked against where you are now instead of being set aside.",
    "so the same change was weighed again from today's picture rather than dropped.",
  ];
  return `${pickDayVariant(moved, date, "regen-rebase-why")}, ${pickDayVariant(rechecked, date, "regen-rebase-what")}`;
}
