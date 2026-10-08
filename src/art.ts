import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { listActivities } from "./repo/activities.js";
import {
  addArtAsset,
  artIndexUsesKey,
  deleteArtAliases,
  getArtAlias,
  getArtAsset,
  getArtIndex,
  listArtAssets,
  listArtIndex,
  listArtAliases,
  listIndexZeroReuseAliases,
  recordArtUsage,
  setArtAlias,
  setArtIndex,
} from "./repo/art-ledger.js";
import { recordDiagnosticEvent } from "./repo/diagnostics.js";
import {
  classifyMuscleGroup,
  detectImplement,
  getExerciseAlias,
  normalizeExerciseName,
  normalizedExerciseKey,
} from "./repo/exercise-canon.js";
import { findExercise, listExercises } from "./repo/exercises.js";
import { getExerciseGuide } from "./repo/exercise-guide.js";
import { getAppState, setAppState } from "./repo/app-state.js";
import { exercisePoseFromExplanation, getCachedExerciseExplanation } from "./coachOps/training.js";
import { listFoodNotes, listMealPlans } from "./repo/nutrition.js";
import { getGeminiApiKey, getSettings } from "./repo/settings.js";
import { artCircuitOpen, noteArtFailure, noteArtSuccess, onArtCircuitClose } from "./artCircuit.js";
import { starterAssetKey, starterFigureFor } from "./artStarter.js";
import { log } from "./log.js";

// Generated artwork service: photoreal/stylized PNGs for foods, exercises, and
// activities via Google's gemini-nano-banana-2.1 ("Nano Banana 2.1"), cached on
// disk under data/art/. Entirely optional — without a Gemini key (Settings,
// GEMINI_API_KEY, or GOOGLE_AI_KEY), or with settings.art_enabled off, every
// miss is a quiet 204 and nothing runs. Exercises have a no-key floor: the
// starter picture pack (src/artStarter.ts) installs a pre-baked figure on a miss.
//
// This is a DIRECT REST call (global fetch), NOT an agents.json CLI run, and a
// strictly serial in-process queue with in-flight dedup, mirroring enrich.ts:
// one generation at a time, and a throwing job never breaks the drain loop.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const ART_DIR = path.join(DATA_DIR, "art");
// Pre-baked, downscaled images shipped in the repo (seed-art/) so a fresh seed or
// the demo renders real studio photos with NO Gemini key at runtime. installSeedArt()
// copies the ones that match the seeded content into ART_DIR. Built (rarely) by
// `npm run seed:art:build` (src/buildSeedArt.ts). Absent in a slim checkout → no-op.
const SEED_ART_DIR = path.join(__dirname, "..", "seed-art");

// Model names are env-overridable so a rename doesn't need a code change. The
// text model runs the cheap "would this render the same image?" check before
// any image generation (see resolveConcept below).
// Exported (read-only) so a regression test can pin these defaults without a
// live network call — see test/artModelDefaults.test.js.
// gemini-nano-banana-2.1 ("Nano Banana 2.1"): Google's stable image model, checked
// 2026-10-07 against https://ai.google.dev/gemini-api/docs/pricing — $0.0336 per 1K
// standard-tier image, same models.generateContent request shape as the 3.x image
// models, and it accepts up to 14 reference images (see styleReferenceParts).
export const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-nano-banana-2.1";
// gemini-3.6-flash: the current stable Gemini Flash-tier model.
export const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-3.6-flash";
// Optional per-kind override for EXERCISE art only. Unset (the default) means
// exercise art uses GEMINI_IMAGE_MODEL like every other kind. The recommended
// value is "gemini-3-pro-image" (verified against Google's published model and
// pricing pages on 2026-08-23): the clay-figurine series reads as one set only
// when successive figures share a sculptural language, and the pro image model
// both holds style better and accepts reference images (see styleReferenceParts).
export const GEMINI_EXERCISE_IMAGE_MODEL = process.env.GEMINI_EXERCISE_IMAGE_MODEL || "";
// Setting the override is the opt-in to style references, and so is a default
// model documented to take them (STYLE_REFERENCE_MODELS); this is the escape
// hatch for a model that turns out not to.
const EXERCISE_STYLE_REFS_ENABLED = process.env.ART_EXERCISE_STYLE_REFS !== "0";
// Image models Google documents as accepting reference images for style/subject
// consistency. An explicit allowlist, never a sniff of the id: a capable model
// named otherwise is added here deliberately, and a future id that merely
// contains "pro" gets nothing by accident. gemini-nano-banana-2.1 accepts
// references but copies their POSE despite being told not to (verified live
// 2026-10-07: a front squat drawn beside a back-squat anchor came out back-racked,
// and the pulldown went behind the neck), so it is deliberately left off.
export const STYLE_REFERENCE_MODELS: ReadonlySet<string> = new Set(["gemini-3-pro-image"]);
const GEMINI_TEXT_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent`;
const GENERATE_TIMEOUT_MS = 60_000;
const TEXT_TIMEOUT_MS = 20_000;

/** The image model that generates this kind: the exercise override, else the default. */
export function imageModelFor(kind: ArtKind): string {
  return kind === "exercise" && GEMINI_EXERCISE_IMAGE_MODEL ? GEMINI_EXERCISE_IMAGE_MODEL : GEMINI_IMAGE_MODEL;
}

/** What one image of this kind costs to generate, for the spend ledger. */
export function imageCostFor(kind: ArtKind): number {
  if (kind === "exercise" && GEMINI_EXERCISE_IMAGE_MODEL) {
    // ART_IMAGE_COST_USD prices the base model only; the override model falls back to
    // its own table price, never the base model's env rate.
    return positiveEnv("ART_EXERCISE_IMAGE_COST_USD") || tableImageCost(GEMINI_EXERCISE_IMAGE_MODEL);
  }
  return imageCostForModel(GEMINI_IMAGE_MODEL);
}

function imageUrlFor(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

// Cost estimates for the spend ledger (art_usage). Defaults follow the selected
// model from the list-price tables below (Google's published Gemini API pricing,
// checked 2026-10-07, 1K standard-tier images); an unlisted model id falls back
// to the flash-image rate — deliberately the mid-tier price, not the default's: the
// fallback only ever prices an id that is NOT in this table (so never the default),
// and an unknown model is better over- than under-estimated on the spend card. An env override always wins: ART_IMAGE_COST_USD,
// ART_EXERCISE_IMAGE_COST_USD, ART_TEXT_IN_USD_PER_M / ART_TEXT_OUT_USD_PER_M.
// NOTE: Google doubles Gemini 3.x text prices on 2027-01-01; update the table then.
export const IMAGE_COST_USD_BY_MODEL: Record<string, number> = {
  "gemini-nano-banana-2.1": 0.0336,
  "gemini-3.1-flash-lite-image": 0.0336,
  "gemini-3.1-flash-image": 0.067,
  "gemini-3-pro-image": 0.134,
  "gemini-2.5-flash-image": 0.039,
};
export const TEXT_USD_PER_M_BY_MODEL: Record<string, { in: number; out: number }> = {
  "gemini-3.8-flash": { in: 0.75, out: 3.75 },
  "gemini-3.7-flash": { in: 0.75, out: 3.75 },
  "gemini-3.6-flash": { in: 0.75, out: 3.75 },
  "gemini-3.5-flash": { in: 1.5, out: 9 },
  "gemini-3.5-flash-lite": { in: 0.3, out: 2.5 },
  "gemini-3.1-flash-lite": { in: 0.25, out: 1.5 },
};
const FALLBACK_IMAGE_COST_USD = 0.067;
const positiveEnv = (name: string): number => {
  const n = Number(process.env[name] || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
function tableImageCost(model: string): number {
  return IMAGE_COST_USD_BY_MODEL[model] || FALLBACK_IMAGE_COST_USD;
}
/** Per-image cost for a model: ART_IMAGE_COST_USD wins, else the table, else flash. */
export function imageCostForModel(model: string): number {
  return positiveEnv("ART_IMAGE_COST_USD") || tableImageCost(model);
}
const TEXT_PRICE = TEXT_USD_PER_M_BY_MODEL[GEMINI_TEXT_MODEL] ?? { in: 0.75, out: 3.75 };
const TEXT_IN_USD_PER_M = positiveEnv("ART_TEXT_IN_USD_PER_M") || TEXT_PRICE.in;
const TEXT_OUT_USD_PER_M = positiveEnv("ART_TEXT_OUT_USD_PER_M") || TEXT_PRICE.out;

// Up to this many already-generated exercise images ride along as style
// references when a reference-capable image model is in play.
const STYLE_REFERENCE_LIMIT = 3;
const STYLE_REFERENCE_MAX_BYTES = 2_000_000;

export const ART_KINDS = ["food", "exercise", "activity"] as const;
export type ArtKind = (typeof ART_KINDS)[number];

export function isArtKind(kind: string): kind is ArtKind {
  return (ART_KINDS as readonly string[]).includes(kind);
}

// Optional generation context. Only the exercise kind uses it today: a classified
// muscle group + implement + pose clause. For exercises these inputs HASH into
// the asset key (so a farmer's carry and a hammer curl cannot share a PNG);
// `art_index` maps the bare name the PWA still queries to the current asset.
export interface ArtContext {
  muscle_group?: string | null;
  equipment?: string | null;
  // A one-or-two-sentence description of the MOVEMENT itself, taken from the
  // exercise's how-to guide (setup + move). The name alone under-specifies a
  // pose. (The plank once served for "Cable Lateral Raise" and "World's
  // Greatest Stretch" was a misfiled ALIAS onto a front-plank asset — see
  // parseMatchIndex / exerciseAliasTrusted — not a prompt the model misread.)
  pose?: string | null;
}

// How much of the movement description rides along. Long enough for a setup and
// a move sentence, short enough that it can't drown the styling text.
export const POSE_MAX_CHARS = 360;

// A compact " — the pose: <movement description>" clause for the exercise prompt.
// Sanitized to a single plain sentence run: no newlines, no runaway length.
export function exercisePoseClause(context?: ArtContext | null): string {
  const raw = String(context?.pose ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "";
  let pose = raw;
  if (pose.length > POSE_MAX_CHARS) {
    const cut = pose.slice(0, POSE_MAX_CHARS).replace(/\s+\S*$/, "");
    pose = (cut || pose.slice(0, POSE_MAX_CHARS)).trim();
  }
  pose = pose.replace(/[\s.,;:—-]+$/, "");
  return pose ? ` — the pose: ${pose}` : "";
}

// A compact " — a <group> exercise using <equipment>" clause for the exercise
// prompt when context is known; "" otherwise. Kept as a pure, exported helper so
// the prompt variant is unit-testable and the no-context path is provably unchanged.
export function exerciseContextClause(context?: ArtContext | null): string {
  if (!context) return "";
  const bits: string[] = [];
  const mg = String(context.muscle_group ?? "").trim();
  const eq = String(context.equipment ?? "").trim();
  if (mg && mg.toLowerCase() !== "other") bits.push(`a ${mg} exercise`);
  if (eq) bits.push(`using ${eq}`);
  return bits.length ? ` — ${bits.join(" ")}` : "";
}

// Baked-in style prompts per kind. Caller text feeds the image prompt; for
// exercises the pose clause leads so it is not the thing the model deprioritizes
// after a long studio-style boilerplate.
export function stylePrompt(kind: ArtKind, text: string, context?: ArtContext | null): string {
  switch (kind) {
    case "food":
      return `Professional studio food photography of ${text}. Plated on simple cream ceramic, centered, soft diffused natural light, photographed against a seamless warm cream studio background (#F4EFE6), gentle soft shadow beneath the dish, slightly elevated three-quarter angle, appetizing, hyper-detailed, no text, no hands, no props other than the dish. Square 1:1.`;
    case "exercise": {
      const poseLead = exercisePoseLead(context);
      return `${poseLead}Hand-sculpted matte clay figurine of a person performing ${text}${exerciseContextClause(context)}, the figure and every piece of equipment sculpted from the same matte terracotta clay, warm earthen tones, minimalist studio product photograph on a seamless warm cream background (#F4EFE6), soft diffused light, gentle shadow, editorial, no text. Square 1:1.`;
    }
    case "activity":
      return `Hand-sculpted matte clay figurine of a person doing ${text}, terracotta and warm earthen tones, minimalist studio product photograph on a seamless warm cream background (#F4EFE6), soft diffused light, gentle shadow, editorial, no text. Square 1:1.`;
  }
}

