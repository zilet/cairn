// Cairn exercise name → Garmin FIT exercise (category + optional sub-name).
//
// Garmin's strength model is a two-level enum from the FIT profile: a CATEGORY
// (BENCH_PRESS, SQUAT, ROW, …) and an optional sub-EXERCISE under it
// (BARBELL_BENCH_PRESS, GOBLET_SQUAT, …). A PUT onto /exerciseSets is only
// accepted for enum members Garmin actually knows, so write-back needs a real
// catalog rather than a guess — an invented sub-name 400s the whole payload,
// while a bare category is always legal. `garmin-exercise-catalog.json` is that
// catalog (1527 rows across 47 categories, scraped once, checked in).
//
// This module is PURE: no Garmin HTTP, no DB writes. It answers two questions —
// "which FIT enum is this lift" (mapExerciseToGarmin) and "are these two names
// the same lift" (sameExerciseIdentity) — and offers the agent a shortlist it
// must choose from (garminCandidatesForPrompt) so a model can never invent an
// enum. Everything degrades: an unmatched name comes back `confidence: "none"`
// and simply does not get written.
//
// Constitution: this is a data mapping, not a judgement. No score is surfaced —
// `confidence` is a provenance word ("exact"/"key"/"fuzzy"/"category"/"none")
// and the numeric candidate scores exist only to rank an internal shortlist.
import catalog from "../garmin-exercise-catalog.json" with { type: "json" };
import { VARIATION_TOKENS, foldPluralToken, normalizeExerciseName } from "./exercise-canon.js";
import { LB_PER_KG } from "./shared.js";

export interface GarminCatalogRow {
  display: string;
  category: string;
  exercise: string | null;
}

export type GarminMapConfidence = "exact" | "key" | "fuzzy" | "category" | "none";

export interface GarminExerciseRef {
  category: string;
  exercise: string | null;
}

export interface GarminMapCandidate {
  display: string;
  category: string;
  exercise: string | null;
  score: number;
}

export interface GarminMapHit extends GarminExerciseRef {
  display: string;
  confidence: GarminMapConfidence;
  candidates?: GarminMapCandidate[];
}

const CATALOG: GarminCatalogRow[] = (Array.isArray(catalog) ? catalog : []).map((row: any) => ({
  display: String(row?.display ?? ""),
  category: String(row?.category ?? ""),
  exercise: row?.exercise == null ? null : String(row.exercise),
})).filter((row) => row.display && row.category);

// ---- tokenization ----------------------------------------------------------
// One vocabulary for both questions this module answers. The gym writes the same
// movement half a dozen ways ("db"/"dumbbell"/"dumbbells", "OHP", "RDL",
// "pulldown"/"pull down"), and the catalog spells all of them out — so every
// abbreviation expands to the catalog's own words before anything is compared.
// An alias may expand to SEVERAL tokens ("rdl" → romanian + deadlift), which is
// what lets a shorthand match a full catalog display name.
const TOKEN_ALIASES: Record<string, string[]> = {
  db: ["dumbbell"],
  dumbbells: ["dumbbell"],
  dbs: ["dumbbell"],
  bb: ["barbell"],
  barbells: ["barbell"],
  kb: ["kettlebell"],
  kettlebells: ["kettlebell"],
  ohp: ["overhead", "press"],
  rdl: ["romanian", "deadlift"],
  rdls: ["romanian", "deadlift"],
  pulldown: ["pull", "down"],
  pulldowns: ["pull", "down"],
  pushup: ["push", "up"],
  pushups: ["push", "up"],
  pullup: ["pull", "up"],
  pullups: ["pull", "up"],
  chinup: ["chin", "up"],
  chinups: ["chin", "up"],
  situp: ["sit", "up"],
  situps: ["sit", "up"],
  stepup: ["step", "up"],
  stepups: ["step", "up"],
  cgbp: ["close", "grip", "bench", "press"],
  bw: ["bodyweight"],
  ez: ["ez", "bar"],
  flye: ["fly"],
  flyes: ["fly"],
  bicep: ["biceps"],
  tricep: ["triceps"],
};

// Implement tokens, post-expansion. Two names may only be the SAME lift when they
// agree here: "db" ≡ "dumbbell", but neither is "barbell".
const IMPLEMENT_TOKENS = new Set([
  "barbell",
  "dumbbell",
  "kettlebell",
  "machine",
  "smith",
  "cable",
  "band",
  "banded",
  "landmine",
  "sled",
  "bodyweight",
  "sandbag",
  "suspension",
  "plate",
]);

