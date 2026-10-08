// The starter picture pack: pre-baked clay figurines for the most common
// exercises, plus one generic figure per movement pattern, shipped in the repo
// (`seed-art/starter/`) so a fresh install with NO Gemini key still shows real
// exercise pictures. Built (rarely, by a maintainer) with
// `npm run starter:art:build` (src/buildStarterArt.ts) through the SAME prompt
// path the runtime uses for exercise art, so a pack figure and a later bespoke
// figure read as one set.
//
// Two layers, two different laws:
//   • a PACK FIGURE stands for one exercise. It is matched as timidly as the
//     exercise-guide matcher: the query's abbreviation-expanded key, the stored
//     name it resolves to, or an explicit `exercise_aliases` link — never a
//     "similar" movement. Every candidate must land on ONE entry; two entries is
//     ambiguous and answers nothing. A hit is installed into data/art/ as a real
//     asset (src/art.ts `installStarterFigure`) and never costs a generation.
//   • a GENERIC FIGURE stands for a movement pattern ("a squat", "a horizontal
//     pull"). It is only ever a visible stand-in, served from its own URL
//     (`GET /api/art/generic`), so it can never be cached as that exercise's
//     real picture — when a real figure lands, it simply paints over it.
//
// Everything here degrades to absence: no pack dir, an empty pack (the committed
// state until the maintainer runs the build), or a missing image file all read
// as "no starter figure", and the runtime behaves exactly as it did before.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  canonicalGroup,
  classifyMuscleGroup,
  expandedExerciseKey,
  getExerciseAlias,
  listExerciseAliases,
  normalizeExerciseName,
  resolveExerciseName,
} from "./repo/exercise-canon.js";
import { classifyPattern, type MovementPattern } from "./repo/exercise-variations.js";
import { findExercise } from "./repo/exercises.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Overridable so the test harness never meets the real (eventually populated) pack.
export const STARTER_ART_DIR = process.env.CAIRN_STARTER_ART_DIR || path.join(__dirname, "..", "seed-art", "starter");

/** The generic movement-pattern figures, in a stable order. */
export const STARTER_PATTERNS = [
  "squat",
  "hinge",
  "lunge",
  "horizontal_push",
  "vertical_push",
  "horizontal_pull",
  "vertical_pull",
  "arms",
  "shoulder_raise",
  "calf",
  "core",
  "carry",
  "mobility",
  "run",
  "ride",
  "general",
] as const;
export type StarterPattern = (typeof STARTER_PATTERNS)[number];

export function isStarterPattern(value: unknown): value is StarterPattern {
  return typeof value === "string" && (STARTER_PATTERNS as readonly string[]).includes(value);
}

export interface StarterExercise {
  name: string;
  aliases?: string[];
  pattern: StarterPattern;
  equipment: string;
  muscle_group: string;
  pose: string;
}

export interface StarterPatternFigure {
  id: StarterPattern;
  /** The prompt subject ("a bodyweight squat"), drawn through the exercise prompt. */
  subject: string;
  pose: string;
}

interface StarterPack {
  exercises: StarterExercise[];
  patterns: StarterPatternFigure[];
  /** expandedExerciseKey(name or alias) → entry index; a key two entries claim maps to -1. */
  byKey: Map<string, number>;
}

/** The pack's on-disk slug for an exercise: its abbreviation-expanded key, hyphenated. */
export function starterSlug(name: string): string {
  return expandedExerciseKey(name).replace(/ /g, "-");
}

export function starterExerciseFile(entry: Pick<StarterExercise, "name">, dir = STARTER_ART_DIR): string {
  return path.join(dir, "exercises", `${starterSlug(entry.name)}.jpg`);
}