/** Pose as a LEADING sentence so the movement isn't buried under studio boilerplate. */
export function exercisePoseLead(context?: ArtContext | null): string {
  const clause = exercisePoseClause(context);
  if (!clause) return "";
  return `${clause.replace(/^ — /, "").replace(/^the pose:/i, "The pose:")}. `;
}

function normalize(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, " ");
}

export function cacheKey(kind: ArtKind, text: string): string {
  return crypto
    .createHash("sha1")
    .update(`${kind}:${normalize(text)}`)
    .digest("hex");
}

/** Short hash of the prompt inputs that distinguish one exercise figurine from another. */
export function exerciseContextHash(text: string, context?: ArtContext | null): string {
  const packed = [
    normalize(text),
    normalize(String(context?.equipment ?? "")),
    normalize(String(context?.muscle_group ?? "")),
    normalize(String(context?.pose ?? "").replace(/\s+/g, " ")),
  ].join("|");
  return crypto.createHash("sha1").update(packed).digest("hex").slice(0, 12);
}

/** Pose-aware, versioned asset key. Name-only lookup goes through `art_index`. */
export function exerciseAssetKey(text: string, context: ArtContext | null | undefined, version: number): string {
  const v = Number(version) > 0 ? Number(version) : 1;
  return crypto
    .createHash("sha1")
    .update(`exercise:${exerciseContextHash(text, context)}:v${v}`)
    .digest("hex");
}

/** On-disk PNG names are sha1 hex (cacheKey / exerciseAssetKey). Anything else is refused. */
export function isArtAssetKey(key: string): boolean {
  return /^[a-f0-9]{40}$/.test(key);
}

function fileForKey(key: string): string {
  if (!isArtAssetKey(key)) throw new Error("invalid art asset key");
  return path.join(ART_DIR, `${key}.png`);
}

export function assetKeyFromPath(file: string): string {
  return path.basename(file, path.extname(file));
}

function indexQuery(text: string): string {
  return normalize(text);
}

export function currentArtIndex(kind: ArtKind, text: string): { asset_key: string; version: number } | null {
  return getArtIndex(kind, indexQuery(text));
}

function existingFile(key: string | null | undefined): string | null {
  if (!key || !isArtAssetKey(key)) return null;
  const file = fileForKey(key);
  return fs.existsSync(file) ? file : null;
}

// Absolute path to the cached PNG, or null when not (yet) generated. Exercises
// resolve through art_index (bare name → current pose-aware asset). Other kinds
// still use the name-only key, then art_aliases.
export function cachedArtPath(kind: ArtKind, text: string): string | null {
  if (kind === "exercise") {
    const idx = getArtIndex(kind, indexQuery(text));
    const indexed = existingFile(idx?.asset_key);
    if (indexed) return indexed;
  }
  const direct = existingFile(cacheKey(kind, text));
  if (direct) return direct;
  const aliasKey = getArtAlias(kind, normalize(text));
  // An exercise alias is honoured only when it points at the SAME movement. The
  // retired text-model matcher filed seven unrelated movements (World's Greatest
  // Stretch, a crunch, a lateral raise…) onto one "front plank" figurine, and a
  // persisted alias short-circuits every later pose-aware generation — the plank
  // would be served forever. A foreign alias reads as a miss so the producer runs.
  if (kind === "exercise" && aliasKey && !exerciseAliasTrusted(text, aliasKey)) return null;
  return existingFile(aliasKey);
}

/** Whether an exercise alias's asset depicts the queried movement (same name, or a linked one). */
export function exerciseAliasTrusted(query: string, assetKey: string): boolean {
  const asset = getArtAsset(assetKey);
  if (!asset) return false;
  if (normalize(asset.text) === normalize(query)) return true;
  return exerciseNamesLinked(query, asset.text);
}

/** Current asset version for a name-only query. Missing → 0 (no figurine yet). */
export function artVersion(kind: ArtKind, text: string): number {
  const idx = getArtIndex(kind, indexQuery(text));
  if (idx && existingFile(idx.asset_key)) return idx.version;
  if (cachedArtPath(kind, text)) return 1;
  // A name whose misfiled alias the boot repair dropped has nothing of its own yet, but a
  // phone may hold the wrong figurine under a v-less or v=1 URL: name the version its
  // replacement will land under, so the URL is already a new one.
  if (kind === "exercise" && aliasRepairedQuery(kind, text)) return exerciseTargetVersion(text, false);
  return 0;
}

const ART_VERSIONS_CAP = 500;
const ART_VERSIONS_NAME_MAX = 120;

/**
 * Cheap version map the PWA fetches once (`GET /api/art/versions`) and keeps in
 * memory, keyed the same way `artImg` tokens are (`kind|q`). Chosen over stuffing
 * `art_v` onto every session/plan row so every surface shares one map without
 * growing the hot payload. Optional `queries` (the `?q=` list) returns only those
 * names; with no list, the most recently used 500 indexed rows.
 */
