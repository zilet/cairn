// THE SPLIT THEY NAMED — "upper/lower", "push/pull/legs", "full body" — held as a fact.
//
// A first-run walk said "upper/lower, lifting Mon/Tue/Thu/Fri" and, once a race was
// stated too, the first-week composer wrote three upper days and one "Lower — Strength".
// The words were in the prompt and nothing held the week to them. This module is that
// hold, on the person's own words only:
//
//   - `splitParts` reads the stated split into its parts, and ONLY when every part is a
//     word a split is actually named by (upper, lower, push, pull, legs, full body; "PPL"
//     is push/pull/legs). Anything else ("a bro split", "whatever works") is still the
//     person's words — the prompt carries it verbatim — but there is nothing here to
//     check it against, so no check runs. Never a guess at what they meant.
//   - `statedSplitIssues` checks a week against those parts: every lifting day is one
//     part of the split (named for it), and the parts share the week evenly — an
//     upper/lower split over four days is two and two, because that is what the words
//     mean, not a preference of ours.
//
// The check is a WARNING on the plan-quality report (src/repo/plan-quality.ts), never a
// refusal: the athlete can still ask for a week that bends their own split, and the
// prompt contract (renderStrengthSchedule) is what binds the composer.
import { getStrengthSchedule } from "./profile.js";

export type SplitPart = "upper" | "lower" | "push" | "pull" | "legs" | "full";

const PART_PATTERN: Record<SplitPart, RegExp> = {
  upper: /\bupper\b/i,
  lower: /\blower\b/i,
  push: /\bpush\b/i,
  pull: /\bpull\b/i,
  legs: /\blegs?\b/i,
  full: /\b(?:full|total)[\s-]*body\b|\bfull\b/i,
};

const PART_WORD: Record<string, SplitPart> = {
  upper: "upper",
  lower: "lower",
  push: "push",
  pull: "pull",
  leg: "legs",
  legs: "legs",
  full: "full",
  total: "full",
};

// Words that ride along with a part without changing it ("upper body", "lower days",
// "a full-body split").
const FILLER = /\b(?:a|an|the|body|day|days|split|session|sessions|workouts?)\b/gi;

/** The stated split's parts, in the order said — or null when any part is not a split word. */
export function splitParts(words: unknown): SplitPart[] | null {
  const text = typeof words === "string" ? words.toLowerCase() : "";
  if (!text.trim()) return null;
  if (/^\s*ppl\s*(?:split)?\s*$/.test(text)) return ["push", "pull", "legs"];
  const pieces = text
    .replace(/\b(?:full|total)[\s-]+body\b/g, "full")
    .split(/\s*(?:\/|,|\+|&|\band\b|\bthen\b|\s-\s|-)\s*/)
    .map((piece) => piece.replace(FILLER, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!pieces.length) return null;
  const parts: SplitPart[] = [];
  for (const piece of pieces) {
    const part = PART_WORD[piece];
    if (!part) return null;
    if (!parts.includes(part)) parts.push(part);
  }
  return parts;
}

/** The split the athlete named, from their stated lifting schedule; null when none. */
export function statedLiftSplit(): string | null {
  try {
    return getStrengthSchedule()?.split ?? null;
  } catch {
    return null;
  }
}

export interface StatedSplitIssue {
  code: "stated_split";
  message: string;
  day_number?: number;
}

/**
 * Where a week departs from the stated split: a lifting day that is none of its parts,
 * or a part the week gives more or fewer days than an even rotation over the week's
 * lifting days. [] when the split is unstated or not checkable (see splitParts).
 */
export function statedSplitIssues(
  days: ReadonlyArray<{ day_number?: unknown; name?: unknown; focus?: unknown }>,
  split: string | null | undefined
): StatedSplitIssue[] {
  const parts = splitParts(split);
  if (!parts) return [];
  const issues: StatedSplitIssue[] = [];
  const counts = new Map<SplitPart, number>(parts.map((part) => [part, 0]));
  for (const [index, day] of days.entries()) {
    const label = `${String(day?.name ?? "")} ${String(day?.focus ?? "")}`;
    const part = parts.find((candidate) => PART_PATTERN[candidate].test(label));
    const dayNumber = Number.isInteger(Number(day?.day_number)) ? Number(day.day_number) : index + 1;
    if (!part) {
      issues.push({
        code: "stated_split",
        message: `Day ${dayNumber} ("${String(day?.name ?? "").trim() || "unnamed"}") is not one of the ${parts.join("/")} days of the split the athlete stated (${split}).`,
        day_number: dayNumber,
      });
      continue;
    }
    counts.set(part, (counts.get(part) ?? 0) + 1);
  }
  const n = days.length;
  if (n === 0) return issues;
  const low = Math.floor(n / parts.length);
  const high = Math.ceil(n / parts.length);
  for (const part of parts) {
    const count = counts.get(part) ?? 0;
    if (count < low || count > high) {
      const want = low === high ? `${low}` : `${low}-${high}`;
      issues.push({
        code: "stated_split",
        message: `The stated ${split} split shares ${n} lifting days evenly (${want} ${part}); this week has ${count} ${part}.`,
      });
    }
  }
  return issues;
}
