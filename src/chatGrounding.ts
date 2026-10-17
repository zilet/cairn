// Grounded replies — the last word on a chat turn's prose before it is stored.
//
// The reconcilers in chat-reconcile.ts each police ONE write family (a plan_update, a
// run, a goal the gate dropped, a structure hand-off, a revert, the running total
// after a food log). What slipped between them, read off four months of real replies,
// was the CLAIM nobody owned: "I've decoupled that easy run and moved it over to your
// Pull day", "Added it to today as a lighter Push session", "putting this on your
// timeline — Rome, then Belgrade", "Got it — 154 lb, no rush" — each over a turn that
// applied nothing at all. The athlete walked away believing a change that never
// happened; the next turn had to retract it.
//
// So this module reads the model's own sentences once, after every action has been
// applied and every reconciler has spoken, and holds each state-change CLAIM to the
// server's record of what landed:
//   - a claim with a matching applied action stays, untouched;
//   - a claim with none is replaced by a calm, honest sentence (a rotating variant set,
//     never one literal) saying it has not happened yet and offering to do it;
//   - a suggestion, an offer, a question or a future "I'll" is never judged at all;
//   - a sentence the server itself wrote (a receipt) is never judged — only sentences
//     present in the model's original reply are.
// It never invents an action: an honest sentence is the whole remedy.
//
// The same pass is the backstop for a stated day figure on a turn that logged no food
// (reconcileChatIntakeReply owns the turns that did): "you're at roughly 1,090 kcal so
// far" over a day that stands at 596 drops the sentence and appends the server's own.
import {
  ACTIVITY_NOT_LOGGED_VARIANTS,
  GOAL_NONE_SAVED_VARIANTS,
  GOAL_NOT_SAVED_VARIANTS,
  PLAN_NO_CHANGE_APPENDED_VARIANTS,
  STRENGTH_OBJECTIVE_NONE_SAVED_VARIANTS,
  STRENGTH_OBJECTIVE_NOT_SAVED_VARIANTS,
} from "./chat-reconcile.js";
import { pickDayVariant } from "./repo/brain/day-read-rules.js";
import { getDayIntake } from "./repo/nutrition.js";
import { localDateISO } from "./repo/shared.js";

export type ClaimClass = "plan" | "timeline" | "goal" | "food" | "log" | "memory";

// `type` is a plain string so a capture action this module does not know by name yet
// (another stream's add_session_note) still grounds by the tables below.
type AppliedEntry = { type: string; result?: unknown; error?: string };

export type StateClaim = {
  sentence: string;
  classes: ClaimClass[];
  /** The goal figure the sentence acknowledges ("154 lb"), when it names one. */
  goal: string | null;
};

export type GroundingNote =
  | { kind: "claim"; class: ClaimClass; sentence: string }
  | { kind: "intake"; sentence: string; server_kcal: number };

export type GroundReplyContext = {
  /** The athlete's message this turn (anchors a goal acknowledgement to their number). */
  message?: string | null;
  /** The model's reply before any reconciler touched it; only its sentences are judged. */
  proposedReply?: string | null;
  drafts?: readonly unknown[];
  droppedGoalFields?: readonly string[];
  appliedGoalPatch?: Record<string, unknown> | null;
  today?: string;
  /** Test seam: the day's intake as the server reads it (repo getDayIntake). */
  readDay?: (date: string) => any;
};

// ── the honest sentences ─────────────────────────────────────────────────────
// Athlete voice: no engineering words, no gate language, no blame. Each states the
// FACT that survives rotation (nothing has moved / is logged / is saved yet) and offers
// to do it. A log, meal or timeline claim may sit over something already on the record
// (a watch-synced run, a trip added last week), so those say "not from this" and offer
// only if it is missing, never inviting a duplicate. Index 0 is the canonical phrasing;
// keys are per class so sets never rotate in lockstep.
export const PLAN_CLAIM_UNGROUNDED_VARIANTS = [
  "I haven't changed your plan yet — that was me talking it through, and your sessions are as they were. Say the word and I'll make that change.",
  "To be straight with you, nothing on your plan has moved yet. If you want that change, ask and I'll make it.",
  "That change isn't on your plan yet, so your week is as it was. Tell me to go ahead and I'll put it through.",
  "Your plan is unchanged for now — I described that change but haven't made it. Say so and I'll make it.",
] as const;

export const TIMELINE_CLAIM_UNGROUNDED_VARIANTS = [
  "I haven't added that to your timeline from this — if it isn't there yet, say the word and I'll add it.",
  "Nothing went on your timeline from this message; if it's missing, ask and I'll add it.",
  "To be straight with you, I didn't put that on your timeline. If it isn't there already, tell me and I'll add it.",
  "That wasn't added to your timeline here — if you don't see it there, say so and I'll put it on.",
] as const;

export const FOOD_CLAIM_UNGROUNDED_VARIANTS = [
  "Your food log didn't change from this — if that meal is missing or needs fixing, tell me and I'll do it.",
  "Nothing in your food log changed from this message. If the meal is missing or off, say the word and I'll add or fix it.",
  "To be straight with you, your food log is as it was. If that meal needs adding or fixing, ask and I'll do it.",
  "I haven't touched your food log from this; tell me if that meal needs adding or fixing and I'll do it.",
] as const;

export const LOG_CLAIM_UNGROUNDED_VARIANTS = [
  "I didn't log anything from that myself — if it isn't on your record, say so and I'll add it.",
  "Nothing new was logged from this message; if it's missing from your record, tell me and I'll add it.",
  "To be straight with you, I haven't logged that here. If it isn't already on your record, ask and I'll add it.",
  "That wasn't logged from this message — if you don't see it on your record, say the word and I'll add it.",
] as const;

export const MEMORY_CLAIM_UNGROUNDED_VARIANTS = [
  "I haven't kept a note of that yet — say so and I'll remember it.",
  "That isn't saved to what I remember about you yet; ask and I'll keep it.",
  "To be straight with you, I haven't stored that yet. Tell me and I'll keep a note of it.",
  "Nothing from that is in my notes yet — say the word and I'll add it.",
] as const;