export function artVersions(opts?: { queries?: string[] | undefined }): { versions: Record<string, number> } {
  const versions: Record<string, number> = {};
  const byNorm = new Map<string, number>();
  const named = opts?.queries?.length
    ? opts.queries.map((q) => String(q ?? "").trim().slice(0, ART_VERSIONS_NAME_MAX)).filter(Boolean)
    : null;

  if (named) {
    for (const name of named) {
      const v = artVersion("exercise", name);
      if (v <= 0) continue;
      byNorm.set(indexQuery(name), v);
      versions[`exercise|${name}`] = v;
      versions[`exercise|${indexQuery(name)}`] = v;
    }
    return { versions };
  }

  for (const row of listArtIndex("exercise", { limit: ART_VERSIONS_CAP })) {
    if (!existingFile(row.asset_key)) continue;
    byNorm.set(row.query, row.version);
    versions[`exercise|${row.query}`] = row.version;
  }
  for (const { kind, q } of enumeratePwaArt()) {
    if (kind !== "exercise") {
      const v = assetVersion(kind, q);
      if (v > 0) versions[`${kind}|${q}`] = v;
      continue;
    }
    const v = byNorm.get(indexQuery(q));
    if (v && v > 0) versions[`${kind}|${q}`] = v;
  }
  return { versions };
}

/**
 * Food and activity pictures have no art_index row, so their URL version is the
 * served asset's creation time (epoch seconds). The art URL is immutable and the
 * service worker is cache-first by full URL, so without a `v=` a query that is
 * re-pointed at a different picture (a regenerated one, or a misfiled alias
 * repaired) would keep showing the old bytes on a phone forever. A newer asset
 * always carries a larger `v`, which is also what the SW's eviction compares.
 * 0 (no `v=`) when nothing is drawn or the file is a seed-pack copy with no row.
 */
export function assetVersion(kind: ArtKind, text: string): number {
  // A query whose misfiled alias the boot repair dropped was served the wrong picture
  // under a URL the phone may still hold — with no `v=` at all before this versioning
  // existed. It never goes back to a v that old: with nothing drawn yet it carries the
  // repair's own time, and its eventual picture anything strictly later.
  const repaired = aliasRepairedQuery(kind, text) ? aliasRepairEpoch() : 0;
  const file = cachedArtPath(kind, text);
  if (!file) return repaired;
  const created = getArtAsset(assetKeyFromPath(file))?.created_at;
  const ms = created ? Date.parse(`${created.replace(" ", "T")}Z`) : Number.NaN;
  const own = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  return repaired ? Math.max(own, repaired + 1) : own;
}

// ---- serial generation queue (in-flight dedup by cache key) ----
interface Job {
  key: string;
  kind: ArtKind;
  text: string;
  context?: ArtContext | null; // exercise prompt + pose-aware key
  // Resolved by the drain when THIS job leaves the loop, whichever way it left
  // (generated, reused, refused by the breaker, or thrown). Only a caller that
  // must await its own queued job sets it — see `enqueueExerciseArt`.
  settle?: (produced: boolean) => void;
}

const queue: Job[] = [];
const inFlight = new Set<string>(); // queued or generating, by cache key
const REGEN_COOLDOWN_MS = 60_000;
const regenInFlight = new Set<string>(); // (kind, normalized q) — versioned keys do not debounce force
const regenCooldownUntil = new Map<string, number>();

/** Test seam: clear the regenerate in-flight / cooldown gates between cases. */
export function resetArtRegenGate(): void {
  regenInFlight.clear();
  regenCooldownUntil.clear();
}
// Keys that failed this process lifetime, mapped to the image model that failed
// them — don't hammer the API; a server restart clears the map so a retry is
// allowed. So does that model's circuit breaker closing: an outage that fails
// 300 keys must not need a restart to recover. Keys are cleared per model, so a
// recovering flash model doesn't un-park keys still waiting on a broken pro one.
const failed = new Map<string, string>();
const failedKeysByQuery = new Map<string, Set<string>>();
onArtCircuitClose((model) => {
  for (const [key, failedModel] of failed) if (failedModel === model) failed.delete(key);
  for (const [query, keys] of failedKeysByQuery) {
    for (const key of keys) if (!failed.has(key)) keys.delete(key);
    if (!keys.size) failedKeysByQuery.delete(query);
  }
});

function queryFailId(kind: ArtKind, text: string): string {
  return `${kind}:${normalize(text)}`;
}

function markFailedKey(kind: ArtKind, text: string, key: string, model: string): void {
  failed.set(key, model);
  const id = queryFailId(kind, text);
  let keys = failedKeysByQuery.get(id);
  if (!keys) {
    keys = new Set();
    failedKeysByQuery.set(id, keys);
  }
  keys.add(key);
}

// Enqueue background generation for a cache miss. Returns true if the request
// was queued (or already in flight); false when generation is unavailable
// (no key / disabled / known-failed) or the file already exists.
//
// Exercise art never takes this name-only path. A miss schedules the
// context-aware producer (`produceExerciseArt`) instead — muscle group,
// implement, and pose from the row / classifier, never a bare name.
export function requestArt(kind: ArtKind, text: string): boolean {
  if (kind === "exercise") return requestExerciseArt(text);
  if (!getGeminiApiKey()) return false;
  if (!getSettings().art_enabled) return false;
  // Gate on the model THIS kind would use: a broken exercise model must not
  // stop food and activity art from queueing.
  if (artCircuitOpen(imageModelFor(kind))) return false; // upstream is down — don't queue into a wall
  const key = cacheKey(kind, text);
  if (failed.has(key)) return false;
  if (cachedArtPath(kind, text)) return false; // direct hit or alias-resolved hit
  if (inFlight.has(key)) return true; // already queued/generating — dedup
  inFlight.add(key);
  queue.push({ key, kind, text });
  void drain();
  return true;
}

// A cache miss on an exercise goes onto the SAME serial queue food and activity
// art use — never straight at the producer. warmArt() walks every uncached PWA
// query 5s after boot, so firing the producer per name meant one image request
// per uncached movement, all in flight at once: a Pi with forty of them met a
// wall of 429s, every key landed in `failed`, and the breaker opened on art that
// was working fine a minute earlier. Queued, they go out one at a time.
// Returns whether a job is really pending — queued now, or already queued /
// generating under this key — so `warmArt()`'s count means something.
function requestExerciseArt(text: string, settle?: (produced: boolean) => void): boolean {
  // Every path that does NOT push a job answers `settle` here, so a caller
  // awaiting its own queued job can never be left hanging on a refusal.
  const refuse = (): boolean => {
    settle?.(false);
    return false;
  };
  const name = String(text ?? "").trim();
  if (!name) return refuse();
  if (cachedArtPath("exercise", name)) return refuse();
  // The starter pack's figure for exactly this exercise is installed instead —
  // key or no key, and never as a paid generation. (Before the key gate, so the
  // boot warm-up lands the pack for a keyless install too.)
  if (installStarterFigure(name)) return refuse();
  if (!getGeminiApiKey()) return refuse();
  if (!getSettings().art_enabled) return refuse();
  if (artCircuitOpen(imageModelFor("exercise"))) return refuse();
  const ctx = buildExerciseArtContext(name);
  const key = exerciseAssetKey(name, ctx, exerciseTargetVersion(name, false));
  if (failed.has(key)) return refuse();
  if (inFlight.has(key)) {
    settle?.(false); // someone else's job owns this key — nothing of ours to wait on
    return true; // already queued/generating — dedup
  }
  inFlight.add(key);
  queue.push({ key, kind: "exercise", text: name, context: ctx, settle });
  void drain();
  return true;
}

/**
 * Queue exercise art the way a cache miss does, and resolve when THAT job has
 * run. The `/api/art` miss path's enrich job (`processExerciseArtJob`) called the
 * producer directly, which put the one path a person actually triggers — opening
 * a movement whose figurine is missing — outside the single lane every other
 * exercise miss rides. A screen full of uncached movements is exactly the wall of
 * concurrent image requests the queue exists to prevent, arriving one enrich job
 * at a time instead of all at once.
 *
 * Resolves false when nothing of ours was queued (empty name, no key, art off,
 * breaker open, a parked failure, already cached, or another in-flight job
 * already owns the key) — in each case there is nothing for the caller to wait
 * on, and the queue's own bookkeeping has already recorded whatever happened.
 */
export function enqueueExerciseArt(name: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let answered = false;
    const settle = (produced: boolean) => {
      if (answered) return;
      answered = true;
      resolve(produced);
    };
    requestExerciseArt(name, settle);
  });
}

/**
 * The single exercise-art producer: always generate with muscle group /
 * equipment / pose context. Called from the enrich `exercise` / `exercise_art`
 * jobs, from `requestArt("exercise")` / `warmArt()`, and from the serve-route
 * fallback when no exercise row exists. Never a bare name.
 */
export async function produceExerciseArt(name: string, context?: ArtContext | null): Promise<boolean> {
  const text = String(name ?? "").trim();
  if (!text) return false;
  return warmExerciseArt(text, context ?? buildExerciseArtContext(text));
}

/** Fill muscle_group / equipment / pose from the row, then the deterministic floor. */
export function buildExerciseArtContext(name: string, extra?: ArtContext | null): ArtContext {
  const row = findExercise(name) as { muscle_group?: string | null; equipment?: string | null } | undefined;
  const pose = extra?.pose || exercisePoseFor(name);
  return {
    muscle_group: extra?.muscle_group || row?.muscle_group || classifyMuscleGroup(name) || null,
    equipment: extra?.equipment || row?.equipment || detectImplement(name) || null,
    pose: pose || null,
  };
}

