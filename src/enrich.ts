import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db } from "./db.js";
import { inferHealthDocumentKind, normalizeHealthDocumentKind } from "./healthDocumentKinds.js";
import * as repo from "./repo.js";
import { extractJson, runAgentWithFallback } from "./agents.js";
import { buildEnrichPrompt, buildExerciseEnrichPrompt, buildFoodPhotoPrompt, buildHealthIngestPrompt, buildHealthReviewPrompt, buildGarminStrengthPrompt } from "./prompt.js";
import { explainExercise, reconcileMarkers, synthesizeHealth } from "./coachOps.js";
import { warmExerciseArt } from "./art.js";
import { LB_PER_KG, round2_5 } from "./repo/shared.js";

const execFileP = promisify(execFile);

// Background, in-process enrichment engine.
//
// Free-text logs/notes are saved INSTANTLY by the offline regex parser; this
// engine later runs a coaching agent over each entry to (a) improve its
// structured fields and (b) distill genuinely notable durable facts into the
// `memory` table. It is a SERIAL queue — only one CLI agent runs at a time —
// and degrades gracefully: if enrichment is disabled or no agent is reachable,
// the regex-parsed entry stands untouched and nothing throws.

// 'review' is a follow-on job (no row of its own): after a health document
// enriches successfully, the whole-picture health review is refreshed on the
// same serial queue. id is unused for review jobs.
// 'garmin_strength' reconciles a synced Garmin strength activity into the day's
// Cairn session — id is the garmin_activities row id (no status column of its own).
// 'food_photo' is a 'food' note that carries an attached plate photo (image_path):
// instead of re-parsing free text it hands a VISION agent the absolute image path
// (same trick as the 'health' kind) to estimate the plate's macros. id is the
// food_notes row id; it shares food_notes' enrichment_status machine.
// 'exercise' is a NEW off-plan movement the athlete just added: the job canonicalizes
// the name, classifies muscle group / mode / equipment, warms the how-to guide
// (ai_cache), and pregenerates muscle/equipment-aware art. id is the exercises row id;
// it shares exercises' enrichment_status machine. Enqueued only on a genuine create
// from the user-facing route — never for seed/plan-import.
type Kind = "activity" | "food" | "food_photo" | "health" | "review" | "garmin_strength" | "exercise";
interface Job {
  kind: Kind;
  id: number;
}
interface HealthSource {
  fp: string;
  mime: string;
  kind: string;
  isDir: boolean;
}

const queue: Job[] = [];
let draining = false;

// Re-entry guard: at most ONE review-refresh job sits in the queue at a time.
// Several health docs finishing back-to-back collapse into a single refresh
// (cleared when the review job starts, so data landing mid-run queues the next).
let reviewQueued = false;

// Pure: whether to enqueue a review refresh given the current latch state. Keeps
// the "at most one pending refresh" pile-up guard unit-testable.
export function shouldEnqueueReviewRefresh(alreadyQueued: boolean): boolean {
  return !alreadyQueued;
}

// Pure: only REGENERATE the whole-picture synthesis after new labs when the user has
// ALREADY opted into it (a synthesis exists). Never create one uninvited — pull, not
// push (docs/VISION.md). Extracted so the gate is testable without an agent call.
export function shouldRegenerateSynthesis(existingSynthesis: unknown): boolean {
  return existingSynthesis != null;
}

export function enqueueReviewRefresh(): void {
  if (!shouldEnqueueReviewRefresh(reviewQueued)) return;
  reviewQueued = true;
  queue.push({ kind: "review", id: 0 });
  if (!draining) void drain();
}

// Enrichment is a small structuring task; cap it well under the default agent
// timeout so one hanging agent can't block the whole serial queue for 5 minutes.
const ENRICH_TIMEOUT_MS = 120_000;
// Health ingestion can mean reading a multi-MB PDF or a whole CCDA export folder
// and splitting years of results into panels — give it the fuller agent budget.
const HEALTH_INGEST_TIMEOUT_MS = 300_000;
const GEMINI_FOOD_PHOTO_MODEL = process.env.GEMINI_FOOD_PHOTO_MODEL || process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
const GEMINI_FOOD_PHOTO_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FOOD_PHOTO_MODEL}:generateContent`;
const FOOD_PHOTO_TIMEOUT_MS = 45_000;

// Refuse pathological archives before unzipping (zip-bomb / huge export guard).
const ZIP_MAX_UNCOMPRESSED = 200 * 1024 * 1024; // 200 MB
const ZIP_MAX_FILES = 3000;

function looksLikeZip(fp: string, mime?: string | null): boolean {
  const m = (mime || "").toLowerCase();
  return m === "application/zip" || m === "application/x-zip-compressed" || /\.zip$/i.test(fp);
}

// Unzip an uploaded archive into an isolated sibling folder under uploads, after
// a size/count sanity check. Returns the extraction dir, or null if unzip is
// unavailable / the archive is unsafe / extraction fails (caller then hands the
// agent the raw file instead). Reads happen only inside this dir.
async function unzipToFolder(zipPath: string): Promise<string | null> {
  const destDir = `${zipPath}-x`;
  try {
    // `unzip -l` trailer: "  <total bytes>  <file count> files"
    const { stdout } = await execFileP("unzip", ["-l", zipPath], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    const lines = stdout.trim().split("\n");
    const last = lines[lines.length - 1] || "";
    const mTotal = last.match(/^\s*(\d+)\s+(\d+)\s+files?/i);
    if (mTotal) {
      const total = Number(mTotal[1]);
      const count = Number(mTotal[2]);
      if (total > ZIP_MAX_UNCOMPRESSED || count > ZIP_MAX_FILES) {
        console.warn(`[enrich] zip too large to ingest (${total} bytes, ${count} files) — skipping unpack.`);
        return null;
      }
    }
    fs.mkdirSync(destDir, { recursive: true });
    // -o overwrite, -qq quiet; modern unzip sanitizes path traversal, and we only
    // ever read back from destDir regardless.
    await execFileP("unzip", ["-o", "-qq", zipPath, "-d", destDir], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    return destDir;
  } catch (e: any) {
    console.warn(`[enrich] unzip failed (${e?.code ?? e?.message ?? e}) — handing the archive to the agent as-is.`);
    return null;
  }
}

// Coerce agent-provided values defensively — the model may return numbers as
// strings ("45"), oversized notes, or junk. Keep regex values when unusable.
const asNum = (v: any): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const asStr = (v: any): string | undefined => {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s ? s.slice(0, 1000) : undefined;
};

// ---- Garmin strength: deterministic kg→lb + naming ----------------------------
// Garmin records detected-set weight in KG (exercise_sets[].weight_kg). Converting
// it lives HERE, in code — not delegated to the LLM, where a dropped "× 2.2" silently
// corrupts every load. The agent only adds the one-line narrative + better naming.

// kg → lb, rounded to the nearest 2.5 lb plate (shared LB_PER_KG + round2_5).
// null/0 kg → null (bodyweight); we never invent a negative (assist) weight from a
// Garmin set — only a hand log / the agent can mark an assist.
function kgToLb(weightKg: number | null | undefined): number | null {
  const kg = typeof weightKg === "number" ? weightKg : Number(weightKg);
  if (!Number.isFinite(kg) || kg <= 0) return null; // null/0/junk → bodyweight
  return round2_5(kg * LB_PER_KG);
}

// A label from Garmin's UPPER_SNAKE category (or its name field), e.g.
// "BENCH_PRESS" → "bench press". We only de-snake here; findOrCreateExercise →
// cleanExerciseName does the canonical Title-Case (with the DB/BB/RDL acronym table)
// and folds it onto an existing movement — so we must NOT case it ourselves (a naive
// pass would render "DB_PRESS" as "Db Press", disagreeing with the canon).
function garminExerciseName(set: any): string | null {
  const raw = (set?.name ?? set?.category ?? "").toString().trim();
  if (!raw) return null;
  return raw.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || null;
}

// A Garmin detected set looks like a timed hold when it carries a duration but no
// rep count (plank / dead hang / wall sit) — mirrors the agent prompt's rule.
function garminSetIsTimed(set: any): boolean {
  const reps = asNum(set?.reps);
  const dur = asNum(set?.duration_sec);
  return (reps == null || reps === 0) && dur != null && dur > 0;
}

// Deterministically log Garmin's detected exercise sets into the day's session,
// converting kg→lb in CODE. Skips any exercise already logged (the `already` guard
// is shared with the agentic pass below so neither double-logs). Returns the count
// logged. Runs EVEN WITH NO AGENT — the sets are facts, not a coaching opinion.
function logGarminDetectedSets(ga: any, already: Set<string>): number {
  const sets = Array.isArray(ga?.exercise_sets) ? ga.exercise_sets : [];
  if (!sets.length) return 0;
  let logged = 0;
  for (const set of sets) {
    const name = garminExerciseName(set);
    if (!name || already.has(name.toLowerCase())) continue;
    const timed = garminSetIsTimed(set);
    const reps = asNum(set?.reps);
    const duration = asNum(set?.duration_sec);
    const weight = timed ? null : kgToLb(set?.weight_kg);
    // Must carry something loggable for its mode (reps OR a converted load for a
    // reps set; a duration for a timed hold). Otherwise skip — never log an empty set.
    if (timed ? duration == null : reps == null && weight == null) continue;
    try {
      repo.logSetByName({
        exercise: name,
        weight: timed ? null : weight,
        reps: timed ? null : reps ?? null,
        duration_sec: timed ? duration ?? null : null,
        exercise_mode: timed ? "timed" : "reps",
        date: ga.date,
      });
      already.add(name.toLowerCase()); // never duplicate within this pass
      logged++;
    } catch {
      /* one bad set shouldn't fail the job */
    }
  }
  return logged;
}

// Push a job and start the drain loop if it isn't already running.
export function enqueueEnrich(kind: Kind, id: number): void {
  queue.push({ kind, id });
  if (!draining) void drain();
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const job = queue.shift()!;
      try {
        await processJob(job);
      } catch (e: any) {
        // A failing job must never break the loop. Mark it failed (regex data
        // is left intact) and continue with the next.
        try {
          markFailed(job);
        } catch {
          /* ignore */
        }
        console.error(`[enrich] job ${job.kind}#${job.id} failed: ${e?.message ?? e}`);
      }
    }
  } finally {
    draining = false;
  }
}

