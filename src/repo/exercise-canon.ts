// Exercise canonicalization — the strength brain's movement de-duplication and
// muscle-group classification. The deterministic FLOOR under elite program
// intelligence (mirrors src/repo/marker-canon.ts for labs and src/art.ts's
// resolveConcept for artwork).
//
// Two problems it solves:
//  1. CLASSIFICATION. Exercises arrive with a free-form (or missing) muscle_group,
//     so the volume picture is wrong: a bench press with no group lands in "other",
//     and there's no `core`/`forearms`/`mobility` concept at all. classifyMuscleGroup
//     maps a name → ONE canonical primary group from the taxonomy below; canonicalGroup
//     folds legacy/free-form values onto it.
//  2. DUPLICATION. "Dead hang" and "Dead hang timed" are the same movement logged
//     under two names, splitting one lift's history into parallel series.
//     normalizedExerciseKey folds the non-distinguishing variants; planExerciseMerges
//     proposes the concrete merges (the write lives in repo/exercises.mergeExercises).
//
// Constitution: this only ever surfaces a canonical GROUP and plain-words bands —
// never a 0-100 score. Classification MERGES/labels for analysis; it never changes
// what the athlete typed as the exercise name on a logged set.

import { db } from "../db.js";

// ---- THE CANONICAL MUSCLE-GROUP TAXONOMY (authoritative) --------------------
// Every exercise resolves to exactly one of these. `core`, `forearms`, `mobility`
// are first-class groups (they were missing — which is why core/grip/stretch work
// was invisible). Order is a sensible display order (push → pull → legs → trunk).
export const MUSCLE_GROUPS = [
  "chest",
  "shoulders",
  "rear delts",
  "triceps",
  "back",
  "biceps",
  "forearms",
  "quads",
  "hamstrings",
  "glutes",
  "calves",
  "core",
  "mobility",
] as const;

export type MuscleGroup = (typeof MUSCLE_GROUPS)[number];

// Weekly working-set landmarks per group — the band thresholds (RP-style volume
// landmarks, adapted). PLAIN-WORDS framing only: consumers report "low / productive
// / high", NEVER the raw numbers as a score. mobility is non-counting (null).
export const MUSCLE_LANDMARKS: Record<string, { low: number; high: number } | null> = {
  chest: { low: 10, high: 22 },
  back: { low: 10, high: 25 },
  shoulders: { low: 8, high: 22 },
  "rear delts": { low: 6, high: 16 },
  biceps: { low: 6, high: 20 },
  triceps: { low: 6, high: 20 },
  quads: { low: 8, high: 20 },
  hamstrings: { low: 6, high: 16 },
  glutes: { low: 6, high: 16 },
  calves: { low: 6, high: 16 },
  core: { low: 6, high: 20 },
  forearms: { low: 4, high: 16 },
  mobility: null,
};

export function isMobility(group: string | null | undefined): boolean {
  return canonicalGroup(group ?? null) === "mobility";
}

// ---- name normalization -----------------------------------------------------
// Lowercase, fold non-alphanumerics to spaces, collapse + trim. Used for matching.
export function normalizeExerciseName(raw: string): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The MERGE key for duplicate detection. CONSERVATIVE: we only drop tokens that do
// NOT distinguish a movement — "timed" (a mode, not a different lift) and a trailing
// "machine"/"-machine" qualifier when it's just describing the same station. We do
// NOT strip implement words (barbell vs dumbbell ARE different lifts), so the key
// stays tight. "Dead hang" / "Dead hang timed" → "dead hang".
const NON_DISTINGUISHING = new Set(["timed"]);
export function normalizedExerciseKey(name: string): string {
  const tokens = normalizeExerciseName(name).split(" ").filter(Boolean);
  const kept = tokens.filter((t) => !NON_DISTINGUISHING.has(t));
  return (kept.length ? kept : tokens).join(" ");
}

// ---- legacy / free-form group → canonical group -----------------------------
// Folds the inconsistent values already in the DB onto the taxonomy. legs→quads
// (knee-dominant default), posterior→hamstrings, abs→core, grip→forearms, etc.
const GROUP_ALIASES: Record<string, MuscleGroup> = {
  legs: "quads",
  leg: "quads",
  quad: "quads",
  quadriceps: "quads",
  posterior: "hamstrings",
  "posterior chain": "hamstrings",
  hams: "hamstrings",
  hamstring: "hamstrings",
  hammies: "hamstrings",
  glute: "glutes",
  butt: "glutes",
  abs: "core",
  ab: "core",
  abdominals: "core",
  abdominal: "core",
  trunk: "core",
  obliques: "core",
  grip: "forearms",
  forearm: "forearms",
  wrist: "forearms",
  "rear delt": "rear delts",
  "rear deltoid": "rear delts",
  "rear deltoids": "rear delts",
  delts: "shoulders",
  deltoid: "shoulders",
  deltoids: "shoulders",
  shoulder: "shoulders",
  pecs: "chest",
  pec: "chest",
  lats: "back",
  lat: "back",
  bicep: "biceps",
  tricep: "triceps",
  triceps: "triceps",
  calf: "calves",
  calve: "calves",
  mobility: "mobility",
  stretch: "mobility",
  stretching: "mobility",
  cardio: "mobility", // a misfiled cardio tag → non-counting (never a strength group)
};