/**
 * The movement description an exercise figurine is drawn from: the coach's cached
 * how-to (setup + move), else the imported library guide's opening steps. Null
 * when neither exists — the classifier context still shapes the prompt then.
 */
export function exercisePoseFor(name: string): string | null {
  try {
    const cached: any = getCachedExerciseExplanation(name);
    const pose = exercisePoseFromExplanation(cached?.explanation);
    if (pose) return pose;
  } catch {
    /* a missing how-to is the ordinary state */
  }
  try {
    return exercisePoseFromGuideSteps(getExerciseGuide(name)?.instructions);
  } catch {
    return null;
  }
}

/**
 * The library guide's first two steps as a pose description. The library's
 * opening step is sometimes a preamble ("This is a three-part stretch."), so two
 * steps ride along; exercisePoseClause caps the length.
 */
export function exercisePoseFromGuideSteps(steps: unknown): string | null {
  if (!Array.isArray(steps)) return null;
  const text = steps
    .slice(0, 2)
    .map((step) =>
      String(step ?? "")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean)
    .join(" ");
  return text || null;
}

export function clearArtFailures(kind: ArtKind, text: string): void {
  const id = queryFailId(kind, text);
  const keys = failedKeysByQuery.get(id);
  if (keys) {
    for (const key of keys) failed.delete(key);
    failedKeysByQuery.delete(id);
  }
  failed.delete(cacheKey(kind, text));
  const idx = getArtIndex(kind, indexQuery(text));
  if (idx) failed.delete(idx.asset_key);
}

// Generate muscle-group/equipment/pose-aware art for an exercise. The PWA still
// looks up by bare name; art_index points that name at the pose-aware file.
// Called by the background 'exercise' / 'exercise_art' enrichment jobs.
export async function warmExerciseArt(name: string, context?: ArtContext | null): Promise<boolean> {
  return warmArtUnderName("exercise", name, context);
}

export type ArtRegenerateOutcome =
  | { ok: true; regenerated: true; version: number }
  | { ok: true; regenerated: false; reason: "cooldown" | "in_flight"; version: number }
  | { ok: false; regenerated: false };

/**
 * Force a fresh image for an existing (kind, q): forget the failure, bump the
 * exercise version, generate again under a new pose-aware key. The repair path
 * for a figurine that came back wrong. Respects the circuit breaker and records
 * the spend exactly like the warm path — a regeneration is a paid generation.
 * Per (kind, normalized q): in-flight and a 60s cooldown no-op so a repeated
 * long-press cannot burn Gemini spend. `force` still bumps the versioned asset
 * key; the query-level gate is what actually debounces.
 */
export async function regenerateArt(
  kind: ArtKind,
  q: string,
  context?: ArtContext | null
): Promise<ArtRegenerateOutcome> {
  const text = String(q ?? "").trim();
  // The same `v` scale the client's art URL uses: an exercise's redraw counter, a food
  // or activity picture's creation time (assetVersion).
  const version = () => (kind === "exercise" ? artVersion(kind, text) : assetVersion(kind, text));
  if (!text) return { ok: false, regenerated: false };
  if (!getGeminiApiKey() || !getSettings().art_enabled) return { ok: false, regenerated: false };
  const model = imageModelFor(kind);
  if (artCircuitOpen(model)) return { ok: false, regenerated: false };

  const id = queryFailId(kind, text);
  if (regenInFlight.has(id)) {
    return { ok: true, regenerated: false, reason: "in_flight", version: version() };
  }
  const until = regenCooldownUntil.get(id) ?? 0;
  if (Date.now() < until) {
    return { ok: true, regenerated: false, reason: "cooldown", version: version() };
  }

  regenInFlight.add(id);
  regenCooldownUntil.set(id, Date.now() + REGEN_COOLDOWN_MS);
  try {
    const landed = await warmArtUnderName(kind, text, context, true);
    if (!landed) return { ok: false, regenerated: false };
    return { ok: true, regenerated: true, version: version() };
  } finally {
    regenInFlight.delete(id);
  }
}

async function warmArtUnderName(
  kind: ArtKind,
  name: string,
  context?: ArtContext | null,
  force = false
): Promise<boolean> {
  const text = String(name ?? "").trim();
  if (!text) return false;
  if (!getGeminiApiKey()) return false;
  if (!getSettings().art_enabled) return false;
  const model = imageModelFor(kind);
  if (artCircuitOpen(model)) return false;
  if (kind === "exercise") return warmExerciseUnderName(text, context, force, model);
  const key = cacheKey(kind, text);
  if (inFlight.has(key)) return false;
  if (force) {
    failed.delete(key);
    try {
      fs.rmSync(fileForKey(key), { force: true });
    } catch {
      /* a file we can't drop we can still overwrite */
    }
  } else {
    if (failed.has(key)) return false;
    if (fs.existsSync(fileForKey(key))) return false;
  }
  inFlight.add(key);
  try {
    await generate({ key, kind, text, context });
  } catch (e: any) {
    markFailedKey(kind, text, key, model);
    noteArtFailure(model, artErrorCode(e));
    recordArtUsage({ kind, query: normalize(text), action: "fail", model });
    log.warn(`[art] ${kind} art failed for "${text}": ${e?.message ?? e}`);
    return false;
  } finally {
    inFlight.delete(key);
  }
  recordGeneration(kind, key, normalize(text), normalize(text), model);
  return true;
}

/**
 * The version the next exercise figurine for this name lands under. One answer for
 * the queue's dedup/failure key and the producer's asset key, so a parked failure
 * is seen by both. A name that was only ever served through a (now distrusted)
 * alias starts at v2: a phone may hold that wrong figurine under v=1 in the
 * service worker's cache-first art layer, and the replacement must not share it.
 */
export function exerciseTargetVersion(text: string, force: boolean): number {
  const q = indexQuery(text);
  const current = getArtIndex("exercise", q);
  const currentFile = existingFile(current?.asset_key) || (!current ? existingFile(cacheKey("exercise", text)) : null);
  const currentVersion = current?.version || (currentFile ? 1 : 0);
  if (force) return currentVersion + 1 || 1;
  if (currentVersion) return currentVersion;
  // The boot repair deletes the distrusted alias before the warm-up runs, so the alias
  // itself is gone by then; the repair's own record of the names it un-aliased carries
  // the same fact.
  const aliasKey = getArtAlias("exercise", q);
  return (aliasKey && existingFile(aliasKey)) || aliasRepairedQuery("exercise", text) ? 2 : 1;
}

async function warmExerciseUnderName(
  text: string,
  context: ArtContext | null | undefined,
  force: boolean,
  model: string
): Promise<boolean> {
  const ctx = context ?? buildExerciseArtContext(text);
  const q = indexQuery(text);
  const current = getArtIndex("exercise", q);
  const currentFile = existingFile(current?.asset_key) || (!current ? existingFile(cacheKey("exercise", text)) : null);
  const version = exerciseTargetVersion(text, force);
  const key = exerciseAssetKey(text, ctx, version);

  if (inFlight.has(key)) return false;
  if (force) {
    clearArtFailures("exercise", text);
    if (
      current?.asset_key &&
      isArtAssetKey(current.asset_key) &&
      current.asset_key !== key &&
      !artIndexUsesKey(current.asset_key, "exercise", q)
    ) {
      try {
        fs.rmSync(fileForKey(current.asset_key), { force: true });
      } catch {
        /* keep generating even if the old file sticks */
      }
    }
  } else {
    if (failed.has(key)) return false;
    if (currentFile) return false; // already generated — regenerateArt is the repair path
    // A starter-pack figure for exactly this exercise beats a paid generation; only
    // the explicit redraw (force) goes past it to a bespoke figure.
    if (installStarterFigure(text)) return false;
    const reused = findReusableExerciseAsset(text, key);
    if (reused) {
      setArtIndex("exercise", q, reused.key, version);
      setArtAlias("exercise", q, reused.key);
      recordArtUsage({
        kind: "exercise",
        query: q,
        asset_key: reused.key,
        action: "reuse",
        est_saved_usd: imageCostFor("exercise"),
      });
      return false;
    }
  }

  inFlight.add(key);
  try {
    await generate({ key, kind: "exercise", text, context: ctx });
  } catch (e: any) {
    markFailedKey("exercise", text, key, model);
    noteArtFailure(model, artErrorCode(e));
    recordArtUsage({ kind: "exercise", query: q, action: "fail", model });
    log.warn(`[art] exercise art failed for "${text}": ${e?.message ?? e}`);
    return false;
  } finally {
    inFlight.delete(key);
  }
  setArtIndex("exercise", q, key, version);
  setArtAlias("exercise", q, key);
  recordGeneration("exercise", key, normalize(text), q, model);
  return true;
}