function markStatus(job: Job, status: string): void {
  if (job.kind === "review" || job.kind === "garmin_strength") return; // no row status of their own
  if (job.kind === "activity") repo.setActivityEnrichStatus(job.id, status);
  // food_photo shares the food_notes row + its status column with food.
  else if (job.kind === "food" || job.kind === "food_photo") repo.setFoodNoteEnrichStatus(job.id, status);
  else if (job.kind === "exercise") repo.setExerciseEnrichStatus(job.id, status);
  else repo.setHealthDocEnrichStatus(job.id, status);
}

function markFailed(job: Job): void {
  markStatus(job, "failed");
}

function healthDocHasStructuredContent(id: number): boolean {
  const row = repo.getHealthDocumentRaw(id) as any;
  if (!row) return false;
  const parsed = row.parsed_json && typeof row.parsed_json === "object"
    ? row.parsed_json
    : (() => {
      try {
        return row.parsed_json ? JSON.parse(String(row.parsed_json)) : null;
      } catch {
        return null;
      }
    })();
  return (
    (Array.isArray(parsed?.markers) && parsed.markers.length > 0) ||
    (Array.isArray(parsed?.clinical_facts) && parsed.clinical_facts.length > 0) ||
    (Array.isArray(parsed?.panels) && parsed.panels.some((p: any) =>
      (Array.isArray(p?.markers) && p.markers.length > 0) ||
      (Array.isArray(p?.clinical_facts) && p.clinical_facts.length > 0)
    ))
  );
}

