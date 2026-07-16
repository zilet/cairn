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
import { createAliasStore } from "./canon-aliases.js";

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

// Fold a simple English plural to its singular for KEYING only (never for display).
// Strip a single trailing "s" only when the token is long enough to be a real word
// (>3 chars) and doesn't already end in "ss" — so "extensions" → "extension",
// "pulldowns" → "pulldown", "raises" → "raise", "curls" → "curl", "triceps" →
// "tricep", while "press"/"abs" (ss / too short) stay intact. Conservative: it only
// ever removes ONE trailing "s", so it can't collapse two genuinely different words.
function foldPluralToken(t: string): string {
  return t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t;
}

// The MERGE key for duplicate detection. CONSERVATIVE: we only drop tokens that do
// NOT distinguish a movement — "timed" (a mode, not a different lift) and a trailing
// "machine"/"-machine" qualifier when it's just describing the same station — and we
// singularize each token (a plural is the same movement: "Leg Extensions" ≡ "Leg
// Extension"). We do NOT strip implement words (barbell vs dumbbell ARE different
// lifts), so the key stays tight. "Dead hang" / "Dead hang timed" → "dead hang".
const NON_DISTINGUISHING = new Set(["timed"]);
export function normalizedExerciseKey(name: string): string {
  const tokens = normalizeExerciseName(name).split(" ").filter(Boolean);
  const kept = tokens.filter((t) => !NON_DISTINGUISHING.has(t)).map(foldPluralToken);
  return (kept.length ? kept : tokens.map(foldPluralToken)).join(" ");
}