// Words that carry no movement information; dropping them lets "Bench Press
// (Barbell)" and "Barbell Bench Press" key identically.
const NOISE_TOKENS = new Set(["the", "a", "and", "with", "of", "on", "in", "for", "timed"]);

// The MOVEMENT head — the word that says what the body actually did. Everything
// else on a name (implement, angle, grip, side) is a qualifier, so two names that
// each name a movement and name DIFFERENT ones are never the same lift however
// many qualifiers they share: "Single-Arm DB Row" and "Single-arm Dumbbell Swing"
// overlap on three of four tokens and are unrelated exercises. Without this guard
// the fuzzy pass confidently mapped that row onto a kettlebell-style swing.
const MOVEMENT_TOKENS = new Set([
  "press", "squat", "row", "curl", "deadlift", "raise", "fly", "extension", "lunge",
  "thrust", "swing", "snatch", "clean", "jerk", "plank", "crunch", "dip", "shrug",
  "hang", "hanging", "carry", "bridge", "twist", "chop", "kickback", "pull", "push",
  "hold", "walk", "jump", "step", "throw", "slam", "drag", "rollout", "climb", "run",
  "pullover", "flutter", "jack", "burpee", "thruster", "sit", "bench",
]);

// Qualifiers that change WHAT THE LIFT IS but aren't in exercise-canon's
// VARIATION_TOKENS (which is shared with the identity rules and the wider canon, so it
// is not the place to bolt scoring nuance onto). Used only for ranking: without
// "overhead" here, plain "Bulgarian Split Squat" matched "Overhead Bulgarian Split
// Squat" ahead of the barbell and dumbbell rows — an unqualified name winning a
// qualified row purely by being shorter.
const SCORING_QUALIFIER_TOKENS = new Set<string>([
  ...VARIATION_TOKENS,
  "overhead",
  "assisted",
  "weighted",
  "alternating",
  "eccentric",
  "isometric",
  "explosive",
  "jumping",
  "plyo",
  "behind",
  "front",
  "rear",
  "bulgarian",
]);

// The BODY REGION a name claims, folded to one word per region so a synonym can
// never read as a contradiction ("pec" ≡ "chest", "delt" ≡ "shoulder"). Two names
// that each name a region and name DIFFERENT ones are never the same lift however
// many other tokens agree: "Seated Machine Chest Press" and "Seated Barbell
// Shoulder Press" share {seated, press} and are different movements. Without this
// the implement-blind category vote handed every machine chest press to
// SHOULDER_PRESS, because the catalog's chest-press rows are all heavily qualified
// ("Alternating Dumbbell Chest Press") and score lower on overlap alone.
//
// Deliberately EXCLUDES the limb/position words the catalog uses as qualifiers
// rather than region claims — "leg", "arm", "hip", "knee", "ankle", "wrist"
// ("Single-Arm Dumbbell Row", "Back Squat" is a bar position, and FIT files "Leg
// Extensions" under CRUNCH and "Leg Press" under SQUAT). A word that is not in this
// table simply carries no region information, which is the safe default: the guard
// only ever fires when BOTH names name a region.
const REGION_TOKENS: Record<string, string> = {
  chest: "chest",
  pec: "chest",
  pectoral: "chest",
  shoulder: "shoulder",
  delt: "shoulder",
  deltoid: "shoulder",
  back: "back",
  lat: "back",
  trap: "back",
  triceps: "triceps",
  biceps: "biceps",
  forearm: "forearm",
  ab: "core",
  abdominal: "core",
  core: "core",
  oblique: "core",
  glute: "glute",
  calf: "calf",
  quad: "thigh",
  hamstring: "thigh",
  thigh: "thigh",
  neck: "neck",
};

function regionsOf(tokens: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const token of tokens) {
    const region = REGION_TOKENS[token];
    if (region) out.add(region);
  }
  return out;
}

function movementsOf(tokens: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const token of tokens) if (MOVEMENT_TOKENS.has(token)) out.add(token);
  return out;
}

function sharesAny(a: Set<string>, b: Set<string>): boolean {
  for (const token of a) if (b.has(token)) return true;
  return false;
}

/**
 * The comparison vocabulary for one exercise name: lowercased, punctuation folded
 * to spaces (via normalizeExerciseName), abbreviations expanded to the catalog's
 * own words, noise dropped, plurals folded. Ordered and de-duplicated, so it reads
 * as a name and can still be used as a set.
 */
