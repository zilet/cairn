// Day intelligence — the Brief's deterministic core: dayRead() (the calm train/
// easy/rest/done read), the forward look + week-ahead floor, the persisted
// day-read cache, and the effortless-capture frequents list. The agentic sentence
// layer wraps this in src/dayread.ts; this is the floor + the structured truth.
//
// Split out of the former intelligence.ts monolith (K4). Plan-day selection lives
// in plan-selection.ts; adaptive nutrition in expenditure.ts.
import { createHash } from "node:crypto";
import { db } from "../db.js";
import { scheduleDayReadRefresh } from "../dayread-refresh.js";
import { brainSignal, invalidateBrainSnapshot } from "../brain/snapshot.js";
import {
  pickDayVariant,
  resolveDayReadRule,
  UNPROGRAMMED_EASY_DAY,
  type DayReadRule,
  type DayReadRuleOutcome,
} from "./brain/day-read-rules.js";
import {
  type EasyOutcomeFeedbackSignal,
  easyOverrideSoftening,
  type EasyOverrideSoftening,
  OUTCOME_SOFTENING_WINDOW_DAYS,
  type OutcomeFeedbackSignal,
  readAdherenceModel,
  recordDayReadDecision,
  reopenDayReadAdherence,
  restOverrideSoftening,
  type RestOverrideSoftening,
} from "./brain/read-adherence.js";
import { getCheckinByDate, getRecoverySummary, latestSleep, trainingSignals } from "./coach.js";
import { activeContextEffect } from "./context-effect.js";
import { activitySportWhere, RUN_SPORT_PATTERNS } from "./endurance-sports.js";
import { estimateExpenditure } from "./expenditure.js";
import { flexibleTrainingAgenda } from "./flexible-training-agenda.js";
import { planningContextEvents } from "./health.js";
import { plainGroupWords } from "./exercise-canon.js";
import { suppressSaturatedDue } from "./hybrid-load.js";
import { SENSOR_MAX_AGE_DAYS, sensorAgeDays, sensorIsCurrent } from "./sensor-freshness.js";
import { getRecentSessions } from "./sessions.js";
import { getSettings } from "./settings.js";
import { getActiveBlock } from "./program-blocks.js";
import { activeRecoveryWeekLedger, RECOVERY_WEEK_ACTIVE_DAYS } from "./recovery-week-ledger.js";
import {
  nextCandidateAfter,
  planDayCandidates,
  planDayFocus,
  resolveSessionPlanDay,
  selectAdaptivePlanDay,
} from "./plan-selection.js";
import { activeRecoveryWeek, getPrimaryDiscipline } from "./profile.js";
import { getProgramState } from "./program-state.js";
import { runIntensityDiscipline } from "./run-progression.js";
import { programBalance } from "./progression.js";
import { addDaysISO, daysBetweenISO, localDateISO } from "./shared.js";
import { getTrainingIntent } from "./training-intent.js";
import {
  hasFreshBrake,
  lifeCapacityIsCommitment,
  planningSignalState,
  signalVoice,
  spokenSignalVoice,
  SIGNAL_VOICE_KEYS,
  SIGNAL_VOICE_REGISTRY,
  tomorrowHolds,
  type SignalDimension,
  type TomorrowHold,
  type SignalVoiceRef,
  type UnifiedSignalState,
} from "./signal-state.js";
import {
  dominantSensorCadenceEntry,
  isWorkingEpisodicPattern,
  wearAbsenceRowState,
  wearAbsenceView,
  wearAbsenceWhy,
} from "./wear-pattern-voice.js";
import { afterSqliteCommit } from "./sqlite-savepoint.js";
import {
  type TrainingLoad,
  dayLoad,
  hardCardioDay,
  hybridDayContext,
  recentCardioLoadMedian,
  recoverySessionDose,
} from "./training-read.js";
import { withFlexibleRunLookahead } from "./hybrid-run-lookahead.js";
import { dayFuelState } from "./fuel-state.js";
import { currentUnderfuelingRead } from "./underfueling-snapshot.js";
import type { UnderfuelingRead } from "./underfueling.js";

// ---------- T1: day intelligence ----------
export interface DayRead {
  kind: "train" | "easy" | "rest" | "done"; // 'done' = a real, loading session is already logged today
  focus: string | null; // e.g. "Lower body" on a train day
  why: string; // one plain-language sentence
  est_minutes: number | null;
  signals: Record<string, any>; // the deterministic inputs behind the call
  decision?: DayReadDecision;
  input_fingerprint?: string;
  computed_at?: string;
}

export interface DayReadDecisionEvidence {
  label: string;
  value: string;
  date?: string;
}

export interface DayReadDecision {
  rule_code: string;
  basis: "deterministic" | "agent" | "server_policy";
  baseline_kind: DayRead["kind"];
  reason: string;
  evidence: DayReadDecisionEvidence[];
  computed_at: string;
}

// ---------- the reading grammar, in ONE place ----------
// VISION.md Amendment 2, as a predicate rather than a habit: plain language, no
// device/clinical jargon, no score, and a suggestion rather than a gate.
//
// This used to exist in three unconnected forms — the prompt's prose instructions
// (src/prompt/day.ts), the guards in test/dayRead.test.js over the deterministic
// vocabulary, and NOTHING AT ALL over the agent's sentence. So the constitution was
// enforced on the layer that cannot violate it and withheld from the layer that can,
// and the agent's headline + `why` — what the athlete reads on most mornings — went
// to the Brief unchecked. `{headline:"Readiness 38/100 — rest.", why:"…you must not
// train today."}` validated and rendered verbatim.
//
// One definition now, held by BOTH registers: the vocabulary tests run the whole
// deterministic set through it, and isValidDayReadAgentResult runs the agent's
// headline and `why` through it. Deliberately the SAME four rules the deterministic
// vocabulary already passes and no more — a stricter grammar here would start
// rejecting good prose, and every registered phrasing is the proof set (the
// zero-false-positive case in test/dayRead.test.js is what pins that).
export const DAY_READ_GRAMMAR_RULES: ReadonlyArray<{ rule: string; pattern: RegExp }> = [
  // Internals leaking as coaching.
  {
    rule: "engineering_prose",
    pattern: /_|deterministic|posture|baseline|policy|fingerprint|directive|override|boundary/i,
  },
  // Clinical/device vocabulary that actually leaked once. Phrase-level, so a
  // colloquial "nothing acute" in a legitimate phrasing is not caught.
  { rule: "device_jargon", pattern: /\bacute warning\b|\breadiness signal\b/i },
  // No scores, no grades, no metric wall. The word boundary sits INSIDE each branch:
  // a single trailing `\b` after the group never fired for the "%" branch (a percent
  // sign followed by a space is two non-word characters, so there is no boundary
  // between them), which let "you scored 42% on recovery" through the one rule whose
  // whole job is to catch it.
  //
  // The "%" branch alone used to fire on ANY digit+percent, so a genuinely factual
  // percentage of a real, named quantity — "you're at 80% of your protein target" —
  // read as a violation right alongside an actual grade — "Readiness 38%.",
  // "you scored 42% on recovery". The two are told apart by what follows the
  // number: "N% of <thing>" names the real quantity it is a fraction of (a
  // measured intake/adherence/dose against a target), so a negative lookahead
  // excuses ONLY that shape. A bare or dangling percentage — nothing after it, or
  // anything other than "of" — still reads as a grade and stays caught, same as
  // "/100", "N points" and "N score(s)" always have.
  { rule: "score", pattern: /\b\d{1,3}\s*(?:\/\s*100\b|%(?!\s+of\b)|points?\b|scores?\b)/i },
  // A suggestion, never a gate.
  { rule: "gate", pattern: /\byou must\b|\bdo not train\b|\bforbidden\b/i },
];

// The name of the first rule `text` breaks, or null when it holds the line. Empty
// text is vacuously fine — absence is the caller's contract to enforce, not this one's.
export function violatesReadingGrammar(text: unknown): string | null {
  const sentence = String(text ?? "");
  if (!sentence.trim()) return null;
  for (const { rule, pattern } of DAY_READ_GRAMMAR_RULES) if (pattern.test(sentence)) return rule;
  return null;
}

// Every rule outcome the deterministic floor can report: the STABLE code that
// keys the accountability ledger, and the athlete-facing sentence right beside
// it, so the words can never drift away from the rule that says them (see the
// contract note in brain/day-read-rules.ts). Exported so the vocabulary is
// enumerable — there is no way for a rule to reach the athlete without words.
export const DAY_READ_OUTCOMES = {
  logged_loading_work_today: {
    code: "logged_loading_work_today",
    reasons: [
      "You've already got real training in today.",
      "Today's work is already done and logged.",
      "The session's in — today is covered.",
    ],
  },
  acute_sleep_corroborated: {
    code: "acute_sleep_corroborated",
    reasons: [
      "Last night was short, and your sleep has been running short for a while now.",
      "A short night on top of a stretch of short nights.",
      "Sleep came up short again last night, the way it has for a while.",
      "Last night was thin, and it isn't a one-off right now.",
    ],
  },
  acute_signal_protection: {
    code: "acute_signal_protection",
    reasons: [
      "Today's signals point to protecting your recovery rather than pushing.",
      "What you're showing today asks for protection more than effort.",
      "Today reads like a day to look after recovery first.",
      "The signals today lean toward guarding recovery.",
    ],
  },
  recovery_dose_overrun: {
    code: "recovery_dose_overrun",
    reasons: [
      "Yesterday went well past the lighter dose this recovery week is built around.",
      "Yesterday ran a long way past what this reduced week asks for.",
      "This week is meant to be light, and yesterday was not.",
    ],
  },
  accumulated_load_rest: {
    code: "accumulated_load_rest",
    reasons: [
      "You've stacked several loading days in a row without a break.",
      "Several real training days back to back, with nothing in between.",
      "That's a run of hard days now, uninterrupted.",
      "You've been loading day after day without a gap.",
    ],
  },
  // The accumulated-load rest, answered by the athlete's own standing preference.
  // It is NOT a second opinion about the same evidence: every safety input that
  // produces a rest still produces one, and this rule only ever fires on the ONE
  // shape of rest that is about rhythm rather than about a signal — stacked loading
  // days with nothing else pulling the other way. The preference sets the posture;
  // the evidence still decides the day (see the rule in dayRead for the whole gate).
  push_drive_targeted_training: {
    code: "push_drive_targeted_training",
    reasons: [
      "You've asked to keep training when recovery reads well, and there's real work due.",
      "Recovery reads clear, and some muscle groups are genuinely due.",
      "The days have stacked up, but nothing is pulling the other way and work is still due.",
      "You'd rather train than take the day off, and there's due work worth doing.",
    ],
  },
  // The accumulated-load rest, RE-TIMED rather than answered. Same family as the push
  // drive above and the same one shape of rest — stacked loading days, nothing else
  // pulling the other way — but the reason is the calendar rather than a preference:
  // tomorrow is already claimed by a trip or a commitment, so the discretionary break
  // is better taken then. The athlete still gets their break; the read only moves which
  // day it lands on, and only ever offers EASY work in exchange.
  lookahead_retimed_training: {
    code: "lookahead_retimed_training",
    reasons: [
      "Tomorrow is already committed, so the quiet day is better taken then.",
      "The break still comes — tomorrow is spoken for, so it lands there instead of here.",
      "There's something on tomorrow, which makes it the natural day to sit out.",
      "Tomorrow already has a claim on it, so today holds the easy movement instead.",
    ],
  },
  low_readiness_rest: {
    code: "low_readiness_rest",
    reasons: [
      "This morning's readiness reading came in low.",
      "Today's readiness reading is on the low side.",
      "Your watch read this morning as low readiness.",
    ],
  },
  felt_run_down_rest: {
    code: "felt_run_down_rest",
    reasons: [
      "You said you're feeling run-down today.",
      "You told us you're low today, and that's the signal that counts.",
      "You checked in feeling run-down.",
    ],
  },
  logged_light_work_today: {
    code: "logged_light_work_today",
    reasons: [
      "You've already moved today.",
      "Something's already on the board for today.",
      "You've already got movement in today.",
    ],
  },
  endurance_volume_spike: {
    code: "endurance_volume_spike",
    reasons: [
      "Your running has ramped up this week and needs a day to absorb.",
      "This week's mileage jumped, and it wants a day to settle.",
      "You've run more than usual this week — absorbing it matters now.",
    ],
  },
  chronic_sleep_watch: {
    code: "chronic_sleep_watch",
    reasons: [
      "Your sleep has been running short lately, without a fresh warning that calls for full rest.",
      "Sleep has been thin for a while now, though nothing this morning says stop.",
      "The sleep trend has been short lately — worth easing, not worth stopping.",
      "Short sleep has been the pattern recently, with nothing acute on top of it.",
    ],
  },
  planned_reduced_training: {
    code: "planned_reduced_training",
    reasons: [
      "Your recovery week calls for the planned lighter session today.",
      "This is a reduced week, and today's lighter session is the plan.",
      "The lighter version of today's session is what this week asks for.",
    ],
  },
  planned_training: {
    code: "planned_training",
    reasons: [
      "A session is due and nothing is asking you to hold back.",
      "Today's session is due, and nothing is pulling the other way.",
      "You're due, and everything reads clear for it.",
      "A session is waiting and you look ready for it.",
    ],
  },
  // The one rule that reads the athlete's OWN outcomes back into the floor. Every
  // other rule above looks only at today's inputs, which is why a stable picture
  // could suggest rest for eleven mornings running while the athlete trained
  // through six of them and rated those sessions well: the disagreement was
  // recorded, reconciled and then never consulted. This rule consults it, and does
  // exactly one thing with it — turns a rest into an EASY day. Never a train day,
  // never against a clinical constraint, never against a fresh short night.
  outcome_feedback_soften: {
    code: "outcome_feedback_soften",
    reasons: [
      "You've trained through the last few of these and it's gone well.",
      "The last few times today read like this, you trained and came out fine.",
      "Training through reads like this has been working for you lately.",
      "You've kept training on days like this recently, and it's held up.",
    ],
  },
  // The MIRROR of the rule above, one rung further up the ladder (owner ruling,
  // 2026-08-17). The rest→easy softening closed half the loop: it could answer a rest
  // the athlete kept overruling, and then the eased day became the new floor and the
  // loop went quiet again — an athlete whose easy mornings kept turning into real
  // sessions, week after week, was still being offered an easy morning. This answers
  // that one, on the same evidence bar and with the same resets, and it too moves
  // exactly ONE step: easy → train, never further, never against anything clinical,
  // never inside a reduced week.
  outcome_feedback_open: {
    code: "outcome_feedback_open",
    reasons: [
      "Your last few easy mornings turned into real sessions and they went well.",
      "The last handful of easy reads became proper training, and it held up.",
      "You've been turning days like this into solid sessions lately, and they've landed fine.",
      "Easy mornings have been becoming real work for you recently, and coming out fine.",
    ],
  },
} as const satisfies Record<string, DayReadRuleOutcome>;

// The athlete-facing `why` for each deterministic read, in several calm phrasings
// of the SAME judgement — rotated per calendar day exactly like the outcome
// reasons above, and for the same reason: a stable signal fires a stable rule, and
// one literal per rule is what made the Brief print an identical sentence every
// morning. The words move; the posture never does.
const DONE_WHY: ReadonlyArray<(label: string) => string> = [
  (label) => `You already got a solid ${label} in today — the rest of the day is for recovery.`,
  (label) => `Today's ${label} is done. Everything from here is recovery.`,
  (label) => `That ${label} is in the books — let the rest of the day work on you.`,
];
const ACUTE_SLEEP_WHY: readonly string[] = [
  "Last night was short and the longer sleep trend is short too — rest is the safer suggestion today.",
  "A short night on top of a short stretch — today is better spent resting.",
  "Sleep's been thin lately and last night didn't help, so rest is the kinder call.",
  "Between last night and the last couple of weeks, you're carrying a real sleep debt — rest suits today.",
];
const DOSE_OVERRUN_WHY: readonly string[] = [
  "Yesterday's recovery session materially exceeded its reduced dose — take today to absorb it before continuing.",
  "Yesterday ran well past what this lighter week asks for, so today is for absorbing it.",
  "This week is meant to be reduced and yesterday wasn't — give today back to recovery.",
];
const STACKED_LOAD_WHY: readonly string[] = [
  "You've trained hard several days running — let it consolidate.",
  "That's a real run of training days. Today is where it turns into fitness.",
  "Several loading days back to back — the adaptation happens on the day you stop.",
  "You've stacked the work. Let today do the quiet half of it.",
];
// The same stacked days, read for an athlete who has asked to keep training. It has
// three jobs at once and every phrasing carries all three: name the groups that are
// actually due (templated, because a targeted day that will not say what it is
// targeting is just a rest day with a nicer headline), frame the day as NARROW rather
// than as a licence to do more, and acknowledge the run of days honestly instead of
// pretending it is not there. No phrasing agrees a verb with the subject — the groups
// arrive as one phrase that may be singular ("quads") or plural ("quads and back").
export const PUSH_DRIVE_WHY: ReadonlyArray<(groups: string) => string> = [
  (groups) =>
    `Several loading days back to back, and nothing is pulling the other way — so keep today narrow: the heavy work due for your ${groups}, and nothing extra stacked on top.`,
  (groups) =>
    `You'd rather train while the evidence looks good, and it does — go after your ${groups}, which is where the work is due, and leave the running out of today.`,
  (groups) =>
    `That's a real run of training days, so make today count where it is due — heavy, focused sets for your ${groups}, and no added miles on top of them.`,
  (groups) =>
    `The days have stacked up, but recovery reads clear and you'd rather train — so spend today on what is due, your ${groups}, and save the extra cardio for another day.`,
];
const LOW_READINESS_WHY: readonly string[] = [
  "A lighter day is the safer call today — your readiness reading came in low this morning.",
  "This morning's reading came in low, so keeping today light is the safer bet.",
  "Readiness is down today — worth respecting rather than pushing through.",
];
// The same words the unified signal state speaks for the same check-in, borrowed
// rather than re-declared: a low-energy check-in reaches the athlete through BOTH
// this rule and the protect posture below, and two literals for one trigger is
// exactly how the same morning ends up reading in two different voices.
const RUN_DOWN_WHY: readonly string[] = signalVoice({ key: "felt_energy_low" });
const LIGHT_WORK_WHY: readonly string[] = [
  "You've already moved today — keep the rest of it easy.",
  "Something's already on the board today, so keep the rest gentle.",
  "You've moved today. That's enough — let the rest stay easy.",
];
// The re-timed rest: the same stacked days, read against a tomorrow that is already
// claimed. It is NOT a second opinion about whether the athlete needs a break — they
// do, and they still get one; it is a question about WHICH day the break lands on, and
// it fires only when the break in question is the discretionary rhythm one.
//
// Every phrasing carries three things: that tomorrow is spoken for (the whole basis of
// the read — a sentence that drops it is a train day with no explanation), that today
// is therefore the day that can hold the movement, and that the movement is EASY. The
// last one matters most: this rule reaches into a run of loading days, so it may offer
// a comfortable session and must never sound like a reason to reach for more. Written
// to fit both branches — a due plan day and a bare open one — because the sentence is
// about the calendar either way, and the focus is what tells the two apart.
const LOOKAHEAD_RETIME_WHY: readonly string[] = [
  "Tomorrow is already spoken for, so today is the better day to move — keep it easy and it still counts.",
  "Something's on tomorrow, which makes today the natural place for the gentle work. No need to make it a big one.",
  "Tomorrow already has a claim on it, so if today is the day you move, keep the effort comfortable.",
  "With tomorrow taken, an easy turn today fits better than waiting for a day that isn't yours.",
];
const VOLUME_SPIKE_WHY: readonly string[] = [
  "Your running's ramped this week — an easy day lets it absorb.",
  "This week's mileage jumped, so today is for letting it settle.",
  "You've run more than usual this week; easy today is how it sticks.",
];
const CHRONIC_SLEEP_WHY: readonly string[] = [
  "Sleep has been running short for a while now, and today doesn't add anything new to that — easing off is enough.",
  "The sleep trend's been thin for a while — nothing alarming today, so ease rather than stop.",
  "Short sleep has been the pattern recently; an easier day covers it.",
  "Nothing acute this morning, but sleep's been light lately — keep today gentle.",
];
// The softened rest. It has to do two things at once: name the evidence honestly
// (their own logged days, not a hunch) and point forward, because the whole reason
// this rule exists is that a read which never moves stops being coaching. Still a
// suggestion — every phrasing offers a lighter day, none of them asks for a session.
const OUTCOME_FEEDBACK_SOFTEN_WHY: readonly string[] = [
  "You've trained through the last few reads like this one and it's gone well, so today leans light rather than fully off.",
  "The last handful of times this came up you trained and it held up — so today reads easy instead of a full stop.",
  "Training through days like this has been working for you lately, so keep today light rather than taking it off entirely.",
  "You've been training through these and coming out fine, so today's an easy day rather than a rest day.",
];
// The opened easy day — the same job one rung up. It has to name the evidence (their
// own last few mornings, not a hunch) AND still offer rather than instruct: every
// phrasing says the day CAN open, none of them asks for a session, and none names a
// number about them. "solid" / "real" describe the sessions they already logged.
const OUTCOME_FEEDBACK_OPEN_WHY: readonly string[] = [
  "Your last few easy mornings became solid sessions and it went well, so today can open harder if you want it to.",
  "The last handful of days like this turned into real training and held up — so today reads as a training day.",
  "You've been turning these into proper sessions lately and coming out fine, so today's open for one.",
  "Easy mornings have been becoming real work for you and it's been landing, so today can be a session rather than a stroll.",
];
const UNPROGRAMMED_WHY: readonly string[] = [
  "Nothing programmed — some easy movement is plenty today.",
  "Nothing's due today, so move however you feel like moving.",
  "The plan's open today — anything easy counts.",
  "No session waiting on you today; easy movement is the whole ask.",
];
const TRAIN_CLEAR_WHY: readonly string[] = [
  "You're recovered and due — good to go.",
  "You're due and everything reads clear. Go get it.",
  "Nothing's holding you back today — the session's yours.",
  "Recovery looks fine and the session is due. Good day for it.",
];
// The clear day's louder sibling, for the day the evidence positively BACKS rather
// than merely permits (signal_state.action.support === "backed"). Until this set
// existed the floor could only ever get quieter: the arbitration had rest, easy and
// modify thresholds and nothing above train, so a week of strongly-rated sessions
// with nothing pulling the other way read exactly like a day with no evidence at
// all — "nothing's holding you back", forever.
//
// Still a SUGGESTION and still inside the reading grammar: every phrasing OFFERS the
// reach ("worth", "if you feel like it", "a good day to"), none of them asks for it,
// and none names a number. The one idea each must carry is that today is a day to go
// AFTER something, on the evidence of what they have already logged.
const TRAIN_PUSH_WHY: readonly string[] = [
  "Everything you've logged lately says you're carrying this well — a good day to go after a little more.",
  "Your recent sessions have come back strong and nothing's pulling the other way, so today's worth reaching on.",
  "You're due, you're absorbing the work, and today looks like a day to ask a bit more of yourself.",
  "By your own recent evidence this block is landing — if you feel like pushing today, today's the day for it.",
];
const TRAIN_CAVEAT_LEAD: readonly string[] = [
  "You're good to train",
  "Today's a green light",
  "You're clear to train",
  "The session's on",
];
// The hold branch's own connective. It sits where TRAIN_CAVEAT_LEAD sits on the
// sibling branch — after the brake's spoken sentence, before the caveat run — and
// fires on exactly the same stable inputs, so it rotates on the same terms rather
// than printing one literal every morning a dimension sits at watch.
const TRAIN_HOLD_LEAD: readonly string[] = [
  "Keep today's work conservative",
  "Keep the session on the conservative side",
  "Worth keeping today measured",
  "Keep today's effort in check",
];

