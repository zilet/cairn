// ============================================================================
// THE SIX SEATS — who on the team made a call, as a ROLE, never a persona.
//
// The six stones are the six seats at the table: Strength, Run, Recovery, Fuel, Body
// and Heart. Each one is a role word and a stone hue, nothing more — no names, no
// faces, no personalities (docs/DESIGN.md, Ask's speaker line in
// src/client/chat-speaker-client.ts). This module is the ONE table of them and the
// ONE deterministic answer to "which seat made this call?", read by:
//
//   - the ledger WRITE (insertBrainDecision / patchBrainDecision stamp
//     `specialist.seat` on every new row, src/repo/brain-decisions.ts), so a new
//     decision carries its seat from the moment it is recorded;
//   - every READ of an older row (the team's week, src/repo/team-week.ts), which
//     derives the same seat from the row's own kind/domain/source/what it changed —
//     so history is attributed too, with no migration;
//   - the specialist voice (src/brain/specialist-voice.ts), whose role words are
//     these same six.
//
// Pure: no DB, no clock. Everything here is a function of the row it is handed.
// ============================================================================
import type { SpecialistDomain } from "../brain/specialist-contract.js";

export type TeamSeatKey = "strength" | "endurance" | "recovery" | "fuel" | "body" | "heart";

/** The six seats in their table order, each with its one role word. */
export const TEAM_SEATS: ReadonlyArray<{ seat: TeamSeatKey; role: string }> = [
  { seat: "strength", role: "Strength" },
  { seat: "endurance", role: "Run" },
  { seat: "recovery", role: "Recovery" },
  { seat: "fuel", role: "Fuel" },
  { seat: "body", role: "Body" },
  { seat: "heart", role: "Heart" },
];

const SEAT_KEYS: ReadonlySet<string> = new Set(TEAM_SEATS.map((s) => s.seat));

export function isTeamSeat(value: unknown): value is TeamSeatKey {
  return typeof value === "string" && SEAT_KEYS.has(value);
}

/** The seat's role word ("Run" for endurance). */
export function teamSeatRole(seat: TeamSeatKey): string {
  return TEAM_SEATS.find((s) => s.seat === seat)?.role ?? "Team";
}

/** A conference specialist's seat. Lifestyle (sleep, stress, daily habit) sits with Recovery. */
export const SPECIALIST_SEAT: Readonly<Record<SpecialistDomain, TeamSeatKey>> = {
  training: "strength",
  endurance: "endurance",
  nutrition: "fuel",
  health: "heart",
  recovery: "recovery",
  lifestyle: "recovery",
};

// A ledger domain's default seat. cross_domain has none: it is read from the words.
const DOMAIN_SEAT: Readonly<Record<string, TeamSeatKey>> = {
  training: "strength",
  nutrition: "fuel",
  health: "heart",
  recovery: "recovery",
  lifestyle: "recovery",
};

// Words that say which seat a free-text call belongs to, most specific first: a lab
// marker before food (an ApoB note mentions saturated fat), food before the scale (a
// cut note mentions weight), the scale before running, running before rest.
const LAB_WORDS =
  /\b(apob|ldl|hdl|lipid|cholesterol|triglyceride|a1c|hba1c|glucose|insulin|blood pressure|lp\(a\)|ferritin|marker|labs?|blood draw|clinician|doctor)\b/i;
const FUEL_WORDS =
  /\b(kcal|calorie|calories|protein|carbs?|carbohydrate|meals?|fuel|fueling|intake|deficit|nutrition)\b/i;
const BODY_WORDS = /\b(body ?weight|weigh-ins?|waist|body fat|dexa|lean mass|scale|weight goal|goal weight)\b/i;
const RUN_WORDS =
  /\b(runs?|running|long run|easy run|tempo|threshold|intervals?|mileage|5k|10k|half marathon|marathon|race|race build|km|miles?)\b/i;
const REST_WORDS = /\b(sleep|hrv|resting heart|rest day|recover|recovery|readiness|deload|stress)\b/i;
const LIFT_WORDS =
  /\b(squat|bench|deadlift|press|row|curl|pull-?ups?|pulldown|lunge|lifts?|lifting|sets?|reps?|plan day|push|pull|legs)\b/i;

/** The seat a sentence speaks for, or null when it names none. */
export function seatFromWords(text: unknown): TeamSeatKey | null {
  const s = String(text ?? "");
  if (!s.trim()) return null;
  if (LAB_WORDS.test(s)) return "heart";
  if (FUEL_WORDS.test(s)) return "fuel";
  if (BODY_WORDS.test(s)) return "body";
  if (RUN_WORDS.test(s) && !LIFT_WORDS.test(s)) return "endurance";
  if (REST_WORDS.test(s)) return "recovery";
  if (LIFT_WORDS.test(s)) return "strength";
  if (RUN_WORDS.test(s)) return "endurance";
  return null;
}

