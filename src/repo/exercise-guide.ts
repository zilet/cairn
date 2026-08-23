// Exercise instruction guides — the optional "how to" layer behind a movement.
//
// SOURCE: free-exercise-db (https://github.com/yuhonas/free-exercise-db), released
// into the public domain under the Unlicense. 873 movements, each with ordered
// step-by-step instructions, primary/secondary muscles, equipment, difficulty and
// exactly two demonstration photos (a start and an end frame).
//
// Nothing here is committed to the repo and nothing is fetched until the athlete
// asks for it: the dataset lands under DATA_DIR/exercise-guides/ on import, and the
// photos are pulled lazily, one movement at a time, only for guides that actually
// matched something the athlete trains. Absence is the normal state — every read
// returns null/empty rather than throwing, so the app is whole without the guide.
//
// MATCHING is deliberately timid. The dataset carries 21 distinct "bench press"
// rows and 56 squats; picking one by feel would put a banded lateral raise's photos
// on a dumbbell lateral raise. So a guide is auto-linked ONLY on an unambiguous name
// match (see matchGuide below). Anything looser is stored as an unlinked candidate
// the athlete can confirm — never rendered as though it were the answer.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../db.js";
import { listExerciseAliases, movementKey, normalizeExerciseName, normalizedExerciseKey } from "./exercise-canon.js";
import { withSqliteSavepoint } from "./sqlite-savepoint.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "..", "data");

export const EXERCISE_GUIDES_DIR = path.join(DATA_DIR, "exercise-guides");
export const EXERCISE_GUIDE_DATASET_PATH = path.join(EXERCISE_GUIDES_DIR, "dataset.json");
export const EXERCISE_GUIDE_IMAGES_DIR = path.join(EXERCISE_GUIDES_DIR, "images");

export const EXERCISE_GUIDE_SOURCE = "free-exercise-db";
export const EXERCISE_GUIDE_LICENSE = "Unlicense (public domain)";
export const EXERCISE_GUIDE_REPO_URL = "https://github.com/yuhonas/free-exercise-db";
const RAW_BASE = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main";
export const EXERCISE_GUIDE_DATASET_URL = `${RAW_BASE}/dist/exercises.json`;

/** The upstream URL for one demonstration photo. Dataset images are always `<id>/<n>.jpg`. */
export function remoteGuideImageUrl(guideId: string, index: number): string {
  return `${RAW_BASE}/exercises/${encodeURIComponent(guideId)}/${index}.jpg`;
}

// A dataset id doubles as an on-disk folder name, so it is validated as a strict
// slug on the way in AND on the way out — a path segment from a downloaded file is
// never trusted to stay inside EXERCISE_GUIDE_IMAGES_DIR on its own good manners.
const GUIDE_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
export function isValidGuideId(guideId: unknown): boolean {
  return typeof guideId === "string" && GUIDE_ID_RE.test(guideId);
}

/** Local cache path for one demonstration photo, or null when the id/index is not addressable. */
export function localGuideImagePath(guideId: string, index: number): string | null {
  if (!isValidGuideId(guideId)) return null;
  if (!Number.isInteger(index) || index < 0 || index > 9) return null;
  return path.join(EXERCISE_GUIDE_IMAGES_DIR, guideId, `${index}.jpg`);
}

// ---- the dataset record -----------------------------------------------------

export interface ExerciseGuideRecord {
  id: string;
  name: string;
  level?: string | null;
  mechanic?: string | null;
  force?: string | null;
  equipment?: string | null;
  category?: string | null;
  primaryMuscles?: string[];
  secondaryMuscles?: string[];
  instructions?: string[];
  images?: string[];
}

const MAX_STEPS = 40;
const MAX_STEP_CHARS = 600;

function strings(value: unknown, limit: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, limit)
    .map((entry) => (entry.length > maxChars ? `${entry.slice(0, maxChars).trim()}…` : entry));
}

function text(value: unknown, maxChars = 60): string | null {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > maxChars ? s.slice(0, maxChars).trim() : s;
}

