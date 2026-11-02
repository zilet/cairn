// Lessons that change the next race build — bounded, server-checked, undoable.
//
// A finished race's review (goal-reviews.ts / coachOps goal review) may PROPOSE changes
// to how the next build is shaped, from a closed vocabulary only (BUILD_LEVER_KEYS). The
// agent proposes; this module decides:
//   - validateBuildLevers: every proposal is parsed, clamped to its key's hard bounds
//     (BUILD_LEVER_BOUNDS, which are the engine's own safe range — a lever can never
//     take the engine past what its constants already allow in the risky direction),
//     and checked against the race's facts (a raised ceiling needs evidence it was
//     taken well; anything unsupported is rejected with a reason, never silently kept).
//   - adoptBuildLevers: records ONE brain_decisions row (announce tier, reversible,
//     server-owned Undo) and writes the accepted levers, superseding older ones per key.
//   - activeBuildLevers: the one resolved set raceRamp() and weeklyRunPlan() both read.
//     With no lever for a key, that key resolves to the engine's constant — so an
//     athlete with no reviewed race runs exactly the engine they run today.
//
// CONTRACT (shared by the goal-review stream and the engine stream): the exported
// types and function signatures below are fixed; implementations live here.

import { db } from "../db.js";
import { decideAutonomyTier } from "../brain/autonomy.js";
import { UNDO_UNAVAILABLE, UndoRefusal } from "../domain/brain/undo-refusal.js";
import { finite as finiteOrNull, round1, round2 } from "../lib/numbers.js";
import { recordDecision, saveBrainRollback } from "./brain-decisions.js";
import { violatesReadingGrammar } from "./day-read-grammar.js";
import { copyDeep, requestMemo } from "./request-memo.js";
import {
  ENGINE_DOWN_WEEK_EVERY,
  ENGINE_TAPER_WEEKS,
  LONG_PEAK_CEILING_KM,
  peakLongKm,
  peakWeeklyClampMaxKm,
  peakWeeklyKm,
  type RampLevers,
  SUSTAINABLE_LONG_STEP_FACTOR,
  SUSTAINABLE_WEEKLY_BUILD_FACTOR,
} from "./run-ramp.js";
import { getSettings } from "./settings.js";
import { localDateISO } from "./shared.js";
import { withSqliteSavepoint } from "./sqlite-savepoint.js";

export const BUILD_LEVER_KEYS = [
  "build_step", // weekly volume build factor (engine: SUSTAINABLE_WEEKLY_BUILD_FACTOR 1.12)
  "long_step", // long-run step factor (engine: SUSTAINABLE_LONG_STEP_FACTOR 1.15)
  "long_run_ceiling_km", // the build's long-run peak cap (engine: min(0.85×distance, 20))
  "peak_week_cap_km", // the build's peak weekly km cap (engine: peakWeeklyKm formula)
  "taper_weeks", // weeks of taper before race week (engine: PEAK_WEEKS_OUT − 1 = 1)
  "down_week_every", // a down week every N weeks (engine: 4)
] as const;
export type BuildLeverKey = (typeof BUILD_LEVER_KEYS)[number];

/** What the agent proposes (agent output; untrusted). */
export interface BuildLeverProposal {
  key: BuildLeverKey;
  value: number;
  /** The athlete-facing reason, one sentence, from the review's lesson. */
  because: string;
}

/** The finished race's facts the validator checks proposals against. */
export interface BuildLeverFacts {
  race_date: string;
  race_distance_km: number;
  /** Best harm-free closed week of the build (the floor that held). */
  held_week_km: number | null;
  /** Biggest closed week of the build, harmed or not. */
  best_week_km: number | null;
  /** Weeks whose volume was set aside for harm (hard run not absorbed, etc.). */
  harmed_weeks: number;
  /**
   * Longest training run before the race (race excluded), and whether it was taken well —
   * POSITIVELY: no harm that day and a next morning that spoke clean (silence never vouches).
   * A long-run ceiling raise stands on this.
   */
  longest_run_km: number | null;
  longest_run_clean: boolean;
  /** Recovery: days from race day until back to full (null while still recovering). */
  recovery_days: number | null;
  /** The recovery window the engine expected (raceRecoveryWindow), in days. */
  expected_recovery_days: number;
}

export interface AcceptedBuildLever {
  key: BuildLeverKey;
  value: number;
  because: string;
  /** Set when the proposal was clamped into bounds. */
  clamped_from?: number;
}

export interface BuildLeverValidation {
  accepted: AcceptedBuildLever[];
  rejected: Array<{ key: string; reason: string }>;
}

/** The resolved engine inputs: every key has a value (lever, else the engine constant). */
export type ResolvedBuildLevers = Record<BuildLeverKey, number> & {
  /** Keys whose value came from an adopted lever (for "why" lines and prompts). */
  from_levers: Array<{ key: BuildLeverKey; value: number; because: string; source_review_id: number | null }>;
};