/** The fields a decision carries that the seat is read from. Every field is optional. */
export interface SeatableDecision {
  kind?: unknown;
  domain?: unknown;
  source?: unknown;
  summary?: unknown;
  action?: unknown;
  context?: unknown;
  specialist?: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The seat a writer stored on the row (`specialist.seat`), when it is one of the six. */
export function storedSeat(specialist: unknown): TeamSeatKey | null {
  const seat = record(specialist).seat;
  return isTeamSeat(seat) ? seat : null;
}

function opinionSeats(specialist: unknown): TeamSeatKey[] {
  const raw = Array.isArray(specialist) ? specialist : record(specialist).opinions;
  if (!Array.isArray(raw)) return [];
  const out: TeamSeatKey[] = [];
  for (const opinion of raw) {
    const domain = String(record(opinion).domain ?? "") as SpecialistDomain;
    const seat = SPECIALIST_SEAT[domain];
    if (seat && !out.includes(seat)) out.push(seat);
  }
  return out;
}

const TRAINING_KINDS = new Set([
  "training_target",
  "training_structure",
  "exercise_rotation",
  "session_suggestion",
  "garmin_reconcile",
  "garmin_backfill",
]);

// A run call is a training kind (a race build is filed under `training`), told apart
// by who drafted it or what it moved.
function isRunCall(decision: SeatableDecision): boolean {
  const source = String(decision.source ?? "");
  if (/run|endurance|race|goal_review/i.test(source)) return true;
  const action = record(decision.action);
  const context = record(decision.context);
  if (action.week_moves || action.endurance_schedule || context.endurance_schedule || action.run_plan) return true;
  const summary = String(decision.summary ?? "");
  return RUN_WORDS.test(summary) && !LIFT_WORDS.test(summary);
}

/**
 * The ONE seat a decision belongs to. Deterministic for a row:
 *   1. the seat its writer stored (`specialist.seat`);
 *   2. a case conference: the revision it carried (a nutrition target is Fuel, a
 *      plan change Strength), else its ledger domain, else the first specialist
 *      that spoke;
 *   3. the kind of thing it changed (a target, a meal plan, a lab note, a run week);
 *   4. its ledger domain, else what its own words name, else Strength (the plan's spine).
 */
export function teamSeatForDecision(decision: SeatableDecision | null | undefined): TeamSeatKey {
  if (!decision) return "strength";
  const stored = storedSeat(decision.specialist);
  if (stored) return stored;
  const kind = String(decision.kind ?? "");
  const domain = String(decision.domain ?? "");
  const source = String(decision.source ?? "");
  const action = record(decision.action);
  if (kind === "case_conference" || source === "case_conference") {
    const revision = String(action.conference_revision_type ?? "");
    if (revision === "nutrition_target") return "fuel";
    if (revision === "plan_restructure" || revision === "changes" || revision === "training_target")
      return isRunCall(decision) ? "endurance" : "strength";
    if (kind !== "case_conference" && TRAINING_KINDS.has(kind)) return isRunCall(decision) ? "endurance" : "strength";
    if (kind === "nutrition_target" || kind === "meal_plan") return "fuel";
    if (DOMAIN_SEAT[domain]) return DOMAIN_SEAT[domain];
    return opinionSeats(decision.specialist)[0] ?? seatFromWords(decision.summary) ?? "strength";
  }
  switch (kind) {
    case "nutrition_target":
    case "meal_plan":
      return "fuel";
    case "health_directive":
      return "heart";
    case "day_read":
    case "lifestyle_adjustment":
      return "recovery";
    case "recovery_adjustment":
      return /fuel/i.test(source) ? "fuel" : "recovery";
    case "goal_change":
      return seatFromWords(decision.summary) ?? "body";
    default:
      break;
  }
  if (TRAINING_KINDS.has(kind)) {
    if (domain === "recovery") return "recovery";
    return isRunCall(decision) ? "endurance" : "strength";
  }
  return DOMAIN_SEAT[domain] ?? seatFromWords(decision.summary) ?? opinionSeats(decision.specialist)[0] ?? "strength";
}

/**
 * The specialist blob a ledger write stores, with its seat stamped. A seat the writer
 * passed explicitly wins; otherwise it is derived from the row being written. The rest
 * of the blob (a conference's opinions) is untouched.
 */
export function withSeatStamp(decision: SeatableDecision, explicitSeat: unknown = null): Record<string, unknown> {
  const base = record(decision.specialist);
  const seat = isTeamSeat(explicitSeat)
    ? explicitSeat
    : teamSeatForDecision({ ...decision, specialist: { ...base, seat: undefined } });
  return { ...base, seat };
}