/** Keep only the dataset rows that are actually usable: a safe id, a name, and steps. */
export function usableGuideRecords(raw: unknown): ExerciseGuideRecord[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ExerciseGuideRecord[] = [];
  for (const entry of raw) {
    const record = entry as ExerciseGuideRecord | null;
    if (!record || typeof record !== "object") continue;
    const id = String(record.id ?? "");
    const name = text(record.name, 120);
    if (!isValidGuideId(id) || !name || seen.has(id)) continue;
    const instructions = strings(record.instructions, MAX_STEPS, MAX_STEP_CHARS);
    if (!instructions.length) continue;
    seen.add(id);
    out.push({
      id,
      name,
      level: text(record.level, 24),
      mechanic: text(record.mechanic, 24),
      force: text(record.force, 24),
      equipment: text(record.equipment, 40),
      category: text(record.category, 40),
      primaryMuscles: strings(record.primaryMuscles, 12, 40),
      secondaryMuscles: strings(record.secondaryMuscles, 12, 40),
      instructions,
      // Only `<id>/<n>.jpg` entries are addressable through the local cache.
      images: strings(record.images, 8, 200).filter((p) => p.startsWith(`${id}/`) && /\/\d+\.jpg$/.test(p)),
    });
  }
  return out;
}

// ---- matching ---------------------------------------------------------------

// Cairn's own vocabulary is abbreviated the way a lifter writes on a phone ("Incline
// DB Press"); the dataset spells implements out. Expanding the abbreviations before
// keying lets those meet WITHOUT loosening the key — "DB" becomes "dumbbell", so a
// dumbbell press still cannot collapse onto a barbell one.
const ABBREVIATIONS: Record<string, string> = {
  db: "dumbbell",
  dbs: "dumbbell",
  bb: "barbell",
  kb: "kettlebell",
  kbs: "kettlebell",
  ohp: "overhead press",
  rdl: "romanian deadlift",
  bw: "bodyweight",
};

function expandAbbreviations(name: string): string {
  return normalizeExerciseName(name)
    .split(" ")
    .filter(Boolean)
    .map((token) => ABBREVIATIONS[token] ?? token)
    .join(" ");
}

/** The high-confidence key: the canon merge key, with abbreviations spelled out first. */
export function guideMatchKey(name: string): string {
  return normalizedExerciseKey(expandAbbreviations(name));
}

/** The low-confidence key: implements stripped, so it collapses barbell/dumbbell siblings. */
export function guideMovementKey(name: string): string {
  return movementKey(expandAbbreviations(name));
}

// A dataset name like "Barbell Bench Press - Medium Grip" carries a trailing
// qualifier. Stripping a GRIP/STANCE/ATTACHMENT qualifier is safe — it is the same
// movement described more precisely. Stripping an EQUIPMENT qualifier is not:
// "Lateral Raise - With Bands" is the only banded row that would collapse onto
// "Lateral Raise", and letting it win would show band photos for a dumbbell raise.
const SAFE_QUALIFIER_RE = /\b(grip|attachment|stance|width)\b/i;

function qualifierBaseName(name: string): string | null {
  const match = /^(.+?) - (.+)$/.exec(name);
  if (!match) return null;
  return SAFE_QUALIFIER_RE.test(match[2]) ? match[1] : null;
}

export type GuideMatchConfidence = "exact" | "key" | "qualified" | "movement";

/** The tiers, strongest first. Matching walks them in this order, globally. */
export const GUIDE_MATCH_TIERS: readonly GuideMatchConfidence[] = ["exact", "key", "qualified", "movement"];

/** Auto-linked tiers. "movement" is deliberately absent — it is a candidate, not an answer. */
const LINKED_TIERS: ReadonlySet<GuideMatchConfidence> = new Set(["exact", "key", "qualified"]);

/**
 * The athlete said no to this guide. It is not "unmatched" (which the matcher is
 * free to try again) — it is answered, and the answer outlives a re-import.
 */
const DETACHED = "detached";

export function isLinkedConfidence(confidence: unknown): boolean {
  return LINKED_TIERS.has(confidence as GuideMatchConfidence);
}

export interface GuideIndex {
  byName: Map<string, ExerciseGuideRecord[]>;
  byKey: Map<string, ExerciseGuideRecord[]>;
  byQualifiedKey: Map<string, ExerciseGuideRecord[]>;
  byMovement: Map<string, ExerciseGuideRecord[]>;
}

function push(map: Map<string, ExerciseGuideRecord[]>, key: string, record: ExerciseGuideRecord): void {
  if (!key) return;
  const bucket = map.get(key);
  if (bucket) bucket.push(record);
  else map.set(key, [record]);
}