// The SWAP-SLOT key: additionally strips implement/equipment tokens so a lift and its
// re-implemented sibling ("Barbell Bench Press" ↔ "DB Bench Press") resolve to the
// same PLAN SLOT — the plan often names one implement while the athlete logs another,
// and a rotate-in must still find where that movement lives. Deliberately looser than
// normalizedExerciseKey and used ONLY for swap-target resolution, never for
// dedup/merges (barbell vs dumbbell stay distinct lifts everywhere else).
const IMPLEMENT_TOKENS = new Set([
  "barbell", "bb", "dumbbell", "dumbbells", "db", "kettlebell", "kb",
  "machine", "smith", "cable", "ez", "trap", "hex", "bar", "landmine", "band", "banded",
]);
export function movementKey(name: string): string {
  const tokens = normalizeExerciseName(name).split(" ").filter(Boolean);
  const kept = tokens.filter((t) => !IMPLEMENT_TOKENS.has(t) && !NON_DISTINGUISHING.has(t));
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
  // --- calves + anterior tibialis (before generic legs) ---
  ["calves", [/calf/, /\bcalves/, /\btib(ialis)?\b/, /\btib raise/, /dorsiflex/, /\btoe raise/, /seated calf/, /standing calf/]],
  // --- hamstrings / hinge / posterior ---
  ["hamstrings", [/leg curl/, /lying curl/, /seated curl/, /\bham(string)?\b/, /\brdl\b/, /romanian/, /stiff leg/, /stiff legged/, /good morning/, /nordic/, /\bdeadlift/, /\bglute ham/, /\bghr\b/]],
  // --- glutes (incl. hip abduction) ---
  ["glutes", [/hip thrust/, /glute bridge/, /\bbridge\b/, /\bglute/, /\bkickback/, /abduction/, /abductor/, /lateral (band )?walk/, /monster walk/, /clamshell/, /\bbird dog\b/]],
  // --- quads / knee-dominant ---
  ["quads", [/squat/, /leg press/, /leg extension/, /\blunge/, /split squat/, /\bstep up/, /\bhack\b/, /\bsissy/, /\bwall sit/, /\bquad/, /goblet/, /pistol/]],
  // --- rear delts (before shoulders + back) ---
  ["rear delts", [/face pull/, /rear delt/, /reverse (fly|pec|flye|delt)/, /rear (fly|flye|raise)/, /\bband pull apart/, /\bypt\b/, /\bprone y\b/, /\bprone t\b/]],
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

// A HIGH-PRECISION subset of the classifier: it returns a group ONLY for names whose
// PRIMARY MOVER is unambiguous, so it's safe to OVERRIDE a clearly-wrong stored group
// (the corruption case: a "Wide-Grip Pulldown" imported as muscle_group "forearms").
// It deliberately EXCLUDES the contested single-token matches a program legitimately
// files differently (a bare "curl"/"press"/"fly", "dip", "pullover", or a plain
// "deadlift" some file under back) — those stay the agent's / the user's call. Returns
// null when the name isn't unambiguous, so the caller leaves the stored group alone.
const AUTHORITATIVE_GROUP_RULES: Array<[MuscleGroup, RegExp[]]> = [
  ["core", [/\bplank/, /\bcrunch/, /\bsit up/, /dead bug/, /hanging (leg|knee) raise/, /ab wheel/, /\bpallof/]],
  ["forearms", [/dead hang/, /farmer.*(carry|carries|walk)/, /wrist (curl|roller|extension)/]],
  ["calves", [/calf raise/, /calf press/]],
  ["hamstrings", [/leg curl/, /lying (leg )?curl/, /seated (leg )?curl/, /romanian deadlift/, /\brdl\b/, /good morning/]],
  ["glutes", [/hip thrust/, /glute bridge/]],
  ["quads", [/\bsquat\b/, /leg press/, /leg extension/, /hack squat/, /split squat/]],
  ["back", [/pulldown/, /pull down/, /pull up/, /pullup/, /chin up/, /chinup/, /lat pulldown/]],
  ["chest", [/bench press/, /chest press/]],
  ["shoulders", [/overhead press/, /\bohp\b/, /shoulder press/, /military press/, /lateral raise/]],
];
export function authoritativeGroup(name: string): MuscleGroup | null {
  const norm = normalizeExerciseName(name);
  if (!norm) return null;
  for (const [group, regexes] of AUTHORITATIVE_GROUP_RULES) {
    for (const re of regexes) if (re.test(norm)) return group;
  }
  return null;
}

// ---- exercise_aliases (the persisted dedup decisions) -----------------------
// Mirrors marker_aliases on the shared canon-alias store. Defensive (guarded): never
// throws if the table isn't present yet (it's created in db.ts as CREATE TABLE IF NOT
// EXISTS on boot).
const aliasStore = createAliasStore({
  table: "exercise_aliases",
  keyColumn: "alias",
  valueColumns: ["canonical"],
  listOrderBy: "canonical, alias",
  guarded: true,
});

export function getExerciseAlias(alias: string): { canonical: string } | null {
  return aliasStore.get(normalizeExerciseName(alias)) as { canonical: string } | null;
}

export function setExerciseAlias(alias: string, canonical: string, source = "agent"): void {
  const a = normalizeExerciseName(alias);
  const c = String(canonical ?? "").replace(/\s+/g, " ").trim();
  if (!a || !c) return;
  aliasStore.set(a, [c], source);
}

export function listExerciseAliases(): Array<{ alias: string; canonical: string; source: string }> {
  return aliasStore.list();
}

// ---- agentic exercise understanding (messy input → canonical name + profile) -
// When a user types a descriptive/messy exercise title ("incline db bench 3x10 lol")
// it must normalize to a clean, reusable display name AND profile its muscle group +
// mode, so the next time a variant of the same input arrives it self-aligns. Mirrors
// the marker-canon flow (a deterministic FLOOR + a PURE validator for the agentic
// reconciliation). Constitution: no scores; this only ever cleans a label and
// resolves a canonical GROUP.

// Known acronyms / implement abbreviations that should NOT be Title-Cased into
// "Db"/"Bb". Keyed by normalized (lowercase) token → the canonical casing.
const ACRONYM_CASING: Record<string, string> = {
  db: "DB",
  bb: "BB",
  kb: "KB",
  rdl: "RDL",
  ohp: "OHP",
  cgbp: "CGBP",
  ez: "EZ",
  ghr: "GHR",
  ghd: "GHD",
  jm: "JM",
  ttb: "TTB",
  bw: "BW",
  amrap: "AMRAP",
};

// Filler / noise tokens to strip from a messy title before cleaning.
const FILLER_TOKENS = new Set([
  "lol",
  "thingy",
  "thing",
  "ish",
  "heavyish",
  "lightish",
  "easyish",
  "hardish",
  "kinda",
  "sorta",
  "idk",
  "today",
  "again",
  "stuff",
]);

// Trailing set/rep/load notation to strip: "3x10", "3×10", "x12", "@ 55",
// "for time", "for reps", "amrap", a bare trailing "@55". CONSERVATIVE — only
// strips at the END of the string, so an in-name token is left alone.
function stripSetRepNotation(s: string): string {
  let out = s;
  // Run a few passes so chained trailing notation ("3x10 @ 55") all comes off.
  for (let i = 0; i < 4; i++) {
    const before = out;
    out = out
      .replace(/\s+for\s+(time|reps|distance)\s*$/i, "")
      .replace(/\s+amrap\s*$/i, "")
      // sets x reps:  3x10, 3 x 10, 4×8, 5x5
      .replace(/\s+\d+\s*[x×]\s*\d+\s*$/i, "")
      // bare rep count with x:  x12, ×8
      .replace(/\s+[x×]\s*\d+\s*$/i, "")
      // load:  @ 55, @55, @ 55lb, @135 lbs
      .replace(/\s+@\s*\d+(\.\d+)?\s*(lb|lbs|kg|kgs)?\s*$/i, "")
      // a trailing bare set count:  "3 sets", "for 3 sets"
      .replace(/\s+(for\s+)?\d+\s*sets?\s*$/i, "")
      .trim();
    if (out === before) break;
  }
  return out;
}

// Strip emoji and other symbol pictographs (kept ASCII-conservative — we already
// fold to spaces via normalizeExerciseName for matching, but cleanExerciseName
// preserves casing so it does its own light scrub).
function stripEmoji(s: string): string {
  // Remove anything outside the basic printable Latin/symbol range we care about.
  // This drops emoji + pictographs without touching letters, digits, common punctuation.
  return s
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, "")
    // Variation selector (FE0F) + zero-width joiner (200D) stripped separately — a
    // combining/format char inside the range class above trips a lint rule.
    .replace(/\u{FE0F}/gu, "")
    .replace(/\u{200D}/gu, "");
}