export function expandExerciseTokens(name: string): string[] {
  const raw = normalizeExerciseName(name).split(" ").filter(Boolean);
  const out: string[] = [];
  for (const token of raw) {
    const expanded = TOKEN_ALIASES[token] ?? [token];
    for (const piece of expanded) {
      const folded = foldPluralToken(piece);
      if (!folded || NOISE_TOKENS.has(folded)) continue;
      if (!out.includes(folded)) out.push(folded);
    }
  }
  return out;
}

function tokenSet(name: string): Set<string> {
  return new Set(expandExerciseTokens(name));
}

function tokenKey(tokens: Iterable<string>): string {
  return [...tokens].sort().join(" ");
}

function implementsOf(tokens: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const token of tokens) if (IMPLEMENT_TOKENS.has(token)) out.add(token);
  return out;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const token of a) if (!b.has(token)) return false;
  return true;
}

/**
 * Are these two names the SAME lift, just labelled differently? Token-set equality
 * AFTER expansion, with two hard stops kept explicit because they are the ones that
 * matter: a VARIATION qualifier one side carries and the other lacks (incline vs
 * flat, sumo vs conventional, seated vs standing) is a different lift, and so is a
 * different IMPLEMENT — compared post-expansion, so "db" ≡ "dumbbell" but neither
 * is "barbell".
 *
 * "Db Incline Press" ≡ "Incline Dumbbell Press"; "Barbell Bench Press" ≠ "Dumbbell
 * Bench Press".
 */
export function sameExerciseIdentity(a: string, b: string): boolean {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (!left.size || !right.size) return false;
  for (const token of VARIATION_TOKENS) {
    if (left.has(token) !== right.has(token)) return false;
  }
  if (!setsEqual(implementsOf(left), implementsOf(right))) return false;
  return setsEqual(left, right);
}

// ---- catalog indexes (built once at module load) ----------------------------
const byDisplayNorm = new Map<string, GarminCatalogRow>();
const byTokenKey = new Map<string, GarminCatalogRow[]>();
const exercisesByCategory = new Map<string, Set<string>>();
const rowTokens = new Map<GarminCatalogRow, Set<string>>();
const categoryByTokenKey = new Map<string, string[]>();

for (const row of CATALOG) {
  const norm = normalizeExerciseName(row.display);
  if (norm && !byDisplayNorm.has(norm)) byDisplayNorm.set(norm, row);
  const tokens = tokenSet(row.display);
  rowTokens.set(row, tokens);
  const key = tokenKey(tokens);
  const bucket = byTokenKey.get(key);
  if (bucket) bucket.push(row);
  else byTokenKey.set(key, [row]);
  let known = exercisesByCategory.get(row.category);
  if (!known) {
    known = new Set<string>();
    exercisesByCategory.set(row.category, known);
  }
  if (row.exercise) known.add(row.exercise);
}
// A category enum ("BENCH_PRESS") is itself a name the athlete may have typed.
for (const category of exercisesByCategory.keys()) {
  const key = tokenKey(tokenSet(category.replace(/_/g, " ")));
  const bucket = categoryByTokenKey.get(key);
  if (bucket) bucket.push(category);
  else categoryByTokenKey.set(key, [category]);
}

/** Every category the catalog knows, in catalog order. */
export function garminExerciseCategories(): string[] {
  return [...exercisesByCategory.keys()];
}

/**
 * Is this a reference Garmin will actually accept? The category must be one the
 * catalog knows, and the sub-exercise must either be absent (category-only, always
 * legal on a PUT) or listed under that exact category. This is the gate an
 * agent-proposed mapping passes through — a model may not invent an enum.
 */
export function isValidGarminRef(ref: unknown): boolean {
  if (!ref || typeof ref !== "object") return false;
  const category = String((ref as any).category ?? "").trim();
  if (!category) return false;
  const known = exercisesByCategory.get(category);
  if (!known) return false;
  const exercise = (ref as any).exercise;
  if (exercise == null || String(exercise).trim() === "") return true;
  return known.has(String(exercise).trim());
}

