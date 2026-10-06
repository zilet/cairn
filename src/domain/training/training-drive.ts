/**
 * The athlete's door to their training drive: "push me harder — until the block ends /
 * until <date>", or "back to steady". One use case behind REST (PUT /api/training-drive),
 * MCP (set_training_drive) and chat (the `set_training_drive` action).
 *
 * The athlete decides; Cairn records. Every change lands at once (it is their word, not
 * a coaching proposal) and is written to the decision ledger as an `observe`-tier,
 * reversible `training_structure` decision with falsifiable expectations — "pushing
 * should not cost you strength, session quality or joint comfort" — and a server-owned
 * one-tap Undo (brain_rollbacks kind `training_stance`, handled in revertTrainingStance,
 * called from the autonomy service's revert path).
 *
 * A push stance is always DATED: an explicit date wins, `scope: "block"` runs through the
 * active block's last day, and with neither it runs PUSH_STANCE_DEFAULT_DAYS. It is capped
 * at PUSH_STANCE_MAX_DAYS so the athlete re-states it rather than living under a stale ask.
 * What a stance licenses — and what it can never touch — is training-drive.ts's header.
 */
import {
  patchBrainDecision,
  saveBrainRollback,
  recordDecision,
  transitionBrainDecision,
  getBrainDecision,
  listBrainExpectations,
  setBrainExpectationStatus,
} from "../../repo/brain-decisions.js";
import {
  buildLiftProgressionExpectations,
  buildTrainingFeedbackExpectations,
  liftProgressionSubjects,
} from "../../repo/brain/change-expectations.js";
import { getPlan } from "../../repo/plan.js";
import { getSettings, setSettings } from "../../repo/settings.js";
import { addDaysISO, localDateISO } from "../../repo/shared.js";
import { invalidateDayRead } from "../../repo/day-read-cache.js";
import {
  PUSH_STANCE_DEFAULT_DAYS,
  PUSH_STANCE_MAX_DAYS,
  type PushStance,
  type PushStanceScope,
  type PushStanceVia,
  type TrainingDriveValue,
  activeBlockEndDate,
  endOpenStances,
  getStance,
  insertStance,
  latestOpenStance,
  linkStanceDecision,
  reopenStance,
  trainingDriveState,
} from "../../repo/training-drive.js";
import { trainingDriveRead } from "../../repo/training-drive-read.js";
import { closeOpenPushOffer } from "../../repo/push-offer.js";
import { PLAN_ITEM_EFFECT_TIER, planItemEffectTier } from "./plan-item-order.js";
import type { ClientSetTrainingDriveResponse } from "../../contracts/training-drive.js";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dayWords(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}` : iso;
}

export interface SetTrainingDriveInput {
  drive: unknown;
  until?: unknown;
  scope?: unknown;
  words?: unknown;
  via?: PushStanceVia;
  /** The day the statement is made (tests); defaults to today. */
  today?: string;
}

// The rollback payload: what the drive was before this decision and what it set. Undo
// only acts while the world still holds what this decision applied.
interface StanceRollback {
  version: 1;
  applied: { drive: TrainingDriveValue; stance_id: number | null };
  previous: { drive: TrainingDriveValue; stance_id: number | null };
}

// The plan's main lifts — the primary-tier compounds, plan order, first three — the
// lifts a push should not cost.
function mainLifts(): string[] {
  try {
    const out: string[] = [];
    for (const day of getPlan() as any[]) {
      for (const item of day?.items ?? []) {
        if (!item?.exercise || item.kind === "cardio") continue;
        if (planItemEffectTier(item) !== PLAN_ITEM_EFFECT_TIER.primary) continue;
        if (!out.some((name) => name.toLowerCase() === String(item.exercise).toLowerCase())) out.push(item.exercise);
      }
    }
    return out.slice(0, 6);
  } catch {
    return [];
  }
}

function stanceExpectations(asOf: string) {
  try {
    return [
      ...buildLiftProgressionExpectations(liftProgressionSubjects(mainLifts(), asOf, 3), asOf),
      ...buildTrainingFeedbackExpectations(asOf),
    ];
  } catch {
    return [];
  }
}

function resolveUntil(
  input: SetTrainingDriveInput,
  today: string
): { until: string; scope: PushStanceScope; notes: string[] } | { error: string } {
  const notes: string[] = [];
  const max = addDaysISO(today, PUSH_STANCE_MAX_DAYS) ?? today;
  const rawUntil = typeof input.until === "string" ? input.until.trim().slice(0, 10) : "";
  if (rawUntil) {
    if (!ISO.test(rawUntil) || addDaysISO(rawUntil, 0) !== rawUntil)
      return { error: "until must be a real date (YYYY-MM-DD)" };
    if (rawUntil < today) return { error: "until is already in the past — name today or a later day" };
    if (rawUntil > max) {
      notes.push(
        `A push runs at most ${PUSH_STANCE_MAX_DAYS / 7} weeks before you re-state it, so this one runs through ${dayWords(max)}.`
      );
      return { until: max, scope: "date", notes };
    }
    return { until: rawUntil, scope: "date", notes };
  }
  if (input.scope === "block") {
    const end = activeBlockEndDate(today);
    if (end && end >= today) {
      const until = end > max ? max : end;
      const daysLeft = Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 864e5);
      if (daysLeft < 7)
        notes.push(
          `This block ends ${dayWords(until)}, so the push runs through then. Name a date to carry it into the next block.`
        );
      return { until, scope: "block", notes };
    }
    notes.push(
      `No block is running, so the push runs ${PUSH_STANCE_DEFAULT_DAYS / 7} weeks, through ${dayWords(addDaysISO(today, PUSH_STANCE_DEFAULT_DAYS - 1) ?? today)}.`
    );
  }
  const until = addDaysISO(today, PUSH_STANCE_DEFAULT_DAYS - 1) ?? today;
  return { until, scope: "date", notes };
}

function cleanWords(value: unknown): string | null {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 240) : null;
}

export function setTrainingDrive(input: SetTrainingDriveInput): ClientSetTrainingDriveResponse {
  const drive = String(input.drive ?? "")
    .trim()
    .toLowerCase();
  if (drive !== "push" && drive !== "steady") return { ok: false, error: "drive must be 'push' or 'steady'" };
  const today = String(input.today || localDateISO()).slice(0, 10);
  const via: PushStanceVia = input.via === "chat" || input.via === "mcp" ? input.via : "athlete";
  const words = cleanWords(input.words);
  const before = trainingDriveState(today);
  const standingBefore: TrainingDriveValue = getSettings().training_drive === "push" ? "push" : "steady";
  const previous = { drive: before.drive, stance_id: before.stance?.id ?? null };

  if (drive === "push") {
    const resolved = resolveUntil(input, today);
    if ("error" in resolved) return { ok: false, error: resolved.error };
    // What the drive goes back to when THIS stance ends: whatever stood before any
    // stance (a renewed stance inherits it rather than "push" from the one it replaces).
    const fallback: TrainingDriveValue = before.stance ? before.stance.previous_drive : before.drive;
    if (standingBefore !== "push") setSettings({ training_drive: "push" }, { keepStances: true });
    // An open stance whose window has CLOSED is replaced exactly like a live one: the
    // standing value still reads push, so a toggle would see "push → push" and do nothing,
    // but the drive in force already fell back — this push opens a new dated stance.
    const replaced = latestOpenStance();
    endOpenStances("replaced");
    const stance = insertStance({
      since: today,
      until: resolved.until,
      scope: resolved.scope,
      words,
      previous_drive: fallback,
      set_via: via,
    });
    const decisionId = recordStanceDecision({
      today,
      summary: `You asked to be pushed through ${dayWords(stance.until)}.`,
      rationale:
        "Your word, recorded as said. While it runs, a clean day can carry up to two heavier top sets, " +
        "a stacked week stays a caveat for longer, and a top set with a rep in hand earns the step — " +
        "never over a rest-grade morning, a day that cost you, a symptom, or anything clinical.",
      via,
      stance,
      words,
      rollback: { version: 1, applied: { drive: "push", stance_id: stance.id }, previous },
      expectations: true,
    });
    if (decisionId != null) linkStanceDecision(stance.id, decisionId);
    // The coach's open offer, if any, is answered by this push — whichever door said it.
    const offerId = closeOpenPushOffer(decisionId, today);
    if (offerId != null && decisionId != null) {
      try {
        const own = getBrainDecision(decisionId);
        patchBrainDecision(decisionId, {
          context: { ...((own?.context as Record<string, unknown>) ?? {}), accepted_offer_id: offerId },
        });
      } catch {
        /* the link is provenance only */
      }
    }
    // Supersede the replaced stance's own ledger row: the newest word owns the drive.
    if (replaced?.decision_id) {
      try {
        const old = getBrainDecision(replaced.decision_id);
        if (old?.status === "applied")
          transitionBrainDecision(replaced.decision_id, "superseded", { supersededBy: decisionId ?? null });
      } catch {
        /* the new stance is authoritative; the old row's status is bookkeeping */
      }
    }
    safeInvalidate(today);
    return { ok: true, notes: resolved.notes, decision_id: decisionId, read: trainingDriveRead(today) };
  }

  // drive === "steady"
  if (before.drive === "steady" && !before.stance && standingBefore === "steady") {
    return { ok: true, notes: ["The drive is already steady."], decision_id: null, read: trainingDriveRead(today) };
  }
  // A push that already ran out: the drive in force is ALREADY steady (read-time fall
  // back), so stepping back changes nothing the athlete trains under. Tidy the lapsed row
  // and the standing value so Settings and the read agree, with no ledger row — a "back
  // to steady" with an Undo would be a change that never happened.
  if (before.drive === "steady" && !before.stance) {
    endOpenStances("stepped_back");
    if (standingBefore !== "steady") setSettings({ training_drive: "steady" }, { keepStances: true });
    safeInvalidate(today);
    return { ok: true, notes: ["The drive is already steady."], decision_id: null, read: trainingDriveRead(today) };
  }
  const ending = before.stance;
  if (ending) endOpenStances("stepped_back", ending.id);
  else endOpenStances("stepped_back");
  if (standingBefore !== "steady") setSettings({ training_drive: "steady" }, { keepStances: true });
  const decisionId = recordStanceDecision({
    today,
    summary: ending ? "You stepped back from the push to a steady drive." : "Your training drive is back to steady.",
    rationale:
      "Your word, recorded as said. The stacked-days rest, the reach and the load steps go back to their ordinary bars.",
    via,
    stance: null,
    words,
    rollback: { version: 1, applied: { drive: "steady", stance_id: null }, previous },
    expectations: false,
  });
  safeInvalidate(today);
  return { ok: true, decision_id: decisionId, read: trainingDriveRead(today) };
}

function safeInvalidate(date: string): void {
  try {
    invalidateDayRead(date);
  } catch {
    /* the fingerprint carries the drive anyway; this only skips one stale serve */
  }
}

function recordStanceDecision(input: {
  today: string;
  summary: string;
  rationale: string;
  via: PushStanceVia;
  stance: PushStance | null;
  words: string | null;
  rollback: StanceRollback;
  expectations: boolean;
}): number | null {
  try {
    const { decision } = recordDecision(
      {
        effective_date: input.today,
        kind: "training_structure",
        domain: "training",
        summary: input.summary,
        rationale: input.rationale,
        source: input.via === "chat" ? "chat" : input.via === "mcp" ? "mcp" : "athlete",
        source_ref_type: null,
        source_ref_key: null,
        status: "applied",
        // The athlete decided this; Cairn recorded it. Claiming an acting tier would
        // overstate what the system did (the program-block decision's same reasoning).
        autonomy_tier: "observe",
        risk_class: "low",
        reversible: true,
        input_fingerprint: null,
        context: {
          training_drive_stance: true,
          // The athlete's own word (any door): the Changes feed shows it as "You said …".
          stated_by_athlete: true,
          words: input.words,
          previous_drive: input.rollback.previous.drive,
        },
        action: {
          training_drive: input.rollback.applied.drive,
          stance_id: input.stance?.id ?? null,
          since: input.stance?.since ?? null,
          until: input.stance?.until ?? null,
          scope: input.stance?.scope ?? null,
          // Distinct per statement, so two stances on one day never share a fingerprint.
          stated_at: new Date().toISOString(),
          // What the brain changed for it, in the athlete's register (the Changes feed's
          // "→ Y" after "You said X").
          user_explanation:
            input.rollback.applied.drive === "push"
              ? "On clean days the room widens: up to two heavier top sets, a top set with a rep in hand earns the step, and a scheduled deload waits unless your loaded weeks earn it. A rest-grade morning, a day that cost you, a symptom or anything clinical still holds."
              : "The reach, the load steps and the stacked-days rest are back to their ordinary bars.",
        },
        specialist: null,
        applied_at: new Date().toISOString(),
        reverted_at: null,
        superseded_by: null,
        evaluator_version: null,
      },
      input.expectations ? stanceExpectations(input.today) : []
    );
    if (decision.id) saveBrainRollback(decision.id, "training_stance", input.rollback);
    return decision.id ?? null;
  } catch {
    // The athlete's word is already in force; the ledger row is accountability, best effort.
    return null;
  }
}

/**
 * Undo a stance decision (called inside the autonomy service's revert savepoint). Acts
 * only while the world still holds what the decision applied — a newer stance or a
 * Settings toggle since then wins, and the Undo says so by throwing.
 */
export function revertTrainingStance(
  payload: unknown,
  today: string = localDateISO(),
  undoneDecisionId: number | null = null
): void {
  const p = payload as StanceRollback | null;
  if (!p || p.version !== 1 || !p.applied || !p.previous) throw new Error("rollback snapshot unavailable");
  const standing: TrainingDriveValue = getSettings().training_drive === "push" ? "push" : "steady";
  const open = latestOpenStance();
  const holdsApplied =
    standing === p.applied.drive &&
    (p.applied.stance_id == null ? open == null || open.until < today : open?.id === p.applied.stance_id);
  if (!holdsApplied) throw new Error("the training drive has changed since — your newer choice stands");
  if (p.applied.stance_id != null) endOpenStances("undone", p.applied.stance_id);
  setSettings(
    { training_drive: p.previous.drive === "push" || p.previous.stance_id != null ? "push" : "steady" },
    {
      keepStances: true,
    }
  );
  if (p.previous.stance_id != null) {
    const prior = getStance(p.previous.stance_id);
    if (prior && !reopenStance(prior.id, today)) {
      // The earlier stance has run out in the meantime: go back to what stood under it.
      setSettings({ training_drive: prior.previous_drive }, { keepStances: true });
    } else if (prior) {
      restoreReopenedStanceDecision(prior.decision_id ?? null, undoneDecisionId, today);
    }
  }
  safeInvalidate(today);
}

// The reopened stance is in force again, so its own ledger row is too (review,
// 2026-10-06): the newer stance superseded it, and undoing that newer stance used to
// reopen the stance while its row stayed `superseded` — a push in force with no row to
// show it and no Undo of its own. The row goes back to `applied` (so its own one-tap
// Undo works again, ownership-guarded like any other), and the falsifiable expectations
// the supersede canceled resume where their window still runs. Only a row this undone
// decision superseded is touched; anything else moved it for its own reason.
function restoreReopenedStanceDecision(decisionId: number | null, undoneDecisionId: number | null, today: string): void {
  if (decisionId == null) return;
  try {
    const row = getBrainDecision(decisionId);
    if (!row || row.status !== "superseded") return;
    if (undoneDecisionId != null && row.superseded_by != null && row.superseded_by !== undoneDecisionId) return;
    patchBrainDecision(decisionId, { status: "applied", superseded_by: null });
    for (const expectation of listBrainExpectations({ decisionId, status: "canceled", limit: 100 })) {
      if (expectation.id != null && String(expectation.window_end ?? "") >= today)
        setBrainExpectationStatus(expectation.id, "pending");
    }
  } catch {
    /* the stance is reopened either way; the row is accountability, best effort */
  }
}