export function buildGuideIndex(records: ExerciseGuideRecord[]): GuideIndex {
  const index: GuideIndex = {
    byName: new Map(),
    byKey: new Map(),
    byQualifiedKey: new Map(),
    byMovement: new Map(),
  };
  for (const record of records) {
    push(index.byName, normalizeExerciseName(record.name), record);
    push(index.byKey, guideMatchKey(record.name), record);
    const base = qualifierBaseName(record.name);
    if (base) push(index.byQualifiedKey, guideMatchKey(base), record);
    push(index.byMovement, guideMovementKey(record.name), record);
  }
  return index;
}

// A bucket only answers when it holds exactly ONE row. Ambiguity is the dataset
// telling us it has several different movements under this name; the honest reply
// to that is silence, not a coin flip.
function only(map: Map<string, ExerciseGuideRecord[]>, key: string): ExerciseGuideRecord | null {
  if (!key) return null;
  const bucket = map.get(key);
  return bucket && bucket.length === 1 ? bucket[0] : null;
}

export interface GuideMatch {
  record: ExerciseGuideRecord;
  confidence: GuideMatchConfidence;
}

function lookupTier(index: GuideIndex, confidence: GuideMatchConfidence, candidate: string): ExerciseGuideRecord | null {
  switch (confidence) {
    case "exact":
      return only(index.byName, normalizeExerciseName(candidate));
    case "key":
      return only(index.byKey, guideMatchKey(candidate));
    case "qualified":
      return only(index.byQualifiedKey, guideMatchKey(candidate));
    default:
      return only(index.byMovement, guideMovementKey(candidate));
  }
}

/**
 * Resolve one name (plus its learned aliases) at ONE tier. Linking calls this per
 * tier so the strongest evidence in the whole library is spent before the weakest —
 * see linkGuidesToExercises.
 */
export function matchGuideAtTier(
  index: GuideIndex,
  confidence: GuideMatchConfidence,
  name: string,
  aliases: string[] = []
): ExerciseGuideRecord | null {
  for (const entry of [name, ...aliases]) {
    const candidate = String(entry ?? "").trim();
    if (!candidate) continue;
    const record = lookupTier(index, confidence, candidate);
    if (record) return record;
  }
  return null;
}

/**
 * Resolve one Cairn exercise name (plus any learned aliases for it) to a dataset
 * row. Tiers run strongest-first and each demands a unique hit; the first three
 * are safe to auto-link, "movement" is only ever a suggestion.
 */
export function matchGuide(index: GuideIndex, name: string, aliases: string[] = []): GuideMatch | null {
  for (const confidence of GUIDE_MATCH_TIERS) {
    const record = matchGuideAtTier(index, confidence, name, aliases);
    if (record) return { record, confidence };
  }
  return null;
}

/** Learned variant names for each canonical exercise, so an alias can find the guide too. */
export function aliasesByCanonical(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of listExerciseAliases()) {
    const canonical = normalizeExerciseName(row.canonical);
    if (!canonical) continue;
    const bucket = out.get(canonical);
    if (bucket) bucket.push(row.alias);
    else out.set(canonical, [row.alias]);
  }
  return out;
}

// ---- storage ----------------------------------------------------------------

export interface ExerciseGuideRow {
  id: number;
  guide_id: string;
  name: string;
  name_key: string;
  level: string | null;
  mechanic: string | null;
  force: string | null;
  equipment: string | null;
  category: string | null;
  primary_muscles: string | null;
  secondary_muscles: string | null;
  instructions: string | null;
  image_count: number;
  exercise_id: number | null;
  match_confidence: string | null;
  match_candidate: string | null;
  source: string;
  license: string;
  source_url: string | null;
  imported_at: string | null;
}

/**
 * Write the dataset rows, preserving whatever linkage already exists — a re-import
 * refreshes the upstream text without silently dropping a guide the athlete
 * confirmed by hand. Returns how many rows were written.
 *
 * Synchronous by design, like linkGuidesToExercises: both are ~900 statements the
 * savepoint commits as one, and neither may leave the library half-written. An async
 * refactor (awaiting inside the loop) would interleave other writes into the open
 * savepoint and lose exactly that atomicity.
 */
export function upsertGuideRecords(records: ExerciseGuideRecord[]): number {
  return withSqliteSavepoint("guide_upsert", () => upsertGuideRecordsUnsafe(records));
}

