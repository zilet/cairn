// The morning wake-up review — the short past-tense passage the Brief shows
// ABOVE today's suggestion (W4.7). It answers two questions the brain already
// has evidence for and does not predict anything new: did YESTERDAY'S morning
// read hold, and did anything the brain was already watching just land?
//
// Deliberately consumes existing machinery rather than re-deriving it:
//   - the divergence half reads read-adherence.ts's own idea of "what was the
//     athlete actually told" (morningReadForDate) and "did they follow it"
//     (readAdherenceOutcome) — this module never re-grades a day itself;
//   - the win half reads a matured brain_expectation the ledger already
//     evaluated, never a fresh prediction.
//
// SILENCE IS THE DEFAULT. An unremarkable yesterday — nothing predicted, or a
// train read simply followed, or nothing landing — returns nothing at all, and
// a genuine miss (a train read nobody followed) is never spoken here either:
// VISION.md bans "you didn't train" as a judgment, and the read-adherence
// softening ladders (restOverrideSoftening / easyOverrideSoftening) are the
// only consumers allowed to reason about a miss — this module only ever speaks
// the two shapes that are safe to say out loud: a quiet day that was HONORED,
// and a quiet day that was OVERRIDDEN with nothing visible to show for it
// costing them. Every sentence a rotating variant set, never a single literal
// (pickDayVariant, the same pattern as day-read-rules.ts).
import { db } from "../../db.js";
import type { BrainMetricKey } from "../../brain/expectation-contract.js";
import { addDaysISO } from "../shared.js";
import { runIntensityDiscipline } from "../run-progression.js";
import { pickDayVariant } from "./day-read-rules.js";
import {
  dayTrainingTruth,
  harmEvidenceOnDay,
  morningReadForDate,
  readAdherenceModel,
  readAdherenceOutcome,
} from "./read-adherence.js";

export interface MorningReview {
  // Past-tense, athlete-facing sentences about yesterday. [] when there is
  // nothing worth saying — the caller renders nothing for an empty array.
  passages: string[];
  // One earned win — a brain_expectation that matured aligned overnight — or
  // null when nothing landed. Kept separate from `passages` because it is a
  // different KIND of fact (a promise kept, not a read followed or overridden)
  // and a caller may want to render it with its own emphasis.
  win: string | null;
}

const EMPTY_REVIEW: MorningReview = Object.freeze({ passages: [], win: null });

function safe<T>(fn: () => T | null): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

// ---------- (a): did yesterday go the way the morning read said it would? ----------
//
// Only rest and easy reads are spoken about. A train read simply followed is the
// unremarkable, expected case — printing it every morning would be noise, not
// evidence — and a train read NOT followed is a miss, which this module never
// states (see the module note above). Rest/easy carry the two shapes that are
// always safe to say: the read was honored (a positive, not a punishment), or it
// was overridden and nothing visible came of it (curiosity, not judgment).

const KEPT_REST_VARIANTS = [
  "Yesterday's rest read stood, and you took it.",
  "You rested yesterday, the way the morning called for.",
  "Yesterday's quiet day was taken as read — no training logged.",
  "The read said rest yesterday, and that's what happened.",
] as const;

const KEPT_EASY_VARIANTS = [
  "Yesterday's easy read held — nothing above easy got logged.",
  "You kept yesterday at easy, the way the morning asked.",
  "The read said easy yesterday, and it stayed that way.",
] as const;

const DIVERGED_REST_HARMLESS_VARIANTS = [
  "The read said rest yesterday; you trained anyway, and nothing since suggests it cost you.",
  "Yesterday called for rest and you went ahead — noted, with no sign it cost you anything.",
  "You overrode yesterday's rest read, and it looks to have landed fine.",
] as const;

const DIVERGED_REST_PLAIN_VARIANTS = [
  "The read said rest yesterday; you trained anyway — noted.",
  "Yesterday called for rest and you went ahead instead — noted.",
] as const;

const DIVERGED_EASY_HARMLESS_VARIANTS = [
  "The read said easy yesterday; you went past it, and it looks to have cost nothing visible.",
  "Yesterday asked for easy and you pushed on — noted, with nothing rougher showing since.",
  "You went further than yesterday's easy read asked, and nothing since says it cost you.",
] as const;

const DIVERGED_EASY_PLAIN_VARIANTS = [
  "The read said easy yesterday; you went past it — noted.",
  "Yesterday asked for easy and you pushed on instead — noted.",
] as const;