const VALID = new Set<string>(MUSCLE_GROUPS);

export function canonicalGroup(rawGroup: string | null | undefined): MuscleGroup | null {
  if (rawGroup == null) return null;
  const norm = normalizeExerciseName(rawGroup);
  if (!norm) return null;
  if (VALID.has(norm)) return norm as MuscleGroup;
  if (GROUP_ALIASES[norm]) return GROUP_ALIASES[norm];
  return null;
}

// ---- classification KB ------------------------------------------------------
// Ordered [group, matchers]. FIRST match wins, so list more-specific patterns
// before general ones (e.g. "rear delt"/"face pull" before generic shoulder/row;
// "leg curl" before "curl"; "leg extension" before "extension"). Matchers run
// against the normalized name (spaces between words). Conservative on purpose —
// returns null when nothing matches, and the caller leaves the group unset.
const CLASSIFY_RULES: Array<[MuscleGroup, RegExp[]]> = [
  // --- mobility / activation (non-counting) — match before anything loaded ---
  ["mobility", [/\b90 90\b/, /hip switch/, /\bstretch/, /mobility/, /cat cow/, /\bcars\b/, /world s greatest/, /\bopener\b/, /\bdrill\b/, /thoracic rotation/, /\bfoam roll/]],
  // --- core / trunk ---
  ["core", [/\bplank/, /\bcrunch/, /\bsit up/, /\bab\b/, /\babs\b/, /\bab /, /dead bug/, /hollow/, /\bpallof/, /\bl sit/, /hanging (leg|knee) raise/, /leg raise/, /knee raise/, /russian twist/, /\bwoodchop/, /\bcable rotation/, /\boblique/, /\bbird dog/, /\bbicycle\b/, /toe touch/, /\bv up/, /\brollout/, /ab wheel/, /\bsuitcase/]],
  // --- forearms / grip / carries ---
  ["forearms", [/dead hang/, /\bhang\b/, /farmer/, /\bcarry\b/, /\bcarries\b/, /grip/, /wrist (curl|roller|extension)/, /\bplate pinch/, /\bgripper/, /finger/]],
  // --- calves (before generic legs) ---
  ["calves", [/calf/, /\bcalves/, /\btib(ialis)?\b/, /\btoe raise/, /seated calf/, /standing calf/]],
  // --- hamstrings / hinge / posterior ---
  ["hamstrings", [/leg curl/, /lying curl/, /seated curl/, /\bham(string)?\b/, /\brdl\b/, /romanian/, /stiff leg/, /stiff legged/, /good morning/, /nordic/, /\bdeadlift/, /\bglute ham/, /\bghr\b/]],
  // --- glutes ---
  ["glutes", [/hip thrust/, /glute bridge/, /\bbridge\b/, /\bglute/, /\bkickback/, /abduction/, /\bbird dog\b/]],
  // --- quads / knee-dominant ---
  ["quads", [/squat/, /leg press/, /leg extension/, /\blunge/, /split squat/, /\bstep up/, /\bhack\b/, /\bsissy/, /\bwall sit/, /\bquad/, /goblet/, /pistol/]],
  // --- rear delts (before shoulders + back) ---
  ["rear delts", [/face pull/, /rear delt/, /reverse (fly|pec|flye)/, /rear fly/, /\bband pull apart/, /\bypt\b/, /\bprone y\b/, /\bprone t\b/]],
  // --- shoulders / vertical & lateral pressing ---
  ["shoulders", [/overhead press/, /\bohp\b/, /shoulder press/, /military press/, /\barnold/, /lateral raise/, /side raise/, /front raise/, /\bdelt/, /\bshoulder\b/, /\bpike push/, /upright row/, /\bshrug/]],
  // --- chest / horizontal pressing ---
  ["chest", [/bench press/, /\bbench\b/, /incline (db|dumbbell|barbell|press|bench)/, /decline (press|bench)/, /chest press/, /chest fly/, /\bpec(toral)? (fly|deck)/, /\bpec deck/, /\bdip\b/, /\bpush up/, /\bpushup/, /\bcable (fly|crossover)/, /\bflye?\b/, /\bchest\b/]],
  // --- triceps (before generic press/pushdown) ---
  ["triceps", [/triceps/, /\btricep/, /pushdown/, /push down/, /skull crusher/, /\bskullcrusher/, /overhead extension/, /\bkickback/, /close grip bench/, /\bcgbp\b/, /jm press/]],
  // --- back / horizontal & vertical pulling ---
  ["back", [/pull up/, /pullup/, /chin up/, /chinup/, /pulldown/, /pull down/, /\blat\b/, /\blats\b/, /\brow\b/, /seated row/, /cable row/, /bent over row/, /\bt bar/, /\bpullover/, /\bback extension/, /hyperextension/, /\bpull/, /\bback\b/]],
  // --- biceps ---
  ["biceps", [/\bcurl\b/, /\bcurls\b/, /\bbicep/, /\bchin\b/, /\bpreacher/, /\bhammer/, /\bconcentration curl/, /\bspider curl/, /\bez bar curl/]],
];