// How close are two token sets, as a fraction of the larger one, adjusted for the
// two things that make a superficially-similar name a DIFFERENT lift. Internal
// only — never surfaced.
function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const leftMovements = movementsOf(a);
  const rightMovements = movementsOf(b);
  if (leftMovements.size && rightMovements.size && !sharesAny(leftMovements, rightMovements)) return 0;
  // Same shape of guard for the body region. Region words survive
  // `withoutImplements`, so this governs the implement-blind category vote too.
  const leftRegions = regionsOf(a);
  const rightRegions = regionsOf(b);
  if (leftRegions.size && rightRegions.size && !sharesAny(leftRegions, rightRegions)) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  if (!shared) return 0;
  let score = shared / Math.max(a.size, b.size);
  const leftImplements = implementsOf(a);
  const rightImplements = implementsOf(b);
  if (leftImplements.size && rightImplements.size) {
    score += setsEqual(leftImplements, rightImplements) ? 0.05 : -0.35;
  } else if (leftImplements.size !== rightImplements.size) {
    // One side names an implement and the other doesn't. Mildly worse than an
    // agreement, far better than a contradiction — enough that a same-implement
    // catalog row outranks an implement-less one that merely shares a token more.
    score -= 0.1;
  }
  for (const token of SCORING_QUALIFIER_TOKENS) {
    if (a.has(token) !== b.has(token)) score -= 0.15;
  }
  return Math.max(0, Math.min(1, score));
}

// The CATEGORY question is implement-independent — a press is a press whether it was
// loaded with a barbell, a dumbbell or a sandbag — so the category vote scores with
// implement words removed from both sides. Without this, "Overhead Press" split its
// vote between SHOULDER_PRESS (barbell, smith) and SANDBAG purely on which implement
// each catalog row happened to name, and came back unmapped.
function withoutImplements(tokens: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const token of tokens) if (!IMPLEMENT_TOKENS.has(token)) out.add(token);
  return out;
}

function scoredCandidates(tokens: Set<string>): GarminMapCandidate[] {
  const out: GarminMapCandidate[] = [];
  for (const row of CATALOG) {
    const score = similarity(tokens, rowTokens.get(row) as Set<string>);
    if (score <= 0) continue;
    out.push({ display: row.display, category: row.category, exercise: row.exercise, score: Math.round(score * 100) / 100 });
  }
  out.sort((x, y) => y.score - x.score || x.display.length - y.display.length || x.display.localeCompare(y.display));
  return out;
}

// A handful of FIT categories are named for the EQUIPMENT rather than the movement
// (SLED, SUSPENSION, SANDBAG, BANDED_EXERCISES). Comparing implement-blind makes their
// rows indistinguishable from the movement family's — "Sled Row" and the plain "Row"
// both reduce to {row} — so they only get a vote when the athlete actually named that
// equipment. Derived from the catalog, never a hardcoded list.
const IMPLEMENT_NAMED_CATEGORIES = new Map<string, string[]>();
for (const category of exercisesByCategory.keys()) {
  const implementWords = [...tokenSet(category.replace(/_/g, " "))].filter((token) => IMPLEMENT_TOKENS.has(token));
  if (implementWords.length) IMPLEMENT_NAMED_CATEGORIES.set(category, implementWords);
}

// Same ranking, implement-blind — only ever consulted for the category fallback.
function scoredCategoryVoters(tokens: Set<string>): Array<{ category: string; score: number }> {
  const bare = withoutImplements(tokens);
  const queryMovements = movementsOf(bare);
  const out: Array<{ category: string; score: number }> = [];
  for (const row of CATALOG) {
    const gate = IMPLEMENT_NAMED_CATEGORIES.get(row.category);
    if (gate && !gate.some((word) => tokens.has(word))) continue;
    const rowBare = withoutImplements(rowTokens.get(row) as Set<string>);
    // Assigning a whole CATEGORY is a claim about what the body did, so the vote is
    // stricter than the candidate ranking: a row may not speak for a movement the
    // athlete never named. Otherwise "Reverse Nordic" borrows LUNGE from "Reverse
    // Lunge" on the strength of the word "reverse". A name the catalog has no
    // movement word in common with stays unmapped — the honest answer, and the one
    // the agentic layer (which still gets the full shortlist) exists to improve.
    if (!queryMovements.size && movementsOf(rowBare).size) continue;
    const score = similarity(bare, rowBare);
    if (score >= CATEGORY_VOTE_FLOOR) out.push({ category: row.category, score });
  }
  return out;
}