// A goal is identity: it always waits on the athlete's own word (Amendment 1). So the
// honest sentence says what is proposed AND the exact words that save it — a phrasing
// the goal gate reads as explicit, so their reply really does stick.
export const GOAL_CLAIM_UNGROUNDED_VARIANTS: ReadonlyArray<(goal: string | null) => string> = [
  (goal) =>
    goal
      ? `${goal} isn't saved as your goal yet — the one on file is unchanged. If that's the one, say "set my goal to ${goal}" and I'll save it.`
      : `Your goal on file hasn't changed yet. If you want a new one, say "set my goal to <weight> by <date>" and I'll save it.`,
  (goal) =>
    goal
      ? `Just so it's clear: your goal on file hasn't changed, and ${goal} is waiting on your word. Say "set my goal to ${goal}" and it will stick.`
      : `Just so it's clear: your goal on file hasn't changed. Say "set my goal to <weight> by <date>" and it will stick.`,
  (goal) =>
    goal
      ? `${goal} is a proposal for now, not your saved goal. Tell me "set my goal to ${goal}" when you're sure and I'll save it.`
      : `That's a proposal for now, not your saved goal. Tell me "set my goal to <weight> by <date>" when you're sure and I'll save it.`,
  (goal) =>
    goal
      ? `Your goal on file is unchanged — ${goal} is waiting on your yes. Say "set my goal to ${goal}" and I'll save it.`
      : `Your goal on file is unchanged and waiting on your yes. Say "set my goal to <weight> by <date>" and I'll save it.`,
];

const INTAKE_SERVER_LINE_VARIANTS: ReadonlyArray<(t: string) => string> = [
  (t) => `Counting what's logged, today stands at ${t}.`,
  (t) => `For the record, what's logged today comes to ${t}.`,
];

const INTAKE_NOTHING_LOGGED_VARIANTS = [
  "For the record, nothing is logged for today yet.",
  "Counting what's logged, today is still empty.",
] as const;

// ── claim detection ──────────────────────────────────────────────────────────
// Every pattern is an ASSERTION: a first-person perfect/past ("I've moved", "I moved"),
// a first-person progressive ("I'm putting"), a sentence-initial past participle after
// an optional acknowledgement ("Added it to today…", "Got it — logged."), or a passive
// that says it just happened ("has been moved", "is now saved"). An offer ("I can move
// it"), a conditional ("I'd move it"), a future promise ("I'll add it") and a negation
// ("I haven't moved it") share the verbs but never these shapes.
const MOD = String.raw`(?:(?:now|also|already|just|gone\s+ahead\s+and|went\s+ahead\s+and)\s+)*`;
const I_PERFECT = String.raw`\bi(?:['’]ve|\s+have)?\s+${MOD}`;
const I_PROGRESSIVE = String.raw`\bi(?:['’]m|\s+am)\s+${MOD}`;
const LEAD = String.raw`^[\s*_>"'“(\-–—•]*(?:(?:got\s+it|done|ok(?:ay)?|sure|great|perfect|all\s+set|noted|nice|deal|right|good\s+call)\b[\s,.!:;\-–—]*)?`;

// A device did it ("has been recorded on Garmin", "synced from your watch"): a fact about
// the athlete's data, never a claim that the coach wrote something.
const NOT_DEVICE = String.raw`(?![^.!?\n]{0,25}\b(?:garmin|watch|apple\s+health|strava|wearable)\b)`;
// A sentence-initial participle that ends in a colon is a LABEL over a list ("**Updated
// Push session:**"), not a claim.
const NOT_LABEL = String.raw`(?![^\n]*:\s*[*_]*\s*$)`;
// A sentence-initial participle with no "I" in front is only a claim when what follows
// it is something the coach could have changed: "Added it to today…", "Logged your
// lunch", "Moved your run to Thursday". Without that object the opener usually describes
// the ATHLETE's own work — "Moved well today", "Pushed through all five sets", "Swapped
// to dumbbells since the bench was taken" — and a false rewrite of a true reply is worse
// than a missed claim. Naming the record it went into ("Added your coffee to the diary")
// is such an object too.
const LEAD_OBJECT = String.raw`(?:(?:\s+(?:over|up|back|in|out|down))?\s+(?:it|that|this|them|(?:your|the|today['’]s|tomorrow['’]s|this\s+week['’]s)\s+(?:[\w'’-]+\s+){0,3}?(?:plans?|program(?:me)?|sessions?|workouts?|schedule|week|runs?|rides?|entry|entries|log|goal|timeline|target|split|day|breakfast|lunch|dinner|snacks?|meals?|food|notes?|record|sets?|lifts?|weight|weigh-in|effort|check-in))\b|\s+(?:[\w'’-]+\s+){1,4}?(?:to|in|into|onto)\s+(?:your\s+|the\s+|today['’]s\s+)?(?:food\s+|session\s+)?(?:log|diary|journal|record|notes|timeline)\b)`;

type VerbForms = { asserted: RegExp[]; lead: RegExp };

function verbForms(past: string, ing: string | null): VerbForms {
  const asserted = [
    new RegExp(`${I_PERFECT}(?:${past})\\b${NOT_DEVICE}`, "i"),
    new RegExp(
      String.raw`\b(?:(?:is|are)\s+now|(?:has|have|['’]s)\s+(?:now\s+)?been)\s+(?:${past})\b${NOT_DEVICE}`,
      "i"
    ),
  ];
  if (ing) asserted.push(new RegExp(`${I_PROGRESSIVE}(?:${ing})\\b${NOT_DEVICE}`, "i"));
  return { asserted, lead: new RegExp(`${LEAD}(?:${past})\\b${LEAD_OBJECT}${NOT_DEVICE}${NOT_LABEL}`, "i") };
}

