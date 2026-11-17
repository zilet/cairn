// ============================================================================
// THE TEAM'S WEEK, SPOKEN — the athlete-facing register of every team-week line.
//
// The ledger stores the machine register: a progression's summary is a label for the
// ledger ("Auto-progression for day 1 — 2 lifts"), an expectation is a metric key and
// a JSON target, a directive is often written for a clinician ("Surface the 16 IU/mL
// result … for a clinician to decide"), an attention reason is a status clause. None
// of that is rewritten in place — the coach context and the provenance trail still
// read it as stored. This module is the projection a PERSON reads instead, the same
// law `spokenSignalVoice` holds for the Brief (CLAUDE.md): every sentence is built
// from what the row actually holds, and every recurring line rotates through a
// day-stable variant set (`pickDayVariant`), never one literal.
//
// Pure apart from what it is handed: no DB, no clock (dates are words against the
// `asOf` the caller passes; units are the athlete's, passed in).
// ============================================================================
import type { BrainDecision } from "../brain/decision-contract.js";
import type { BrainExpectation } from "../brain/expectation-contract.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { type WeightUnit, dateWords, loadWords, weightRateValue } from "./display-words.js";
import { joinList } from "./shared.js";
import { spokenMarkerName } from "./loop-speech.js";
import { athleteLine, athleteRegister } from "./brain/clinician-ask.js";
import { violatesReadingGrammar } from "./day-read-grammar.js";
import { type TeamSeatKey, teamSeatForDecision, teamSeatRole } from "./team-seats.js";

const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

/** "six" for 6, digits past twelve. */
export function numberWord(n: number): string {
  const i = Math.trunc(n);
  return i >= 0 && i < NUMBER_WORDS.length ? NUMBER_WORDS[i] : String(i);
}

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sentence(text: string): string {
  const t = text.trim();
  return !t ? t : /[.!?…]$/.test(t) ? t : `${t}.`;
}

// ---------------------------------------------------------------------------
// What a progression moved, lift by lift
// ---------------------------------------------------------------------------

export type LiftMoveKind = "raised" | "lowered" | "range" | "sets_up" | "sets_down" | "held" | "added" | "unknown";

export interface LiftMove {
  name: string;
  move: LiftMoveKind;
  load: number | null; // the load after the change (lb; negative = assist; null = bodyweight/unknown)
  rep_low: number | null;
  rep_high: number | null;
  sets: number | null;
}

// The value a field holds after the change: a field the change did not name keeps its
// before value; only target_weight treats an explicit null as a value (bodyweight).
function afterValue(change: Record<string, any>, before: Record<string, any>, key: string): unknown {
  const v = change[key];
  return v === undefined || (v === null && key !== "target_weight") ? before[key] : v;
}

function moveOf(change: Record<string, any>): LiftMoveKind {
  if (change.change === "added") return "added";
  const before = change.before && typeof change.before === "object" ? (change.before as Record<string, any>) : null;
  if (!before) return "unknown";
  const wb = num(before.target_weight) ?? 0;
  const wa = num(afterValue(change, before, "target_weight")) ?? 0;
  if (wa !== wb) return wa > wb ? "raised" : "lowered";
  const sb = num(before.target_seconds);
  const sa = num(afterValue(change, before, "target_seconds"));
  if (sb != null && sa != null && sa !== sb) return sa > sb ? "raised" : "lowered";
  if (
    num(afterValue(change, before, "rep_low")) !== num(before.rep_low) ||
    num(afterValue(change, before, "rep_high")) !== num(before.rep_high)
  )
    return "range";
  const setsB = num(before.sets);
  const setsA = num(afterValue(change, before, "sets"));
  if (setsB != null && setsA != null && setsA !== setsB) return setsA > setsB ? "sets_up" : "sets_down";
  return "held";
}

/** The lifts a decision's applied payload moved, in payload order, one per lift. Swap-ins are left to the swap. */
export function decisionLiftMoves(decision: Pick<BrainDecision, "action"> | null | undefined): LiftMove[] {
  const action = record(decision?.action);
  const swapsIn = new Set(
    (Array.isArray(action.swaps) ? action.swaps : []).map((s: any) =>
      String(s?.to ?? "")
        .trim()
        .toLowerCase()
    )
  );
  const out: LiftMove[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(action.changes) ? action.changes : []) {
    const change = record(raw);
    const name = String(change.exercise ?? "").trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key) || swapsIn.has(key)) continue;
    seen.add(key);
    const before = record(change.before);
    out.push({
      name,
      move: moveOf(change),
      load: num(afterValue(change, before, "target_weight")),
      rep_low: num(afterValue(change, before, "rep_low")),
      rep_high: num(afterValue(change, before, "rep_high")),
      sets: num(afterValue(change, before, "sets")),
    });
  }
  return out;
}