// ---------------------------------------------------------------------------
// BOUNDS — the engine's own safe range, per key.
//
// The four factor/count keys can only ever make the build MORE conservative than the
// engine's constants: a lower weekly or long-run step, a longer taper, more frequent
// resets. Their upper (risky-direction) bound IS the engine constant, so no lever can
// take the engine past what it already allows. The lower bounds stop a lesson from
// flattening a build into one that cannot climb at all (12 weeks at 1.05 still ~1.8×).
//
// The two km caps are the only keys allowed to RISE, and only with evidence from the
// race just run:
//   - long_run_ceiling_km: freely down to 0.6× the engine's long-run peak for that
//     distance (min(0.85 × distance, 20 km)); ABOVE it only when the longest training
//     run was taken well (`longest_run_clean`), and then to at most 1.1× that run and
//     never past the race distance itself.
//   - peak_week_cap_km: freely down to 0.7× the distance's own peak-week demand
//     (peakWeeklyKm); ABOVE it only when fewer than two weeks were set aside for harm and
//     a harm-free week held (`held_week_km`), to at most 1.1× that week and never past
//     the demand formula's own clamp maximum (40 km under 15 km races, 45 km from 15 km).
// A raise without its evidence is REJECTED with a plain reason, never clamped into a
// smaller raise; an out-of-range value with the evidence is clamped (`clamped_from`).
// ---------------------------------------------------------------------------

export const BUILD_LEVER_BOUNDS = {
  build_step: { min: 1.05, max: SUSTAINABLE_WEEKLY_BUILD_FACTOR, engine: SUSTAINABLE_WEEKLY_BUILD_FACTOR },
  long_step: { min: 1.08, max: SUSTAINABLE_LONG_STEP_FACTOR, engine: SUSTAINABLE_LONG_STEP_FACTOR },
  taper_weeks: { min: 1, max: 2, engine: ENGINE_TAPER_WEEKS, integer: true },
  down_week_every: { min: 3, max: 4, engine: ENGINE_DOWN_WEEK_EVERY, integer: true },
  long_run_ceiling_km: {
    /** Lowest share of the engine's long-run peak a lesson may set. */
    min_of_engine: 0.6,
    /** A raise reaches at most this multiple of the longest run taken well… */
    raise_of_longest_clean: 1.1,
    /** …and never past the race distance itself. */
    max_of_distance: 1,
  },
  peak_week_cap_km: {
    /** Lowest share of the distance's own peak-week demand a lesson may set. */
    min_of_engine: 0.7,
    /** A raise reaches at most this multiple of the harm-free week that held… */
    raise_of_held_week: 1.1,
    /** …and only when fewer harmed weeks than this were set aside. */
    raise_blocked_at_harmed_weeks: 2,
  },
} as const;

/**
 * Distance scoping (the two km caps only). A long-run or peak-week ceiling is a fact
 * about one race DISTANCE — 16 km is a cautious half long run and a reckless 10K one —
 * so a cap applies only to a next race of the SAME distance class it was learned on
 * (`raceDistanceClass`); any other distance builds to the engine's own caps. The
 * learned distance rides on the adopting decision (`context.race_distance_km`). The
 * factor and count keys (steps, taper, resets) are about how this body absorbs a build
 * and carry to a next race of any distance.
 */
export type RaceDistanceClass = "short" | "10k" | "half" | "marathon";
export function raceDistanceClass(distanceKm: unknown): RaceDistanceClass | null {
  const d = Number(distanceKm);
  if (!Number.isFinite(d) || d <= 0) return null;
  if (d < 8) return "short";
  if (d < 15) return "10k";
  if (d < 30) return "half";
  return "marathon";
}

const LEVER_KEY_SET: ReadonlySet<string> = new Set(BUILD_LEVER_KEYS);
const isLeverKey = (k: unknown): k is BuildLeverKey => typeof k === "string" && LEVER_KEY_SET.has(k);
const CAP_KEYS: ReadonlySet<BuildLeverKey> = new Set(["long_run_ceiling_km", "peak_week_cap_km"]);
const BECAUSE_MAX = 240;
const MAX_PROPOSALS = 20;

