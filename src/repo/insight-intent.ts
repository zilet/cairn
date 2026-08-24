// The identity of a quiet cross-domain insight — WHAT it connects, not how it was
// worded. Text dedup (isDuplicateInsight, coach.ts) collapses a reword; it cannot
// collapse a genuine rephrase, because "your protein timing and sleep quality look
// linked" and "your sleep tends to improve on days when dinner protein is higher"
// share almost no words. No Jaccard threshold fixes that — the two sentences are
// the same CLAIM, and only a claim-level key can say so.
//
// So an insight carries an intent key: the two facets it links plus whether they
// move together or against each other. Both producers (the agentic connection pass
// in coachOps.generateInsight and the deterministic health-outcome annotations in
// health-outcomes.ts) route through this one module, the same discipline as
// foodCapture.ts / symptomCapture.ts — one contract, no drifting copies.
//
// DERIVATION IS DELIBERATELY CONSERVATIVE. deriveInsightIntentKey() reads surface
// synonyms out of free text and returns null on ANY ambiguity: fewer than two
// distinct facets, more than two, or two that sit in the same domain. A wrong key
// silences a real insight forever, which is far worse than falling back to today's
// text guard — so when the text does not name exactly one clean cross-domain pair,
// this module says nothing and the caller keeps the status quo.
import { db } from "../db.js";
// Repetition-gated dismissal evidence (W3.2): a theme dismissed on repeat days is
// a SOFTER cousin of a thumbs-down, folded into the same corpus below rather than
// given its own hard suppression — see repeatedlyDismissedKeys' own doc comment
// for the repetition gate itself.
import { repeatedlyDismissedKeys } from "./surface-dismissals.js";

export type InsightDomain = "training" | "endurance" | "nutrition" | "sleep" | "recovery" | "labs" | "body" | "life";

export interface InsightFacet {
  // "<domain>.<name>" — the stable identifier that goes into a key.
  facet: string;
  domain: InsightDomain;
  // Short athlete-facing label, used when we tell the model what it already covered.
  label: string;
  // Lowercase surface forms for derivation, matched longest-first with word
  // boundaries. NOT an exhaustive lexicon — just enough that the common phrasings
  // of this facet land on it rather than on a neighbour.
  //
  // EVERY SURFACE MUST BE UNAMBIGUOUS IN PROSE. A bare common word whose second
  // meaning is idiomatic ("carrying the weight of the days before it", "ahead of
  // schedule", "the pace of change", "the strength of the link", "a tweak to your
  // plan") or MECHANICAL ("stress on the elbow joint", "drinking water") fires this
  // facet on a sentence that is not about it at all, and the damage is silent and
  // asymmetric. A false pair writes a wildcard key that suppresses a genuine
  // territory for 90 days with nothing to show for it; and a stray THIRD facet in
  // an otherwise clean sentence collapses the derivation to null, letting a real
  // repeat through the guard. So a term earns its place only in a multi-word form
  // or with a possessive ("your weight", "work stress"). Under-matching costs one
  // derivation; over-matching costs a connection.
  surfaces: string[];
}

