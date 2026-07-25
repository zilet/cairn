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
import { invalidateBrainSnapshot } from "../brain/snapshot.js";
import {
  pickDayVariant,
  resolveDayReadRule,
  UNPROGRAMMED_EASY_DAY,
  type DayReadRule,
  type DayReadRuleOutcome,
} from "./brain/day-read-rules.js";
import { insertBrainDecision, transitionBrainDecision } from "./brain-decisions.js";
import { getCheckinByDate, getRecoverySummary, latestSleep } from "./coach.js";
import { activeContextEffect } from "./context-effect.js";
import { activitySportWhere, RUN_SPORT_PATTERNS } from "./endurance-sports.js";
import { listContextEvents } from "./health.js";
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
import { programBalance } from "./progression.js";
import { daysBetweenISO, localDateISO } from "./shared.js";
import {
  planningSignalState,
  signalVoice,
  spokenSignalVoice,
  SIGNAL_VOICE_KEYS,
  SIGNAL_VOICE_REGISTRY,
  type UnifiedSignalState,
} from "./signal-state.js";
import { afterSqliteCommit } from "./sqlite-savepoint.js";
import {
  type TrainingLoad,
  dayLoad,
  hardCardioDay,
  hybridDayContext,
  recentCardioLoadMedian,
  recoverySessionDose,
} from "./training-read.js";
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
const TRAIN_CAVEAT_LEAD: readonly string[] = [
  "You're good to train",
  "Today's a green light",
  "You're clear to train",
  "The session's on",
];
const RECOVERY_WEEK_TRAIN_WHY: ReadonlyArray<(focus: string) => string> = [
  (focus) => `${focus} keeps the recovery-week rhythm — use the reduced prescription and leave the reps crisp.`,
  (focus) => `${focus}, at this week's reduced dose — crisp reps, well shy of failure.`,
  (focus) => `${focus} today, kept light on purpose. This week is about rhythm, not load.`,
];

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

// Keyed by rule_code (the SAME string dayread.ts passes as both the ledger code and
// the pickDayVariant key), mirroring DAY_READ_WHY_VARIANTS so the two vocabularies —
// the day's `why` and the server policy's `reason` — are tested the same way.
export const DAY_READ_POLICY_REASON_VARIANTS: Readonly<Record<string, readonly string[]>> = {
  completion_fact_not_logged: COMPLETION_FACT_NOT_LOGGED_REASON,
  completion_fact_preserved: COMPLETION_FACT_PRESERVED_REASON,
  deterministic_safety_floor: DETERMINISTIC_SAFETY_FLOOR_REASON,
  recovery_week_reduced_train_after_non_loading_day: RECOVERY_WEEK_REDUCED_TRAIN_REASON,
  recovery_week_rest_softened_to_easy_after_loading_day: RECOVERY_WEEK_SOFTEN_REASON,
};

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
  low_readiness_rest: LOW_READINESS_WHY,
  felt_run_down_rest: RUN_DOWN_WHY,
  logged_light_work_today: LIGHT_WORK_WHY,
  endurance_volume_spike: VOLUME_SPIKE_WHY,
  chronic_sleep_watch: CHRONIC_SLEEP_WHY,
  unprogrammed_easy_day: UNPROGRAMMED_WHY,
  planned_training: TRAIN_CLEAR_WHY,
  planned_reduced_training: RECOVERY_WEEK_TRAIN_WHY.map((render) => render("Lower body")),
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
  low_readiness_rest: /\b(?:readiness|reading)\b/i,
  felt_run_down_rest: /\b(?:run-down|low)\b/i,
  logged_light_work_today: /\b(?:moved|movement|board)\b/i,
  endurance_volume_spike: /\b(?:running|run|mileage)\b/i,
  chronic_sleep_watch: /\bsleep\b/i,
  planned_reduced_training: /\b(?:reduced|light|lighter)\b/i,
  planned_training: /\b(?:due|train|session)\b/i,
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
    // A movement work-around (an active injury) is safety guidance that lives only in
    // the `why` — keep it and let the escalation follow, rather than replacing it. And
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
    proposal_id: number;
    label: "reduced volume";
  } | null;
}