// Classify an exercise NAME → a canonical primary group, or null when unknown.
export function classifyMuscleGroup(name: string): MuscleGroup | null {
  const norm = normalizeExerciseName(name);
  if (!norm) return null;
  for (const [group, regexes] of CLASSIFY_RULES) {
    for (const re of regexes) if (re.test(norm)) return group;
  }
  return null;
}

// Resolve the best group for an exercise given its raw name AND any stored group:
// a stored (canonicalized) group wins; else classify by name. Used by reconcile.
export function resolveGroup(name: string, storedGroup: string | null | undefined): MuscleGroup | null {
  return canonicalGroup(storedGroup ?? null) ?? classifyMuscleGroup(name);
}

// ---- exercise_aliases (the persisted dedup decisions) -----------------------
// Mirrors marker_aliases. Defensive: never throws if the table isn't present yet
// (it's created in db.ts as CREATE TABLE IF NOT EXISTS on boot).
export function getExerciseAlias(alias: string): { canonical: string } | null {
  try {
    const r = db.prepare("SELECT canonical FROM exercise_aliases WHERE alias = ?").get(normalizeExerciseName(alias)) as any;
    return r ? { canonical: r.canonical } : null;
  } catch {
    return null;
  }
}

export function setExerciseAlias(alias: string, canonical: string, source = "agent"): void {
  const a = normalizeExerciseName(alias);
  const c = String(canonical ?? "").replace(/\s+/g, " ").trim();
  if (!a || !c) return;
  try {
    db.prepare(
      `INSERT INTO exercise_aliases (alias, canonical, source) VALUES (?, ?, ?)
       ON CONFLICT(alias) DO UPDATE SET canonical = excluded.canonical, source = excluded.source`
    ).run(a, c, source);
  } catch {
    /* table not present yet — no-op */
  }
}

export function listExerciseAliases(): Array<{ alias: string; canonical: string; source: string }> {
  try {
    return db.prepare("SELECT alias, canonical, source FROM exercise_aliases ORDER BY canonical, alias").all() as any[];
  } catch {
    return [];
  }
}

// PURE merge planner: cluster the given exercise names by normalizedExerciseKey and,
// for any cluster with ≥2 distinct names, propose merging the others INTO the
// "primary" (the name with the most logged sets when counts are provided, else the
// shortest/cleanest name). No DB writes — the write lives in repo.mergeExercises.
// When `names` is omitted, reads the current distinct exercise names from the DB.
export function planExerciseMerges(
  names?: Array<{ name: string; sets?: number }>
): Array<{ from: string; into: string; reason: string }> {
  let rows: Array<{ name: string; sets: number }>;
  if (names && names.length) {
    rows = names.map((n) => ({ name: String(n.name ?? "").trim(), sets: Number(n.sets) || 0 })).filter((n) => n.name);
  } else {
    try {
      rows = (
        db
          .prepare(
            `SELECT e.name AS name, COUNT(ls.id) AS sets
               FROM exercises e LEFT JOIN logged_sets ls ON ls.exercise_id = e.id
              GROUP BY e.id`
          )
          .all() as any[]
      ).map((r) => ({ name: String(r.name), sets: Number(r.sets) || 0 }));
    } catch {
      rows = [];
    }
  }
  const clusters = new Map<string, Array<{ name: string; sets: number }>>();
  for (const r of rows) {
    const key = normalizedExerciseKey(r.name);
    if (!key) continue;
    (clusters.get(key) ?? clusters.set(key, []).get(key)!).push(r);
  }
  const out: Array<{ from: string; into: string; reason: string }> = [];
  for (const [, members] of clusters) {
    const distinct = [...new Map(members.map((m) => [m.name, m])).values()];
    if (distinct.length < 2) continue;
    // primary = most logged sets, tie-break shortest name (the cleaner label).
    distinct.sort((a, b) => b.sets - a.sets || a.name.length - b.name.length);
    const into = distinct[0].name;
    for (const m of distinct.slice(1)) {
      out.push({ from: m.name, into, reason: "same movement logged under two names" });
    }
  }
  return out;
}
