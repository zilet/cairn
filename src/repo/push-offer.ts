/**
 * THE PUSH OFFER — the coach noticing that the athlete is carrying the program with room
 * to spare, and ASKING whether they want to open the throttle. Never deciding it.
 *
 * A push stance is the athlete's own word (training-drive.ts). The coach may only PROPOSE
 * one: this module is the deterministic evaluator of whether the log has earned that
 * question, and the ledger read of the one open offer. The write path (filing the offer
 * with its falsifiable expectations, the one-tap accept that calls the same
 * setTrainingDrive, the dismissal that is remembered) is src/domain/training/push-offer.ts.
 *
 * What earns the question — every part read off an existing deterministic read, never a
 * second engine, never a score:
 *   • CARRIED: at least two of the main lifts are progressing in the program read (the
 *     progression engine is stepping them up on what was completed at full load) and none
 *     trained recently is regressing or stalled.
 *   • and at least one more witness that the dose is under what he can take: sessions
 *     rated strong (and none rated poor), working sets logged with reps in reserve at the
 *     top of the range, three or more main lifts moving, or a recovery read that is
 *     supportive this morning.
 *   • over enough recent work to mean it (MIN_SESSIONS strength sessions in the window).
 *
 * The floors are not inputs to weigh — any one of them closes the question outright:
 * a day that cost something in the last fortnight (`harmEvidenceOnDay`), a fresh deciding
 * brake this morning, an open symptom or injury, an act-now health finding that governs
 * training, a recovery week, a deload the loaded weeks earned, a push already in force,
 * a dismissed offer inside OFFER_DISMISS_COOLDOWN_DAYS, or a stance that ended inside
 * OFFER_AFTER_STANCE_DAYS. Pull, never push: the offer waits on the training-drive read
 * (and so on the Brief and the conductor) and is never a notification.
 */
import type { ClientPushOffer } from "../contracts/training-drive.js";
import { conferenceConflictInputs } from "../domain/brain/conference-conflicts.js";
import { harmEvidenceOnDay } from "./brain/read-adherence.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { listBrainDecisions, patchBrainDecision, transitionBrainDecision } from "./brain-decisions.js";
import { db } from "../db.js";
import { dayPlanningSignalState } from "./day-read.js";
import { listActiveDirectives } from "./directives-read.js";
import { healthFocus } from "./health-focus.js";
import { getProgramState, liftTrainedRecently } from "./program-state.js";
import { activeRecoveryWeek } from "./recovery-week.js";
import { freshDecidingBrakeFields } from "./signal-state.js";
import { addDaysISO, daysBetweenISO, localDateISO } from "./shared.js";
import { listTrainingSymptoms } from "./training-symptoms.js";
import { latestOpenStance, trainingDriveState } from "./training-drive.js";
import type { BrainDecision } from "../brain/decision-contract.js";

/** The window the evidence is read over. */
export const OFFER_EVIDENCE_DAYS = 21;
/** The harm-free stretch the offer needs behind it. */
export const OFFER_HARM_FREE_DAYS = 14;
/** Strength sessions in the window before the log means anything. */
export const OFFER_MIN_SESSIONS = 5;
/** A "not now" holds the question shut this long. */
export const OFFER_DISMISS_COOLDOWN_DAYS = 28;
/** After a stance ends (ran out, stepped back, undone), the coach waits this long. */
export const OFFER_AFTER_STANCE_DAYS = 14;
/** An unanswered offer stops showing after this many days (its evidence has aged). */
export const OFFER_TTL_DAYS = 10;
/** The stance an accepted offer opens: "the next two weeks". */
export const OFFER_STANCE_DAYS = 14;

const COMPOUND_GROUPS = new Set(["chest", "back", "shoulders", "quads", "hamstrings", "glutes"]);

export type PushOfferBlocker =
  | "already_pushing"
  | "harm"
  | "brake"
  | "symptom"
  | "clinical"
  | "recovery_week"
  | "deload"
  | "dismissed"
  | "stance_recent"
  | "thin_log"
  | "not_carried";