function exerciseNamesLinked(a: string, b: string): boolean {
  const keyA = normalizedExerciseKey(a);
  const keyB = normalizedExerciseKey(b);
  if (keyA && keyA === keyB) return true;
  const na = normalizeExerciseName(a);
  const nb = normalizeExerciseName(b);
  if (!na || !nb) return false;
  const aliasA = getExerciseAlias(na);
  const aliasB = getExerciseAlias(nb);
  if (aliasA?.canonical) {
    const c = String(aliasA.canonical);
    if (normalizeExerciseName(c) === nb || normalizedExerciseKey(c) === keyB) return true;
  }
  if (aliasB?.canonical) {
    const c = String(aliasB.canonical);
    if (normalizeExerciseName(c) === na || normalizedExerciseKey(c) === keyA) return true;
  }
  return false;
}

function findReusableExerciseAsset(name: string, excludeKey: string): { key: string; text: string } | null {
  for (const asset of listArtAssets("exercise", 150)) {
    if (asset.key === excludeKey) continue;
    if (!existingFile(asset.key)) continue;
    if (exerciseNamesLinked(name, asset.text)) return asset;
  }
  return null;
}

/**
 * Persist a generation that already landed on disk, and only THEN tell the
 * breaker upstream is healthy. The order matters both ways: a success recorded
 * before the write would credit a render that isn't in the ledger, and a
 * persistence throw is OUR fault, not the model's — counting it as an upstream
 * failure would march a perfectly healthy model toward an open circuit. So a
 * write failure gets its own diagnostic and touches the breaker not at all.
 */
function recordGeneration(kind: ArtKind, key: string, assetText: string, query: string, model: string): void {
  try {
    addArtAsset(key, kind, assetText);
    recordArtUsage({
      kind,
      query,
      asset_key: key,
      action: "generate",
      model,
      est_cost_usd: imageCostFor(kind),
    });
  } catch (e: any) {
    recordDiagnosticEvent({
      source: "worker",
      kind: "art_persist_error",
      level: "error",
      operation: "art:persist",
      fingerprint: `worker:art_persist_error:${kind}`,
      message: String(e?.message ?? e).slice(0, 240),
      metadata: { model },
    });
    log.warn(`[art] generated ${kind} "${query}" but could not record it: ${e?.message ?? e}`);
    return;
  }
  noteArtSuccess(model);
}

let draining = false;

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const job = queue.shift()!;
      const model = imageModelFor(job.kind);
      // Whether this job put a NEW image on disk — the answer a caller awaiting
      // its own queued job gets, on every way out of the body below.
      let produced = false;
      try {
        // The breaker for THIS job's model may have opened partway through the
        // drain — drop the job rather than spend on a known outage, but keep
        // draining: a broken exercise model must not abandon the food and
        // activity backlog for the length of its cooldown.
        if (artCircuitOpen(model)) {
          inFlight.delete(job.key);
          continue;
        }
        try {
          // An earlier job this drain may have aliased this query onto an
          // asset that now exists — nothing left to do.
          if (cachedArtPath(job.kind, job.text)) continue;
          if (job.kind === "exercise") {
            // Hand the key back before calling: the producer owns `inFlight` for
            // the window it actually generates in, and would read our own
            // reservation as someone else's in-flight job and bail. It carries its
            // own failure bookkeeping (failed map, breaker, ledger row), so the
            // drain adds nothing here but serialization.
            inFlight.delete(job.key);
            produced = await warmExerciseUnderName(job.text, job.context, false, model);
            continue;
          }
          const r = await resolveConcept(job);
          if (!r.reused) {
            await generate({ key: r.key, kind: job.kind, text: r.text });
            recordGeneration(job.kind, r.key, normalize(r.text), normalize(job.text), model);
            produced = true;
          }
        } catch (e: any) {
          // A failing job must never break the loop.
          markFailedKey(job.kind, job.text, job.key, model);
          noteArtFailure(model, artErrorCode(e));
          recordArtUsage({ kind: job.kind, query: normalize(job.text), action: "fail", model });
          log.warn(`[art] generation failed for ${job.kind} "${job.text}": ${e?.message ?? e}`);
        } finally {
          inFlight.delete(job.key);
        }
      } finally {
        // Never let a waiter outlive its job — a settle that throws is the
        // caller's problem, not the queue's.
        try {
          job.settle?.(produced);
        } catch {
          /* a waiter must never break the drain */
        }
      }
    }
  } finally {
    draining = false;
  }
}

// ---- semantic canonicalization (one cheap text call per unique phrase) ----
// Before paying for an image, ask a cheap text model whether this query would
// render essentially the same picture as an asset we already have ("blueberry
// oats with almonds" vs "oatmeal, blueberries, almonds"), and if not, what
// canonical phrase to file the new image under so future rewordings converge
// on it. The verdict is persisted in art_aliases, so each unique phrase pays
// for at most one text call ever. Any failure (no model, bad JSON, timeout)
// falls back to generating under the query's own key — the original behavior.
//
// Exercises are the exception: Gemini-text "semantic match" is how distinct
// movements got aliased onto one another's figurine. Reuse only when
// normalizedExerciseKey matches or an explicit exercise_aliases row already
// links them, and never rewrite the prompt away from the athlete's name.

function matcherPrompt(kind: ArtKind, text: string, existing: { text: string }[]): string {
  const list = existing.map((a, i) => `${i}: ${a.text}`).join("\n");
  const strictness =
    kind === "activity"
      ? "Be strict: a different movement, equipment, or activity is NOT a match (barbell vs dumbbell bench press are different images; 'DB bench' and 'dumbbell bench press' are the same image)."
      : "Ignore brands, quantities, plating words, and word order; the same dish phrased differently IS a match. Different dishes are not.";
  return `You manage a cache of generated illustrations for a fitness app. A new ${kind} entry needs an image.

New entry: "${text}"

Existing cached images (index: subject):
${list || "(none yet)"}

Respond with ONLY a JSON object: {"match": <index or null>, "canonical": "<phrase>"}
- "match": the index of an existing image that would look essentially identical for this entry, or null if none. ${strictness}
- "canonical": a short generic phrase (max 8 words) describing the image to generate, normalized so equivalent wordings of this entry would produce the exact same phrase.`;
}

async function geminiText(prompt: string): Promise<{ json: any; in_tokens: number; out_tokens: number }> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error("Gemini API key missing");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEXT_TIMEOUT_MS);
  let body: any = null;
  try {
    const res = await fetch(GEMINI_TEXT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw await geminiFailure(res, GEMINI_TEXT_MODEL, "canonicalize");
    body = await res.json().catch(() => null);
  } finally {
    clearTimeout(timer);
  }
  const parts = body?.candidates?.[0]?.content?.parts;
  const raw = Array.isArray(parts) ? parts.map((p: any) => p?.text ?? "").join("") : "";
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in text response");
  return {
    json: JSON.parse(m[0]),
    in_tokens: Number(body?.usageMetadata?.promptTokenCount ?? 0),
    out_tokens: Number(body?.usageMetadata?.candidatesTokenCount ?? 0),
  };
}

function textCost(inTokens: number, outTokens: number): number {
  return (inTokens * TEXT_IN_USD_PER_M + outTokens * TEXT_OUT_USD_PER_M) / 1_000_000;
}

/**
 * The matcher's `match` as an index into the listed assets, or null for "no match".
 * Strict on purpose: `Number(null)` is 0, and that one coercion filed every
 * non-matching query onto the NEWEST asset of its kind — hundreds of meals drawn
 * as one chicken plate, seven movements as one front plank. Only a real integer
 * (or an all-digit string) inside the list counts.
 */
export function parseMatchIndex(raw: unknown, length: number): number | null {
  let idx: number;
  if (typeof raw === "number") idx = raw;
  else if (typeof raw === "string" && /^\s*\d+\s*$/.test(raw)) idx = Number(raw);
  else return null;
  return Number.isInteger(idx) && idx >= 0 && idx < length ? idx : null;
}