/** The swaps a rotation carried ({from, to}), from its payload, else its "Rotate A → B" summary. */
export function decisionSwaps(
  decision: Pick<BrainDecision, "action" | "summary"> | null | undefined
): Array<{ from: string; to: string }> {
  const action = record(decision?.action);
  const out: Array<{ from: string; to: string }> = [];
  for (const s of Array.isArray(action.swaps) ? action.swaps : []) {
    const from = String(s?.from ?? "").trim();
    const to = String(s?.to ?? "").trim();
    if (from && to) out.push({ from, to });
  }
  if (!out.length) {
    const m = /^rotate\s+(.+?)\s+→\s+(.+?)(?:\s+on day\b.*)?$/i.exec(String(decision?.summary ?? "").trim());
    if (m) out.push({ from: m[1].trim(), to: m[2].trim() });
  }
  return out;
}

// One lift's move as words: the verb (dropped when the previous lift shared it) and the rest.
function movePhrase(m: LiftMove, units: WeightUnit): { verb: string; rest: string } {
  const load = m.load == null ? "bodyweight" : loadWords(m.load, units);
  switch (m.move) {
    case "raised":
      return { verb: "moved", rest: `up to ${load}` };
    case "lowered":
      return { verb: "eased", rest: `back to ${load}` };
    case "range":
      return m.rep_low != null && m.rep_high != null
        ? { verb: "moved", rest: `to ${m.rep_low}–${m.rep_high} reps` }
        : { verb: "moved", rest: "to a new rep range" };
    case "sets_up":
      return { verb: "went", rest: m.sets != null ? `up to ${numberWord(m.sets)} sets` : "up a set" };
    case "sets_down":
      return { verb: "went", rest: m.sets != null ? `down to ${numberWord(m.sets)} sets` : "down a set" };
    case "held":
      return { verb: "held", rest: `at ${load}` };
    case "added":
      return { verb: "joined", rest: "the plan" };
    default:
      return m.load != null ? { verb: "set", rest: `at ${load}` } : { verb: "moved", rest: "on" };
  }
}

const MOVE_PRIORITY: Record<LiftMoveKind, number> = {
  raised: 0,
  lowered: 1,
  range: 2,
  sets_up: 3,
  sets_down: 4,
  added: 5,
  held: 6,
  unknown: 7,
};

/**
 * The week's progressions as ONE spoken sentence that names the lifts and the step:
 * "Bench Press moved up to 145 lb and Barbell Row up to 135 lb, and five more lifts
 * moved from your log." Never a plan-day number. `fallbackCount` speaks an older row
 * that recorded no per-lift payload ("Moved four lifts on from your log.").
 */
export function progressionSentence(
  moves: LiftMove[],
  opts: { units: WeightUnit; asOf: string; fallbackCount?: number }
): string {
  if (!moves.length) {
    const n = Math.max(0, Math.trunc(Number(opts.fallbackCount) || 0));
    return n > 0
      ? pickDayVariant(
          [
            `Moved ${numberWord(n)} ${n === 1 ? "lift" : "lifts"} on from what you logged.`,
            `Your log earned ${numberWord(n)} ${n === 1 ? "lift" : "lifts"} a step.`,
          ],
          opts.asOf,
          "team_week_progression_count"
        )
      : "Moved your lifting targets on from what you logged.";
  }
  const ordered = [...moves].sort((a, b) => MOVE_PRIORITY[a.move] - MOVE_PRIORITY[b.move]);
  const named = ordered.slice(0, 2);
  const rest = ordered.length - named.length;
  const parts: string[] = [];
  let lastVerb = "";
  for (const m of named) {
    const p = movePhrase(m, opts.units);
    parts.push(p.verb === lastVerb ? `${m.name} ${p.rest}` : `${m.name} ${p.verb} ${p.rest}`);
    lastVerb = p.verb;
  }
  const core = parts.join(" and ");
  if (rest > 0) {
    const lifts = rest === 1 ? "lift" : "lifts";
    return pickDayVariant(
      [
        `${core}, and ${numberWord(rest)} more ${lifts} moved from your log.`,
        `${core}, plus ${numberWord(rest)} more ${lifts} adjusted from what you logged.`,
      ],
      opts.asOf,
      "team_week_progression"
    );
  }
  const allRaised = named.every((m) => m.move === "raised");
  return allRaised
    ? pickDayVariant(
        [`${core}, earned from your log.`, `${core} — your log earned it.`],
        opts.asOf,
        "team_week_progression_one"
      )
    : `${core}.`;
}