function upsertGuideRecordsUnsafe(records: ExerciseGuideRecord[]): number {
  const stmt = db.prepare(
    `INSERT INTO exercise_guides
       (guide_id, name, name_key, level, mechanic, force, equipment, category,
        primary_muscles, secondary_muscles, instructions, image_count, source, license, source_url, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(guide_id) DO UPDATE SET
       name = excluded.name,
       name_key = excluded.name_key,
       level = excluded.level,
       mechanic = excluded.mechanic,
       force = excluded.force,
       equipment = excluded.equipment,
       category = excluded.category,
       primary_muscles = excluded.primary_muscles,
       secondary_muscles = excluded.secondary_muscles,
       instructions = excluded.instructions,
       image_count = excluded.image_count,
       source = excluded.source,
       license = excluded.license,
       source_url = excluded.source_url,
       imported_at = excluded.imported_at`
  );
  let written = 0;
  for (const record of records) {
    stmt.run(
      record.id,
      record.name,
      guideMatchKey(record.name),
      record.level ?? null,
      record.mechanic ?? null,
      record.force ?? null,
      record.equipment ?? null,
      record.category ?? null,
      JSON.stringify(record.primaryMuscles ?? []),
      JSON.stringify(record.secondaryMuscles ?? []),
      JSON.stringify(record.instructions ?? []),
      (record.images ?? []).length,
      EXERCISE_GUIDE_SOURCE,
      EXERCISE_GUIDE_LICENSE,
      EXERCISE_GUIDE_REPO_URL
    );
    written += 1;
  }
  return written;
}

export interface GuideLinkSuggestion {
  exercise: string;
  guide_id: string;
  guide_name: string;
  confidence: GuideMatchConfidence;
}

export interface GuideLinkResult {
  linked: number;
  suggested: GuideLinkSuggestion[];
  unmatched: string[];
}

/**
 * Re-run matching over every exercise the athlete has. Confident hits are attached;
 * plausible-but-ambiguous ones are recorded as candidates and returned as
 * suggestions. Idempotent: relinking the same library produces the same rows.
 *
 * The tiers are walked GLOBALLY, not per exercise: every exact match in the library
 * is claimed before any key match, and so on down to the suggestion tier. Resolving
 * one exercise at a time would let alphabetical order decide who gets a row — "Band
 * Crossover" reaching "Cable Crossover" on the implement-stripped tier would take the
 * guide that "Cable Crossover" matches by name. Uniqueness is still demanded within
 * a pass; an exercise that loses a claim simply falls through to the weaker tiers.
 */
export function linkGuidesToExercises(records: ExerciseGuideRecord[]): GuideLinkResult {
  return withSqliteSavepoint("guide_link", () => linkGuidesToExercisesUnsafe(records));
}