// How much of a CATEGORY's own enum words the athlete actually typed. Deliberately
// not `similarity`: a bare category name carries no implement and no qualifier, so
// docking it for lacking the "seated"/"machine" the athlete wrote would score every
// family at zero. The movement and region guards still apply — a name may not borrow
// a family whose body region it contradicts.
function categoryNameOverlap(tokens: Set<string>, category: string): number {
  const words = tokenSet(category.replace(/_/g, " "));
  if (!words.size) return 0;
  const movements = movementsOf(tokens);
  const wordMovements = movementsOf(words);
  if (movements.size && wordMovements.size && !sharesAny(movements, wordMovements)) return 0;
  const regions = regionsOf(tokens);
  const wordRegions = regionsOf(words);
  if (regions.size && wordRegions.size && !sharesAny(regions, wordRegions)) return 0;
  let shared = 0;
  for (const word of words) if (tokens.has(word)) shared++;
  return shared / words.size;
}

const FUZZY_FLOOR = 0.7;
// Below the fuzzy floor a single sub-exercise is no longer trustworthy, but the
// CATEGORY often still is: "Hack Squat" matches only "Barbell Hack Squat" (0.57),
// and every other thing it resembles is also a squat. So a family of plausible
// rows that overwhelmingly agrees on one category yields a category-only ref —
// always legal on a PUT, and honest about what we do and don't know.
const CATEGORY_VOTE_FLOOR = 0.5;
const CATEGORY_VOTE_SHARE = 0.6;
const CANDIDATE_LIMIT = 12;

function hit(row: GarminCatalogRow, confidence: GarminMapConfidence): GarminMapHit {
  return { category: row.category, exercise: row.exercise, display: row.display, confidence };
}

/**
 * Map one Cairn exercise name onto the FIT catalog. Never invents an enum — every
 * non-"none" answer is a row (or a category) that exists in the catalog.
 *
 * In order: an exact display-name match; a unique match on the expanded token set;
 * a unique high-similarity fuzzy match; a unique parent CATEGORY (exercise null,
 * always legal on a PUT — including the case where several sub-exercises tie but
 * all sit under one category); otherwise "none" with a ranked shortlist so the
 * agentic layer, or a human, can decide.
 *
 * `opts.muscle_group` / `opts.equipment` are the row's own stored tags; they only
 * ever break a tie, never override a structural match.
 */
export function mapExerciseToGarmin(
  name: string,
  opts: { muscle_group?: string | null; equipment?: string | null } = {}
): GarminMapHit {
  const norm = normalizeExerciseName(name);
  if (!norm) return { category: "", exercise: null, display: "", confidence: "none", candidates: [] };

  const exact = byDisplayNorm.get(norm);
  if (exact) return hit(exact, "exact");

  const tokens = tokenSet(name);
  const equipmentTokens = tokenSet(String(opts.equipment ?? ""));
  const enriched = new Set(tokens);
  for (const token of equipmentTokens) if (IMPLEMENT_TOKENS.has(token)) enriched.add(token);

  for (const probe of enriched.size !== tokens.size ? [tokens, enriched] : [tokens]) {
    const keyed = byTokenKey.get(tokenKey(probe));
    if (keyed && keyed.length === 1) return hit(keyed[0], "key");
  }

  const candidates = scoredCandidates(tokens);
  const top = candidates.filter((candidate) => candidate.score >= FUZZY_FLOOR);
  if (top.length) {
    const best = top[0].score;
    const tied = top.filter((candidate) => candidate.score === best);
    if (tied.length === 1) {
      return {
        category: tied[0].category,
        exercise: tied[0].exercise,
        display: tied[0].display,
        confidence: "fuzzy",
      };
    }
    const categories = new Set(tied.map((candidate) => candidate.category));
    if (categories.size === 1) {
      const category = [...categories][0];
      return { category, exercise: null, display: category, confidence: "category" };
    }
  }

  // The athlete may simply have typed the category's own words ("Bench Press",
  // "Deadlift"). A category-only ref is always legal on a PUT.
  const categoryHits = categoryByTokenKey.get(tokenKey(tokens));
  if (categoryHits && categoryHits.length === 1) {
    return { category: categoryHits[0], exercise: null, display: categoryHits[0], confidence: "category" };
  }

  const voters = scoredCategoryVoters(tokens);
  if (voters.length) {
    // One category holding the single best implement-blind match answers outright:
    // "Cable Row" reads as a ROW because the catalog's bare "Row" matches it exactly
    // while everything else only rhymes with it. Counting votes instead would let
    // ROW's 47 heavily-qualified rows dilute their own family.
    const best = Math.max(...voters.map((voter) => voter.score));
    const leaders = new Set(voters.filter((voter) => voter.score >= best - 1e-9).map((voter) => voter.category));
    if (leaders.size === 1) {
      const category = [...leaders][0];
      return { category, exercise: null, display: category, confidence: "category" };
    }
    // Otherwise: a family of plausible rows that overwhelmingly agrees. "Overhead
    // Press" ties a sandbag row against two shoulder-press rows on the top score;
    // the weight of agreement is what breaks it.
    const weights = new Map<string, number>();
    let total = 0;
    for (const voter of voters) {
      weights.set(voter.category, (weights.get(voter.category) ?? 0) + voter.score);
      total += voter.score;
    }
    const [leader, weight] = [...weights.entries()].sort((x, y) => y[1] - x[1])[0];
    if (total > 0 && weight / total >= CATEGORY_VOTE_SHARE) {
      return { category: leader, exercise: null, display: leader, confidence: "category" };
    }
    // Last resort, and only reached where the answer would otherwise be "none": two
    // families tied on their single best row and neither outweighs the other. The
    // category's OWN name is itself something the athlete may have half-typed, so it
    // breaks the tie — "seated machine chest press" ties BENCH_PRESS ("Kettlebell
    // Chest Press") against PUSH_UP ("Chest Press with Band"), and only one of those
    // two enums shares a word with what was typed. Needs a STRICT unique winner.
    const named = [...leaders]
      .map((category) => ({ category, score: categoryNameOverlap(tokens, category) }))
      .filter((entry) => entry.score > 0)
      .sort((x, y) => y.score - x.score);
    if (named.length === 1 || (named.length > 1 && named[0].score > named[1].score + 1e-9)) {
      return { category: named[0].category, exercise: null, display: named[0].category, confidence: "category" };
    }
  }

  return {
    category: "",
    exercise: null,
    display: "",
    confidence: "none",
    candidates: candidates.slice(0, CANDIDATE_LIMIT),
  };
}