export function starterPatternFile(pattern: StarterPattern, dir = STARTER_ART_DIR): string {
  return path.join(dir, "patterns", `${pattern}.jpg`);
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Parse + validate the pack lists. Pure over `dir`; malformed entries are dropped. */
export function readStarterPack(dir = STARTER_ART_DIR): StarterPack {
  const rawExercises = readJson(path.join(dir, "exercises.json"))?.exercises;
  const rawPatterns = readJson(path.join(dir, "patterns.json"))?.patterns;
  const exercises: StarterExercise[] = [];
  for (const row of Array.isArray(rawExercises) ? rawExercises : []) {
    const name = String(row?.name ?? "").trim();
    if (!name || !isStarterPattern(row?.pattern)) continue;
    exercises.push({
      name,
      aliases: Array.isArray(row?.aliases)
        ? row.aliases.map((a: unknown) => String(a ?? "").trim()).filter(Boolean)
        : [],
      pattern: row.pattern,
      equipment: String(row?.equipment ?? "").trim(),
      muscle_group: String(row?.muscle_group ?? "").trim(),
      pose: String(row?.pose ?? "").trim(),
    });
  }
  const patterns: StarterPatternFigure[] = [];
  for (const row of Array.isArray(rawPatterns) ? rawPatterns : []) {
    if (!isStarterPattern(row?.id)) continue;
    patterns.push({ id: row.id, subject: String(row?.subject ?? "").trim(), pose: String(row?.pose ?? "").trim() });
  }
  const byKey = new Map<string, number>();
  exercises.forEach((entry, index) => {
    for (const text of [entry.name, ...(entry.aliases ?? [])]) {
      const key = expandedExerciseKey(text);
      if (!key) continue;
      const prior = byKey.get(key);
      // A key two entries claim is ambiguous and stands for neither.
      byKey.set(key, prior === undefined || prior === index ? index : -1);
    }
  });
  return { exercises, patterns, byKey };
}

// The pack ships with the image and never changes under a running process, so it
// is read once. Tests swap the dir per process (CAIRN_STARTER_ART_DIR) and can drop
// the cache between cases.
let packCache: StarterPack | null = null;
const fileState = new Map<string, boolean>();
function pack(): StarterPack {
  if (!packCache) packCache = readStarterPack();
  return packCache;
}

/** Test seam: forget the parsed pack and the file-existence memo. */
export function resetStarterPackCache(): void {
  packCache = null;
  fileState.clear();
}

function fileExists(file: string): boolean {
  const known = fileState.get(file);
  if (known !== undefined) return known;
  let present = false;
  try {
    present = fs.statSync(file).isFile();
  } catch {
    present = false;
  }
  fileState.set(file, present);
  return present;
}

/**
 * Every text that names the SAME exercise as `query`, by the resolver's own
 * evidence: the query, the stored name it resolves to, and the explicit
 * `exercise_aliases` links in either direction. Never a looser key.
 */
function candidateTexts(query: string): string[] {
  const texts = new Set<string>();
  const q = String(query ?? "").trim();
  if (!q) return [];
  texts.add(q);
  try {
    const resolved = resolveExerciseName(q);
    if (resolved.exercise_id != null && resolved.canonical) texts.add(resolved.canonical);
  } catch {
    /* the resolver is a read; a miss is the ordinary state */
  }
  try {
    for (const text of [...texts]) {
      const canonical = getExerciseAlias(text)?.canonical;
      if (canonical) texts.add(String(canonical));
    }
    const norms = new Set([...texts].map((t) => normalizeExerciseName(t)));
    for (const row of listExerciseAliases()) {
      if (norms.has(normalizeExerciseName(row.canonical))) texts.add(row.alias);
    }
  } catch {
    /* no alias table yet — the name tiers above still answer */
  }
  return [...texts];
}

export interface StarterFigureHit {
  entry: StarterExercise;
  file: string;
}

/**
 * The pack figure that depicts exactly this exercise, or null. Timid on purpose:
 * every candidate text must agree on ONE entry, and the entry's image must be on
 * disk. A query whose candidates reach two entries is ambiguous and answers null.
 */
export function starterFigureFor(query: string): StarterFigureHit | null {
  const p = pack();
  if (!p.exercises.length) return null;
  let hit = -1;
  for (const text of candidateTexts(query)) {
    const index = p.byKey.get(expandedExerciseKey(text));
    if (index === undefined) continue;
    if (index < 0) return null; // the pack itself is ambiguous on this key
    if (hit >= 0 && hit !== index) return null; // two entries — no coin flips
    hit = index;
  }
  if (hit < 0) return null;
  const entry = p.exercises[hit];
  const file = starterExerciseFile(entry);
  return fileExists(file) ? { entry, file } : null;
}

const contentKeys = new Map<string, string>();
/**
 * The art asset key a pack file installs under: a sha1 over the pack namespace,
 * the slug and the file's own bytes — so a rebuilt figure is a new asset, never
 * an overwrite of one a phone already cached.
 */
export function starterAssetKey(hit: StarterFigureHit): string {
  const known = contentKeys.get(hit.file);
  if (known) return known;
  const digest = crypto.createHash("sha1").update(fs.readFileSync(hit.file)).digest("hex").slice(0, 16);
  const key = crypto
    .createHash("sha1")
    .update(`exercise:starter:${starterSlug(hit.entry.name)}:${digest}`)
    .digest("hex");
  contentKeys.set(hit.file, key);
  return key;
}

// ---- generic movement-pattern figures ----

const PATTERN_FROM_FAMILY: Record<MovementPattern, StarterPattern> = {
  squat: "squat",
  hinge: "hinge",
  "hip-extension": "hinge",
  lunge: "lunge",
  "horizontal-push": "horizontal_push",
  "vertical-push": "vertical_push",
  "horizontal-pull": "horizontal_pull",
  "vertical-pull": "vertical_pull",
  calf: "calf",
  tibialis: "calf",
  core: "core",
  carry: "carry",
  shrug: "carry",
  curl: "arms",
  triceps: "arms",
  "lateral-raise": "shoulder_raise",
  "rear-delt": "shoulder_raise",
  abduction: "general",
  mobility: "mobility",
};

const PATTERN_FROM_GROUP: Record<string, StarterPattern> = {
  chest: "horizontal_push",
  shoulders: "vertical_push",
  "rear delts": "shoulder_raise",
  triceps: "arms",
  biceps: "arms",
  back: "horizontal_pull",
  forearms: "carry",
  quads: "squat",
  hamstrings: "hinge",
  glutes: "hinge",
  calves: "calf",
  core: "core",
  mobility: "mobility",
};

const RUN_RE = /\b(run|runs|running|jog|jogging|sprint|sprints|treadmill|strides?)\b/;
const RIDE_RE = /\b(bike|biking|cycle|cycling|ride|riding|spin|airdyne|assault bike|echo bike)\b/;
const CONDITIONING_RE =
  /\b(rower|rowing machine|erg|ski erg|sled|burpees?|jump rope|skipping|battle ropes?|box jumps?|jumping jacks?)\b/;

/**
 * Which generic figure stands in for an exercise: the stored row's group and
 * mode when there is one, the deterministic movement-family classifier, then
 * the muscle-group floor. Every input resolves — "general" is the last word.
 */
export function movementPatternFor(
  name: string,
  row?: { muscle_group?: string | null; mode?: string | null; equipment?: string | null } | null
): StarterPattern {
  const norm = normalizeExerciseName(name);
  if (RUN_RE.test(norm)) return "run";
  if (RIDE_RE.test(norm)) return "ride";
  if (CONDITIONING_RE.test(norm)) return "general";
  const group = canonicalGroup(row?.muscle_group ?? null) ?? classifyMuscleGroup(name);
  if (group === "mobility") return "mobility";
  const family = classifyPattern(name, group ?? undefined);
  if (family) return PATTERN_FROM_FAMILY[family] ?? "general";
  if (group && PATTERN_FROM_GROUP[group]) return PATTERN_FROM_GROUP[group];
  return "general";
}

/** The generic stand-in image for an exercise, or null when that figure is not built. */
export function genericFigureFor(name: string): { pattern: StarterPattern; file: string } | null {
  let row: any = null;
  try {
    row = findExercise(name) ?? null;
  } catch {
    row = null;
  }
  const pattern = movementPatternFor(name, row);
  const exact = starterPatternFile(pattern);
  if (fileExists(exact)) return { pattern, file: exact };
  const general = starterPatternFile("general");
  return pattern !== "general" && fileExists(general) ? { pattern: "general", file: general } : null;
}

/** How many pack figures are actually built on disk (Settings honesty, the builder's summary). */
export function starterPackCounts(): { exercises: number; built: number; patterns: number } {
  const p = pack();
  return {
    exercises: p.exercises.length,
    built: p.exercises.filter((entry) => fileExists(starterExerciseFile(entry))).length,
    patterns: STARTER_PATTERNS.filter((id) => fileExists(starterPatternFile(id))).length,
  };
}