async function processJob(job: Job): Promise<void> {
  if (job.kind === "review") return processReviewJob();
  if (job.kind === "garmin_strength") return processGarminStrengthJob(job.id);
  if (job.kind === "food_photo") return processFoodPhotoJob(job.id);
  if (job.kind === "exercise") return processExerciseJob(job.id);

  // Check enablement BEFORE picking an agent: pickAgentOrder() advances the
  // round-robin cursor as a side effect, so calling it for a job we then skip
  // would burn rotation state against a phantom invocation.
  const settings = repo.getSettings();
  if (!settings.enrich_enabled) {
    if (job.kind === "health") {
      const backfill = repo.backfillCcdaHealthDocument(job.id);
      if (backfill.wrote) {
        console.log(`[enrich] health#${job.id}: deterministic CCDA backfill wrote ${backfill.clinicalFacts} fact(s), ${backfill.vitalMarkers} vital marker(s), ${backfill.bpReadings}/${backfill.extractedBpReadings} BP row(s) (agent enrichment off).`);
        markStatus(job, "done");
        try { repo.deriveDirectives(); } catch (e: any) { console.warn(`[enrich] deriveDirectives failed: ${e?.message}`); }
        enqueueReviewRefresh();
        return;
      }
    }
    markStatus(job, "skipped");
    return;
  }
  // Health-record ingestion is accuracy-critical (a curated panel silently drops
  // markers), so it deterministically prefers the strongest faithful transcriber
  // (Claude-first) instead of the load-spreading round-robin. Other kinds rotate.
  const order = job.kind === "health" ? repo.pickHealthAgentOrder() : repo.pickAgentOrder();
  if (!order.length) {
    if (job.kind === "health") {
      const backfill = repo.backfillCcdaHealthDocument(job.id);
      if (backfill.wrote) {
        console.log(`[enrich] health#${job.id}: deterministic CCDA backfill wrote ${backfill.clinicalFacts} fact(s), ${backfill.vitalMarkers} vital marker(s), ${backfill.bpReadings}/${backfill.extractedBpReadings} BP row(s) (no usable agent).`);
        markStatus(job, "done");
        try { repo.deriveDirectives(); } catch (e: any) { console.warn(`[enrich] deriveDirectives failed: ${e?.message}`); }
        enqueueReviewRefresh();
        return;
      }
    }
    // No usable agent → skip, keep the regex parse as-is.
    markStatus(job, "skipped");
    return;
  }

  // Build the prompt. Health jobs hand the agent an absolute path to read (a file,
  // or an unpacked archive folder) and ask it to split multi-date history into
  // panels; activity/food jobs hand it the raw free-text entry.
  let prompt: string;
  let timeoutMs = ENRICH_TIMEOUT_MS;
  // Track an unpacked archive dir so we can always remove it after the agent runs
  // — an Apple Health export is hundreds of MB and would otherwise fill a Pi's disk.
  let extractedDir: string | null = null;
  // Carry the health source out of the branch so the completeness retry below can
  // re-read it (text sources only) and re-prompt without re-deriving the path.
  let healthSource: HealthSource | null = null;
  let ccdaExtraction: ReturnType<typeof repo.extractCcdaHealthData> | null = null;
  if (job.kind === "health") {
    const row = repo.getHealthDocumentRaw(job.id) as any;
    const fp = (row?.file_path ?? "").toString().trim();
    if (!fp) {
      // No binary on disk (e.g. a client-recorded analysis); nothing to read.
      markStatus(job, "skipped");
      return;
    }
    // Uploaded files are always stored as an absolute path under UPLOADS_DIR.
    // Refuse anything else rather than resolving it relative to cwd — that's the
    // only thing keeping the agent's file read constrained to uploaded docs.
    if (!path.isAbsolute(fp)) {
      markStatus(job, "skipped");
      return;
    }
    // Mark in-progress before any slow work (unzip / agent) so a crash leaves a
    // recoverable marker rather than a stuck 'pending'.
    markStatus(job, "in_progress");
    let target = fp;
    let isDir = false;
    if (looksLikeZip(fp, row?.mime)) {
      const dir = await unzipToFolder(fp);
      if (dir) { target = dir; isDir = true; extractedDir = dir; }
    }
    healthSource = { fp: target, mime: (row?.mime ?? "").toString(), kind: row?.kind || "other", isDir };
    try {
      ccdaExtraction = repo.extractCcdaHealthData(target);
      if (ccdaExtraction.files && (ccdaExtraction.clinical_facts.length || ccdaExtraction.vitals_panels.length)) {
        console.log(`[enrich] health#${job.id}: deterministic CCDA found ${ccdaExtraction.clinical_facts.length} fact(s), ${ccdaExtraction.vitals_panels.length} vitals panel(s), ${ccdaExtraction.blood_pressure_readings.length} BP reading(s).`);
      }
    } catch (e: any) {
      console.warn(`[enrich] health#${job.id}: deterministic CCDA extraction skipped (${e?.message ?? e}).`);
      ccdaExtraction = null;
    }
    prompt = buildHealthIngestPrompt(target, isDir, row?.kind || "other");
    timeoutMs = HEALTH_INGEST_TIMEOUT_MS;
  } else {
    const raw = jobRawText(job);
    if (!raw) {
      // Nothing to enrich from; treat as not-applicable.
      markStatus(job, "skipped");
      return;
    }
    prompt = buildEnrichPrompt(job.kind, raw);
    // Mark in-progress BEFORE the first await: if the process is killed mid-flight
    // the row carries a recoverable marker (recoverPendingEnrich picks 'in_progress'
    // up too) instead of being stuck 'pending' forever.
    markStatus(job, "in_progress");
  }

  let parsed: any = null;
  try {
    const fb = await runAgentWithFallback(order, prompt, timeoutMs);
    parsed = fb.result?.parsed ?? null;
  } catch {
    parsed = null;
  } finally {
    // Always remove an unpacked archive dir (could be hundreds of MB) once the
    // agent has read it — whether the run succeeded, failed, or threw.
    if (extractedDir) {
      try { fs.rmSync(extractedDir, { recursive: true, force: true }); }
      catch (e: any) { console.warn(`[enrich] failed to clean up ${extractedDir}: ${e?.message ?? e}`); }
    }
  }

  if (!parsed || typeof parsed !== "object") {
    if (job.kind === "health" && ccdaExtraction) {
      const backfill = repo.applyCcdaHealthBackfill(job.id, ccdaExtraction);
      if (backfill.wrote) {
        console.warn(`[enrich] health#${job.id}: agent returned no usable JSON; deterministic CCDA backfill wrote ${backfill.clinicalFacts} fact(s), ${backfill.vitalMarkers} vital marker(s), ${backfill.bpReadings}/${backfill.extractedBpReadings} BP row(s).`);
        markStatus(job, "done");
        try { repo.deriveDirectives(); } catch (e: any) { console.warn(`[enrich] deriveDirectives failed: ${e?.message}`); }
        enqueueReviewRefresh();
        return;
      }
    }
    if (job.kind === "health") {
      const fallback = applyTextVisitNoteFallback(job.id, healthSource);
      if (fallback.applied) {
        console.warn(`[enrich] health#${job.id}: agent returned no usable JSON; deterministic visit-note fallback wrote ${fallback.facts} fact(s).`);
        markStatus(job, "done");
        try { repo.deriveDirectives(); } catch (e: any) { console.warn(`[enrich] deriveDirectives failed: ${e?.message}`); }
        enqueueReviewRefresh();
        return;
      }
    }
    if (job.kind === "health" && healthDocHasStructuredContent(job.id)) {
      console.warn(`[enrich] health#${job.id}: agent returned no usable JSON; kept existing structured ingest.`);
      markStatus(job, "done");
      return;
    }
    markStatus(job, "failed");
    return;
  }

  // Completeness guard: a weaker model can curate a 100+ marker panel down to "the
  // interesting ones". When the extraction looks grossly short for the source, re-run
  // ONCE — Claude-first, with an explicit "you missed many" nudge — and keep whichever
  // attempt captured more markers. Two thresholds feed the SAME single-file retry:
  //   • text/plain — we can estimate the source's own marker count (repo.estimateMarkerCandidates),
  //     so the trigger is precise: extracted < 80% of an estimate of ≥40.
  //   • PDF / image — we can't count candidates on a binary, so the trigger is a
  //     conservative absolute FLOOR: a comprehensive panel (bloodwork) that came back
  //     with very few markers is suspiciously thin; a genuinely small panel (or a DEXA /
  //     other doc, which legitimately carries few rows) is left alone so we don't waste
  //     a re-run. An unpacked archive (isDir) is never retried — too many source files
  //     to attribute a single count to.
  if (healthSource && !healthSource.isDir) {
    const got = countIngestMarkers(parsed);
    const isText = /^text\/plain/i.test(healthSource.mime);
    let shouldRetry = false;
    let expected = 0;
    if (isText) {
      try { expected = repo.estimateMarkerCandidates(fs.readFileSync(healthSource.fp, "utf8")); }
      catch { /* unreadable → no estimate, no text-path retry */ }
      shouldRetry = expected >= 40 && got < expected * 0.8;
    } else if (looksThinForBinaryHealthDoc(healthSource.kind, got)) {
      // No countable source → conservative absolute floor for a comprehensive panel.
      shouldRetry = true;
    }
    if (shouldRetry) {
      const why = isText ? `the source lists ~${expected}` : `a comprehensive panel should carry far more`;
      console.warn(`[enrich] health#${job.id}: extracted ${got} markers but ${why} — retrying Claude-first for completeness.`);
      try {
        const fb2 = await runAgentWithFallback(
          repo.pickHealthAgentOrder(),
          buildHealthIngestPrompt(healthSource.fp, false, healthSource.kind, { emphasizeCompleteness: true, missed: { got, expected } }),
          HEALTH_INGEST_TIMEOUT_MS,
        );
        const parsed2 = fb2.result?.parsed ?? null;
        const got2 = parsed2 && typeof parsed2 === "object" ? countIngestMarkers(parsed2) : 0;
        if (got2 > got) {
          parsed = parsed2;
          console.log(`[enrich] health#${job.id}: retry improved extraction ${got} → ${got2} markers.`);
        }
      } catch { /* keep the first parse */ }
    }
  }

  // Apply the structured fields the agent provided; keep regex values otherwise.
  // Health docs carry a top-level `summary` alongside `structured`, so they take
  // a dedicated apply path.
  const appliedFields =
    job.kind === "health" ? applyHealthIngest(job.id, parsed) : applyStructured(job, parsed.structured);
  const ccdaBackfill =
    job.kind === "health" && ccdaExtraction ? repo.applyCcdaHealthBackfill(job.id, ccdaExtraction) : null;
  if (ccdaBackfill?.wrote) {
    console.log(`[enrich] health#${job.id}: deterministic CCDA backfill wrote ${ccdaBackfill.clinicalFacts} fact(s), ${ccdaBackfill.vitalMarkers} vital marker(s), ${ccdaBackfill.bpReadings}/${ccdaBackfill.extractedBpReadings} BP row(s).`);
  }

  // Add each genuinely-new memory item (the prompt instructs the agent to skip
  // anything already on record; addMemory also dedupes exact repeats).
  let addedMemory = 0;
  if (Array.isArray(parsed.memory)) {
    for (const m of parsed.memory) {
      const content = (m?.content ?? "").toString().trim();
      if (!content) continue;
      try {
        repo.addMemory(content, m?.kind || "observation", "enrich");
        addedMemory++;
      } catch {
        /* one bad memory item shouldn't fail the job */
      }
    }
  }

  let fallbackApplied = false;
  if (job.kind === "health" && !appliedFields && !addedMemory && !ccdaBackfill?.wrote) {
    const fallback = applyTextVisitNoteFallback(job.id, healthSource);
    if (fallback.applied) {
      fallbackApplied = true;
      addedMemory += fallback.addedMemory;
      console.warn(`[enrich] health#${job.id}: agent returned no usable health ingest; deterministic visit-note fallback wrote ${fallback.facts} fact(s).`);
    }
  }

  // Parseable JSON of the wrong shape (e.g. a coach-proposal response) yields no
  // fields and no memory — the regex parse stands. Surface it rather than letting
  // a silent no-op masquerade as a successful enrichment.
  if (!appliedFields && !addedMemory && !ccdaBackfill?.wrote && !fallbackApplied) {
    // For a HEALTH doc this is not a benign no-op: the doc has no regex fallback
    // (the markers are the whole point), so a wrong-shape response that wrote
    // nothing must NOT read as 'done' — that would make a doc with dropped markers
    // look ingested. Mark it 'failed' so the surface shows it didn't take and a
    // re-trigger can retry. activity/food keep their regex parse, so 'done' is fine.
    if (job.kind === "health") {
      if (healthDocHasStructuredContent(job.id)) {
        console.warn(`[enrich] health#${job.id}: agent returned parseable JSON but no markers/summary/memory (wrong shape?) — kept existing structured ingest.`);
        markStatus(job, "done");
        return;
      }
      console.warn(`[enrich] health#${job.id}: agent returned parseable JSON but no markers/summary/memory (wrong shape?) — marking failed (nothing ingested).`);
      markStatus(job, "failed");
      return;
    }
    console.warn(`[enrich] ${job.kind}#${job.id}: agent returned parseable JSON but nothing usable (wrong shape?) — kept regex parse.`);
  }

  markStatus(job, "done");

  // A health document successfully analyzed means new marker data. Re-run the
  // deterministic markers→directives propagation (idempotent: clears + re-derives
  // only the 'markers' source) so the connected brain reflects the latest panel
  // without waiting for a manual Derive, then refresh the whole-picture health
  // review as a follow-on job on this same serial queue. Never for activity/food.
  if (job.kind === "health") {
    // First, let the agent align any new analyte synonyms this lab introduced
    // (e.g. an abbreviation the KB never saw) so the merged series feed everything
    // below. Fail-open: the deterministic normalizer + KB already ran at read time.
    try { await reconcileMarkers("auto"); } catch (e: any) { console.warn(`[enrich] marker reconcile failed: ${e?.message}`); }
    try { repo.deriveDirectives(); } catch (e: any) { console.warn(`[enrich] deriveDirectives failed: ${e?.message}`); }
    // deriveDirectives() busts today's cached Brief itself (a lab reshapes the read).
    enqueueReviewRefresh();
  }
}

