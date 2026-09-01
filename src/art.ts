import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  getSettings, getGeminiApiKey, listExercises, listMealPlans, listFoodNotes, listActivities,
  getArtAlias, setArtAlias, addArtAsset, listArtAssets, recordArtUsage, recordDiagnosticEvent,
} from "./repo.js";
import { artCircuitOpen, noteArtFailure, noteArtSuccess, onArtCircuitClose } from "./artCircuit.js";

// Generated artwork service: photoreal/stylized PNGs for foods, exercises, and
// activities via Google's gemini-3.1-flash-image ("nano banana 2"), cached on
// disk under data/art/. Entirely optional — without a Gemini key (Settings,
// GEMINI_API_KEY, or GOOGLE_AI_KEY), or with settings.art_enabled off, every
// miss is a quiet 204 and nothing runs.
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
export const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";
// gemini-3.6-flash: the current stable Gemini Flash-tier model.
export const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-3.6-flash";
// Optional per-kind override for EXERCISE art only. Unset (the default) means
// exercise art uses GEMINI_IMAGE_MODEL like every other kind. The recommended
// value is "gemini-3-pro-image" (verified against Google's published model and
// pricing pages on 2026-08-23): the clay-figurine series reads as one set only
// when successive figures share a sculptural language, and the pro image model
// both holds style better and accepts reference images (see styleReferenceParts).
export const GEMINI_EXERCISE_IMAGE_MODEL = process.env.GEMINI_EXERCISE_IMAGE_MODEL || "";
// Setting the override is the opt-in to style references; this is the escape
// hatch for an override model that doesn't take them.
const EXERCISE_STYLE_REFS_ENABLED = process.env.ART_EXERCISE_STYLE_REFS !== "0";
const GEMINI_TEXT_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent`;
const GENERATE_TIMEOUT_MS = 60_000;
const TEXT_TIMEOUT_MS = 20_000;

/** The image model that generates this kind: the exercise override, else the default. */
export function imageModelFor(kind: ArtKind): string {
  return kind === "exercise" && GEMINI_EXERCISE_IMAGE_MODEL ? GEMINI_EXERCISE_IMAGE_MODEL : GEMINI_IMAGE_MODEL;
}

/** What one image of this kind costs to generate, for the spend ledger. */
export function imageCostFor(kind: ArtKind): number {
  return kind === "exercise" && GEMINI_EXERCISE_IMAGE_MODEL ? EXERCISE_IMAGE_COST_USD : IMAGE_COST_USD;
}

function imageUrlFor(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

// Cost estimates for the spend ledger (art_usage). Flash image bills a flat
// ~1290 output tokens per image; text rates are USD per 1M tokens. All
// env-overridable so a price change doesn't need a code change.
// Rates below are Google's published list prices for gemini-3.1-flash-image
// ($0.067 per generated image) and the Gemini 3.x Flash text tier ($0.75 per M
// input / $3.75 per M output), as of 2026-08.
const IMAGE_COST_USD = Number(process.env.ART_IMAGE_COST_USD || 0.067);
// A mixed-model setup is mispriced by one flat rate: with the exercise override
// in play, exercise images bill at the override model's rate (gemini-3-pro-image
// is $0.134 per 1K/2K image as of 2026-08) while food and activity still bill at
// the flash rate. Unset falls back to ART_IMAGE_COST_USD, so a single-model
// install is unchanged.
const EXERCISE_IMAGE_COST_USD =
  Number(process.env.ART_EXERCISE_IMAGE_COST_USD || 0) || IMAGE_COST_USD;
const TEXT_IN_USD_PER_M = Number(process.env.ART_TEXT_IN_USD_PER_M || 0.75);
const TEXT_OUT_USD_PER_M = Number(process.env.ART_TEXT_OUT_USD_PER_M || 3.75);

// Up to this many already-generated exercise images ride along as style
// references when the pro image model is in play.
const STYLE_REFERENCE_LIMIT = 3;
const STYLE_REFERENCE_MAX_BYTES = 2_000_000;

export const ART_KINDS = ["food", "exercise", "activity"] as const;
export type ArtKind = (typeof ART_KINDS)[number];

export function isArtKind(kind: string): kind is ArtKind {
  return (ART_KINDS as readonly string[]).includes(kind);
}

// Optional generation context. Only the exercise kind uses it today: a classified
// muscle group + implement sharpens the clay-figurine prompt WITHOUT changing the
// cache key (the key is still sha1(kind:name)), so the bare-name query still hits it.
export interface ArtContext {
  muscle_group?: string | null;
  equipment?: string | null;
  // A one-or-two-sentence description of the MOVEMENT itself, taken from the
  // exercise's how-to guide (setup + move). The name alone under-specifies a
  // pose — "Cable Lateral Raise" rendered as a plank, because the style
  // references were the only pose signal the model had. Like the rest of this
  // context it never touches `key`.
  pose?: string | null;
}

// How much of the movement description rides along. Long enough for a setup and
// a move sentence, short enough that it can't drown the styling text.
const POSE_MAX_CHARS = 220;

// A compact " — the pose: <movement description>" clause for the exercise prompt.
// Sanitized to a single plain sentence run: no newlines, no runaway length.
export function exercisePoseClause(context?: ArtContext | null): string {
  const raw = String(context?.pose ?? "").replace(/\s+/g, " ").trim();
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

// Baked-in style prompts per kind. Caller text feeds the image prompt only —
// it never influences the filesystem path beyond the sha1 cache key. `context`
// (exercise only) enriches the prompt without touching that key.
export function stylePrompt(kind: ArtKind, text: string, context?: ArtContext | null): string {
  switch (kind) {
    case "food":
      return `Professional studio food photography of ${text}. Plated on simple cream ceramic, centered, soft diffused natural light, photographed against a seamless warm cream studio background (#F4EFE6), gentle soft shadow beneath the dish, slightly elevated three-quarter angle, appetizing, hyper-detailed, no text, no hands, no props other than the dish. Square 1:1.`;
    case "exercise":
      return `Hand-sculpted matte clay figurine of a person performing ${text}${exerciseContextClause(context)}${exercisePoseClause(context)}, terracotta and warm earthen tones, minimalist studio product photograph on a seamless warm cream background (#F4EFE6), soft diffused light, gentle shadow, editorial, no text. Square 1:1.`;
    case "activity":
      return `Hand-sculpted matte clay figurine of a person doing ${text}, terracotta and warm earthen tones, minimalist studio product photograph on a seamless warm cream background (#F4EFE6), soft diffused light, gentle shadow, editorial, no text. Square 1:1.`;
  }
}

