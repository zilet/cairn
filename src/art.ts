import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  getSettings, getGeminiApiKey, listExercises, listMealPlans, listFoodNotes, listActivities,
  getArtAlias, setArtAlias, addArtAsset, listArtAssets, recordArtUsage,
} from "./repo.js";

// Generated artwork service: photoreal/stylized PNGs for foods, exercises, and
// activities via Google's gemini-2.5-flash-image ("nano banana"), cached on
// disk under data/art/. Entirely optional — without a Gemini key (Settings,
// GEMINI_API_KEY, or GOOGLE_AI_KEY) or with
// settings.art_enabled off) every miss is a quiet 204 and nothing runs.
//
// This is a DIRECT REST call (global fetch), NOT an agents.json CLI run, and a
// strictly serial in-process queue with in-flight dedup, mirroring enrich.ts:
// one generation at a time, and a throwing job never breaks the drain loop.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const ART_DIR = path.join(DATA_DIR, "art");

// Model names are env-overridable so a rename doesn't need a code change. The
// text model runs the cheap "would this render the same image?" check before
// any image generation (see resolveConcept below).
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";
const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-3.1-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`;
const GEMINI_TEXT_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent`;
const GENERATE_TIMEOUT_MS = 60_000;
const TEXT_TIMEOUT_MS = 20_000;

// Cost estimates for the spend ledger (art_usage). Flash image bills a flat
// ~1290 output tokens per image; text rates are USD per 1M tokens. All
// env-overridable so a price change doesn't need a code change.
const IMAGE_COST_USD = Number(process.env.ART_IMAGE_COST_USD || 0.039);
const TEXT_IN_USD_PER_M = Number(process.env.ART_TEXT_IN_USD_PER_M || 0.30);
const TEXT_OUT_USD_PER_M = Number(process.env.ART_TEXT_OUT_USD_PER_M || 2.50);

export const ART_KINDS = ["food", "exercise", "activity"] as const;
export type ArtKind = (typeof ART_KINDS)[number];

export function isArtKind(kind: string): kind is ArtKind {
  return (ART_KINDS as readonly string[]).includes(kind);
}

// Baked-in style prompts per kind. Caller text feeds the image prompt only —
// it never influences the filesystem path beyond the sha1 cache key.
function stylePrompt(kind: ArtKind, text: string): string {
  switch (kind) {
    case "food":
      return `Professional studio food photography of ${text}. Plated on simple cream ceramic, centered, soft diffused natural light, photographed against a seamless warm cream studio background (#F4EFE6), gentle soft shadow beneath the dish, slightly elevated three-quarter angle, appetizing, hyper-detailed, no text, no hands, no props other than the dish. Square 1:1.`;
    case "exercise":
      return `Hand-sculpted matte clay figurine of a person performing ${text}, terracotta and warm earthen tones, minimalist studio product photograph on a seamless warm cream background (#F4EFE6), soft diffused light, gentle shadow, editorial, no text. Square 1:1.`;
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
}

const queue: Job[] = [];
const inFlight = new Set<string>(); // queued or generating, by cache key
// Keys that failed this process lifetime — don't hammer the API; a server
// restart clears the set so a retry is allowed.
const failed = new Set<string>();

// Enqueue background generation for a cache miss. Returns true if the request
// was queued (or already in flight); false when generation is unavailable
// (no key / disabled / known-failed) or the file already exists.
export function requestArt(kind: ArtKind, text: string): boolean {
  if (!getGeminiApiKey()) return false;
  if (!getSettings().art_enabled) return false;
  const key = cacheKey(kind, text);
  if (failed.has(key)) return false;
  if (cachedArtPath(kind, text)) return false; // direct hit or alias-resolved hit
  if (inFlight.has(key)) return true; // already queued/generating — dedup
  inFlight.add(key);
  queue.push({ key, kind, text });
  void drain();
  return true;
}

let draining = false;

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const job = queue.shift()!;
      try {
        // An earlier job this drain may have aliased this query onto an
        // asset that now exists — nothing left to do.
        if (cachedArtPath(job.kind, job.text)) continue;
        const r = await resolveConcept(job);
        if (!r.reused) {
          await generate({ key: r.key, kind: job.kind, text: r.text });
          addArtAsset(r.key, job.kind, normalize(r.text));
          recordArtUsage({
            kind: job.kind, query: normalize(job.text), asset_key: r.key,
            action: "generate", model: GEMINI_IMAGE_MODEL, est_cost_usd: IMAGE_COST_USD,
          });
        }
      } catch (e: any) {
        // A failing job must never break the loop.
        failed.add(job.key);
        recordArtUsage({ kind: job.kind, query: normalize(job.text), action: "fail", model: GEMINI_IMAGE_MODEL });
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
    if (!res.ok) throw new Error(`gemini text responded ${res.status}`);
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
        action: "reuse", est_saved_usd: IMAGE_COST_USD,
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
        recordArtUsage({ kind: job.kind, query: norm, asset_key: key, action: "reuse", est_saved_usd: IMAGE_COST_USD });
        return { key, text: canonical, reused: true };
      }
      return { key, text: canonical, reused: false };
    }
  } catch (e: any) {
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

async function generate(job: Job): Promise<void> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error("Gemini API key missing");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);
  let body: any = null;
  try {
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: stylePrompt(job.kind, job.text) }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`gemini responded ${res.status}`);
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