// Refresh the whole-picture health review after a health doc enriched. Failures
// log and no-op — the previous review stands, and the triggering document's
// 'done' status is never touched because of a review problem.
async function processReviewJob(): Promise<void> {
  reviewQueued = false; // a health doc finishing while we run may queue the next refresh
  const settings = repo.getSettings();
  if (!settings.enrich_enabled) return;
  // Faithful clinical reading matters more than spreading load: default the whole-picture
  // health review to the Claude-first health order (an explicit `health` pin still wins),
  // NOT the round-robin rotation.
  const order = repo.pickHealthAgentOrder();
  if (!order.length) return;

  const prompt = buildHealthReviewPrompt();
  let agent: string | null = null;
  let raw: string | undefined;
  let parsed: any = null;
  try {
    const fb = await runAgentWithFallback(order, prompt, ENRICH_TIMEOUT_MS);
    agent = fb.agent ?? null;
    raw = fb.result?.raw;
    parsed = fb.result?.parsed ?? null;
  } catch (e: any) {
    console.warn(`[enrich] health review refresh failed: ${e?.message ?? e}`);
    return;
  }

  const saved = parsed && typeof parsed === "object" ? repo.addHealthReview(parsed, agent, raw) : null;
  if (!saved) {
    console.warn("[enrich] health review refresh: agent returned no usable review — previous review kept.");
  }

  // New labs landed → refresh the elite-coach whole-picture synthesis on the fresh
  // directives + review, so the Health → Read view's lead reflects the new panel without a
  // manual refresh. Pull artifact (cached): only regenerate when a synthesis ALREADY
  // exists (the user opted into the read at least once) — never conjure one uninvited.
  // Non-blocking + silent-degrade: a failure keeps the previous synthesis, the Stand
  // overview's existing stale/refresh affordance simply finds fresher data on its own.
  if (shouldRegenerateSynthesis(repo.getHealthSynthesis())) {
    try {
      const r = await synthesizeHealth("auto");
      console.log(r.ok ? "[enrich] health synthesis refreshed after new labs." : "[enrich] health synthesis: kept previous (no usable read).");
    } catch (e: any) {
      console.warn(`[enrich] health synthesis refresh failed: ${e?.message ?? e}`);
    }
  }
}

// Reconcile a Garmin strength activity into the day's Cairn session. The
// deterministic physiology merge already ran during sync (reconcileGarminStrength);
// here the agent adds the one-line "body's reaction" read and logs the exercises
// Garmin detected that the athlete did NOT already log by hand. Degrades to a
// clean no-op (the deterministic merge stands) when enrichment/agents are off.
async function processGarminStrengthJob(garminActivityId: number): Promise<void> {
  let ga = repo.getGarminActivity(garminActivityId) as any;
  if (!ga) return;
  // Ensure the deterministic merge happened (a re-enqueue after restart / manual
  // trigger may reach here before reconcileGarminStrength has run).
  if (!ga.session_id) {
    try { repo.reconcileGarminStrength(garminActivityId); } catch { /* not strength / nothing to attach */ }
    ga = repo.getGarminActivity(garminActivityId) as any;
  }
  if (!ga?.session_id) return; // not a strength activity, or no session to attach to

  // Which exercises already have logged sets this session — never duplicate them.
  // This code-level guard is the real protection; the prompt instruction is a hint.
  // The deterministic and agentic passes SHARE this set, so they can't double-log.
  const session = repo.getSessionDetail(ga.session_id) as any;
  const already = new Set<string>(
    (Array.isArray(session?.sets) ? session.sets : []).map((s: any) => String(s.exercise || "").toLowerCase())
  );

  // DETERMINISTIC FLOOR: log Garmin's detected sets with the kg→lb conversion done
  // in CODE. This runs FIRST and ALWAYS — even when enrichment is off or no agent is
  // reachable — because the sets (and their weights) are facts, not a coaching opinion.
  // Delegating the conversion to the LLM risks a silent ~2.2× corruption of every load.
  const hadDetectedSets = Array.isArray(ga?.exercise_sets) && ga.exercise_sets.length > 0;
  let logged = logGarminDetectedSets(ga, already);

  const settings = repo.getSettings();
  if (!settings.enrich_enabled) {
    // Sets are logged; the physiology already merged during sync. Mark the session's
    // blob extrapolated if we added any, but skip the (agentic) narrative layer.
    if (logged) {
      repo.updateSessionGarminNarrative(ga.session_id, { extrapolated: true });
      console.log(`[enrich] garmin_strength#${garminActivityId}: logged ${logged} detected set(s) deterministically (no narrative — enrichment off).`);
    }
    return;
  }
  const order = repo.pickAgentOrder();
  if (!order.length) {
    if (logged) {
      repo.updateSessionGarminNarrative(ga.session_id, { extrapolated: true });
      console.log(`[enrich] garmin_strength#${garminActivityId}: logged ${logged} detected set(s) deterministically (no agent for narrative).`);
    }
    return;
  }

  let parsed: any = null;
  let agent: string | null = null;
  try {
    const fb = await runAgentWithFallback(order, buildGarminStrengthPrompt(ga), ENRICH_TIMEOUT_MS);
    agent = fb.agent ?? null;
    parsed = fb.result?.parsed ?? null;
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object") {
    // Deterministic sets + physiology stand; just no one-line narrative this run.
    if (logged) repo.updateSessionGarminNarrative(ga.session_id, { extrapolated: true });
    return;
  }

  // The agent's set list is the FALLBACK path only: when Garmin gave us no detected
  // exercise_sets, the deterministic floor logged nothing, so the agent's reconstruction
  // is all we have. When the floor DID log from exercise_sets, we do NOT re-log the
  // agent's sets — its names may differ from the floor's ("Bench Press" vs "Barbell
  // Bench Press") and slip past the `already` guard, double-logging the same physical
  // work. In that case the agent only contributes the one-line narrative below.
  if (!hadDetectedSets && Array.isArray(parsed.sets)) {
    for (const raw of parsed.sets) {
      const name = asStr(raw?.exercise);
      if (!name || already.has(name.toLowerCase())) continue;
      const mode = raw?.mode === "timed" ? "timed" : "reps";
      const weight = asNum(raw?.weight); // agent value is already lb per the prompt
      const reps = asNum(raw?.reps);
      const duration = asNum(raw?.duration_sec);
      // Must carry something loggable for its mode.
      if (mode === "timed" ? duration == null : reps == null && weight == null) continue;
      try {
        repo.logSetByName({
          exercise: name,
          weight: mode === "timed" ? null : weight ?? null,
          reps: mode === "timed" ? null : reps ?? null,
          duration_sec: mode === "timed" ? duration ?? null : null,
          exercise_mode: mode,
          date: ga.date,
        });
        already.add(name.toLowerCase()); // guard against duplicate names within one response
        logged++;
      } catch {
        /* one bad set shouldn't fail the job */
      }
    }
  }

  repo.updateSessionGarminNarrative(ga.session_id, {
    summary: asStr(parsed.summary) ?? null,
    intensity: ["easy", "moderate", "hard"].includes(parsed.intensity) ? parsed.intensity : null,
    extrapolated: !!parsed.extrapolated || logged > 0,
    agent,
  });
  if (logged) console.log(`[enrich] garmin_strength#${garminActivityId}: logged ${logged} detected set(s) into session ${ga.session_id} (kg→lb in code).`);
}