// ---------- NAMING THE CAUSE (owner ruling, 2026-09-02) ----------
//
// The plain sets above were selected by `trainedWithoutHarm(yesterday) === false`
// — a bare boolean — so the ONE thing the brain actually knew about the day went
// unsaid. The live shape: the athlete lifted well through a quiet read and then
// ran their "easy" run above their own easy ceiling, `harmEvidenceOnDay` answered
// `hard_cardio`, and the Brief printed "you went past it — noted." A curt ledger
// entry that withholds its own reason is the opposite of a coach, and on the
// fourth morning it reads as a parent keeping score (VISION.md §2: never anxious,
// adherence-neutral).
//
// So the look-back asks for the EVIDENCE, not the boolean, and when the cost is
// intensity-shaped — the run graded hard, or a first of its kind — it says which
// half of the day carried it and what opens the mornings back up. The unlock is
// the same one the train-read arm already speaks (EARN_PATH_INTENSITY in
// day-read.ts): the athlete's own easy ceiling in bpm, a measurement rather than a
// grade, and the only number allowed in this passage. With no ceiling to name
// (no heart-rate model, or a distribution that reads fine) the same sentence is
// spoken without one rather than vaguely — a run that ran hard is still a fact.
const CAUSE_INTENSITY_CEILING_VARIANTS: ReadonlyArray<(ceiling: string) => string> = [
  (ceiling) =>
    `You lifted well through yesterday's quiet read — it was the run that tipped it, finishing above your easy ceiling of ${ceiling}. Bring the next one in under that and the mornings open back up.`,
  (ceiling) =>
    `The lifting yesterday was not the cost; the run was, sitting above the ${ceiling} where easy actually lives for you. A run or two under it and there's room to build again.`,
  (ceiling) =>
    `Yesterday's session held up fine. What made it a hard day was the run finishing north of ${ceiling} — keep the next easy one under that and this loosens.`,
  (ceiling) =>
    `It wasn't the weights that made yesterday costly — the run came in above ${ceiling}, your own easy ceiling. One that genuinely stays under it gives the harder days somewhere to go.`,
] as const;

const CAUSE_INTENSITY_PLAIN_VARIANTS = [
  "You lifted well through yesterday's quiet read — it was the run that tipped it, coming in harder than easy. Let the next one actually run easy and the mornings open back up.",
  "The lifting yesterday was not the cost; the run was, finishing well above easy. An easy one that stays easy is what gives this back.",
  "Yesterday's session held up fine. What made it a hard day was the run running hard — keep the next one genuinely easy and this loosens.",
  "It wasn't the weights that made yesterday costly, it was the run going harder than easy. One run that stays easy and there's room to build again.",
] as const;

// The same two sets for a day with no lifting in it. A run-only divergence cannot
// be told "the lifting was not the cost" — there was none — so the run keeps the
// whole sentence and the unlock is unchanged.
const CAUSE_INTENSITY_RUN_ONLY_CEILING_VARIANTS: ReadonlyArray<(ceiling: string) => string> = [
  (ceiling) =>
    `Yesterday's run is what made it a hard day — it finished above your easy ceiling of ${ceiling}. Bring the next one in under that and the mornings open back up.`,
  (ceiling) =>
    `The run yesterday sat above the ${ceiling} where easy actually lives for you, which is what turned a quiet day into a loading one. A run or two under it and there's room to build again.`,
  (ceiling) =>
    `What cost you yesterday was the run finishing north of ${ceiling} — keep the next easy one under that and this loosens.`,
] as const;

const CAUSE_INTENSITY_RUN_ONLY_PLAIN_VARIANTS = [
  "Yesterday's run is what made it a hard day — it came in harder than easy. Let the next one actually run easy and the mornings open back up.",
  "The run yesterday finished well above easy, which is what turned a quiet day into a loading one. An easy one that stays easy is what gives this back.",
  "What cost you yesterday was the run running hard rather than easy — keep the next one genuinely easy and this loosens.",
] as const;

const CAUSE_LONGEST_RUN_VARIANTS = [
  "The long run is what made yesterday a big day — it went further than anything in months. A quieter day lets that one land.",
  "Yesterday's run was the longest you've done in months, and a first like that asks for a little room afterwards.",
  "The distance is what made yesterday big — that run was further than any in months, and it's worth letting settle.",
] as const;

