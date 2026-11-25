// ============================================================================
// recovery-refusal.ts — "the athlete already said no to this."
//
// A recovery week is a STRUCTURE decision: it reshapes a whole week of training.
// When the athlete cancels an announced one, that refusal is their word on the
// matter, and re-announcing the same week two days later is the system arguing
// with them. The refusal is durable for the rest of the CURRENT BLOCK.
//
// It is not, however, a permanent gag. A refusal is about the athlete's read of
// their own training; it says nothing about a symptom, an illness, a clinical
// finding, or a fresh subjective brake that arrives AFTERWARDS. Any of those is
// new information the athlete has not yet answered, so the announcement is
// allowed again. Everything here is READ-ONLY and fail-soft: a query problem
// answers "no refusal on record", which restores the pre-existing behaviour
// rather than silently suppressing a safety response.
// ============================================================================
import { db } from "../db.js";
import { latestUserVetoAt } from "./brain-decisions.js";
import { contextEventReadsAsIllness } from "./context-effect.js";
import { getActiveBlock } from "./program-blocks.js";
import { addDaysISO, localDateISO } from "./shared.js";
import { runDownCheckinCorroboratedOn } from "./felt-brake.js";
import { withSymptomClosures } from "./injury-symptom-link.js";

// With no active block to scope to, a refusal still has to mean something. Four
// weeks is the ordinary block length, so it is the honest stand-in.
export const RECOVERY_REFUSAL_FALLBACK_DAYS = 28;

const isDate = (value: unknown): value is string => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""));

function one(sql: string, ...params: unknown[]): boolean {
  try {
    return !!db.prepare(sql).get(...(params as any[]));
  } catch {
    return false;
  }
}

// The day the athlete last UNDID a landed recovery week (revertDecision is only ever the
// person's tap) or set aside one held for their yes (their discard writes a `rejected`
// row carrying `proposal_status: 'discarded'`; a system retirement is `superseded`).
// Fail-soft: a read problem is "nothing on record".
function latestUndoOrSetAsideOn(): string | null {
  try {
    const row = db
      .prepare(
        `SELECT MAX(on_date) AS on_date FROM (
           SELECT COALESCE(date(reverted_at), date(created_at)) AS on_date FROM brain_decisions
            WHERE kind = 'training_structure' AND domain = 'recovery' AND status = 'reverted'
           UNION ALL
           SELECT date(created_at) AS on_date FROM brain_decisions
            WHERE kind = 'training_structure' AND domain = 'recovery' AND status = 'rejected'
              AND json_extract(action_json, '$.proposal_status') = 'discarded'
         )`
      )
      .get() as { on_date?: string | null } | undefined;
    const on = String(row?.on_date ?? "").slice(0, 10);
    return isDate(on) ? on : null;
  } catch {
    return null;
  }
}

/**
 * The date of the athlete's own refusal of a recovery week, when one stands
 * inside the current block. `null` means nothing is on record to respect.
 */
export function recoveryWeekRefusedOn(today = localDateISO()): string | null {
  try {
    // Three shapes of the same "no": an announced week held before it landed (a
    // `canceled` row the athlete marked), a landed week undone (`reverted`), and a week
    // held for their yes that they set aside (`rejected` from their discard). The newest
    // one is the refusal on record.
    const refusedOn = [latestUserVetoAt("training_structure", "recovery"), latestUndoOrSetAsideOn()]
      .map((at) => String(at ?? "").slice(0, 10))
      .filter(isDate)
      .sort()
      .at(-1);
    if (!refusedOn || !isDate(refusedOn)) return null;
    const startedAt = String(getActiveBlock()?.started_at ?? "").slice(0, 10);
    const floor = isDate(startedAt) ? startedAt : (addDaysISO(today, -RECOVERY_REFUSAL_FALLBACK_DAYS) ?? today);
    return refusedOn >= floor ? refusedOn : null;
  } catch {
    return null;
  }
}

/**
 * Has a SAFETY-GRADE signal arrived since `since`? Four shapes, each one news the
 * athlete's refusal could not have been about:
 *   • a symptom reported or re-reported after the refusal,
 *   • an illness or injury that started after it and is still open,
 *   • a firm TRAINING health directive derived after it (the clinical lane — see the
 *     exclusions on that query; a resurfaced or lab-lever row is not new news),
 *   • a fresh subjective brake — a run-down check-in an objective signal corroborated
 *     (a lone tap only eases a day, so alone it is not news), or a session logged
 *     with high soreness or a named sore joint.
 * Ordinary fatigue, a flat week, or the same fuel read saying the same thing are
 * deliberately NOT on this list: none of them is new information.
 */