function cleanBecause(raw: unknown): string {
  const text = Array.from(typeof raw === "string" ? raw : "")
    .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= BECAUSE_MAX) return text;
  const cut = text.slice(0, BECAUSE_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > BECAUSE_MAX * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:\s]+$/, "")}…`;
}

type Bounded = { value: number; clamped_from?: number } | { reject: string };

function clampInto(value: number, min: number, max: number, integer = false): { value: number; clamped_from?: number } {
  const rounded = integer ? Math.round(value) : round2(value);
  const bounded = Math.min(max, Math.max(min, rounded));
  // A clamp is a move past the bound (or a count that was not a whole number); a
  // factor rounded to two places is just written tidily.
  const moved = integer ? bounded !== value : bounded !== rounded;
  return moved ? { value: bounded, clamped_from: value } : { value: bounded };
}

/**
 * How far past a bound a proposal may sit and still be CLAMPED. Further out it is not a
 * near miss but a different number (a missing value read as 0, a percentage, a mile
 * figure), and taking the bound in its place would adopt the tightest — or loosest —
 * setting nobody proposed. So it is rejected instead.
 */
export const BUILD_LEVER_CLAMP_MARGIN = 0.1;
const FAR_OUTSIDE = "That number is far outside what the build can take, so it was set aside rather than guessed at.";

function tooFarBelow(value: number, min: number): boolean {
  return value < min * (1 - BUILD_LEVER_CLAMP_MARGIN);
}
function tooFarAbove(value: number, max: number): boolean {
  return value > max * (1 + BUILD_LEVER_CLAMP_MARGIN);
}

function clampOrReject(value: number, min: number, max: number, integer = false): Bounded {
  if (tooFarBelow(value, min) || tooFarAbove(value, max)) return { reject: FAR_OUTSIDE };
  return clampInto(value, min, max, integer);
}

/** A proposal's number: a finite number, or a numeric string — never null, "", false or []. */
function proposedNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function boundLever(key: BuildLeverKey, value: number, facts: BuildLeverFacts): Bounded {
  switch (key) {
    case "build_step":
    case "long_step":
      return clampOrReject(value, BUILD_LEVER_BOUNDS[key].min, BUILD_LEVER_BOUNDS[key].max);
    case "taper_weeks":
    case "down_week_every":
      return clampOrReject(value, BUILD_LEVER_BOUNDS[key].min, BUILD_LEVER_BOUNDS[key].max, true);
    case "long_run_ceiling_km": {
      const d = Number(facts?.race_distance_km);
      if (!(Number.isFinite(d) && d >= 8))
        return { reject: "A race this short is built on quality, not on a long-run ladder." };
      const engine = peakLongKm(d);
      const floor = round1(engine * BUILD_LEVER_BOUNDS.long_run_ceiling_km.min_of_engine);
      const km = round1(value);
      if (tooFarBelow(km, floor)) return { reject: FAR_OUTSIDE };
      if (km <= engine) return km < floor ? { value: floor, clamped_from: value } : { value: km };
      const longest = finiteOrNull(facts?.longest_run_km);
      if (!facts?.longest_run_clean || longest == null || longest <= 0)
        return { reject: "A longer long run than the build's own needs a long run that was taken well to stand on." };
      const max = round1(
        Math.min(
          longest * BUILD_LEVER_BOUNDS.long_run_ceiling_km.raise_of_longest_clean,
          d * BUILD_LEVER_BOUNDS.long_run_ceiling_km.max_of_distance
        )
      );
      if (max <= engine)
        return {
          reject:
            "The longest run taken well doesn't reach past the build's own long run, so there is nothing to raise it on.",
        };
      if (tooFarAbove(km, max)) return { reject: FAR_OUTSIDE };
      return km > max ? { value: max, clamped_from: value } : { value: km };
    }
    case "peak_week_cap_km": {
      const d = Number(facts?.race_distance_km);
      const demand = Number.isFinite(d) ? peakWeeklyKm(d) : null;
      const clampMax = Number.isFinite(d) ? peakWeeklyClampMaxKm(d) : null;
      if (demand == null || clampMax == null)
        return { reject: "A race this short is built on quality, not on a weekly mileage peak." };
      const floor = round1(demand * BUILD_LEVER_BOUNDS.peak_week_cap_km.min_of_engine);
      const km = round1(value);
      if (tooFarBelow(km, floor)) return { reject: FAR_OUTSIDE };
      if (km <= demand) return km < floor ? { value: floor, clamped_from: value } : { value: km };
      const harmed = Math.max(0, Math.trunc(Number(facts?.harmed_weeks) || 0));
      if (harmed >= BUILD_LEVER_BOUNDS.peak_week_cap_km.raise_blocked_at_harmed_weeks)
        return {
          reject:
            "Two or more weeks of the last build were set aside because the body paid for them, so the peak doesn't go higher.",
        };
      const held = finiteOrNull(facts?.held_week_km);
      if (held == null || held <= 0)
        return { reject: "No week of the last build held without a cost, so there is nothing to raise the peak on." };
      const max = round1(Math.min(held * BUILD_LEVER_BOUNDS.peak_week_cap_km.raise_of_held_week, clampMax));
      if (max <= demand)
        return {
          reject: "The week that held doesn't reach past the build's own peak, so there is nothing to raise it on.",
        };
      if (tooFarAbove(km, max)) return { reject: FAR_OUTSIDE };
      return km > max ? { value: max, clamped_from: value } : { value: km };
    }
  }
}

export function validateBuildLevers(proposals: unknown, facts: BuildLeverFacts): BuildLeverValidation {
  const accepted: AcceptedBuildLever[] = [];
  const rejected: BuildLeverValidation["rejected"] = [];
  const list = Array.isArray(proposals)
    ? proposals
    : proposals && typeof proposals === "object" && Array.isArray((proposals as { levers?: unknown }).levers)
      ? (proposals as { levers: unknown[] }).levers
      : null;
  if (!list) {
    if (proposals != null) rejected.push({ key: "", reason: "The proposals were not a list, so none were taken." });
    return { accepted, rejected };
  }
  const seen = new Set<string>();
  for (const raw of list.slice(0, MAX_PROPOSALS)) {
    const rec = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    const keyText = typeof rec?.key === "string" ? rec.key.trim() : "";
    if (!rec || !isLeverKey(keyText)) {
      rejected.push({ key: keyText.slice(0, 40), reason: "Not one of the levers a build can take." });
      continue;
    }
    const key = keyText;
    // The first proposal for a key is the one considered, whatever becomes of it.
    if (seen.has(key)) {
      rejected.push({ key, reason: "Already proposed once; the first one stands." });
      continue;
    }
    seen.add(key);
    const because = cleanBecause(rec.because);
    if (!because) {
      rejected.push({ key, reason: "A lesson needs its reason in plain words." });
      continue;
    }
    const grammar = violatesReadingGrammar(because);
    if (grammar) {
      rejected.push({
        key,
        reason: `The reason doesn't read in the app's plain voice (${grammar}), so it can't be shown as written.`,
      });
      continue;
    }
    const value = proposedNumber(rec.value);
    if (value == null || value <= 0) {
      rejected.push({ key, reason: "A lever needs a real number." });
      continue;
    }
    const bounded = boundLever(key, value, facts);
    if ("reject" in bounded) {
      rejected.push({ key, reason: bounded.reject });
      continue;
    }
    accepted.push({
      key,
      value: bounded.value,
      because,
      ...(bounded.clamped_from != null ? { clamped_from: bounded.clamped_from } : {}),
    });
  }
  if (list.length > MAX_PROPOSALS) rejected.push({ key: "", reason: "Only the first proposals were read." });
  return { accepted, rejected };
}