// The pattern, said once. Three consecutive quiet mornings trained through with
// nothing but intensity behind them is no longer a divergence to note — it is the
// athlete telling the brain what kind of week they want, and the honest answer is
// the trade rather than a fourth "noted". Deliberately hands off to the rest trade
// (the calendar carries it; the plan's rhythm is untouched) instead of arguing.
const STREAK_TRADE_VARIANTS: ReadonlyArray<(days: string) => string> = [
  (days) =>
    `That's ${days} mornings running you've trained through a quiet read, with nothing since saying it cost you. If you'd rather keep going today, trade the quiet day forward and take it tomorrow.`,
  (days) =>
    `${days} quiet mornings in a row now, answered the same way each time and nothing the worse for it. Today can stay a training day — take the rest tomorrow instead.`,
  (days) =>
    `You've trained through ${days} quiet mornings in a row now. The break still counts if it lands tomorrow rather than today.`,
] as const;

// Three, the same bar the softening ladders use: two is a coincidence, three is a
// pattern the athlete has actually stated.
const TRADE_HANDOFF_STREAK = 3;

// How many consecutive quiet mornings — ending yesterday — the athlete trained
// through with nothing but intensity-shaped evidence behind them.
//
// A rated-poor session or the next morning's physiology answering IS a different
// fact, and it BREAKS the streak rather than extending it: the trade this streak
// hands off to is an answer to a rhythm the athlete disagrees with, never an
// answer to their body having spoken. Read off the rolling ReadAdherenceModel the
// softening ladders already build, walked back over CONTIGUOUS calendar days so a
// gap (an untracked day, a day with no read) ends the run rather than jumping it.
function quietOverrideStreak(date: string): number {
  const model = safe(() => readAdherenceModel(date));
  if (!model || !Array.isArray(model.recent)) return 0;
  const byDate = new Map(model.recent.map((day) => [day.date, day]));
  let streak = 0;
  let cursor = addDaysISO(date, -1);
  while (cursor) {
    const day = byDate.get(cursor);
    if (!day) break;
    if (day.read !== "rest" && day.read !== "easy") break;
    if (day.outcome !== "diverged") break;
    const harm = safe(() => harmEvidenceOnDay(cursor as string));
    if (harm && harm.kind !== "hard_cardio" && harm.kind !== "longest_run") break;
    streak += 1;
    cursor = addDaysISO(cursor, -1);
  }
  return streak;
}

// The athlete's OWN easy ceiling, in bpm, or null when there is none to name.
// Gated on exactly the reading that puts the ceiling in front of the athlete
// elsewhere (`run_intensity_compressed`'s subject, signal-state.ts): a healthy
// distribution says nothing at all, so this passage does not invent a ceiling to
// scold with.
function easyCeiling(date: string): string | null {
  const read = safe(() => runIntensityDiscipline(date));
  if (!read || read.status !== "compressed") return null;
  const top = Number(read.z2_top);
  return Number.isFinite(top) ? `${Math.round(top)} bpm` : null;
}

const STREAK_WORDS = ["", "one", "two", "three", "four", "five", "six", "seven"] as const;
const streakWord = (streak: number): string => STREAK_WORDS[streak] ?? `${streak}`;

function dayComparisonPassages(date: string): string[] {
  const yesterday = addDaysISO(date, -1);
  if (!yesterday) return [];
  const morning = morningReadForDate(yesterday);
  if (!morning || (morning.kind !== "rest" && morning.kind !== "easy")) return [];
  const truth = dayTrainingTruth(yesterday);
  const outcome = readAdherenceOutcome(morning.kind, truth);
  if (outcome === "unclear") return [];
  const variantKey = `${morning.kind}_${outcome}`;
  if (outcome === "followed") {
    const kept = morning.kind === "rest" ? KEPT_REST_VARIANTS : KEPT_EASY_VARIANTS;
    return [pickDayVariant(kept, date, variantKey)];
  }

  const harm = safe(() => harmEvidenceOnDay(yesterday));
  const streak = quietOverrideStreak(date);
  const patternSpeaks = streak >= TRADE_HANDOFF_STREAK;
  // The streak length rides in every key on this arm, so the third morning of one
  // shape never prints the second morning's sentence.
  const key = `${variantKey}_${streak}`;
  const passages: string[] = [];

  if (harm?.kind === "hard_cardio") {
    const ceiling = easyCeiling(yesterday);
    // "The lifting was not the cost" is only sayable when there WAS lifting.
    const lifted = Number(truth.sets) > 0;
    const withCeiling = lifted ? CAUSE_INTENSITY_CEILING_VARIANTS : CAUSE_INTENSITY_RUN_ONLY_CEILING_VARIANTS;
    const withoutCeiling = lifted ? CAUSE_INTENSITY_PLAIN_VARIANTS : CAUSE_INTENSITY_RUN_ONLY_PLAIN_VARIANTS;
    passages.push(
      ceiling
        ? pickDayVariant(withCeiling, date, `${key}_ceiling`)(ceiling)
        : pickDayVariant(withoutCeiling, date, `${key}_intensity`)
    );
  } else if (harm?.kind === "longest_run") {
    passages.push(pickDayVariant(CAUSE_LONGEST_RUN_VARIANTS, date, `${key}_longest_run`));
  } else if (!harm) {
    const harmless = morning.kind === "rest" ? DIVERGED_REST_HARMLESS_VARIANTS : DIVERGED_EASY_HARMLESS_VARIANTS;
    passages.push(pickDayVariant(harmless, date, key));
  } else if (!patternSpeaks) {
    // Rated poorly, or the next morning answered. The plain set is the FIRST-TIME
    // set now — and a body-response day cannot reach the streak arm at all, so
    // "noted" can never be the third morning's whole sentence.
    const plain = morning.kind === "rest" ? DIVERGED_REST_PLAIN_VARIANTS : DIVERGED_EASY_PLAIN_VARIANTS;
    passages.push(pickDayVariant(plain, date, key));
  }

  if (patternSpeaks) {
    passages.push(pickDayVariant(STREAK_TRADE_VARIANTS, date, `${key}_trade`)(streakWord(streak)));
  }
  return passages;
}