// Resolve a queued query to the asset it should serve: an existing asset
// (reused: true — no image call) or a canonical key/text to generate under.
// Exported so tests can pin the exercise reuse rule without going through drain.
export async function resolveConcept(job: {
  kind: ArtKind;
  text: string;
  key?: string;
  context?: ArtContext | null;
}): Promise<{ key: string; text: string; reused: boolean }> {
  const fallbackKey =
    job.key ?? (job.kind === "exercise" ? exerciseAssetKey(job.text, job.context, 1) : cacheKey(job.kind, job.text));
  if (job.kind === "exercise") return resolveExerciseConcept(job.text, fallbackKey);

  const norm = normalize(job.text);
  const existing = listArtAssets(job.kind, 150);
  try {
    const { json, in_tokens, out_tokens } = await geminiText(matcherPrompt(job.kind, job.text, existing));
    recordArtUsage({
      kind: job.kind,
      query: norm,
      action: "canonicalize",
      model: GEMINI_TEXT_MODEL,
      input_tokens: in_tokens,
      output_tokens: out_tokens,
      est_cost_usd: textCost(in_tokens, out_tokens),
    });
    const idx = parseMatchIndex(json?.match, existing.length);
    if (idx != null && existingFile(existing[idx].key)) {
      setArtAlias(job.kind, norm, existing[idx].key);
      recordArtUsage({
        kind: job.kind,
        query: norm,
        asset_key: existing[idx].key,
        action: "reuse",
        est_saved_usd: imageCostFor(job.kind),
      });
      return { key: existing[idx].key, text: existing[idx].text, reused: true };
    }
    const canonical = normalize(String(json?.canonical ?? "")).slice(0, 120);
    if (canonical) {
      const key = cacheKey(job.kind, canonical);
      if (key !== cacheKey(job.kind, norm)) setArtAlias(job.kind, norm, key);
      if (existingFile(key)) {
        recordArtUsage({
          kind: job.kind,
          query: norm,
          asset_key: key,
          action: "reuse",
          est_saved_usd: imageCostFor(job.kind),
        });
        return { key, text: canonical, reused: true };
      }
      return { key, text: canonical, reused: false };
    }
  } catch (e: any) {
    recordArtUsage({ kind: job.kind, query: norm, action: "fail", model: GEMINI_TEXT_MODEL });
    log.warn(`[art] canonicalize failed for ${job.kind} "${job.text}": ${e?.message ?? e}`);
  }
  return { key: fallbackKey, text: job.text, reused: false };
}

function resolveExerciseConcept(text: string, fallbackKey: string): { key: string; text: string; reused: boolean } {
  const norm = indexQuery(text);
  const existing = listArtAssets("exercise", 150);
  for (const asset of existing) {
    if (!existingFile(asset.key)) continue;
    if (!exerciseNamesLinked(text, asset.text)) continue;
    setArtAlias("exercise", norm, asset.key);
    const version = getArtIndex("exercise", norm)?.version || 1;
    setArtIndex("exercise", norm, asset.key, version);
    recordArtUsage({
      kind: "exercise",
      query: norm,
      asset_key: asset.key,
      action: "reuse",
      est_saved_usd: imageCostFor("exercise"),
    });
    // Keep the athlete's name as the prompt text — never canonicalize it away.
    return { key: asset.key, text, reused: true };
  }
  return { key: fallbackKey, text, reused: false };
}

// ---- cache warm-up ----
// Mirrors the PWA (public/js/) ACT_ART_PHRASE and MUST stay in sync with it: bare
// activity types make ambiguous image prompts ("ride" → horseback), so common
// types map to an explicit phrase. Substring match over the lowercased type,
// in insertion order; no match falls back to the raw type.
const ACT_ART_PHRASE: Record<string, string> = {
  ride: "riding a road bicycle",
  bike: "riding a road bicycle",
  cycl: "riding a road bicycle",
  run: "running",
  jog: "jogging",
  hike: "hiking with a backpack",
  walk: "walking briskly",
  swim: "swimming freestyle",
  row: "rowing on a rowing machine",
  yoga: "holding a yoga pose",
  climb: "climbing an indoor wall",
  ski: "cross-country skiing",
};

function actArtText(a: any): string {
  const t = String(a?.type ?? "").toLowerCase();
  for (const k in ACT_ART_PHRASE) if (t.includes(k)) return ACT_ART_PHRASE[k];
  return a?.type || a?.raw_text || "";
}

// The PWA's artImg() truncates every query to 120 chars before hitting
// /api/art — warm-up queries must match or the cache keys diverge.
function pwaQuery(q: any): string {
  return String(q ?? "")
    .trim()
    .slice(0, 120);
}

// Every (kind, query) pair the PWA will request art for — the single source of
// truth shared by warmArt() (queue generation) and artManifest() (report which
// are already generated). Queries are built EXACTLY like the PWA (same truncation
// and fallback chains) so the cache keys — and the "kind|q" tokens the client
// computes — line up. Deduped on the raw "kind|q" token (what the client keys on).
export function enumeratePwaArt(): { kind: ArtKind; q: string }[] {
  const out: { kind: ArtKind; q: string }[] = [];
  const seen = new Set<string>();
  const push = (kind: ArtKind, text: string) => {
    const q = pwaQuery(text);
    if (!q) return;
    const token = `${kind}|${q}`;
    if (seen.has(token)) return;
    seen.add(token);
    out.push({ kind, q });
  };

  // a) exercises — the PWA uses the bare exercise name as the query.
  for (const ex of listExercises() as any[]) push("exercise", ex?.name ?? "");

  // b) meal plans — most recent non-discarded plan + any current draft.
  //    Query built exactly like the PWA (public/js/) mealRowHtml.
  const plans = listMealPlans(20) as any[];
  const targets = [plans.find((p) => p?.status !== "discarded"), plans.find((p) => p?.status === "draft")].filter(
    (p, i, arr) => p && arr.indexOf(p) === i
  );
  for (const plan of targets) {
    for (const d of Array.isArray(plan?.parsed?.days) ? plan.parsed.days : []) {
      for (const m of Array.isArray(d?.meals) ? d.meals : []) {
        const items = Array.isArray(m?.items) ? m.items.join(", ") : m?.items || "";
        push("food", `${m?.name || m?.meal || ""} ${items}`.trim());
      }
    }
  }

  // c) food notes — same fallback chain as the PWA (public/js/) noteEntryInner.
  for (const n of listFoodNotes(30) as any[]) {
    const pj = n?.parsed;
    push("food", n?.raw_text || n?.raw || n?.raw_output || (pj && (pj.summary || pj.items)) || "");
  }

  // d) activities — distinct types, mapped through the PWA's phrase map.
  for (const a of listActivities(50) as any[]) push("activity", actArtText(a));

  return out;
}

// Pre-generate every image the PWA is going to ask for, so tiles render
// immediately instead of 204-then-generate on first view. Each query goes
// through requestArt(), which already handles unavailability (no key /
// art_enabled off / known-failed), cache hits, and in-flight dedup.
//
// `repairedCap` bounds how many food/activity queries the alias repair un-aliased this
// pass may queue (the boot passes REPAIRED_ART_WARM_PER_BOOT): a repair can drop hundreds
// of meal aliases at once, and each queued one is a paid matcher call and maybe an image.
// The rest resolve lazily, when a screen actually asks for them (GET /api/art), or on a
// later boot's share.
export const REPAIRED_ART_WARM_PER_BOOT = 12;

export function warmArt(opts: { repairedCap?: number } = {}): { queued: number; skipped: number } {
  let queued = 0;
  let skipped = 0;
  const cap = opts.repairedCap;
  let repairedQueued = 0;
  for (const { kind, q } of enumeratePwaArt()) {
    if (cap != null && kind !== "exercise" && aliasRepairedQuery(kind, q)) {
      if (repairedQueued >= cap) {
        skipped++;
        continue;
      }
      if (requestArt(kind, q)) {
        queued++;
        repairedQueued++;
      } else skipped++;
      continue;
    }
    if (requestArt(kind, q)) queued++;
    else skipped++;
  }
  return { queued, skipped };
}

// Which of the PWA's art queries already have a generated image on disk, returned
// as the exact "kind|q" tokens the client computes. The PWA primes its readiness
// set from this so generated art renders immediately — eager, no SVG-placeholder
// flash — on a cold client too. Cheap: an fs.existsSync (+ alias lookup) per entry.
export function artManifest(): { ready: string[]; enabled: boolean } {
  const ready: string[] = [];
  for (const { kind, q } of enumeratePwaArt()) {
    if (cachedArtPath(kind, q)) ready.push(`${kind}|${q}`);
  }
  return { ready, enabled: !!getSettings().art_enabled };
}

/**
 * Everything the PWA needs about art at boot, in one read (`GET /api/art/state`):
 * the ready tokens, the enabled flag and the exercise version map. It replaces the
 * boot's two round trips (`/art/manifest` + `/art/versions`, both still served), and
 * the client persists the versions so the very first render's image URLs already
 * carry `v=` — a stale `v` would otherwise draw every photo twice.
 */
export function artState(): { ready: string[]; enabled: boolean; versions: Record<string, number> } {
  const manifest = artManifest();
  return { ...manifest, versions: artVersions().versions };
}

// ---- one-shot repair of misfiled aliases ----

const ALIAS_REPAIR_STATE_KEY = "art_alias_repair_v1";

/**
 * Drop the aliases that serve one movement's or meal's picture for another:
 *   • exercise — any alias whose asset is not the same or a linked movement
 *     (the retired text matcher's verdicts; cachedArtPath already distrusts them);
 *   • food / activity — the `Number(null) === 0` signature (listIndexZeroReuseAliases).
 * Dropping an alias deletes no image: the query simply misses, re-asks the (now
 * strict) matcher, and either reuses a genuine match or draws its own picture.
 * Dry run unless `apply`. Returns the counts per kind.
 */