// The closed vocabulary. COARSE ON PURPOSE: a fine-grained list (labs.ferritin vs
// labs.hemoglobin, nutrition.dinner_protein vs nutrition.protein) lets a rephrase
// land on a neighbouring facet and slip through, which is exactly the failure this
// key is meant to close. Facets are grouped at the level this codebase already
// reasons at — the five signal-state dimensions (src/repo/signal-state.ts), the
// clinical MARKER_GROUPS (src/repo/propagation-data.ts), and the day-read rules'
// training/fuel/recovery/life vocabulary.
export const INSIGHT_FACETS: InsightFacet[] = [
  // ---- training (strength / the training_load_tolerance dimension) ----
  {
    facet: "training.volume",
    domain: "training",
    label: "training volume",
    surfaces: ["training volume", "weekly volume", "set volume", "total sets", "workload", "training load", "volume"],
  },
  {
    facet: "training.intensity",
    domain: "training",
    label: "training intensity",
    surfaces: ["training intensity", "hard sessions", "heavy days", "heavy sessions", "intensity", "rpe"],
  },
  {
    facet: "training.strength",
    domain: "training",
    label: "strength progress",
    // NOT bare "strength": "the strength of the link between your fibre and your
    // cholesterol" is the single most damaging false match on record — a stray third
    // facet inside the one connection the athlete actually keeps being told.
    surfaces: [
      "strength progress",
      "strength gains",
      "strength work",
      "your strength",
      "getting stronger",
      "estimated 1rm",
      "est-1rm",
      "e1rm",
      "1rm",
      "top set",
      "working weight",
      "lifting numbers",
    ],
  },
  {
    facet: "training.consistency",
    domain: "training",
    label: "training consistency",
    // NOT bare "showing up" (pain, soreness and stiffness all "show up" too) and NOT
    // bare "consistency" (which is just as often said of sleep or of eating).
    surfaces: [
      "training consistency",
      "session frequency",
      "sessions per week",
      "showing up for training",
      "showing up to train",
      "sticking to the plan",
      "missed sessions",
      "skipped sessions",
    ],
  },
  {
    facet: "training.soreness",
    domain: "training",
    label: "muscle soreness",
    surfaces: ["muscle soreness", "doms", "soreness", "sore"],
  },

  // ---- endurance (running / cardio) ----
  {
    facet: "endurance.mileage",
    domain: "endurance",
    label: "running mileage",
    surfaces: ["running mileage", "weekly mileage", "run volume", "mileage", "miles", "kilometres", "kilometers"],
  },
  {
    facet: "endurance.pace",
    domain: "endurance",
    label: "running pace",
    // NOT bare "pace": "the pace of change", "ahead of pace" and weight-loss pace are
    // all rate-of-progress idioms, not running pace.
    surfaces: ["easy pace", "running pace", "race pace", "run pace", "training pace", "pace per mile", "pace per km"],
  },
  {
    facet: "endurance.aerobic_fitness",
    domain: "endurance",
    label: "aerobic fitness",
    surfaces: ["aerobic fitness", "aerobic base", "vo2max", "vo2 max", "cardio fitness", "endurance"],
  },

  // ---- nutrition (the energy_fueling dimension + foodCapture's bands) ----
  {
    facet: "nutrition.protein",
    domain: "nutrition",
    label: "protein intake",
    surfaces: ["protein intake", "dinner protein", "protein"],
  },
  {
    facet: "nutrition.calories",
    domain: "nutrition",
    label: "calorie intake",
    surfaces: [
      "calorie intake",
      "energy intake",
      "eating enough",
      "under-eating",
      "undereating",
      "calories",
      "kcal",
      "deficit",
      "surplus",
    ],
  },
  {
    facet: "nutrition.carbs",
    domain: "nutrition",
    label: "carbohydrate intake",
    surfaces: ["carbohydrate intake", "carbohydrates", "carb intake", "carbs"],
  },
  {
    facet: "nutrition.timing",
    domain: "nutrition",
    label: "meal timing",
    surfaces: [
      "meal timing",
      "eating window",
      "late dinner",
      "late meals",
      "pre-workout fuel",
      "post-workout fuel",
      "fuelling timing",
      "fueling timing",
    ],
  },
  {
    facet: "nutrition.hydration",
    domain: "nutrition",
    label: "hydration",
    surfaces: ["hydration", "fluid intake", "water intake", "dehydrated", "dehydration"],
  },
  {
    facet: "nutrition.alcohol",
    domain: "nutrition",
    label: "alcohol",
    // NOT bare "drinking"/"drinks": "drinking water" and "sports drinks" are the
    // hydration and fuelling facets, and a wrong facet is worse than no facet.
    surfaces: ["alcohol", "drinking alcohol", "a few drinks", "wine", "beer", "nightcap"],
  },
  {
    facet: "nutrition.fibre",
    domain: "nutrition",
    label: "fibre intake",
    surfaces: ["fibre intake", "fiber intake", "fibre", "fiber"],
  },

  // ---- sleep ----
  {
    facet: "sleep.duration",
    domain: "sleep",
    label: "sleep duration",
    surfaces: ["sleep duration", "hours of sleep", "sleep hours", "time asleep", "short nights", "sleep debt"],
  },
  {
    facet: "sleep.quality",
    domain: "sleep",
    label: "sleep quality",
    surfaces: [
      "sleep quality",
      "restless nights",
      "broken sleep",
      "deep sleep",
      "sleep score",
      "how you sleep",
      "sleeping",
      "sleep",
    ],
  },
  {
    facet: "sleep.timing",
    domain: "sleep",
    label: "sleep timing",
    surfaces: ["sleep timing", "bedtime", "wake time", "late nights", "sleep schedule"],
  },

  // ---- recovery (the recovery_capacity dimension) ----
  { facet: "recovery.hrv", domain: "recovery", label: "HRV", surfaces: ["heart rate variability", "hrv"] },
  {
    facet: "recovery.resting_hr",
    domain: "recovery",
    label: "resting heart rate",
    surfaces: ["resting heart rate", "resting hr", "resting pulse"],
  },
  {
    facet: "recovery.readiness",
    domain: "recovery",
    label: "readiness",
    surfaces: ["body battery", "readiness", "recovery", "recovered", "feeling fresh", "freshness"],
  },
  {
    facet: "recovery.joint_pain",
    domain: "recovery",
    label: "joint pain",
    // "tweak" is deliberately absent: the surface only ever matched the NOUN (the
    // pattern takes a plural suffix, not a past tense), and in coaching prose a
    // tweak is something you make to a plan far more often than something you feel.
    surfaces: [
      "joint pain",
      "shoulder pain",
      "knee pain",
      "back pain",
      "elbow pain",
      "hip pain",
      "niggle",
      "pain",
    ],
  },

  // ---- labs (one facet per clinical MARKER_GROUP cluster, never per analyte) ----
  {
    facet: "labs.iron",
    domain: "labs",
    label: "iron status",
    surfaces: [
      "iron status",
      "iron stores",
      "ferritin",
      "haemoglobin",
      "hemoglobin",
      "haematocrit",
      "hematocrit",
      "transferrin",
      "iron",
    ],
  },
  {
    facet: "labs.metabolic",
    domain: "labs",
    label: "blood sugar",
    surfaces: [
      "blood sugar",
      "blood glucose",
      "fasting glucose",
      "hba1c",
      "a1c",
      "fasting insulin",
      "insulin",
      "glucose",
    ],
  },
  {
    facet: "labs.lipids",
    domain: "labs",
    label: "cholesterol",
    surfaces: ["cholesterol", "apob", "apo b", "ldl", "hdl", "triglycerides", "lipids", "lipid panel"],
  },
  {
    facet: "labs.inflammation",
    domain: "labs",
    label: "inflammation markers",
    surfaces: ["inflammation", "c-reactive protein", "crp", "homocysteine"],
  },
  { facet: "labs.thyroid", domain: "labs", label: "thyroid", surfaces: ["thyroid", "tsh", "free t3", "free t4"] },
  {
    facet: "labs.hormones",
    domain: "labs",
    label: "hormones",
    surfaces: ["testosterone", "cortisol", "estradiol", "oestradiol", "shbg", "dhea", "hormones"],
  },
  {
    facet: "labs.vitamins",
    domain: "labs",
    label: "vitamin & mineral status",
    surfaces: ["vitamin d", "vitamin b12", "b12", "folate", "magnesium", "omega-3", "omega 3", "vitamins"],
  },
  {
    facet: "labs.kidney_liver",
    domain: "labs",
    label: "kidney & liver markers",
    surfaces: ["kidney function", "liver enzymes", "creatinine", "egfr", "alt", "ast", "ggt", "uric acid"],
  },
  {
    facet: "labs.blood_pressure",
    domain: "labs",
    label: "blood pressure",
    surfaces: ["blood pressure", "systolic", "diastolic"],
  },

  // ---- body composition ----
  {
    facet: "body.weight",
    domain: "body",
    label: "body weight",
    // NOT bare "weight": "carrying the weight of the days before it" is fatigue prose,
    // and "working weight" / "the weight on the bar" are load. Every form here either
    // says body, says the scale, or says a direction of change.
    surfaces: [
      "body weight",
      "bodyweight",
      "scale weight",
      "your weight",
      "weight loss",
      "weight gain",
      "losing weight",
      "gaining weight",
      "weight trend",
      "weigh-in",
      "the scale",
    ],
  },
  { facet: "body.body_fat", domain: "body", label: "body fat", surfaces: ["body fat", "visceral fat", "fat mass"] },
  {
    facet: "body.lean_mass",
    domain: "body",
    label: "lean mass",
    surfaces: ["lean mass", "muscle mass", "fat-free mass", "fat free mass", "almi"],
  },
  {
    facet: "body.measurements",
    domain: "body",
    label: "body measurements",
    surfaces: ["waist measurement", "waist circumference", "body measurements", "waist"],
  },

  // ---- life (the life_capacity dimension) ----
  {
    facet: "life.stress",
    domain: "life",
    label: "life stress",
    // NOT bare "stress": in a training app the mechanical sense is at least as common
    // ("stress on the joint", "stress the tendon"), and that reading is the opposite
    // domain from this one.
    surfaces: ["life stress", "work stress", "your stress", "stress levels", "under stress", "stressful", "stressed"],
  },
  {
    facet: "life.schedule",
    domain: "life",
    label: "schedule pressure",
    // NOT bare "schedule": "ahead of schedule" / "behind schedule" are progress-pace
    // idioms with no calendar in them. Every form here carries calendar context.
    surfaces: [
      "schedule pressure",
      "busy schedule",
      "packed schedule",
      "your schedule",
      "busy weeks",
      "travel",
      "work hours",
      "workload at work",
      "calendar",
    ],
  },
  {
    facet: "life.mood",
    domain: "life",
    label: "mood",
    surfaces: ["mood", "motivation", "morale", "how you feel about"],
  },
];