function linkGuidesToExercisesUnsafe(records: ExerciseGuideRecord[]): GuideLinkResult {
  const index = buildGuideIndex(records);
  const aliasMap = aliasesByCanonical();
  const exercises = db.prepare(`SELECT id, name FROM exercises ORDER BY name`).all() as Array<{
    id: number;
    name: string;
  }>;

  // Start from a clean slate so a rename or a merge cannot leave a stale link
  // pointing at a movement the athlete no longer has. The two ANSWERED states are
  // not ours to revoke, though — a hand-confirmed link and a hand-refused one are
  // both the athlete answering a question the matcher could not, so a re-import must
  // never quietly undo either.
  db.exec(
    `UPDATE exercise_guides
        SET exercise_id = NULL, match_confidence = NULL, match_candidate = NULL
      WHERE match_confidence IS NULL OR match_confidence NOT IN ('manual', '${DETACHED}')`
  );
  // A manual link only stays authoritative while its exercise still exists. Deleting
  // the exercise already nulls exercise_id (ON DELETE SET NULL), which would
  // otherwise leave a 'manual' marker with nothing behind it — a zombie that keeps
  // claiming the guide. Clear those outright.
  db.exec(
    `UPDATE exercise_guides
        SET exercise_id = NULL, match_confidence = NULL, match_candidate = NULL
      WHERE match_confidence = 'manual'
        AND (exercise_id IS NULL OR exercise_id NOT IN (SELECT id FROM exercises))`
  );
  const manuallyClaimed = new Set(
    (
      db
        .prepare(`SELECT guide_id, exercise_id FROM exercise_guides WHERE match_confidence = 'manual'`)
        .all() as Array<{ guide_id: string; exercise_id: number }>
    ).map((row) => row.guide_id)
  );
  const manuallyLinkedExercises = new Set(
    (
      db
        .prepare(
          `SELECT exercise_id FROM exercise_guides WHERE match_confidence = 'manual' AND exercise_id IS NOT NULL`
        )
        .all() as Array<{ exercise_id: number }>
    ).map((row) => row.exercise_id)
  );
  // A refused guide is spoken for: nothing may auto-claim it, and it is not offered
  // as a suggestion again either. attachGuide is the only way back.
  const suppressed = (
    db.prepare(`SELECT guide_id FROM exercise_guides WHERE match_confidence = ?`).all(DETACHED) as Array<{
      guide_id: string;
    }>
  ).map((row) => row.guide_id);

  const link = db.prepare(
    `UPDATE exercise_guides SET exercise_id = ?, match_confidence = ?, match_candidate = NULL WHERE guide_id = ?`
  );
  const suggest = db.prepare(
    `UPDATE exercise_guides SET exercise_id = NULL, match_confidence = ?, match_candidate = ? WHERE guide_id = ?`
  );

  const suggested: GuideLinkSuggestion[] = [];
  const claimed = new Set<string>([...manuallyClaimed, ...suppressed]);
  let linked = manuallyLinkedExercises.size;

  // An exercise the athlete already answered for keeps that answer; the matcher does
  // not get a second opinion.
  const pending = exercises.filter((exercise) => !manuallyLinkedExercises.has(exercise.id));
  const aliasesFor = new Map(
    pending.map((exercise) => [exercise.id, aliasMap.get(normalizeExerciseName(exercise.name)) ?? []])
  );
  const resolved = new Set<number>();

  for (const confidence of GUIDE_MATCH_TIERS) {
    for (const exercise of pending) {
      if (resolved.has(exercise.id)) continue;
      const record = matchGuideAtTier(index, confidence, exercise.name, aliasesFor.get(exercise.id) ?? []);
      // One dataset row can only stand for one movement. Within a pass the first
      // (alphabetical, hence stable) claimant keeps it; the loser is not stranded —
      // it simply carries on into the weaker tiers.
      if (!record || claimed.has(record.id)) continue;
      claimed.add(record.id);
      resolved.add(exercise.id);
      if (isLinkedConfidence(confidence)) {
        link.run(exercise.id, confidence, record.id);
        linked += 1;
      } else {
        suggest.run(confidence, exercise.name, record.id);
        suggested.push({
          exercise: exercise.name,
          guide_id: record.id,
          guide_name: record.name,
          confidence,
        });
      }
    }
  }

  const unmatched = pending.filter((exercise) => !resolved.has(exercise.id)).map((exercise) => exercise.name);
  return { linked, suggested, unmatched };
}

function parseList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}

export interface ExerciseGuide {
  guide_id: string;
  name: string;
  level: string | null;
  mechanic: string | null;
  force: string | null;
  equipment: string | null;
  category: string | null;
  primary_muscles: string[];
  secondary_muscles: string[];
  instructions: string[];
  images: Array<{ index: number; url: string }>;
  match_confidence: string | null;
  source: string;
  license: string;
  source_url: string | null;
}

function hydrate(row: ExerciseGuideRow | undefined | null): ExerciseGuide | null {
  if (!row) return null;
  const count = Math.max(0, Math.min(Number(row.image_count) || 0, 8));
  return {
    guide_id: row.guide_id,
    name: row.name,
    level: row.level,
    mechanic: row.mechanic,
    force: row.force,
    equipment: row.equipment,
    category: row.category,
    primary_muscles: parseList(row.primary_muscles),
    secondary_muscles: parseList(row.secondary_muscles),
    instructions: parseList(row.instructions),
    images: Array.from({ length: count }, (_unused, index) => ({
      index,
      url: `/api/exercise-guides/image/${encodeURIComponent(row.guide_id)}/${index}`,
    })),
    match_confidence: row.match_confidence,
    source: row.source,
    license: row.license,
    source_url: row.source_url,
  };
}

/**
 * The guide attached to one exercise, by name. Returns null when the dataset was
 * never imported, when nothing matched confidently, or when the exercise itself is
 * gone — all of which are ordinary states, never errors.
 */