export function repairMisfiledArtAliases(opts: { apply?: boolean } = {}): Record<ArtKind, number> {
  const out: Record<ArtKind, number> = { food: 0, exercise: 0, activity: 0 };
  const queries = misfiledAliasQueries();
  for (const kind of ART_KINDS) {
    out[kind] = opts.apply ? deleteArtAliases(kind, queries[kind]) : queries[kind].length;
  }
  return out;
}

function misfiledAliasQueries(): Record<ArtKind, string[]> {
  const out: Record<ArtKind, string[]> = { food: [], exercise: [], activity: [] };
  for (const kind of ART_KINDS) {
    out[kind] =
      kind === "exercise"
        ? listArtAliases(kind)
            .filter((row) => !exerciseAliasTrusted(row.query, row.asset_key))
            .map((row) => row.query)
        : listIndexZeroReuseAliases(kind)
            .filter((row) => normalize(row.text) !== row.query)
            .map((row) => row.query);
  }
  return out;
}

/**
 * Run the alias repair once per database (boot), before the art warm-up. The record it
 * leaves names every query it un-aliased, because the alias itself — the only other
 * evidence a phone may hold a wrong picture for that name — is gone afterwards: those
 * names start at a new URL version (exerciseTargetVersion, assetVersion), and the
 * food/activity ones are queued a few per boot rather than all at once (warmArt).
 */
export function repairMisfiledArtAliasesOnce(): Record<ArtKind, number> | null {
  if (getAppState(ALIAS_REPAIR_STATE_KEY)) return null;
  const queries = misfiledAliasQueries();
  const removed: Record<ArtKind, number> = { food: 0, exercise: 0, activity: 0 };
  for (const kind of ART_KINDS) removed[kind] = deleteArtAliases(kind, queries[kind]);
  setAppState(ALIAS_REPAIR_STATE_KEY, JSON.stringify({ at: new Date().toISOString(), removed, queries }));
  aliasRepairThisTick = undefined;
  return removed;
}

type AliasRepairRecord = { epoch: number; queries: Record<ArtKind, Set<string>> };
let aliasRepairCache: { raw: string; record: AliasRepairRecord | null } | null = null;
// The record as read in the current synchronous span (undefined = not read yet). The
// version map and the warm-up ask once per PWA query; a live record can name hundreds
// of meals, so it is read once per span, not once per query.
let aliasRepairThisTick: AliasRepairRecord | null | undefined;

function aliasRepairRecord(): AliasRepairRecord | null {
  if (aliasRepairThisTick !== undefined) return aliasRepairThisTick;
  const record = readAliasRepairRecord();
  aliasRepairThisTick = record;
  queueMicrotask(() => {
    aliasRepairThisTick = undefined;
  });
  return record;
}

function readAliasRepairRecord(): AliasRepairRecord | null {
  const raw = getAppState(ALIAS_REPAIR_STATE_KEY);
  if (!raw) return null;
  if (aliasRepairCache?.raw === raw) return aliasRepairCache.record;
  let record: AliasRepairRecord | null = null;
  try {
    const parsed = JSON.parse(raw) as { at?: unknown; queries?: Partial<Record<ArtKind, unknown>> };
    const ms = Date.parse(String(parsed?.at ?? ""));
    const queries = { food: new Set<string>(), exercise: new Set<string>(), activity: new Set<string>() };
    for (const kind of ART_KINDS) {
      const list = parsed?.queries?.[kind];
      if (Array.isArray(list)) for (const q of list) if (typeof q === "string" && q) queries[kind].add(q);
    }
    record = { epoch: Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0, queries };
  } catch {
    record = null;
  }
  aliasRepairCache = { raw, record };
  return record;
}

/** Whether the boot repair dropped this query's misfiled alias. */
function aliasRepairedQuery(kind: ArtKind, text: string): boolean {
  return !!aliasRepairRecord()?.queries[kind].has(normalize(text));
}

/** When the repair ran (epoch seconds); 0 when it never did or its record is unreadable. */
function aliasRepairEpoch(): number {
  return aliasRepairRecord()?.epoch || 0;
}

// ---- pre-baked seed-art pack (offline, no key) ----

// Copy any pre-baked images that match THIS database's art queries into the live
// cache, so a fresh seed/demo renders real photos immediately with no Gemini key.
// Offline, idempotent (skips files already present), and a quiet no-op when the
// pack is absent (a slim checkout) or empty. Returns what it did, for logging.
export function installSeedArt(): { installed: number; available: number; matched: number } {
  let available = 0;
  let matched = 0;
  let installed = 0;
  if (!fs.existsSync(SEED_ART_DIR)) return { installed, available, matched };
  try {
    available = fs.readdirSync(SEED_ART_DIR).filter((f) => f.endsWith(".png")).length;
  } catch {
    return { installed, available, matched };
  }
  if (!available) return { installed, available, matched };
  fs.mkdirSync(ART_DIR, { recursive: true });
  for (const { kind, q } of enumeratePwaArt()) {
    const key = cacheKey(kind, q);
    const src = path.join(SEED_ART_DIR, `${key}.png`);
    if (!fs.existsSync(src)) continue;
    matched++;
    const dst = fileForKey(key);
    if (fs.existsSync(dst)) continue; // never clobber a real (or already-installed) image
    try {
      fs.copyFileSync(src, dst);
      installed++;
    } catch {
      /* best-effort */
    }
  }
  return { installed, available, matched };
}

// Generate the image for a single (kind, text) DIRECTLY under its own cache key,
// bypassing the semantic-dedup canonicalization — so the seed-art builder bakes a
// deterministic, alias-free pack (each query → its own file, no art_aliases rows to
// ship). Returns the absolute file path; throws on failure. `force` regenerates even
// when the file already exists. NOT used by the runtime serve/warm path.
//
// Always the BASE model with no style references, whatever the local env says:
// the shipped pack must not vary with one builder's per-kind override, and a
// figurine seeded off whatever happened to be cached locally is not
// reproducible. It still answers to the breaker — a builder loop that keeps
// calling into a dead upstream is exactly the burst this round exists to stop.
export async function pregenerate(kind: ArtKind, text: string, opts: { force?: boolean } = {}): Promise<string> {
  const key = cacheKey(kind, text);
  const file = fileForKey(key);
  if (!opts.force && fs.existsSync(file)) return file;
  const model = GEMINI_IMAGE_MODEL;
  if (artCircuitOpen(model)) throw new Error(`art generation is paused: ${model} circuit is open`);
  try {
    await generate({ key, kind, text }, { model, styleRefs: false });
  } catch (e) {
    noteArtFailure(model, artErrorCode(e));
    throw e;
  }
  noteArtSuccess(model);
  return file;
}

/**
 * The starter-pack builder's generator (src/buildStarterArt.ts): one exercise
 * figure through the SAME prompt the runtime producer sends — stylePrompt with the
 * exercise's ArtContext, pose leading — so a pack figure and a later bespoke one
 * read as one series. Written under the context's own v1 asset key in this
 * process's DATA_DIR/art (the builder's throwaway dir); returns that path, throws
 * on failure. `refFiles` are the pack's anchor figures, sent as style references
 * when the model takes them; an empty list sends none.
 */
export async function pregenerateExerciseFigure(
  name: string,
  context: ArtContext,
  opts: { refFiles?: string[]; model?: string } = {}
): Promise<string> {
  const text = String(name ?? "").trim();
  if (!text) throw new Error("exercise name required");
  const key = exerciseAssetKey(text, context, 1);
  const model = opts.model || GEMINI_IMAGE_MODEL;
  if (artCircuitOpen(model)) throw new Error(`art generation is paused: ${model} circuit is open`);
  const refFiles = STYLE_REFERENCE_MODELS.has(model) && EXERCISE_STYLE_REFS_ENABLED ? (opts.refFiles ?? []) : [];
  try {
    await generate({ key, kind: "exercise", text, context }, { model, refFiles });
  } catch (e) {
    noteArtFailure(model, artErrorCode(e));
    throw e;
  }
  noteArtSuccess(model);
  return fileForKey(key);
}

// ---- starter picture pack (offline, no key) ----

/**
 * Install the starter pack's figure for this exercise into data/art/ as a real
 * asset and point the name's art_index row at it. Returns the installed file, or
 * null when the pack holds no figure for exactly this exercise (src/artStarter.ts
 * is as timid as the guide matcher: expanded key, resolved stored name, or an
 * explicit exercise_aliases link — never a similar movement).
 *
 * Never a generation, so it records nothing in art_usage: the spend ledger is
 * about Gemini calls, and a file copy neither costs nor saves one on an install
 * that may have no key at all. The version is the one the next figure for this
 * name would land under (exerciseTargetVersion), so a name the alias repair
 * re-pointed still moves to a fresh URL, and "Redraw this figure" later bumps past
 * it to a bespoke generation exactly as it would for any other figure.
 */