const FACET_BY_KEY = new Map<string, InsightFacet>(INSIGHT_FACETS.map((f) => [f.facet, f]));

export function insightFacet(facet: string): InsightFacet | null {
  return (
    FACET_BY_KEY.get(
      String(facet ?? "")
        .trim()
        .toLowerCase()
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// the key itself
// ---------------------------------------------------------------------------

// Polarity: do the two facets move TOGETHER or against each other. Directions are
// used only to compute this and are then thrown away, which is what makes the key
// symmetric under a global flip — "protein up with sleep up" and "sleep down with
// protein down" are one claim, so they must be one key. "*" is the DERIVED polarity:
// free-text derivation reads what an insight is about, never which way each side
// moved, so a derived key is territorial and collides with either polarity.
export type InsightPolarity = "same" | "opposite" | "*";
export type InsightDirection = "up" | "down";

function makeKey(facetA: string, facetB: string, polarity: InsightPolarity): string {
  const [x, y] = [facetA, facetB].sort();
  return `${x}~${y}:${polarity}`;
}

interface ParsedKey {
  pair: string;
  facets: [string, string];
  polarity: InsightPolarity;
}

export function splitInsightIntentKey(key: string | null | undefined): ParsedKey | null {
  const s = String(key ?? "").trim();
  if (!s) return null;
  const at = s.lastIndexOf(":");
  if (at <= 0) return null;
  const pair = s.slice(0, at);
  const polarity = s.slice(at + 1);
  if (polarity !== "same" && polarity !== "opposite" && polarity !== "*") return null;
  const facets = pair.split("~");
  if (facets.length !== 2) return null;
  if (!insightFacet(facets[0]) || !insightFacet(facets[1])) return null;
  return { pair, facets: [facets[0], facets[1]], polarity };
}

// Two keys collide when they name the same facet pair and their polarities are
// compatible — a derived "*" matches either direction, an explicit pair must agree.
export function intentKeysCollide(a: string | null | undefined, b: string | null | undefined): boolean {
  const pa = splitInsightIntentKey(a);
  const pb = splitInsightIntentKey(b);
  if (!pa || !pb || pa.pair !== pb.pair) return false;
  return pa.polarity === "*" || pb.polarity === "*" || pa.polarity === pb.polarity;
}

function side(value: unknown): { facet: InsightFacet; direction: InsightDirection } | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const facet = insightFacet(String(raw.facet ?? ""));
  const direction = String(raw.direction ?? "")
    .trim()
    .toLowerCase();
  if (!facet || (direction !== "up" && direction !== "down")) return null;
  return { facet, direction: direction as InsightDirection };
}

// Validate an agent-emitted {a:{facet,direction}, b:{facet,direction}} into a
// canonical key. Returns null when a facet is outside the vocabulary, a direction
// is missing, both sides name the SAME facet, or both sides sit in the same domain
// — a same-domain pair is not a cross-domain connection, which is the only thing
// this insight is allowed to be, so it is rejected outright rather than keyed.
export function parseInsightIntentKey(connection: unknown): string | null {
  if (!connection || typeof connection !== "object") return null;
  const c = connection as Record<string, unknown>;
  const a = side(c.a);
  const b = side(c.b);
  if (!a || !b) return null;
  if (a.facet.facet === b.facet.facet) return null;
  if (a.facet.domain === b.facet.domain) return null;
  return makeKey(a.facet.facet, b.facet.facet, a.direction === b.direction ? "same" : "opposite");
}

// ---------------------------------------------------------------------------
// derivation from free text (legacy rows + the deterministic health-outcome path)
// ---------------------------------------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Longest surface first, same shape as classifyDirectiveIntent's keyword pass
// (src/repo/propagation-data.ts): the longer phrase wins so "resting heart rate"
// never degrades into a bare "heart rate", and its span is blanked out of the
// haystack so a shorter contained surface cannot also fire.
const SURFACES: { re: RegExp; facet: InsightFacet }[] = INSIGHT_FACETS.flatMap((facet) =>
  facet.surfaces.map((surface) => ({ surface, facet }))
)
  .sort((a, b) => b.surface.length - a.surface.length)
  .map(({ surface, facet }) => ({ re: new RegExp(`\\b${escapeRe(surface)}(?:s|es)?\\b`, "gi"), facet }));

export function deriveInsightIntentKey(text: string | null | undefined, rationale?: string | null): string | null {
  let hay = `${String(text ?? "")} ${String(rationale ?? "")}`.toLowerCase();
  if (!hay.trim()) return null;
  const found: InsightFacet[] = [];
  const seen = new Set<string>();
  for (const { re, facet } of SURFACES) {
    re.lastIndex = 0;
    if (!re.test(hay)) continue;
    re.lastIndex = 0;
    hay = hay.replace(re, (m) => " ".repeat(m.length));
    if (seen.has(facet.facet)) continue;
    seen.add(facet.facet);
    found.push(facet);
  }
  // The conservative rule, stated once: exactly two facets, in two different
  // domains, or nothing at all.
  if (found.length !== 2) return null;
  if (found[0].domain === found[1].domain) return null;
  return makeKey(found[0].facet, found[1].facet, "*");
}

// ---------------------------------------------------------------------------
// the one resolution contract both producers call
// ---------------------------------------------------------------------------

export type InsightIntentResolution =
  // The agent named a valid connection, or the text derived cleanly.
  | { status: "keyed"; key: string }
  // The agent named a connection and it did not validate. The KEY is discarded and
  // never stored; the caller (coachOps.insightVerdict) drops back to derivation as
  // if none had been named, so a vocabulary miss costs the key, not the insight.
  | { status: "invalid"; key: null }
  // No connection was named and derivation was ambiguous: fall back to the text
  // guard and store a NULL key (the pre-key status quo, no regression).
  | { status: "unkeyed"; key: null };

export function resolveInsightIntent(
  connection: unknown,
  text: string | null | undefined,
  rationale?: string | null
): InsightIntentResolution {
  if (connection != null) {
    const key = parseInsightIntentKey(connection);
    return key ? { status: "keyed", key } : { status: "invalid", key: null };
  }
  const derived = deriveInsightIntentKey(text, rationale);
  return derived ? { status: "keyed", key: derived } : { status: "unkeyed", key: null };
}

// ---------------------------------------------------------------------------
// the key corpus
// ---------------------------------------------------------------------------

// Only these kinds carry a territorial key. `weekly_read` is deliberately absent:
// it legitimately recurs on the same territory every single week, so keying it
// would silence the standing read after its first run.
export const KEYED_INSIGHT_KINDS = ["connection", "health_outcome"] as const;

// The key corpus is TIME-based, not last-N-rows: a connection said two months ago
// is still said, however many insights have scrolled past it since.
export const INSIGHT_KEY_WINDOW_DAYS = 90;

// What may reach a PROMPT out of that corpus. The corpus itself stays whole — the
// dedupe guards and the cache key need every key in the window — but a 90-day window
// can hold ~200 rows, and pasting all of them into the insight prompt is a payload
// the model reads as noise. `buildInsightPrompt` is the single choke point where both
// lists are cut, newest first (both arrive in id-DESC order).
export const INSIGHT_PROMPT_UNKEYED_LIMIT = 12;
export const INSIGHT_PROMPT_COVERED_LIMIT = 20;

// A thumbs-down is territorial, not textual — the athlete waved off the CONNECTION,
// so its key keeps suppressing regardless of age. Bounded exactly like
// DOWNVOTED_DEDUP_LIMIT so the corpus can never grow without limit.
export const DOWNVOTED_KEY_LIMIT = 30;

// A sane ceiling on the in-window scan so a very chatty 90 days cannot make the
// corpus build unbounded.
const KEY_WINDOW_ROW_LIMIT = 200;

export interface InsightIntentCorpus {
  // Every intent key in play — stored keys plus keys derived on the fly.
  keys: string[];
  // Rows in the window that have no key and whose text would not derive one. They
  // keep going to the model as raw text so a LITERAL repeat is still blocked.
  unkeyedTexts: string[];
}

// Legacy rows are NOT backfilled — their keys are derived here, at READ time, so
// improving derivation improves them retroactively (the same on-the-fly shape as
// lastDirectiveFeedback's intent classification, src/repo/propagation.ts).
export function insightIntentCorpus(): InsightIntentCorpus {
  const kinds = KEYED_INSIGHT_KINDS.map(() => "?").join(", ");
  const recent = db
    .prepare(
      `SELECT text, rationale, intent_key FROM insights
        WHERE kind IN (${kinds}) AND created_at >= datetime('now', ?)
        ORDER BY id DESC LIMIT ?`
    )
    .all(...KEYED_INSIGHT_KINDS, `-${INSIGHT_KEY_WINDOW_DAYS} days`, KEY_WINDOW_ROW_LIMIT) as any[];
  const downvoted = db
    .prepare(
      `SELECT text, rationale, intent_key FROM insights
        WHERE kind IN (${kinds}) AND feedback = 'down'
        ORDER BY id DESC LIMIT ?`
    )
    .all(...KEYED_INSIGHT_KINDS, DOWNVOTED_KEY_LIMIT) as any[];

  const keys: string[] = [];
  const seenKeys = new Set<string>();
  const unkeyedTexts: string[] = [];
  const seenTexts = new Set<string>();
  for (const row of [...recent, ...downvoted]) {
    const stored = splitInsightIntentKey(row?.intent_key) ? String(row.intent_key).trim() : null;
    const key = stored ?? deriveInsightIntentKey(row?.text, row?.rationale);
    if (key) {
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        keys.push(key);
      }
      continue;
    }
    const text = String(row?.text ?? "").trim();
    if (text && !seenTexts.has(text)) {
      seenTexts.add(text);
      unkeyedTexts.push(text);
    }
  }
  // Repetition-gated dismissal evidence (W3.2): a theme dismissed on >=2 distinct
  // days joins the SAME corpus a thumbs-down feeds — soft suppression via the
  // dedupe/prompt-covered list, never a hard block, and never from ONE idle tap.
  // item_key here is already a canonical intent key (surface-dismissals only ever
  // stores one when the insight route resolved it), so no re-derivation.
  for (const key of repeatedlyDismissedKeys("insight")) {
    if (!splitInsightIntentKey(key)) continue;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      keys.push(key);
    }
  }
  return { keys, unkeyedTexts };
}