// Produce a clean, reusable canonical DISPLAY name from a messy raw title.
// Never returns empty — falls back to a trimmed version of the raw input.
export function cleanExerciseName(raw: string): string {
  const original = String(raw ?? "");
  let s = stripEmoji(original).replace(/\s+/g, " ").trim();
  s = stripSetRepNotation(s);
  // Drop filler tokens (case-insensitive). NB: we do NOT blanket-strip a trailing
  // "ish" — that mangled real movements ("Finish"/"Spanish"/"Swish"); the few
  // intensity-ish words ("heavyish") are listed in FILLER_TOKENS instead.
  const tokens = s
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !FILLER_TOKENS.has(t.toLowerCase()))
    .filter(Boolean);
  // CONSERVATIVE: if the title (after stripping notation/filler) is ALREADY
  // well-cased — it has both upper- and lower-case letters and no snake_case — it
  // was named deliberately ("Barbell Bench Press", "ZTest Knee Ext", "DB Press").
  // Preserve it verbatim; only re-case the genuinely-messy forms (all-lowercase,
  // ALL-CAPS, snake_case). The point is to tidy messy input, never mangle clean names.
  const joined = tokens.join(" ").trim();
  if (joined && /[a-z]/.test(joined) && /[A-Z]/.test(joined) && !/_/.test(joined)) {
    return joined.length > 80 ? joined.slice(0, 80).trim() : joined;
  }
  // Title-Case each word, but keep known acronyms/implements sensible.
  const cased = tokens.map((t) => {
    const lower = t.toLowerCase();
    if (ACRONYM_CASING[lower]) return ACRONYM_CASING[lower];
    // hyphenated word: case each segment ("t-bar" → "T-Bar")
    if (t.includes("-")) {
      return t
        .split("-")
        .map((seg) => {
          const segLower = seg.toLowerCase();
          if (ACRONYM_CASING[segLower]) return ACRONYM_CASING[segLower];
          return seg ? seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase() : seg;
        })
        .join("-");
    }
    return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  });
  let clean = cased.join(" ").trim();
  if (clean.length > 80) clean = clean.slice(0, 80).trim();
  // Never empty — fall back to a trimmed raw (also length-capped, emoji-scrubbed).
  if (!clean) {
    clean = stripEmoji(original).replace(/\s+/g, " ").trim().slice(0, 80).trim();
  }
  return clean || original.trim().slice(0, 80);
}

