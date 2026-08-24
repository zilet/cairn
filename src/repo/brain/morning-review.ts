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
import { pickDayVariant } from "./day-read-rules.js";
import { dayTrainingTruth, morningReadForDate, readAdherenceOutcome, trainedWithoutHarm } from "./read-adherence.js";

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

function dayComparisonPassage(date: string): string | null {
  const yesterday = addDaysISO(date, -1);
  if (!yesterday) return null;
  const morning = morningReadForDate(yesterday);
  if (!morning || (morning.kind !== "rest" && morning.kind !== "easy")) return null;
  const truth = dayTrainingTruth(yesterday);
  const outcome = readAdherenceOutcome(morning.kind, truth);
  if (outcome === "unclear") return null;
  const followed = outcome === "followed";
  const variantKey = `${morning.kind}_${outcome}`;
  if (morning.kind === "rest") {
    if (followed) return pickDayVariant(KEPT_REST_VARIANTS, date, variantKey);
    const harmless = trainedWithoutHarm(yesterday);
    return pickDayVariant(harmless ? DIVERGED_REST_HARMLESS_VARIANTS : DIVERGED_REST_PLAIN_VARIANTS, date, variantKey);
  }
  if (followed) return pickDayVariant(KEPT_EASY_VARIANTS, date, variantKey);
  const harmless = trainedWithoutHarm(yesterday);
  return pickDayVariant(harmless ? DIVERGED_EASY_HARMLESS_VARIANTS : DIVERGED_EASY_PLAIN_VARIANTS, date, variantKey);
}

// ---------- (c): did anything the brain was already watching just land? ----------
//
// A brain_expectation that matured overnight and evaluated `aligned` is a
// speakable win — a promise the brain made out loud (in `brain_decisions`) that
// the ledger has since confirmed, never a fresh claim invented here. Deliberately
// a small allowlist of metric keys: only ones with an unambiguous, plain-language
// "this got better" reading. `day_read_adherence` is excluded — that is the SAME
// evidence dayComparisonPassage above already speaks in its own voice, and
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
  const passages: string[] = [];
  const dayPassage = safe(() => dayComparisonPassage(date));
  if (dayPassage) passages.push(dayPassage);
  const win = safe(() => landedWin(date));
  if (!passages.length && !win) return EMPTY_REVIEW;
  return { passages, win };
}