function normalize(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, " ");
}

export function cacheKey(kind: ArtKind, text: string): string {
  return crypto.createHash("sha1").update(`${kind}:${normalize(text)}`).digest("hex");
}

function fileForKey(key: string): string {
  return path.join(ART_DIR, `${key}.png`);
}

// Absolute path to the cached PNG, or null when not (yet) generated. Resolves
// through art_aliases, so any phrasing already mapped to an existing asset
// serves that asset's file.
export function cachedArtPath(kind: ArtKind, text: string): string | null {
  const direct = fileForKey(cacheKey(kind, text));
  if (fs.existsSync(direct)) return direct;
  const aliasKey = getArtAlias(kind, normalize(text));
  if (aliasKey) {
    const file = fileForKey(aliasKey);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// ---- serial generation queue (in-flight dedup by cache key) ----
interface Job {
  key: string;
  kind: ArtKind;
  text: string;
  context?: ArtContext | null; // exercise-only prompt enrichment; never affects `key`
}

const queue: Job[] = [];
const inFlight = new Set<string>(); // queued or generating, by cache key
// Keys that failed this process lifetime, mapped to the image model that failed
// them — don't hammer the API; a server restart clears the map so a retry is
// allowed. So does that model's circuit breaker closing: an outage that fails
// 300 keys must not need a restart to recover. Keys are cleared per model, so a
// recovering flash model doesn't un-park keys still waiting on a broken pro one.
const failed = new Map<string, string>();
onArtCircuitClose((model) => {
  for (const [key, failedModel] of failed) if (failedModel === model) failed.delete(key);
});

// Enqueue background generation for a cache miss. Returns true if the request
// was queued (or already in flight); false when generation is unavailable
// (no key / disabled / known-failed) or the file already exists.
export function requestArt(kind: ArtKind, text: string): boolean {
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

// Generate muscle-group/equipment-aware art for a just-classified exercise, under
// the BARE-NAME cache key (so the PWA's plain `?q=<name>` request resolves straight
// to it — no alias needed, no key drift). Called by the background 'exercise'
// enrichment job. Degrades exactly like requestArt (no key / art disabled / known-
// failed → no-op) and never double-pays: skips when the image already exists (a
// recovery re-run, or the serve path beat it) or is in flight. Records the spend
// ledger like the serve path. Returns true only when it generated a new image.
export async function warmExerciseArt(name: string, context?: ArtContext | null): Promise<boolean> {
  return warmArtUnderName("exercise", name, context);
}

/**
 * Force a fresh image for an existing (kind, q) under its own cache key: drop the
 * cached file, forget the key's failure, generate again. The repair path for a
 * figurine that came back wrong (a lateral raise rendered as a plank). Respects
 * the circuit breaker and records the spend exactly like the warm path — a
 * regeneration is a paid generation. Returns true only when a new image landed.
 */
export async function regenerateArt(kind: ArtKind, q: string, context?: ArtContext | null): Promise<boolean> {
  return warmArtUnderName(kind, q, context, true);
}

// The shared body behind warmExerciseArt and regenerateArt: generate under the
// BARE query's own key. `force` drops the cached file and the known-failed mark
// first; without it an existing image or a known failure is a no-op.
async function warmArtUnderName(
  kind: ArtKind,
  name: string,
  context?: ArtContext | null,
  force = false,
): Promise<boolean> {
  const text = String(name ?? "").trim();
  if (!text) return false;
  if (!getGeminiApiKey()) return false;
  if (!getSettings().art_enabled) return false;
  const model = imageModelFor(kind);
  if (artCircuitOpen(model)) return false;
  const key = cacheKey(kind, text);
  if (inFlight.has(key)) return false;              // the serve queue is already on it
  if (force) {
    failed.delete(key);
    try { fs.rmSync(fileForKey(key), { force: true }); } catch { /* a file we can't drop we can still overwrite */ }
  } else {
    if (failed.has(key)) return false;
    if (fs.existsSync(fileForKey(key))) return false; // already generated (enriched or name-only)
  }
  inFlight.add(key);
  try {
    await generate({ key, kind, text, context });
  } catch (e: any) {
    failed.set(key, model);
    noteArtFailure(model, artErrorCode(e));
    recordArtUsage({ kind, query: normalize(text), action: "fail", model });
    console.warn(`[art] ${kind} art failed for "${text}": ${e?.message ?? e}`);
    return false;
  } finally {
    inFlight.delete(key);
  }
  recordGeneration(kind, key, normalize(text), normalize(text), model);
  return true;
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
      kind, query, asset_key: key,
      action: "generate", model, est_cost_usd: imageCostFor(kind),
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
    console.warn(`[art] generated ${kind} "${query}" but could not record it: ${e?.message ?? e}`);
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
        const r = await resolveConcept(job);
        if (!r.reused) {
          await generate({ key: r.key, kind: job.kind, text: r.text });
          recordGeneration(job.kind, r.key, normalize(r.text), normalize(job.text), model);
        }
      } catch (e: any) {
        // A failing job must never break the loop.
        failed.set(job.key, model);
        noteArtFailure(model, artErrorCode(e));
        recordArtUsage({ kind: job.kind, query: normalize(job.text), action: "fail", model });
        console.warn(`[art] generation failed for ${job.kind} "${job.text}": ${e?.message ?? e}`);
      } finally {
        inFlight.delete(job.key);
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

function matcherPrompt(kind: ArtKind, text: string, existing: { text: string }[]): string {
  const list = existing.map((a, i) => `${i}: ${a.text}`).join("\n");
  const strictness =
    kind === "exercise" || kind === "activity"
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

// Resolve a queued query to the asset it should serve: an existing asset
// (reused: true — no image call) or a canonical key/text to generate under.
async function resolveConcept(job: Job): Promise<{ key: string; text: string; reused: boolean }> {
  const norm = normalize(job.text);
  // Comparison window: the 150 most recent assets of this kind. Older assets
  // can still be hit directly or via existing aliases, just not matched anew.
  const existing = listArtAssets(job.kind, 150);
  try {
    const { json, in_tokens, out_tokens } = await geminiText(matcherPrompt(job.kind, job.text, existing));
    recordArtUsage({
      kind: job.kind, query: norm, action: "canonicalize", model: GEMINI_TEXT_MODEL,
      input_tokens: in_tokens, output_tokens: out_tokens, est_cost_usd: textCost(in_tokens, out_tokens),
    });
    const idx = Number(json?.match);
    if (Number.isInteger(idx) && idx >= 0 && idx < existing.length && fs.existsSync(fileForKey(existing[idx].key))) {
      setArtAlias(job.kind, norm, existing[idx].key);
      recordArtUsage({
        kind: job.kind, query: norm, asset_key: existing[idx].key,
        action: "reuse", est_saved_usd: imageCostFor(job.kind),
      });
      return { key: existing[idx].key, text: existing[idx].text, reused: true };
    }
    const canonical = normalize(String(json?.canonical ?? "")).slice(0, 120);
    if (canonical) {
      const key = cacheKey(job.kind, canonical);
      if (key !== cacheKey(job.kind, norm)) setArtAlias(job.kind, norm, key);
      // Two phrasings can canonicalize to the same phrase even when the asset
      // fell outside the comparison window — that's still a cache hit.
      if (fs.existsSync(fileForKey(key))) {
        recordArtUsage({ kind: job.kind, query: norm, asset_key: key, action: "reuse", est_saved_usd: imageCostFor(job.kind) });
        return { key, text: canonical, reused: true };
      }
      return { key, text: canonical, reused: false };
    }
  } catch (e: any) {
    // Record the failure in the existing spend ledger (same "fail" action the
    // image path already uses) so a persistent misconfiguration — e.g. an
    // invalid GEMINI_TEXT_MODEL — shows up as a standing count in
    // GET /api/art/stats / get_art_stats instead of degrading silently
    // forever. `model` is GEMINI_TEXT_MODEL here vs GEMINI_IMAGE_MODEL on an
    // image-generate failure, so the two are distinguishable in the raw
    // art_usage rows even though both roll into the same "failed" total.
    // Falls through to generating under the query's own key exactly as
    // before — no retry, no throw, degradation unchanged.
    recordArtUsage({ kind: job.kind, query: norm, action: "fail", model: GEMINI_TEXT_MODEL });
    console.warn(`[art] canonicalize failed for ${job.kind} "${job.text}": ${e?.message ?? e}`);
  }
  return { key: job.key, text: job.text, reused: false };
}

// ---- cache warm-up ----
// Mirrors the PWA (public/js/) ACT_ART_PHRASE and MUST stay in sync with it: bare
// activity types make ambiguous image prompts ("ride" → horseback), so common
// types map to an explicit phrase. Substring match over the lowercased type,
// in insertion order; no match falls back to the raw type.
const ACT_ART_PHRASE: Record<string, string> = {
  ride: "riding a road bicycle", bike: "riding a road bicycle", cycl: "riding a road bicycle",
  run: "running", jog: "jogging", hike: "hiking with a backpack",
  walk: "walking briskly", swim: "swimming freestyle", row: "rowing on a rowing machine",
  yoga: "holding a yoga pose", climb: "climbing an indoor wall", ski: "cross-country skiing",
};

function actArtText(a: any): string {
  const t = String(a?.type ?? "").toLowerCase();
  for (const k in ACT_ART_PHRASE) if (t.includes(k)) return ACT_ART_PHRASE[k];
  return a?.type || a?.raw_text || "";
}

// The PWA's artImg() truncates every query to 120 chars before hitting
// /api/art — warm-up queries must match or the cache keys diverge.
function pwaQuery(q: any): string {
  return String(q ?? "").trim().slice(0, 120);
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
  const targets = [
    plans.find((p) => p?.status !== "discarded"),
    plans.find((p) => p?.status === "draft"),
  ].filter((p, i, arr) => p && arr.indexOf(p) === i);
  for (const plan of targets) {
    for (const d of Array.isArray(plan?.parsed?.days) ? plan.parsed.days : []) {
      for (const m of Array.isArray(d?.meals) ? d.meals : []) {
        const items = Array.isArray(m?.items) ? m.items.join(", ") : (m?.items || "");
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
export function warmArt(): { queued: number; skipped: number } {
  let queued = 0;
  let skipped = 0;
  for (const { kind, q } of enumeratePwaArt()) {
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
  const rawBody = await res.text().then((t) => t.slice(0, ERROR_BODY_CHARS)).catch(() => "");
  const code = geminiErrorCode(res.status, rawBody);
  const seenKey = `${model}:${operation}:${code}`;
  if (!loggedErrorCodes.has(seenKey)) {
    loggedErrorCodes.add(seenKey);
    console.warn(`[art] ${operation} failed · ${model} · HTTP ${res.status} · ${code} · body: ${rawBody || "(empty)"}`);
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
 * The gate is the OPT-IN itself: references ride along only when
 * GEMINI_EXERCISE_IMAGE_MODEL is set, because setting it is the deliberate act of
 * choosing a model for the figurine series. (It used to sniff /pro/i out of the
 * model id, which both missed a capable model named otherwise and would have
 * fired on any future id containing "pro".) The default flash tier deliberately
 * gets none: it is not documented to take reference images for style transfer,
 * and sending them would change a currently working request shape for every
 * user. ART_EXERCISE_STYLE_REFS=0 opts back out without giving up the override.
 */
function styleReferenceParts(kind: ArtKind, excludeKey: string): any[] {
  if (kind !== "exercise" || !GEMINI_EXERCISE_IMAGE_MODEL || !EXERCISE_STYLE_REFS_ENABLED) return [];
  const parts: any[] = [];
  for (const asset of listArtAssets("exercise", 24)) {
    if (parts.length >= STYLE_REFERENCE_LIMIT) break;
    if (asset.key === excludeKey) continue;
    try {
      const file = fileForKey(asset.key);
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

// `opts` exists for the seed-pack builder, which pins the base model and refuses
// style references so the shipped images are reproducible (see pregenerate).
async function generate(job: Job, opts: { model?: string; styleRefs?: boolean } = {}): Promise<void> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error("Gemini API key missing");
  const model = opts.model ?? imageModelFor(job.kind);
  const refs = opts.styleRefs === false ? [] : styleReferenceParts(job.kind, job.key);

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
            parts: [
              { text: stylePrompt(job.kind, job.text, job.context) },
              ...refs,
            ],
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