/** "Swapped Hammer Curl for Barbell Curl and DB Bench Press for Incline Bench Press." */
export function rotationSentence(swaps: Array<{ from: string; to: string }>, asOf: string): string | null {
  const seen = new Set<string>();
  const unique = swaps.filter((s) => {
    const k = `${s.from.toLowerCase()}→${s.to.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!unique.length) return null;
  const shown = unique.slice(0, 3);
  const extra = unique.length - shown.length;
  const tail = extra > 0 ? `, and ${numberWord(extra)} more` : "";
  return pickDayVariant(
    [
      `Swapped ${joinList(shown.map((s) => `${s.from} for ${s.to}`))}${tail}.`,
      `Brought in ${joinList(shown.map((s) => `${s.to} for ${s.from}`))}${tail}.`,
    ],
    asOf,
    "team_week_rotation"
  );
}

// ---------------------------------------------------------------------------
// A change in its own words
// ---------------------------------------------------------------------------

const KIND_LINE: Readonly<Record<string, string>> = {
  training_target: "Adjusted a lifting target.",
  training_structure: "Reshaped how your training week is built.",
  exercise_rotation: "Rotated an exercise.",
  nutrition_target: "Adjusted your calorie target.",
  meal_plan: "Refreshed your meal plan.",
  recovery_adjustment: "Eased the week for recovery.",
  lifestyle_adjustment: "Adjusted a daily habit.",
  goal_change: "Adjusted a goal's timeline.",
  case_conference: "The team reviewed the whole picture.",
};

/**
 * A single change's line: its own summary when it is already written for a person (no
 * producer label, holds the reading grammar), clipped on a sentence or word; else a
 * plain line for the kind of change.
 */
// A producer's templated ledger label ("Auto-progression for day 5 — 2 lifts", "Rotate
// A → B on day 3") is a label for the ledger, never a line for a person.
const LEDGER_LABEL = /^auto-progression\b|^rotate\s.+→/i;

export function spokenChangeLine(summary: unknown, kind: unknown, max = 150): string {
  const fallback = KIND_LINE[String(kind)] ?? "Made a change to your plan.";
  if (LEDGER_LABEL.test(String(summary ?? "").trim())) return fallback;
  return athleteLine(summary, max) ?? fallback;
}

// ---------------------------------------------------------------------------
// What a decision is about, as a noun
// ---------------------------------------------------------------------------

function namesPhrase(names: string[], max = 2, noun = "lifts"): string {
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  return extra > 0 ? `${shown.join(", ")} and ${numberWord(extra)} more ${noun}` : joinList(shown);
}

/**
 * The thing a decision changed, as a noun phrase without an article: "step on Bench
 * Press", "swap to Barbell Curl", "calorie target change", "change to your run week".
 * `subject` (an expectation's subject_key) narrows it to the one lift or marker asked about.
 */
export function decisionSubjectNoun(
  decision: Pick<BrainDecision, "kind" | "domain" | "source" | "summary" | "action" | "context" | "specialist"> | null,
  subject?: { metric_key?: string | null; subject_key?: string | null } | null
): string {
  const metric = String(subject?.metric_key ?? "");
  const key = String(subject?.subject_key ?? "").trim();
  const kind = String(decision?.kind ?? "");
  if (key && metric.startsWith("exercise_")) return kind === "exercise_rotation" ? `swap to ${key}` : `step on ${key}`;
  if (key && metric === "marker_direction") return `change aimed at ${spokenMarkerName(key)}`;
  if (!decision) return "change";
  const seat = teamSeatForDecision(decision);
  switch (kind) {
    case "exercise_rotation": {
      const swaps = decisionSwaps(decision);
      return swaps.length
        ? `swap to ${namesPhrase(
            swaps.map((s) => s.to),
            2,
            "lifts"
          )}`
        : "exercise swap";
    }
    case "training_target": {
      const lifts = decisionLiftMoves(decision).map((m) => m.name);
      return lifts.length ? `step on ${namesPhrase(lifts)}` : seat === "recovery" ? "easier stretch" : "lifting change";
    }
    case "training_structure":
      return seat === "endurance" ? "change to your run week" : "change to how your week is built";
    case "nutrition_target":
      return "calorie target change";
    case "meal_plan":
      return "meal plan";
    case "recovery_adjustment":
      return "easier stretch for recovery";
    case "goal_change":
      return "goal timeline change";
    case "case_conference":
      return `${teamSeatRole(seat).toLowerCase()} call from the team review`;
    default:
      return `${teamSeatRole(seat).toLowerCase()} change`;
  }
}

// ---------------------------------------------------------------------------
// What an expectation looks for, in words
// ---------------------------------------------------------------------------

export interface ExpectationClause {
  subject: string; // "Bench Press", "your weight"
  predicate: string; // "done as written in two sessions", "coming down 0.2–1 lb a week"
}

const DIRECTION_WORDS: Readonly<Record<string, string>> = {
  increase: "rising",
  decrease: "coming down",
  maintain: "holding steady",
  within_band: "staying in its range",
  at_least: "holding up",
  at_most: "staying down",
  complete: "done as planned",
  avoid: "staying clear",
};

function rateWords(band: { min: number; max: number }, units: WeightUnit): string {
  const fmt = (lb: number) => {
    const v = Math.abs(weightRateValue(lb, units));
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  };
  const { min, max } = band;
  if (max <= 0) {
    return Math.abs(max) < 0.05
      ? `coming down up to ${fmt(min)} ${units} a week`
      : `coming down ${fmt(max)}–${fmt(min)} ${units} a week`;
  }
  if (min >= 0) {
    return Math.abs(min) < 0.05
      ? `going up by up to ${fmt(max)} ${units} a week`
      : `going up ${fmt(min)}–${fmt(max)} ${units} a week`;
  }
  return "holding roughly steady";
}

function rateShare(rate: number): string {
  if (rate >= 0.9) return "nearly all of them done";
  if (rate >= 0.7) return "about three in four done";
  if (rate >= 0.45) return "about half done";
  return "some of them done";
}

/**
 * An expectation as subject + predicate, built only from what the row holds. Null for
 * a metric with no person-facing claim (the same-day morning-read check). `subjects`
 * lets one clause speak several lifts asked the same question.
 */
export function expectationClause(
  exp: Pick<BrainExpectation, "metric_key" | "subject_key" | "direction" | "target">,
  units: WeightUnit,
  subjects?: string[]
): ExpectationClause | null {
  const target = record(exp.target);
  const named = subjects?.length ? namesPhrase(subjects) : String(exp.subject_key ?? "").trim();
  const dir = DIRECTION_WORDS[String(exp.direction)] ?? "holding steady";
  switch (exp.metric_key) {
    case "exercise_target_completion": {
      const n = Math.max(1, Math.trunc(num(target.exposures) ?? 2));
      return {
        subject: named || "the changed lifts",
        predicate: `done as written ${n === 1 ? "in the next session" : `in ${numberWord(n)} sessions`}`,
      };
    }
    case "exercise_est_1rm_trend":
      return {
        subject: named || "the lift",
        predicate:
          exp.direction === "increase"
            ? "getting stronger"
            : exp.direction === "decrease"
              ? "easing as planned"
              : subjects && subjects.length > 1
                ? "holding their strength"
                : "holding its strength",
      };
    case "weight_trend_lb_wk": {
      const min = num(target.min);
      const max = num(target.max);
      return {
        subject: "your weight",
        predicate: min != null && max != null ? rateWords({ min, max }, units) : dir,
      };
    }
    case "intake_to_weight_response":
      return { subject: "your weight", predicate: "answering what you eat" };
    case "session_performance_feedback":
      return { subject: "your sessions", predicate: "feeling no worse" };
    case "joint_pain_or_soreness":
      return { subject: "joint pain", predicate: "no more frequent than before" };
    case "plan_day_adherence": {
      const rate = num(target.rate);
      return { subject: "your planned sessions", predicate: rate != null ? rateShare(rate) : "done as planned" };
    }
    case "run_volume_adherence":
      return { subject: "your runs", predicate: "landing near the planned distance" };
    case "vo2max_trend":
      return { subject: "your VO2 max", predicate: dir };
    case "recovery_hrv_delta":
      return { subject: "your HRV", predicate: dir };
    case "recovery_rhr_delta":
      return { subject: "your resting heart rate", predicate: dir };
    case "sleep_duration_delta":
      return { subject: "your sleep", predicate: dir };
    case "marker_direction":
      return {
        subject: named ? spokenMarkerName(named) : "the marker",
        predicate: "moving toward its optimal range at the next draw",
      };
    case "body_measurement_direction":
      return { subject: named ? `your ${named.toLowerCase()}` : "your measurements", predicate: dir };
    default:
      return null;
  }
}

/** "Expects to see Bench Press done as written in two sessions by Dec 14." */
export function expectsSentence(clause: ExpectationClause, windowEnd: string, asOf: string): string {
  const by = dateWords(windowEnd, asOf);
  return `Expects to see ${clause.subject} ${clause.predicate}${by ? ` by ${by}` : ""}.`;
}

/** A still-maturing expectation under "What we're watching". */
export function watchingSentence(clause: ExpectationClause, windowEnd: string, asOf: string): string {
  const by = dateWords(windowEnd, asOf);
  return pickDayVariant(
    [
      `Watching for ${clause.subject} ${clause.predicate}${by ? `, by ${by}` : ""}.`,
      `${capitalize(clause.subject)} ${clause.predicate} is what the team expects${by ? ` by ${by}` : ""}.`,
    ],
    asOf,
    `team_week_watch:${clause.subject}`
  );
}

// ---------------------------------------------------------------------------
// How a call landed
// ---------------------------------------------------------------------------

export interface LandedInput {
  verdict: "aligned" | "not_aligned";
  noun: string; // decisionSubjectNoun — "step on Bench Press"
  clause: ExpectationClause | null;
  // The decision's state now: a change that has since been undone or replaced says so,
  // instead of promising a second look at something no longer in force.
  stillInForce: boolean;
  date: string; // the evaluation's local day, keys the variant
}

function clauseObject(input: LandedInput): string | null {
  if (!input.clause) return null;
  // "The step on Bench Press … the team looked for it done as written" — the subject is
  // not said twice when the noun already names it.
  const subject = input.noun.endsWith(input.clause.subject) ? "it" : input.clause.subject;
  return `${subject} ${input.clause.predicate}`;
}

/**
 * A landed line with its subject, what was expected and what happens next — never
 * "Exercise completion didn't land the way we expected".
 */
export function landedSentence(input: LandedInput): string {
  const subj = `The ${input.noun}`;
  const looked = clauseObject(input);
  const key = `team_week_landed:${input.noun}`;
  if (input.verdict === "aligned") {
    if (!looked) return `${subj} landed as expected.`;
    return pickDayVariant(
      [
        `${subj} landed as expected: the team looked for ${looked}, and saw it.`,
        `${subj} landed the way the team expected, with ${looked}.`,
      ],
      input.date,
      key
    );
  }
  const next = input.stillInForce
    ? pickDayVariant(
        ["The team is taking a second look before the next step.", "It gets a second look before anything else moves."],
        input.date,
        `${key}:next`
      )
    : "That change has since been set aside.";
  if (!looked) return `${subj} didn't land as expected. ${next}`;
  return pickDayVariant(
    [
      `${subj} didn't land as expected: the team looked for ${looked}. ${next}`,
      `${subj} hasn't paid off yet: the team looked for ${looked}. ${next}`,
    ],
    input.date,
    key
  );
}

/** A seat's last concluded call, short: "The last step on Bench Press landed as expected." */
export function seatLandedSentence(verdict: "aligned" | "not_aligned", noun: string, date: string): string {
  if (verdict === "aligned")
    return pickDayVariant(
      [`The last ${noun} landed as expected.`, `The last ${noun} did what it was meant to.`],
      date,
      `team_seat_landed:${noun}`
    );
  return pickDayVariant(
    [
      `The last ${noun} didn't land as expected, so it's getting a second look.`,
      `The last ${noun} fell short, so the team is taking a second look.`,
    ],
    date,
    `team_seat_landed:${noun}`
  );
}

// ---------------------------------------------------------------------------
// "Waiting for you" — addressed to the person
// ---------------------------------------------------------------------------

// A directive written for the TEAM or a clinician, not to the athlete: it names a
// clinician, tells someone to "surface" a result, or carries the clinician's register
// (athleteRegister: a named doctor, "patient", "facilitate …"). A sentence that merely
// says "the athlete" is the team's shorthand, not a clinician's note, so it is not
// moved by that alone. The person reads one plain line about the marker instead.
const CLINICIAN_ADDRESSED =
  /\b(clinician|physician|provider)s?\b|\bsurface (?:the|this|it)\b|\blet (?:the|your) doctor\b/i;

export function directiveForClinician(text: unknown): boolean {
  const s = String(text ?? "");
  if (CLINICIAN_ADDRESSED.test(s)) return true;
  return !athleteRegister(s.replace(/\bathletes?(?:'s?)?\b/gi, "you"));
}

/** One line for every result worth taking to a doctor, grouped: "Worth asking your doctor about your Lp(a) and rheumatoid factor results at your next visit." */
export function doctorLine(markers: string[], asOf: string): string {
  const names = [...new Set(markers.map((m) => spokenMarkerName(m)).filter(Boolean))];
  if (!names.length)
    return pickDayVariant(
      [
        "A result from your labs is worth raising with your doctor at your next visit.",
        "One lab result is worth talking through with your doctor.",
      ],
      asOf,
      "team_week_doctor"
    );
  const list = joinList(names);
  const results = names.length === 1 ? "result" : "results";
  return pickDayVariant(
    [
      `Worth asking your doctor about your ${list} ${results} at your next visit.`,
      `Your ${list} ${results} ${names.length === 1 ? "is" : "are"} worth talking through with your doctor.`,
    ],
    asOf,
    "team_week_doctor"
  );
}

/**
 * A directive or held change as a line addressed to the athlete: a caution keeps its own
 * words (never softened), and anything that still breaks the reading grammar falls back to
 * the plain kind line. Clinician-addressed directives never reach here (doctorLine).
 */
export function spokenFlagText(text: unknown, fallback: string, max = 200): string {
  const raw = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return athleteLine(raw, max) ?? fallback;
}

// ---------------------------------------------------------------------------
// "What we're watching" — attention reasons, spoken
// ---------------------------------------------------------------------------

const PLATEAU = /^(.+?) is plateaued(?: ~(\d+) wk)?; re-test or rotate only after a useful training response\.?$/i;
const DRIFTING = /^(.+?) is drifting down; .*$/i;
const PROGRESSING = /^(.+?) is progressing cleanly\b.*$/i;
const MARKER_STATUS = /^([^;]{1,160}?) is (?:outside its optimal\/lab range|under an active follow-up lever);\s*/i;
const SCHEDULED_RECHECK = /^You scheduled an? (.+?) recheck from a directive\b.*$/i;

export interface WatchEntryInput {
  signal_key: string;
  reason: string;
  source: string;
}

/**
 * An attention entry's reason, spoken. `changeNoun` resolves a change-check note's
 * decision (`…:change-check:d<id>`) to the thing it changed. Null when the reason is in
 * the machine register and no spoken form exists — a line the person cannot read is
 * dropped rather than shown.
 */
export function spokenWatchReason(
  entry: WatchEntryInput,
  asOf: string,
  changeNoun: (decisionId: number) => string | null
): string | null {
  const reason = String(entry.reason ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const key = `team_week_watch:${entry.signal_key}`;
  const check = /:change-check:d(\d+)$/.exec(entry.signal_key);
  if (check) {
    const named = changeNoun(Number(check[1]));
    // No structured subject to name: the note's own sentence stands when it is already
    // written for a person ("Bench moves up one small step — that change hasn't …"),
    // never when it opens on a ledger label.
    if (!named && reason && !LEDGER_LABEL.test(reason) && !violatesReadingGrammar(reason)) return reason;
    const noun = named ?? "last change";
    return pickDayVariant(
      [
        `The ${noun} hasn't shown up the way the team expected, so it's worth a second look.`,
        `The ${noun} hasn't paid off yet, so it's getting a second look.`,
      ],
      asOf,
      key
    );
  }
  let m = PLATEAU.exec(reason);
  if (m) {
    const span = m[2] ? `about ${numberWord(Number(m[2]))} ${Number(m[2]) === 1 ? "week" : "weeks"}` : "a while";
    return pickDayVariant(
      [
        `${m[1]} has held steady for ${span}; it gets a re-test or a fresh variation once training gives a clear answer.`,
        `${m[1]} has been flat for ${span}, so the team will re-test or rotate it when training says the time is right.`,
      ],
      asOf,
      key
    );
  }
  m = DRIFTING.exec(reason);
  if (m) return `${m[1]} has slipped a little; the next check is about confirming the rebuild, not a max.`;
  m = PROGRESSING.exec(reason);
  if (m) return `${m[1]} is progressing cleanly, so it needs no fixed re-test.`;
  m = MARKER_STATUS.exec(reason);
  if (m) {
    const name = spokenMarkerName(m[1]);
    const policy = sentence(capitalize(reason.replace(MARKER_STATUS, "")));
    return pickDayVariant(
      [
        `Your ${name} is due a recheck.${policy ? ` ${policy}` : ""}`,
        `A recheck on ${name} is coming up.${policy ? ` ${policy}` : ""}`,
      ],
      asOf,
      key
    );
  }
  m = SCHEDULED_RECHECK.exec(reason);
  if (m) {
    const name = spokenMarkerName(m[1]);
    return pickDayVariant(
      [
        `Your ${name} recheck comes back around once it has had time to show a change.`,
        `The ${name} recheck you set comes up after the window it needs.`,
      ],
      asOf,
      key
    );
  }
  let s = reason.replace(/^[a-z][a-z\s-]{0,40}follow-up\s*:\s*/i, "");
  s = s.replace(/\s*\([^)]*\)\s*\.?\s*$/g, "").trim();
  s = s.replace(/[.\s]+$/, "");
  if (!s || violatesReadingGrammar(s)) return null;
  return capitalize(s);
}

// ---------------------------------------------------------------------------
// The lead — a sentence, not a count wall
// ---------------------------------------------------------------------------

export interface LeadInput {
  asOf: string;
  topSeat: { seat: TeamSeatKey; role: string; did: string } | null;
  reviewAsks: number; // held changes waiting on the athlete's yes
  doctorNote: boolean; // a lab result grouped for the athlete and their doctor
  suggestions: number; // other lab suggestions in the list
  watching: number;
  landed: number;
}

/**
 * The week in a sentence or two: who led it and what they did, then the ONE thing that
 * needs the athlete, if any. Calm by default; "" on a genuinely empty week.
 */
export function composeTeamLead(input: LeadInput): string {
  const parts: string[] = [];
  if (input.topSeat) {
    parts.push(
      pickDayVariant(
        [`${input.topSeat.role} led the week.`, `Most of this week's work sat with ${input.topSeat.role}.`],
        input.asOf,
        "team_week_lead_seat"
      )
    );
    parts.push(sentence(input.topSeat.did));
  }
  if (input.reviewAsks > 0) {
    parts.push(
      input.reviewAsks === 1
        ? pickDayVariant(
            ["One change is waiting on your yes.", "One call is waiting on you."],
            input.asOf,
            "team_week_lead_ask"
          )
        : pickDayVariant(
            ["A couple of changes are waiting on your yes.", "A few calls are waiting on you."],
            input.asOf,
            "team_week_lead_ask"
          )
    );
  } else if (input.doctorNote) {
    parts.push(
      pickDayVariant(
        ["One lab result is worth raising with your doctor.", "Your labs left one thing for you and your doctor."],
        input.asOf,
        "team_week_lead_doctor"
      )
    );
  } else if (!input.topSeat && input.suggestions > 0) {
    parts.push("A quiet week for changes; your labs left a few suggestions below.");
  } else if (input.topSeat && input.suggestions === 0) {
    parts.push(
      pickDayVariant(["Nothing needs you.", "Nothing is waiting on you."], input.asOf, "team_week_lead_quiet")
    );
  }
  if (!parts.length) {
    if (input.watching > 0)
      return pickDayVariant(
        [
          "A quiet week: the team is watching how recent changes land.",
          "Nothing changed this week; the team is watching how earlier changes settle.",
        ],
        input.asOf,
        "team_week_lead_watch"
      );
    if (input.landed > 0) return "A quiet week: the team checked how earlier calls landed.";
    return "";
  }
  return parts.join(" ");
}