// ---- new off-plan exercise → canonical + classify + guide + art ----------------
// The athlete added a movement that wasn't in the plan (e.g. "Single-Arm Lat
// Pulldown"). The deterministic canon already cleaned the name + guessed a
// group/mode at insert; here the agent refines that ONE entry, then we warm its
// how-to guide (so the first ⓘ tap is instant) and pregenerate muscle/equipment-
// aware art (so its tile shows a real image, not the name-only fallback). NEVER
// touches logged numbers. Degrades cleanly end-to-end: enrichment off / no agent →
// 'skipped' (art still attempted from the deterministic group, self-degrading); a
// wrong-shape reply → the deterministic classification stands and we mark 'done'.
// Exported so the offline test can drive the graceful-degradation paths directly.
export async function processExerciseJob(id: number): Promise<void> {
  const ex = repo.getExercise(id) as any;
  if (!ex) return; // deleted while queued — nothing to enrich, no status to set

  const settings = repo.getSettings();
  if (!settings.enrich_enabled) {
    repo.setExerciseEnrichStatus(id, "skipped");
    return;
  }

  const order = repo.pickAgentOrder();
  let finalName = String(ex.name);
  let group: string | null = ex.muscle_group ?? null;
  let equipment: string | null = ex.equipment ?? null;

  if (order.length) {
    // Mark in-progress BEFORE the first await so a crash leaves a recoverable
    // marker (recoverPendingEnrich re-enqueues 'in_progress' too), and the art
    // route keeps deferring name-only generation while the job runs.
    repo.setExerciseEnrichStatus(id, "in_progress");
    let parsed: any = null;
    try {
      const fb = await runAgentWithFallback(order, buildExerciseEnrichPrompt(repo.getExerciseDetail(ex.name)), ENRICH_TIMEOUT_MS);
      parsed = fb.result?.parsed ?? null;
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === "object") {
      // Apply the classification safely (canonical merge/rename, fill-only group/
      // equipment/mode); the returned id/name reflect any merge or rename.
      const applied = repo.applyExerciseEnrichment(id, {
        canonical: asStr(parsed.canonical),
        muscle_group: asStr(parsed.muscle_group ?? parsed.group),
        mode: asStr(parsed.mode),
        equipment: asStr(parsed.equipment),
      });
      finalName = applied.name || finalName;
      const updated = repo.getExercise(applied.id) as any;
      group = updated?.muscle_group ?? group;
      equipment = updated?.equipment ?? equipment;
    }
    // Warm the how-to guide into ai_cache so the first ⓘ tap serves instantly.
    try { await explainExercise("auto", finalName); } catch { /* best-effort */ }
  }

  // Muscle/equipment-aware art under the bare-name key (self-degrades: no key /
  // art disabled / already cached / known-failed → no-op). Runs EVEN with no CLI
  // agent — the art call is a direct Gemini request keyed off the deterministic group.
  try { await warmExerciseArt(finalName, { muscle_group: group, equipment }); } catch { /* best-effort */ }

  // 'done' whenever an agent was available (the deterministic row already stands, so
  // even a soft agent miss leaves a usable exercise — the guide hydrates lazily and
  // art was attempted); 'skipped' only when there was no agent at all.
  repo.setExerciseEnrichStatus(id, order.length ? "done" : "skipped");
}

// ---- food photo → macros (vision) ----------------------------------------------
// A food note that carries an attached plate photo. Instead of re-parsing free
// text, hand a VISION-capable agent the ABSOLUTE image path (same trick as the
// 'health' kind — the Claude/Codex CLIs open local files) and ask it to estimate
// the plate's foods + per-item and total macros. The estimate is coerced/clamped
// (shared discipline with the food enricher) and merged over the note's existing
// parsed blob, upgrading the as-logged entry IN PLACE. The 'confidence' band is
// carried through so the surface can render an honest "rough estimate" hint.
//
// Degrades cleanly end-to-end: enrichment off / no agent / a non-absolute path /
// an unreadable image / a wrong-shape reply → 'skipped' or 'failed', and the
// as-logged note (its instant summary, any macros the chat agent already filled)
// stands untouched. Idempotent: a re-run (recovery / re-enqueue) just re-estimates
// and overwrites with the latest parse — it never appends a second note.
// Exported so the offline test can verify the graceful-degradation refusals
// (no image_path / a non-absolute path / no usable agent all end terminal,
// before any agent is reached).
export async function processFoodPhotoJob(id: number): Promise<void> {
  const settings = repo.getSettings();
  if (!settings.enrich_enabled) {
    repo.setFoodNoteEnrichStatus(id, "skipped");
    return;
  }
  const row = repo.getFoodNote(id) as any;
  if (!row) return; // deleted while queued — nothing to enrich, no status to set
  const fp = (row.image_path ?? "").toString().trim();
  if (!fp) {
    // No photo on the note (e.g. enqueued for the wrong kind) — fall back to the
    // text enricher is not our job here; just treat as not-applicable.
    repo.setFoodNoteEnrichStatus(id, "skipped");
    return;
  }
  // The image is always stored as an absolute path under UPLOADS_DIR. Refuse
  // anything else rather than resolving relative to cwd — same guard as 'health',
  // and the only thing constraining the agent's file read to uploaded images.
  if (!path.isAbsolute(fp)) {
    repo.setFoodNoteEnrichStatus(id, "skipped");
    return;
  }
  // A vision read hands the agent a local file to look at — prefer the strongest
  // file-reading transcriber (Claude-first), the same ordering the 'health' kind
  // uses, rather than the load-spreading round-robin.
  const order = repo.pickHealthAgentOrder();
  const hasGeminiVision = !!repo.getGeminiApiKey();
  if (!hasGeminiVision && !order.length) {
    repo.setFoodNoteEnrichStatus(id, "skipped");
    return;
  }

  // Mark in-progress BEFORE the first await so a crash leaves a recoverable marker
  // (recoverPendingEnrich re-enqueues 'in_progress' too) instead of a stuck row.
  repo.setFoodNoteEnrichStatus(id, "in_progress");

  const hint = (row.parsed?.summary ?? row.raw_output ?? row.meal ?? "").toString().trim();
  let parsed: any = null;
  let wrote = false;

  if (hasGeminiVision) {
    try {
      parsed = await runGeminiFoodPhoto(fp, hint || undefined);
      wrote = !!parsed && applyFoodPhoto(id, parsed);
    } catch (e: any) {
      console.warn(`[enrich] food_photo#${id}: Gemini vision failed (${e?.message ?? e}); falling back to CLI agent.`);
    }
  }

  if (!wrote && order.length) {
    try {
      const fb = await runAgentWithFallback(order, buildFoodPhotoPrompt(fp, hint || undefined), ENRICH_TIMEOUT_MS);
      parsed = fb.result?.parsed ?? null;
      wrote = !!parsed && applyFoodPhoto(id, parsed);
    } catch {
      parsed = null;
    }
  }

  if (!wrote && (!parsed || typeof parsed !== "object")) {
    // Vision read failed / wrong shape: keep the as-logged note (its instant
    // summary stands), just no macro estimate this run. A re-trigger can retry.
    repo.setFoodNoteEnrichStatus(id, "failed");
    return;
  }

  if (!wrote) {
    // Parseable JSON but nothing usable (e.g. a coach-proposal response) — the
    // as-logged note stands; surface it as failed so a re-trigger can retry.
    console.warn(`[enrich] food_photo#${id}: agent returned parseable JSON but no usable macros (wrong shape?) — kept as-logged note.`);
    repo.setFoodNoteEnrichStatus(id, "failed");
    return;
  }
  repo.setFoodNoteEnrichStatus(id, "done");
}

async function runGeminiFoodPhoto(absPath: string, hint?: string): Promise<any | null> {
  const apiKey = repo.getGeminiApiKey();
  if (!apiKey) return null;
  const buf = fs.readFileSync(absPath);
  if (!buf.length) throw new Error("empty image file");
  const mimeType = mimeForImage(absPath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FOOD_PHOTO_TIMEOUT_MS);
  let body: any = null;
  try {
    const res = await fetch(GEMINI_FOOD_PHOTO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: buildFoodPhotoPrompt(absPath, hint) },
            { inlineData: { mimeType, data: buf.toString("base64") } },
          ],
        }],
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`gemini food photo responded ${res.status}`);
    body = await res.json().catch(() => null);
  } finally {
    clearTimeout(timer);
  }
  const parts = body?.candidates?.[0]?.content?.parts;
  const raw = Array.isArray(parts) ? parts.map((p: any) => p?.text ?? "").join("") : "";
  return extractJson(raw);
}

function mimeForImage(fp: string): string {
  const ext = path.extname(fp).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".heic") return "image/heic";
  if (ext === ".heif") return "image/heif";
  return "image/jpeg";
}