export function newSafetyGradeSignalSince(since: string, today = localDateISO()): boolean {
  if (!isDate(since)) return true;
  if (
    one(
      `SELECT 1 FROM training_symptom_events
        WHERE status = 'active' AND last_reported_on > ? LIMIT 1`,
      since
    )
  )
    return true;
  // The CLINICAL lane — deliberately NOT "any new active directive". Three exclusions,
  // each one a row that is not news the athlete's refusal failed to answer:
  //   • a RESURFACED row (`resurfaced_from_id` set) is old news restated. A worsening
  //     panel re-inserts a previously handled directive with a fresh `created_at`; that
  //     new timestamp must not reopen a training refusal on its own.
  //   • a row outside `domain='training'` is a nutrition or watch lever (a lipid
  //     eat-more-fiber nudge, a recheck reminder). It says nothing about whether this
  //     week's training should change, whatever lab it came from.
  //   • an `uncertain` row is by contract a softer nudge ("keep regular aerobic work
  //     in the week"), not a constraint on training — never safety-grade.
  // What survives is the shape that genuinely overrides a refusal: a firm training
  // directive, from either source, telling the athlete their training must change
  // (e.g. the anemia pattern's "hold endurance volume until iron recovers").
  if (
    one(
      `SELECT 1 FROM health_directives
        WHERE status = 'active'
          AND date(created_at) > ?
          AND resurfaced_from_id IS NULL
          AND domain = 'training'
          AND COALESCE(uncertain, 0) = 0
        LIMIT 1`,
      since
    )
  )
    return true;
  // A run-down check-in is news only when it CARRIED its day. Under the tap law (owner
  // ruling, 2026-09-29) a lone tap eases the day and never rests it, so on its own it
  // cannot reopen a structural "no" the athlete already gave either: it must be
  // corroborated by something objective about the same 24 hours — the one predicate
  // the day read uses (runDownCheckinCorroboratedOn, felt-brake.ts). Illness keeps its
  // own arm below and needs no witness.
  try {
    const lowTapDates = db
      .prepare(
        `SELECT DISTINCT date FROM checkins
          WHERE date > ? AND date <= ? AND (energy <= 2 OR sleep_feel <= 2)
          ORDER BY date DESC`
      )
      .all(since, today) as Array<{ date: string }>;
    if (lowTapDates.some((row) => isDate(row.date) && runDownCheckinCorroboratedOn(row.date))) return true;
  } catch {
    /* unreadable check-ins → no claim from this shape */
  }
  if (
    one(
      `SELECT 1 FROM sessions
        WHERE date > ? AND date <= ?
          AND (soreness >= 4 OR (joint_pain IS NOT NULL AND TRIM(joint_pain) != '')) LIMIT 1`,
      since,
      today
    )
  )
    return true;
  // An injury row, or anything that READS as an illness whatever kind it was filed
  // under — the same classifier the day-read uses, so there is one answer to "is
  // this an illness" rather than a second regex free to drift.
  try {
    // An injury closed through its twin training symptom carries that closing date.
    const events = withSymptomClosures(
      db
        .prepare(
          `SELECT id, kind, title, detail, start_date, end_date, resolved_at
             FROM context_events
            WHERE COALESCE(archived, 0) = 0 AND start_date > ? AND start_date <= ?`
        )
        .all(since, today) as any[],
      today
    );
    for (const event of events) {
      const clinical = String(event?.kind ?? "") === "injury" || contextEventReadsAsIllness(event);
      if (!clinical) continue;
      const resolved = String(event?.resolved_at ?? "").slice(0, 10);
      const end = String(event?.end_date ?? "").slice(0, 10);
      if (isDate(resolved) && resolved < today) continue;
      if (isDate(end) && end < today) continue;
      return true;
    }
  } catch {
    /* unreadable context events → no clinical claim from this shape */
  }
  return false;
}

/**
 * The one question the recovery-week announcement asks: may it speak? False only
 * when a refusal stands in this block and nothing safety-grade has happened since.
 */
export function recoveryWeekMayBeAnnounced(today = localDateISO()): { allowed: boolean; refused_on: string | null } {
  const refusedOn = recoveryWeekRefusedOn(today);
  if (!refusedOn) return { allowed: true, refused_on: null };
  return { allowed: newSafetyGradeSignalSince(refusedOn, today), refused_on: refusedOn };
}
