// The plan day's PURPOSE line — what THIS lifting day is for, in one calm fragment.
//
// GET /plan (getPlanWithPurpose, day-read.ts) used to attach the week-ahead meso note to
// every plan day, keyed on the read date alone, so every card in the gallery said the
// same "building volume for the block ahead". A purpose is a property of the DAY: what
// leads it and what follows (the plan's own items, the first primary-tier compound as
// the lead — the weekly dose ledger's read), its role in the week (the heavy leg day, the
// accessory day), and the block phase as the week actually runs it (block-phase.ts).
//
// Grounded only: a day with no lifting items has no purpose (null). Rotation is per DAY
// and per WEEK (`pickDayVariant` seeded on the week's Monday and keyed by the plan day's
// id), so one card keeps its wording all week and two cards never share a template by
// accident of the date. Words only — no score, no gate.
import { isPrepPlanItem, PLAN_ITEM_EFFECT_TIER, planItemEffectTier } from "../domain/training/plan-item-order.js";
import { mondayOf } from "../lib/dates.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { canonicalGroup, classifyMuscleGroup, plainGroupWords } from "./exercise-canon.js";

/** The week's phase a purpose can speak to: the block's resolved phase, else the mesocycle's. */
export type PlanPurposePhase = "accumulation" | "intensification" | "deload" | "deload-due" | "realization";

const HEAVY_LOWER = new Set(["quads", "hamstrings", "glutes"]);

const LEAD_CLAUSE: readonly ((lead: string, follow: string | null) => string)[] = [
  (lead, follow) => `${lead} leads${follow ? `, ${follow} follow` : ""}`,
  (lead, follow) => `built around ${lead}${follow ? `, with ${follow} after it` : ""}`,
  (lead, follow) => `${lead} first while you're fresh${follow ? `, then ${follow}` : ""}`,
];
const ACCESSORY_CLAUSE: readonly ((first: string, groups: string | null) => string)[] = [
  (first, groups) => `accessory work${groups ? ` for the ${groups}` : ""}, opening with ${first}`,
  (first, groups) => `supporting work${groups ? ` that rounds out the ${groups}` : ""}, starting with ${first}`,
];
const ROLE_HEAVY_LOWER: readonly string[] = [
  "the week's heavy leg day",
  "the big lower-body day of the week",
  "the day the legs carry the load",
];
const PHASE_CLAUSE: Record<PlanPurposePhase, readonly string[]> = {
  accumulation: [
    "building volume this block",
    "banking good sets while the block builds",
    "steady volume as the block lays its base",
  ],
  intensification: [
    "heavier and crisper as the block sharpens",
    "fewer reps, more intent while the block intensifies",
    "the block is sharpening, so every rep counts",
  ],
  realization: ["the block's top end — a few heavy, clean sets", "showing what the block built"],
  deload: ["lighter by design while the block resets", "an easy pass so the next build starts fresh"],
  "deload-due": ["keep it smooth — a lighter week is close", "steady work while the block nears its reset"],
};

type PurposeItem = { exercise?: unknown; muscle_group?: unknown; mode?: unknown; note?: unknown; kind?: unknown };

function groupOf(item: PurposeItem): string | null {
  const name = String(item.exercise ?? "").trim();
  return (
    canonicalGroup(item.muscle_group == null ? null : String(item.muscle_group)) ??
    (name ? classifyMuscleGroup(name) : null)
  );
}

/**
 * The purpose fragment for one plan day, or null when the day holds no lifting.
 * `dayKey` identifies the day (its id, else its number); `phase` is the week's phase.
 */
export function planDayPurposeLine(
  day: { id?: unknown; day_number?: unknown; items?: unknown },
  date: string,
  phase: PlanPurposePhase | null
): string | null {
  const items = (Array.isArray(day.items) ? (day.items as PurposeItem[]) : []).filter(
    (item) => item && item.kind !== "cardio" && String(item.exercise ?? "").trim()
  );
  const work = items.filter((item) => String(item.mode ?? "") !== "mobility" && !isPrepPlanItem(item as any));
  if (!work.length) return null;
  const dayKey = String(day.id ?? day.day_number ?? "");
  const week = mondayOf(String(date).slice(0, 10));
  const pick = <T>(variants: readonly T[], key: string): T =>
    pickDayVariant(variants, week, `plan-purpose:${dayKey}:${key}`);

  const leadIndex = work.findIndex((item) => planItemEffectTier(item as any) === PLAN_ITEM_EFFECT_TIER.primary);
  const lead = work[leadIndex >= 0 ? leadIndex : 0];
  const leadName = String(lead.exercise).trim();
  const leadGroup = groupOf(lead);
  const groups = work.map(groupOf).filter((g): g is string => !!g && g !== "mobility");
  const followGroups = groups.filter((g) => g !== leadGroup);
  const follow = plainGroupWords(followGroups, 2);
  const heavyLower = groups.some((g) => HEAVY_LOWER.has(g));

  const parts: string[] = [];
  if (leadIndex < 0) {
    parts.push(pick(ACCESSORY_CLAUSE, "accessory")(leadName, plainGroupWords(groups, 2)));
  } else {
    parts.push(pick(LEAD_CLAUSE, "lead")(leadName, follow));
  }
  const tail: string[] = [];
  if (leadIndex >= 0 && heavyLower && leadGroup && HEAVY_LOWER.has(leadGroup))
    tail.push(pick(ROLE_HEAVY_LOWER, "role"));
  if (phase && PHASE_CLAUSE[phase]) tail.push(pick(PHASE_CLAUSE[phase], `phase:${phase}`));
  return tail.length ? `${parts[0]} — ${tail.join(", ")}` : parts[0];
}