// Coerce/clamp a vision agent's macro payload and merge it over the food note's
// existing parsed blob, mirroring applyStructured's food path (a manual edit or a
// chat-agent estimate already on the note is overwritten only by fields the agent
// actually returned). Returns true if it wrote anything usable. Exported so the
// offline test can exercise the coerce/clamp + merge discipline directly (the
// agent never runs in the harness).
export function applyFoodPhoto(id: number, parsed: any): boolean {
  const cur = (repo.getFoodNote(id) as any)?.parsed ?? {};
  const merged: Record<string, any> = { ...cur };
  let changed = false;
  let usableMacro = false;
  const inferredTotals = macroTotalsFromItems(parsed.items) ?? macroTotalsFromItems(parsed.ingredients);

  const summary = asStr(parsed.summary);
  if (summary !== undefined) { merged.summary = summary; changed = true; }
  if (Array.isArray(parsed.items)) {
    const items = parsed.items.map(photoItemLabel).filter((x: any) => !!x).slice(0, 50);
    if (items.length) {
      merged.items = items;
      changed = true;
    }
  }
  const kcal = asNum(parsed.kcal ?? inferredTotals?.kcal); if (kcal !== undefined) { merged.kcal = clampMacro(kcal, 5000); changed = true; usableMacro = true; }
  const protein = asNum(parsed.protein_g ?? inferredTotals?.protein_g); if (protein !== undefined) { merged.protein_g = clampMacro(protein, 500); changed = true; usableMacro = true; }
  const carbs = asNum(parsed.carbs_g ?? inferredTotals?.carbs_g); if (carbs !== undefined) { merged.carbs_g = clampMacro(carbs, 1000); changed = true; usableMacro = true; }
  const fat = asNum(parsed.fat_g ?? inferredTotals?.fat_g); if (fat !== undefined) { merged.fat_g = clampMacro(fat, 500); changed = true; usableMacro = true; }
  const fiber = asNum(parsed.fiber_g ?? inferredTotals?.fiber_g); if (fiber !== undefined) { merged.fiber_g = clampMacro(fiber, 200); changed = true; usableMacro = true; }
  const notes = asStr(parsed.notes);
  if (notes !== undefined) {
    merged.notes = notes;
    changed = true;
  } else if (isImageAccessFailureNote(merged.notes)) {
    merged.notes = null;
    changed = true;
  }

  // A coarse confidence band (low|medium|high) the surface can show as an honest
  // "rough estimate" hint — never a score, never a percentage. Anything else → drop.
  const conf = String(parsed.confidence ?? "").toLowerCase();
  if (["low", "medium", "high"].includes(conf)) { merged.confidence = conf; changed = true; }
  // The estimate came from the plate photo — mark provenance so the surface can say
  // "estimated from your photo" rather than implying a precise hand-entered log.
  if (!usableMacro) return false;
  if (changed) { merged.from_photo = true; }

  if (changed) repo.updateFoodNoteParsed(id, merged);
  return changed;
}

function photoItemLabel(x: any): string | null {
  if (x === null || x === undefined) return null;
  if (typeof x === "object") {
    const item = asStr(x.item ?? x.name ?? x.summary ?? x.food);
    const amount = asStr(x.amount ?? x.qty ?? x.quantity ?? x.portion);
    if (!item) return null;
    return amount ? `${item} (${amount})`.slice(0, 200) : item.slice(0, 200);
  }
  const s = String(x).trim();
  return s ? s.slice(0, 200) : null;
}

function macroTotalsFromItems(items: any): Record<string, number> | null {
  if (!Array.isArray(items)) return null;
  const totals: Record<string, number> = {};
  let saw = false;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    for (const key of ["kcal", "protein_g", "carbs_g", "fat_g", "fiber_g"] as const) {
      const n = asNum(item[key]);
      if (n === undefined) continue;
      totals[key] = (totals[key] ?? 0) + n;
      saw = true;
    }
  }
  return saw ? totals : null;
}

function isImageAccessFailureNote(v: any): boolean {
  const s = String(v ?? "").toLowerCase();
  return !!s && /(unable|cannot|can't|could not|failed|blocked).{0,80}(image|photo|file|viewer|sandbox|access|open)/i.test(s);
}

// Clamp a macro value to a non-negative integer under a sane ceiling.
function clampMacro(n: number, max: number): number {
  return Math.min(max, Math.max(0, Math.round(n)));
}

function jobRawText(job: Job): string {
  if (job.kind === "activity") {
    const row = repo.getActivity(job.id) as any;
    return (row?.raw_text ?? "").toString().trim();
  }
  const row = repo.getFoodNote(job.id) as any;
  return (row?.raw_output ?? "").toString().trim();
}

// Store the agent's extracted markers + plain-language summary on the health doc.
// Returns true if it wrote anything usable (used to detect a no-op result).
// Apply a multi-record ingestion result. The agent returns `panels[]` (one per
// distinct test date). The NEWEST panel is written onto the source row (which
// owns the binary); every older panel becomes its own dated record linked back
// via source_doc_id. A single-date upload yields one panel → enriched in place,
// no extra rows. Falls back to the legacy single-doc {structured} shape.
// Normalize an ingest result to its panels array (handles both the modern
// {panels:[…]} shape and the legacy single-doc {structured:{markers}} shape).
function ingestPanels(parsed: any): any[] {
  let panels: any[] = Array.isArray(parsed?.panels) ? parsed.panels : [];
  if (!panels.length && parsed?.structured && typeof parsed.structured === "object") {
    panels = [{
      doc_date: parsed.doc_date ?? parsed.structured.doc_date ?? parsed.structured.date,
      kind: parsed.kind ?? parsed.structured.type,
      summary: parsed.summary,
      markers: parsed.structured.markers,
      type: parsed.structured.type,
    }];
  }
  return panels;
}

// Total markers across all panels of an ingest result — the completeness signal
// the retry guard compares against the source's estimated marker count.
function countIngestMarkers(parsed: any): number {
  return ingestPanels(parsed).reduce(
    (n, p) => n + (Array.isArray(p?.markers) ? p.markers.length : 0),
    0,
  );
}

// A binary (PDF/image) health doc has no countable source text, so the completeness
// guard can't compute an expected marker count for it. This is the CONSERVATIVE
// absolute-floor fallback: only a comprehensive BLOODWORK panel — which realistically
// reports dozens of analytes (a CBC differential + a metabolic panel alone clears 25)
// — is suspicious when it comes back with a handful of markers. A DEXA, an "other"
// doc, or a genuinely small panel legitimately carries few rows, so we never re-run
// those. The floor (12) sits well under any real comprehensive panel, so a small but
// honest blood draw (e.g. a lipid + A1c follow-up) isn't needlessly re-run either.
const COMPREHENSIVE_PANEL_FLOOR = 12;
function looksThinForBinaryHealthDoc(kind: string | null | undefined, got: number): boolean {
  // got can be 0 (a curated-to-nothing or transcription-missed bloodwork) — the
  // strongest signal of a miss, and a retry that recovers markers also rescues the
  // doc from the wrong-shape 'failed' path below. Either way we keep whichever
  // attempt captured MORE, so the retry can never make the result worse.
  return (kind || "").toLowerCase() === "bloodwork" && got < COMPREHENSIVE_PANEL_FLOOR;
}

function isoFromDateLike(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slash = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (!slash) return null;
  const mm = Number(slash[1]);
  const dd = Number(slash[2]);
  const yyyy = Number(slash[3]);
  if (!Number.isInteger(mm) || !Number.isInteger(dd) || !Number.isInteger(yyyy)) return null;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || yyyy < 1900 || yyyy > 2100) return null;
  return `${String(yyyy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

function visitNoteSentence(line: string | null | undefined, max = 240): string | null {
  const s = String(line ?? "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

function clinicalNoteFallbackFromText(text: string): { doc_date: string | null; summary: string; clinical_facts: any[]; memory: any[] } | null {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim());
  const nonEmpty = lines.filter(Boolean);
  if (nonEmpty.length < 4) return null;

  const lower = nonEmpty.join("\n").toLowerCase();
  const looksClinical =
    /assessment\/plan|progress notes?|televisit|office visit|after visit summary|history of present illness|follow-up/i.test(lower) &&
    /patient|visit|provider|lab|medication|assessment|plan/i.test(lower);
  if (!looksClinical) return null;

  const docDate = nonEmpty.map(isoFromDateLike).find(Boolean) ?? null;
  const providerMatch = nonEmpty.join("\n").match(/(?:progress notes?|visit notes?)\s+by\s+(.+?)\s+at\s+\d{1,2}\/\d{1,2}\/\d{4}/i);
  const provider = visitNoteSentence(providerMatch?.[1], 120);
  const encounterTitle = nonEmpty.find((l) =>
    /visit|televisit|consult|encounter|progress note/i.test(l) &&
    !/^progress notes?\s+by\b/i.test(l) &&
    !/^today'?s visit/i.test(l)
  ) ?? "Clinical visit";

  const facts: any[] = [];
  const seen = new Set<string>();
  const addFact = (fact: any) => {
    const name = visitNoteSentence(fact?.name, 180);
    if (!name) return;
    const clean = {
      kind: fact.kind,
      date: fact.date ?? docDate,
      name,
      status: visitNoteSentence(fact.status, 80) ?? null,
      detail: visitNoteSentence(fact.detail, 500),
      source: visitNoteSentence(fact.source, 160),
    };
    const key = [clean.kind, clean.date ?? "", clean.name.toLowerCase(), clean.status ?? "", clean.detail ?? ""].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    facts.push(clean);
  };

  const assessmentIdx = lines.findIndex((l) => /^assessment\/plan:?$/i.test(l));
  const assessmentLines = assessmentIdx >= 0 ? lines.slice(assessmentIdx + 1) : lines;
  const numbered = assessmentLines
    .map((l) => l.match(/^\d+\.\s+(.+)$/)?.[1])
    .filter((l): l is string => !!visitNoteSentence(l));
  const labOrders = [...new Set(assessmentLines
    .map((l) => l.match(/^[-*]\s*([A-Z0-9 ,()./%+-]{3,90});\s*Future\b/i)?.[1])
    .filter((l): l is string => !!visitNoteSentence(l))
    .map((l) => l.replace(/\s+/g, " ").trim()))];
  const followupIdx = lines.findIndex((l) => /^follow-up:?$/i.test(l));
  const sectionFollowup = followupIdx >= 0
    ? lines.slice(followupIdx + 1).find((l) => /^[-*]\s+/.test(l))
    : null;
  const followup = sectionFollowup ?? assessmentLines.find((l) => /^[-*]\s+.*\b(labs?|follow|f\/u|mychart)\b/i.test(l)) ?? null;
  const referral = assessmentLines.find((l) => /consider referral to cardiology|e-consult|CAC\b|risk stratification/i.test(l)) ?? null;
  const riskLine = assessmentLines.find((l) => /PREVENT algorithm|ASCVD/i.test(l)) ?? null;
  const familyLine = nonEmpty.find((l) => /denies family history .*heart|family history negative for cardiac/i.test(l)) ?? null;

  const encounterDetailParts = [
    numbered.length ? `Assessment: ${numbered.slice(0, 4).join("; ")}` : null,
    labOrders.length ? `Future labs: ${labOrders.slice(0, 8).join(", ")}` : null,
    followup ? `Follow-up: ${followup.replace(/^[-*]\s*/, "")}` : null,
  ].filter(Boolean);
  addFact({
    kind: "encounter",
    date: docDate,
    name: provider ? `${encounterTitle} with ${provider}` : encounterTitle,
    status: "completed",
    detail: encounterDetailParts.join(". ") || null,
    source: "visit note",
  });
  if (provider) {
    addFact({ kind: "care_team", date: docDate, name: provider, status: "unknown", detail: "Provider listed on visit note.", source: "visit note" });
  }
  for (const item of numbered) {
    const kind = /\bscreening\b|\blab test follow-up\b/i.test(item) ? "other" : "condition";
    addFact({
      kind,
      date: docDate,
      name: item,
      status: kind === "condition" ? "active" : "unknown",
      detail: "Listed in Assessment/Plan.",
      source: "Assessment/Plan",
    });
  }
  for (const order of labOrders) {
    addFact({
      kind: "other",
      date: docDate,
      name: order,
      status: "ordered",
      detail: "Future lab order in visit plan.",
      source: "Assessment/Plan",
    });
  }
  if (followup) {
    addFact({
      kind: "other",
      date: docDate,
      name: "Follow-up plan",
      status: "planned",
      detail: followup.replace(/^[-*]\s*/, ""),
      source: "Follow-up",
    });
  }
  if (referral) {
    addFact({
      kind: "other",
      date: docDate,
      name: "Cardiology referral/e-consult consideration",
      status: "planned",
      detail: referral.replace(/^[-*]\s*/, ""),
      source: "Assessment/Plan",
    });
  }
  if (riskLine) {
    addFact({
      kind: "other",
      date: docDate,
      name: "ASCVD risk reviewed",
      status: "reviewed",
      detail: riskLine.replace(/^[-*]\s*/, ""),
      source: "Assessment/Plan",
    });
  }
  if (familyLine) {
    addFact({
      kind: "family_history",
      date: docDate,
      name: "No known family history of heart disease noted",
      status: "reported",
      detail: familyLine,
      source: "History",
    });
  }

  const topic = numbered.filter((n) => !/\bscreening\b/i.test(n)).slice(0, 3).join(", ") || "health follow-up";
  const orderText = labOrders.length
    ? ` Future labs ordered: ${labOrders.slice(0, 6).join(", ")}${labOrders.length > 6 ? ", and more" : ""}.`
    : "";
  const followText = followup ? ` Follow-up plan: ${followup.replace(/^[-*]\s*/, "")}.` : "";
  const summary = `${encounterTitle}${docDate ? ` on ${docDate}` : ""} documented ${topic}.${orderText}${followText}`.slice(0, 1000);
  const memory: any[] = [];
  if (labOrders.length || followup || referral) {
    const bits = [
      docDate ? `Visit note on ${docDate}` : "Visit note",
      labOrders.length ? `planned future labs (${labOrders.slice(0, 8).join(", ")})` : null,
      followup ? followup.replace(/^[-*]\s*/, "") : null,
      referral ? "cardiology/e-consult may be considered depending on results" : null,
    ].filter(Boolean);
    memory.push({ content: `${bits.join("; ")}.`, kind: "milestone" });
  }

  if (!facts.length && !summary) return null;
  return { doc_date: docDate, summary, clinical_facts: facts, memory };
}

function reconcileHealthDocContext(id: number): void {
  try {
    const matches = repo.reconcileHealthDocumentContextEvents(id);
    if (matches.length) {
      console.log(`[enrich] health#${id}: resolved ${matches.length} matched context event(s).`);
    }
  } catch (e: any) {
    console.warn(`[enrich] health#${id}: context-event reconciliation failed: ${e?.message || e}`);
  }
}