// The hold lead's softer sibling, for the caution that is REAL but unseconded — one
// dimension at watch on a board where nothing else is pulling (see the second-opinion
// bar in planningDirectives, owner ruling 2026-08-17). That caution used to counsel
// holding load and volume everywhere; now it only speaks. The lead has to work in two
// shapes: with a caveat run after it, and on its own with nothing but the earn path
// behind it — so each phrasing is a complete clause that survives a full stop.
const TRAIN_NOTED_LEAD: readonly string[] = [
  "The session's still yours",
  "Today's still a training day",
  "That doesn't close the day down",
  "The work still stands",
];
// The push lead. The push and the caveat run used to be mutually exclusive — any
// caveat at all withdrew the push — so a backed day carrying nothing worse than a
// bookkeeping note read exactly like a day with a brake on it. Now that bookkeeping
// caveats no longer veto the push, the composed sentence needs a lead that OFFERS the
// reach and still hands off to the caveats honestly.
const TRAIN_PUSH_CAVEAT_LEAD: readonly string[] = [
  "There's room to reach today",
  "Today's a day you can ask more of",
  "Worth going after a little more today",
  "Today has room in it for more",
];

// The LEADS above, registered. They rotated from the start but belonged to
// neither existing registry, so nothing held them to the constitution and a new
// phrasing could skip it entirely: they are not a whole `why` (they carry no
// terminal punctuation — a caveat run follows) and not a caveat fragment (they open
// with a capital, because they open the sentence). Their own registry, keyed by the
// same pickDayVariant rotation key the rule passes, with the shape rules that follow
// from sitting at the FRONT of a composed sentence. Guards in test/dayRead.test.js.
export const DAY_READ_LEAD_VARIANTS: Readonly<Record<string, readonly string[]>> = {
  "planned_training:caveats": TRAIN_CAVEAT_LEAD,
  "planned_training:hold_lead": TRAIN_HOLD_LEAD,
  "planned_training:noted_lead": TRAIN_NOTED_LEAD,
  "planned_training:push_caveats": TRAIN_PUSH_CAVEAT_LEAD,
};