// Movements whose name implies a HOLD / duration → log time, not reps.
const TIMED_PATTERNS: RegExp[] = [
  /\bplank/,
  /side plank/,
  /dead hang/,
  /\bhang\b/,
  /wall sit/,
  /hollow (hold|body)/,
  /\bl sit/,
  /\bl-sit/,
  /\bhold\b/,
  /isometric/,
  /farmer.*(carry|carries|walk)/,
  /\bcarry\b/,
  /\bcarries\b/,
  /loaded carry/,
  /for time/,
];

// Detect whether an exercise should be logged as a timed hold or as reps.
export function detectExerciseMode(name: string): "reps" | "timed" {
  const norm = normalizeExerciseName(name);
  if (!norm) return "reps";
  for (const re of TIMED_PATTERNS) if (re.test(norm)) return "timed";
  return "reps";
}

// PURE validator of an agent's exercise reconciliation — mirrors planMarkerMerges /
// planExerciseMerges so the safety guards are unit-testable without an agent and no
// DB write is implied here. Each group folds 1+ messy/variant inputs onto ONE clean
// canonical. Guards, in order:
//   - every member must be a VERBATIM input name (matched by normalized name);
//   - the canonical must be a real member OR a cleanExerciseName of one;
//   - a group is accepted when it folds ≥2 variants onto one canonical OR cleans a
//     single messy member (canonical ≠ member's raw display);
//   - resolve group via canonicalGroup(g.group) ?? classifyMuscleGroup(canonical);
//   - resolve mode via (g.mode==='timed' ? 'timed' : detectExerciseMode(canonical)).
// Returns one alias row per NON-canonical member ({rawNorm → canonical}); a member
// whose norm equals the canonical's norm is skipped (no self-alias). Conservative:
// groups with no valid members are dropped.
export function planExerciseAliases(
  items: Array<{ name: string }>,
  groups: Array<{ members: string[]; canonical: string; group?: string | null; mode?: string | null }>
): Array<{ rawNorm: string; canonical: string; group: MuscleGroup | null; mode: "reps" | "timed" }> {
  const validItems = Array.isArray(items) ? items.filter((i) => i && String(i.name ?? "").trim()) : [];
  // normalized name → the verbatim display name the user actually used.
  const byNorm = new Map<string, string>();
  for (const i of validItems) {
    const display = String(i.name).replace(/\s+/g, " ").trim();
    const norm = normalizeExerciseName(display);
    if (norm && !byNorm.has(norm)) byNorm.set(norm, display);
  }

  const out: Array<{ rawNorm: string; canonical: string; group: MuscleGroup | null; mode: "reps" | "timed" }> = [];
  const seen = new Set<string>(); // dedupe rawNorm across groups (first valid wins)

  for (const g of Array.isArray(groups) ? groups : []) {
    const rawMembers: string[] = Array.isArray((g as any)?.members)
      ? (g as any).members.map((x: any) => String(x ?? "").replace(/\s+/g, " ").trim()).filter(Boolean)
      : [];
    // Keep only members that are VERBATIM inputs (by normalized match).
    const members: string[] = rawMembers
      .map((m) => byNorm.get(normalizeExerciseName(m)))
      .filter((m): m is string => !!m);
    // Dedupe member displays.
    const distinctMembers: string[] = [...new Set(members)];
    if (distinctMembers.length === 0) continue;

    // Resolve the canonical: prefer the agent's canonical when it's a real member or
    // a clean version of one; else clean the first member.
    const rawCanonical = String((g as any)?.canonical ?? "").replace(/\s+/g, " ").trim();
    const rawCanonNorm = normalizeExerciseName(rawCanonical);
    let canonical: string;
    if (rawCanonNorm && byNorm.has(rawCanonNorm)) {
      // canonical names an actual member verbatim — clean it for display.
      canonical = cleanExerciseName(byNorm.get(rawCanonNorm)!);
    } else if (rawCanonical && distinctMembers.some((m) => normalizeExerciseName(cleanExerciseName(m)) === rawCanonNorm)) {
      // canonical equals the cleaned form of a member — accept it.
      canonical = rawCanonical;
    } else if (rawCanonical) {
      // canonical is foreign to the members — reject (be conservative), fall back to
      // cleaning the first member instead.
      canonical = cleanExerciseName(distinctMembers[0]);
    } else {
      canonical = cleanExerciseName(distinctMembers[0]);
    }
    if (!canonical) continue;
    const canonNorm = normalizeExerciseName(canonical);

    // Accept only a REAL fold: ≥2 variants, OR a single messy member being cleaned
    // (its raw differs from the canonical).
    const nonCanonMembers = distinctMembers.filter((m) => normalizeExerciseName(m) !== canonNorm);
    if (nonCanonMembers.length === 0) continue; // nothing to alias (all already canonical)

    const group = canonicalGroup((g as any)?.group ?? null) ?? classifyMuscleGroup(canonical);
    const mode: "reps" | "timed" = (g as any)?.mode === "timed" ? "timed" : detectExerciseMode(canonical);

    for (const m of nonCanonMembers) {
      const rawNorm = normalizeExerciseName(m);
      if (!rawNorm || rawNorm === canonNorm || seen.has(rawNorm)) continue;
      seen.add(rawNorm);
      out.push({ rawNorm, canonical, group, mode });
    }
  }
  return out;
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

// Tokens that mark a genuinely DIFFERENT exercise even when the rest of the name
// matches: a qualifier one side carries and the other lacks means they are NOT the
// same lift (incline vs flat bench, sumo vs conventional, seated vs standing calf
// raise, single-arm vs two-arm). "assisted" is checked separately — it also inverts
// the load direction, so it's an even harder stop.
const VARIATION_TOKENS = new Set([
  "incline", "decline", "pause", "paused", "deficit", "sumo", "seated", "standing",
  "single", "close", "wide", "narrow", "reverse", "kneeling", "staggered", "tempo",
  "pin", "snatch",
]);

function exerciseTokens(name: string): Set<string> {
  return new Set(normalizeExerciseName(name).split(" ").filter(Boolean));
}
function isTokenSubset(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

export interface MergeCandidate {
  name: string;
  group?: string | null;
  mode?: string | null;
  days?: number; // distinct logged days — the "how well-trained" signal
}

// Which relation let a merge PASS, from strongest to weakest structural evidence:
//   - "same-key"   — the two names normalize to the same movement key (a pure
//                    naming/plural variant: "Leg Extensions" ≡ "Leg Extension");
//   - "subset"     — one name's tokens are a subset of the other's (a rename with an
//                    added qualifier we've already cleared: "Squat" ⊂ "Back Squat");
//   - "group-only" — they merely share a resolved muscle group (weakest — it admits
//                    genuinely different movements like Pendlay Row vs Bent-Over Row).
// The auto-apply gate (shouldAutoApplyMerge) only trusts the two STRUCTURAL relations.
export type MergeRelation = "same-key" | "subset" | "group-only";
export interface MergeVerdict {
  ok: boolean;
  relation?: MergeRelation;
  reason?: string;
}

// PURE validator of a proposed "merge `from` INTO `into`". No DB access, so the safety
// guards are unit-testable without a fixture. Mirrors planMarkerMerges' role: an
// over-merge (folding two different movements into one) is the only real harm, so
// every guard is conservative. Guards, in order (all must pass):
//   - both named, and not the same exercise;
//   - modes compatible (never fold a timed hold with a rep-counted lift);
//   - no "assisted" asymmetry (assisted pull-up ≠ pull-up);
//   - no variation token one side carries and the other lacks (incline ≠ flat);
//   - not two independently well-trained lifts (both ≥8 logged days) UNLESS they
//     already key identically (a pure naming/plural variant);
//   - resolved muscle groups agree, OR one name's tokens ⊂ the other's, OR same key.
// On acceptance it reports WHICH relation justified the pass (see MergeRelation) so the
// caller can gate irreversible auto-application on a structural relation.
export function validateExerciseMergePlan(from: MergeCandidate, into: MergeCandidate): MergeVerdict {
  const fromName = String(from?.name ?? "").trim();
  const intoName = String(into?.name ?? "").trim();
  const fromNorm = normalizeExerciseName(fromName);
  const intoNorm = normalizeExerciseName(intoName);
  if (!fromNorm || !intoNorm) return { ok: false, reason: "both exercises must be named" };
  if (fromNorm === intoNorm) return { ok: false, reason: "from and into are the same exercise" };

  const fromMode = from.mode === "timed" ? "timed" : detectExerciseMode(fromName);
  const intoMode = into.mode === "timed" ? "timed" : detectExerciseMode(intoName);
  if (fromMode !== intoMode) return { ok: false, reason: "different logging mode (timed vs reps)" };

  const fromTokens = exerciseTokens(fromName);
  const intoTokens = exerciseTokens(intoName);

  if (fromTokens.has("assisted") !== intoTokens.has("assisted")) {
    return { ok: false, reason: "one side is assisted and the other is not" };
  }
  for (const t of VARIATION_TOKENS) {
    if (fromTokens.has(t) !== intoTokens.has(t)) {
      return { ok: false, reason: `variation mismatch on "${t}"` };
    }
  }

  const sameKey = normalizedExerciseKey(fromName) === normalizedExerciseKey(intoName);
  if (!sameKey && Number(from.days ?? 0) >= 8 && Number(into.days ?? 0) >= 8) {
    return { ok: false, reason: "both lifts have substantial independent history" };
  }

  const fromGroup = canonicalGroup(from.group ?? null) ?? classifyMuscleGroup(fromName);
  const intoGroup = canonicalGroup(into.group ?? null) ?? classifyMuscleGroup(intoName);
  const groupsAgree = !!fromGroup && !!intoGroup && fromGroup === intoGroup;
  const subset = isTokenSubset(fromTokens, intoTokens) || isTokenSubset(intoTokens, fromTokens);
  if (!(groupsAgree || subset || sameKey)) {
    return { ok: false, reason: "different muscle groups" };
  }
  const relation: MergeRelation = sameKey ? "same-key" : subset ? "subset" : "group-only";
  return { ok: true, relation };
}

// The auto-apply gate for an AGENT-proposed merge: apply automatically ONLY when the
// agent is confident AND the pair is structurally related (same key or token subset).
// A "group-only" pass (they just share a muscle group) is demoted to a suggestion no
// matter the confidence — that branch admits distinct movements, and a merge can't be
// undone, so it deserves one-tap human confirmation instead of silent application.
export function shouldAutoApplyMerge(verdict: MergeVerdict, confidence: string): boolean {
  return verdict.ok === true && confidence === "high" && verdict.relation !== "group-only";
}

// ---------- constraint taxonomy (grip/form ≠ load) ---------------------------
// An exercise's `constraint_note` (from an injury or a coach cue) used to be a
// single boolean that FROZE load progression for ANY note — so a GRIP cue ("neutral
// grip only, no supinated curls", cubital tunnel) stranded a lift the athlete was
// crushing at a heavy working weight. A real coach distinguishes:
//   - "load"  → the note LIMITS load (pain/strain under load, "keep it light", "no
//               heavy", "reduce the weight"). Load must be held/capped — safety.
//   - "form"  → a technique/grip/range/equipment cue the athlete WORKS AROUND while
//               still earning load (neutral grip, no supination, partial ROM, tempo,
//               cable/machine only). Load may progress normally; the cue stays visible.
//   - "none"  → no constraint.
// Conservative on purpose: a note with ANY pain/load language — or one with no clear
// form cue at all — is treated as "load" (cap), so a genuine injury note is never
// wrongly un-capped. Only a clear form/grip/ROM cue WITHOUT load language frees load.
export type ConstraintKind = "load" | "form" | "none";

const CONSTRAINT_FORM_RE =
  /\b(grip|supinat|pronat|neutral|underhand|overhand|hammer|tempo|slow|pause|partial|range of motion|\brom\b|form|technique|stance|posture|alignment|cable|machine|smith|specific bar|ez[- ]?bar|footing|angle)\b/i;
const CONSTRAINT_LOAD_RE =
  /\b(no heav|keep (it )?light|lighten|reduce (the )?(load|weight)|cap (the )?(load|weight)|don'?t add|do not add|avoid load|unload|too heavy|pain|hurts?|sharp|flare|aggravat|tendin|strain|sprain|tweak|sore|ache|injur|impinge|herniat|limit (the )?(load|weight)|go easy|ease off)\b/i;

export function classifyConstraint(note?: string | null): ConstraintKind {
  const s = String(note ?? "").trim();
  if (!s) return "none";
  const load = CONSTRAINT_LOAD_RE.test(s);
  const form = CONSTRAINT_FORM_RE.test(s);
  // A clear form/grip/ROM cue with NO load/pain language → manage technically, keep
  // progressing load. Anything else (pain/load language, or ambiguous) → cap (safe).
  if (form && !load) return "form";
  return "load";
}

// True when the constraint should HOLD/cap load (a load-limiting note). A form/grip
// cue returns false — load progresses while the cue is respected technically.
export function constraintLimitsLoad(note?: string | null): boolean {
  return classifyConstraint(note) === "load";
}