export function installStarterFigure(text: string): string | null {
  const name = String(text ?? "").trim();
  if (!name) return null;
  let hit: ReturnType<typeof starterFigureFor> = null;
  try {
    hit = starterFigureFor(name);
  } catch {
    return null;
  }
  if (!hit) return null;
  try {
    const key = starterAssetKey(hit);
    const dst = fileForKey(key);
    if (!fs.existsSync(dst)) {
      fs.mkdirSync(ART_DIR, { recursive: true });
      const tmp = `${dst}.tmp-${process.pid}-${crypto.randomUUID()}`;
      fs.copyFileSync(hit.file, tmp);
      fs.renameSync(tmp, dst);
    }
    // Re-stamping an existing asset row would move its created_at (addArtAsset's
    // conflict branch), so a second name sharing this figure leaves it alone.
    if (!getArtAsset(key)) addArtAsset(key, "exercise", hit.entry.name);
    const q = indexQuery(name);
    if (getArtIndex("exercise", q)?.asset_key !== key)
      setArtIndex("exercise", q, key, exerciseTargetVersion(name, false));
    return dst;
  } catch (e: any) {
    log.warn(`[art] starter figure for "${name}" could not be installed: ${e?.message ?? e}`);
    return null;
  }
}

/** A cached exercise figure, else the starter pack's (installed on the way). */
export function exerciseArtPath(text: string): string | null {
  return cachedArtPath("exercise", text) ?? installStarterFigure(text);
}

// ---- upstream failure diagnosis ----
// The pipeline once failed for weeks emitting only "gemini responded 400": the
// response BODY was never captured, so the cause was undiagnosable from the
// field. Every non-OK response now yields a short error CODE (for grouping) and
// a truncated body (for reading), logged once per distinct code and recorded in
// the durable diagnostic spine.

const ERROR_BODY_CHARS = 500;
// Codes already logged this process lifetime — the point is one readable line
// per distinct fault, not one per doomed call.
const loggedErrorCodes = new Set<string>();

/** A short, groupable code for a Gemini failure: "<http>:<api status or hint>". */
export function geminiErrorCode(status: number, rawBody: string): string {
  let hint = "";
  try {
    const parsed = JSON.parse(rawBody);
    hint = String(parsed?.error?.status ?? parsed?.error?.code ?? "").trim();
  } catch {
    /* non-JSON bodies (proxy/HTML errors) fall through to the text hint */
  }
  if (!hint) {
    const words = rawBody.replace(/\s+/g, " ").trim().slice(0, 40);
    hint = words ? crypto.createHash("sha1").update(words).digest("hex").slice(0, 8) : "no_body";
  }
  return `${status}:${hint.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 40)}`;
}

/** Gemini's own error message, when the body is its standard error envelope. */
function geminiErrorMessage(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody);
    const message = String(parsed?.error?.message ?? "").trim();
    if (message) return message;
  } catch {
    /* fall through */
  }
  return rawBody.replace(/\s+/g, " ").trim();
}

/**
 * Turn a non-OK Gemini response into a throwable Error carrying the error code,
 * logging + recording the detail exactly once per distinct (model, code).
 * `operation` is "generate" or "canonicalize".
 */
async function geminiFailure(res: Response, model: string, operation: string): Promise<Error> {
  const rawBody = await res
    .text()
    .then((t) => t.slice(0, ERROR_BODY_CHARS))
    .catch(() => "");
  const code = geminiErrorCode(res.status, rawBody);
  const seenKey = `${model}:${operation}:${code}`;
  if (!loggedErrorCodes.has(seenKey)) {
    loggedErrorCodes.add(seenKey);
    log.warn(`[art] ${operation} failed · ${model} · HTTP ${res.status} · ${code} · body: ${rawBody || "(empty)"}`);
  }
  // The sink coalesces on fingerprint, so this stays one row per fault class.
  // Only Gemini's own error message travels — never the request body/prompt.
  recordDiagnosticEvent({
    source: "worker",
    kind: "art_upstream_error",
    level: "error",
    operation: `art:${operation}`,
    status: res.status,
    fingerprint: `worker:art_upstream_error:${operation}:${model}:${code}`,
    message: `${code}: ${geminiErrorMessage(rawBody).slice(0, 240)}`,
    metadata: { model, error_code: code },
  });
  const error = new Error(`gemini ${operation} responded ${res.status} (${code})`);
  (error as any).artErrorCode = code;
  return error;
}

function artErrorCode(error: unknown): string | null {
  const code = (error as any)?.artErrorCode;
  return typeof code === "string" ? code : null;
}

// ---- style references (pro image model only) ----

/** PNG/JPEG/WebP magic bytes → the mime type the API must be told. */
function sniffImageMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/**
 * Up to STYLE_REFERENCE_LIMIT already-cached exercise images as inline reference
 * parts, so a new figurine joins an existing series instead of restarting it.
 *
 * Shape confirmed against Google's models.generateContent reference: one Content
 * carries several Parts, and a binary part is
 * `{ inlineData: { mimeType, data } }` with base64 `data` — see
 * https://ai.google.dev/api/generate-content.
 *
 * The gate is an OPT-IN: references ride along when GEMINI_EXERCISE_IMAGE_MODEL
 * is set (setting it is the deliberate act of choosing a model for the figurine
 * series), or when the exercise model is on the STYLE_REFERENCE_MODELS allowlist —
 * Nano Banana 2.1, the default since 2026-10-07, takes up to 14 reference images,
 * and with the starter pack's figures installed in data/art a bespoke figure must
 * join that set rather than restart the look. (It once sniffed /pro/i out of the
 * model id, which both missed a capable model named otherwise and would have fired
 * on any future id containing "pro".) A model off the list — the older flash tier —
 * still gets none. ART_EXERCISE_STYLE_REFS=0 opts back out entirely.
 */
export function exerciseStyleRefsEnabled(): boolean {
  if (!EXERCISE_STYLE_REFS_ENABLED) return false;
  return !!GEMINI_EXERCISE_IMAGE_MODEL || STYLE_REFERENCE_MODELS.has(imageModelFor("exercise"));
}

function styleReferenceParts(kind: ArtKind, excludeKey: string): any[] {
  if (kind !== "exercise" || !exerciseStyleRefsEnabled()) return [];
  const files: string[] = [];
  for (const asset of listArtAssets("exercise", 24)) {
    if (asset.key === excludeKey || !isArtAssetKey(asset.key)) continue;
    files.push(fileForKey(asset.key));
  }
  return styleReferencePartsFromFiles(files);
}

/** Up to STYLE_REFERENCE_LIMIT readable images from `files`, introduced as style guidance. */
function styleReferencePartsFromFiles(files: string[]): any[] {
  const parts: any[] = [];
  for (const file of files) {
    if (parts.length >= STYLE_REFERENCE_LIMIT) break;
    try {
      if (!fs.existsSync(file)) continue;
      const stat = fs.statSync(file);
      if (!stat.size || stat.size > STYLE_REFERENCE_MAX_BYTES) continue;
      const buf = fs.readFileSync(file);
      const mimeType = sniffImageMime(buf);
      if (!mimeType) continue;
      parts.push({ inlineData: { mimeType, data: buf.toString("base64") } });
    } catch {
      /* a missing or unreadable reference is never worth failing the generation */
    }
  }
  if (!parts.length) return [];
  return [
    {
      text:
        "The following images are existing figurines from this same series. Match their sculptural style, " +
        "material, palette, lighting and framing exactly, so the new figurine reads as part of the same set. " +
        "Do not copy their pose or subject. The figurine's pose must depict the movement described in the " +
        "prompt text above; these references govern material and style only, never the body position.",
    },
    ...parts,
  ];
}

// `opts` exists for the pack builders: the seed pack pins the base model and
// refuses style references so the shipped images are reproducible (see
// pregenerate); the starter pack hands in its own anchor figures as the
// references (`refFiles`, see pregenerateExerciseFigure).
async function generate(
  job: Job,
  opts: { model?: string; styleRefs?: boolean; refFiles?: string[] } = {}
): Promise<void> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error("Gemini API key missing");
  const model = opts.model ?? imageModelFor(job.kind);
  const refs = opts.refFiles
    ? styleReferencePartsFromFiles(opts.refFiles)
    : opts.styleRefs === false
      ? []
      : styleReferenceParts(job.kind, job.key);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);
  let body: any = null;
  try {
    const res = await fetch(imageUrlFor(model), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: stylePrompt(job.kind, job.text, job.context) }, ...refs],
          },
        ],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw await geminiFailure(res, model, "generate");
    body = await res.json().catch(() => null);
  } finally {
    clearTimeout(timer);
  }
  // Defensive parse: find the first part carrying inline image data.
  const parts = body?.candidates?.[0]?.content?.parts;
  const imagePart = Array.isArray(parts) ? parts.find((p: any) => p?.inlineData?.data) : null;
  const b64 = imagePart?.inlineData?.data;
  if (!b64 || typeof b64 !== "string") throw new Error("no inline image in response");

  const buf = Buffer.from(b64, "base64");
  if (!buf.length) throw new Error("empty image payload");

  // Atomic write: tmp file in the same dir, then rename over the final name.
  fs.mkdirSync(ART_DIR, { recursive: true });
  const file = fileForKey(job.key);
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}