// The one idea each lead must carry, exactly as DAY_READ_CAVEAT_CONCEPT does for the
// fragments: the green-light lead has to still read as a green light, and the hold
// lead has to still ask for restraint.
export const DAY_READ_LEAD_CONCEPT: Readonly<Record<string, RegExp>> = {
  "planned_training:caveats": /\b(?:train|session|green light)\b/i,
  "planned_training:hold_lead": /\b(?:conservative|measured|in check)\b/i,
  // A noted caution must leave the day OPEN — that is the whole difference between it
  // and the hold lead sitting above it.
  "planned_training:noted_lead": /\b(?:still|doesn't close)\b/i,
  "planned_training:push_caveats": /\b(?:room|reach|more)\b/i,
};

// ---------- THE EARN PATH (owner ruling, 2026-08-17) ----------
//
// A brake the athlete cannot see the end of is a verdict wearing a suggestion's
// clothes. Every surface where something holds the day back now closes with the
// condition that opens it again — never a date, never a target, never a number about
// the person, and never an instruction ("you must" is already a grammar violation).
//
// Two sets, because exactly one brake in this vocabulary can name a CONCRETE unlock:
// the run-intensity caution, whose voice already carries the athlete's own easy
// ceiling in bpm as its subject (SIGNAL_VOICE.run_intensity_compressed). A ceiling is
// a measurement, not a grade, and it is the one thing that makes "keep the next runs
// under it" actionable rather than vague. Everything else gets the honest general
// form: a clean stretch on whatever is being watched and the room comes back.
const EARN_PATH_INTENSITY: ReadonlyArray<(ceiling: string) => string> = [
  (ceiling) => `Bring the next few runs in under ${ceiling} and the room to build opens back up.`,
  (ceiling) => `A couple of runs that actually sit under ${ceiling} is what gives this back.`,
  (ceiling) => `Once the easy runs are landing under ${ceiling} again, there's room to reach for more.`,
  (ceiling) => `Give it a run or two under ${ceiling} and the harder work has somewhere to go again.`,
];
const EARN_PATH_GENERAL: readonly string[] = [
  "A clear day or two on that and there's room to reach again.",
  "Once it settles, the room to push comes back with it.",
  "Give it a day or two to come good and today's ceiling lifts again.",
  "It opens back up as soon as that reads clear again.",
];

// The earn-path vocabulary, registered beside the rest of the Brief's words
// (templated set rendered with a sample ceiling, exactly as DAY_READ_WHY_VARIANTS
// does for its own templated entries).
export const DAY_READ_EARN_PATH_VARIANTS: Readonly<Record<string, readonly string[]>> = {
  "planned_training:earn_path_intensity": EARN_PATH_INTENSITY.map((render) => render("148 bpm")),
  "planned_training:earn_path": EARN_PATH_GENERAL,
};
// The one idea each must carry: something OPENS. A phrasing that names the brake and
// forgets the way out is the sentence this whole layer exists to replace.
export const DAY_READ_EARN_PATH_CONCEPT: Readonly<Record<string, RegExp>> = {
  "planned_training:earn_path_intensity": /\b(?:opens?|back|again|somewhere to go)\b/i,
  "planned_training:earn_path": /\b(?:opens?|back|again|room)\b/i,
};

// The one earn-path sentence for the brake that is actually holding the day, or "" when
// the brake carries no voice at all. Keyed off the VOICE rather than the dimension: the
// run-intensity caution is the only one carrying a concrete unlock, and it identifies
// itself by voice key, so a second brake that grows one later joins here rather than in
// a parallel chain somewhere else.
function earnPathClause(voice: SignalVoiceRef | null | undefined, date: string): string {
  const ceiling = String(voice?.subject ?? "").trim();
  return voice?.key === "run_intensity_compressed" && ceiling
    ? pickDayVariant(EARN_PATH_INTENSITY, date, "planned_training:earn_path_intensity")(ceiling)
    : pickDayVariant(EARN_PATH_GENERAL, date, "planned_training:earn_path");
}

// (A `RECOVERY_WEEK_TRAIN_WHY` set used to sit here as the third arm of the planned-
// training `why` chain — `holdAggression ? … : caveats.length ? … : recoveryWeek ? … :
// TRAIN_CLEAR_WHY`. It was DEAD: a recovery week always pushes RECOVERY_WEEK_CAVEAT, so
// `caveats.length >= 1` whenever `recoveryWeek` is true and the arm could never be
// reached. Hoisting the check above the caveat arm was the other way to revive it, but
// that arm is the only one that can carry the day's OTHER caveats — an injury to work
// around, a short-sleep stretch, a hold on aggression — so reviving it would have
// traded live safety guidance for a phrasing nobody had ever read. It is retired
// instead: a recovery-week train day speaks through the registered lead
// (`planned_training:caveats`) plus the registered `planned_training:recovery_week`
// caveat, which is what it has always actually printed.)

// ---------- the planned-training caveats (the fragments after the dash) ----------
// The planned-training rule is the one that fires on most mornings, and its `why` is
// assembled rather than picked: a lead, then a run of lowercase FRAGMENTS joined with
// "; and ", then a full stop. The leads rotated from the start; the fragments did not
// — each was a single hardcoded string, so an athlete in a chronic-short-sleep stretch
// or a recovery week read the identical clause every single morning, which is exactly
// the failure this whole layer exists to remove.
//
// Every set below is therefore a variant set on the same terms as the `why` sets
// above, with two extra shape rules that come from being spliced mid-sentence:
// each phrasing starts LOWERCASE and carries NO terminal punctuation, so any
// combination of them still reads as one grammatical sentence. Each set also gets
// its OWN pickDayVariant rotation key, so two caveats firing on the same day rotate
// independently instead of moving in lockstep. DAY_READ_CAVEAT_VARIANTS /
// DAY_READ_CAVEAT_CONCEPT below register them for the constitution tests.
const RECOVERY_WEEK_CAVEAT: readonly string[] = [
  "this is the reduced recovery-week dose, so keep every set crisp and well shy of failure",
  "the recovery week has this dialled down on purpose, so keep the reps crisp and nowhere near failure",
  "you're inside a reduced week, so treat the prescription as a ceiling and leave a couple of reps in reserve",
  "this is the lighter recovery-week dose, so it should still feel easy on the way out",
];
// Templated on the injury title, following the same renderer-array pattern as
// RECOVERY_WEEK_TRAIN_WHY / QUIET_STREAK_WHY. The subject arrives already lowercased.
const INJURY_CAVEAT: ReadonlyArray<(subject: string) => string> = [
  (subject) => `you've got ${subject} to work around, so skip anything that aggravates it`,
  (subject) => `${subject} is still there to work around, so steer clear of anything that aggravates it`,
  (subject) => `keep ${subject} in mind and work around it, since nothing today is worth aggravating it for`,
  (subject) => `there's ${subject} to work around today, so drop any movement that makes it speak up`,
];
// Session-reported joint pain, templated on the sore areas exactly as INJURY_CAVEAT is
// templated on the injury title. It needs its own set because it reaches the read by a
// different route and reads differently: an injury is a NAMED condition from a context
// event ("a sore left knee"), joint pain is a bare list of areas from session feedback
// ("left knee"), and the ask is a pain-free SUBSTITUTION rather than avoiding a known
// aggravator. Every phrasing avoids a verb agreeing with the subject, because the areas
// arrive joined ("left knee, right shoulder") and a singular verb reads wrong on one of
// the two.
const JOINT_PAIN_CAVEAT: ReadonlyArray<(subject: string) => string> = [
  (subject) => `keep today pain-free around your ${subject} and swap out anything that aggravates it`,
  (subject) => `there's recent soreness around your ${subject} to work around, so skip anything that provokes it`,
  (subject) => `work around your ${subject} today and stop short of anything that nags`,
  (subject) => `pick movements that keep your ${subject} comfortable rather than pushing through the soreness`,
];
const EASE_AROUND_CAVEAT: readonly string[] = [
  "there's something to ease around right now, so keep the load conservative",
  "something needs easing around at the moment, so keep the load on the conservative side",
  "you've got something to ease around today, so hold the load where it stays comfortable",
  "there's something worth easing around, so keep today's load modest",
];
const ANTICIPATE_DELOAD_CAVEAT: readonly string[] = [
  "recovery's drifting below your norm, so a couple more hard days and you'll likely want a reset",
  "your recovery's been sliding a little, so another hard day or two and a reset will probably be worth taking",
  "recovery's running under where it usually sits, and a reset is probably only a few hard days away",
  "recovery's been trending a touch low, so a lighter week may be closer than it looks",
];
const VOLUME_SPIKE_CAVEAT: readonly string[] = [
  "your running's ramped this week, so keep today's miles easy and don't pile on hard intensity",
  "the running's climbed this week, so keep today's miles gentle rather than stacking more intensity on top",
  "you've put more running in than usual this week, so today's miles are better kept easy",
  "there's been a jump in running this week, so let today's miles stay comfortable and save the intensity",
];
const LOW_SLEEP_CAVEAT: readonly string[] = [
  "sleep's been running short lately, so keep the session controlled and stop a rep or two shy",
  "your sleep's been on the short side, so keep the session controlled and leave a couple of reps in the tank",
  "the nights have been short for a while now, so keep today measured and stop shy of failure",
  "sleep hasn't been generous recently, so hold the session steady and finish a rep or two early",
];
// The pronoun in the first phrasing ("until that settles") points at the sentence
// before it — the brake's own spoken voice, named by action.directives.training_source.
// The middle two name the thing outright, so a short lead still leaves a caveat that
// stands on its own.
const HOLD_AGGRESSION_CAVEAT: readonly string[] = [
  "hold off on adding load or volume until that settles",
  "leave the load and the volume where they are for now rather than reaching for more",
  "today isn't the day to add load or volume, so keep both where they were last time",
  "hold the load and the volume steady until that eases off",
];
// `directives.schedule === "compress"` has TWO unrelated causes and only one of them
// is about the clock, so it gets TWO caveats (see the split in the rule below). This
// one speaks only for a real dated commitment, where the claim is true and the 60→40
// clamp is earned.
const COMMITMENT_PRESSURE_CAVEAT: readonly string[] = [
  "a current dated commitment compresses today's training window, so keep the session focused",
  "something on today's calendar squeezes the training window, so keep the session focused",
  "you've got a commitment today that shortens the training window, so keep it tight",
  "today's schedule leaves a narrower window than usual, so plan for a compact session",
];
// ...and this one for the other cause: `context.expect_worse_sleep`, a late night or a
// stressful stretch. There is no commitment and nothing about the clock is squeezed —
// what is thinner is RECOVERY. So it asks for less intensity at full length, never a
// shorter day. Naming a commitment here was a false claim about the athlete's calendar.
const LIFE_PRESSURE_CAVEAT: readonly string[] = [
  "there's enough going on right now to thin out your recovery, so keep the intensity honest rather than the day short",
  "a stretch like this usually costs you sleep, so hold the intensity where it is and take the session as it comes",
  "what's on at the moment tends to eat into your recovery, so keep today's hardest sets a notch easier",
  "this stretch is thinner on recovery than usual, so ease the intensity rather than the length",
];

// The caveat vocabulary, keyed by its own pickDayVariant rotation key (templated sets
// rendered with a sample subject, exactly as DAY_READ_WHY_VARIANTS does). Separate from
// DAY_READ_WHY_VARIANTS because these are FRAGMENTS: they start lowercase and end
// without punctuation, so the sentence-shape guards on the `why` vocabulary would
// (correctly) reject them. Their own guards live beside those, in test/dayRead.test.js.
export const DAY_READ_CAVEAT_VARIANTS: Readonly<Record<string, readonly string[]>> = {
  "planned_training:recovery_week": RECOVERY_WEEK_CAVEAT,
  "planned_training:injury": INJURY_CAVEAT.map((render) => render("a sore left knee")),
  "planned_training:ease_around": EASE_AROUND_CAVEAT,
  "planned_training:anticipate_deload": ANTICIPATE_DELOAD_CAVEAT,
  "planned_training:volume_spike": VOLUME_SPIKE_CAVEAT,
  "planned_training:low_sleep": LOW_SLEEP_CAVEAT,
  "planned_training:hold_aggression": HOLD_AGGRESSION_CAVEAT,
  "planned_training:commitment_pressure": COMMITMENT_PRESSURE_CAVEAT,
  "planned_training:life_pressure": LIFE_PRESSURE_CAVEAT,
  "planned_training:joint_pain": JOINT_PAIN_CAVEAT.map((render) => render("left knee")),
};

// The one idea each caveat must carry whichever phrasing lands — the same drift guard
// DAY_READ_REQUIRED_CONCEPT applies to the `why` vocabulary.
export const DAY_READ_CAVEAT_CONCEPT: Readonly<Record<string, RegExp>> = {
  "planned_training:recovery_week": /\b(?:recovery week|recovery-week|reduced|lighter)\b/i,
  "planned_training:injury": /\bwork(?:ing)? around\b/i,
  "planned_training:ease_around": /\beas(?:e|ing) around\b/i,
  "planned_training:anticipate_deload": /\brecovery(?:'s)?\b/i,
  "planned_training:volume_spike": /\b(?:running|miles)\b/i,
  "planned_training:low_sleep": /\b(?:sleep|nights?)\b/i,
  "planned_training:hold_aggression": /\b(?:load|volume)\b/i,
  // The commitment caveat must stay about the CLOCK, and the life-pressure one about
  // RECOVERY. Keeping the two concepts disjoint is what stops the false-commitment
  // claim from creeping back in under a new phrasing.
  "planned_training:commitment_pressure": /\b(?:window|commitment|calendar)\b/i,
  "planned_training:life_pressure": /\b(?:recovery|sleep|thinner|stretch)\b/i,
  "planned_training:joint_pain": /\b(?:work(?:ing)? around|pain-free|comfortable)\b/i,
};

// The rest→easy softening clamp in enforceRecoveryWeekCadence (src/dayread.ts) is a
// server-policy override, not one of the rules above — but it fires inside an APPLIED
// recovery week and can repeat for several consecutive days just like any other rule
// (that's exactly the path most likely to print the same sentence for a week straight),
// so it rotates through the same pickDayVariant mechanism, keyed on the same calendar
// date. Exported so dayread.ts can pick from it directly.
export const RECOVERY_WEEK_SOFTEN_WHY: readonly string[] = [
  "Yesterday carried a real load — keep today easy, without turning the reduced week into another full rest day.",
  "You put in real work yesterday, so ease off today rather than taking the whole day off.",
  "There was a genuine loading day yesterday — today stays light, not another full rest day in this reduced week.",
  "Yesterday's load was real, which is reason enough to keep today easy without stacking a second rest day.",
];

// The server-policy `decision.reason` literals in dayread.ts's policyDecision() calls
// are ALSO athlete-facing — the Brief renders decision.reason whenever it's non-empty
// — and every clamp path below can fire on consecutive days exactly like a rule above,
// so they rotate through the same pickDayVariant mechanism, keyed on their own
// rule_code. Each set stays in the register the original literal established:
// explaining what the server policy did and why, which is DELIBERATELY DIFFERENT
// content from the day's own narrative `why` — most visibly for the recovery-week
// softening clamp, where RECOVERY_WEEK_SOFTEN_REASON explains that a full-rest read
// got dialed back to easy, rather than restating RECOVERY_WEEK_SOFTEN_WHY's "yesterday
// carried load" narrative on the same card.
const COMPLETION_FACT_NOT_LOGGED_REASON: readonly string[] = [
  "No training is logged yet today, so today is still open.",
  "Nothing's been logged for today yet — the day is still ahead of you.",
  "Today doesn't show any training logged yet, so it's still wide open.",
  "There's nothing logged today, which means today hasn't actually happened yet.",
];
const COMPLETION_FACT_PRESERVED_REASON: readonly string[] = [
  "Your logged training already covers today.",
  "What you logged stands — today doesn't get reopened as a fresh suggestion.",
  "The work's already logged, so today isn't turning back into a recommendation.",
  "Today's covered by what you logged; that doesn't need reinterpreting.",
];
const DETERMINISTIC_SAFETY_FLOOR_REASON: readonly string[] = [
  "Your recent training and recovery still point to keeping today lighter.",
  "Everything in your recent training and recovery still argues for a lighter day.",
  "The picture from recent training and recovery hasn't changed — today stays lighter.",
  "Recent training and recovery both still say lighter, not harder.",
];
const RECOVERY_WEEK_REDUCED_TRAIN_REASON: readonly string[] = [
  "Yesterday was already easy, so today goes back to the planned lighter session.",
  "There wasn't a loading day yesterday to ease off from, so today returns to the planned session.",
  "Yesterday didn't carry real load, which means today's planned lighter session stands.",
  "With nothing heavy yesterday, today goes back to what the reduced week already had planned.",
];
const RECOVERY_WEEK_SOFTEN_REASON: readonly string[] = [
  "A full rest day here would go further than this reduced week calls for, so it softened to easy instead.",
  "Full rest got dialed back to easy — the reduced week already answers a loaded day like yesterday.",
  "This stayed at easy rather than a full stop, since the recovery week is already the answer to yesterday's load.",
  "The suggested rest eased to a lighter day instead, in line with how this reduced week already handles load.",
];

// The agent's own conservative adjustment is the fifth athlete-facing `decision.reason`
// and the only one the rotation missed. It is written in computeDayRead rather than by
// a policyDecision() clamp — `basis` there is "agent", not "server_policy" — but it is
// rendered by exactly the same Brief line (todayBriefDecisiveReason, on rest/easy days,
// which is the only shape `conservative` can take), and it fires every day an agent
// steps a planned session down. So it lives in the same map and rotates on the same
// terms; only the reason LOOKUP is shared with policyDecision, never the basis.
const AGENT_CONSERVATIVE_ADJUSTMENT_REASON: readonly string[] = [
  "Your coach eased today back from the planned session.",
  "Today came back a notch from what the plan had down.",
  "Your coach dialled today down from the session that was scheduled.",
  "The planned session got softened a little for today.",
];

// Keyed by rule_code (the SAME string dayread.ts passes as both the ledger code and
// the pickDayVariant key), mirroring DAY_READ_WHY_VARIANTS so the two vocabularies —
// the day's `why` and the server policy's `reason` — are tested the same way.
export const DAY_READ_POLICY_REASON_VARIANTS: Readonly<Record<string, readonly string[]>> = {
  completion_fact_not_logged: COMPLETION_FACT_NOT_LOGGED_REASON,
  completion_fact_preserved: COMPLETION_FACT_PRESERVED_REASON,
  deterministic_safety_floor: DETERMINISTIC_SAFETY_FLOOR_REASON,
  recovery_week_reduced_train_after_non_loading_day: RECOVERY_WEEK_REDUCED_TRAIN_REASON,
  recovery_week_rest_softened_to_easy_after_loading_day: RECOVERY_WEEK_SOFTEN_REASON,
  agent_conservative_adjustment: AGENT_CONSERVATIVE_ADJUSTMENT_REASON,
};

// The ONE lookup for a rendered `decision.reason`. Every writer of that field goes
// through here so the map cannot acquire a second, differently-rotated reader (it
// already had one: the agent branch in computeDayRead hand-wrote its literal).
// An unregistered code yields "" — the Brief renders a reason only when there is a
// specific one, and narrating Cairn's internals is worse than saying nothing.
export function dayReadPolicyReason(ruleCode: string, date: string): string {
  const variants = DAY_READ_POLICY_REASON_VARIANTS[ruleCode];
  return variants?.length ? pickDayVariant(variants, date, ruleCode) : "";
}

// ---------- the Brief's headline ----------
// The most prominent string on the whole Brief (`<h2 class="brief-headline">`), and
// the last one still printed as an unrotated literal — one fixed sentence per kind,
// implemented THREE times (a `deterministicHeadline` in dayread.ts, a byte-identical
// `dayReadHeadline` in the day-read use case, and a hardcoded "Take it easy." inside
// the recovery-week softening clamp, directly above the `why` that was fixed for
// exactly this reason). Everything beneath it rotated this round; it did not. On this
// athlete's real history roughly half of mornings open on `rest`, so "Rest today." was
// the sentence they read verbatim, indefinitely.
//
// One implementation now, rotated by calendar day like the rest of the vocabulary.
// DATE-KEYED, never random: todayBriefMateriallyDiffers compares `headline` to decide
// whether to repaint, and the clamp paths rewrite it on every call, so a
// non-deterministic pick would repaint the Brief on every poll.
export const DAY_READ_HEADLINE_VARIANTS: Readonly<Record<string, readonly string[]>> = {
  done: ["You're done for today.", "Today's work is in.", "That's today's training done.", "Today's already covered."],
  rest: ["Rest today.", "Today's a rest day.", "Today is for resting.", "A rest day today."],
  easy: ["Take it easy.", "Keep today easy.", "An easy day today.", "Easy does it today."],
  train: ["Good to train.", "Good day to train.", "You're clear to train.", "Today's a training day."],
};

// A train day that knows its focus makes the FOCUS the headline ("Lower body."), so
// the rotation moves the frame around it instead of replacing it — the plain form
// stays first, and every phrasing still names the focus.
const TRAIN_FOCUS_HEADLINE: ReadonlyArray<(focus: string) => string> = [
  (focus) => `${focus}.`,
  (focus) => `${focus} today.`,
  (focus) => `${focus} is on today.`,
];

// The BACKED train day's headline sets — its own rather than a fifth `kind` entry in
// DAY_READ_HEADLINE_VARIANTS above, because the read's kind really is `train` (the
// safety ladder in enforceDayReadSafetyPosture ranks rest < easy < train and knows
// nothing else) and every consumer that maps a kind to a headline set must keep
// resolving to the same four. The push is a FLAVOUR of train, not a fifth posture.
const TRAIN_PUSH_HEADLINE: readonly string[] = [
  "Good day to go after it.",
  "Today's one to push.",
  "A day to train and reach a little.",
  "Good day to ask more of yourself.",
];
const TRAIN_PUSH_FOCUS_HEADLINE: ReadonlyArray<(focus: string) => string> = [
  (focus) => `${focus} — go after it.`,
  (focus) => `${focus}, and a good day to push.`,
  (focus) => `${focus} today. Reach a little.`,
];

// The drive read's own headline sets, on the same terms as the backed day's above: the
// kind really is `train`, and this is a third FLAVOUR of it rather than a fifth posture.
// It has to read differently from the push sets, because it means something different —
// the backed day offers MORE, this one offers a NARROWER day in place of a rest — so a
// phrasing that says "go after it" would misdescribe the very restraint the rule is
// built around.
const TRAIN_DRIVE_HEADLINE: readonly string[] = [
  "Train what's due today.",
  "A targeted day, not a day off.",
  "Keep today narrow and useful.",
  "Today's for the work that's due.",
];
const TRAIN_DRIVE_FOCUS_HEADLINE: ReadonlyArray<(focus: string) => string> = [
  (focus) => `${focus} — what's due today.`,
  (focus) => `${focus}, and keep it targeted.`,
  (focus) => `${focus} today, and nothing on top.`,
];

// The one headline a read gets on a given day. Every writer of the field goes through
// here (dayread.ts's clamps and agent fallback, and the use case's factual replace).
//
// `signals.push_bias` is read rather than a fifth kind for the reason above: a caller
// that passes only `{kind, focus}` (every clamp, and the agent fallback for a read the
// agent itself downgraded) is asking the plain question and gets the plain answer.
export function dayReadHeadline(
  read: { kind?: unknown; focus?: unknown; signals?: Record<string, any> | null },
  date: string
): string {
  const kind = String(read?.kind ?? "");
  const focus = typeof read?.focus === "string" ? read.focus.trim() : "";
  const push = kind === "train" && !!read?.signals?.push_bias;
  // The drive read is checked FIRST because the two flags can co-occur (a backed day
  // is one of the two ways the drive gate can be satisfied), and when they do, the
  // narrower sentence is the honest one: this day exists in place of a rest.
  const drive = kind === "train" && !!read?.signals?.training_drive_push;
  if (kind === "train" && focus) {
    return drive
      ? pickDayVariant(TRAIN_DRIVE_FOCUS_HEADLINE, date, "headline:train_focus_drive")(focus)
      : push
        ? pickDayVariant(TRAIN_PUSH_FOCUS_HEADLINE, date, "headline:train_focus_push")(focus)
        : pickDayVariant(TRAIN_FOCUS_HEADLINE, date, "headline:train_focus")(focus);
  }
  if (drive) return pickDayVariant(TRAIN_DRIVE_HEADLINE, date, "headline:train_drive");
  if (push) return pickDayVariant(TRAIN_PUSH_HEADLINE, date, "headline:train_push");
  const variants = DAY_READ_HEADLINE_VARIANTS[kind] ?? DAY_READ_HEADLINE_VARIANTS.train;
  return pickDayVariant(variants, date, `headline:${kind || "train"}`);
}

// The idea each headline must carry whichever phrasing lands, exactly as
// DAY_READ_REQUIRED_CONCEPT does for the `why` vocabulary. (The focus form declares
// none: its required content is the focus itself, which the guard asserts directly.)
export const DAY_READ_HEADLINE_CONCEPT: Readonly<Record<string, RegExp>> = {
  done: /\b(?:done|in|covered)\b/i,
  rest: /\brest(?:ing)?\b/i,
  easy: /\beasy\b/i,
  train: /\btrain(?:ing)?\b/i,
};

// The focus form, rendered with a sample focus — registered so the shape and
// constitution guards cover it alongside the fixed sets.
export const DAY_READ_FOCUS_HEADLINE_VARIANTS: readonly string[] = TRAIN_FOCUS_HEADLINE.map((render) =>
  render("Lower body")
);

// The backed train day's two headline forms, registered on the same terms: a phrasing
// the athlete can read has to be enumerable and held to the constitution, whichever
// branch of dayReadHeadline reaches it.
export const DAY_READ_PUSH_HEADLINE_VARIANTS: readonly string[] = TRAIN_PUSH_HEADLINE;
export const DAY_READ_PUSH_FOCUS_HEADLINE_VARIANTS: readonly string[] = TRAIN_PUSH_FOCUS_HEADLINE.map((render) =>
  render("Lower body")
);

// The drive read's two headline forms, registered for the same guards.
export const DAY_READ_DRIVE_HEADLINE_VARIANTS: readonly string[] = TRAIN_DRIVE_HEADLINE;
export const DAY_READ_DRIVE_FOCUS_HEADLINE_VARIANTS: readonly string[] = TRAIN_DRIVE_FOCUS_HEADLINE.map((render) =>
  render("Lower body")
);

// `applyContinuityVoice` asks for the ordinal of TODAY (`quiet_streak + 1`), and
// `dayReadContinuity` walks `recentDayReads(date, 7)` — so the streak reaches 7 and
// this is called with 8, one past where the table used to end. It fell through to
// "another" and printed "That's your another quiet day in a row." The table now
// covers the whole reachable range, and the fallback is a word that reads correctly
// in EVERY template below ("your latest quiet day", "Latest quiet day running",
// "this is the latest", "the latest quiet day") — so widening the continuity window
// degrades readably instead of breaking the sentence again.
const QUIET_ORDINALS = ["", "", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];
export function quietOrdinal(n: number): string {
  return QUIET_ORDINALS[n] || "latest";
}

// A long quiet stretch must not keep re-asserting itself. Past roughly two, the
// read stops repeating its own logic and offers the smallest thing worth doing —
// still a suggestion, never a gate, never a nag, never a score.
export const QUIET_STREAK_WHY: ReadonlyArray<(ordinal: string) => string> = [
  (o) =>
    `That's your ${o} quiet day in a row. Nothing here is pushing you to train — but if you want the smallest thing worth doing, ten easy minutes on your feet is plenty.`,
  (o) =>
    `${o.charAt(0).toUpperCase() + o.slice(1)} quiet day running. Staying rested is completely fine; so is a short walk or five minutes of easy mobility if you'd rather do something.`,
  (o) =>
    `You've had a few quiet days now — this is the ${o}. No pressure either way, though a gentle walk today would do more for you than another full stop.`,
  (o) =>
    `This makes the ${o} quiet day. If the rest still feels right, take it. If you're getting restless, something small and easy is the place to start.`,
];

// The same escalation for a day carrying a movement work-around. Three of the four
// phrasings above offer the smallest thing worth doing as time on your feet — and
// on an injury day that sentence lands AFTER the caveat warning them off exactly
// that, so the read's last and most memorable words contradicted its own guardrail
// (on some days only, since the variant is date-keyed). These carry the same idea —
// the rest is fine, and you are not obliged to do nothing — without naming a
// weight-bearing option, and rotate the same way, so pinning the guarded day to one
// phrasing never reintroduces the daily repetition this whole layer exists to fix.
export const QUIET_STREAK_GUARDED_WHY: ReadonlyArray<(ordinal: string) => string> = [
  (o) =>
    `That's your ${o} quiet day in a row. Nothing here is pushing you to train, and while there's something to work around, resting is a perfectly good answer.`,
  (o) =>
    `${o.charAt(0).toUpperCase() + o.slice(1)} quiet day running. Staying rested is completely fine; if you do want to do something, keep it comfortable and stop short of anything that nags.`,
  (o) =>
    `You've had a few quiet days now — this is the ${o}. There's no pressure to break the run while something still needs working around.`,
  (o) =>
    `This makes the ${o} quiet day. If the rest still feels right, take it; if you're getting restless, stay well inside what feels good today.`,
];

// Honest thin-data degradation: when nothing has actually moved, say so plainly
// instead of re-deriving the same sentence as though it were news.
const NOTHING_MOVED_CLAUSES: readonly string[] = [
  "Nothing's really moved since yesterday.",
  "That's unchanged from yesterday.",
  "Same picture as yesterday, honestly.",
  "Nothing new has come in since yesterday's read.",
];

// The whole athlete-facing vocabulary of the deterministic floor, keyed by rule
// code (templated variants rendered with a sample argument). Exported so a caller
// — and the tests — can reason about what a rule MAY say rather than pinning one
// literal, and so a new variant that breaks the constitution is catchable in one
// place. `quiet_streak` is the escalation voice, which belongs to no single rule;
// `quiet_streak_guarded` is that same voice on a day with something to work around.
// The unified signal state's athlete voice, folded into the SAME registry under the
// rule whose `why` it becomes (`acute_signal_protection`, one entry per signal). That
// path — the dominant rest/easy path — used to assign the machine-facing evidence
// `summary` straight to the Brief's headline, so it reached the athlete without
// passing a single one of the constitution guards below. Now every phrasing it can
// speak is enumerable and tested here beside the rest of the Brief's vocabulary.
const SIGNAL_VOICE_WHY: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(SIGNAL_VOICE_REGISTRY).map(([key, entry]) => [`acute_signal_protection:${key}`, entry.variants])
);
const SIGNAL_VOICE_CONCEPTS: Record<string, RegExp> = Object.fromEntries(
  Object.entries(SIGNAL_VOICE_REGISTRY).map(([key, entry]) => [`acute_signal_protection:${key}`, entry.concept])
);

export const DAY_READ_WHY_VARIANTS: Readonly<Record<string, readonly string[]>> = {
  logged_loading_work_today: DONE_WHY.map((render) => render("session")),
  acute_sleep_corroborated: ACUTE_SLEEP_WHY,
  recovery_dose_overrun: DOSE_OVERRUN_WHY,
  accumulated_load_rest: STACKED_LOAD_WHY,
  push_drive_targeted_training: PUSH_DRIVE_WHY.map((render) => render("quads and back")),
  lookahead_retimed_training: LOOKAHEAD_RETIME_WHY,
  low_readiness_rest: LOW_READINESS_WHY,
  felt_run_down_rest: RUN_DOWN_WHY,
  logged_light_work_today: LIGHT_WORK_WHY,
  endurance_volume_spike: VOLUME_SPIKE_WHY,
  chronic_sleep_watch: CHRONIC_SLEEP_WHY,
  outcome_feedback_soften: OUTCOME_FEEDBACK_SOFTEN_WHY,
  outcome_feedback_open: OUTCOME_FEEDBACK_OPEN_WHY,
  unprogrammed_easy_day: UNPROGRAMMED_WHY,
  planned_training: TRAIN_CLEAR_WHY,
  // The backed train day. It keeps the `planned_training` LEDGER code — the decision
  // is the same one, and a second code would split the adherence history of the most
  // common read in two — and carries its own registered vocabulary, keyed off
  // `signals.push_bias` rather than off the rule that produced it.
  planned_training_push: TRAIN_PUSH_WHY,
  // `planned_reduced_training` has no `why` set of its own on purpose: a recovery-week
  // train day composes its sentence from the registered lead + the registered
  // `planned_training:recovery_week` caveat (see the retired RECOVERY_WEEK_TRAIN_WHY
  // note above), so its words are covered by DAY_READ_LEAD_VARIANTS and
  // DAY_READ_CAVEAT_VARIANTS. Its ledger `reasons` still live on the outcome.
  quiet_streak: QUIET_STREAK_WHY.map((render) => render("third")),
  quiet_streak_guarded: QUIET_STREAK_GUARDED_WHY.map((render) => render("third")),
  // The floor this rule falls back to when the winning evidence carries no voice.
  acute_signal_protection: SIGNAL_VOICE_REGISTRY.unvoiced_protect.variants,
  ...SIGNAL_VOICE_WHY,
};

// The one idea each rule's words MUST carry, whichever phrasing lands on the day.
// The old single-literal cases pinned this by accident — a test asserting
// /last night was short/ was really asserting "this read talks about sleep" — and
// that guarantee would have quietly evaporated the moment one sentence became
// several. It is explicit now, and it lives HERE, beside the prose, so a new
// variant cannot drift away from the meaning the rule exists to convey. Applies to
// BOTH registers: the athlete-facing `why` and the ledger `reason`.
export const DAY_READ_REQUIRED_CONCEPT: Readonly<Record<string, RegExp>> = {
  logged_loading_work_today: /\b(?:in today|done|books|covered|logged)\b/i,
  acute_sleep_corroborated: /\b(?:sleep|night|nights)\b/i,
  acute_signal_protection: /\b(?:protect|protecting|protection|recovery|guarding)\b/i,
  recovery_dose_overrun: /\byesterday\b/i,
  accumulated_load_rest: /\b(?:trained|training|loading|stacked|hard days)\b/i,
  // The one word this rule may never lose. It offers TRAINING on a day the floor would
  // otherwise have rested, and the only thing that earns that is work genuinely being
  // owed — a phrasing that drops "due" would be offering the session on the strength of
  // the preference alone, which is exactly what the gate below refuses to do.
  push_drive_targeted_training: /\bdue\b/i,
  // The one word this read may never lose. Every other rule explains itself from
  // today's evidence; this one's entire basis is the NEXT day, and a phrasing that
  // stops naming it is an unexplained training day inside a run of loading days.
  lookahead_retimed_training: /\btomorrow\b/i,
  low_readiness_rest: /\b(?:readiness|reading)\b/i,
  felt_run_down_rest: /\b(?:run-down|low)\b/i,
  logged_light_work_today: /\b(?:moved|movement|board)\b/i,
  endurance_volume_spike: /\b(?:running|run|mileage)\b/i,
  chronic_sleep_watch: /\bsleep\b/i,
  // Both halves, not one. This rule's whole claim is "you trained through reads like
  // this AND it went well" — a phrasing that keeps the history and drops how it turned
  // out would soften the day without saying what earned it, which is the one thing an
  // outcome-driven rule may never do.
  outcome_feedback_soften: /\b(?:trained|training)\b(?=[\s\S]*\b(?:well|held up|working|fine)\b)/i,
  // Same two-part guard as its sibling above, for the same reason: this rule OPENS a
  // day the floor wanted quiet, and the only thing that earns that is the athlete's
  // own recent mornings AND how they turned out. A phrasing that keeps the history and
  // drops the outcome would be opening the day on a hunch.
  outcome_feedback_open: /\b(?:sessions?|training|work)\b(?=[\s\S]*\b(?:well|held up|landing|fine)\b)/i,
  planned_reduced_training: /\b(?:reduced|light|lighter)\b/i,
  planned_training: /\b(?:due|train|session)\b/i,
  // A push read that forgets to offer the reach is just a clear day with extra words.
  planned_training_push: /\b(?:more|reach(?:ing)?|push(?:ing)?)\b/i,
  unprogrammed_easy_day: /\b(?:nothing|no session|open)\b/i,
  quiet_streak: /\bquiet days?\b/i,
  quiet_streak_guarded: /\bquiet days?\b/i,
  // Each signal voice declares its own required idea in signal-state.ts, beside the
  // phrasings — a soreness read must still be about soreness on the day a different
  // wording lands.
  ...SIGNAL_VOICE_CONCEPTS,
};

// ---------- cross-day memory (what we already told them) ----------
// Nothing in the Brief used to read YESTERDAY's Brief. Any input that is stable
// day over day — a chronic short sleeper, a persistently low readiness baseline,
// a multi-week injury — therefore fired the same rule, printed the same sentence,
// and did so indefinitely: taking the suggested rest never changes the input, so
// the read never changes. "Rest after rest after rest", verbatim.
//
// The day_reads cache already keeps a rolling three weeks of what was actually
// SAID; these read it back so both layers can use it — the deterministic floor to
// vary its own words and escalate a long quiet stretch, and the agentic layer to
// know what it told the athlete yesterday.
export interface PriorDayRead {
  date: string;
  kind: string;
  rule_code: string | null;
  headline: string | null;
  why: string | null;
  source: string | null;
}

// The most recent cached reads STRICTLY BEFORE `date`, newest first. Never throws.
export function recentDayReads(date: string, limit = 3): PriorDayRead[] {
  const want = Math.max(1, Math.min(14, Math.trunc(Number(limit) || 3)));
  try {
    const rows = db
      .prepare(
        `SELECT date, kind, headline, why, source, signals FROM day_reads
          WHERE date < ? ORDER BY date DESC LIMIT ?`
      )
      .all(date, want) as any[];
    return rows.map((row) => {
      let ruleCode: string | null = null;
      try {
        const meta = row.signals ? JSON.parse(row.signals)?._day_read_meta : null;
        const code = meta?.decision?.rule_code;
        ruleCode = typeof code === "string" && code ? code : null;
      } catch {
        ruleCode = null;
      }
      return {
        date: String(row.date),
        kind: String(row.kind ?? ""),
        rule_code: ruleCode,
        headline: row.headline ?? null,
        why: row.why ?? null,
        source: row.source ?? null,
      };
    });
  } catch {
    return [];
  }
}

export interface DayReadContinuity {
  // Consecutive CALENDAR days immediately before `date` whose read was easy/rest.
  // A missing day breaks the run: an unknown day is not a quiet day.
  quiet_streak: number;
  // Yesterday's read, when there is one (the day immediately before `date`).
  yesterday: { kind: string; rule_code: string | null; why: string | null } | null;
  // Filled in once the rule resolves: yesterday reached the same conclusion by the
  // same route, so today genuinely has nothing new to report.
  repeat_of_yesterday: boolean;
}

const QUIET_KINDS = new Set(["easy", "rest"]);

export function dayReadContinuity(date: string, priorReads?: PriorDayRead[]): DayReadContinuity {
  const prior = priorReads ?? recentDayReads(date, 7);
  const dayBefore = (iso: string, back: number) =>
    new Date(new Date(`${iso}T00:00:00Z`).getTime() - back * 864e5).toISOString().slice(0, 10);
  let quiet = 0;
  for (let back = 1; back <= prior.length; back++) {
    const row = prior.find((r) => r.date === dayBefore(date, back));
    if (!row || !QUIET_KINDS.has(row.kind)) break;
    quiet++;
  }
  const yesterdayRow = prior.find((r) => r.date === dayBefore(date, 1)) ?? null;
  return {
    quiet_streak: quiet,
    yesterday: yesterdayRow
      ? { kind: yesterdayRow.kind, rule_code: yesterdayRow.rule_code, why: yesterdayRow.why }
      : null,
    repeat_of_yesterday: false,
  };
}

// Voice the read against what was already said. Only the WORDS change here — the
// kind, focus and duration are the safety posture and stay exactly as the rules
// decided them.
function applyContinuityVoice(
  date: string,
  outcome: DayReadRuleOutcome,
  read: Omit<DayRead, "decision" | "input_fingerprint" | "computed_at">,
  continuity: DayReadContinuity
): Omit<DayRead, "decision" | "input_fingerprint" | "computed_at"> {
  if (!QUIET_KINDS.has(read.kind)) return read;
  // A day they have ALREADY moved on is not a day to talk about the stretch of quiet
  // days — the read is about the thing they just did, and "here's the smallest thing
  // worth doing" would ignore it.
  const signals = read.signals as any;
  const movedToday =
    signals?.trained_today === true ||
    Number(signals?.logged_today?.sets ?? 0) > 0 ||
    (Array.isArray(signals?.logged_today?.activities) && signals.logged_today.activities.length > 0);
  if (movedToday) return read;
  if (continuity.quiet_streak >= 2) {
    // A movement work-around (any fresh health constraint — an injury, an illness, a
    // painful joint) is safety guidance that lives only in the `why` — keep it and let
    // the escalation follow, rather than replacing it. And
    // the escalation that follows it must not undo it: the general set offers the
    // smallest thing worth doing as time on your feet, which is precisely what the
    // caveat just warned against. The guarded set says the same thing without naming
    // a weight-bearing option, so the read closes without contradicting itself.
    const guarded = !!signals?.health_workaround;
    const escalation = pickDayVariant(
      guarded ? QUIET_STREAK_GUARDED_WHY : QUIET_STREAK_WHY,
      date,
      `${outcome.code}:quiet-streak`
    )(quietOrdinal(continuity.quiet_streak + 1));
    return { ...read, why: guarded ? `${read.why} ${escalation}` : escalation };
  }
  if (continuity.repeat_of_yesterday) {
    const clause = pickDayVariant(NOTHING_MOVED_CLAUSES, date, `${outcome.code}:unchanged`);
    return { ...read, why: `${read.why} ${clause}` };
  }
  return read;
}

// ---------- periodization context (shared by the Brief response AND the prompt) ----------
// Where today sits in the program: the active block's week counter and, when a
// recovery overlay is running, which day of it this is. The agentic layer needs
// this to stop proposing rest as though it were novel on day 3 of 7 of a deload.
export interface DayReadPeriodizationContext {
  program_block: {
    goal: string;
    focus: string;
    stored_phase: string;
    effective_phase: string;
    week_index: number;
    total_weeks: number;
    started_at: string;
    counter_basis: "calendar_program_block";
  } | null;
  recovery_overlay: {
    applied_on: string;
    until: string;
    day_index: number;
    total_days: 7;
    proposal_id: number | null;
    cycle_id?: number;
    label: "reduced volume";
  } | null;
}

export function dayReadPeriodizationContext(date: string): DayReadPeriodizationContext {
  try {
    const block = getActiveBlock();
    // The same new-record-first, legacy-fallback authority used by dayRead() and
    // the daily-session decision. The legacy ledger is consulted only to retain
    // its proposal identifier in the compatibility payload.
    const recovery = activeRecoveryWeek(date);
    const legacy = recovery && recovery.cycle_id == null ? activeRecoveryWeekLedger(date) : null;
    const dayOffset = recovery ? daysBetweenISO(date, recovery.applied_on) : null;
    return {
      program_block: block
        ? {
            goal: String(block.goal).slice(0, 200),
            focus: block.focus,
            stored_phase: block.phase,
            effective_phase: recovery ? "deload" : block.phase,
            week_index: block.week_index,
            total_weeks: block.total_weeks,
            started_at: String(block.started_at).slice(0, 32),
            counter_basis: "calendar_program_block",
          }
        : null,
      recovery_overlay:
        recovery && dayOffset != null
          ? {
              applied_on: recovery.applied_on,
              until: recovery.until,
              day_index: Math.min(RECOVERY_WEEK_ACTIVE_DAYS, Math.max(1, dayOffset + 1)),
              total_days: RECOVERY_WEEK_ACTIVE_DAYS,
              proposal_id: legacy?.proposal_id ?? null,
              ...(recovery.cycle_id != null ? { cycle_id: recovery.cycle_id } : {}),
              label: "reduced volume",
            }
          : null,
    };
  } catch {
    return { program_block: null, recovery_overlay: null };
  }
}

// Minutes read as a metric wall the moment anything renders them (VISION.md
// Amendment 2). Sleep evidence therefore speaks in hours and minutes the way a
// person says them, never a raw "412 min".
function humanDuration(totalMinutes: unknown): string | null {
  const minutes = Math.round(Number(totalMinutes));
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

// Evidence summaries are written as labels, not prose, so they may arrive with no end
// stop. Anything spliced into a `why` needs one, or the sentence after it runs on.
function endStopped(text: string): string {
  const trimmed = String(text ?? "").trim();
  return !trimmed || /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function boundedEvidence(signals: Record<string, any>, date: string): DayReadDecisionEvidence[] {
  const evidence: DayReadDecisionEvidence[] = [];
  const push = (label: string, value: unknown, when?: unknown) => {
    if (value == null || evidence.length >= 5) return;
    const text = String(value).replace(/\s+/g, " ").trim().slice(0, 120);
    if (!text) return;
    const item: DayReadDecisionEvidence = { label: label.slice(0, 48), value: text };
    if (typeof when === "string" && /^\d{4}-\d{2}-\d{2}$/.test(when)) item.date = when;
    evidence.push(item);
  };
  const yesterday = Array.isArray(signals.recent_load) ? signals.recent_load[0] : null;
  push("Yesterday's load", yesterday?.load, yesterday?.date);
  if (signals.recovery_week?.state === "applied") {
    push(
      "Recovery overlay",
      "reduced volume",
      typeof signals.recovery_week.applied_on === "string" ? signals.recovery_week.applied_on : date
    );
  }
  if (signals.last_night?.total_min != null) {
    push("Last night's sleep", humanDuration(signals.last_night.total_min), signals.last_night.date);
  } else if (signals.avg_sleep_min != null) {
    const rolling = humanDuration(signals.avg_sleep_min);
    push("Rolling sleep", rolling ? `${rolling} a night on average` : null);
  }
  if (signals.checkin) push("Morning check-in", "athlete-reported recovery", date);
  const readiness = signals.fatigue?.readiness;
  if (readiness?.current_date) push("Readiness", readiness.freshness ?? "current", readiness.current_date);
  if (signals.context?.active?.[0]?.title) push("Life context", signals.context.active[0].title, date);
  if (signals.plan_selection?.reason) push("Plan selection", signals.plan_selection.reason, date);
  return evidence;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !key.startsWith("_"))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, stableValue(child)])
  );
}