// ---------------------------------------------------------------------------
// ADOPTION — one decision, one Undo.
// ---------------------------------------------------------------------------

/** The undo snapshot (brain_rollbacks kind 'build_levers'). */
interface BuildLeverRollback {
  version: 1;
  /** The rows this decision wrote. */
  lever_ids: number[];
  /** The rows it superseded, put back by Undo when their key is free again. */
  superseded_ids: number[];
}

/** The race distance the review was about (for the caps' distance scoping), or null. */
function reviewRaceDistanceKm(reviewId: number): { distance_km: number | null; title: string | null } {
  try {
    const row = db.prepare(`SELECT ref_key, title, facts_json FROM goal_reviews WHERE id = ?`).get(reviewId) as
      | { ref_key?: string; title?: string; facts_json?: string }
      | undefined;
    if (!row) return { distance_km: null, title: null };
    let facts: any = null;
    try {
      facts = JSON.parse(String(row.facts_json ?? "null"));
    } catch {
      facts = null;
    }
    const candidates = [
      facts?.race_distance_km,
      facts?.distance_km,
      facts?.lever_facts?.race_distance_km,
      facts?.build_lever_facts?.race_distance_km,
      facts?.race?.distance_km,
      String(row.ref_key ?? "").split("|")[1],
    ];
    const distance = candidates.map(finiteOrNull).find((n) => n != null && n > 0) ?? null;
    const title =
      String(row.title ?? "")
        .trim()
        .slice(0, 80) || null;
    return { distance_km: distance, title };
  } catch {
    return { distance_km: null, title: null };
  }
}

/** One lever in the athlete's words (no score, no percentage). */
export function buildLeverWords(
  key: BuildLeverKey,
  value: number,
  kmWords: (km: number) => string = (km) => `${round1(km)} km`
): string {
  switch (key) {
    case "taper_weeks":
      return Math.round(value) >= 2 ? "a two-week taper" : "a one-week taper";
    case "down_week_every":
      return Math.round(value) <= 3 ? "a lighter week every third week" : "a lighter week every fourth week";
    case "build_step":
      return value < SUSTAINABLE_WEEKLY_BUILD_FACTOR - 1e-9 ? "a gentler weekly climb" : "the usual weekly climb";
    case "long_step":
      return value < SUSTAINABLE_LONG_STEP_FACTOR - 1e-9 ? "smaller long-run steps" : "the usual long-run steps";
    case "long_run_ceiling_km":
      return `the long run topping out at ${kmWords(value)}`;
    case "peak_week_cap_km":
      return `the biggest week at ${kmWords(value)}`;
  }
}