function applyTextVisitNoteFallback(id: number, source: HealthSource | null): { applied: boolean; facts: number; addedMemory: number } {
  if (!source || source.isDir) return { applied: false, facts: 0, addedMemory: 0 };
  if (!/^text\/plain\b/i.test(source.mime) && !/\.txt$/i.test(source.fp)) return { applied: false, facts: 0, addedMemory: 0 };
  let text = "";
  try { text = fs.readFileSync(source.fp, "utf8").slice(0, 400_000); }
  catch { return { applied: false, facts: 0, addedMemory: 0 }; }
  const fallback = clinicalNoteFallbackFromText(text);
  if (!fallback || (!fallback.clinical_facts.length && !fallback.summary)) return { applied: false, facts: 0, addedMemory: 0 };
  const row = repo.getHealthDocumentRaw(id) as any;
  repo.updateHealthDocFields(id, {
    parsed_json: {
      markers: [],
      clinical_facts: fallback.clinical_facts,
    },
    summary: fallback.summary,
    kind: inferHealthDocumentKind({
      kind: row?.kind,
      summary: fallback.summary,
      original_name: row?.original_name,
      markers: [],
      clinical_facts: fallback.clinical_facts,
      mime: row?.mime,
    }),
    doc_date: fallback.doc_date ?? row?.doc_date ?? null,
  });
  try { repo.replaceHealthPanels(id, [], row?.original_name ?? null); } catch { /* best effort cleanup */ }
  let addedMemory = 0;
  for (const m of fallback.memory) {
    try {
      if (repo.addMemory(m.content, m.kind || "observation", "health-note-fallback")) addedMemory++;
    } catch { /* one memory should not fail the fallback */ }
  }
  reconcileHealthDocContext(id);
  return { applied: true, facts: fallback.clinical_facts.length, addedMemory };
}

