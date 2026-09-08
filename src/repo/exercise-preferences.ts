// ============================================================================
// exercise-preferences.ts — preference-aware novelty: the athlete's 'preference'
// memories parsed into polarity + tokens, and the bounded re-rank they earn over
// same-pattern variation candidates. Split out of progression.ts. A leaf: pure
// text scoring plus one memory read, no progression logic.
//
// Constitution: this NEVER pulls in a candidate injury/pattern filters excluded
// and never overrides pattern-correctness — it reorders the passing list only.
// ============================================================================
import { db } from "../db.js";
import type { Equipment, ExerciseVariation } from "./exercise-variations.js";

// ---- preference-aware novelty (bounded, deterministic) ----------------------
// A parsed 'preference' memory: a polarity (a like vs a "dislikes X"/"hates X"
// phrasing) plus the load-bearing keyword tokens it names. Used ONLY to gently
// re-rank same-pattern variation candidates the athlete already qualifies for —
// it NEVER pulls in a candidate injury/pattern filters excluded, and never
// overrides pattern-correctness (it reorders the passing list, never adds to it).
export interface ParsedPreference {
  polarity: 1 | -1; // like (+1) vs dislike (-1)
  tokens: Set<string>; // distinctive keyword tokens named in the memory
}

// A negative-preference phrasing ("dislikes X" / "hates X" / "avoid X" / "not a
// fan of X" / "don't like X"). Anything else on a 'preference' memory reads as a
// positive like. Deliberately conservative — exact/substring only, no NLP. Only a
// leading word boundary is anchored so common suffixes still match (dislike →
// dislikes, hate → hates, avoid → avoiding).
const PREF_DISLIKE_RE =
  /\b(dislike|hate|avoid|can'?t stand|cannot stand|not a fan|no thanks|rather not|don'?t (?:like|enjoy|want)|doesn'?t (?:like|enjoy|want))/i;

// Generic words that never discriminate one same-pattern candidate from another
// (so "loves squats" doesn't uniformly light up every squat variation) — dropped
// from both the memory tokens and the candidate's distinctive tokens.
const PREF_STOPWORDS = new Set(
  "the a an and or to of in on for is are do does did have has i im my me you your with at as be it that this so but not more most really always usually prefer prefers like likes love loves enjoy enjoys favou favour favourite favorite exercise exercises workout workouts lift lifts move moves movement movements work works working train trains training day days".split(
    " "
  )
);

function prefTokens(s: string): string[] {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !PREF_STOPWORDS.has(w));
}

// Equipment → the plain words a memory might use to name it (so "prefers dumbbell
// work" boosts every DB candidate). Matched once per candidate. Deliberately only
// unambiguous, ≥3-char words: no "bb"/"db"/"kb" (2-char tokens are dropped anyway)
// and no "hack"/"smith" (those are specific movement names, not generic equipment,
// so they'd wrongly demote Leg Press off a "hates hack squats" memory).
const PREF_EQUIP_ALIASES: Record<Equipment, string[]> = {
  barbell: ["barbell"],
  dumbbell: ["dumbbell", "dumbell", "dumbbells"],
  machine: ["machine", "machines"],
  cable: ["cable", "cables", "pulley"],
  kettlebell: ["kettlebell", "kettlebells"],
  bodyweight: ["bodyweight", "calisthenic", "calisthenics"],
};

// Parse 'preference' memory contents into polarity + tokens. Empty/tokenless rows
// are dropped. Pure + deterministic — exported for direct unit testing.
export function parsePreferenceMemories(contents: Array<string | null | undefined>): ParsedPreference[] {
  const out: ParsedPreference[] = [];
  for (const raw of contents) {
    const text = String(raw ?? "").trim();
    if (!text) continue;
    const tokens = new Set(prefTokens(text));
    if (!tokens.size) continue;
    out.push({ polarity: PREF_DISLIKE_RE.test(text) ? -1 : 1, tokens });
  }
  return out;
}

// The learned-preference score for ONE candidate against the original lift. The
// candidate's DISTINCTIVE tokens (its name tokens MINUS the original's, so the
// shared pattern noun like "squat" never counts) plus its equipment aliases are
// matched against each preference; a match contributes polarity×strength. 0 when
// nothing matches (the calm, common answer). Pure — exported for unit testing.
export function preferenceSignal(
  candidate: { name: string; equipment: Equipment },
  originalName: string,
  prefs: ParsedPreference[]
): number {
  if (!prefs.length) return 0;
  const originalTokens = new Set(prefTokens(originalName));
  const distinctive = prefTokens(candidate.name).filter((t) => !originalTokens.has(t));
  const equipAliases = PREF_EQUIP_ALIASES[candidate.equipment] ?? [];
  let score = 0;
  for (const p of prefs) {
    let strength = 0;
    for (const t of distinctive) if (p.tokens.has(t)) strength++;
    if (equipAliases.some((a) => p.tokens.has(a))) strength++; // equipment mention counts once
    if (strength > 0) score += p.polarity * strength;
  }
  return score;
}

// Stable-sort variation candidates by their learned-preference score (liked first,
// disliked last), preserving the input order for ties — so the equipment/compound
// ranking suggestAlternatives already applied is the tiebreak. NEVER filters: a
// disliked candidate is demoted, never removed, and nothing new is ever added, so
// injury/pattern constraints upstream always win. Pure — exported for unit testing.
export function preferenceRerank(
  candidates: ExerciseVariation[],
  originalName: string,
  prefs: ParsedPreference[]
): ExerciseVariation[] {
  if (!prefs.length || candidates.length < 2) return candidates;
  return candidates
    .map((c, i) => ({ c, i, s: preferenceSignal(c, originalName, prefs) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.c);
}

// The athlete's live 'preference' memories, parsed. Read once per day's pass and
// threaded into every lift's context. Null-safe — no memory / no preferences → [].
export function learnedPreferences(): ParsedPreference[] {
  try {
    const rows = db
      .prepare(`SELECT content FROM memory WHERE kind = 'preference' AND superseded_by IS NULL ORDER BY id DESC LIMIT 40`)
      .all() as any[];
    return parsePreferenceMemories(rows.map((r) => String(r?.content ?? "")));
  } catch {
    return [];
  }
}