export function dayReadPeriodizationContext(date: string): DayReadPeriodizationContext {
  try {
    const block = getActiveBlock();
    const recovery = activeRecoveryWeekLedger(date);
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
              proposal_id: recovery.proposal_id,
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
}

// dayRead()'s contract is that it never throws on missing data, and this runs
// inside it — a program_blocks read that fails must degrade to "no block", not
// take the Brief down. writeDayRead already guarded the identical call.
function currentDayReadFingerprintContext(): DayReadFingerprintContext {
  try {
    const programBlock = db
      .prepare(
        `SELECT goal, focus, phase, week_index, total_weeks, started_at
           FROM program_blocks WHERE status = 'active' ORDER BY id DESC LIMIT 1`
      )
      .get() as any;
    return { program_block: programBlock ?? null };
  } catch {
    return { program_block: null };
  }
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
// Pure over the supplied read and explicit block context. Fuel deliberately stays
// out: it has its own both-present serve-time comparator, which preserves cached
// rows written before the visible fuel signal existed.
export function dayReadInputFingerprint(
  date: string,
  read: Pick<DayRead, "kind" | "focus" | "signals">,
  context: DayReadFingerprintContext = { program_block: null }
): string {
  const signals = read.signals ?? {};
  const shortNight = (minutes: unknown): boolean => {
    const value = Number(minutes);
    return Number.isFinite(value) && value > 0 && value < 360;
  };
  const input = {
    date,
    baseline_kind: read.kind,
    focus: read.focus ?? null,
    program_block: context.program_block,
    recovery_week: signals.recovery_week ?? null,
    recent_load: signals.recent_load ?? null,
    today_load: signals.today_load ?? null,
    trained_today: signals.trained_today ?? null,
    logged_today: signals.logged_today ?? null,
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
    context: signals.context ?? null,
    // The unified signal state's DECISION, not its narration: `reason`/`reasons`/
    // `confidence` restate the same posture in different words as evidence lines
    // come and go (an HRV field arriving mid-day rewrites the sentence and lifts
    // confidence without changing what to do), which is churn, not a new decision.
    signal_action: signals.signal_state?.action
      ? {
          posture: signals.signal_state.action.posture ?? null,
          directives: signals.signal_state.action.directives ?? null,
        }
      : null,
    underfueling: signals.underfueling
      ? {
          state: signals.underfueling.state ?? null,
          action: signals.underfueling.action ?? null,
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
      currentDayReadFingerprintContext()
    ),
  };
}

// Deterministic baseline (T1 layers the agentic sentence + buildDayReadPrompt on
// top). Rules: rest if >=3 consecutive training days OR recovery clearly low;
// else train the suggested plan day; else easy. Never throws on missing data.
export function dayRead(
  date?: string,
  recovery?: any,
  unifiedState?: UnifiedSignalState,
  underfuelingSnapshot?: UnderfuelingRead
): DayRead {
  const d = date || localDateISO();
  const recoveryWeek = activeRecoveryWeek(d);

  // Discipline shapes what "a training day" means for the consecutive-days +
  // earned-rest rules. For a strength athlete a logged lifting session counts;
  // for an endurance/hybrid athlete a real cardio effort (a run/ride) is also a
  // training day — otherwise a runner's whole week is invisible and the Brief
  // keeps suggesting fresh sessions on top of hard mileage. Default 'strength'
  // keeps the existing behavior byte-for-byte.
  const discipline = getPrimaryDiscipline();
  const countsCardio = discipline === "endurance" || discipline === "hybrid";

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
  const SLEEP_FRESH_DAYS = 2;
  const lsRaw = latestSleep();
  let lastNight = lsRaw;
  if (lsRaw?.date) {
    const ageDays = Math.round((Date.parse(d + "T00:00:00Z") - Date.parse(lsRaw.date + "T00:00:00Z")) / 864e5);
    if (!(ageDays >= 0 && ageDays <= SLEEP_FRESH_DAYS)) lastNight = null;
  }
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
  const acuteLoad = rec?.recovery?.acute_load ?? null;
  // Readiness is a CURRENT decision signal only when its dated reading is today or
  // yesterday relative to the day being read. The multi-day average remains useful
  // context, but can never force a current recommendation (and a stale current value
  // cannot either).
  const readinessQuality = rec?.quality?.training_readiness ?? rec?.recovery?.quality?.training_readiness ?? null;
  const readinessCurrent = rec?.recovery?.training_readiness ?? null;
  const readinessDate = readinessQuality?.latest_date ?? null;
  const readinessAgeDays = readinessDate
    ? Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${readinessDate}T00:00:00Z`)) / 864e5)
    : null;
  const readinessFresh = readinessAgeDays != null && readinessAgeDays >= 0 && readinessAgeDays <= 1;
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
      return (listContextEvents() as any[]).filter(
        (event) =>
          !event?.archived &&
          !event?.resolved &&
          (!event?.start_date || event.start_date <= d) &&
          (!event?.end_date || event.end_date >= d)
      );
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
  const signalState =
    unifiedState ??
    planningSignalState({
      date: d,
      recovery: rec,
      checkin,
      context: ctx,
      contextEvents,
      underfueling: fuelProtection,
      completedToday: (trainedToday || !!bigActivity) && (todayLoad === "hard" || todayLoad === "moderate"),
    });
  (signals as any).signal_state = signalState;
  // A movement work-around is a fact about the ATHLETE, not a property of whichever
  // rule wins the morning, so it is probed once here rather than inside a rule. It
  // used to live inside the protect rule below — so the day a corroborated short
  // night preempted that rule (the two co-occur constantly, since health constraints
  // are what drive the protect posture in the first place) the injury went unnamed,
  // and `applyContinuityVoice`, which branches on this signal, then SUBSTITUTED its
  // escalation for the read: an injured athlete on their third quiet day was told
  // ten easy minutes on their feet was plenty, with no guardrail at all.
  const activeInjury =
    signalState.dimensions.health_constraints.evidence.find(
      (item) => item.field === "active_injury" && item.freshness !== "stale"
    ) ?? null;
  if (activeInjury) {
    (signals as any).health_workaround = { field: "active_injury", reason: activeInjury.summary };
  }
  // Hybrid runner+lifter sequencing (one additive signal entry). Purely informational —
  // it NEVER changes the kind decision or adds an interruption; the agentic layer voices
  // it warmly when it fits. Omitted entirely when nothing sequences, so existing reads are
  // byte-for-byte unchanged. Null-safe: any failure leaves it off.
  try {
    const hc = hybridDayContext(d);
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
        const stackedLoadingRest = consec >= 3 && !recoveryWeek;
        if (!(yesterdayRecoveryOverdose || stackedLoadingRest || lowSubjective || lowReadiness)) return null;
        // Each branch reports the outcome that matches its own words. Before the
        // reason moved onto the rule, a low check-in or a low readiness reading was
        // filed under "accumulated load" and explained as stacked training days the
        // athlete may not have done. (Both of those now reach rest through the
        // unified protect posture above, so their branches here are shadowed in
        // practice — labelled correctly regardless, so a future reorder can't
        // resurrect the mislabel.)
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
        const caveats: string[] = [];
        if (recoveryWeek)
          caveats.push("this is the reduced recovery-week dose, so keep every set crisp and well shy of failure");
        if (reduceItem)
          caveats.push(
            reduceItem.kind === "injury"
              ? `you've got ${String(reduceItem.title || "an injury").toLowerCase()} to work around — train around it and skip anything that aggravates it`
              : "there's something to ease around right now, so keep the load conservative"
          );
        if (sd.selection?.adapted && sd.selection?.reason) caveats.push(String(sd.selection.reason));
        if (anticipateDeload)
          caveats.push(
            "recovery's drifting below your norm, so a couple more hard days and you'll likely want a reset"
          );
        if (volumeSpike)
          caveats.push("your running's ramped this week, so keep today's miles easy and don't pile on hard intensity");
        // A CHRONICALLY short sleeper is a caveat on the session, not a reason to
        // withhold it. This used to be its own rule ABOVE this one, so anyone whose
        // rolling average sat under six hours was never offered a due plan day at all
        // — permanent rest traded for permanent easy. The watch still gets voiced (and
        // the rule survives below, for a day with nothing programmed to soften).
        if (lowSleep)
          caveats.push("sleep's been running short lately, so keep the session controlled and stop a rep or two shy");
        const holdAggression = signalState.action.directives.training === "hold_aggression";
        // Same rule as the protect read above: the athlete hears the athlete voice,
        // never the machine-facing summary. This is the second (and only other) path by
        // which the signal state's own words reach a `why` — it LEADS the read here
        // rather than sitting mid-sentence after the dash, because these are whole
        // sentences (several of them carry their own dash) and the caveat list is a
        // run of lowercase fragments.
        const holdLead = holdAggression ? spokenSignalVoice(signalState.action.voice, d, "planned_training:hold") : "";
        if (holdAggression) caveats.push("hold off on adding load or volume until that settles");
        const compressSchedule =
          signalState.action.posture === "train" && signalState.action.directives.schedule === "compress";
        if (compressSchedule) {
          const scheduleReason = signalState.dimensions.life_capacity.reason;
          caveats.push("a current dated commitment compresses today's training window, so keep the session focused");
          (signals as any).schedule = {
            directive: "compress",
            compressed: true,
            original_est_minutes: 60,
            est_minutes: 40,
            reason: scheduleReason,
          };
        }
        const why = holdAggression
          ? `${holdLead} Keep today's work conservative — ${caveats.join("; and ")}.`
          : caveats.length
            ? `${pickDayVariant(TRAIN_CAVEAT_LEAD, d, "planned_training:caveats")} — ${caveats.join("; and ")}.`
            : recoveryWeek
              ? pickDayVariant(RECOVERY_WEEK_TRAIN_WHY, d, "planned_reduced_training")(sd.focus || "Training")
              : pickDayVariant(TRAIN_CLEAR_WHY, d, "planned_training");
        return {
          outcome: recoveryWeek ? DAY_READ_OUTCOMES.planned_reduced_training : DAY_READ_OUTCOMES.planned_training,
          read: { kind: "train", focus: sd.focus, why, est_minutes: compressSchedule ? 40 : 60, signals },
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
  const outcome = resolved?.outcome ?? UNPROGRAMMED_EASY_DAY;
  const resolvedRead = resolved?.read ?? {
    kind: "easy" as const,
    focus: null,
    why: pickDayVariant(UNPROGRAMMED_WHY, d, "unprogrammed_easy_day"),
    est_minutes: 20,
    signals,
  };
  // The movement work-around closes EVERY protective read, whichever rule produced it
  // — a short night, stacked load, a light walk already logged, or the bare floor. It
  // used to be spoken by one rule only, so the athlete's injury guidance disappeared
  // the moment a different rule won the posture. A train day is excluded on purpose:
  // that read voices the same constraint in its own caveat list ("train around it and
  // skip anything that aggravates it"), and a `done` day is a fact about work already
  // finished, not a suggestion to work around.
  const base =
    activeInjury && QUIET_KINDS.has(resolvedRead.kind)
      ? {
          ...resolvedRead,
          // Named in the athlete's own register and rotated by day like everything
          // else. It used to splice the evidence `summary` behind a fixed lead-in —
          // one sentence printed verbatim for as long as the injury lasted, carrying
          // context-effect's generic classifier line along with the injury's name
          // ("…around the active injury: Achilles tendinopathy: an active injury is
          // worth easing or working around."). endStopped stays: everything the
          // continuity voice adds lands AFTER this, so the sentence must close.
          why: `${resolvedRead.why} ${endStopped(
            spokenSignalVoice(activeInjury.voice ?? { key: "active_injury" }, d, SIGNAL_VOICE_KEYS.injury)
          )}`,
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
    due = Array.isArray(bal?.due) ? bal.due.slice(0, 2) : [];
  } catch {
    /* no balance → no due groups */
  }
  const parts: string[] = [];
  if (next_focus) parts.push(`Next: ${next_focus}`);
  if (due.length) parts.push(`${due.join(" & ")} due this week`);
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
export function weekAheadPlan(): { days: WeekAheadDay[]; summary: string } {
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
    const bal = programBalance();
    if (Array.isArray(bal?.due) && bal.due.length)
      notes.push(
        `${bal.due.slice(0, 3).join(", ")} ${bal.due.length === 1 ? "is" : "are"} due — work ${bal.due.length === 1 ? "it" : "them"} in`
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
      inputFingerprint = dayReadInputFingerprint(date, read, currentDayReadFingerprintContext());
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
  // Persist the recommendation as a bounded, outcome-addressable decision. This
  // runs after the canonical cache write and is intentionally fail-soft: an audit
  // outage must never make the Brief unavailable.
  try {
    const decisionInput = {
      effective_date: date,
      kind: "day_read",
      domain: "cross_domain",
      summary: String(read.headline || `${String(read.kind)} day`).slice(0, 300),
      rationale: read.why ?? null,
      source: read.source ?? "deterministic",
      source_ref_type: "day_read",
      source_ref_key: date,
      status: "observed",
      autonomy_tier: "observe",
      risk_class: "low",
      reversible: false,
      input_fingerprint: null,
      context: { signals: read.signals ?? {}, override },
      action: {
        kind: read.kind,
        focus: read.focus ?? null,
        est_minutes: read.est_minutes ?? null,
        why: read.why ?? null,
      },
      specialist: null,
      applied_at: null,
      reverted_at: null,
      superseded_by: null,
      evaluator_version: null,
    } as const;
    // The cache has one mutable row per date; the accountability ledger does not.
    // Preserve each materially different observation as a new immutable entry,
    // then supersede every prior current observation for the same date. A byte-for-
    // byte repeat is idempotent, while its older legacy siblings are still closed.
    const existing = db
      .prepare(
        `SELECT id, summary, rationale, source, context_json, action_json
           FROM brain_decisions
          WHERE kind = 'day_read' AND source_ref_type = 'day_read'
            AND source_ref_key = ? AND status = 'observed'
          ORDER BY id DESC`
      )
      .all(date) as any[];
    const material = {
      summary: decisionInput.summary,
      rationale: decisionInput.rationale,
      source: decisionInput.source,
      context_json: JSON.stringify(decisionInput.context),
      action_json: JSON.stringify(decisionInput.action),
    };
    const newest = existing[0] ?? null;
    const sameMaterial =
      !!newest &&
      String(newest.summary ?? "") === material.summary &&
      (newest.rationale ?? null) === material.rationale &&
      (newest.source ?? null) === material.source &&
      (newest.context_json ?? null) === material.context_json &&
      (newest.action_json ?? null) === material.action_json;
    const current = sameMaterial ? newest : insertBrainDecision(decisionInput);
    if (current?.id) {
      for (const prior of sameMaterial ? existing.slice(1) : existing) {
        transitionBrainDecision(Number(prior.id), "superseded", { supersededBy: Number(current.id) });
      }
    }
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

// The same invalidation, but only when the write could actually have changed what
// today should be. `invalidateDayRead` DELETES the row unconditionally, so a
// six-hourly watch sync (or a re-sync writing byte-identical numbers) destroyed the
// warm agentic read before the narrowed decision fingerprint was ever consulted —
// the serve-time comparison wave 1 built could not run on a row that no longer
// existed. Recomputing the deterministic floor and comparing fingerprints costs one
// synchronous read; losing the coach's sentence costs the athlete the Brief.
//
// Returns true when the cached read was actually retired. A cold cache still takes
// the normal path, so the fresh-wake background re-warm keeps its trigger.
export function invalidateDayReadIfDecisionChanged(date?: string): boolean {
  const d = date || localDateISO();
  let cached: any = null;
  try {
    cached = getCachedDayRead(d);
  } catch {
    cached = null;
  }
  // A curated read is pinned on purpose — only an explicit invalidateDayRead retires it.
  if (cached?.curated) return false;
  if (cached && typeof cached.input_fingerprint === "string" && cached.input_fingerprint) {
    let live: DayRead | null = null;
    try {
      live = dayRead(d);
    } catch {
      live = null;
    }
    if (live?.input_fingerprint && live.input_fingerprint === cached.input_fingerprint) return false;
  }
  invalidateDayRead(d);
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
    try {
      scheduleDayReadRefresh(d);
    } catch {}
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
  const rows = db
    .prepare(
      `SELECT created_at, COALESCE(date, substr(created_at, 1, 10)) AS log_date, meal, parsed_json FROM food_notes
     WHERE CAST(substr(created_at, 12, 2) AS INTEGER) IN (${bandHours.map(() => "?").join(",")})
     ORDER BY id DESC LIMIT 400`
    )
    .all(...bandHours) as any[];
  const agg = new Map<string, { count: number; last_at: string; days: Set<string> }>();
  for (const r of rows) {
    // created_at is stored UTC ("YYYY-MM-DD HH:MM:SS"); read the hour and accept
    // a ±2h window (wrapping midnight) around the target.
    const hh = Number(String(r.created_at ?? "").slice(11, 13));
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