function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function sameValue(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

/** Undo for a build-lever decision (called inside the autonomy service's revert savepoint). */
export function revertBuildLevers(payload: unknown, decisionId: number, at: string = new Date().toISOString()): void {
  const p = payload as BuildLeverRollback | null;
  if (!p || p.version !== 1 || !Array.isArray(p.lever_ids)) throw new UndoRefusal(UNDO_UNAVAILABLE);
  const ids = p.lever_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const live = ids.length
    ? (db
        .prepare(
          `SELECT id, key FROM build_levers WHERE status = 'active' AND decision_id = ? AND id IN (${ids.map(() => "?").join(",")})`
        )
        .all(decisionId, ...ids) as Array<{ id: number; key: string }>)
    : [];
  if (!live.length) throw new UndoRefusal("A later race's lessons have replaced these, so they stand.");
  // EVERY row of this decision goes — the superseded ones too. An Undo is the athlete's
  // no to the whole lesson, so a row a later review replaced must not come back when
  // that later review is undone in its turn (and as-of resolution never reads it).
  db.prepare(
    `UPDATE build_levers SET status = 'reverted', reverted_at = ? WHERE decision_id = ? AND status != 'reverted'`
  ).run(at, decisionId);
  // Put back what this decision superseded — only for a key this Undo freed (a key a
  // newer lesson holds stays the newer lesson's), and only a row whose own decision is
  // still in force (a lesson already undone stays undone).
  const freed = new Set(live.map((r) => r.key));
  const restore = db.prepare(`UPDATE build_levers SET status = 'active' WHERE id = ? AND status = 'superseded'`);
  for (const id of (Array.isArray(p.superseded_ids) ? p.superseded_ids : []).map(Number)) {
    if (!(Number.isInteger(id) && id > 0)) continue;
    const row = db
      .prepare(
        `SELECT l.key, d.status AS decision_status FROM build_levers l
           LEFT JOIN brain_decisions d ON d.id = l.decision_id WHERE l.id = ?`
      )
      .get(id) as { key?: string; decision_status?: string | null } | undefined;
    if (!row?.key || !freed.has(row.key) || row.decision_status !== "applied") continue;
    const taken = db.prepare(`SELECT 1 FROM build_levers WHERE key = ? AND status = 'active' LIMIT 1`).get(row.key);
    if (!taken) restore.run(id);
  }
}

export function adoptBuildLevers(
  sourceReviewId: number,
  accepted: AcceptedBuildLever[],
  date: string
): { decision_id: number | null; adopted: number } {
  const reviewId = Math.trunc(Number(sourceReviewId));
  if (!(reviewId > 0)) return { decision_id: null, adopted: 0 };
  const day = String(date || localDateISO()).slice(0, 10);
  // Idempotent per review: a review's lessons are adopted once. A decision the athlete
  // already put back stays put back.
  const prior = db
    .prepare(
      `SELECT id FROM brain_decisions WHERE source_ref_type = 'goal_review' AND source_ref_key = ? ORDER BY id ASC LIMIT 1`
    )
    .get(String(reviewId)) as { id?: number } | undefined;
  if (prior?.id) {
    const n = db
      .prepare(`SELECT COUNT(*) AS n FROM build_levers WHERE decision_id = ? AND status = 'active'`)
      .get(prior.id) as { n: number };
    return { decision_id: Number(prior.id), adopted: Number(n?.n ?? 0) };
  }
  const { distance_km, title } = reviewRaceDistanceKm(reviewId);
  // Defensive re-check: only known keys with a number and a plain reason, first per key,
  // the factor/count keys inside their hard bounds, and the caps only when the race
  // distance they were learned on is known (otherwise they could not be scoped).
  const seen = new Set<string>();
  const levers: AcceptedBuildLever[] = [];
  for (const lever of Array.isArray(accepted) ? accepted : []) {
    if (!lever || !isLeverKey(lever.key) || seen.has(lever.key)) continue;
    const value = proposedNumber(lever.value);
    const because = cleanBecause(lever.because);
    if (value == null || value <= 0 || !because || violatesReadingGrammar(because)) continue;
    if (CAP_KEYS.has(lever.key) && !(distance_km != null && distance_km >= 8)) continue;
    const b = BUILD_LEVER_BOUNDS[lever.key] as { min?: number; max?: number; integer?: boolean };
    const v = b.min != null && b.max != null ? clampInto(value, b.min, b.max, b.integer === true).value : round1(value);
    seen.add(lever.key);
    levers.push({
      key: lever.key,
      value: v,
      because,
      ...(lever.clamped_from != null ? { clamped_from: lever.clamped_from } : {}),
    });
  }
  if (!levers.length) return { decision_id: null, adopted: 0 };

  // Autonomy is server policy: a change to how the next build is shaped is structural
  // (`training_structure`), reversible, moderate — the policy's announce tier. Under
  // "review everything" the policy asks instead; there is no approve door for a lever
  // set (a `review` row with nothing behind it would sit in "Waiting on you" with no way
  // to say yes), so nothing is recorded and nothing adopted — a later call, once the
  // posture allows it, adopts as usual.
  let leadMode: "lead" | "announce_first" | "review_everything" = "lead";
  try {
    leadMode = getSettings().lead_mode ?? "lead";
  } catch {
    leadMode = "lead";
  }
  const policy = decideAutonomyTier({
    kind: "training_structure",
    risk_class: "moderate",
    reversible: true,
    requested_tier: "announce",
    lead_mode: leadMode,
  });
  if (policy.tier !== "announce" && policy.tier !== "quiet_apply") return { decision_id: null, adopted: 0 };
  const race = title ? `the ${title}` : "the last race";
  const words = levers.map((l) => buildLeverWords(l.key, l.value));
  const summary = `Shaped your next race build from ${race}`.slice(0, 140);
  // A longer taper also lengthens the race's lifting trim (race-strength.ts reads the
  // ladder's taper weeks), so the athlete hears that too.
  const liftingNote = levers.some((l) => l.key === "taper_weeks" && l.value >= 2)
    ? " The lighter lifting before the race stretches across both taper weeks as well."
    : "";
  const explanation = `Your next build takes ${joinWords(words)}, from what ${race} taught.${liftingNote}`;
  const rationale = levers.map((l) => l.because).join(" ");
  const nowIso = new Date().toISOString();

  return withSqliteSavepoint(`adopt_build_levers_${reviewId}`, () => {
    const { decision } = recordDecision({
      effective_date: day,
      kind: "training_structure",
      domain: "training",
      summary,
      rationale,
      source: "goal_review",
      source_ref_type: "goal_review",
      source_ref_key: String(reviewId),
      status: "applied",
      autonomy_tier: "announce",
      risk_class: "moderate",
      reversible: true,
      input_fingerprint: null,
      context: {
        build_levers: true,
        race_distance_km: distance_km,
        race_title: title,
        policy_reasons: policy.reasons,
      },
      action: {
        kind: "build_levers",
        title: summary,
        user_explanation: explanation,
        levers: levers.map((l) => ({
          key: l.key,
          value: l.value,
          because: l.because,
          ...(l.clamped_from != null ? { clamped_from: l.clamped_from } : {}),
        })),
      },
      specialist: null,
      applied_at: nowIso,
      reverted_at: null,
      superseded_by: null,
      evaluator_version: null,
    });
    const decisionId = Number(decision.id);
    if (!(decisionId > 0)) return { decision_id: null, adopted: 0 };

    const leverIds: number[] = [];
    const supersededIds: number[] = [];
    const findActive = db.prepare(`SELECT id FROM build_levers WHERE key = ? AND status = 'active'`);
    const supersede = db.prepare(`UPDATE build_levers SET status = 'superseded' WHERE id = ?`);
    const insert = db.prepare(
      `INSERT INTO build_levers (key, value, because, source_review_id, decision_id, status, adopted_on)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`
    );
    const reviewExists = !!db.prepare(`SELECT 1 FROM goal_reviews WHERE id = ?`).get(reviewId);
    for (const lever of levers) {
      for (const row of findActive.all(lever.key) as Array<{ id: number }>) {
        supersede.run(row.id);
        supersededIds.push(Number(row.id));
      }
      const info = insert.run(lever.key, lever.value, lever.because, reviewExists ? reviewId : null, decisionId, day);
      leverIds.push(Number(info.lastInsertRowid));
    }
    const rollback: BuildLeverRollback = { version: 1, lever_ids: leverIds, superseded_ids: supersededIds };
    saveBrainRollback(decisionId, "build_levers", rollback);
    return { decision_id: decisionId, adopted: leverIds.length };
  });
}

// ---------------------------------------------------------------------------
// RESOLUTION — the one set the ramp, the week and the ladder read.
// ---------------------------------------------------------------------------

/**
 * Each key's value with no lever. The factor/count keys are the engine's constants; the
 * two km caps, with no race distance to read, are the engine's absolute ceilings (the
 * 20 km long run, the 45 km demand clamp) — `buildLeversForRace` puts the distance's
 * own figures in their place.
 */
export const ENGINE_BUILD_LEVERS: Readonly<Record<BuildLeverKey, number>> = {
  build_step: SUSTAINABLE_WEEKLY_BUILD_FACTOR,
  long_step: SUSTAINABLE_LONG_STEP_FACTOR,
  long_run_ceiling_km: LONG_PEAK_CEILING_KM,
  peak_week_cap_km: 45,
  taper_weeks: ENGINE_TAPER_WEEKS,
  down_week_every: ENGINE_DOWN_WEEK_EVERY,
};

interface ActiveLeverRow {
  key: BuildLeverKey;
  value: number;
  because: string;
  source_review_id: number | null;
  learned_distance_km: number | null;
}

/**
 * The lever in force for each key ON `day`: the latest row adopted on or before it that
 * was not undone. Supersession is a matter of time — a newer review's row wins from the
 * day it was adopted — so a past week resolves exactly as it did then, whatever was
 * adopted since. Only an Undo (`reverted`) takes a row out of every date.
 */
function readActiveRows(day: string): ActiveLeverRow[] {
  try {
    const rows = db
      .prepare(
        `SELECT l.id, l.key, l.value, l.because, l.source_review_id,
                json_extract(d.context_json, '$.race_distance_km') AS learned_distance_km
           FROM build_levers l
           LEFT JOIN brain_decisions d ON d.id = l.decision_id
          WHERE l.status != 'reverted' AND l.adopted_on <= ?
          ORDER BY l.adopted_on DESC, l.id DESC`
      )
      .all(day) as Array<Record<string, unknown>>;
    const out: ActiveLeverRow[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const key = String(r.key);
      const value = finiteOrNull(r.value);
      if (!isLeverKey(key) || seen.has(key) || value == null || value <= 0) continue;
      seen.add(key);
      out.push({
        key,
        value,
        because: String(r.because ?? ""),
        source_review_id: finiteOrNull(r.source_review_id),
        learned_distance_km: finiteOrNull(r.learned_distance_km),
      });
    }
    return out.sort((a, b) => BUILD_LEVER_KEYS.indexOf(a.key) - BUILD_LEVER_KEYS.indexOf(b.key));
  } catch {
    return [];
  }
}

/** A stored value held to its key's hard rails (a hand-edited or stale row never escapes them). */
function railed(key: BuildLeverKey, value: number, distanceKm?: number | null): number {
  const b = BUILD_LEVER_BOUNDS[key] as { min?: number; max?: number; integer?: boolean };
  if (b.min != null && b.max != null) return clampInto(value, b.min, b.max, b.integer === true).value;
  const d = Number(distanceKm);
  if (key === "long_run_ceiling_km") {
    if (!(Number.isFinite(d) && d >= 8)) return round1(Math.min(value, LONG_PEAK_CEILING_KM));
    const engine = peakLongKm(d);
    return round1(Math.min(d, Math.max(engine * BUILD_LEVER_BOUNDS.long_run_ceiling_km.min_of_engine, value)));
  }
  const demand = Number.isFinite(d) ? peakWeeklyKm(d) : null;
  const clampMax = Number.isFinite(d) ? peakWeeklyClampMaxKm(d) : null;
  if (demand == null || clampMax == null) return round1(Math.min(value, ENGINE_BUILD_LEVERS.peak_week_cap_km));
  return round1(Math.min(clampMax, Math.max(demand * BUILD_LEVER_BOUNDS.peak_week_cap_km.min_of_engine, value)));
}

/** The engine's own figure for a km cap at a race distance (long-run peak / peak-week demand). */
function engineCapKm(key: BuildLeverKey, distanceKm: number): number | null {
  if (!(Number.isFinite(distanceKm) && distanceKm >= 8)) return null;
  return key === "long_run_ceiling_km" ? peakLongKm(distanceKm) : peakWeeklyKm(distanceKm);
}

/**
 * A km cap learned on a race of `learnedKm`, carried to a race of `nextKm` in the same
 * class. The DIRECTION is kept: the cap is read as a share of the learned race's own
 * engine figure, so a lowering stays a lowering (that share of the next race's figure,
 * never below the floor share) and a raise stays a raise of at most what was validated
 * (never past the stored km, the next race's distance or the demand's clamp max). Null
 * when it no longer moves anything for the next race — a raise that would not clear the
 * next race's own figure does not apply at all.
 */
export function capForRace(key: BuildLeverKey, storedKm: number, learnedKm: number, nextKm: number): number | null {
  const learnedEngine = engineCapKm(key, learnedKm);
  const nextEngine = engineCapKm(key, nextKm);
  if (learnedEngine == null || nextEngine == null || !(storedKm > 0)) return null;
  const share = storedKm / learnedEngine;
  if (share < 1 - 1e-9) {
    const floorShare =
      key === "long_run_ceiling_km"
        ? BUILD_LEVER_BOUNDS.long_run_ceiling_km.min_of_engine
        : BUILD_LEVER_BOUNDS.peak_week_cap_km.min_of_engine;
    const km = round1(Math.max(share, floorShare) * nextEngine);
    return km < nextEngine ? km : null;
  }
  if (share > 1 + 1e-9) {
    const rail = key === "long_run_ceiling_km" ? nextKm : (peakWeeklyClampMaxKm(nextKm) ?? nextEngine);
    const km = round1(Math.min(share * nextEngine, storedKm, rail));
    return km > nextEngine ? km : null;
  }
  return null;
}

function resolve(
  rows: ActiveLeverRow[],
  base: Record<BuildLeverKey, number>,
  distanceKm?: number | null
): ResolvedBuildLevers {
  const out = { ...base, from_levers: [] } as ResolvedBuildLevers;
  for (const row of rows) {
    let value: number;
    if (CAP_KEYS.has(row.key) && distanceKm != null) {
      const carried =
        row.learned_distance_km != null ? capForRace(row.key, row.value, row.learned_distance_km, distanceKm) : null;
      if (carried == null) continue;
      value = carried;
    } else {
      value = railed(row.key, row.value, CAP_KEYS.has(row.key) ? row.learned_distance_km : null);
    }
    out[row.key] = value;
    out.from_levers.push({ key: row.key, value, because: row.because, source_review_id: row.source_review_id });
  }
  return out;
}

export function activeBuildLevers(asOf?: string): ResolvedBuildLevers {
  const day = String(asOf || localDateISO()).slice(0, 10);
  return requestMemo(`build_levers:${day}`, () => resolve(readActiveRows(day), { ...ENGINE_BUILD_LEVERS }), copyDeep);
}

/**
 * The levers for a build toward a race of `distanceKm`, as of `asOf`: every key
 * resolved, the two caps the distance's own figures unless a cap was learned on a race
 * of the same distance class (see `raceDistanceClass`) — the one set raceRamp,
 * weeklyRunPlan and the race ladder are handed.
 */
export function buildLeversForRace(distanceKm: number, asOf?: string): ResolvedBuildLevers {
  const day = String(asOf || localDateISO()).slice(0, 10);
  const d = Number(distanceKm);
  return requestMemo(
    `build_levers:${day}:${Number.isFinite(d) ? d : "none"}`,
    () => {
      const cls = raceDistanceClass(d);
      const base: Record<BuildLeverKey, number> = {
        ...ENGINE_BUILD_LEVERS,
        long_run_ceiling_km: Number.isFinite(d) && d > 0 ? peakLongKm(d) : ENGINE_BUILD_LEVERS.long_run_ceiling_km,
        peak_week_cap_km: (Number.isFinite(d) ? peakWeeklyKm(d) : null) ?? ENGINE_BUILD_LEVERS.peak_week_cap_km,
      };
      const rows = readActiveRows(day).filter(
        (row) =>
          !CAP_KEYS.has(row.key) ||
          (cls != null && cls !== "short" && raceDistanceClass(row.learned_distance_km) === cls)
      );
      return resolve(rows, base, d);
    },
    copyDeep
  );
}

/**
 * The levers as the pure ramp reads them: only the keys a lever set, so a build with no
 * lesson hands the ramp nothing and runs exactly the engine's constants. Never throws —
 * an unreadable table is the engine as it was.
 */
export function rampLeversForRace(distanceKm: unknown, asOf?: string): RampLevers | null {
  try {
    const d = Number(distanceKm);
    if (!(Number.isFinite(d) && d > 0)) return null;
    const resolved = buildLeversForRace(d, asOf);
    if (!resolved.from_levers.length) return null;
    const out: RampLevers = {};
    for (const lever of resolved.from_levers) out[lever.key] = lever.value;
    return out;
  } catch {
    return null;
  }
}

/** Whether a resolved lever actually moves the engine for a race of `distanceKm`. */
export function leverMovesBuild(key: BuildLeverKey, value: number, distanceKm: number): boolean {
  switch (key) {
    case "long_run_ceiling_km":
      return !sameValue(round1(value), peakLongKm(distanceKm));
    case "peak_week_cap_km": {
      const demand = peakWeeklyKm(distanceKm);
      return demand != null && !sameValue(round1(value), demand);
    }
    default:
      return !sameValue(value, ENGINE_BUILD_LEVERS[key]);
  }
}

/** The title of the race a review was about ("Cambridge Half Marathon"), or null. */
export function buildLeverSourceTitle(reviewId: number | null | undefined): string | null {
  if (!(Number(reviewId) > 0)) return null;
  return reviewRaceDistanceKm(Number(reviewId)).title;
}
