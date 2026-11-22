// Body: the ONE body-fat estimate (body-fat-estimate.ts), said as its central value with
// its likely range and its basis, never as "the" number of any one source; and, only when a
// DEXA is on file, lean mass and bone in words read off that scan (standing.ts
// bodyCompositionRead). Weight is a goal row already, so it is not repeated here.
import type {
  WeekReadStandingDirection,
  WeekReadStandingLine,
  WeekReadStandingRow,
} from "../../../contracts/week-read.js";
import { addDaysISO } from "../../../lib/dates.js";
import { bodyFatEstimate, type BodyFatEstimateRead } from "../../../repo/body-fat-estimate.js";
import { dateWords, sinceWords } from "../../../repo/display-words.js";
import { effectiveGoalMode, getProfile } from "../../../repo/profile.js";
import { bodyCompositionRead } from "../../../repo/standing.js";
import { standingLine, standingRow } from "./words.js";

/** The bioimpedance direction window (body-fat-estimate.ts SCALE_WINDOW_DAYS). */
const SCALE_WINDOW_DAYS = 42;
// The body page's own bars (bodyCompositionRead's notes, repo/standing.ts): the lean-mass
// index and the T-score at or above which that page says "healthy". Below them this row
// says nothing: a quiet absence, never a second verdict.
const ALMI_HEALTHY = 7.5;
const T_SCORE_HEALTHY = -1;

function basisClause(est: BodyFatEstimateRead, today: string): string {
  const anchor = est.anchor;
  if (anchor && (est.primary === "dexa" || est.primary === "bod_pod" || est.primary === "hydrostatic")) {
    return `anchored to your ${anchor.label}${anchor.date ? ` from ${dateWords(anchor.date, today)}` : ""}`;
  }
  if (est.primary === "tape")
    return est.tape_offset != null ? "from your tape, matched to your scan" : "from your tape";
  if (est.primary === "anthropometric") return "estimated from height and weight";
  return "from your measurements";
}

/**
 * The scale's direction (direction only: bioimpedance never sets the level), read for this
 * athlete: lower body fat is better, except during a deliberate gain, where a little rise
 * is part of the plan and reads as holding.
 */
function scaleDirection(trend: BodyFatEstimateRead["scale_trend"], mode: string): WeekReadStandingDirection | null {
  if (trend === "falling") return "better";
  if (trend === "steady") return "holding";
  if (trend === "rising") return mode === "gain" ? "holding" : "worse";
  return null;
}

export function bodyRow(today: string): WeekReadStandingRow | null {
  const profile = getProfile() ?? {};
  const est = bodyFatEstimate(profile, today);
  if (!est || !Number.isFinite(est.value)) return null;
  let mode = "maintain";
  try {
    mode = effectiveGoalMode(profile);
  } catch {
    mode = "maintain";
  }
  const direction = scaleDirection(est.scale_trend, mode);
  const v = Math.round(est.value);
  const lo = Math.round(est.low);
  const hi = Math.round(est.high);
  const lines: WeekReadStandingLine[] = [
    standingLine("health", {
      id: "body:fat",
      label: "Body fat",
      // "N% fat": the grammar reads a bare percentage as a grade; the quantity is named.
      now_text: `about ${v}% fat`,
      direction,
      move_words: est.scale_trend
        ? `your scale reads ${est.scale_trend === "steady" ? "level" : est.scale_trend === "falling" ? "lower" : "higher"} over six weeks`
        : null,
      note: `likely ${lo} to ${hi}, ${basisClause(est, today)}`,
    }),
  ];

  // Lean mass and bone, only off a DEXA, in words: never the index or the T-score itself.
  let scanWords = "";
  if (est.anchor?.kind === "dexa") {
    const comp = (() => {
      try {
        return bodyCompositionRead([], null, today, profile);
      } catch {
        return null;
      }
    })();
    const regional = comp?.regional ?? null;
    const scanNote = `from your DEXA, ${dateWords(est.anchor.date, today)}`;
    const healthy: string[] = [];
    if (regional?.almi != null) {
      const ok = regional.almi >= ALMI_HEALTHY;
      if (ok) healthy.push("lean mass");
      if (ok) lines.push(
        standingLine("health", {
          id: "body:lean",
          label: "Lean mass",
          now_text: "Healthy on your scan",
          direction: null,
          move_words: null,
          note: scanNote,
        })
      );
    }
    if (regional?.t_score != null) {
      const ok = regional.t_score >= T_SCORE_HEALTHY;
      if (ok) healthy.push("bone");
      if (ok) lines.push(
        standingLine("health", {
          id: "body:bone",
          label: "Bone",
          now_text: "Healthy on your scan",
          direction: null,
          move_words: null,
          note: scanNote,
        })
      );
    }
    if (healthy.length === 2) scanWords = " Lean mass and bone read healthy on your DEXA.";
    else if (healthy.length === 1)
      scanWords = ` ${healthy[0] === "bone" ? "Bone reads" : "Lean mass reads"} healthy on your DEXA.`;
  }

  const windowStart = addDaysISO(today, -SCALE_WINDOW_DAYS);
  return standingRow("health", {
    key: "body",
    stone: "body",
    label: "Body",
    direction,
    // "N% of": the grammar's own shape for a real quantity.
    words: `Body fat is about ${v}% of your weight, likely ${lo} to ${hi}.${scanWords}`,
    since_words: direction && windowStart ? sinceWords(windowStart, today) || null : null,
    lines,
    invite: est.sharpen_hint ?? null,
    href: "/app/you/body",
  });
}