const PLAN_PAST = String.raw`locked\s+in|moved|swapped|added|removed|replaced|decoupled|shifted|rescheduled|pushed|updated|changed|adjusted|dropped|lightened|trimmed|scaled\s+(?:back|down)|cut|reshuffled|rearranged|put(?!\s+together)|switched|lowered|bumped|reduced|tweaked|modified|restructured|applied|saved|edited|slotted|deloaded`;
const PLAN_ING = String.raw`moving|swapping|adding|removing|replacing|decoupling|shifting|rescheduling|pushing|updating|changing|adjusting|dropping|lightening|trimming|putting|switching|lowering|reducing|restructuring|applying|saving|slotting`;
const PLAN_NOUN =
  /\b(?:plans?|program(?:me)?|sessions?|workouts?|split|week|today|tomorrow|tonight|calendar|schedule|app|deload|runs?|ride|lifts?|exercises?|sets?|reps?|push|pull|legs|upper|lower|full[- ]body|(?:mon|tues|wednes|thurs|fri|satur|sun)day|day\s+\d)\b/i;
const PLAN_CLAIM = verbForms(PLAN_PAST, PLAN_ING);

// No bare "noted": "Noted — salmon dinner sounds great" is an acknowledgement, not a log.
const FOOD_PAST = String.raw`logged|recorded|saved|tracked|captured|added|entered|filed|stored|updated|changed|corrected|amended|fixed|swapped|removed|took(?=[^.!?\n]{0,30}\boff\b)|adjusted|bumped|made|scaled|edited|replaced|dropped`;
const FOOD_ING = String.raw`logging|recording|saving|tracking|adding|updating|changing|correcting|amending|fixing|removing|taking|adjusting`;
const FOOD_NOUN =
  /\b(?:meals?|breakfast|lunch|dinner|snacks?|food|plate|bowl|shake|smoothie|coffee|drink|serving|portion|entry|ingredients?|macros|food\s+log)\b/i;
const FOOD_CLAIM = verbForms(FOOD_PAST, FOOD_ING);

const LOG_PAST = String.raw`logged|recorded|saved|tracked|captured|entered|noted\s+down|filed|stored`;
const LOG_ING = String.raw`logging|recording|saving|tracking`;
const LOG_CLAIM = verbForms(LOG_PAST, LOG_ING);