export function getExerciseGuide(name: string): ExerciseGuide | null {
  const wanted = String(name ?? "").trim();
  if (!wanted) return null;
  const row = db
    .prepare(
      `SELECT g.* FROM exercise_guides g
         JOIN exercises e ON e.id = g.exercise_id
        WHERE e.name = ? COLLATE NOCASE
        LIMIT 1`
    )
    .get(wanted) as ExerciseGuideRow | undefined;
  return hydrate(row);
}

export function getExerciseGuideByExerciseId(exerciseId: number): ExerciseGuide | null {
  if (!Number.isInteger(exerciseId)) return null;
  const row = db.prepare(`SELECT * FROM exercise_guides WHERE exercise_id = ? LIMIT 1`).get(exerciseId) as
    | ExerciseGuideRow
    | undefined;
  return hydrate(row);
}

export function getGuideById(guideId: string): ExerciseGuide | null {
  if (!isValidGuideId(guideId)) return null;
  const row = db.prepare(`SELECT * FROM exercise_guides WHERE guide_id = ? LIMIT 1`).get(guideId) as
    | ExerciseGuideRow
    | undefined;
  return hydrate(row);
}

/**
 * Confirm a guide by hand — the door out of a low-confidence suggestion. ok:false at
 * the call site (never an HTTP error) when either side is missing.
 */
export function attachGuide(exerciseName: string, guideId: string): { ok: boolean; error?: string } {
  const wanted = String(exerciseName ?? "").trim();
  if (!wanted) return { ok: false, error: "exercise required" };
  if (!isValidGuideId(guideId)) return { ok: false, error: "unknown guide" };
  const exercise = db.prepare(`SELECT id FROM exercises WHERE name = ? COLLATE NOCASE`).get(wanted) as
    | { id: number }
    | undefined;
  if (!exercise) return { ok: false, error: `exercise "${wanted}" not found` };
  const guide = db.prepare(`SELECT id FROM exercise_guides WHERE guide_id = ?`).get(guideId) as
    | { id: number }
    | undefined;
  if (!guide) return { ok: false, error: `guide "${guideId}" not imported` };
  // One guide per exercise: clear whatever was pointing here before. Setting it back
  // to "no answer" (rather than 'detached') is deliberate — the athlete replaced this
  // exercise's guide, they did not refuse the old row for every movement.
  db.prepare(
    `UPDATE exercise_guides SET exercise_id = NULL, match_confidence = NULL, match_candidate = NULL WHERE exercise_id = ?`
  ).run(exercise.id);
  // A manual attach is also the door OUT of suppression: naming the guide overrides
  // an earlier refusal of it.
  db.prepare(
    `UPDATE exercise_guides SET exercise_id = ?, match_confidence = 'manual', match_candidate = NULL WHERE guide_id = ?`
  ).run(exercise.id, guideId);
  return { ok: true };
}

/**
 * Drop a link, or dismiss a suggestion — and REMEMBER the no. A cleared row would be
 * indistinguishable from one that was never matched, so the next import would re-attach
 * the very guide the athlete just rejected. The 'detached' marker outlives the import;
 * attachGuide is the way back.
 */
export function detachGuide(guideId: string): { ok: boolean } {
  if (!isValidGuideId(guideId)) return { ok: false };
  db.prepare(
    `UPDATE exercise_guides SET exercise_id = NULL, match_confidence = ?, match_candidate = NULL WHERE guide_id = ?`
  ).run(DETACHED, guideId);
  return { ok: true };
}

/**
 * Follow an exercise merge. The survivor keeps its own guide if it has one;
 * otherwise the merged-away exercise's guide moves across. Called from
 * mergeExercises BEFORE the losing row is deleted, so the link is never left
 * dangling and a merged movement's detail view still opens.
 */
export function repointGuidesOnMerge(fromExerciseId: number, intoExerciseId: number): void {
  if (!Number.isInteger(fromExerciseId) || !Number.isInteger(intoExerciseId)) return;
  if (fromExerciseId === intoExerciseId) return;
  const survivorHasGuide = db
    .prepare(`SELECT 1 AS present FROM exercise_guides WHERE exercise_id = ? LIMIT 1`)
    .get(intoExerciseId) as { present: number } | undefined;
  if (survivorHasGuide) {
    db.prepare(`UPDATE exercise_guides SET exercise_id = NULL, match_confidence = NULL WHERE exercise_id = ?`).run(
      fromExerciseId
    );
    return;
  }
  db.prepare(`UPDATE exercise_guides SET exercise_id = ? WHERE exercise_id = ?`).run(intoExerciseId, fromExerciseId);
}