function applyHealthIngest(id: number, parsed: any): boolean {
  const panels = ingestPanels(parsed);
  const panelFacts = panels.flatMap((p: any) => Array.isArray(p?.clinical_facts) ? p.clinical_facts : []);
  const clinicalFacts = repo.cleanClinicalFacts([
    ...(Array.isArray(parsed?.clinical_facts) ? parsed.clinical_facts : []),
    ...panelFacts,
  ]);

  const cleanMarkers = (raw: any): any[] =>
    (Array.isArray(raw) ? raw : [])
      .filter((m: any) => m && typeof m === "object")
      .slice(0, repo.MAX_MARKERS_PER_PANEL)
      .map((m: any) => ({
        name: asStr(m.name) ?? "",
        value: typeof m.value === "number" ? m.value : asStr(m.value) ?? null,
        unit: asStr(m.unit) ?? null,
        flag: ["low", "normal", "high"].includes(m.flag) ? m.flag : null,
      }))
      .filter((m: any) => m.name)
      // Numeric plausibility / unit-error guard (mirrors insertHealthPanels): the
      // primary-panel ingest path writes via updateHealthDocFields, so it must run
      // the same defensive check or a transcription typo / unit mix-up would poison
      // the connected brain's directives. Conservative — only CLEAR impossibilities.
      .filter((m: any) => {
        try {
          const v = repo.plausibleMarkerValue(m.name, m.value, m.unit);
          if (!v.plausible) {
            console.warn(`[enrich] dropped implausible marker "${m.name}" = ${m.value}${m.unit ? ` ${m.unit}` : ""}: ${v.reason ?? "out of physiologic range"}`);
            return false;
          }
        } catch { /* guard unavailable → keep the marker (fail-open) */ }
        return true;
      });

  const cleaned = panels
    .filter((p: any) => p && typeof p === "object")
    .map((p: any) => {
      const date = asStr(p.doc_date);
      const validDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
      const explicitKind = normalizeHealthDocumentKind(p.kind);
      const kind = explicitKind !== "other"
        ? explicitKind
        : inferHealthDocumentKind({
          kind: p.kind,
          type: p.type,
          summary: p.summary,
          original_name: row?.original_name,
          markers: p.markers,
          clinical_facts: p.clinical_facts,
          mime: row?.mime,
        });
      return {
        doc_date: validDate,
        kind,
        summary: asStr(p.summary) ?? null,
        markers: cleanMarkers(p.markers),
        type: asStr(p.type) ?? null,
      };
    })
    .filter((p) => p.markers.length || p.summary);

  const row = repo.getHealthDocumentRaw(id) as any;
  const markerCount = cleaned.reduce((n, p) => n + p.markers.length, 0);
  // A health-document result with only prose is not an ingest. This catches agent
  // sandbox/file-access failures like "I could not read the upload" before they
  // overwrite a previously valid marker panel with {"markers":[]}.
  if (!markerCount && !clinicalFacts.length) return false;
  if (!cleaned.length) {
    const summary = asStr(parsed?.summary) ?? null;
    const out: Record<string, any> = { markers: [] };
    if (clinicalFacts.length) out.clinical_facts = clinicalFacts;
    repo.updateHealthDocFields(id, {
      parsed_json: out,
      kind: inferHealthDocumentKind({
        kind: row?.kind,
        type: out.type,
        summary,
        original_name: row?.original_name,
        markers: [],
        clinical_facts: clinicalFacts,
        mime: row?.mime,
      }),
      summary,
    });
    repo.replaceHealthPanels(id, [], row?.original_name ?? null);
    reconcileHealthDocContext(id);
    return true;
  }

  // Newest first (date-bearing panels ahead of date-less ones).
  cleaned.sort((a, b) => {
    if (a.doc_date && b.doc_date) return a.doc_date < b.doc_date ? 1 : a.doc_date > b.doc_date ? -1 : 0;
    if (a.doc_date) return -1;
    if (b.doc_date) return 1;
    return 0;
  });

  const primary = cleaned[0];
  const rest = cleaned.slice(1);

  // Write the newest panel onto the source row.
  const out: Record<string, any> = { markers: primary.markers };
  if (primary.type) out.type = primary.type;
  if (clinicalFacts.length) out.clinical_facts = clinicalFacts;
  const fields: { parsed_json?: any; summary?: string | null; kind?: string | null; doc_date?: string | null } = {
    parsed_json: out,
    kind: inferHealthDocumentKind({
      kind: primary.kind,
      type: primary.type,
      summary: (rest.length ? asStr(parsed?.summary) : null) ?? primary.summary ?? asStr(parsed?.summary) ?? null,
      original_name: row?.original_name,
      markers: primary.markers,
      clinical_facts: clinicalFacts,
      mime: row?.mime,
    }),
  };
  if (primary.doc_date) fields.doc_date = primary.doc_date;
  // Prefer the cross-import overview as the source row's summary when there are
  // multiple panels (it reads as "what this whole import means"); else the panel's.
  fields.summary = (rest.length ? asStr(parsed?.summary) : null) ?? primary.summary ?? asStr(parsed?.summary) ?? null;
  repo.updateHealthDocFields(id, fields);

  // Older panels become their own dated records (replacing any prior set, so a
  // re-analysis is idempotent).
  const created = repo.replaceHealthPanels(id, rest, row?.original_name ?? null);
  if (created.length) {
    console.log(`[enrich] health#${id}: split import into ${cleaned.length} dated panel(s) (${created.length} derived).`);
  }
  reconcileHealthDocContext(id);
  return true;
}

// Returns true if it wrote any structured field (used to detect a no-op result).
function applyStructured(job: Job, structured: any): boolean {
  if (!structured || typeof structured !== "object") return false;

  if (job.kind === "activity") {
    // Only overwrite fields the agent actually provided, coerced to the column's
    // type so a string-number or junk value can't silently corrupt the row.
    const fields: Record<string, any> = {};
    const type = asStr(structured.type); if (type !== undefined) fields.type = type;
    const dur = asNum(structured.duration_min); if (dur !== undefined) fields.duration_min = dur;
    const dist = asNum(structured.distance_km); if (dist !== undefined) fields.distance_km = dist;
    const pace = asStr(structured.pace); if (pace !== undefined) fields.pace = pace;
    const rpe = asNum(structured.rpe); if (rpe !== undefined) fields.rpe = rpe;
    const notes = asStr(structured.notes); if (notes !== undefined) fields.notes = notes;
    if (Object.keys(fields).length) {
      repo.updateActivityFields(job.id, fields);
      return true;
    }
    return false;
  }

  // food: merge the agent's coerced estimate over the existing parsed_json blob.
  const cur = (repo.getFoodNote(job.id) as any)?.parsed ?? {};
  const merged: Record<string, any> = { ...cur };
  let changed = false;
  const summary = asStr(structured.summary);
  if (summary !== undefined) { merged.summary = summary; changed = true; }
  if (Array.isArray(structured.items)) {
    merged.items = structured.items.map((x: any) => String(x).slice(0, 200)).slice(0, 50);
    changed = true;
  }
  if (Array.isArray(structured.ingredients)) {
    merged.ingredients = structured.ingredients
      .filter((x: any) => x && typeof x === "object")
      .slice(0, 50)
      .map((x: any) => {
        const item = asStr(x.item ?? x.name);
        if (!item) return null;
        const out: Record<string, any> = { item };
        const amount = asStr(x.amount ?? x.qty ?? x.quantity);
        if (amount !== undefined) out.amount = amount;
        for (const key of ["kcal", "protein_g", "carbs_g", "fat_g"] as const) {
          const n = asNum(x[key]);
          if (n !== undefined) out[key] = n;
        }
        return out;
      })
      .filter(Boolean);
    changed = true;
  }
  const kcal = asNum(structured.kcal); if (kcal !== undefined) { merged.kcal = kcal; changed = true; }
  const protein = asNum(structured.protein_g); if (protein !== undefined) { merged.protein_g = protein; changed = true; }
  const carbs = asNum(structured.carbs_g); if (carbs !== undefined) { merged.carbs_g = carbs; changed = true; }
  const fat = asNum(structured.fat_g); if (fat !== undefined) { merged.fat_g = fat; changed = true; }
  const fiber = asNum(structured.fiber_g); if (fiber !== undefined) { merged.fiber_g = fiber; changed = true; }
  const fnotes = asStr(structured.notes); if (fnotes !== undefined) { merged.notes = fnotes; changed = true; }
  if (changed) repo.updateFoodNoteParsed(job.id, merged);
  return changed;
}

// Crash recovery: re-enqueue every row left 'pending' (queued, never started) or
// 'in_progress' (started but interrupted by a restart). Called once at startup
// from server.ts. A re-run ends in 'done' or 'failed', so jobs don't loop.
export function recoverPendingEnrich(): { activities: number; food: number; health: number; exercises: number } {
  const acts = db
    .prepare(`SELECT id FROM activities WHERE enrichment_status IN ('pending','in_progress')`)
    .all() as any[];
  // A food note with an attached photo is a vision job ('food_photo'); a text-only
  // one is the regular 'food' enricher. Carry image_path so recovery re-enqueues
  // each interrupted note onto the SAME path it was originally queued for.
  const foods = db
    .prepare(`SELECT id, image_path FROM food_notes WHERE enrichment_status IN ('pending','in_progress')`)
    .all() as any[];
  const health = db
    .prepare(`SELECT id FROM health_documents WHERE enrichment_status IN ('pending','in_progress')`)
    .all() as any[];
  const exercises = db
    .prepare(`SELECT id FROM exercises WHERE enrichment_status IN ('pending','in_progress')`)
    .all() as any[];
  for (const a of acts) enqueueEnrich("activity", a.id);
  for (const f of foods) enqueueEnrich(f.image_path ? "food_photo" : "food", f.id);
  for (const h of health) enqueueEnrich("health", h.id);
  for (const x of exercises) enqueueEnrich("exercise", x.id);
  if (acts.length || foods.length || health.length || exercises.length) {
    console.log(`[enrich] recovered ${acts.length} activity + ${foods.length} food + ${health.length} health + ${exercises.length} exercise pending job(s).`);
  }
  return { activities: acts.length, food: foods.length, health: health.length, exercises: exercises.length };
}