// True when the candidate key names territory the corpus already covers.
export function isDuplicateInsightIntent(
  key: string | null | undefined,
  corpus: string[] = insightIntentCorpus().keys
): boolean {
  if (!splitInsightIntentKey(key)) return false;
  return corpus.some((k) => intentKeysCollide(key, k));
}

// ---------------------------------------------------------------------------
// rendering (prompt-facing)
// ---------------------------------------------------------------------------

// "protein intake ~ sleep quality (together)" — what the model is told it has
// already covered. Plain territory, not a sentence to reword around.
export function describeInsightIntentKey(key: string | null | undefined): string | null {
  const parsed = splitInsightIntentKey(key);
  if (!parsed) return null;
  const a = insightFacet(parsed.facets[0]);
  const b = insightFacet(parsed.facets[1]);
  if (!a || !b) return null;
  const how = parsed.polarity === "opposite" ? "opposite" : parsed.polarity === "same" ? "together" : "either way";
  return `${a.label} ~ ${b.label} (${how})`;
}

// The vocabulary, printed for the model grouped by domain.
export function renderInsightFacetVocabulary(): string {
  const byDomain = new Map<InsightDomain, string[]>();
  for (const f of INSIGHT_FACETS) {
    const list = byDomain.get(f.domain) ?? [];
    list.push(f.facet);
    byDomain.set(f.domain, list);
  }
  return [...byDomain.entries()].map(([domain, facets]) => `  ${domain}: ${facets.join(", ")}`).join("\n");
}