export interface ExerciseGuideStatus {
  imported: boolean;
  guides: number;
  linked: number;
  suggested: number;
  exercises_with_guide: number;
  images_cached: number;
  source: string;
  license: string;
  source_url: string;
  imported_at: string | null;
}

/** What the Settings surface needs to describe the guide library in one calm line. */
export function exerciseGuideStatus(): ExerciseGuideStatus {
  const counts = db
    .prepare(
      `SELECT COUNT(*) AS guides,
              SUM(CASE WHEN exercise_id IS NOT NULL THEN 1 ELSE 0 END) AS linked,
              SUM(CASE WHEN exercise_id IS NULL AND match_candidate IS NOT NULL THEN 1 ELSE 0 END) AS suggested,
              MAX(imported_at) AS imported_at
         FROM exercise_guides`
    )
    .get() as { guides: number; linked: number | null; suggested: number | null; imported_at: string | null };
  const guides = Number(counts?.guides ?? 0);
  return {
    imported: guides > 0,
    guides,
    linked: Number(counts?.linked ?? 0),
    suggested: Number(counts?.suggested ?? 0),
    exercises_with_guide: Number(counts?.linked ?? 0),
    images_cached: countCachedImages(),
    source: EXERCISE_GUIDE_SOURCE,
    license: EXERCISE_GUIDE_LICENSE,
    source_url: EXERCISE_GUIDE_REPO_URL,
    imported_at: counts?.imported_at ?? null,
  };
}

function countCachedImages(): number {
  try {
    let total = 0;
    for (const folder of fs.readdirSync(EXERCISE_GUIDE_IMAGES_DIR, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue;
      total += fs.readdirSync(path.join(EXERCISE_GUIDE_IMAGES_DIR, folder.name)).filter((f) => f.endsWith(".jpg"))
        .length;
    }
    return total;
  } catch {
    return 0;
  }
}

/** The low-confidence matches waiting on a human yes/no. Never shown as an answer. */
export function listGuideSuggestions(limit = 50): GuideLinkSuggestion[] {
  const rows = db
    .prepare(
      `SELECT guide_id, name, match_candidate, match_confidence
         FROM exercise_guides
        WHERE exercise_id IS NULL AND match_candidate IS NOT NULL
        ORDER BY match_candidate
        LIMIT ?`
    )
    .all(Math.max(1, Math.min(Number(limit) || 50, 200))) as Array<{
    guide_id: string;
    name: string;
    match_candidate: string;
    match_confidence: string;
  }>;
  return rows.map((row) => ({
    exercise: row.match_candidate,
    guide_id: row.guide_id,
    guide_name: row.name,
    confidence: row.match_confidence as GuideMatchConfidence,
  }));
}

/**
 * The one suggestion waiting on THIS exercise, if any — what the detail sheet needs
 * to ask its quiet yes/no. Null whenever nothing plausible was parked for it, which
 * is the ordinary state.
 */
export function getGuideSuggestionForExercise(name: string): GuideLinkSuggestion | null {
  const wanted = String(name ?? "").trim();
  if (!wanted) return null;
  const row = db
    .prepare(
      `SELECT guide_id, name, match_candidate, match_confidence
         FROM exercise_guides
        WHERE exercise_id IS NULL AND match_candidate = ? COLLATE NOCASE
        LIMIT 1`
    )
    .get(wanted) as
    | { guide_id: string; name: string; match_candidate: string; match_confidence: string }
    | undefined;
  if (!row) return null;
  return {
    exercise: row.match_candidate,
    guide_id: row.guide_id,
    guide_name: row.name,
    confidence: row.match_confidence as GuideMatchConfidence,
  };
}

/** Guide ids that are linked to an exercise — the only ones worth spending bytes on. */
export function linkedGuideIds(): string[] {
  const rows = db
    .prepare(`SELECT guide_id FROM exercise_guides WHERE exercise_id IS NOT NULL ORDER BY guide_id`)
    .all() as Array<{ guide_id: string }>;
  return rows.map((row) => row.guide_id);
}

export function guideImageCount(guideId: string): number {
  if (!isValidGuideId(guideId)) return 0;
  const row = db.prepare(`SELECT image_count FROM exercise_guides WHERE guide_id = ?`).get(guideId) as
    | { image_count: number }
    | undefined;
  return row ? Math.max(0, Math.min(Number(row.image_count) || 0, 8)) : 0;
}