// ---------- (c): did anything the brain was already watching just land? ----------
//
// A brain_expectation that matured overnight and evaluated `aligned` is a
// speakable win — a promise the brain made out loud (in `brain_decisions`) that
// the ledger has since confirmed, never a fresh claim invented here. Deliberately
// a small allowlist of metric keys: only ones with an unambiguous, plain-language
// "this got better" reading. `day_read_adherence` is excluded — that is the SAME
// evidence dayComparisonPassages above already speaks in its own voice, and
// speaking it twice would double-count one fact as two.
const WIN_METRIC_VARIANTS: Partial<Record<BrainMetricKey, readonly [string, ...string[]]>> = {
  recovery_hrv_delta: [
    "The lighter stretch did what it promised — HRV came back.",
    "HRV came back the way the easier days were meant to bring it.",
    "The easier days paid off — HRV is back up.",
  ],
  recovery_rhr_delta: [
    "Resting heart rate settled the way the lighter days were meant to bring it down.",
    "The quieter days brought resting heart rate back down, as expected.",
  ],
  sleep_duration_delta: [
    "Sleep actually lengthened, the way the plan was hoping it would.",
    "Sleep stretched out longer, right on what the plan expected.",
  ],
  vo2max_trend: [
    "Aerobic fitness moved in the direction the training was aimed at.",
    "The engine is trending the way the training was built to move it.",
  ],
  exercise_est_1rm_trend: [
    "Strength kept climbing the way the program expected.",
    "The numbers moved the way the program was banking on.",
  ],
  weight_trend_lb_wk: [
    "The trend moved the way the plan was banking on.",
    "The scale trend landed where the plan expected it to.",
  ],
};

interface MaturedExpectationRow {
  metric_key: string;
  verdict: string;
}

function landedWin(date: string): string | null {
  const yesterday = addDaysISO(date, -1);
  if (!yesterday) return null;
  const rows = db
    .prepare(
      `SELECT expectation.metric_key AS metric_key, latest.verdict AS verdict
         FROM brain_expectations expectation
         JOIN brain_evaluations latest
           ON latest.id = (
             SELECT evaluation.id FROM brain_evaluations evaluation
              WHERE evaluation.expectation_id = expectation.id
              ORDER BY evaluation.evaluated_at DESC, evaluation.id DESC LIMIT 1
           )
        WHERE expectation.window_end = ?
          AND expectation.status = 'evaluated'
          AND expectation.metric_key <> 'day_read_adherence'
        ORDER BY expectation.id LIMIT 10`
    )
    .all(yesterday) as unknown as MaturedExpectationRow[];
  for (const row of rows) {
    if (row.verdict !== "aligned") continue;
    const variants = WIN_METRIC_VARIANTS[row.metric_key as BrainMetricKey];
    if (!variants) continue;
    return pickDayVariant(variants, date, `win_${row.metric_key}`);
  }
  return null;
}

// ---------- the builder ----------

export function morningReview(date: string): MorningReview {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return EMPTY_REVIEW;
  const passages: string[] = safe(() => dayComparisonPassages(date)) ?? [];
  const win = safe(() => landedWin(date));
  if (!passages.length && !win) return EMPTY_REVIEW;
  return { passages, win };
}