export interface DayReadFingerprintContext {
  program_block: {
    goal: unknown;
    focus: unknown;
    phase: unknown;
    week_index: unknown;
    total_weeks: unknown;
    started_at: unknown;
  } | null;
  flexible_training_agenda?: {
    available: boolean;
    intents: Array<{
      kind: "easy" | "quality" | "long" | null;
      status: "open" | "completed" | null;
      suggested_date: string | null;
      window_start: string | null;
      window_end: string | null;
      target_distance_km: number | null;
      target_duration_min: number | null;
      target_zone: string | null;
      // A completed intent's duration/distance are the SAME provider telemetry
      // `logged_today` carries, so they are stored BANDED here (see
      // fingerprintDurationBucket / fingerprintDistanceBucket) rather than raw —
      // otherwise a re-sync nudging 8.02 → 8.03 km moved the hash through the
      // agenda after it had been banded out of `logged_today`. Banding is
      // idempotent, which matters: this shape is compacted twice (once into the
      // context, once inside dayReadInputFingerprint).
      completion: {
        date: string | null;
        duration_min: number | null;
        distance_km: number | null;
        intensity: "easy" | "quality" | null;
      } | null;
    }>;
  } | null;
}

function fingerprintNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Effort telemetry, BANDED. A provider re-sync rewrites the same effort with a
// slightly different number many times a day (8.02 → 8.03 km, 44 → 45 min), and a
// raw hash turned each rewrite into "the decision moved" — discarding a warm
// agentic read for an effort the athlete already did. Nothing branches on the
// exact number; only on roughly how big the effort was. So it is hashed in bands:
// ~5-minute buckets and ~0.5 km buckets. A genuinely different effort still lands
// in a different band; the same one re-synced does not.
function fingerprintDurationBucket(value: unknown): number | null {
  const minutes = fingerprintNumber(value);
  return minutes == null ? null : Math.round(minutes / 5) * 5;
}

function fingerprintDistanceBucket(value: unknown): number | null {
  const km = fingerprintNumber(value);
  return km == null ? null : Math.round(km * 2) / 2;
}