// "I've added that to today's session notes": a note is a capture, never a plan change,
// even though it names the session.
const NOTES_NOUN = /\bnotes?\b/i;
// A sentence about the RECORD — "added it to today's log", "your food log", "the diary" —
// is a capture claim, never a plan change, even though "today" is in it.
const RECORD_DEST =
  /\b(?:to|in|into|on|onto)\s+(?:your\s+|the\s+|today['’]s\s+)?(?:food\s+)?(?:log|diary|journal|record)\b/i;
// A body-weight reading ("176 lb", "your weigh-in") is a weight log, never a plan change —
// unless the sentence is about a lift ("bumped your squat to 225 lb").
const BODYWEIGHT_REF = /\b(?:weigh-?ins?|body\s*weight|bodyweight|the\s+scale|your\s+weight|weight\s+for\s+today)\b/i;
const WEIGHT_FIGURE = /\b\d{2,3}(?:\.\d)?\s*(?:lb|lbs|pounds|kg)\b/i;
const LIFT_REF =
  /\b(?:sets?|reps?|squats?|bench|deadlifts?|press(?:es)?|rows?|curls?|lifts?|exercises?|dumbbells?|barbell|kettlebell|load|working\s+weight)\b/i;

function aboutBodyweight(text: string): boolean {
  return !LIFT_REF.test(text) && (BODYWEIGHT_REF.test(text) || WEIGHT_FIGURE.test(text));
}
const NOTE_CLAIM = verbForms(
  String.raw`added|put|noted|saved|logged|jotted|written|wrote|appended`,
  String.raw`adding|putting|noting|saving|logging|jotting|writing`
);

const TIMELINE_CLAIM =
  /\b(?:put|putting|added|adding|logged|logging|noted|noting|marked|marking|saved|saving|pinned|pinning|placed|placing|dropped|dropping)\b[^.!?\n]{0,60}?\b(?:on|to|onto|in)\s+(?:your\s+|the\s+)?timeline\b|\b(?:is|are)\s+now\s+on\s+(?:your\s+|the\s+)?timeline\b/i;

const MEMORY_CLAIM = new RegExp(
  String.raw`${I_PERFECT}(?:made\s+a\s+note|noted\s+(?:that|it|this|down)|saved\s+(?:that|it|this)\s+(?:to|in)\s+(?:memory|your\s+profile)|added\s+(?:that|it|this)\s+to\s+(?:memory|your\s+profile|my\s+notes))\b|\b(?:noted|saved)\s+(?:that\s+|it\s+)?for\s+later\b`,
  "i"
);

const GOAL_NOUN = String.raw`(?:goal|goal\s+weight|target\s+weight)`;
const GOAL_WEIGHT = String.raw`\d{2,3}(?:\.\d)?\s*(?:lb|lbs|pounds|kg)`;
const GOAL_CLAIM = [
  new RegExp(
    String.raw`${I_PERFECT}(?:set|saved|updated|changed|locked(?:\s+in)?|made)\s+(?:(?:your|the|a)\s+)?(?:new\s+)?${GOAL_NOUN}\b|${I_PERFECT}(?:set|saved|locked(?:\s+in)?|made)\b[^.!?\n]{0,20}\bas\s+(?:your\s+)?(?:new\s+)?goal\b`,
    "i"
  ),
  // "Your goal is now set" / "has been updated" — never a bare "your goal is set at 165
  // lb", which describes the goal already on file.
  new RegExp(
    String.raw`\b${GOAL_NOUN}\b[^.!?\n]{0,30}\b(?:(?:is|['’]s)\s+now|(?:has|['’]s)\s+been)\s+(?:set|saved|updated|changed|locked(?:\s+in)?|live)\b|\bnew\s+goal\s*(?:is\b|['’]s\b|:)`,
    "i"
  ),
  // "Locking in 154 lb" — the lock is a goal claim only beside a goal or a body weight.
  new RegExp(
    String.raw`\block(?:ing|ed)\s+(?:it\s+|that\s+|this\s+)?in\b[^.!?\n]{0,40}\b(?:goal|${GOAL_WEIGHT})|\b(?:goal|${GOAL_WEIGHT})\b[^.!?\n]{0,40}\block(?:ing|ed)\s+(?:it\s+|that\s+)?in\b`,
    "i"
  ),
  new RegExp(String.raw`\b${GOAL_WEIGHT}\s+it\s+is\b`, "i"),
];
const GOAL_FIGURE = /\b(\d{2,3}(?:\.\d)?)\s*(lb|lbs|pounds|kg)\b/i;
// "Got it — 154 lb, no rush": an acknowledgement whose first content is a body-weight
// figure. Judged only when the athlete's own message carries the same number AND reads as
// reaching for a goal, so a read-back of a weigh-in ("176 this morning") or a figure from
// DATA is never mistaken for one.
const GOAL_CUE =
  /\b(?:goal|go(?:ing)?\s+for|aim(?:ing)?|target|get(?:ting)?\s+(?:down\s+)?to|reach|abs|leaner|drop\s+to|cut\s+to|end\s+up)\b/i;
const GOAL_ACK =
  /^[\s*_>"'“(\-–—•]*(?:got\s+it|noted|perfect|great|love\s+(?:it|that)|deal|done|ok(?:ay)?|sounds\s+good|good\s+call|nice|understood)\b[\s,.!:;\-–—]*(?:so\s+)?(\d{2,3}(?:\.\d)?)\s*(?:lb|lbs|pounds|kg)\b/i;

// What governs the claim, read only from the text BEFORE it: a conditional, an offer,
// or a future promise frames everything after it as not-yet.
const NOT_YET_FRAME =
  /\b(?:if|unless|once\s+you|when\s+you|after\s+you|want\s+me\s+to|would\s+you\s+like|shall\s+i|should\s+i|can\s+i|could\s+i|i\s+can|i\s+could|i['’]d|i\s+would|i\s+might|i\s+may|would|could|might|happy\s+to|let\s+me\s+know|say\s+the\s+word|just\s+say|tell\s+me|ask\s+me|do\s+you\s+want|you\s+can|you\s+could|i['’]ll|i\s+will|going\s+to|gonna|plan\s+to|suggest|recommend)\b/i;

function firstMatchIndex(sentence: string, patterns: readonly RegExp[]): number {
  let best = -1;
  for (const re of patterns) {
    const m = re.exec(sentence);
    if (m && (best === -1 || m.index < best)) best = m.index;
  }
  return best;
}

// A claim at `index` counts only when nothing before it frames it as not-yet.
function assertedAt(sentence: string, index: number): boolean {
  return index !== -1 && !NOT_YET_FRAME.test(sentence.slice(0, index));
}

function goalFigure(sentence: string): string | null {
  const m = GOAL_FIGURE.exec(sentence);
  if (!m) return null;
  const unit = m[2].toLowerCase() === "kg" ? "kg" : "lb";
  return `${m[1]} ${unit}`;
}

// The opener repeats the athlete's own words ("Swapped to dumbbells…" after they said
// they swapped): an echo of what THEY did, never the coach's claim.
function echoesMessage(text: string, message: string | null | undefined): boolean {
  const words = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9'’\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  const head = words(text).slice(0, 3);
  if (head.length < 2) return false;
  return ` ${words(String(message ?? "")).join(" ")} `.includes(` ${head.join(" ")} `);
}

function claimAt(text: string, forms: VerbForms, message: string | null | undefined): boolean {
  if (assertedAt(text, firstMatchIndex(text, forms.asserted))) return true;
  return forms.lead.test(text) && !echoesMessage(text, message);
}

function messageCarriesNumber(message: string | null | undefined, n: string): boolean {
  return new RegExp(`(?:^|[^\\d.])${n.replace(".", "\\.")}(?![\\d])`).test(String(message ?? ""));
}

/** Which state-change claims (if any) one sentence makes. Questions are never claims. */
export function classifySentence(sentence: string, message?: string | null): StateClaim | null {
  const text = sentence.trim();
  if (!text || /\?\s*["'”)]*\s*$/.test(text)) return null;
  const classes: ClaimClass[] = [];
  let goal: string | null = null;

  if (assertedAt(text, firstMatchIndex(text, [TIMELINE_CLAIM]))) classes.push("timeline");

  const goalAt = firstMatchIndex(text, GOAL_CLAIM);
  const ack = GOAL_ACK.exec(text);
  const ackedGoal = !!ack && GOAL_CUE.test(String(message ?? "")) && messageCarriesNumber(message, ack[1]);
  if (assertedAt(text, goalAt) || ackedGoal) {
    classes.push("goal");
    goal = goalFigure(text);
  }

  const aboutRecord = NOTES_NOUN.test(text) || RECORD_DEST.test(text) || aboutBodyweight(text);
  if (FOOD_NOUN.test(text) && claimAt(text, FOOD_CLAIM, message)) classes.push("food");
  if (!aboutRecord && PLAN_NOUN.test(text) && claimAt(text, PLAN_CLAIM, message)) classes.push("plan");
  if (claimAt(text, LOG_CLAIM, message) || (aboutRecord && claimAt(text, NOTE_CLAIM, message))) classes.push("log");
  if (assertedAt(text, firstMatchIndex(text, [MEMORY_CLAIM]))) classes.push("memory");

  return classes.length ? { sentence: text, classes, goal } : null;
}

// ── splitting a reply into judgeable units ───────────────────────────────────
// Same shape as the intake reconciler: a list item, heading or table row is one unit;
// prose lines split at a sentence end after a real word (so "5.5k" and "e.g." hold).
const BLOCK_LINE = /^\s*(?:[-*•>]|\d+[.)]|#{1,6}\s|\|)/;
const SENTENCE_BREAK = /(?<=\b\w{2,}[.!?])\s+(?=[A-Z"'“(])/;

function unitsOf(line: string): string[] {
  return BLOCK_LINE.test(line) ? [line] : line.split(SENTENCE_BREAK);
}

/** Every state-change claim the reply makes, sentence by sentence. */
export function detectStateClaims(reply: string, message?: string | null): StateClaim[] {
  const claims: StateClaim[] = [];
  for (const line of String(reply ?? "").split("\n")) {
    for (const unit of unitsOf(line)) {
      const claim = classifySentence(unit, message);
      if (claim) claims.push(claim);
    }
  }
  return claims;
}

// ── what grounds a claim ─────────────────────────────────────────────────────
// Plan-shaped writes. Their presence at all — landed, scheduled, held or refused —
// means reconcileChatPlanReply / reconcileChatRunReply / the structure and drive
// reconcilers already gave the truthful receipt, so this pass stays out of their way.
const PLAN_TYPES: ReadonlySet<string> = new Set<string>([
  "plan_update",
  "plan_restructure",
  "set_run",
  "set_endurance_schedule",
  "set_strength_schedule",
  "flag_training_structure",
  "set_training_drive",
  "revert_decision",
  "set_movement_considerations",
]);
const TIMELINE_TYPES: ReadonlySet<string> = new Set<string>(["add_context_event", "resolve_context_event"]);
const FOOD_TYPES: ReadonlySet<string> = new Set<string>(["log_food", "update_food_note"]);
const MEMORY_TYPES: ReadonlySet<string> = new Set<string>(["add_memory", "update_memory", "supersede_memory"]);
// Anything that puts a fact on the record. "Logged" without a noun is satisfied by any.
const CAPTURE_TYPES: ReadonlySet<string> = new Set<string>([
  "log_activity",
  "log_set",
  "log_food",
  "update_food_note",
  "log_weight",
  "log_blood_pressure",
  "log_health",
  "log_supplement",
  "log_measurement",
  "log_checkin",
  "log_context_tag",
  "set_activity_effort",
  "report_training_symptom",
  "resolve_training_symptom",
  "add_context_event",
  "resolve_context_event",
  "add_memory",
  "update_memory",
  "supersede_memory",
  "add_session_note",
  "update_session_notes",
]);
const GOAL_TYPES: ReadonlySet<string> = new Set<string>([
  "set_endurance_goal",
  "set_training_intent",
  "set_strength_objective",
]);

// What a sentence NAMES decides which capture grounds it, whatever verb it uses: "Added
// your 4th set of squats at 225" is a set log, "Updated that run's effort to hard" a felt
// effort, "Added your 5k run from this morning" an activity log — each true when its own
// capture landed, though every one of them also reads as plan-shaped.
const SUBJECT_TYPES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/\bnotes?\b/i, ["add_session_note", "update_session_notes", "add_memory", "update_memory"]],
  [
    /\b(?:sets?|reps?|squats?|bench|deadlifts?|press(?:es)?|rows?|curls?|pull-?ups?|chin-?ups?|dips?|lunges?|lifts?)\b/i,
    ["log_set", "add_session_note"],
  ],
  [
    /\b(?:runs?|ride|walk|hike|swim|activity|cardio|\d+(?:\.\d+)?\s*k|km|miles?)\b/i,
    ["log_activity", "set_activity_effort", "add_session_note"],
  ],
  [/\b(?:effort|rpe|felt|hard|easy|brutal|tough)\b/i, ["set_activity_effort", "log_checkin"]],
  [/\b(?:weigh-?ins?|bodyweight|body\s*weight|scale)\b/i, ["log_weight", "log_measurement"]],
  [/\b(?:check-?in|energy|sleep|soreness|sore|mood)\b/i, ["log_checkin"]],
  [/\b(?:sessions?|workouts?)\b/i, ["add_session_note", "log_set"]],
  [/\b(?:blood\s+pressure|bp)\b/i, ["log_blood_pressure"]],
  [/\b(?:waist|chest|hips?|measurements?)\b/i, ["log_measurement"]],
  [/\b(?:supplements?|creatine|vitamin|omega|whey)\b/i, ["log_supplement"]],
  [/\b(?:labs?|markers?|bloodwork|panel|results)\b/i, ["log_health"]],
  [
    /\b(?:pain|ache|niggle|knee|shoulder|elbow|back|hip|ankle|wrist|symptom)\b/i,
    ["report_training_symptom", "resolve_training_symptom", "add_context_event"],
  ],
];

function subjectGrounded(sentence: string, applied: readonly AppliedEntry[]): boolean {
  const landedOf = (types: readonly string[]) => applied.some((entry) => types.includes(entry.type) && landed(entry));
  // A body-weight figure ("176 lb") names a weigh-in only when no lift is in the sentence.
  if (aboutBodyweight(sentence) && landedOf(["log_weight", "log_measurement"])) return true;
  return SUBJECT_TYPES.some(([names, types]) => names.test(sentence) && landedOf(types));
}

function landed(entry: AppliedEntry): boolean {
  if (entry.error) return false;
  const result = entry.result;
  return !(result && typeof result === "object" && (result as Record<string, unknown>).ok === false);
}

function classGrounded(cls: ClaimClass, applied: readonly AppliedEntry[], ctx: GroundReplyContext): boolean {
  const any = (types: ReadonlySet<string>, needLanded = true) =>
    applied.some((entry) => types.has(entry.type) && (!needLanded || landed(entry)));
  switch (cls) {
    case "plan":
      return any(PLAN_TYPES, false) || (ctx.drafts?.length ?? 0) > 0;
    case "timeline":
      return any(TIMELINE_TYPES);
    case "food":
      return any(FOOD_TYPES);
    case "log":
      return any(CAPTURE_TYPES);
    case "memory":
      return any(MEMORY_TYPES) || any(CAPTURE_TYPES);
    case "goal":
      return (
        (!!ctx.appliedGoalPatch && Object.keys(ctx.appliedGoalPatch).length > 0) ||
        any(GOAL_TYPES) ||
        // An acknowledged weigh-in is a log, not a goal.
        applied.some((entry) => entry.type === "log_weight" && landed(entry))
      );
  }
}

// A reconciler upstream already said the truthful thing for this class; a second
// honest sentence beside it would only repeat it.
function classAlreadySpoken(cls: ClaimClass, reply: string, ctx: GroundReplyContext): boolean {
  const has = (set: readonly string[]) => set.some((line) => reply.includes(line));
  switch (cls) {
    case "plan":
      return has(PLAN_NO_CHANGE_APPENDED_VARIANTS);
    case "goal":
      return (
        (ctx.droppedGoalFields?.length ?? 0) > 0 ||
        has(GOAL_NONE_SAVED_VARIANTS) ||
        has(GOAL_NOT_SAVED_VARIANTS) ||
        has(STRENGTH_OBJECTIVE_NONE_SAVED_VARIANTS) ||
        has(STRENGTH_OBJECTIVE_NOT_SAVED_VARIANTS)
      );
    case "log":
    case "food":
      return has(ACTIVITY_NOT_LOGGED_VARIANTS);
    default:
      return false;
  }
}

function honestSentence(cls: ClaimClass, claim: StateClaim, today: string): string {
  switch (cls) {
    case "plan":
      return pickDayVariant(PLAN_CLAIM_UNGROUNDED_VARIANTS, today, "chat-ground-plan");
    case "timeline":
      return pickDayVariant(TIMELINE_CLAIM_UNGROUNDED_VARIANTS, today, "chat-ground-timeline");
    case "food":
      return pickDayVariant(FOOD_CLAIM_UNGROUNDED_VARIANTS, today, "chat-ground-food");
    case "log":
      return pickDayVariant(LOG_CLAIM_UNGROUNDED_VARIANTS, today, "chat-ground-log");
    case "memory":
      return pickDayVariant(MEMORY_CLAIM_UNGROUNDED_VARIANTS, today, "chat-ground-memory");
    case "goal":
      return pickDayVariant(GOAL_CLAIM_UNGROUNDED_VARIANTS, today, "chat-ground-goal")(claim.goal);
  }
}

// Priority when one sentence claims several things and none landed: the most specific
// honest sentence wins.
const CLASS_ORDER: readonly ClaimClass[] = ["goal", "timeline", "food", "plan", "log", "memory"];

// ── the stated day figure, when no food was logged this turn ─────────────────
// Only a sentence that states where the day STANDS (so far, or what is left) is judged.
// "Your total" and "for the day" also introduce advice ("…and you'll hit your total"),
// so they are not cues on their own.
const INTAKE_STRONG_CUE =
  /\b(?:so\s+far|today\s+so\s+far|(?:day|daily|running)\s+total\s+(?:is|stands|sits)|(?:kcal|calories|cals|protein)\s+(?:left|remaining|to\s+go)|(?:left|remaining)\s+(?:for|to|today))\b/i;
const INTAKE_WEAK_CUE =
  /\b(?:you(?:['’]re|\s+are)\s+(?:now\s+)?(?:at|around|roughly|about|sitting\s+at)|you(?:['’]ve|\s+have)\s+(?:had|eaten|logged)|puts?\s+you\s+at)\b/i;
const INTAKE_MEAL_REF =
  /\b(?:this|that|the|your|a)\s+(?:\w+\s+){0,2}(?:meal|lunch|dinner|breakfast|snack|plate|steak|bowl|shake|serving|portion|sandwich|burger)\b/i;
// A figure about another day, a week, an average or a what-if is not today's standing.
const INTAKE_NOT_TODAY =
  /\b(?:yesterday|last\s+night|tomorrow|this\s+week|last\s+week|per\s+day|a\s+day|averag(?:e|es|ed|ing)|weekly|would|could|if|once|after\s+(?:dinner|lunch|that|this))\b/i;
// Advice and the future are not a statement of the day: "Get 40 g protein at dinner and
// you'll hit your total" names a figure the day does not (and need not) hold.
const INTAKE_ADVICE =
  /^[\s*_>"'“(\-–—•]*(?:get|have|eat|add|grab|aim|hit|try|go|save|keep|make|finish|top)\b|\b(?:you['’]ll|you\s+will|will|should|need\s+to|aim\s+for|at\s+(?:dinner|lunch|breakfast)|tonight|later\s+today|before\s+bed)\b/i;
const KCAL_FIGURE = /(\d[\d,]*(?:\.\d+)?)\s*(?:k?cals?\b|calories\b)/gi;
const PROTEIN_FIGURE = /(\d[\d,]*(?:\.\d+)?)\s*g\s*(?:of\s+)?protein\b/gi;

// ~10%: a model rounding the server's own figure ("about 1,100" for 1,064) is honest;
// one adding a meal in its head ("1,090" for 596) is not.
function within(value: number, truth: number, floor: number): boolean {
  return Math.abs(value - truth) <= Math.max(floor, Math.abs(truth) * 0.1);
}

// Each figure is judged against the ONE quantity its own cue names — never accepted
// because it happens to match a different one. "You're at roughly 2,400 kcal so far" over
// a 596 kcal day is wrong even when 2,400 is the target: "so far" names what is eaten.
type Quantity = "consumed" | "remaining" | "target";
const QUANTITY_CUES: ReadonlyArray<readonly [Quantity, RegExp]> = [
  [
    "consumed",
    /\b(?:so\s+far|you(?:['’]re|\s+are)\s+(?:now\s+)?(?:at|around|roughly|about|sitting\s+at)|you(?:['’]ve|\s+have)\s+(?:had|eaten|logged)|puts?\s+you\s+at|(?:day|daily|running)\s+total)\b/gi,
  ],
  ["remaining", /\b(?:left|remaining|to\s+go)\b/gi],
  ["target", /\b(?:target|goal|budget)\b/gi],
];
const CLAUSE_BREAK = /,\s+|;\s*|\s*[—–]\s*|\s+-\s+|\s+and\s+/gi;
// A figure that sizes a meal ("that 700 kcal steak", "a 500 kcal dinner") is about the
// plate, not the day.
const MEAL_AFTER_FIGURE =
  /^\s*(?:[a-z-]+\s+)?(?:meal|lunch|dinner|breakfast|snack|plate|steak|bowl|shake|serving|portion|sandwich|burger|salad)\b/i;

export type DayTruth = {
  kcal: number;
  protein_g: number;
  remaining_kcal: number | null;
  remaining_protein_g: number | null;
  target_kcal: number | null;
  target_protein_g: number | null;
};

type Located = { index: number; end: number };

function clauseRanges(sentence: string): Located[] {
  const ranges: Located[] = [];
  let start = 0;
  for (const m of sentence.matchAll(new RegExp(CLAUSE_BREAK.source, CLAUSE_BREAK.flags))) {
    ranges.push({ index: start, end: m.index ?? 0 });
    start = (m.index ?? 0) + m[0].length;
  }
  ranges.push({ index: start, end: sentence.length });
  return ranges;
}

function truthFor(day: DayTruth, quantity: Quantity, unit: "kcal" | "protein"): number | null {
  if (quantity === "consumed") return unit === "kcal" ? day.kcal : day.protein_g;
  if (quantity === "remaining") return unit === "kcal" ? day.remaining_kcal : day.remaining_protein_g;
  return unit === "kcal" ? day.target_kcal : day.target_protein_g;
}

/** Does this sentence state today's standing in figures the server's day contradicts? */
export function sentenceMisstatesDay(sentence: string, day: DayTruth): boolean {
  const dayCue =
    INTAKE_STRONG_CUE.test(sentence) || (INTAKE_WEAK_CUE.test(sentence) && !INTAKE_MEAL_REF.test(sentence));
  if (!dayCue || INTAKE_NOT_TODAY.test(sentence) || INTAKE_ADVICE.test(sentence)) return false;
  const cues = QUANTITY_CUES.flatMap(([quantity, re]) =>
    [...sentence.matchAll(new RegExp(re.source, re.flags))].map((m) => ({ quantity, index: m.index ?? 0 }))
  );
  const clauses = clauseRanges(sentence);
  const clauseOf = (index: number) => clauses.find((c) => index >= c.index && index <= c.end) ?? clauses[0];
  const nearest = (index: number, pool: typeof cues) =>
    pool.reduce<(typeof cues)[number] | null>(
      (best, cue) => (!best || Math.abs(cue.index - index) < Math.abs(best.index - index) ? cue : best),
      null
    );
  let judged = 0;
  let wrong = 0;
  for (const [unit, re, min, floor] of [
    ["kcal", KCAL_FIGURE, 100, 50],
    ["protein", PROTEIN_FIGURE, 20, 5],
  ] as const) {
    for (const m of sentence.matchAll(new RegExp(re.source, re.flags))) {
      const value = Number(m[1].replace(/,/g, ""));
      const at = m.index ?? 0;
      if (!Number.isFinite(value) || value < min) continue;
      if (MEAL_AFTER_FIGURE.test(sentence.slice(at + m[0].length))) continue;
      const clause = clauseOf(at);
      const own = cues.filter((cue) => cue.index >= clause.index && cue.index <= clause.end);
      if (!own.length && INTAKE_MEAL_REF.test(sentence.slice(clause.index, clause.end))) continue;
      const cue = nearest(at, own.length ? own : cues);
      if (!cue) continue;
      const truth = truthFor(day, cue.quantity, unit);
      if (truth == null) continue;
      judged++;
      if (!within(value, truth, floor)) wrong++;
    }
  }
  return judged > 0 && wrong > 0;
}

function readDayTruth(ctx: GroundReplyContext, today: string): (DayTruth & { line: string }) | null {
  let day: any;
  try {
    day = (ctx.readDay ?? ((date: string) => getDayIntake(date)))(today);
  } catch {
    return null;
  }
  const totals = day?.totals;
  if (!totals || !Number.isFinite(Number(totals.kcal))) return null;
  const entries: any[] = Array.isArray(day?.entries) ? day.entries : [];
  // A meal still waiting on its estimate makes "what's logged" a moving figure; the
  // model is not contradicted by a number the server cannot state yet.
  if (entries.some((entry) => entry?.enrichment_status === "pending")) return null;
  const num = (v: unknown) => (v != null && Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  const kcal = Math.round(Number(totals.kcal));
  const protein = Math.round(Number(totals.protein_g) || 0);
  const remainingKcal = num(day?.remaining?.kcal);
  const remainingProtein = num(day?.remaining?.protein_g);
  const targetKcal = num(day?.target?.kcal);
  const targetProtein = num(day?.target?.protein_g);
  let line: string;
  if (!entries.length && kcal === 0) {
    line = pickDayVariant(INTAKE_NOTHING_LOGGED_VARIANTS, today, "chat-ground-intake-empty");
  } else {
    const fmt = (n: number) => n.toLocaleString("en-US");
    const parts = [`${fmt(kcal)} kcal and ${protein} g protein`];
    if (remainingKcal != null && targetKcal != null) {
      const left = [`${fmt(Math.max(0, remainingKcal))} kcal`];
      if (remainingProtein != null) left.push(`${Math.max(0, remainingProtein)} g protein`);
      parts.push(`about ${left.join(" and ")} left of ${fmt(targetKcal)}`);
    }
    line = pickDayVariant(INTAKE_SERVER_LINE_VARIANTS, today, "chat-ground-intake")(parts.join(", "));
  }
  return {
    kcal,
    protein_g: protein,
    remaining_kcal: remainingKcal,
    remaining_protein_g: remainingProtein,
    target_kcal: targetKcal,
    target_protein_g: targetProtein,
    line,
  };
}

// ── a sentence with more than one claim ───────────────────────────────────────
const CLAIM_CLAUSE_BREAK = /(?:,\s+|;\s*|\s*[—–]\s*|\s+-\s+)(?:and\s+)?|\s+and\s+/i;

function splitClaims(
  unit: string,
  message: string | null | undefined
): Array<{ text: string; claim: StateClaim | null }> {
  return unit
    .trim()
    .split(CLAIM_CLAUSE_BREAK)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => ({ text, claim: classifySentence(text, message) }));
}

// The grounded clauses, rejoined as one plain sentence.
function joinClauses(clauses: readonly string[]): string {
  if (!clauses.length) return "";
  const body = clauses
    .map((c) => c.replace(/[.!;:,]+$/, ""))
    .join(", ")
    .trim();
  return body ? `${body.charAt(0).toUpperCase()}${body.slice(1)}.` : "";
}

// ── the pass ─────────────────────────────────────────────────────────────────
const RECEIPT_JOIN = "\n\n";

export function groundReply(input: { reply: string; applied: readonly AppliedEntry[]; ctx?: GroundReplyContext }): {
  reply: string;
  notes: GroundingNote[];
} {
  const reply = String(input.reply ?? "");
  const applied = input.applied ?? [];
  const ctx = input.ctx ?? {};
  const today = ctx.today ?? localDateISO();
  const proposed = ctx.proposedReply == null ? null : String(ctx.proposedReply);
  const notes: GroundingNote[] = [];
  // Only the model's own words are judged; a receipt a reconciler wrote is the server's.
  const modelAuthored = (unit: string) => proposed == null || proposed.includes(unit.trim());

  // The intake backstop runs only where the food reconciler did not: no food landed.
  const foodLanded = applied.some((entry) => FOOD_TYPES.has(entry.type) && !entry.error);
  let dayTruth: ReturnType<typeof readDayTruth> | undefined;
  const truth = () => {
    if (dayTruth === undefined) dayTruth = foodLanded ? null : readDayTruth(ctx, today);
    return dayTruth;
  };
  const mentionsFigures = /\d[\d,]*\s*(?:k?cals?\b|calories\b|g\s*(?:of\s+)?protein\b)/i.test(reply);

  // Within ONE clause the classes are readings of a single claim ("Logged your lunch" is
  // both a food and a log claim), so any landed reading — or a landed capture of what the
  // clause names — grounds it.
  const claimGrounded = (c: StateClaim, text: string) =>
    c.classes.some((cls) => classGrounded(cls, applied, ctx)) || subjectGrounded(text, applied);
  const corrected = new Set<ClaimClass>();
  let intakeDropped = false;
  let changed = false;
  const lines = reply.split("\n").map((line) => {
    if (!line.trim()) return line;
    const kept: string[] = [];
    let touched = false;
    for (const unit of unitsOf(line)) {
      if (!modelAuthored(unit)) {
        kept.push(unit);
        continue;
      }
      const claim = classifySentence(unit, ctx.message);
      // Two or more separable claims in one sentence are judged clause by clause: the
      // grounded one stays word for word, the ungrounded one gets its honest sentence.
      // "I've updated today's session and logged your lunch" over a lone log_food keeps
      // "Logged your lunch." and says the plan has not changed.
      const split = claim ? splitClaims(unit, ctx.message) : null;
      if (split && split.filter((c) => c.claim).length >= 2) {
        const judged = split.map((c) => ({ ...c, grounded: !c.claim || claimGrounded(c.claim, c.text) }));
        if (judged.some((c) => !c.grounded)) {
          const keptClauses: string[] = [];
          const honest: string[] = [];
          let lastClaimGrounded = true;
          for (const c of judged) {
            if (!c.claim) {
              // A clause with no claim of its own rides with the claim before it.
              if (lastClaimGrounded) keptClauses.push(c.text);
              continue;
            }
            const cls = c.grounded
              ? undefined
              : CLASS_ORDER.find(
                  (candidate) => c.claim?.classes.includes(candidate) && !classAlreadySpoken(candidate, reply, ctx)
                );
            lastClaimGrounded = c.grounded || !cls;
            if (!cls || !c.claim) {
              keptClauses.push(c.text);
              continue;
            }
            notes.push({ kind: "claim", class: cls, sentence: c.claim.sentence });
            if (!corrected.has(cls)) {
              corrected.add(cls);
              honest.push(honestSentence(cls, c.claim, today));
            }
          }
          if (honest.length || keptClauses.length < judged.length) {
            touched = true;
            const head = joinClauses(keptClauses);
            kept.push(...[head, ...honest].filter(Boolean));
            continue;
          }
        }
      } else if (claim && !claimGrounded(claim, claim.sentence)) {
        const cls = CLASS_ORDER.find(
          (candidate) => claim.classes.includes(candidate) && !classAlreadySpoken(candidate, reply, ctx)
        );
        if (cls) {
          notes.push({ kind: "claim", class: cls, sentence: claim.sentence });
          touched = true;
          // One honest sentence per class; a second false claim of the same class goes.
          if (!corrected.has(cls)) {
            corrected.add(cls);
            kept.push(honestSentence(cls, claim, today));
          }
          continue;
        }
      }
      if (mentionsFigures && !foodLanded) {
        const day = truth();
        if (day && sentenceMisstatesDay(unit, day)) {
          notes.push({ kind: "intake", sentence: unit.trim(), server_kcal: day.kcal });
          intakeDropped = true;
          touched = true;
          continue;
        }
      }
      kept.push(unit);
    }
    if (!touched) return line;
    changed = true;
    return kept.length ? kept.join(" ") : null;
  });
  if (!changed) return { reply, notes };
  let out = lines
    .filter((line): line is string => line !== null)
    .join("\n")
    .replace(/\n{3,}/g, RECEIPT_JOIN)
    .trim();
  const day = intakeDropped ? truth() : null;
  if (day) out = out ? `${out}${RECEIPT_JOIN}${day.line}` : day.line;
  return { reply: out, notes };
}
