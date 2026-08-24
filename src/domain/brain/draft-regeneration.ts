import { pickDayVariant } from "../../repo/brain/day-read-rules.js";
import { regenerationReceiptForDraft } from "../../repo/brain-decisions.js";
import { buildProgressionProposal, buildVolumeRestoreProposal } from "../../repo/progression.js";
import { buildRunPlanProposal } from "../../repo/run-progression.js";
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
export function regenerableProducer(proposal: any): RegenerableProducer | null {
  const agent = String(proposal?.agent ?? "");
  if (agent === "auto-progression") {
    const day = progressionDay(proposal);
    if (!Number.isFinite(day)) return null;
    // Deliberately WITHOUT `forNextSession`: that option reads the progression against
    // the session that had just finished when the original draft was written, and the
    // whole point of regenerating is to read against the picture as it stands now.
    return { key: `auto-progression:day:${day}`, rerun: () => buildProgressionProposal(day) };
  }
  if (agent === "auto-run-plan") {
    // No date argument — the week the run plan is being read for is today's.
    return { key: "auto-run-plan", rerun: () => buildRunPlanProposal() };
  }
  if (agent === VOLUME_RESTORE_AGENT) {
    const cause = volumeRestoreCause(proposal);
    return {
      key: `volume-restore:${cause ?? "any"}`,
      rerun: () => buildVolumeRestoreProposal(cause ? { cause } : {}),
    };
  }
  return null;
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