/** The facts the verdict reads. Gathered by pushOfferFacts; pure past that. */
export interface PushOfferFacts {
  date: string;
  pushing: boolean;
  lifts_carried: string[];
  lifts_struggling: string[];
  sessions: number;
  strong_sessions: number;
  poor_sessions: number;
  rir_reserve_sets: number;
  recovery_supportive: boolean;
  harm_dates: string[];
  brakes: string[];
  open_symptoms: number;
  clinical_training_hold: boolean;
  recovery_week: boolean;
  deload: boolean;
  dismissed_on: string | null;
  stance_ended_on: string | null;
}

export interface PushOfferVerdict {
  eligible: boolean;
  /** Plain-words witnesses, most decisive first (the offer's own "why"). */
  evidence: string[];
  /** Machine keys; the first is the reason it is not offered. */
  blockers: PushOfferBlocker[];
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** The pure verdict. Floors first; the evidence only speaks when no floor holds. */
export function pushOfferVerdict(f: PushOfferFacts): PushOfferVerdict {
  const blockers: PushOfferBlocker[] = [];
  if (f.pushing) blockers.push("already_pushing");
  if (f.harm_dates.length) blockers.push("harm");
  if (f.brakes.length) blockers.push("brake");
  if (f.open_symptoms > 0) blockers.push("symptom");
  if (f.clinical_training_hold) blockers.push("clinical");
  if (f.recovery_week) blockers.push("recovery_week");
  if (f.deload) blockers.push("deload");
  if (f.dismissed_on) {
    const age = daysBetweenISO(f.date, f.dismissed_on);
    if (age != null && age < OFFER_DISMISS_COOLDOWN_DAYS) blockers.push("dismissed");
  }
  if (f.stance_ended_on) {
    const age = daysBetweenISO(f.date, f.stance_ended_on);
    if (age != null && age < OFFER_AFTER_STANCE_DAYS) blockers.push("stance_recent");
  }
  if (f.sessions < OFFER_MIN_SESSIONS) blockers.push("thin_log");

  const evidence: string[] = [];
  const carried = f.lifts_carried.length >= 2 && f.lifts_struggling.length === 0;
  if (carried) evidence.push(`${joinWords(f.lifts_carried.slice(0, 3))} keep stepping up on what you complete`);
  else blockers.push("not_carried");
  const witnesses: string[] = [];
  if (f.strong_sessions >= 2 && f.poor_sessions === 0)
    witnesses.push(`${f.strong_sessions} sessions you rated strong, none rated poor`);
  if (f.rir_reserve_sets >= 3) witnesses.push("top sets finished with reps still in hand");
  if (f.lifts_carried.length >= 3) witnesses.push("the progress is across the board, not one lift");
  if (f.recovery_supportive) witnesses.push("recovery reads supportive this morning");
  if (carried && !witnesses.length) blockers.push("not_carried");
  evidence.push(...witnesses);
  if (!f.harm_dates.length) evidence.push(`nothing in the last ${OFFER_HARM_FREE_DAYS / 7} weeks cost you`);
  return { eligible: blockers.length === 0, evidence: blockers.length ? [] : evidence.slice(0, 4), blockers };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function sessionFacts(
  from: string,
  to: string
): {
  sessions: number;
  strong: number;
  poor: number;
  rir: number;
} {
  const rows = safe(
    () =>
      db
        .prepare(
          `SELECT s.id, s.performance,
                  (SELECT COUNT(*) FROM logged_sets ls WHERE ls.session_id = s.id AND ls.reps IS NOT NULL) AS sets,
                  (SELECT COUNT(*) FROM logged_sets ls WHERE ls.session_id = s.id AND ls.rir IS NOT NULL AND ls.rir >= 2 AND ls.reps IS NOT NULL) AS rir_sets
             FROM sessions s
            WHERE s.date >= ? AND s.date <= ?`
        )
        .all(from, to) as Array<{ performance: number | null; sets: number; rir_sets: number }>,
    []
  );
  const lifted = rows.filter((r) => Number(r.sets) > 0);
  return {
    sessions: lifted.length,
    strong: lifted.filter((r) => Number(r.performance) >= 4).length,
    poor: lifted.filter((r) => r.performance != null && Number(r.performance) <= 2).length,
    rir: lifted.reduce((n, r) => n + Number(r.rir_sets || 0), 0),
  };
}

function isOffer(decision: BrainDecision | null | undefined): boolean {
  return (decision?.context as Record<string, unknown> | null)?.push_offer === true;
}

function stampDay(value: unknown): string | null {
  const text = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

/** The newest dismissed offer's day — the remembered "not now". */
export function lastDismissedOfferDay(): string | null {
  for (const d of safe(() => listBrainDecisions({ status: "rejected", kind: "training_structure", limit: 50 }), [])) {
    if (!isOffer(d)) continue;
    const on = String((d.context as Record<string, unknown>)?.dismissed_on ?? "") || stampDay(d.created_at);
    if (on) return on;
  }
  return null;
}

function lastStanceEndDay(date: string): string | null {
  const open = latestOpenStance();
  if (open && open.until < date) return open.until;
  const row = safe(
    () =>
      db
        .prepare(`SELECT ended_at, until FROM training_stances WHERE ended_at IS NOT NULL ORDER BY id DESC LIMIT 1`)
        .get() as { ended_at: string | null; until: string } | undefined,
    undefined
  );
  if (!row) return null;
  const ended = stampDay(row.ended_at);
  return ended && ended < row.until ? ended : row.until;
}

// ---- the floors, one read each (shared with training-drive-read.ts stanceHeldBy) ----

/** An act-now finding governs training right now — the conference's own lever rule. */
export function clinicalTrainingHold(): boolean {
  return safe(() => {
    const inputs = conferenceConflictInputs({ health_focus: healthFocus(), directives: listActiveDirectives() });
    return inputs.clinicalAttention === true && inputs.clinicalLevers.some((lever) => lever.domain === "training");
  }, false);
}

/** Open (active) training symptoms on `date`, from the lifecycle — never a legacy seed. */
export function openSymptomCount(date: string): number {
  return safe(
    () => listTrainingSymptoms({ on: date, seed_legacy: false }).filter((s: any) => s.status === "active").length,
    0
  );
}

/** The fresh deciding brakes on `date` (signal state) and whether recovery reads supportive. */
export function morningBrakes(date: string): { brakes: string[]; recovery_supportive: boolean } {
  const state = safe(() => dayPlanningSignalState(date), null);
  const dimensions = (state as any)?.dimensions ?? null;
  const brakes = dimensions ? safe(() => freshDecidingBrakeFields(dimensions), [] as string[]) : [];
  const recoveryDim = dimensions?.recovery_capacity;
  const recoveryStatus = String(recoveryDim?.deciding?.status ?? recoveryDim?.status ?? "");
  return { brakes, recovery_supportive: recoveryStatus === "supportive" };
}

/** Gather the facts for `date`. Read-only. */
export function pushOfferFacts(date?: string | null): PushOfferFacts {
  const d = String(date || localDateISO()).slice(0, 10);
  const from = addDaysISO(d, -OFFER_EVIDENCE_DAYS) ?? d;
  const yesterday = addDaysISO(d, -1) ?? d;
  const drive = trainingDriveState(d);
  const program = safe(() => getProgramState(d), null);
  const recent = (program?.lifts ?? []).filter(
    (lift) => COMPOUND_GROUPS.has(String(lift.muscle_group ?? "").toLowerCase()) && liftTrainedRecently(lift, d)
  );
  const carried = recent.filter((lift) => lift.status === "progressing").map((lift) => lift.exercise);
  const struggling = recent
    .filter((lift) => lift.status === "regressing" || lift.status === "plateaued")
    .map((lift) => lift.exercise);
  const sessions = sessionFacts(from, yesterday);
  const harm: string[] = [];
  for (let back = 1; back <= OFFER_HARM_FREE_DAYS; back++) {
    const iso = addDaysISO(d, -back);
    if (iso && safe(() => harmEvidenceOnDay(iso), null)) harm.push(iso);
  }
  const morning = morningBrakes(d);
  const phase = String(program?.mesocycle?.phase ?? "");
  return {
    date: d,
    pushing: drive.drive === "push" || drive.stance != null,
    lifts_carried: carried,
    lifts_struggling: struggling,
    sessions: sessions.sessions,
    strong_sessions: sessions.strong,
    poor_sessions: sessions.poor,
    rir_reserve_sets: sessions.rir,
    recovery_supportive: morning.recovery_supportive,
    harm_dates: harm,
    brakes: morning.brakes,
    open_symptoms: openSymptomCount(d),
    clinical_training_hold: clinicalTrainingHold(),
    recovery_week: safe(() => activeRecoveryWeek(d) != null, false),
    deload: phase === "deload" || phase === "deload-due" || program?.mesocycle?.deload_evidence === true,
    dismissed_on: lastDismissedOfferDay(),
    stance_ended_on: lastStanceEndDay(d),
  };
}

export function pushOfferRead(date?: string | null): PushOfferVerdict & { facts: PushOfferFacts } {
  const facts = pushOfferFacts(date);
  return { ...pushOfferVerdict(facts), facts };
}

// ---- the open offer, as the ledger holds it ----

/** The newest offer still waiting on the athlete (observed, inside its TTL), or null. */
export function openPushOfferDecision(date?: string | null): BrainDecision | null {
  const d = String(date || localDateISO()).slice(0, 10);
  for (const decision of safe(
    () => listBrainDecisions({ status: "observed", kind: "training_structure", limit: 50 }),
    []
  )) {
    if (!isOffer(decision)) continue;
    const offered = String(decision.effective_date ?? "") || stampDay(decision.created_at);
    const age = offered ? daysBetweenISO(d, offered) : null;
    if (age == null || age < 0 || age > OFFER_TTL_DAYS) continue;
    return decision;
  }
  return null;
}

const OFFER_LINE: ReadonlyArray<(evidence: string) => string> = [
  (evidence) => `You're carrying this well — ${evidence}. Want to open the throttle for the next two weeks?`,
  (evidence) => `The program looks light for you right now: ${evidence}. Want me to push you for the next two weeks?`,
  (evidence) => `You've been handling more than the plan asks — ${evidence}. Open it up for two weeks?`,
];

/** The UI view of the open offer. Null when none waits. Never writes. */
export function pushOfferView(date?: string | null): ClientPushOffer | null {
  const d = String(date || localDateISO()).slice(0, 10);
  const decision = openPushOfferDecision(d);
  if (!decision?.id) return null;
  // A push already in force answers the question; a floor that has since closed it
  // (a day that cost something, a fresh brake) hides it rather than asking over it.
  if (trainingDriveState(d).drive === "push") return null;
  for (const back of [1, 2, 3]) {
    const iso = addDaysISO(d, -back);
    if (iso && safe(() => harmEvidenceOnDay(iso), null)) return null;
  }
  if (morningBrakes(d).brakes.length || openSymptomCount(d) > 0 || clinicalTrainingHold()) return null;
  const evidence = Array.isArray((decision.context as any)?.evidence)
    ? ((decision.context as any).evidence as unknown[]).map(String).filter(Boolean)
    : [];
  const until = addDaysISO(d, OFFER_STANCE_DAYS - 1) ?? d;
  return {
    decision_id: decision.id,
    offered_on: String(decision.effective_date ?? stampDay(decision.created_at) ?? d),
    evidence,
    line: pickDayVariant(OFFER_LINE, d, "push_offer:line")(joinWords(evidence.slice(0, 2)) || "the log says so"),
    until,
    accept_label: "Push me for two weeks",
    dismiss_label: "Not now",
  };
}

export function isPushOfferDecision(decision: BrainDecision | null | undefined): boolean {
  return isOffer(decision);
}

/**
 * Called by setTrainingDrive when the athlete sets a push (by any door): an open offer is
 * answered by it, so it is superseded by the stance's own decision. A steady statement
 * leaves the offer alone (they did not answer it).
 */
export function closeOpenPushOffer(stanceDecisionId: number | null, today: string = localDateISO()): number | null {
  const open = openPushOfferDecision(today);
  if (!open?.id) return null;
  try {
    transitionBrainDecision(open.id, "superseded", { supersededBy: stanceDecisionId ?? null });
    patchBrainDecision(open.id, {
      context: { ...((open.context as Record<string, unknown>) ?? {}), accepted_on: today },
    });
    return open.id;
  } catch {
    return null;
  }
}