// `logged_today` is `{ sets: <count>, activities: [{type, duration_min, distance_km}] }`,
// and it is rewritten by EVERY logged set and every watch re-sync. The raw set
// count was the single biggest churn source in this hash: on a `done` day — whose
// decision enforceCompletionContract has already made terminal — set 12 → 13 → 14
// moved the fingerprint and cost the athlete a fresh agent run per set.
//
// That granularity is not a decision. The volume those sets represent already
// reaches this hash GRADED, as `today_load` (dayLoad ranks the day none/easy/
// moderate/hard, so a session crossing into real load still moves it) and as
// `trained_today`. What only `logged_today` can add is WHETHER any set exists at
// all and WHICH efforts are on the board — so the evening run appearing still
// retires the morning read, while another set of the lift already in progress does
// not. The activity list is sorted (its source query orders by id, which is not a
// decision) but never deduplicated: a second effort of the same shape is a second
// effort.
function compactLoggedTodayFingerprint(value: unknown): {
  any_sets: boolean;
  activities: Array<{ type: string | null; duration_bucket: number | null; distance_bucket: number | null }>;
} | null {
  if (!value || typeof value !== "object") return null;
  const logged = value as Record<string, any>;
  const activities = (Array.isArray(logged.activities) ? logged.activities : [])
    .map((activity: any) => ({
      type: typeof activity?.type === "string" ? activity.type.trim() || null : null,
      duration_bucket: fingerprintDurationBucket(activity?.duration_min),
      distance_bucket: fingerprintDistanceBucket(activity?.distance_km),
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { any_sets: (fingerprintNumber(logged.sets) ?? 0) > 0, activities };
}

// `recent_load` is the last five days' graded load, each day optionally carrying
// the FULL recovery-dose read for every session on it — per-set ids, weights, reps,
// RIR, a float volume ratio and a prose reason. Exactly two things in there can move
// TODAY's decision: each day's grade (the consecutive-loading-days rule) and whether
// YESTERDAY's recovery session was an overdose (the recovery_dose_overrun rule).
// Hashing the rest meant a late correction to one set three days ago, or a re-derived
// ratio, retired today's read.
function compactRecentLoadFingerprint(
  value: unknown
): Array<{ date: string | null; load: string | null; dose_overrun: boolean }> | null {
  if (!Array.isArray(value)) return null;
  return value.map((day: any) => ({
    date: typeof day?.date === "string" ? day.date : null,
    load: typeof day?.load === "string" ? day.load : null,
    dose_overrun: (Array.isArray(day?.recovery_dose) ? day.recovery_dose : []).some(
      (dose: any) => dose?.classification === "overdose"
    ),
  }));
}

function compactFlexibleAgendaFingerprint(
  value: unknown
): NonNullable<DayReadFingerprintContext["flexible_training_agenda"]> | null {
  if (!value || typeof value !== "object") return null;
  const agenda = value as Record<string, any>;
  const available = agenda.available === true;
  const intents = (Array.isArray(agenda.intents) ? agenda.intents : [])
    .map((intent: any) => {
      const kind =
        intent?.kind === "easy" || intent?.kind === "quality" || intent?.kind === "long" ? intent.kind : null;
      const status = intent?.status === "open" || intent?.status === "completed" ? intent.status : null;
      const completion =
        status === "completed" && intent?.completion && typeof intent.completion === "object"
          ? {
              date: typeof intent.completion.date === "string" ? intent.completion.date : null,
              duration_min: fingerprintDurationBucket(intent.completion.duration_min),
              distance_km: fingerprintDistanceBucket(intent.completion.distance_km),
              intensity:
                intent.completion.intensity === "easy" || intent.completion.intensity === "quality"
                  ? intent.completion.intensity
                  : null,
            }
          : null;
      return {
        kind,
        status,
        suggested_date: typeof intent?.suggested_date === "string" ? intent.suggested_date : null,
        window_start: typeof intent?.window_start === "string" ? intent.window_start : null,
        window_end: typeof intent?.window_end === "string" ? intent.window_end : null,
        target_distance_km: fingerprintNumber(intent?.target_distance_km),
        target_duration_min: fingerprintNumber(intent?.target_duration_min),
        target_zone: typeof intent?.target_zone === "string" ? intent.target_zone.trim() || null : null,
        completion,
      };
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { available, intents };
}

// dayRead()'s contract is that it never throws on missing data, and this runs
// inside it — either contextual read may fail independently without taking the
// Brief down. Only compact agenda facts rendered into the prompt participate;
// rationale/why/guidance narration never enters this identity.
function currentDayReadFingerprintContext(date: string): DayReadFingerprintContext {
  let programBlock: DayReadFingerprintContext["program_block"] = null;
  try {
    programBlock =
      (db
        .prepare(
          `SELECT goal, focus, phase, week_index, total_weeks, started_at
           FROM program_blocks WHERE status = 'active' ORDER BY id DESC LIMIT 1`
        )
        .get() as DayReadFingerprintContext["program_block"]) ?? null;
  } catch {
    programBlock = null;
  }
  let flexibleAgenda: DayReadFingerprintContext["flexible_training_agenda"] = null;
  try {
    flexibleAgenda = compactFlexibleAgendaFingerprint(flexibleTrainingAgenda(date));
  } catch {
    flexibleAgenda = null;
  }
  return { program_block: programBlock, flexible_training_agenda: flexibleAgenda };
}

// The fingerprint answers exactly one question: could the DECISION have changed?
// It is the trigger that throws away a warm agentic read for the deterministic
// floor, so anything hashed here that cannot move the decision is pure churn —
// a mid-day watch sync used to flip it (raw `avg_sleep_min`, the whole `fatigue`
// blob with its acute_load / hrv_vs_norm / readiness window average) and cost the
// athlete their coach's sentence plus a fresh brain_decisions row, for a read that
// never changed. Continuous measurements are therefore reduced to the PREDICATES
// the rules above actually branch on (short sleep, low readiness, an anticipated
// deload, a volume spike); athlete-entered context (check-ins, life events, plan
// selection) is kept whole because it only moves when the athlete acts.
//
// The same reduction applies to the TRAINING LOG, and for the same reason. The log
// moves far more often than the watch does: one evening produced ten-plus day_read
// recomputes between 20:30 and 23:45 — one agent call every two or three minutes,
// on a day whose read was already terminal ("done") — because `logged_today` was
// hashed whole and its raw set COUNT moved on every single logged set. What a
// logged set can genuinely change about today's decision already arrives here in
// banded form: `today_load` is the day's grade (none/easy/moderate/hard) and
// `trained_today` is the fact. So `logged_today` keeps only "is there any set" plus
// the day's efforts by type and banded size, and `recent_load` keeps only each
// day's grade plus yesterday's overdose flag (see the compact* helpers above).
// The documented intent is preserved exactly: a NEW activity — the evening run
// appearing — still moves this hash; another set of the lift already underway, and
// a watch re-sync rewriting the same effort, do not.
//
// Pure over the supplied read and explicit block context. Fuel deliberately stays
// out: it has its own both-present serve-time comparator, which preserves cached
// rows written before the visible fuel signal existed.
export function dayReadInputFingerprint(
  date: string,
  read: Pick<DayRead, "kind" | "focus" | "signals">,
  context: DayReadFingerprintContext = { program_block: null, flexible_training_agenda: null }
): string {
  const signals = read.signals ?? {};
  const shortNight = (minutes: unknown): boolean => {
    const value = Number(minutes);
    return Number.isFinite(value) && value > 0 && value < 360;
  };
  // The drive read's `focus` is not a decision, it is the RENDERED due list — and the
  // due list moves every time a set is logged, which is precisely what a partially
  // completed session does. Hashing it discarded the warm Brief and queued a fresh
  // agent call mid-session on a decision that had not changed (log two rows of curls
  // and "Back and biceps" becomes "Back and rear shoulders"). So this read hashes a
  // stable token in the focus slot instead. Scoped to the drive read alone: every
  // other read still hashes its focus exactly as before, because for them the focus
  // IS part of the decision (which body region the day is about) rather than a
  // read-time rendering of a list that is being consumed as the day goes on. The
  // due list itself is out of the hash for the same reason (see `training_drive`).
  const driveRead = !!(read.signals as any)?.training_drive_push;
  const input = {
    date,
    baseline_kind: read.kind,
    focus: driveRead ? "training_drive_push" : (read.focus ?? null),
    program_block: context.program_block,
    flexible_training_agenda: compactFlexibleAgendaFingerprint(context.flexible_training_agenda),
    recovery_week: signals.recovery_week ?? null,
    recent_load: compactRecentLoadFingerprint(signals.recent_load),
    // Today's load GRADE — already the banded form of today's volume, and what the
    // rules branch on directly. A session crossing from easy into moderate/hard
    // moves it; the sets inside one grade do not. Kept whole.
    today_load: signals.today_load ?? null,
    trained_today: signals.trained_today ?? null,
    logged_today: compactLoggedTodayFingerprint(signals.logged_today),
    // The chronic-sleep watch branches on the <6h average, not the average itself.
    low_sleep: !!signals.low_sleep,
    // Likewise the acute branch: a fresh night is short, or it isn't.
    short_last_night: shortNight(signals.last_night?.total_min),
    checkin: signals.checkin ?? null,
    fatigue: {
      anticipate_deload: !!signals.fatigue?.anticipate_deload,
      low_readiness: !!signals.fatigue?.low_readiness,
    },
    volume_spike: !!signals.endurance_volume?.volume_spike,
    // The athlete's standing posture. It is a decision INPUT — it selects which rules
    // are available on a stacked-days morning — so flipping it must throw away the warm
    // read rather than leave a rest on screen the floor would no longer produce. The
    // DUE-group list deliberately stays out: it moves every time a set is logged, and
    // hashing it would churn a read that has not changed.
    //
    // The key is OMITTED, not nulled, on the default `steady` posture, which serves the
    // same end as the `fuel` comparator in day-read-use-case.ts: a row cached before
    // this signal existed carries no posture at all, and the mere APPEARANCE of a new
    // key must not invalidate every warm read on the estate once, on deploy day. Every
    // pre-deploy read was a steady read by definition, so omitting the key there makes
    // the two hashes identical — while a genuine steady→push flip (or push→steady)
    // still adds or removes the key and still throws the warm read away. Unlike a
    // serve-time both-present comparator, this also catches the athlete who flips to
    // push on deploy day, whose cached row has no key to compare against.
    ...(signals.training_drive && signals.training_drive !== "steady"
      ? { training_drive: signals.training_drive }
      : {}),
    context: signals.context ?? null,
    // The unified signal state's DECISION, not its narration: `reason`/`reasons`/
    // `confidence` restate the same posture in different words as evidence lines
    // come and go (an HRV field arriving mid-day rewrites the sentence and lifts
    // confidence without changing what to do), which is churn, not a new decision.
    //
    // `directives` is therefore selected FIELD BY FIELD rather than spread whole, so
    // that `directives.training_source` stays out. The source names WHICH dimension
    // produced the directive — it selects the athlete-facing lead, but it is not
    // itself a decision, and the inputs that MOVE it (recent_load, checkin, fatigue,
    // logged_today, today_load) are already hashed above. So a genuine change of
    // brake already moves this hash through its own cause; hashing the source on top
    // adds no signal and discards a warm agentic read on the one case it uniquely
    // catches — the same `hold_aggression` changing hands between two dimensions,
    // which is not a new decision. A new directive field must be added here
    // deliberately; that is the point of listing them.
    signal_action: signals.signal_state?.action
      ? {
          posture: signals.signal_state.action.posture ?? null,
          directives: signals.signal_state.action.directives
            ? {
                training: signals.signal_state.action.directives.training ?? null,
                fueling: signals.signal_state.action.directives.fueling ?? null,
                schedule: signals.signal_state.action.directives.schedule ?? null,
              }
            : null,
        }
      : null,
    underfueling: signals.underfueling
      ? {
          state: signals.underfueling.state ?? null,
          action: signals.underfueling.action ?? null,
        }
      : null,
    // Hybrid sequencing can change the athlete-facing agent sentence even when
    // the day posture stays the same. Keep only the three boolean decisions:
    // moved/completed flexible-agenda intentions then reconcile a stale warm
    // read without hashing the agenda's narration or raw plan.
    hybrid: signals.hybrid
      ? {
          cardio_today: !!signals.hybrid.cardio_today,
          hard_cardio_yesterday: !!signals.hybrid.hard_cardio_yesterday,
          protect_run_next: !!signals.hybrid.protect_run_next,
        }
      : null,
    plan_selection: signals.plan_selection ?? null,
  };
  return createHash("sha256")
    .update(JSON.stringify(stableValue(input)))
    .digest("hex")
    .slice(0, 24);
}

function finalizeDeterministicRead(
  date: string,
  outcome: DayReadRuleOutcome,
  read: Omit<DayRead, "decision" | "input_fingerprint" | "computed_at">
): DayRead {
  const computedAt = new Date().toISOString();
  const decision: DayReadDecision = {
    rule_code: outcome.code,
    basis: "deterministic",
    baseline_kind: read.kind,
    // Rotated by calendar day so a stable input does not print one identical
    // sentence for a week (see DayReadRuleOutcome.reasons).
    reason: pickDayVariant(outcome.reasons, date, outcome.code),
    evidence: boundedEvidence(read.signals, date),
    computed_at: computedAt,
  };
  return {
    ...read,
    decision,
    computed_at: computedAt,
    input_fingerprint: dayReadInputFingerprint(
      date,
      read as Pick<DayRead, "kind" | "focus" | "signals">,
      currentDayReadFingerprintContext(date)
    ),
  };
}

// ---------- the ONE planning signal state ----------
// `planningSignalState` takes nine OPTIONAL inputs, and three of them carry
// safety_override CONSTRAINTS the athlete-facing read must never be blind to:
// joint pain and the low-performance flag arrive through `trainingSignals`, an
// anticipated reset through `programState.mesocycle`. "Optional" means a caller
// that omits them silently builds a WEAKER state — no error, no warning — which
// is exactly how the Brief came to say "train" on a day getCoachContext was told
// to protect (thin: posture=train/proceed; rich: posture=rest/recover, with
// health_constraints and load_tolerance both constrained).
//
// So there is exactly ONE builder, it is always rich, and it is memoized per
// (date, request) under the same brain-snapshot key getCoachContext already used.
// Within one request the Brief's deterministic baseline, the prompt's baseline,
// the server-policy clamps, the persisted `signals`/`input_fingerprint` and the
// coach context therefore describe the SAME state — the rich/thin seam cannot
// reopen. Outside a request scope (the scheduler's warm) `brainSignal` is a
// pass-through, so callers that must agree thread the baseline explicitly
// instead; see computeDayRead → buildDayReadPrompt.
//
// Every producer is probed INDIVIDUALLY behind try/catch: dayRead() is on the
// morning-open path and must ALWAYS return, so a thrower degrades that one input
// rather than failing the whole read. A caller may pass a value it already holds
// (all of these are expensive); the memo makes the first caller in a request
// authoritative, and every caller derives them from the same producers for the
// same date, so which one lands first does not change the decision.
export interface DayPlanningSignalInputs {
  recovery?: any;
  checkin?: any;
  trainingSignals?: any;
  programState?: any;
  expenditure?: any;
  underfueling?: any;
  context?: any;
  contextEvents?: any[];
  completedToday?: boolean;
  runIntensity?: any;
}

function signalInput<T>(compute: () => T, fallback: T): T {
  try {
    return compute();
  } catch {
    return fallback;
  }
}

export function dayPlanningSignalState(date: string, provided: DayPlanningSignalInputs = {}): UnifiedSignalState {
  return brainSignal(`signal_state:${date}`, () => {
    // Recovery is NOT memoized under getCoachContext's `recovery:14` key: that key
    // holds a summary built over an explicitly-passed Garmin window, and silently
    // seeding it from here would let a differently-scoped fetch win the race.
    const recovery = provided.recovery ?? signalInput(() => getRecoverySummary(14), null);
    // Today keeps the BARE memo keys below — they ARE getCoachContext's, and sharing
    // them is what keeps one Brief request from building these expensive producers
    // twice no matter which consumer asks first. A read of an EARLIER date gets its
    // own keys and its own date-bounded inputs, because "the twenty newest sessions"
    // and "the last 21 completed days" are both measured from NOW: unscoped, a read
    // of last Tuesday was derived from work logged after it, and called every lift
    // stale by today's calendar. Same class of bug as the program-state one below.
    const isLiveDate = date === localDateISO();
    const trainingSignalsView =
      provided.trainingSignals ??
      signalInput(
        () =>
          brainSignal(isLiveDate ? "training_signals" : `training_signals:${date}`, () =>
            trainingSignals(
              brainSignal(isLiveDate ? "recent_sessions:20" : `recent_sessions:20:${date}`, () =>
                getRecentSessions(20, isLiveDate ? {} : { through: date })
              ) as any[],
              date
            )
          ),
        null
      );
    // Keyed to the date being READ, not to "now". getCoachContext only ever asks
    // for today, so today keeps its bare `program_state` key and stays shared; a
    // read of an earlier date gets that date's mesocycle instead of one measured
    // from today (which would tell a day inside an applied recovery week that a
    // reset was months overdue). getProgramState defaults to today for `undefined`,
    // so passing the date through is equivalent for the common case.
    const programState =
      provided.programState ??
      signalInput(
        () =>
          brainSignal(isLiveDate ? "program_state" : `program_state:${date}`, () => getProgramState(date, recovery)),
        null
      );
    const expenditure =
      provided.expenditure ??
      signalInput(
        () =>
          brainSignal(isLiveDate ? "expenditure:21" : `expenditure:21:${date}`, () =>
            estimateExpenditure(21, isLiveDate ? {} : { asOf: date })
          ),
        null
      );
    return planningSignalState({
      date,
      recovery,
      checkin: provided.checkin ?? signalInput(() => getCheckinByDate(date), null),
      trainingSignals: trainingSignalsView,
      programState,
      expenditure,
      underfueling: provided.underfueling ?? signalInput(() => currentUnderfuelingRead(date), null),
      // Keyed to the date being read for the same reason program state is: the window
      // is measured backwards from THAT day, and a read of last Tuesday must not be
      // handed the fortnight that ends today. Memoized so the signal state and
      // `run_variety` (which carries the same read's compact form) build it once.
      runIntensity:
        provided.runIntensity ??
        signalInput(() => brainSignal(`run_intensity:${date}`, () => runIntensityDiscipline(date)), null),
      context: provided.context ?? signalInput(() => activeContextEffect(date), null),
      contextEvents: provided.contextEvents ?? signalInput(() => planningContextEvents(date), []),
      completedToday: provided.completedToday ?? false,
    });
  });
}

// ---------- which rests the outcome loop may soften ----------
// The rest reads whose case is an ACCUMULATION argument — enough loading days have
// stacked up, the watch read low, the athlete said they felt flat. Those are exactly
// the reads the athlete has been overruling successfully, and they are reversible: a
// softened one still asks for an easy day, and tomorrow's read sees today's log.
//
// Everything else is excluded ON PURPOSE and the exclusions are the safety contract:
//   • `acute_sleep_corroborated` — a short night on top of a short stretch is FRESH
//     evidence about today, not a standing judgement. History cannot argue with it.
//   • `recovery_dose_overrun` — yesterday measurably exceeded a reduced week's dose.
//     Also a fact about the last 24 hours.
//   • anything clinical — see clinicallyDriven() below. That floor is absolute.
//
// WHICH OF THESE ACTUALLY KEYS A READ, verified rather than assumed (the earned-rest
// rule below carries the matching note, and the two used to disagree). On the
// PRODUCTION path — `dayRead(date)`, where the signal state is built rich from the
// same DB the rule reads — `low_readiness_rest` and `felt_run_down_rest` never key
// anything: a low check-in becomes a safety_override constraint and a subdued
// readiness reading a recovery constraint, so the unified protect rule ABOVE the
// earned-rest rule wins the posture first and the read ships as
// `acute_signal_protection` (rest and easy respectively).
//
// They are listed here anyway because they are not dead — they are reachable through
// the one documented seam that can separate the two, a caller that SCOPES the whole
// state via `dayRead`'s `unifiedState` argument while the athlete's check-in or
// readiness reading still sits in the DB. That path still produces a genuine rest
// under those codes, and an accumulation rest is exactly what softening is for, so
// dropping them would silently make one shape of rest unsoftenable. Membership is
// pinned by test/dayReadPushLadder.test.js in both directions.
const SOFTENABLE_REST_CODES: ReadonlySet<string> = new Set([
  DAY_READ_OUTCOMES.accumulated_load_rest.code,
  DAY_READ_OUTCOMES.low_readiness_rest.code,
  DAY_READ_OUTCOMES.felt_run_down_rest.code,
  DAY_READ_OUTCOMES.acute_signal_protection.code,
]);

// ---------- …and which EASY reads it may open (owner ruling, 2026-08-17) ----------
// The mirror of the set above, one rung up. Same shape of argument: these are the easy
// reads whose case is an ACCUMULATION — a sleep trend, a week's running that ramped, a
// board of soft signals — never a fact about the last 24 hours and never anything
// clinical. Those are exactly the reads an experienced athlete has been outrunning
// successfully, and opening one is reversible: a train read is still a suggestion, and
// tomorrow's model sees how today actually went.
//
// EVERY easy-producing rule code, and where each landed:
//   • acute_signal_protection  — SOFTENABLE. The dominant soft-signal easy read. Its
//     clinical shapes are already excluded by clinicallyDriven() at the call site, so
//     what is left here is the accumulation case this rule is for.
//   • chronic_sleep_watch      — SOFTENABLE. A trend, explicitly "nothing acute this
//     morning". (Its acute sibling, acute_sleep_corroborated, produces a REST and is
//     excluded from the rest ladder for the same reason: fresh evidence about today.)
//   • endurance_volume_spike   — SOFTENABLE. A week-shaped mileage argument, and the
//     kind of week an athlete who is absorbing it demonstrably trains through.
//   • logged_light_work_today  — EXCLUDED. Not a brake at all: it acknowledges movement
//     ALREADY logged today. Opening it would ask for a second session on the strength
//     of evidence about other mornings.
//   • unprogrammed_easy_day    — EXCLUDED. There is no session to open. The floor is
//     saying nothing is due, which history cannot argue with.
//   • outcome_feedback_soften  — EXCLUDED, and this one is a safety rule rather than a
//     taste: it is a rest this loop ALREADY softened once. Allowing it would chain the
//     two ladders into rest → easy → train inside one window, and each ladder moves
//     exactly one step by design.
// Recovery-week and symptom/illness reads reach neither set: `recoveryWeek` and
// clinicallyDriven() are checked at the call site, whichever code produced the day.
const SOFTENABLE_EASY_CODES: ReadonlySet<string> = new Set([
  DAY_READ_OUTCOMES.acute_signal_protection.code,
  DAY_READ_OUTCOMES.chronic_sleep_watch.code,
  DAY_READ_OUTCOMES.endurance_volume_spike.code,
]);

// The hard ceiling on the training-drive read. Three stacked loading days is where the
// accumulated-load rest starts, and this is where the preference stops being able to
// answer it: at five days running the rest stands whatever the athlete has asked for
// and whatever the evidence says, because the whole point of a floor is that it is not
// negotiable all the way up. Named rather than inlined so the bound is greppable and
// test/dayRead.test.js can pin both sides of it.
const PUSH_DRIVE_CONSEC_CEILING = 5;
// Readiness that positively CORROBORATES the day, as opposed to merely failing to
// object. `lowReadiness` (the rest trigger) sits at <35; this is a long way clear of
// it, because the wearable path is the one that can earn the read without a single
// rated session behind it and so has to clear a higher bar than "not alarming".
const PUSH_DRIVE_READINESS_FLOOR = 60;

// Is anything clinical in play today? Probed three ways because the same constraint
// can reach the read by three routes, and a single check would miss two of them:
// a fresh constraint item (an injury, an illness, a painful joint — the same probe
// the work-around sentence uses), the DRIVING evidence behind today's posture
// (`source_dimensions`, which is where a health item that only contributed to the
// arbitration shows up), and the dimension's own standing status. Any of them and
// the day is not softenable, whichever rule produced the rest.
function clinicallyDriven(signalState: UnifiedSignalState, healthWorkaround: unknown): boolean {
  const health = signalState.dimensions.health_constraints;
  return (
    !!healthWorkaround ||
    signalState.action.source_dimensions.includes("health_constraints") ||
    health.status === "constrained" ||
    health.status === "watch"
  );
}

// Deterministic baseline (T1 layers the agentic sentence + buildDayReadPrompt on
// top). Rules: rest if >=3 consecutive training days OR recovery clearly low;
// else train the suggested plan day; else easy. Never throws on missing data.
//
// PARAMETER CONTRACT: every optional argument overrides exactly its OWN input and
// nothing else. Supplying one never suppresses the others, and never narrows what
// the read may look at — `dayRead` reads the training log, plan, activities,
// check-ins, context events and fuel state straight from the DB regardless of what
// any caller passes. So `dayRead(d, {has_data:false, recovery:{}})` says "this
// athlete has no wearable recovery signal", NOT "read nothing else"; their logged
// sessions are still real history the read is supposed to see. `recovery` exists
// only to spare a caller that already holds the 14-day summary a redundant fetch.
// `unifiedState` is the ONE parameter that scopes the whole signal state — pass it
// to take full control; omit it and the state is built rich (see
// dayPlanningSignalState). Anything else would be exactly the failure mode this
// function was just fixed for: an optional argument silently changing what the
// athlete-facing read is allowed to know.
export function dayRead(
  date?: string,
  recovery?: any,
  unifiedState?: UnifiedSignalState,
  underfuelingSnapshot?: UnderfuelingRead
): DayRead {
  const d = date || localDateISO();
  const recoveryWeek = activeRecoveryWeek(d);
  // The athlete's standing posture toward an accumulated-load rest. A PREFERENCE, and
  // read like one: it can only ever select among reads the evidence already permits
  // (see the drive rule below), never produce one on its own. Fail-soft to the floor's
  // own rhythm — dayRead never throws, and a settings read that fails must not be able
  // to hand out a training day.
  const trainingDrive = (() => {
    try {
      return getSettings().training_drive;
    } catch {
      return "steady" as const;
    }
  })();

  // Discipline shapes what "a training day" means for the consecutive-days +
  // earned-rest rules. For a strength athlete a logged lifting session counts;
  // for an endurance/hybrid athlete a real cardio effort (a run/ride) is also a
  // training day — otherwise a runner's whole week is invisible and the Brief
  // keeps suggesting fresh sessions on top of hard mileage. Default 'strength'
  // keeps the existing behavior byte-for-byte.
  const discipline = getPrimaryDiscipline();
  // Explicit ordered intent is authoritative. Legacy profiles still resolve to
  // their former discipline behavior through getTrainingIntent()'s derived
  // fallback, while a strength-labelled athlete with supporting endurance no
  // longer has their real rides/runs disappear from the recovery rhythm.
  const countsCardio = getTrainingIntent().endurance_role !== "none";

  // Lifting-session days (a logged set) — still used for "did they train today".
  const sessionDates = new Set(
    (
      db
        .prepare(`SELECT DISTINCT s.date AS dt FROM sessions s JOIN logged_sets l ON l.session_id = s.id`)
        .all() as any[]
    ).map((r) => r.dt)
  );

  // Intensity-aware earned-rest count. The old rule treated ANY logged day as a
  // hard "training day", so a 20-min mobility session (RIR 8-10, no load) or a
  // short easy run stacked toward a forced rest exactly like a heavy lift. Now we
  // grade each day's actual LOAD (hard/moderate/easy — see training-read.dayLoad)
  // and count only genuinely LOADING days: a real recovery day BREAKS the streak,
  // which is how a coach reads it. The per-day grades ride along in `signals` so
  // the agentic layer understands the rhythm too, not just the bare count.
  // Classify each historical day against ITS calendar state. Using only today's
  // active window made the first build day retroactively grade the preceding
  // compliant deload sessions as ordinary loading.
  const recoveryByDate = new Map<string, ReturnType<typeof activeRecoveryWeek>>();
  const recoveryForDate = (iso: string) => {
    if (!recoveryByDate.has(iso)) recoveryByDate.set(iso, activeRecoveryWeek(iso));
    return recoveryByDate.get(iso) ?? null;
  };
  // A genuinely HARD cardio day loads recovery for EVERY athlete, so it counts as a
  // loading day even for a strength-primary lifter (whose discipline otherwise makes
  // dayLoad ignore cardio). Easy strolls clear none of hardCardioDay's bars, so they
  // never count. Endurance/hybrid athletes already count all their cardio via dayLoad,
  // so the bump is a no-op for them (and hardCardioDay is never consulted). The recent
  // cardio-load median is computed once and threaded, avoiding a per-day re-query.
  const cardioLoadMedian = countsCardio ? null : recentCardioLoadMedian(d);
  const gradeDay = (iso: string, recoveryWeekActive: boolean): TrainingLoad | "none" => {
    const base = dayLoad(iso, { countsCardio, recoveryWeekActive });
    if (base === "hard") return base;
    if (!countsCardio && hardCardioDay(iso, cardioLoadMedian)) return "moderate";
    return base;
  };
  const loadAt = (iso: string): TrainingLoad | "none" => gradeDay(iso, !!recoveryForDate(iso));
  const recentLoads: { date: string; load: TrainingLoad | "none"; recovery_dose?: any[] }[] = [];
  let consec = 0; // consecutive LOADING (hard/moderate) days ending yesterday
  let streakOpen = true;
  for (let back = 1; back <= 10; back++) {
    const iso = new Date(new Date(d + "T00:00:00Z").getTime() - back * 864e5).toISOString().slice(0, 10);
    const load = loadAt(iso);
    if (back <= 5) {
      const dose = recoveryForDate(iso)
        ? (db.prepare(`SELECT id FROM sessions WHERE date = ? ORDER BY id`).all(iso) as any[]).map((row) =>
            recoverySessionDose(Number(row.id))
          )
        : [];
      recentLoads.push({ date: iso, load, ...(dose.length ? { recovery_dose: dose } : {}) });
    }
    const loading = load === "hard" || load === "moderate";
    if (streakOpen && loading) consec++;
    else streakOpen = false;
    if (!streakOpen && back > 5) break;
  }
  const yesterdayRecoveryOverdose = !!recentLoads[0]?.recovery_dose?.some(
    (dose: any) => dose?.classification === "overdose"
  );

  // Endurance volume spike: a weekly-mileage jump well above the prior weeks'
  // average is its own earned-rest signal (consecutive-day counting can miss a
  // single very-long effort). Deterministic + null-safe; only for endurance/hybrid.
  let volumeSpike = false;
  let lastWeekKm: number | null = null;
  if (countsCardio) {
    const runSport = activitySportWhere("activities", RUN_SPORT_PATTERNS);
    const weekKm = (endIso: string): number => {
      const end = new Date(endIso + "T00:00:00Z").getTime();
      const start = new Date(end - 6 * 864e5).toISOString().slice(0, 10);
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(distance_km), 0) AS km FROM activities
            WHERE date >= ? AND date <= ? AND (${runSport.sql})`
        )
        .get(start, endIso, ...runSport.params) as any;
      return Math.round(Number(row?.km ?? 0) * 10) / 10;
    };
    const yesterdayIso = new Date(new Date(d + "T00:00:00Z").getTime() - 864e5).toISOString().slice(0, 10);
    lastWeekKm = weekKm(yesterdayIso);
    // The three prior weeks' average (the chronic base), ending a week back.
    const priorEnds = [7, 14, 21].map((n) =>
      new Date(new Date(d + "T00:00:00Z").getTime() - n * 864e5).toISOString().slice(0, 10)
    );
    const priorKm = priorEnds.map(weekKm);
    const chronic = priorKm.reduce((a, b) => a + b, 0) / priorKm.length;
    // A meaningful spike: this week clearly above the chronic base (and a real
    // amount of running, so a near-zero base doesn't trip on a single short run).
    volumeSpike = lastWeekKm >= 25 && chronic > 0 && lastWeekKm > chronic * 1.5;
  }

  // Recovery signal (unified). "clearly low" = short sleep or a low subjective
  // check-in for the day. All optional — absent signals never force rest. The
  // window is always "last 14 days from now" (date-independent), so a caller that
  // already has it (getCoachContext) can pass it in to avoid a redundant fetch.
  const rec = recovery ?? getRecoverySummary(14);
  const checkin = getCheckinByDate(d) as any;
  // "Last night" must actually be RECENT. A wearable can stop syncing sleep for weeks
  // (a 25-day-old night is not last night), and feeding a stale night to the Brief is
  // what made it assert "you slept fine" off month-old data. Treat an old night as
  // ABSENT so the read never claims how they slept from data it doesn't have.
  // The bound itself now lives in SENSOR_MAX_AGE_DAYS, so the signal state cannot
  // keep voicing a night this read has already dropped — and the CHECK now lives
  // inside latestSleep(), which takes the bound as a required argument, so a future
  // second caller cannot forget it the way an outside gate invited.
  const lastNight = latestSleep(SENSOR_MAX_AGE_DAYS.sleep, d);
  const avgSleepMin = rec?.recovery?.avg_sleep_min ?? null;
  const lowSleep = avgSleepMin != null && avgSleepMin > 0 && avgSleepMin < 360; // <6h average
  const freshShortSleep =
    lastNight?.total_min != null && Number(lastNight.total_min) > 0 && Number(lastNight.total_min) < 360;
  const corroboratedLowSleep = lowSleep && freshShortSleep;
  const lowSubjective =
    checkin &&
    ((checkin.energy != null && checkin.energy <= 2) || (checkin.sleep_feel != null && checkin.sleep_feel <= 2));

  // ---- predictive deload anticipation ----
  // Don't wait for 3 hard days to already be logged: read the acute-vs-chronic
  // recovery DRIFT (HRV below their norm, resting HR above it) plus rising acute
  // training load, and ANTICIPATE the reset a day or two early. This NEVER forces
  // rest — it's a soft heads-up the agent can voice ("two more hard days and
  // you'll likely want a reset"). Null-safe: no baseline → no anticipation.
  const dl = rec?.delta ?? null;
  let recoveryDrift = 0; // count of signals pointing the wrong way vs the athlete's own norm
  // HRV running meaningfully below baseline (>~5% of baseline) is a fatigue tell.
  if (
    dl?.hrv != null &&
    rec?.baseline?.hrv != null &&
    rec.baseline.hrv > 0 &&
    dl.hrv < -Math.max(2, rec.baseline.hrv * 0.05)
  )
    recoveryDrift++;
  // Resting HR running above baseline (>~2 bpm) the same way.
  if (dl?.rhr != null && dl.rhr > 2) recoveryDrift++;
  // Sleep running short vs their norm.
  if (dl?.sleep != null && dl.sleep < -25) recoveryDrift++;
  // Acute training load is a CURRENT number the coach reasons and speaks from, but
  // `getRecoverySummary` resolves it as "the newest non-null row in the last 14 days"
  // — so a watch that stopped syncing kept handing the prompt a fortnight-old load as
  // though it were today's. Past its bound it reads as absent, like every other
  // sensor datum here.
  const acuteLoadQuality = rec?.quality?.acute_load ?? rec?.recovery?.quality?.acute_load ?? null;
  const acuteLoad = sensorIsCurrent("training_load", acuteLoadQuality?.latest_date ?? null, d)
    ? (rec?.recovery?.acute_load ?? null)
    : null;
  // Readiness is a CURRENT decision signal only when its dated reading is today or
  // yesterday relative to the day being read. The multi-day average remains useful
  // context, but can never force a current recommendation (and a stale current value
  // cannot either).
  const readinessQuality = rec?.quality?.training_readiness ?? rec?.recovery?.quality?.training_readiness ?? null;
  const readinessCurrent = rec?.recovery?.training_readiness ?? null;
  const readinessDate = readinessQuality?.latest_date ?? null;
  const readinessFresh = sensorIsCurrent("training_readiness", readinessDate, d);
  const lowReadiness = readinessFresh && readinessCurrent != null && Number(readinessCurrent) < 35;
  const readinessAverage = rec?.recovery?.avg_training_readiness ?? null;
  // Mounting fatigue: at least 2 straight training days AND recovery drifting the
  // wrong way (or readiness low) — i.e. heading toward a reset but not there yet.
  const buildingFatigue = consec >= 2 && (recoveryDrift >= 1 || lowReadiness);
  // A soft, plain-language anticipation note (never a verdict). Only when we're
  // building toward the rest trigger but the floor hasn't tripped it yet.
  const daysToLikelyReset = consec >= 3 ? 0 : Math.max(0, 3 - consec);
  const anticipateDeload = buildingFatigue && consec < 3;

  // What's already been logged for `d` — a lifting session (sets) or a real
  // activity (a run/ride/class). The Brief must reflect this: once you've moved
  // today it should acknowledge it, not keep suggesting a fresh session as if the
  // day were blank. A "real" activity clears a light bar (≥20 min or any logged
  // distance) so an incidental short walk doesn't suppress a genuinely-due day.
  const todaysActivities = db
    .prepare(`SELECT type, duration_min, distance_km FROM activities WHERE date = ? ORDER BY id DESC`)
    .all(d) as any[];
  const todaysSetCount = Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS n FROM logged_sets l JOIN sessions s ON s.id = l.session_id WHERE s.date = ?`)
        .get(d) as any
    )?.n ?? 0
  );
  const bigActivity =
    todaysActivities.find((a) => (a.duration_min != null && Number(a.duration_min) >= 20) || a.distance_km != null) ||
    null;

  // Active lifestyle/context (injury, illness, travel, a late night) as of `d`. The
  // deterministic floor now READS it — an active injury isn't just prompt prose, it
  // biases the read (a caveat on the train branch, never a forced rest — you can
  // usually train around it). Null-safe; absent context changes nothing.
  const contextEvents = (() => {
    try {
      return planningContextEvents(d);
    } catch {
      return [];
    }
  })();
  const ctx = (() => {
    try {
      return activeContextEffect(d, contextEvents);
    } catch {
      return null;
    }
  })();
  const reduceItem = ctx?.active?.find((a) => a.reduce_load) ?? null;

  // HOW the athlete wears the sensor, and therefore what today's silence means.
  // Derived from the cadence Track C hangs off each recovery quality entry, so no
  // extra query and no second opinion about the same series. Null when the
  // recovery snapshot predates that field (a caller passing a hand-built
  // `recovery`), which leaves every downstream surface exactly where it is today.
  // The FIELD rides along because the words depend on it: the densest series is
  // routinely resting HR, and only the sleep series may be spoken of as a night.
  const recoveryCadenceEntry = dominantSensorCadenceEntry(rec?.quality ?? rec?.recovery?.quality ?? {});
  const recoveryAbsence = recoveryCadenceEntry
    ? wearAbsenceView(recoveryCadenceEntry.cadence, d, recoveryCadenceEntry.field)
    : null;
  // Absence prose describes a day with NOTHING to lean on, and was being written on
  // every day regardless — including days whose wearable data was driving the read,
  // where it contradicted the read beside it. Consumers all gate on
  // `has_recovery_data === false`, so it stayed off the screen; it is persisted into
  // the decision ledger either way, and nothing gates it there.
  const lacksBearingReading = !rec?.has_data;

  const signals = {
    // Active context the brain is accounting for (injury/illness/travel), or null.
    context: ctx?.any
      ? {
          reduce_load: !!ctx.reduce_load,
          expect_worse_sleep: !!ctx.expect_worse_sleep,
          transient_inflammation: !!ctx.transient_inflammation,
          active: ctx.active.map((a) => ({ title: a.title, kind: a.kind, reason: a.reason })).slice(0, 3),
        }
      : null,
    // Consecutive genuinely-LOADING (hard/moderate) days ending yesterday — a
    // recovery/easy day breaks the streak (it's earned rest, not stacked fatigue).
    consecutive_training_days: consec,
    // The athlete's standing posture, carried so the read's provenance says which
    // rules were even available this morning — and hashed into the input fingerprint,
    // so flipping the control regenerates the Brief instead of leaving yesterday's
    // rest warm on a morning it can no longer produce.
    training_drive: trainingDrive,
    // The last few days' actual load grade (hard/moderate/easy/none), so the read
    // reflects intensity, not just "did something get logged".
    recent_load: recentLoads,
    recovery_week: recoveryWeek,
    // Discipline-aware context (v35): what "training day" counts as, and the
    // endurance volume read when it applies. Strength athletes see discipline
    // 'strength' + a null volume block (today's behavior).
    discipline,
    endurance_volume: countsCardio ? { last_week_km: lastWeekKm, volume_spike: volumeSpike } : null,
    avg_sleep_min: avgSleepMin,
    low_sleep: lowSleep,
    checkin: checkin
      ? { energy: checkin.energy, sleep_feel: checkin.sleep_feel, soreness: checkin.soreness, mood: checkin.mood }
      : null,
    has_recovery_data: !!rec?.has_data,
    // The wear pattern behind that boolean, plus the ONE athlete-facing line each
    // surface says when today carries no reading. The WORDS are computed here
    // rather than in the PWA on purpose: they are a rotating variant set drawn
    // from the same vocabulary the rest of the read speaks (wear-pattern-voice.ts),
    // and a second copy in the client is precisely how "none synced yet" survived
    // in front of an athlete whose watch was working exactly as they use it.
    // Null when the recovery snapshot carries no cadence — every consumer falls
    // back to what it says today.
    recovery_cadence: recoveryAbsence
      ? {
          pattern: recoveryAbsence.pattern,
          shape: recoveryAbsence.shape,
          readings: recoveryAbsence.readings,
          window_days: recoveryAbsence.window_days,
          last_reading_date: recoveryAbsence.last_reading_date,
          last_reading_age_days: recoveryAbsence.age_days,
          median_gap_days: recoveryAbsence.median_gap_days,
          // A real, current habit rather than two readings left over from last
          // spring — the predicate a surface uses before deciding to stay quiet.
          working_episodic: isWorkingEpisodicPattern(recoveryAbsence),
          // Null on a day that HAS a bearing reading — there is no absence to word.
          absence_state: lacksBearingReading ? wearAbsenceRowState(recoveryAbsence, d) : null,
          absence_why: lacksBearingReading ? wearAbsenceWhy(recoveryAbsence, d) : null,
        }
      : null,
    // Last night's single-night sleep architecture + HRV (plain numbers + a calm
    // one-line `text`), so the Brief can speak to LAST NIGHT, not just the window.
    // null when the most recent night is too old to be "last night" (see above).
    last_night: lastNight,
    logged_today: {
      sets: todaysSetCount,
      activities: todaysActivities.map((a) => ({
        type: a.type,
        duration_min: a.duration_min,
        distance_km: a.distance_km,
      })),
    },
    // Predictive deload anticipation — a soft, forward-looking fatigue read.
    // anticipate_deload true ⇒ heading toward a reset (recovery drifting below the
    // athlete's own norm while training days stack up), but the rest floor hasn't
    // tripped yet. days_to_likely_reset is a gentle countdown, never a deadline.
    fatigue: {
      anticipate_deload: anticipateDeload,
      days_to_likely_reset: anticipateDeload ? daysToLikelyReset : null,
      recovery_drift_signals: recoveryDrift,
      acute_load: acuteLoad,
      low_readiness: lowReadiness,
      hrv_vs_norm: dl?.hrv ?? null,
      rhr_vs_norm: dl?.rhr ?? null,
      sleep_vs_norm: dl?.sleep ?? null,
      readiness: {
        current: readinessCurrent,
        current_date: readinessDate,
        freshness: readinessFresh ? "fresh" : (readinessQuality?.freshness ?? "missing"),
        window_average: readinessAverage,
        sample_count: readinessQuality?.sample_count ?? null,
        window_days: readinessQuality?.window_days ?? null,
      },
    },
  };

  // Already trained today (a logged lifting session)? Then today reads as covered.
  const trainedToday = sessionDates.has(d);

  // Pick a suggested plan day for the "train" case. This now starts with the
  // historical rotation but lets logged content, volume balance, and acute load
  // adapt the pick when another programmed day is clearly smarter.
  function suggestedPlanDay(): { day_number: number; focus: string | null; selection?: Record<string, any> } | null {
    const selected = selectAdaptivePlanDay(d);
    if (selected?.selection) (signals as any).plan_selection = selected.selection;
    return selected;
  }

  // Already trained today is a FACT, not a suggestion — and it takes PRECEDENCE over
  // the earned-rest rule. If today's logged work genuinely LOADED something (a hard/
  // moderate session OR a real run/ride — see dayLoad), the day is DONE: acknowledge the
  // work and frame the rest as recovery. Checking this FIRST is what stops two bugs:
  // (1) a hard push session mislabeled "EASY DAY", and (2) this morning's run being
  // shadowed by a "3 hard days → REST" call while a full session still sits below (the
  // "Rest today" vs planned-Pull contradiction). A light/none-load log (a short mobility
  // flush, or an easy spin a lifter doesn't count) stays soft and is handled lower down.
  // The grade + fact ride in `signals` for the agent regardless of which branch wins.
  const todayLoad = gradeDay(d, !!recoveryWeek);
  (signals as any).trained_today = trainedToday || !!bigActivity;
  (signals as any).today_load = todayLoad;
  const fuelProtection = underfuelingSnapshot ?? currentUnderfuelingRead(d);
  (signals as any).underfueling = fuelProtection;
  // Pace-aware protein state for `d` (behind / on_pace / met), so the Brief's FUEL
  // line speaks to where you'd EXPECT to be at this point in the day, not a raw
  // "grams remaining" that reads as a gap all morning. Rides in `signals` so the
  // cached row carries it AND the serve-time recheck can detect a stale bucket
  // (e.g. a lunch that moved behind→on_pace) and heal the prose. Null-safe: no
  // derivable target → no fuel key, exactly as before.
  try {
    const fuel = dayFuelState(d);
    if (fuel) {
      (signals as any).fuel = {
        bucket: fuel.bucket,
        protein_so_far_g: fuel.protein_so_far_g,
        target_g: fuel.target_g,
      };
    }
  } catch {
    /* fuel state is additive context only — never block the read */
  }
  // The fallback builds the SAME rich state getCoachContext does — see
  // dayPlanningSignalState. It used to pass only the handful of inputs already in
  // scope here, which left the athlete-facing read blind to joint pain, the
  // low-performance flag and a due deload while the coach prompt saw all three.
  const signalState =
    unifiedState ??
    dayPlanningSignalState(d, {
      recovery: rec,
      checkin,
      context: ctx,
      contextEvents,
      underfueling: fuelProtection,
      completedToday: (trainedToday || !!bigActivity) && (todayLoad === "hard" || todayLoad === "moderate"),
    });
  (signals as any).signal_state = signalState;
  // What tomorrow already holds, published whichever rule ends up winning today. It is
  // a FACT about the calendar, not a property of the read, so — like the health
  // work-around probe below — it is derived once here rather than inside the one rule
  // that acts on it: the cached row, the coach prompt and the decision ledger all carry
  // it even on a morning where a short night or a logged session decides the day.
  const holdsTomorrow: TomorrowHold[] = signalInput(() => tomorrowHolds(d, contextEvents), []);
  if (holdsTomorrow.length) (signals as any).tomorrow_holds = holdsTomorrow;
  // A movement work-around is a fact about the ATHLETE, not a property of whichever
  // rule wins the morning, so it is probed once here rather than inside a rule. It
  // used to live inside the protect rule below — so the day a corroborated short
  // night preempted that rule (the two co-occur constantly, since health constraints
  // are what drive the protect posture in the first place) the injury went unnamed,
  // and `applyContinuityVoice`, which branches on this signal, then SUBSTITUTED its
  // escalation for the read: an injured athlete on their third quiet day was told
  // ten easy minutes on their feet was plenty, with no guardrail at all.
  //
  // The probe is on the DIMENSION, not one field name. It used to match
  // `field === "active_injury"` alone, so an illness or any other health constraint —
  // an equal safety_override, and the very thing driving the rest posture — never set
  // this signal at all: the guarded continuity escalation below was withheld, and on
  // the third quiet day of a head cold the Brief REPLACED the illness guidance with
  // "a gentle walk today would do more for you than another full stop". Every
  // constraint in this dimension is by definition something to work around, so the
  // guard follows the dimension and the next field added there is covered on arrival.
  // The item's own `field`/`voice` still ride along, so the sentence names the right
  // thing; an injury keeps precedence when several are live because it is the most
  // specific movement work-around.
  const freshHealthConstraints = signalState.dimensions.health_constraints.evidence.filter(
    (item) => item.direction === "constraint" && item.freshness !== "stale"
  );
  const healthWorkaround =
    freshHealthConstraints.find((item) => item.field === "active_injury") ?? freshHealthConstraints[0] ?? null;
  if (healthWorkaround) {
    (signals as any).health_workaround = { field: healthWorkaround.field, reason: healthWorkaround.summary };
  }
  // Hybrid runner+lifter sequencing (one additive signal entry). Purely informational —
  // it NEVER changes the kind decision or adds an interruption; the agentic layer voices
  // it warmly when it fits. Omitted entirely when nothing sequences, so existing reads are
  // byte-for-byte unchanged. Null-safe: any failure leaves it off.
  try {
    // Template projection first; flexible agenda overrides planned_run_next so protect_run_next
    // tracks movable key runs (quality/long) instead of fixed day_number weekdays.
    const hc = withFlexibleRunLookahead(hybridDayContext(d), d);
    const tomorrow = new Date(new Date(`${d}T00:00:00Z`).getTime() + 864e5).toISOString().slice(0, 10);
    const protectRunNext = !!(
      hc.planned_run_next &&
      hc.planned_run_next.kind !== "easy" &&
      hc.planned_run_next.date === tomorrow
    );
    if (hc.cardio_today || hc.hard_cardio_yesterday || protectRunNext) {
      (signals as any).hybrid = {
        cardio_today: !!hc.cardio_today,
        hard_cardio_yesterday: !!hc.hard_cardio_yesterday,
        protect_run_next: protectRunNext,
      };
    }
  } catch {
    /* hybrid sequencing is additive context only — never block the read */
  }
  // What the Brief has already been telling them. Rides in `signals` (so the cached
  // row carries it and the agentic layer can see its own recent output) and drives
  // the continuity voice below. Deliberately NOT part of the decision fingerprint:
  // it changes the words, never the posture, so it must not churn a warm read.
  const continuity = dayReadContinuity(d);
  (signals as any).continuity = continuity;
  // …and how those reads actually WENT. The continuity above is what the Brief said;
  // this is what the athlete did with it and whether it cost them. Nothing else in the
  // deterministic floor looks past today's inputs, which is how a stable picture came
  // to suggest rest for eleven mornings running while the athlete trained through six
  // of them and rated those sessions well — every one of those disagreements was
  // already recorded, reconciled and then never read back.
  //
  // Bounded on purpose: a 12-day model rather than the coach context's 42, because the
  // softening window is ten closed days and the model costs two queries per day it
  // covers. Memoized per (date, request) like the other expensive producers, and
  // fail-soft — an audit-table outage degrades to "no softening", never to no Brief.
  const outcomeFeedback: RestOverrideSoftening | null = signalInput(
    () =>
      brainSignal(`rest_override_softening:${d}`, () =>
        restOverrideSoftening(readAdherenceModel(d, OUTCOME_SOFTENING_WINDOW_DAYS + 2), d)
      ),
    null
  );
  // Published here so the rules below can see the evidence, and REPUBLISHED once the
  // rules have resolved with `applied` — whether the softening actually fired — added.
  if (outcomeFeedback) (signals as any).outcome_feedback = { ...outcomeFeedback, applied: false };
  // The same evidence one rung up: easy mornings that became real sessions. Derived
  // from the SAME model instance rather than a second read of the ledger — two windows
  // over the same days that could disagree about which days they cover is the drift
  // this file keeps paying for elsewhere. Same memo, same fail-soft contract.
  const easyFeedback: EasyOverrideSoftening | null = signalInput(
    () =>
      brainSignal(`easy_override_softening:${d}`, () =>
        easyOverrideSoftening(readAdherenceModel(d, OUTCOME_SOFTENING_WINDOW_DAYS + 2), d)
      ),
    null
  );
  if (easyFeedback) (signals as any).easy_outcome_feedback = { ...easyFeedback, applied: false };
  // The rhythm-driven rest: genuinely-loading days stacking up outside a reduced week.
  // Hoisted out of the earned-rest rule because the training-drive rule directly above
  // it answers THIS trigger and no other, and two copies of the condition is how the
  // two would eventually come to disagree about which day they are talking about.
  const stackedLoadingRest = consec >= 3 && !recoveryWeek;
  // A commitment on the calendar compresses the training window (see the planned-
  // training rule below for the split between a commitment and a thin stretch, and
  // for the caveat each one pushes). Hoisted because BOTH train-shaped rules answer
  // to it: the drive read is a shorter, narrower day, not an exemption from the
  // athlete's actual afternoon.
  const schedulePressure =
    signalState.action.posture === "train" && signalState.action.directives.schedule === "compress";
  const commitmentPressure = schedulePressure && lifeCapacityIsCommitment(signalState);
  const rules: DayReadRule[] = [
    {
      resolve: () => {
        if (!((trainedToday || bigActivity) && (todayLoad === "hard" || todayLoad === "moderate"))) return null;
        // Name the work for the deterministic `why` (the floor when the agent's offline).
        // A logged lifting session reads as "session"; otherwise name the activity (run/
        // ride). When BOTH happened, "session" wins so the lift isn't erased by the run.
        const label = trainedToday
          ? "session"
          : bigActivity && bigActivity.type && bigActivity.type !== "other"
            ? String(bigActivity.type)
            : "session";
        return {
          outcome: DAY_READ_OUTCOMES.logged_loading_work_today,
          read: {
            kind: "done",
            focus: null,
            why: pickDayVariant(DONE_WHY, d, "logged_loading_work_today")(label),
            est_minutes: null,
            signals,
          },
        };
      },
    },
    {
      resolve: () => {
        if (!corroboratedLowSleep) return null;
        return {
          outcome: DAY_READ_OUTCOMES.acute_sleep_corroborated,
          read: {
            kind: "rest",
            focus: null,
            why: pickDayVariant(ACUTE_SLEEP_WHY, d, "acute_sleep_corroborated"),
            est_minutes: null,
            signals,
          },
        };
      },
    },
    {
      resolve: () => {
        if (signalState.action.posture !== "rest" && signalState.action.posture !== "easy") return null;
        // The injury caveat is NOT appended here: it belongs to every protective read,
        // not just this one (see the probe above and the guardrail below).
        //
        // The `why` comes from the winning evidence's ATHLETE voice, never its
        // `summary`. The summary is an observer's note written about the athlete in
        // the third person ("The athlete feels poorly recovered…") and it was being
        // printed to them as the Brief's headline — one fixed sentence per signal, so
        // the most common rest path repeated itself verbatim every morning a stable
        // check-in fired the same branch. The set rotates by calendar day like every
        // other rule; `summary` stays exactly as it is for coaches and machines.
        return {
          outcome: DAY_READ_OUTCOMES.acute_signal_protection,
          read: {
            kind: signalState.action.posture,
            focus: null,
            why: spokenSignalVoice(signalState.action.voice, d, SIGNAL_VOICE_KEYS.protect),
            est_minutes: signalState.action.posture === "easy" ? 20 : null,
            signals,
          },
        };
      },
    },
    {
      // ---- the training drive, answering the accumulated-load rest ----
      // The ONE rest the athlete's standing preference may answer, and it sits here —
      // directly above the rule that would otherwise produce it, and BELOW the done,
      // corroborated-short-night and protect rules — so the ordering itself is the
      // guarantee: a fact, a fresh short night and a protective posture all reach the
      // athlete before the preference is ever consulted.
      //
      // The preference sets the POSTURE; the evidence still decides the day. Six
      // conditions, and the read is withheld unless every one of them holds:
      //   1. the athlete asked for it,
      //   2. the rest in question is the RHYTHM one (stacked days) and nothing else in
      //      the earned-rest branch is also true — a dose overrun, a run-down check-in
      //      or a low readiness reading each keeps its rest, because those are signals
      //      about today rather than a pattern about the week,
      //   3. the run of days is under the hard ceiling,
      //   4. nothing clinical is in play, by the same three-way probe the outcome
      //      softening uses,
      //   5. the evidence is positively green — either the backed tier (earned from
      //      the athlete's own rated sessions) or a fresh, solid readiness reading over
      //      last night's own sleep, with nothing fresh pulling the other way anywhere
      //      in the state (the same brake question the backed tier asks itself, asked
      //      through the same predicate),
      //   6. and there is actually something DUE, after the acute gate has removed the
      //      groups still carrying yesterday's work.
      // Miss any of them and this returns null, the earned-rest rule below fires, and
      // the athlete gets exactly the rest day they get today.
      resolve: () => {
        if (trainingDrive !== "push") return null;
        if (!stackedLoadingRest) return null;
        if (yesterdayRecoveryOverdose || lowSubjective || lowReadiness) return null;
        if (consec >= PUSH_DRIVE_CONSEC_CEILING) return null;
        if (clinicallyDriven(signalState, healthWorkaround)) return null;
        const backed = signalState.action.support?.level === "backed";
        const solidReadiness =
          readinessFresh && readinessCurrent != null && Number(readinessCurrent) >= PUSH_DRIVE_READINESS_FLOOR;
        // Last night has to be PRESENT, be LAST NIGHT, and not be short. The sensor
        // bound alone is too loose here: SENSOR_MAX_AGE_DAYS.sleep is 2, so a night
        // from the day before yesterday is still "current" enough to be voiced — but
        // it is not corroboration for THIS morning, and the wearable path is the one
        // that can open a training day with no rated session behind it. So the age is
        // tightened to the night immediately preceding `d`. An absent, stale or
        // day-old night reads as absent, and the path simply does not open — silence
        // is never corroboration.
        const lastNightAge = sensorAgeDays(lastNight?.date ?? null, d);
        const sleptEnough =
          lastNightAge != null &&
          lastNightAge >= 0 &&
          lastNightAge <= 1 &&
          lastNight?.total_min != null &&
          Number(lastNight.total_min) >= 360;
        // The wearable path has no brake check of its own to inherit — the `backed`
        // tier refuses to exist while any fresh caution or constraint is on the board,
        // but readiness-plus-sleep is only two fields and knows nothing about the other
        // seven dimensions. Without this, a morning carrying a fresh routine disruption
        // AND fresh schedule pressure still handed out the training day. Same predicate
        // the tier uses, so the two answers cannot drift.
        const wearablePath = solidReadiness && sleptEnough && !hasFreshBrake(signalState.dimensions);
        if (!(backed || wearablePath)) return null;
        // The same acute gate every other "what's due" surface reads, so this day can
        // never open by naming a group that is still flattened from yesterday. Wrapped
        // like its sibling call sites: no balance ⇒ no due groups ⇒ no drive read.
        let due: string[] = [];
        try {
          const bal: any = programBalance(2, d);
          due = suppressSaturatedDue(Array.isArray(bal?.due) ? bal.due : [], d).slice(0, 2);
        } catch {
          due = [];
        }
        if (!due.length) return null;
        // EVERY rendering of the groups goes through the canon folding, with no raw
        // fallback behind it: `plainGroupWords` returns null only when nothing in the
        // list folds to athlete-facing words, and a due list we cannot say out loud is
        // the same absence as no due list at all. Joining the raw keys instead would
        // put "rear_delts" in the headline, the why and the focus at once.
        const groups = plainGroupWords(due, 2);
        if (!groups) return null;
        (signals as any).training_drive_push = { due, backed_by: backed ? "logged_sessions" : "recovery_reading" };
        return {
          outcome: DAY_READ_OUTCOMES.push_drive_targeted_training,
          read: {
            kind: "train" as const,
            focus: groups.charAt(0).toUpperCase() + groups.slice(1),
            why: pickDayVariant(PUSH_DRIVE_WHY, d, "push_drive_targeted_training")(groups),
            // The same clock the ordinary train rule keeps: a commitment on the
            // calendar compresses the window there, and a targeted day is no less
            // subject to the athlete's actual afternoon than a planned one is.
            est_minutes: commitmentPressure ? 40 : 60,
            signals,
          },
        };
      },
    },
    {
      // ---- the look-ahead, RE-TIMING the accumulated-load rest ----
      // The only rule in this file that looks past today, and it looks exactly one day.
      //
      // The incident: a bloodwork appointment tomorrow, an athlete who wanted to train
      // today and rest tomorrow, and a Brief that suggested rest today because it could
      // not see the appointment at all. The agent prompt has always had the row —
      // getCoachContext lists active events with no date filter — but the deterministic
      // floor read context events through two filters that both drop anything starting
      // in the future, so the layer that decides the KIND was the one layer blind to it.
      //
      // What this rule may do is deliberately small: it re-times a rest the athlete was
      // going to get anyway, and it hands back an EASY day in exchange. What it may
      // never do is manufacture capacity. So it sits BELOW every rule that answers to a
      // signal about the athlete — the logged session, the corroborated short night, the
      // protective posture, the training drive — and its gate is the rhythm rest and
      // nothing else:
      //   1. tomorrow holds something that plausibly claims the day (`blocks_training`,
      //      resolved once in `tomorrowHolds` — never an injury row or anything that
      //      reads as an illness, both clinical shapes carried for visibility only),
      //   2. today is still OPEN. The done rule above only claims a day whose work
      //      graded hard or moderate, so a mobility session or a short shakeout logged
      //      this morning fell straight through it and landed here — and this rule
      //      would then offer a second session on top of the one already done. It may
      //      re-time a rest; it may never add work to a day that has already had some,
      //   3. the rest today would be the RHYTHM one (stacked loading days) — the same
      //      one shape of rest the push drive above may answer,
      //   4. and nothing else in the earned-rest branch is also true: a dose overrun, a
      //      run-down check-in and a low readiness reading each keep their rest, because
      //      those are signals about today that a calendar cannot re-time,
      //   5. under the same hard ceiling on consecutive days the drive read respects,
      //   6. with nothing clinical in play, by the same three-way probe,
      //   7. and no fresh brake anywhere in the state — this path opens a day on the
      //      strength of an absence rather than on positive evidence, so it inherits
      //      the strictest of the brake checks rather than the loosest.
      // A rest grounded in safety — symptoms, illness, a short night, a low reading —
      // never reaches this rule at all: (2) and (3) exclude it, and the protective rules
      // above have already won the day before it is consulted.
      resolve: () => {
        const blocking = holdsTomorrow.filter((hold) => hold.blocks_training);
        if (!blocking.length) return null;
        if (trainedToday || bigActivity) return null;
        if (!stackedLoadingRest) return null;
        if (yesterdayRecoveryOverdose || lowSubjective || lowReadiness) return null;
        if (consec >= PUSH_DRIVE_CONSEC_CEILING) return null;
        if (clinicallyDriven(signalState, healthWorkaround)) return null;
        if (hasFreshBrake(signalState.dimensions)) return null;
        // A due plan day gives the read a focus and a compressed clock; with nothing
        // programmed the day still opens, as easy movement rather than a session that
        // does not exist. Either way the words are the same — the calendar is the
        // reason in both branches — and either way the effort offered is easy.
        const planDay = suggestedPlanDay();
        (signals as any).lookahead_retimed = {
          holds: blocking,
          consecutive_days: consec,
          opened: planDay ? "plan_day" : "easy_movement",
        };
        return {
          outcome: DAY_READ_OUTCOMES.lookahead_retimed_training,
          read: {
            kind: (planDay ? "train" : "easy") as "train" | "easy",
            focus: planDay?.focus ?? null,
            why: pickDayVariant(LOOKAHEAD_RETIME_WHY, d, "lookahead_retimed_training"),
            // Shorter than the ordinary train day's 60 on purpose: this is a day
            // reached for inside a run of loading days, so the offer is a comfortable
            // session, not a full one. It carries no further clamp for a commitment
            // squeezing today — schedule_pressure is brake evidence, and a fresh brake
            // anywhere in the state has already turned this rule away above.
            est_minutes: planDay ? 40 : 25,
            signals,
          },
        };
      },
    },
    {
      resolve: () => {
        // Earned rest comes from genuinely-loading days stacking up (intensity-aware
        // now), or an acute recovery signal (short sleep / a run-down check-in). A
        // weekly-mileage spike is NO LONGER a forced rest — for a hybrid athlete with a
        // noisy chronic base it fired far too readily (and "rest" contradicted its own
        // "an easier day" wording). It now rides as a caveat on the train read below,
        // so the agent still sees `volume_spike` and the athlete still gets their day.
        // A recovery week is already the periodized answer to accumulated load.
        // Pre-deload hard days cannot turn every reduced session into another rest
        // day; acute safety signals and actual dose overruns retain full authority.
        if (!(yesterdayRecoveryOverdose || stackedLoadingRest || lowSubjective || lowReadiness)) return null;
        // Each branch reports the outcome that matches its own words. Before the
        // reason moved onto the rule, a low check-in or a low readiness reading was
        // filed under "accumulated load" and explained as stacked training days the
        // athlete may not have done.
        //
        // The two subjective branches are SHADOWED on the production path and live
        // off it, which is the same fact SOFTENABLE_REST_CODES above is written
        // against: when the signal state is built from the same DB this rule reads,
        // a low check-in and a subdued readiness reading both reach the unified
        // protect rule first and ship as `acute_signal_protection`. They still fire
        // for a caller that SCOPES the state through `dayRead`'s `unifiedState`
        // argument — the one documented way the two inputs can diverge — so the
        // labels here are live code, not a hedge against a future reorder.
        const branch = yesterdayRecoveryOverdose
          ? {
              outcome: DAY_READ_OUTCOMES.recovery_dose_overrun,
              why: pickDayVariant(DOSE_OVERRUN_WHY, d, "recovery_dose_overrun"),
            }
          : stackedLoadingRest
            ? {
                outcome: DAY_READ_OUTCOMES.accumulated_load_rest,
                why: pickDayVariant(STACKED_LOAD_WHY, d, "accumulated_load_rest"),
              }
            : lowReadiness
              ? {
                  outcome: DAY_READ_OUTCOMES.low_readiness_rest,
                  why: pickDayVariant(LOW_READINESS_WHY, d, "low_readiness_rest"),
                }
              : {
                  outcome: DAY_READ_OUTCOMES.felt_run_down_rest,
                  why: pickDayVariant(RUN_DOWN_WHY, d, "felt_run_down_rest"),
                };
        return {
          outcome: branch.outcome,
          read: { kind: "rest", focus: null, why: branch.why, est_minutes: null, signals },
        };
      },
    },
    {
      resolve: () => {
        // An easy/light effort already done today (a short walk, a recovery spin a lifter
        // doesn't count as their real work) — acknowledge it without telling them to rest.
        if (!(trainedToday || bigActivity)) return null;
        return {
          outcome: DAY_READ_OUTCOMES.logged_light_work_today,
          read: {
            kind: "easy",
            focus: null,
            why: pickDayVariant(LIGHT_WORK_WHY, d, "logged_light_work_today"),
            est_minutes: 20,
            signals,
          },
        };
      },
    },
    {
      resolve: () => {
        // A genuine mileage spike WHILE actively stacking loading days earns an easier
        // day (not a forced rest) so the running absorbs. Gated on consec>=1: if
        // yesterday was already a recovery/easy day, the spike has been answered — don't
        // stack easy on easy, let them train (the spike still rides as a caveat below).
        if (!(volumeSpike && consec >= 1)) return null;
        return {
          outcome: DAY_READ_OUTCOMES.endurance_volume_spike,
          read: {
            kind: "easy",
            focus: null,
            why: pickDayVariant(VOLUME_SPIKE_WHY, d, "endurance_volume_spike"),
            est_minutes: 25,
            signals,
          },
        };
      },
    },
    {
      resolve: () => {
        const sd = suggestedPlanDay();
        if (!sd) return null;
        // Still a green-light to train (a suggestion, never a gate), but voice the soft
        // caveats so it's coach-level, not a blunt "go": fatigue quietly building toward
        // a reset, and/or running ramped this week (keep today's miles easy).
        // Each caveat is a rotating variant set, never a literal (see the sets above):
        // this rule fires on most mornings, so a fixed fragment reads as a stuck app.
        const caveats: string[] = [];
        // ---- SAFETY vs BOOKKEEPING (owner ruling, 2026-08-17) ----
        //
        // A caveat used to withdraw the push simply by EXISTING: `!caveats.length` was
        // the gate, so the read's one positive direction was switched off by any note
        // at all, including notes that are not about whether the athlete can carry load
        // today. On a real training block something is essentially always worth
        // mentioning, so the push was unreachable in practice — the read could get
        // quieter but never louder, which is the pessimism this ruling is about.
        //
        // So each caveat is now classified where it is raised, and only the SAFETY ones
        // veto. The test is not severity, it is subject: does this caveat say something
        // about the athlete's capacity to take load today?
        //
        //   SAFETY (vetoes the push)
        //     recovery_week      a deliberately reduced week; reaching inside it is
        //                        reaching against the structure, not within it
        //     injury             an active injury being worked around
        //     ease_around        a dated load-reducing constraint, same family
        //     joint_pain         a fresh health constraint off session feedback
        //     life_pressure      thinner RECOVERY (a late night / a stressful stretch);
        //                        the caveat's own job is to hold intensity down
        //
        //   BOOKKEEPING (no longer vetoes)
        //     adapted plan pick  which day was chosen, not how much can be carried
        //     anticipate_deload  a reset on the HORIZON; the deload itself, when it
        //                        arrives, is a recovery week and vetoes as one
        //     volume_spike       running-specific, and it already has its own dedicated
        //                        brake (the endurance_volume_spike easy read above, plus
        //                        the spike factor in weeklyRunPlan) — vetoing the lifting
        //                        push as well was the same finding charged twice
        //     low_sleep          a chronic sleep TREND, which already brakes in its own
        //                        right (the recovery dimension, the chronic-sleep easy
        //                        read, and the run-volume factor) — charged twice again
        //     commitment_pressure a squeezed CLOCK; the day is already clamped 60 → 40,
        //                        and a short session is a fine session to reach inside
        //
        // `backed` and `!holdAggression` are unchanged and still required, and between
        // them they already exclude every fresh caution and constraint in the signal
        // state — so most of the SAFETY list is belt-and-braces on top of a bar those
        // two already clear. It is enumerated anyway: a veto that depends on a
        // coincidence of two other layers is a veto nobody can find later.
        const pushVetoes: string[] = [];
        if (recoveryWeek) {
          caveats.push(pickDayVariant(RECOVERY_WEEK_CAVEAT, d, "planned_training:recovery_week"));
          pushVetoes.push("recovery_week");
        }
        if (reduceItem) {
          caveats.push(
            reduceItem.kind === "injury"
              ? pickDayVariant(
                  INJURY_CAVEAT,
                  d,
                  "planned_training:injury"
                )(String(reduceItem.title || "an injury").toLowerCase())
              : pickDayVariant(EASE_AROUND_CAVEAT, d, "planned_training:ease_around")
          );
          pushVetoes.push(reduceItem.kind === "injury" ? "injury" : "ease_around");
        }
        // A health constraint the CONTEXT path cannot see. `reduceItem` is derived from
        // context EVENTS, so an injury, an illness or a dated constraint is already
        // voiced just above — but joint pain arrives from session feedback
        // (trainingSignals.autoregulation), and once the read learned to see it, it
        // reached this rule having ALREADY changed the day (directives.training ==
        // "modify", health_constraints constrained) with nothing to say about it. The
        // athlete was handed a modified session under "Recovery looks fine and the
        // session is due. Good day for it." — silent would have been bad; contradicting
        // itself is worse. Keyed on the DIMENSION like the work-around probe, so the
        // next constraint that arrives by a non-context route is covered on arrival;
        // the evidence's own voice supplies the subject, and anything that carries
        // none falls back to the generic ease-around fragment rather than inventing one.
        if (!reduceItem && healthWorkaround) {
          const sore = String(healthWorkaround.voice?.subject ?? "").trim();
          caveats.push(
            sore
              ? pickDayVariant(JOINT_PAIN_CAVEAT, d, "planned_training:joint_pain")(sore)
              : pickDayVariant(EASE_AROUND_CAVEAT, d, "planned_training:ease_around")
          );
          pushVetoes.push("joint_pain");
        }
        // BOOKKEEPING from here down — these push a caveat and no veto. See the table
        // where `pushVetoes` is declared for why each one landed on that side.
        if (sd.selection?.adapted && sd.selection?.reason) caveats.push(String(sd.selection.reason));
        if (anticipateDeload)
          caveats.push(pickDayVariant(ANTICIPATE_DELOAD_CAVEAT, d, "planned_training:anticipate_deload"));
        if (volumeSpike) caveats.push(pickDayVariant(VOLUME_SPIKE_CAVEAT, d, "planned_training:volume_spike"));
        // A CHRONICALLY short sleeper is a caveat on the session, not a reason to
        // withhold it. This used to be its own rule ABOVE this one, so anyone whose
        // rolling average sat under six hours was never offered a due plan day at all
        // — permanent rest traded for permanent easy. The watch still gets voiced (and
        // the rule survives below, for a day with nothing programmed to soften).
        if (lowSleep) caveats.push(pickDayVariant(LOW_SLEEP_CAVEAT, d, "planned_training:low_sleep"));
        const holdAggression = signalState.action.directives.training === "hold_aggression";
        // Same rule as the protect read above: the athlete hears the athlete voice,
        // never the machine-facing summary. This is the second (and only other) path by
        // which the signal state's own words reach a `why` — it LEADS the read here
        // rather than sitting mid-sentence after the dash, because these are whole
        // sentences (several of them carry their own dash) and the caveat list is a
        // run of lowercase fragments.
        //
        // It leads with the BRAKE's voice, not the day's posture voice. `action.voice`
        // speaks the posture, and a hold day is still readiness:"ready" / posture:"train"
        // — whose evidence is the SUPPORT items — so voicing the hold through it printed
        // "you slept fine" and then asked the athlete to hold, with "until that settles"
        // pointing at nothing. `directives.training_source` names the dimension whose
        // status actually produced the hold, and on a watch dimension its `voice` is the
        // caution item's: the brake, in the athlete's register, with the pronoun in the
        // caveat finally resolving to it.
        const holdVoice = signalState.action.directives.training_source
          ? signalState.dimensions[signalState.action.directives.training_source].voice
          : signalState.action.voice;
        const holdLead = holdAggression ? spokenSignalVoice(holdVoice, d, "planned_training:hold") : "";
        if (holdAggression) caveats.push(pickDayVariant(HOLD_AGGRESSION_CAVEAT, d, "planned_training:hold_aggression"));
        // `schedule: "compress"` has TWO unrelated causes and only one is about the
        // clock. life_capacity reaches `watch` either from a real dated commitment
        // (voice `commitment_pressure`) or from `context.expect_worse_sleep` — a late
        // night or a stressful stretch (voice `schedule_pressure`), which is not a
        // commitment at all. Both write the same `field`, so the winning evidence's
        // VOICE is the only discriminator — shared with the conductor's compress card
        // as lifeCapacityIsCommitment, because two copies of it drifted apart once
        // already. Reading them as one printed "you've got a
        // commitment today that shortens the training window" over a life_event titled
        // "Brutal week at work" — a false claim about the athlete's calendar — and
        // answered a RECOVERY signal by shortening the clock. Split: a commitment
        // compresses the window; a thin stretch asks for less intensity at full length.
        // Anything unrecognized falls to the life-pressure branch, which claims less
        // and clamps nothing.
        // `schedulePressure` / `commitmentPressure` are derived once above the rule
        // list, so the drive read compresses on exactly the same condition.
        // MACHINE register, and now named as such. `life_capacity.reason` is
        // third-person evidence prose written for the model and the provenance trail
        // ("A current commitment or stressful stretch is likely to compress recovery
        // capacity."), and it sat on a field called plain `reason` inside the read's
        // own signals — one plausible client render away from printing observer prose
        // at the athlete. The athlete-facing counterpart is the dimension's `voice`,
        // carried beside it: a surface that shows this must speak it through
        // spokenSignalVoice, never render the evidence string.
        const scheduleReason = signalState.dimensions.life_capacity.reason;
        const scheduleVoice = signalState.dimensions.life_capacity.voice;
        if (commitmentPressure) {
          caveats.push(pickDayVariant(COMMITMENT_PRESSURE_CAVEAT, d, "planned_training:commitment_pressure"));
          (signals as any).schedule = {
            directive: "compress",
            compressed: true,
            original_est_minutes: 60,
            est_minutes: 40,
            evidence_reason: scheduleReason,
            voice: scheduleVoice,
          };
        } else if (schedulePressure) {
          caveats.push(pickDayVariant(LIFE_PRESSURE_CAVEAT, d, "planned_training:life_pressure"));
          // SAFETY — this branch is the RECOVERY one of the two compress causes (see the
          // split above); its whole content is "hold the intensity", which is the exact
          // opposite of what the push offers.
          pushVetoes.push("life_pressure");
          // Recovery pressure is a reason to hold intensity, not to shorten the day —
          // so the clock is left alone. The directive is still recorded so the machine
          // surface stays honest about what the signal state said AND what the read
          // chose to do with it.
          (signals as any).schedule = {
            directive: "compress",
            compressed: false,
            original_est_minutes: 60,
            est_minutes: 60,
            evidence_reason: scheduleReason,
            voice: scheduleVoice,
          };
        }
        // A recovery week ALWAYS pushes its own caveat above, so the caveat arm is the
        // one a reduced week takes — there is no separate recovery-week arm (the one
        // that used to sit between these two was unreachable for exactly that reason;
        // see the retired RECOVERY_WEEK_TRAIN_WHY note at the top of this file).
        // The brain's other direction. Every arm above this one either holds the day
        // back or leaves it alone; this is the only one that offers MORE, and it fires
        // when the unified state says the evidence positively backs the day
        // (support === "backed") AND nothing SAFETY-class is on the board. `backed`
        // already requires no fresh caution or constraint anywhere; `pushVetoes` is what
        // rules out the day's non-signal brakes too — a recovery week, an injury being
        // worked around, a stretch that is eating recovery.
        //
        // The gate used to read `!caveats.length`, i.e. any note at all. That is the
        // clause this ruling replaces: see the SAFETY/BOOKKEEPING table above for which
        // notes still veto and why. Suggestion, never a gate; `est_minutes` is
        // deliberately untouched, because a backed day is a reason to reach WITHIN the
        // session, not a reason to make it longer.
        // ---- the caution that is real but UNSECONDED (owner ruling, 2026-08-17) ----
        //
        // Raising the hold bar to a second opinion left a gap the athlete would have
        // felt as the read going deaf: one dimension genuinely at `watch`, no hold, and
        // therefore nothing at all in the read about it — the Brief would have said
        // "nothing's holding you back today" on a morning where something was
        // demonstrably worth saying. Silence would have been a worse bug than the
        // over-holding, because the finding is real; only the counsel was too firm.
        //
        // So the caution still SPEAKS, in its own voice, and the day stays open. Read in
        // the same precedence order planningDirectives uses, off the same four
        // dimensions it counts, so the sentence names the dimension the hold WOULD have
        // named had a second one joined it.
        //
        // Held out entirely when anything SAFETY-class is already on the board: those
        // days already lead with the thing that matters (an injury, a reduced week, a
        // stretch eating recovery), and handing the lead to a soft caution instead would
        // demote the constraint to a fragment after the dash. This branch is for the
        // otherwise-clean board, which is exactly the case the ruling is about.
        const HOLD_DIMENSIONS: readonly SignalDimension[] = [
          "recovery_capacity",
          "training_load_tolerance",
          "health_constraints",
          "energy_fueling",
        ];
        const notedWatch =
          holdAggression || pushVetoes.length
            ? null
            : (HOLD_DIMENSIONS.find((dimension) => signalState.dimensions[dimension].status === "watch") ?? null);
        const notedVoice = notedWatch ? signalState.dimensions[notedWatch].voice : null;
        const notedLead = notedWatch ? spokenSignalVoice(notedVoice, d, "planned_training:noted") : "";
        const pushBias = signalState.action.support?.level === "backed" && !holdAggression && !pushVetoes.length;
        if (pushBias) (signals as any).push_bias = { backed_by: signalState.action.support?.fields ?? [] };
        // Whatever holds the day back also says what opens it again — the earn path.
        // Only the two branches that actually hold something carry one; a clear day and
        // a push day have nothing to unlock.
        const earnPath = holdAggression
          ? ` ${earnPathClause(holdVoice, d)}`
          : notedWatch
            ? ` ${earnPathClause(notedVoice, d)}`
            : "";
        const caveatRun = caveats.length ? ` — ${caveats.join("; and ")}` : "";
        const why = holdAggression
          ? `${holdLead} ${pickDayVariant(TRAIN_HOLD_LEAD, d, "planned_training:hold_lead")}${caveatRun}.${earnPath}`
          : notedWatch
            ? // The caution speaks, the day stays open, and the earn path closes it out.
              `${notedLead} ${pickDayVariant(TRAIN_NOTED_LEAD, d, "planned_training:noted_lead")}${caveatRun}.${earnPath}`
            : caveats.length
              ? // A backed day carrying only bookkeeping notes keeps the reach in the
                // lead rather than losing it: the caveats are still said, in full, but
                // the sentence no longer opens as though something were wrong.
                `${pickDayVariant(
                  pushBias ? TRAIN_PUSH_CAVEAT_LEAD : TRAIN_CAVEAT_LEAD,
                  d,
                  pushBias ? "planned_training:push_caveats" : "planned_training:caveats"
                )}${caveatRun}.`
              : pushBias
                ? pickDayVariant(TRAIN_PUSH_WHY, d, "planned_training_push")
                : pickDayVariant(TRAIN_CLEAR_WHY, d, "planned_training");
        return {
          outcome: recoveryWeek ? DAY_READ_OUTCOMES.planned_reduced_training : DAY_READ_OUTCOMES.planned_training,
          read: { kind: "train", focus: sd.focus, why, est_minutes: commitmentPressure ? 40 : 60, signals },
        };
      },
    },
    {
      resolve: () => {
        // The chronic-sleep watch, DEMOTED below the plan day it used to preempt: it
        // now only speaks when there is no session to caveat, where it still beats the
        // bare unprogrammed floor at explaining why today reads easy.
        if (!lowSleep) return null;
        return {
          outcome: DAY_READ_OUTCOMES.chronic_sleep_watch,
          read: {
            kind: "easy",
            focus: null,
            why: pickDayVariant(CHRONIC_SLEEP_WHY, d, "chronic_sleep_watch"),
            est_minutes: 25,
            signals,
          },
        };
      },
    },
  ];

  const resolved = resolveDayReadRule(rules);
  const ruleOutcome = resolved?.outcome ?? UNPROGRAMMED_EASY_DAY;
  const ruleRead = resolved?.read ?? {
    kind: "easy" as const,
    focus: null,
    why: pickDayVariant(UNPROGRAMMED_WHY, d, "unprogrammed_easy_day"),
    est_minutes: 20,
    signals,
  };
  // ---- the outcome loop, closed ----
  // A rest the athlete has repeatedly overruled without paying for it becomes an easy
  // day. ONE step, and only ever this one: rest → easy. It cannot reach train, it
  // cannot fire against a fresh short night or a measured dose overrun, and it cannot
  // fire while anything clinical is live (see SOFTENABLE_REST_CODES + clinicallyDriven
  // above). The result carries its own rule code, so the ledger, the repeat-of-
  // yesterday check and the Brief's reason all key on the softening rather than on the
  // rule it replaced — and tomorrow's model sees how THIS day went, so the loop is
  // self-correcting in both directions.
  const softenRest =
    outcomeFeedback?.active === true &&
    ruleRead.kind === "rest" &&
    SOFTENABLE_REST_CODES.has(ruleOutcome.code) &&
    !clinicallyDriven(signalState, healthWorkaround);
  // Republish the evidence with the ANSWER attached. `active` says only that the
  // pattern is there; it stays true on a morning that reads train, and on one where a
  // clinical constraint or a fresh short night holds the rest in place. Anything
  // downstream that claims the day has already been eased — the day-read prompt, and
  // tomorrow's evidence window reading this row back off the ledger — must key on
  // `applied`, which is the fact rather than the argument for it.
  if (outcomeFeedback) {
    (signals as any).outcome_feedback = { ...outcomeFeedback, applied: softenRest } satisfies OutcomeFeedbackSignal;
  }
  // ---- …and the same loop one rung up ----
  // An EASY read the athlete has repeatedly taken above easy without paying for it
  // becomes a training day. ONE step, exactly as above: easy → train and no further.
  // Same evidence bar, same clinical floor, and additionally never inside a reduced
  // week — a recovery week is a deliberate structure the athlete signed up for, not a
  // read arguing with them, so their own overruns are not evidence against it.
  //
  // `!softenRest` is belt-and-braces rather than arithmetic: a rest read cannot be in
  // SOFTENABLE_EASY_CODES anyway, but stating it here makes it impossible for the two
  // ladders to compose into rest → train by way of a future code appearing in both.
  const softenEasy =
    !softenRest &&
    easyFeedback?.active === true &&
    ruleRead.kind === "easy" &&
    SOFTENABLE_EASY_CODES.has(ruleOutcome.code) &&
    !recoveryWeek &&
    !clinicallyDriven(signalState, healthWorkaround);
  // The opened day gets the focus and the clock of the session that was actually due,
  // when one is: the easy reads this rule may open sit ABOVE the planned-training rule
  // and preempt it, so without this an athlete who has been outrunning the quiet reads
  // for a fortnight would be handed a training day with nothing in it. No plan day due
  // → the read keeps its own focus and opens the clock a little rather than inventing a
  // session that does not exist.
  const openedPlanDay = softenEasy ? suggestedPlanDay() : null;
  if (easyFeedback) {
    (signals as any).easy_outcome_feedback = {
      ...easyFeedback,
      applied: softenEasy,
    } satisfies EasyOutcomeFeedbackSignal;
  }
  const outcome = softenRest
    ? DAY_READ_OUTCOMES.outcome_feedback_soften
    : softenEasy
      ? DAY_READ_OUTCOMES.outcome_feedback_open
      : ruleOutcome;
  const resolvedRead = softenRest
    ? {
        ...ruleRead,
        kind: "easy" as const,
        focus: null,
        why: pickDayVariant(OUTCOME_FEEDBACK_SOFTEN_WHY, d, "outcome_feedback_soften"),
        est_minutes: 20,
      }
    : softenEasy
      ? {
          ...ruleRead,
          kind: "train" as const,
          focus: openedPlanDay?.focus ?? ruleRead.focus ?? null,
          why: pickDayVariant(OUTCOME_FEEDBACK_OPEN_WHY, d, "outcome_feedback_open"),
          est_minutes: openedPlanDay ? 60 : 45,
        }
      : ruleRead;
  // The health work-around closes EVERY protective read, whichever rule produced it
  // — a short night, stacked load, a light walk already logged, or the bare floor. It
  // used to be spoken by one rule only, so the athlete's constraint guidance disappeared
  // the moment a different rule won the posture. A train day is excluded on purpose:
  // that read voices the same constraint in its own caveat list ("train around it and
  // skip anything that aggravates it"), and a `done` day is a fact about work already
  // finished, not a suggestion to work around.
  //
  // …unless the winning rule ALREADY spoke that same voice. Widening the probe from
  // `active_injury` to every health constraint made that reachable: an illness both
  // drives the protect posture AND is the winning evidence behind it, so the rule's
  // own `why` IS the illness voice — and appending a second phrasing of it printed the
  // same idea twice in one read. Membership is checked across the whole voice, not the
  // one sentence today rolled, because the two paths rotate on different keys.
  const workaroundVoice = healthWorkaround?.voice ?? {
    key:
      healthWorkaround?.field === "illness"
        ? ("illness" as const)
        : healthWorkaround?.field === "active_injury"
          ? ("active_injury" as const)
          : ("health_constraint" as const),
  };
  const workaroundAlreadySpoken =
    !!healthWorkaround && signalVoice(workaroundVoice).some((variant) => resolvedRead.why.includes(variant));
  const base =
    healthWorkaround && QUIET_KINDS.has(resolvedRead.kind) && !workaroundAlreadySpoken
      ? {
          ...resolvedRead,
          // Named in the athlete's own register and rotated by day like everything
          // else. It used to splice the evidence `summary` behind a fixed lead-in —
          // one sentence printed verbatim for as long as the injury lasted, carrying
          // context-effect's generic classifier line along with the injury's name
          // ("…around the active injury: Achilles tendinopathy: an active injury is
          // worth easing or working around."). endStopped stays: everything the
          // continuity voice adds lands AFTER this, so the sentence must close.
          why: `${resolvedRead.why} ${endStopped(spokenSignalVoice(workaroundVoice, d, SIGNAL_VOICE_KEYS.injury))}`,
        }
      : resolvedRead;
  // Cross-day memory: yesterday reached this same conclusion by this same route,
  // so today has nothing new to report and should say so rather than re-deriving
  // the sentence as though it were news.
  continuity.repeat_of_yesterday =
    !!continuity.yesterday &&
    continuity.yesterday.kind === base.kind &&
    continuity.yesterday.rule_code === outcome.code;
  return finalizeDeterministicRead(d, outcome, applyContinuityVoice(d, outcome, base, continuity));
}

// ---------- the forward look (day-ahead heads-up) ----------
// The Program-tab intelligence, woven onto the Brief so the athlete never has to
// visit a separate tab to know their focus: what the NEXT session leans toward (the
// plan day AFTER the one anchoring today) + which muscle groups are DUE this week
// (under their productive range). Deterministic + null-safe — the agent voices it
// warmly when available, this is the floor (and the structured truth the PWA renders).
export interface ForwardLook {
  next_focus: string | null; // the next session's character ("Lower body")
  due: string[]; // groups under their productive range this week
  text: string | null; // a single plain-words line, or null when there's nothing to say
}
export function forwardLook(date?: string): ForwardLook {
  const d = date || localDateISO();
  let next_focus: string | null = null;
  try {
    const days = planDayCandidates();
    if (days.length) {
      // If today already has work, "Next" means the day after that work. Otherwise
      // it means the same adaptive next-session pick the Brief points at.
      const todaySess = db
        .prepare(
          `SELECT s.id AS id, s.plan_day_id AS plan_day_id
           FROM sessions s
          WHERE s.date = ? AND EXISTS (SELECT 1 FROM logged_sets l WHERE l.session_id = s.id)
          ORDER BY s.id DESC LIMIT 1`
        )
        .get(d) as any;
      const todayResolved = todaySess
        ? resolveSessionPlanDay(
            Number(todaySess.id),
            todaySess.plan_day_id == null ? null : Number(todaySess.plan_day_id),
            days
          )
        : null;
      const selected = todayResolved ? null : selectAdaptivePlanDay(d);
      const nd = todayResolved
        ? nextCandidateAfter(days, todayResolved.day_number)
        : days.find((day) => day.day_number === selected?.day_number);
      next_focus = nd ? planDayFocus(nd) : null;
    }
  } catch {
    /* no plan → no next focus */
  }
  let due: string[] = [];
  try {
    const bal: any = programBalance(2, d);
    // A saturated group is NOT something to put in front of the athlete as "due"
    // — the Brief must never say "quads & calves due" the morning after the long
    // run that flattened them. This surface never asked the acute question at
    // all; it does now, through the same gate every other consumer reads.
    due = suppressSaturatedDue(Array.isArray(bal?.due) ? bal.due : [], d).slice(0, 2);
  } catch {
    /* no balance → no due groups */
  }
  const parts: string[] = [];
  if (next_focus) parts.push(`Next: ${next_focus}`);
  if (due.length) parts.push(`${plainGroupWords(due, 2) ?? due.join(" & ")} due this week`);
  return { next_focus, due, text: parts.length ? parts.join(" · ") : null };
}

// ---------- the week ahead (deterministic floor) ----------
// The forward-look's safety net (coachOps.weekAheadRead layers the agentic day-by-
// day shape on top). Honest + simple: the lifting split as the week's sessions, in
// plan order, plus a base-building note — NO fabricated calendar (the agent owns the
// real day-by-day). Always available, never throws.
export interface WeekAheadDay {
  day: string | null; // weekday label when the agent placed it; null for the floor's plan list
  kind: "lift" | "run" | "mixed" | "rest";
  label: string; // e.g. "Lower body" / "Easy 5k" / "Rest"
  note?: string | null;
}
export function weekAheadPlan(date = localDateISO()): { days: WeekAheadDay[]; summary: string } {
  const d = String(date).slice(0, 10);
  const planDays = db.prepare(`SELECT id, day_number, name, focus FROM plan_days ORDER BY day_number`).all() as any[];
  if (!planDays.length) return { days: [], summary: "" };
  // Per-day modality from plan_items so the floor REFLECTS a runner's prescribed
  // cardio instead of hardcoding every day to a lift — without this a runner sees
  // zero runs in the Today week-ahead floor. cardio-only → run; cardio+strength →
  // mixed; otherwise lift. (The agentic weekAheadRead still layers the real shape.)
  const counts = new Map<number, { cardio: number; strength: number }>();
  for (const r of db
    .prepare(
      `SELECT plan_day_id AS id,
            SUM(CASE WHEN kind='cardio' THEN 1 ELSE 0 END) AS cardio,
            SUM(CASE WHEN kind='cardio' THEN 0 ELSE 1 END) AS strength
       FROM plan_items GROUP BY plan_day_id`
    )
    .all() as any[]) {
    counts.set(Number(r.id), { cardio: Number(r.cardio) || 0, strength: Number(r.strength) || 0 });
  }
  const days: WeekAheadDay[] = planDays.map((d) => {
    const c = counts.get(Number(d.id)) || { cardio: 0, strength: 0 };
    const kind: WeekAheadDay["kind"] = c.cardio > 0 ? (c.strength > 0 ? "mixed" : "run") : "lift";
    return {
      day: null,
      kind,
      label: String(d.focus || d.name || `Day ${d.day_number}`)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60),
    };
  });
  // Reflect PROGRAM STATE in the floor's summary (plain words, never a fabricated
  // calendar): if a deload is about due, or muscle groups are DUE, or a lift needs
  // a deload, say so as a forward-looking note so the look-ahead is honest about
  // what the week could use. Defensive: program-state is a heavier read — a failure
  // here must never break the deterministic week-ahead floor.
  const notes: string[] = [];
  try {
    const st = getProgramState();
    if (st?.mesocycle?.phase === "deload-due") notes.push("a deload week is about due — pencil in one lighter day");
    // Same acute gate as the forward-look: the week ahead never opens by naming a
    // group that is still carrying yesterday's work as something to go add.
    const bal = programBalance(2, d);
    const dueFresh = suppressSaturatedDue(Array.isArray(bal?.due) ? bal.due : [], d).slice(0, 3);
    if (dueFresh.length)
      notes.push(
        `${plainGroupWords(dueFresh, 3) ?? dueFresh.join(", ")} ${dueFresh.length === 1 ? "is" : "are"} due — work ${dueFresh.length === 1 ? "it" : "them"} in`
      );
    const deload = (Array.isArray(st?.lifts) ? st.lifts : [])
      .filter((l: any) => l.suggested_action === "deload")
      .map((l: any) => l.exercise);
    if (deload.length) notes.push(`${deload.slice(0, 2).join(", ")} could use a light deload`);
  } catch {
    /* program-state unavailable — fall back to the plain summary */
  }

  const base =
    "Your training week in order — weave easy, conversational runs between sessions for your aerobic base, and take a rest day when you need one.";
  return {
    days,
    summary: notes.length ? `${base} This week: ${notes.join("; ")}.` : base,
  };
}

// ---------- Day-read cache (the Brief) ----------
// One canonical (no-override) read per calendar day, persisted so the morning
// open is instant. The nightly scheduler pass (and any cache miss) fills it; the
// few events that materially change the read invalidate the affected day, and
// the next open recomputes once and re-caches. See src/dayread.ts for the
// agentic compute + write path that wraps the deterministic dayRead() above.
export function getCachedDayRead(date: string): any | null {
  const row = db.prepare(`SELECT * FROM day_reads WHERE date = ?`).get(date) as any;
  if (!row) return null;
  let signals: any = {};
  try {
    signals = row.signals ? JSON.parse(row.signals) : {};
  } catch {
    signals = {};
  }
  const meta = signals?._day_read_meta && typeof signals._day_read_meta === "object" ? signals._day_read_meta : {};
  if (signals && typeof signals === "object") delete signals._day_read_meta;
  const computedAt = String(row.computed_at ?? "").replace(" ", "T");
  const normalizedComputedAt = computedAt && !/[zZ]|[+-]\d\d:\d\d$/.test(computedAt) ? `${computedAt}Z` : computedAt;
  const decision = meta.decision ?? undefined;
  return {
    kind: row.kind,
    headline: row.headline,
    why: row.why,
    focus: row.focus ?? null,
    est_minutes: row.est_minutes ?? null,
    signals,
    source: row.source || "deterministic",
    agent: row.agent || undefined,
    override: row.override ?? null,
    decision,
    input_fingerprint: meta.input_fingerprint ?? undefined,
    curated: meta.curated === true,
    computed_at: decision?.computed_at ?? (normalizedComputedAt || undefined),
  };
}

export interface CachedOverrideIdentity {
  override: string;
  input_fingerprint?: string;
  computed_at?: string;
}

function writeDayRead(date: string, read: any, expectedStaleOverride?: CachedOverrideIdentity): boolean {
  if (!date || !read || !read.kind) return false;
  const override = read.override != null && String(read.override).trim() ? String(read.override).trim() : null;
  // A CURATED read is deliberately authored rather than derived — the demo seed's
  // hand-written Brief, and anything else pinned on purpose. Its signals are
  // illustrative, so no fingerprint the live DB produces will ever match it; left
  // to the ordinary rules it gets overwritten by the deterministic floor on the
  // first open. It is pinned instead: only an explicit invalidateDayRead() (which
  // deletes the row outright) retires it.
  const curated = read.curated === true;
  const existing = getCachedDayRead(date);
  if (existing?.curated && !curated) return false;
  // No-clobber guard: a canonical (no-steer) recompute — nightly precompute, boot
  // warm, a cache-miss compute — must never overwrite an athlete's persisted steer
  // for the day. Ordinary material writes clear it via invalidateDayRead(); the
  // serve-time reconciliation path uses the exact-identity replacement below.
  if (!override && existing?.override) {
    const trustedReplacement =
      !!expectedStaleOverride &&
      existing.override === expectedStaleOverride.override &&
      existing.input_fingerprint === expectedStaleOverride.input_fingerprint &&
      existing.computed_at === expectedStaleOverride.computed_at;
    if (!trustedReplacement) return false;
  }
  let inputFingerprint = typeof read.input_fingerprint === "string" ? read.input_fingerprint : null;
  if (!inputFingerprint) {
    try {
      inputFingerprint = dayReadInputFingerprint(date, read, currentDayReadFingerprintContext(date));
    } catch {
      inputFingerprint = null;
    }
  }
  const computedAt =
    typeof read.computed_at === "string" && read.computed_at ? read.computed_at : new Date().toISOString();
  const decision =
    read.decision && typeof read.decision === "object"
      ? read.decision
      : {
          rule_code: "cached_read_write",
          basis: read.source === "agent" ? "agent" : "deterministic",
          baseline_kind: read.kind,
          // A read handed to us without a decision has no reason BEYOND its own
          // `why` — and the athlete must never be shown boundary trivia dressed up
          // as coaching, so the reason stays empty and the Brief renders nothing.
          reason: "",
          evidence: [],
          computed_at: computedAt,
        };
  const storedSignals = {
    ...(read.signals ?? {}),
    _day_read_meta: {
      decision,
      input_fingerprint: inputFingerprint,
      ...(curated ? { curated: true } : {}),
    },
  };
  db.prepare(
    `INSERT INTO day_reads (date, kind, headline, why, focus, est_minutes, signals, source, agent, override, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(date) DO UPDATE SET
       kind=excluded.kind, headline=excluded.headline, why=excluded.why, focus=excluded.focus,
       est_minutes=excluded.est_minutes, signals=excluded.signals, source=excluded.source,
       agent=excluded.agent, override=excluded.override, computed_at=excluded.computed_at`
  ).run(
    date,
    read.kind,
    read.headline ?? null,
    read.why ?? null,
    read.focus ?? null,
    read.est_minutes != null && Number.isFinite(Number(read.est_minutes)) ? Math.round(Number(read.est_minutes)) : null,
    JSON.stringify(storedSignals),
    read.source ?? "deterministic",
    read.agent ?? null,
    override
  );
  // Keep the table to a rolling few weeks — old reads are never served.
  try {
    db.prepare(`DELETE FROM day_reads WHERE date < date('now','-21 days')`).run();
  } catch {}
  // Persist the recommendation as a bounded, outcome-addressable decision carrying
  // a falsifiable read-adherence expectation. This runs after the canonical cache
  // write and is intentionally fail-soft: an audit outage must never make the Brief
  // unavailable.
  //
  // The identity used to be the whole `signals` blob, which moves all day, so one
  // date produced ~19 immutable rows and 18 supersedes. It is now the CLAIM the read
  // makes — kind plus override, deliberately NOT `inputFingerprint` (see
  // recordDayReadDecision) — so any recompute reaching the same conclusion is
  // idempotent and only a genuine change of call records.
  try {
    recordDayReadDecision(date, read, { override });
  } catch {
    // The day-read cache is authoritative; learning/audit recording is best effort.
  }
  return true;
}

export function saveDayRead(date: string, read: any): boolean {
  return writeDayRead(date, read);
}

// The one trusted exception to saveDayRead's athlete-steer no-clobber guard.
// readToday's material-truth reconciliation passes the exact cached identity it
// inspected; a newer/different steer therefore wins and is never cleared.
export function replaceStaleDayReadOverride(date: string, read: any, expected: CachedOverrideIdentity): boolean {
  if (!expected?.override) return false;
  return writeDayRead(date, read, expected);
}

// Work that lands for a day ALREADY judged re-opens that judgement. This is the one
// part of an invalidation that must NOT be economised away, because it answers a
// different question from the read cache. The cache asks "could today's suggestion
// have changed"; adherence asks "was the suggestion I already made followed", and it
// asks it against the RAW logged counts (`adherenceFactsChanged` in
// brain/read-adherence.ts compares logged_sets / logged_activities / real_activities
// / load). The decision fingerprint deliberately drops exactly that granularity — a
// set added to a past day moves no grade and no fact — so a late correction on a
// judged day leaves the fingerprint perfectly still. Gate the re-open behind the
// fingerprint and that correction is never re-judged, and the resulting error is
// asymmetric: a missed re-judgement always turns a `diverged` into a stale
// `aligned`, never the reverse, so the loop quietly flatters itself on the one metric
// built to measure it honestly.
//
// Cheap by construction. Only a PAST day can have been judged (an expectation for `d`
// matures on d+1), so today — the overwhelmingly common case — costs one string
// compare and no query at all; and reopenDayReadAdherence itself no-ops unless the
// day's logged facts actually moved. Best-effort: re-judging must never fail a write.
//
// Callers run this AFTER COMMIT, so a rolled-back savepoint can never re-open a
// judgement against a write that did not land.
function reopenJudgedDay(d: string): void {
  try {
    if (d < localDateISO()) reopenDayReadAdherence(d);
  } catch {
    /* re-judging is best effort; it must never fail a write */
  }
}

// The same invalidation, but only when the write could actually have changed what
// today should be. `invalidateDayRead` DELETES the row unconditionally, so a
// six-hourly watch sync (or a re-sync writing byte-identical numbers) destroyed the
// warm agentic read before the narrowed decision fingerprint was ever consulted —
// the serve-time comparison wave 1 built could not run on a row that no longer
// existed. Recomputing the deterministic floor and comparing fingerprints costs one
// synchronous read; losing the coach's sentence costs the athlete the Brief.
//
// It is now also what the TRAINING LOG writes go through — logging a set, importing
// Garmin sets, recording an activity, a Garmin upsert or strength reconcile. Those
// fire far more often than a watch sync (once per set), and under the unconditional
// path each one deleted the cached read and armed another agent run, which is how a
// single evening spent ten-plus day_read recomputes on an already-terminal day.
//
// Returns true when the cached read was actually retired. A cold cache still takes
// the normal path — no live read is computed at all — so the fresh-wake background
// re-warm keeps its trigger and a burst against a cold cache stays cheap.
//
// The one thing it does NOT economise is re-judging a day that has already been
// judged — see reopenJudgedDay, which runs on every exit path.
export function invalidateDayReadIfDecisionChanged(date?: string): boolean {
  const d = date || localDateISO();
  let cached: any = null;
  try {
    cached = getCachedDayRead(d);
  } catch {
    cached = null;
  }
  // A curated read is pinned on purpose — only an explicit invalidateDayRead retires it.
  if (cached?.curated) {
    afterSqliteCommit(() => reopenJudgedDay(d));
    return false;
  }
  if (cached && typeof cached.input_fingerprint === "string" && cached.input_fingerprint) {
    // The comparison is only as good as the state it reads, and the unified signal
    // state plus its training-log producers are memoized per (date, request). A
    // caller that already touched them earlier in the SAME request — which is every
    // set-logging request that reconciles or reads before it writes — would compare
    // the PRE-write snapshot, find the fingerprint unmoved, and pin a Brief that is
    // now wrong. Drop exactly the keys invalidateDayRead drops after commit; the
    // 14-day recovery window and the 21-day TDEE stay warm because neither moves on
    // one training write. Outside a request scope this is a no-op.
    //
    // `day_read` belongs in this set even though the cached row is about to SURVIVE:
    // coach.ts memoizes the read with the request's signal state embedded in its
    // `signals`, so dropping signal_state without it would leave the coach context
    // holding a fresh signal_state beside a day_read carrying the stale one. Rebuild
    // is cheap on this path precisely because the row is still there.
    invalidateBrainSnapshot("day_read");
    invalidateBrainSnapshot("signal_state");
    invalidateBrainSnapshot("recent_sessions");
    invalidateBrainSnapshot("training_signals");
    invalidateBrainSnapshot("program_state");
    let live: DayRead | null = null;
    try {
      live = dayRead(d);
    } catch {
      live = null;
    }
    if (live?.input_fingerprint && live.input_fingerprint === cached.input_fingerprint) {
      // The cached READ survives — but the day's JUDGEMENT is still re-opened.
      afterSqliteCommit(() => reopenJudgedDay(d));
      return false;
    }
  }
  invalidateDayRead(d); // re-opens the judgement itself, on its own commit hook
  return true;
}

export function invalidateDayRead(date?: string): void {
  const d = date || localDateISO();
  try {
    db.prepare(`DELETE FROM day_reads WHERE date = ?`).run(d);
  } catch {}
  // Fresh-wake: schedule a debounced, coalesced, fire-and-forget background
  // recompute so the athlete's next open serves a warm agentic read instead of
  // paying the ~90s agent run inline. Best-effort + off the write path — it only
  // acts when `d` covers today AND an agent is usable (see src/dayread-refresh.ts).
  afterSqliteCommit(() => {
    invalidateBrainSnapshot("day_read");
    // The unified signal state is now memoized per (date, request), and a day-read
    // invalidation means the training log just moved underneath it. Drop it and the
    // training-log-derived producers it reads, so a recompute LATER IN THE SAME
    // request sees the write rather than the pre-write snapshot. The two heaviest
    // producers (recovery:14, expenditure:21) are deliberately left warm — neither
    // a 14-day recovery window nor a 21-day TDEE moves on one logged set.
    invalidateBrainSnapshot("signal_state");
    invalidateBrainSnapshot("recent_sessions");
    invalidateBrainSnapshot("training_signals");
    invalidateBrainSnapshot("program_state");
    try {
      scheduleDayReadRefresh(d);
    } catch {}
    // Work that lands for a day ALREADY judged re-opens that judgement. Every
    // training write for a date reaches EITHER this function or its guarded sibling
    // with that date, and BOTH re-open — which is why the hook lives on the two
    // invalidation functions rather than at the eight call sites where the ninth
    // would silently be missed. See reopenJudgedDay for why the guarded path cannot
    // skip it.
    reopenJudgedDay(d);
  });
}

// ---------- T5: frequent foods by time of day ----------
// summary/count/last_at are the load-bearing fields; the macro carry-through
// (kcal/protein_g/carbs_g/fat_g, all optional) is additive — populated from the
// most recent occurrence's parsed_json when present, so a one-tap re-log can
// prefill macros without another agent call. Absent when never enriched.
export interface FrequentFood {
  summary: string;
  count: number;
  // Number of distinct logged days behind the count. A count can be inflated by
  // duplicate entries from one meal; planning code uses this to distinguish a
  // recurring staple from a one-off event without weakening the capture chips.
  distinct_days: number;
  last_at: string;
  kcal?: number | null;
  protein_g?: number | null;
  carbs_g?: number | null;
  fat_g?: number | null;
}

// Collapse a food summary into a grouping key: lowercase, fold whitespace, drop
// trailing punctuation and a leading "a/an/the". Slightly broader than a bare
// toLowerCase() so "Chicken & rice", "chicken and rice " and "the chicken &
// rice." all group together — but conservative on purpose (no stemming, no
// synonym table) so genuinely different meals stay distinct.
function frequentFoodKey(s: string): string {
  return String(s)
    .toLowerCase()
    .replace(/[.,;:!?]+$/g, "") // trailing punctuation
    .replace(/\s*&\s*/g, " and ") // "&" ⇒ "and" so both spellings merge
    .replace(/^\s*(a|an|the)\s+/, "") // leading article
    .replace(/\s+/g, " ") // fold internal whitespace
    .trim();
}

// Recent distinct foods logged near a given hour-of-day (±2h), most-frequent
// first — powers one-tap "frequents" in fast logging. Deterministic, null-safe.
export function frequentFoods(hour?: number): FrequentFood[] {
  const targetHour = Number.isInteger(hour) && hour! >= 0 && hour! <= 23 ? hour! : new Date().getHours();
  // Push the ±2h hour band into SQL (created_at is UTC "YYYY-MM-DD HH:MM:SS", so
  // substr pos 12-13 is the hour) so the LIMIT is a horizon over MATCHING rows,
  // not a blanket recency truncation — otherwise a heavy logger's rarely-used
  // off-peak slot could fall entirely outside the 400 newest rows and return [].
  // The hour set wraps midnight naturally.
  const bandHours: number[] = [];
  for (let dh = -2; dh <= 2; dh++) bandHours.push((((targetHour + dh) % 24) + 24) % 24);
  // Match on WHEN IT WAS EATEN wherever that is recorded, falling back to the write
  // time for every row that has none. Since a note can be backdated ("a late dinner
  // last night", logged this morning), created_at alone would file that dinner under
  // breakfast and quietly poison the time-of-day frequents. eaten_at is a LOCAL
  // "HH:MM" so its hour is directly comparable to targetHour, which is also local.
  const rows = db
    .prepare(
      `SELECT created_at, eaten_at, COALESCE(date, substr(created_at, 1, 10)) AS log_date, meal, parsed_json FROM food_notes
     WHERE CAST(COALESCE(substr(eaten_at, 1, 2), substr(created_at, 12, 2)) AS INTEGER) IN (${bandHours.map(() => "?").join(",")})
     ORDER BY id DESC LIMIT 400`
    )
    .all(...bandHours) as any[];
  const agg = new Map<string, { count: number; last_at: string; days: Set<string> }>();
  for (const r of rows) {
    // eaten_at is local "HH:MM"; created_at is stored UTC ("YYYY-MM-DD HH:MM:SS").
    // Read whichever this row has and accept a ±2h window (wrapping midnight).
    const hh = r.eaten_at ? Number(String(r.eaten_at).slice(0, 2)) : Number(String(r.created_at ?? "").slice(11, 13));
    if (!Number.isFinite(hh)) continue;
    const diff = Math.min(Math.abs(hh - targetHour), 24 - Math.abs(hh - targetHour));
    if (diff > 2) continue;
    let parsed: any = null;
    try {
      parsed = r.parsed_json ? JSON.parse(r.parsed_json) : null;
    } catch {
      parsed = null;
    }
    const summary = String(parsed?.summary ?? r.meal ?? "").trim();
    if (!summary) continue;
    const key = frequentFoodKey(summary);
    if (!key) continue;
    const cur = agg.get(key);
    if (cur) {
      cur.count++;
      if (r.log_date) cur.days.add(String(r.log_date));
      if (String(r.created_at) > cur.last_at) cur.last_at = String(r.created_at);
    } else {
      const days = new Set<string>();
      if (r.log_date) days.add(String(r.log_date));
      agg.set(key, { count: 1, last_at: String(r.created_at), days });
    }
  }
  // Recover display casing from the NEWEST occurrence of each key (rows are
  // id-DESC, so the first one we see per key wins), and macros from the newest
  // occurrence that actually CARRIES them — the most recent log of a food is
  // often a quick text entry not yet enriched, so we want the freshest enriched
  // estimate to prefill, not null.
  const display = new Map<string, string>();
  const macros = new Map<
    string,
    { kcal: number | null; protein_g: number | null; carbs_g: number | null; fat_g: number | null }
  >();
  const num = (v: any): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  for (const r of rows) {
    let parsed: any = null;
    try {
      parsed = r.parsed_json ? JSON.parse(r.parsed_json) : null;
    } catch {
      parsed = null;
    }
    const summary = String(parsed?.summary ?? r.meal ?? "").trim();
    if (!summary) continue;
    const key = frequentFoodKey(summary);
    if (!key) continue;
    if (!display.has(key)) display.set(key, summary);
    if (!macros.has(key)) {
      const m = {
        kcal: num(parsed?.kcal),
        protein_g: num(parsed?.protein_g),
        carbs_g: num(parsed?.carbs_g),
        fat_g: num(parsed?.fat_g),
      };
      // Only lock in macros once we find an occurrence that has at least one —
      // skip bare text logs so a later (older) enriched row can supply them.
      if (m.kcal != null || m.protein_g != null || m.carbs_g != null || m.fat_g != null) macros.set(key, m);
    }
  }
  return [...agg.entries()]
    .map(([key, v]) => {
      const m = macros.get(key);
      return {
        summary: display.get(key) ?? key,
        count: v.count,
        distinct_days: v.days.size,
        last_at: v.last_at,
        kcal: m?.kcal ?? null,
        protein_g: m?.protein_g ?? null,
        carbs_g: m?.carbs_g ?? null,
        fat_g: m?.fat_g ?? null,
      };
    })
    .sort((a, b) => b.count - a.count || (b.last_at > a.last_at ? 1 : -1))
    .slice(0, 8);
}