/**
 * The ranked shortlist the agentic mapping layer is allowed to choose from. The
 * deterministic answer (when there is one) leads, so a model that agrees with the
 * floor costs nothing; everything else is ordered by internal similarity. Returned
 * WITHOUT scores — the prompt asks for a choice, not a judgement of our ranking.
 */
export function garminCandidatesForPrompt(
  name: string,
  n = 12,
  opts: {
    muscle_group?: string | null;
    equipment?: string | null;
    resolved?: GarminMapHit;
  } = {}
): Array<{ display: string; category: string; exercise: string | null }> {
  const limit = Math.max(1, Math.min(40, Math.trunc(n) || 12));
  const out: Array<{ display: string; category: string; exercise: string | null }> = [];
  const seen = new Set<string>();
  const push = (row: { display: string; category: string; exercise: string | null }) => {
    const key = `${row.category}|${row.exercise ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ display: row.display, category: row.category, exercise: row.exercise });
  };

  const deterministic = opts.resolved ?? mapExerciseToGarmin(name, opts);
  if (deterministic.confidence !== "none") {
    push({ display: deterministic.display, category: deterministic.category, exercise: deterministic.exercise });
  }
  // A "none" hit already ranked the catalog for the shortlist it returned; reuse
  // that instead of walking 1527 rows a second time. A placed hit still needs the
  // rest of the list so the agent can confirm or pick a neighbour.
  const ranked = deterministic.candidates ?? scoredCandidates(tokenSet(name));
  for (const candidate of ranked) {
    if (out.length >= limit) break;
    push(candidate);
  }
  // A name sharing no word with the catalog ("Skull Crusher", "Meadows Row") would
  // otherwise hand the agent an empty list and guarantee a null answer. The FAMILIES
  // are still a real choice — category-only is always legal on a PUT — so fall back to
  // offering every category. Ignores `n` deliberately: an arbitrary 12 of 47 families
  // would silently hide the right one.
  if (!out.length) {
    for (const category of exercisesByCategory.keys()) push({ display: category, category, exercise: null });
    return out;
  }
  return out.slice(0, limit);
}

// ---- weight / duration conversion ------------------------------------------
// Cairn stores pounds, with two encodings Garmin has no field for: a NEGATIVE
// weight is assist (-30 = 30 lb of assistance) and null is bodyweight. Garmin's
// exerciseSets `weight` is grams of external load, so both become null — writing
// 30 lb onto an assisted pull-up would claim the athlete added weight they were
// actually given.

/** Cairn pounds → Garmin grams. Assist (negative) and bodyweight (null/0) → null. */
export function garminWeightGrams(lb: number | null | undefined): number | null {
  if (lb == null) return null;
  const pounds = Number(lb);
  if (!Number.isFinite(pounds) || pounds <= 0) return null;
  return Math.round((pounds / LB_PER_KG) * 1000);
}
