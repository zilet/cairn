import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db } from "./db.js";
import { inferHealthDocumentKind, normalizeHealthDocumentKind } from "./healthDocumentKinds.js";
import * as repo from "./repo.js";
import { AgentFallbackError, extractJson, runAgentWithFallback } from "./agents.js";
import {
  clampFoodMacro,
  coerceFoodIngredients,
  coerceFoodItems,
  coerceFoodProvenance,
  coerceNutritionPattern,
  foodMacroTotalsFrom,
} from "./foodCapture.js";
import {
  buildSymptomCapturePrompt,
  coerceSymptomCapture,
  symptomTextMentionsBody,
  type SymptomCaptureContext,
  type SymptomCaptureReport,
} from "./symptomCapture.js";
import { symptomAreaKey } from "./repo/symptom-area.js";
import { buildEnrichPrompt, buildExerciseEnrichPrompt, buildFoodPhotoPrompt, buildHealthIngestPrompt, buildHealthReviewPrompt, buildGarminStrengthPrompt, buildImagingStudyPrompt } from "./prompt.js";
import { explainExercise, reconcileMarkers, synthesizeHealth } from "./coachOps.js";
import { GEMINI_TEXT_MODEL, warmExerciseArt } from "./art.js";
import { LB_PER_KG, round2_5 } from "./repo/shared.js";
import { diagnosticErrorName, recordAsyncFailure, recordDegradedOperation } from "./diagnostics.js";
import { safeUploadPath } from "./uploadPaths.js";
import { agentErrorClass } from "./telemetry-privacy.js";
import { activeTimeZone, runWithTimeZone } from "./tz.js";

// Live status-transition bus for background enrichment. The emit is wired into the
// repo status setters (the choke point every write flows through — see enrichBus.ts);
// re-exported here so onEnrichEvent reads as part of the enrichment engine's surface,
// the same way agentJobs.ts owns onJobEvent. The SSE stream routes subscribe with it.
export { onEnrichEvent, isEnrichTerminal, isEnrichActive } from "./enrichBus.js";
export type { EnrichEvent, EnrichResourceKind } from "./enrichBus.js";
// The food-capture coercions now live in ./foodCapture.ts (one contract, three
// surfaces). Re-exported here because they are part of this engine's surface —
// every caller and test that reached for them through the enricher still can.
export {
  coerceFoodIngredients,
  coerceFoodProvenance,
  coerceNutritionPattern,
  normalizeFoodCaptureParsed,
} from "./foodCapture.js";

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
// 'symptom' is one verbatim pain report the athlete wrote (session note, feedback
// line, chat, API). The words are ALREADY stored synchronously in symptom_reports;
// this job derives the structure from them — which watch, which way it moved, which
// movements they named — through src/symptomCapture.ts's one contract and then
// applies it exclusively via the existing lifecycle repo functions. id is the
// symptom_reports row id; it carries its own extraction_status machine. A failure
// costs nothing: the words stay stored and rendered.
type Kind = "activity" | "food" | "food_photo" | "health" | "review" | "garmin_strength" | "exercise" | "symptom";
interface Job {
  kind: Kind;
  id: number;
}
interface HealthSource {
  fp: string;
  mime: string;
  kind: string;
  isDir: boolean;
  imaging?: boolean;
}

const queue: Job[] = [];
let draining = false;

export function staleImagingWorkerAction(reason: "attachments_changed" | "user_state_changed"): {
  status: "pending" | "retry_needed";
  requeue: boolean;
} {
  return reason === "attachments_changed"
    ? { status: "pending", requeue: true }
    : { status: "retry_needed", requeue: false };
}

export function settleStaleImagingJob(
  id: number,
  reason: "attachments_changed" | "user_state_changed",
  schedule: (job: Job) => void = (job) => {
    if (!queue.some((queued) => queued.kind === job.kind && queued.id === job.id)) queue.push(job);
  }
): { status: "pending" | "retry_needed"; requeued: boolean } {
  const action = staleImagingWorkerAction(reason);
  repo.setHealthDocEnrichStatus(id, action.status);
  if (action.requeue) schedule({ kind: "health", id });
  return { status: action.status, requeued: action.requeue };
}

// Re-entry guard: at most ONE review-refresh job sits in the queue at a time.
// Several health docs finishing back-to-back collapse into a single refresh
// (cleared when the review job starts, so data landing mid-run queues the next).
let reviewQueued = false;

// ONE REVIEW PER INGEST BATCH (owner ruling R4). The latch alone only collapses
// refreshes that are pending SIMULTANEOUSLY — and a batch never is: an upload of a
// dozen documents queues them all up front and drains them SERIALLY, so doc 1 finishes,
// enqueues a review, the review runs and clears the latch, and doc 2 does it all again.
// One zip became fourteen whole-picture reviews that way, each one naming the same
// finding. The fix is to ask what is still coming: while ANOTHER health document is
// still queued, this document's review would be superseded before anyone read it, so
// the batch's LAST document is the one that enqueues. Nothing is lost — the deferred
// refresh is not dropped, it is the one that ends up running, over the complete batch.
export function shouldEnqueueReviewRefresh(alreadyQueued: boolean, healthWorkPending = false): boolean {
  if (alreadyQueued) return false;
  if (healthWorkPending) return false;
  return true;
}

// Whether any further health document is still waiting in (or being processed by) the
// queue. Exported for tests; the drain loop shifts the CURRENT job off before running
// it, so this only ever sees documents that have not been read yet.
export function healthWorkPending(): boolean {
  return queue.some((job) => job.kind === "health");
}

// Pure: only REGENERATE the whole-picture synthesis after new labs when the user has
// ALREADY opted into it (a synthesis exists). Never create one uninvited — pull, not
// push (docs/VISION.md). Extracted so the gate is testable without an agent call.
export function shouldRegenerateSynthesis(existingSynthesis: unknown): boolean {
  return existingSynthesis != null;
}

export function enqueueReviewRefresh(): void {
  if (!shouldEnqueueReviewRefresh(reviewQueued, healthWorkPending())) return;
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
// This is the one VISION call outside art.ts, so it falls back to art.ts's
// GEMINI_TEXT_MODEL rather than re-deriving the same env-var-or-literal chain
// (that constant already resolves process.env.GEMINI_TEXT_MODEL || the default,
// so the back-compat env override still works and the two Gemini text call sites
// can no longer drift to different ids). The default model's own capability table
// (ai.google.dev/gemini-api/docs/models/gemini-3.6-flash) explicitly lists Image
// among its supported inputs, so it's confirmed fit for this call, not just
// assumed. GEMINI_FOOD_PHOTO_MODEL overrides just this call.
const GEMINI_FOOD_PHOTO_MODEL = process.env.GEMINI_FOOD_PHOTO_MODEL || GEMINI_TEXT_MODEL;
const GEMINI_FOOD_PHOTO_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FOOD_PHOTO_MODEL}:generateContent`;
const FOOD_PHOTO_TIMEOUT_MS = 45_000;

// Refuse pathological archives before unzipping (zip-bomb / huge export guard).
const ZIP_MAX_UNCOMPRESSED = 200 * 1024 * 1024; // 200 MB
const ZIP_MAX_FILES = 3000;

function looksLikeZip(fp: string, mime?: string | null): boolean {
  const m = (mime || "").toLowerCase();
  return m === "application/zip" || m === "application/x-zip-compressed" || /\.zip$/i.test(fp);
}

const INVENTORY_MAX_FILES = 200;
const INVENTORY_SKIP_EXT = new Set([".css", ".xsl", ".xslt", ".js", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico"]);

// The readable files inside an unpacked export, as "<absolute path>  (N bytes)"
// lines for the ingest prompt. Handed to the agent so it never needs a directory
// listing of its own — a headless CLI cannot get the `command` permission for
// one, and asking it to try is how an ingest ends up exiting 0 with no output.
// Presentation only: stylesheets, scripts and images carry no health data, and
// the count is bounded so a huge export can't crowd out the instructions.
export function buildHealthSourceInventory(root: string): string[] {
  const out: string[] = [];
  const visit = (fp: string) => {
    if (out.length >= INVENTORY_MAX_FILES) return;
    const base = path.basename(fp);
    if (base.startsWith(".") || base.toLowerCase() === "__macosx") return;
    let st: fs.Stats;
    try { st = fs.statSync(fp); } catch { return; }
    if (st.isDirectory()) {
      let entries: string[] = [];
      try { entries = fs.readdirSync(fp).sort(); } catch { return; }
      for (const entry of entries) visit(path.join(fp, entry));
      return;
    }
    if (!st.isFile()) return;
    if (INVENTORY_SKIP_EXT.has(path.extname(fp).toLowerCase())) return;
    out.push(`${fp}  (${st.size} bytes)`);
  };
  visit(root);
  return out;
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

// Normalize one Garmin activity's usable detected sets before handing the whole
// batch to the repo-owned atomic importer. Repeated exercise names remain valid:
// Garmin emits one item per working set, not one item per exercise.
function garminDetectedSetInputs(ga: any): repo.GarminSetImportInput[] {
  const sets = Array.isArray(ga?.exercise_sets) ? ga.exercise_sets : [];
  const usable: repo.GarminSetImportInput[] = [];
  for (const set of sets) {
    const name = garminExerciseName(set);
    if (!name) continue;
    const timed = garminSetIsTimed(set);
    const reps = asNum(set?.reps);
    const duration = asNum(set?.duration_sec);
    const weight = timed ? null : kgToLb(set?.weight_kg);
    // Must carry something loggable for its mode (reps OR a converted load for a
    // reps set; a duration for a timed hold). Otherwise skip — never log an empty set.
    if (timed ? duration == null : reps == null && weight == null) continue;
    usable.push({
      exercise: name,
      weight: timed ? null : weight,
      reps: timed ? null : reps ?? null,
      duration_sec: timed ? duration ?? null : null,
      exercise_mode: timed ? "timed" : "reps",
    });
  }
  return usable;
}

function agentGarminSetInputs(parsed: any): repo.GarminSetImportInput[] {
  if (!Array.isArray(parsed?.sets)) return [];
  const usable: repo.GarminSetImportInput[] = [];
  for (const raw of parsed.sets) {
    const exercise = asStr(raw?.exercise);
    if (!exercise) continue;
    const mode = raw?.mode === "timed" ? "timed" : "reps";
    const weight = asNum(raw?.weight);
    const reps = asNum(raw?.reps);
    const duration = asNum(raw?.duration_sec);
    if (mode === "timed" ? duration == null : reps == null && weight == null) continue;
    usable.push({
      exercise,
      weight: mode === "timed" ? null : weight ?? null,
      reps: mode === "timed" ? null : reps ?? null,
      duration_sec: mode === "timed" ? duration ?? null : null,
      exercise_mode: mode,
    });
  }
  return usable;
}

// Push a job and start the drain loop if it isn't already running.
export function enqueueEnrich(kind: Kind, id: number): void {
  queue.push({ kind, id });
  if (!draining) void drain();
}

// The repo stores the athlete's words and must not import this engine (the barrel
// would close a cycle), so the engine registers itself. Until it does — a migration
// CLI, a storage-only test — a verbatim report is still written; it simply waits.
repo.registerSymptomExtractionHook((reportId) => enqueueEnrich("symptom", reportId));

/**
 * Whether this free text is worth an agent call at all. Re-exported from the one
 * capture contract so every enqueue site asks the same question — "great session,
 * felt strong" must never cost an invocation, and a body report must never be
 * dropped for lack of a keyword list at one call site.
 */
export { symptomTextMentionsBody };

/**
 * The enrichment queue drains OUTSIDE any request, so nothing has ever put a zone
 * in scope for it — and everything it calls that frames a local day (a CCDA draw
 * stamped `20260824233000-0500`, a food note's `eaten_at`) then fell back to the
 * container's own clock. On a UTC container that files a Saturday-evening blood
 * draw on Sunday. The scheduler already answers this by running each tick inside
 * the owner's recorded zone; the queue now does the same, and defers to a live
 * request zone when a drain happens to start inside one.
 */
export function inOwnerTimeZone<T>(fn: () => T): T {
  return runWithTimeZone(activeTimeZone() ?? repo.recordedClientTimeZone(), fn);
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const job = queue.shift()!;
      try {
        await inOwnerTimeZone(() => processJob(job));
      } catch (e: any) {
        // A failing job must never break the loop. Mark it failed (regex data
        // is left intact) and continue with the next.
        try {
          markFailed(job, e);
        } catch {
          /* ignore */
        }
        console.error(`[enrich] job ${job.kind}#${job.id} failed (${diagnosticErrorName(e)})`);
        // The batch's review refresh is enqueued by the LAST health document to finish
        // (shouldEnqueueReviewRefresh). If that document is the one that threw, the
        // refresh would be lost for the whole batch — so a failing health job still
        // asks, and the guard decides. A failure keeps the previous review either way.
        if (job.kind === "health") {
          try {
            enqueueReviewRefresh();
          } catch {
            /* ignore */
          }
        }
      }
    }
  } finally {
    draining = false;
  }
}

function markStatus(job: Job, status: string): void {
  if (job.kind === "review" || job.kind === "garmin_strength") return; // no row status of their own
  // symptom_reports.extraction_status is a narrower machine than the enrichment
  // rows' (no 'in_progress' — a report is never half-extracted, it either yielded a
  // structure or it did not), so it is set only through its own dedicated path.
  if (job.kind === "symptom") {
    repo.setSymptomReportExtraction(job.id, status === "done" ? "done" : status === "skipped" ? "skipped" : "failed");
    return;
  }
  if (job.kind === "activity") repo.setActivityEnrichStatus(job.id, status);
  // food_photo shares the food_notes row + its status column with food.
  else if (job.kind === "food" || job.kind === "food_photo") repo.setFoodNoteEnrichStatus(job.id, status);
  else if (job.kind === "exercise") repo.setExerciseEnrichStatus(job.id, status);
  else repo.setHealthDocEnrichStatus(job.id, status);
}

function markFailed(job: Job, error: unknown = new Error("invalid enrichment output")): void {
  markStatus(job, "failed");
  recordAsyncFailure("enrichment", job.kind, error);
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
    repo.imagingStudyHasContent(parsed?.imaging_study) ||
    (Array.isArray(parsed?.markers) && parsed.markers.length > 0) ||
    (Array.isArray(parsed?.clinical_facts) && parsed.clinical_facts.length > 0) ||
    (Array.isArray(parsed?.panels) && parsed.panels.some((p: any) =>
      (Array.isArray(p?.markers) && p.markers.length > 0) ||
      (Array.isArray(p?.clinical_facts) && p.clinical_facts.length > 0)
    ))
  );
}

// ---------- honest degrade ----------
// A health import that completed on its deterministic path alone is NOT the same
// thing as an analyzed one: the labs, vitals and facts are real, but the written
// read never happened. The source row carries that distinction so the card can
// say so plainly instead of showing "✦ analyzed" over a half-finished ingest.
export interface DeterministicIngestState {
  mode: "deterministic";
  reason: string;
  detail: string;
  at: string;
}

const AVAILABILITY_WORDS: Record<string, string> = {
  weekly_limit: "weekly limit reached",
  usage_limit: "usage limit reached",
  rate_limited: "rate limited",
  needs_credit: "needs credit",
  needs_login: "needs sign-in",
  quota_exhausted: "out of quota",
  unavailable: "unavailable",
};

function agentLabel(name: string): string {
  const raw = String(name ?? "").trim();
  if (!raw) return "An agent";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// Why the agent step produced nothing, in the athlete's words. Prefers the
// availability read a sibling stream attaches to each attempt (it knows about
// resets and holds); with no availability it falls back to the attempt's error
// CLASS, never its text.
//
// The text arm is gone on purpose: on the throw path `attempt.error` is raw
// stderr, and this string is persisted into `health_documents.parsed_json.ingest
// .detail` and rendered on the card. A CLI stack trace, a home-directory path or
// a provider URL has no business in a durable health row.
export function describeAgentDegrade(error: unknown): { reason: string; detail: string } {
  const tried = Array.isArray((error as any)?.tried) ? ((error as any).tried as any[]) : [];
  const states = new Map<string, number>();
  const parts: string[] = [];
  for (const attempt of tried) {
    const availability = attempt?.availability && typeof attempt.availability === "object" ? attempt.availability : null;
    const state = typeof availability?.state === "string" ? availability.state : null;
    if (state) states.set(state, (states.get(state) ?? 0) + 1);
    const errorClass = state ? null : agentErrorClass(attempt?.status, attempt?.error);
    const words =
      (typeof availability?.detail === "string" && availability.detail.trim()) ||
      (state ? AVAILABILITY_WORDS[state] ?? state.replace(/_/g, " ") : "") ||
      (errorClass ? AVAILABILITY_WORDS[errorClass] ?? errorClass.replace(/_/g, " ") : "") ||
      "no usable output";
    parts.push(`${agentLabel(attempt?.agent)}: ${words.replace(/\s+/g, " ").slice(0, 80)}`);
  }
  let dominant = "";
  let best = 0;
  for (const [state, n] of states) {
    if (n > best) {
      best = n;
      dominant = state;
    }
  }
  const detail = parts.join(" · ").slice(0, 240);
  return {
    reason: dominant || "no_valid_output",
    detail: detail || "No agent returned a usable read.",
  };
}

function noteDeterministicIngest(id: number, reason: string, detail: string): void {
  try {
    const row = repo.getHealthDocumentRaw(id) as any;
    if (!row) return;
    let parsed: any = {};
    try {
      const raw = row.parsed_json;
      const decoded = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) parsed = decoded;
    } catch { /* an unreadable parsed_json is replaced, not preserved */ }
    const ingest: DeterministicIngestState = {
      mode: "deterministic",
      reason: String(reason || "no_valid_output").slice(0, 60),
      detail: String(detail || "").slice(0, 240),
      at: new Date().toISOString(),
    };
    repo.updateHealthDocFields(id, { parsed_json: { ...parsed, ingest } });
  } catch (e: any) {
    console.warn(`[enrich] health#${id}: could not record the degraded ingest state (${e?.message ?? e}).`);
  }
  recordDegradedOperation("enrichment", "health", reason);
}

function clearDeterministicIngest(id: number): void {
  try {
    const row = repo.getHealthDocumentRaw(id) as any;
    if (!row?.parsed_json) return;
    const parsed = typeof row.parsed_json === "string" ? JSON.parse(row.parsed_json) : row.parsed_json;
    if (!parsed || typeof parsed !== "object" || !parsed.ingest) return;
    const { ingest: _dropped, ...rest } = parsed;
    repo.updateHealthDocFields(id, { parsed_json: rest });
  } catch { /* the mark is advisory; failing to clear it must not fail the job */ }
}

async function processJob(job: Job): Promise<void> {
  if (job.kind === "review") return processReviewJob();
  if (job.kind === "garmin_strength") return processGarminStrengthJob(job.id);
  if (job.kind === "food_photo") return processFoodPhotoJob(job.id);
  if (job.kind === "exercise") return processExerciseJob(job.id);
  if (job.kind === "symptom") return processSymptomJob(job.id);

  // Check enablement BEFORE picking an agent: pickAgentOrder() advances the
  // round-robin cursor as a side effect, so calling it for a job we then skip
  // would burn rotation state against a phantom invocation.
  const settings = repo.getSettings();
  if (!settings.enrich_enabled) {
    if (job.kind === "health") {
      const backfill = repo.backfillCcdaHealthDocument(job.id);
      if (backfill.wrote) {
        console.log(`[enrich] health#${job.id}: deterministic CCDA backfill wrote ${backfill.clinicalFacts} fact(s), ${backfill.resultMarkers} lab marker(s), ${backfill.vitalMarkers} vital marker(s), ${backfill.bpReadings}/${backfill.extractedBpReadings} BP row(s) (agent enrichment off).`);
        noteDeterministicIngest(job.id, "enrichment_off", "Agent analysis is switched off in Settings.");
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
  // pickAgentOrderForTask resolves an `agent_routes.health`/`.enrich` pin first (if
  // usable), then falls to that task class's policy.
  const task = job.kind === "health" ? "health" : "enrich";
  const order = repo.pickAgentOrderForTask(task);
  if (!order.length) {
    if (job.kind === "health") {
      const backfill = repo.backfillCcdaHealthDocument(job.id);
      if (backfill.wrote) {
        console.log(`[enrich] health#${job.id}: deterministic CCDA backfill wrote ${backfill.clinicalFacts} fact(s), ${backfill.resultMarkers} lab marker(s), ${backfill.vitalMarkers} vital marker(s), ${backfill.bpReadings}/${backfill.extractedBpReadings} BP row(s) (no usable agent).`);
        noteDeterministicIngest(job.id, "no_agent_enabled", "No agent is enabled — turn one on in Settings.");
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
  let imagingBaseRevisionState: repo.ImagingStudyRevisionState | null = null;
  let ccdaExtraction: ReturnType<typeof repo.extractCcdaHealthData> | null = null;
  if (job.kind === "health") {
    const row = repo.getHealthDocumentRaw(job.id) as any;
    if (row?.kind === "imaging") {
      imagingBaseRevisionState = repo.imagingStudyRevisionState(job.id);
      // Raw DICOM objects never enter an agent prompt. Only ordinary written
      // attachments and bounded server-rendered representative PNGs are eligible.
      const files = repo.listImagingPromptFilesRaw(job.id) as any[];
      const promptFiles = files.map((file) => {
        const safe = safeUploadPath(file.file_path);
        return safe && fs.existsSync(safe) ? {
          id: file.id,
          sequence: file.sequence,
          path: safe,
          mime: file.mime,
          source_kind: file.source_kind,
          original_name: file.original_name,
        } : null;
      }).filter(Boolean) as any[];
      if (!promptFiles.length) {
        markStatus(job, "skipped");
        return;
      }
      markStatus(job, "in_progress");
      healthSource = { fp: promptFiles[0].path, mime: promptFiles[0].mime, kind: "imaging", isDir: false, imaging: true };
      let existing: any = null;
      try { existing = row.parsed_json ? JSON.parse(row.parsed_json)?.imaging_study : null; } catch {}
      prompt = buildImagingStudyPrompt(promptFiles, existing);
      timeoutMs = HEALTH_INGEST_TIMEOUT_MS;
    } else {
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
      prompt = buildHealthIngestPrompt(target, isDir, row?.kind || "other", {
        inventory: isDir ? buildHealthSourceInventory(target) : undefined,
      });
      timeoutMs = HEALTH_INGEST_TIMEOUT_MS;
    }
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
  // Kept so a deterministic-only completion can say WHY the agent step produced
  // nothing (out of quota, needs sign-in, no usable output) instead of quietly
  // presenting a half-finished import as analyzed.
  let agentFailure: unknown = null;
  try {
    // Effort/model are server policy (repo.TASK_EXECUTION_PROFILES), not whatever the
    // CLI's home settings happen to say: ingestion is a deep/high transcription read,
    // ordinary enrichment is cheap structuring.
    const fb = await runAgentWithFallback(order, prompt, { timeoutMs, profile: repo.executionProfileForTask(task) });
    parsed = fb.result?.parsed ?? null;
    if (!parsed) agentFailure = new AgentFallbackError(order, [{ agent: fb.agent ?? "agent", error: "no usable output" }]);
  } catch (e: unknown) {
    parsed = null;
    agentFailure = e;
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
        const degrade = describeAgentDegrade(agentFailure);
        console.warn(`[enrich] health#${job.id}: agent returned no usable JSON (${degrade.reason}); deterministic CCDA backfill wrote ${backfill.clinicalFacts} fact(s), ${backfill.resultMarkers} lab marker(s), ${backfill.vitalMarkers} vital marker(s), ${backfill.bpReadings}/${backfill.extractedBpReadings} BP row(s).`);
        noteDeterministicIngest(job.id, degrade.reason, degrade.detail);
        foldDuplicateHealthPanels(job.id);
        markStatus(job, "done");
        try { repo.deriveDirectives(); } catch (e: any) { console.warn(`[enrich] deriveDirectives failed: ${e?.message}`); }
        enqueueReviewRefresh();
        return;
      }
    }
    if (job.kind === "health") {
      const fallback = applyTextVisitNoteFallback(job.id, healthSource);
      if (fallback.applied) {
        const degrade = describeAgentDegrade(agentFailure);
        console.warn(`[enrich] health#${job.id}: agent returned no usable JSON (${degrade.reason}); deterministic visit-note fallback wrote ${fallback.facts} fact(s).`);
        noteDeterministicIngest(job.id, degrade.reason, degrade.detail);
        foldDuplicateHealthPanels(job.id);
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
    markFailed(job);
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
  if (healthSource && !healthSource.isDir && !healthSource.imaging) {
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
          repo.pickAgentOrderForTask("health"),
          buildHealthIngestPrompt(healthSource.fp, false, healthSource.kind, { emphasizeCompleteness: true, missed: { got, expected } }),
          { timeoutMs: HEALTH_INGEST_TIMEOUT_MS, profile: repo.executionProfileForTask("health") },
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
  const healthApply =
    job.kind === "health"
      ? applyHealthIngestResult(job.id, parsed, { imagingBaseRevisionState, ccda: ccdaExtraction })
      : null;
  if (healthApply?.status === "stale") {
    const settled = settleStaleImagingJob(job.id, healthApply.reason);
    console.warn(
      `[enrich] imaging#${job.id}: analysis became stale (${healthApply.reason}); ` +
        (settled.requeued ? "queued one fresh pass." : "kept user state; manual retry needed.")
    );
    return;
  }
  const appliedFields = job.kind === "health" ? healthApply?.status === "applied" : applyStructured(job, parsed.structured);
  const ccdaBackfill =
    job.kind === "health" && ccdaExtraction ? repo.applyCcdaHealthBackfill(job.id, ccdaExtraction) : null;
  if (ccdaBackfill?.wrote) {
    console.log(`[enrich] health#${job.id}: deterministic CCDA backfill wrote ${ccdaBackfill.clinicalFacts} fact(s), ${ccdaBackfill.resultMarkers} lab marker(s) across ${ccdaBackfill.resultPanels} panel(s), ${ccdaBackfill.vitalMarkers} vital marker(s), ${ccdaBackfill.bpReadings}/${ccdaBackfill.extractedBpReadings} BP row(s).`);
  }
  if (job.kind === "health") foldDuplicateHealthPanels(job.id);

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
      markFailed(job);
      return;
    }
    console.warn(`[enrich] ${job.kind}#${job.id}: agent returned parseable JSON but nothing usable (wrong shape?) — kept regex parse.`);
  }

  // The agent ran, but only the deterministic passes actually wrote: the import
  // is real and complete as far as it goes, and the card must say which read it
  // got. A genuine agent apply clears any earlier mark.
  if (job.kind === "health" && !healthSource?.imaging) {
    if (appliedFields) clearDeterministicIngest(job.id);
    else if (ccdaBackfill?.wrote || fallbackApplied) {
      noteDeterministicIngest(job.id, "no_valid_output", "The agent's answer wasn't a usable health read.");
    }
  }

  markStatus(job, "done");

  // A health document successfully analyzed means new marker data. Re-run the
  // deterministic markers→directives propagation (idempotent: clears + re-derives
  // only the 'markers' source) so the connected brain reflects the latest panel
  // without waiting for a manual Derive, then refresh the whole-picture health
  // review as a follow-on job on this same serial queue. Never for activity/food.
  if (job.kind === "health" && !healthSource?.imaging) {
    // First, let the agent align any new analyte synonyms this lab introduced
    // (e.g. an abbreviation the KB never saw) so the merged series feed everything
    // below. Fail-open: the deterministic normalizer + KB already ran at read time.
    try { await reconcileMarkers("auto"); } catch (e: any) { console.warn(`[enrich] marker reconcile failed: ${e?.message}`); }
    try { repo.deriveDirectives(); } catch (e: any) { console.warn(`[enrich] deriveDirectives failed: ${e?.message}`); }
    // Recompute the lab/marker recheck cadence NOW (event-driven), alongside the
    // directive propagation, so a mid-day upload's "next checkup" recheck surfaces
    // immediately instead of waiting for the nightly checkup_attention_date op. The
    // GET /health/next-checkup read is otherwise read-only. Fail-open like the rest.
    try { repo.refreshDoctorLoopAttention(); } catch (e: any) { console.warn(`[enrich] doctor-loop attention refresh failed: ${e?.message}`); }
    // "Worse than last time" is an EVENT (owner ruling R1). The outcome annotations were
    // pull-only — nobody ever computed them unless the user opened the read — so a panel
    // that came back further off-optimal left no trace anywhere: the directive quietly
    // absorbed the new number and the connected brain carried on as if nothing had
    // happened. Recording them HERE, on the ingest that produced the new reading, is what
    // makes a worsening marker a dated fact the ledger and the insight layer can both see.
    // Fingerprint-idempotent, so every document in a batch may call it. Fail-open.
    try { repo.recordHealthOutcomeEvents(); } catch (e: any) { console.warn(`[enrich] health outcome events failed: ${e?.message}`); }
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
  // health review to the Claude-first health order (an explicit `health_review` pin still
  // wins — same task label the interactive runHealthReview op uses), NOT the round-robin
  // rotation.
  const order = repo.pickAgentOrderForTask("health_review");
  if (!order.length) return;

  const prompt = buildHealthReviewPrompt();
  let agent: string | null = null;
  let raw: string | undefined;
  let parsed: any = null;
  try {
    const fb = await runAgentWithFallback(order, prompt, {
      timeoutMs: ENRICH_TIMEOUT_MS,
      profile: repo.executionProfileForTask("health_review"),
    });
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
// here the agent adds the one-line "body's reaction" read. Garmin exercises are
// imported only when set authority resolves watch-only at job start; when Cairn sets
// are authoritative, BOTH detected and agent-returned sets are ignored. Degrades to
// a clean no-op (the deterministic merge stands) when enrichment/agents are off.
// Exported for focused offline policy tests.
export async function processGarminStrengthJob(garminActivityId: number): Promise<void> {
  let ga = repo.getGarminActivity(garminActivityId) as any;
  if (!ga) return;
  // Ensure the deterministic merge happened (a re-enqueue after restart / manual
  // trigger may reach here before reconcileGarminStrength has run).
  if (!ga.session_id) {
    try { repo.reconcileGarminStrength(garminActivityId); } catch { /* not strength / nothing to attach */ }
    ga = repo.getGarminActivity(garminActivityId) as any;
  }
  if (!ga?.session_id) return; // not a strength activity, or no session to attach to

  const setImportKey = String(ga.external_id ?? `garmin-activity:${ga.id}`);
  const detectedSets = garminDetectedSetInputs(ga);
  // The repo operation re-reads authority and set count inside its savepoint. This
  // closes the reconcile→job race and commits all sets with their ledger marker.
  const initialImport = repo.importGarminActivitySets({
    session_id: ga.session_id,
    date: ga.date,
    activity_key: setImportKey,
    sets: detectedSets,
  });
  let logged = initialImport.imported;

  const settings = repo.getSettings();
  if (!settings.enrich_enabled) {
    // The physiology and any atomic deterministic set import stand; skip narrative.
    if (logged) {
      console.log(`[enrich] garmin_strength#${garminActivityId}: logged ${logged} detected set(s) deterministically (no narrative — enrichment off).`);
    }
    return;
  }
  const order = repo.pickAgentOrderForTask("enrich");
  if (!order.length) {
    if (logged) {
      console.log(`[enrich] garmin_strength#${garminActivityId}: logged ${logged} detected set(s) deterministically (no agent for narrative).`);
    }
    return;
  }

  let parsed: any = null;
  let agent: string | null = null;
  try {
    const fb = await runAgentWithFallback(order, buildGarminStrengthPrompt(ga), {
      timeoutMs: ENRICH_TIMEOUT_MS,
      profile: repo.executionProfileForTask("enrich"),
    });
    agent = fb.agent ?? null;
    parsed = fb.result?.parsed ?? null;
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object") {
    // Deterministic sets + physiology stand; just no one-line narrative this run.
    return;
  }

  // If the deterministic pass had no usable sets, a valid agent reconstruction is
  // the fallback. Re-read after the await so a Cairn set logged while the agent was
  // thinking can win; the repo then checks once more inside the atomic savepoint.
  if (detectedSets.length === 0) {
    // This explicit refresh is also what keeps prompt-time state from being treated
    // as current after a potentially long-running external agent call.
    const refreshedSession = repo.getSessionDetail(ga.session_id);
    const agentSets = refreshedSession ? agentGarminSetInputs(parsed) : [];
    const fallbackImport = repo.importGarminActivitySets({
      session_id: ga.session_id,
      date: ga.date,
      activity_key: setImportKey,
      sets: agentSets,
    });
    logged += fallbackImport.imported;
  }

  const session = repo.getSessionDetail(ga.session_id) as any;
  repo.updateSessionGarminNarrative(ga.session_id, {
    summary: asStr(parsed.summary) ?? null,
    intensity: ["easy", "moderate", "hard"].includes(parsed.intensity) ? parsed.intensity : null,
    // When Cairn owns the sets, an agent's ignored reconstruction must not make the
    // session look extrapolated. Preserve only a pre-existing historical flag.
    extrapolated: !!session?.garmin?.extrapolated,
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

  const order = repo.pickAgentOrderForTask("enrich");
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
      const fb = await runAgentWithFallback(order, buildExerciseEnrichPrompt(repo.getExerciseDetail(ex.name)), {
        timeoutMs: ENRICH_TIMEOUT_MS,
        profile: repo.executionProfileForTask("enrich"),
      });
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

// ---- verbatim pain report → structure ------------------------------------------
// The ONLY writer of structure from an athlete's pain words. Everything it applies
// goes through the existing lifecycle repo functions (reportTrainingSymptom,
// recurTrainingSymptom, resolveTrainingSymptomByArea, recordMovementTolerance) — no
// raw SQL — so every idempotency guard, epoch rule and proposal-truth snapshot keeps
// working exactly as it did when a button was the caller.

// Movements the report could plausibly be about: what they trained that day first,
// then what they have trained lately. The model may only name from this list, and
// coerceSymptomCapture re-matches every name against it.
function symptomCaptureMovements(sessionId: number | null, on: string): { session: string[]; recent: string[] } {
  const session: string[] = [];
  const recent: string[] = [];
  try {
    if (sessionId != null) {
      const detail = repo.getSessionDetail(sessionId) as any;
      for (const set of Array.isArray(detail?.sets) ? detail.sets : []) {
        const name = String(set?.exercise ?? "").trim();
        if (name && !session.includes(name)) session.push(name);
      }
    }
  } catch {
    /* a report can arrive with no session attached — that is normal */
  }
  try {
    for (const row of repo.getRecentSessions(10, { through: on }) as any[]) {
      for (const set of Array.isArray(row?.sets) ? row.sets : []) {
        const name = String(set?.exercise ?? "").trim();
        if (name && !session.includes(name) && !recent.includes(name)) recent.push(name);
      }
    }
  } catch {
    /* no recent training history → the model simply names nothing */
  }
  return { session, recent };
}

function symptomAreaMatch(label: string, on: string): any | null {
  const key = symptomAreaKey(label);
  if (!key) return null;
  const events = repo.listTrainingSymptoms({ on, include_resolved: true, seed_legacy: false });
  return (
    events
      .filter((event: any) => event.scope !== "systemic" && symptomAreaKey(event.area_text) === key)
      .sort((a: any, b: any) => String(b.last_reported_on).localeCompare(String(a.last_reported_on)) || b.id - a.id)[0] ??
    null
  );
}

/**
 * Apply one validated extraction. Exported so the offline test can drive the whole
 * deterministic half without an agent — the same discipline applyFoodPhoto follows,
 * and the reason a stub that cannot speak this contract is still enough to prove the
 * lane's degradation paths.
 *
 * Idempotent: a second pass over the same result re-reports the same day (which
 * reportTrainingSymptom treats as a retry) and re-offers the same exposures (which
 * the unique exposure indexes ignore).
 */
export function applySymptomExtraction(
  reportId: number,
  result: { found: boolean; reports: SymptomCaptureReport[] }
): { events: number; observations: number } {
  const out = { events: 0, observations: 0 };
  const report = repo.getSymptomReport(reportId);
  if (!report || !result.found) return out;
  const on = report.reported_on;

  for (const entry of result.reports) {
    let event: any = null;
    if (entry.scope === "systemic") {
      // No place named, so the label is the athlete's own phrase, clamped by the
      // same short-label normalizer every other write crosses. It can never load a
      // lift — scope 'systemic' is checked before relevance ever runs.
      event = repo.reportTrainingSymptom({
        area_text: entry.quote,
        report_text: entry.quote,
        onset_on: on,
        source_session_id: report.session_id,
        source_kind: "symptom_extraction",
        scope: "systemic",
        record_report: false,
      });
    } else if (entry.change === "resolved") {
      // Closing a watch is still the athlete's call — this only carries out a
      // closure they stated in their own words.
      event = entry.area_label ? repo.resolveTrainingSymptomByArea(entry.area_label, on) : null;
    } else {
      const matched = entry.area_label ? symptomAreaMatch(entry.area_label, on) : null;
      if (matched && matched.status === "resolved" && (entry.change === "new" || entry.change === "worse")) {
        // It came back. The dedicated recurrence path owns the epoch reset; a plain
        // re-report would open a second, orphaned record for the same place.
        event = repo.recurTrainingSymptom(matched.id, { on, area_text: entry.area_label ?? undefined });
      } else {
        event = repo.reportTrainingSymptom({
          area_text: entry.area_label!,
          report_text: entry.quote,
          onset_on: on,
          source_session_id: report.session_id,
          source_kind: "symptom_extraction",
          record_report: false,
        });
      }
    }
    if (!event) continue;
    out.events++;
    // EVERY watch this sentence produced points back at it, not just the first. A note
    // naming two places opens two watches, and the second used to render with no words
    // and age as though the athlete had never spoken about it.
    repo.attachSymptomReportEvent(reportId, Number(event.id));
    for (const movement of entry.movements) {
      try {
        const before = toleranceSnapshot(repo.getTrainingSymptom(Number(event.id), on));
        repo.recordMovementTolerance({
          symptom_event_id: Number(event.id),
          movement: movement.name,
          observed_on: on,
          session_id: report.session_id,
          pain_free: movement.outcome === "pain_free",
          evidence: "stated",
        });
        // Comparing the two hydrated OBJECTS was always true — they are freshly built
        // every call — so a re-applied extraction counted a write per movement it had
        // already recorded. Compare what a write would actually move.
        if (toleranceSnapshot(repo.getTrainingSymptom(Number(event.id), on)) !== before) out.observations++;
      } catch {
        /* one unmappable movement must not lose the rest of the report */
      }
    }
  }
  return out;
}

// Everything a tolerance write can move: the exposure counts per movement, plus the
// epoch and recurrence a pain_present write bumps. Equal snapshots mean nothing was
// written — the exposure was already on record.
function toleranceSnapshot(event: any): string {
  if (!event) return "";
  return JSON.stringify([event.evidence_epoch, event.recurrence_count, event.movement_readiness]);
}

/**
 * Derive structure from one verbatim pain report. Degrades cleanly at every step —
 * enrichment off, no agent, an unparseable reply, a payload that fails validation —
 * and in every one of those cases the athlete's words stand untouched and on screen.
 * Exported so the offline test can drive those refusals directly.
 */
export async function processSymptomJob(id: number): Promise<void> {
  const report = repo.getSymptomReport(id);
  if (!report) return; // deleted while queued
  // Extraction runs ONCE per report. A re-enqueue (crash recovery, a manual retry of
  // a sibling job) must not re-ask an agent about words it already read.
  if (report.extraction_status !== "pending") return;

  const settings = repo.getSettings();
  if (!settings.enrich_enabled) {
    repo.setSymptomReportExtraction(id, "skipped");
    return;
  }
  const order = repo.pickAgentOrderForTask("enrich");
  if (!order.length) {
    repo.setSymptomReportExtraction(id, "skipped");
    return;
  }

  const movements = symptomCaptureMovements(report.session_id, report.reported_on);
  const ctx: SymptomCaptureContext = {
    text: report.text,
    reported_on: report.reported_on,
    active_events: repo
      .listTrainingSymptoms({ on: report.reported_on, include_resolved: false, seed_legacy: false })
      .map((event: any) => ({
        id: Number(event.id),
        area_label: String(event.area_text),
        scope: event.scope === "systemic" ? ("systemic" as const) : ("area" as const),
      })),
    session_movements: movements.session,
    recent_movements: movements.recent,
  };

  let parsed: any = null;
  try {
    const fb = await runAgentWithFallback(order, buildSymptomCapturePrompt(ctx), {
      timeoutMs: ENRICH_TIMEOUT_MS,
      profile: repo.executionProfileForTask("enrich"),
    });
    parsed = fb.result?.parsed ?? null;
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object") {
    console.warn(`[enrich] symptom#${id}: no usable JSON — the athlete's words stand as written.`);
    markFailed({ kind: "symptom", id });
    return;
  }

  const validation = coerceSymptomCapture(parsed, ctx);
  if (!validation.ok) {
    console.warn(`[enrich] symptom#${id}: extraction rejected (${validation.reason}) — words kept, nothing derived.`);
    markFailed({ kind: "symptom", id });
    return;
  }
  try {
    applySymptomExtraction(id, validation.result);
  } catch (e: any) {
    console.warn(`[enrich] symptom#${id}: applying the extraction failed (${e?.message ?? e}).`);
    markFailed({ kind: "symptom", id });
    return;
  }
  repo.setSymptomReportExtraction(id, "done", validation.result);
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
  // file-reading transcriber (Claude-first), the same "health" task the doc-ingest
  // kind uses (and pin), rather than the load-spreading round-robin.
  const order = repo.pickAgentOrderForTask("health");
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
      const fb = await runAgentWithFallback(order, buildFoodPhotoPrompt(fp, hint || undefined), {
        timeoutMs: ENRICH_TIMEOUT_MS,
        profile: repo.executionProfileForTask("health"),
      });
      parsed = fb.result?.parsed ?? null;
      wrote = !!parsed && applyFoodPhoto(id, parsed);
    } catch {
      parsed = null;
    }
  }

  if (!wrote && (!parsed || typeof parsed !== "object")) {
    // Vision read failed / wrong shape: keep the as-logged note (its instant
    // summary stands), just no macro estimate this run. A re-trigger can retry.
    markFailed({ kind: "food_photo", id });
    return;
  }

  if (!wrote) {
    // Parseable JSON but nothing usable (e.g. a coach-proposal response) — the
    // as-logged note stands; surface it as failed so a re-trigger can retry.
    console.warn(`[enrich] food_photo#${id}: agent returned parseable JSON but no usable macros (wrong shape?) — kept as-logged note.`);
    markFailed({ kind: "food_photo", id });
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
  // Prefer the STRUCTURED rows when the vision read gave them: `ingredients` carries
  // the amount as a field, `items` carries it inside display prose.
  const inferredTotals = foodMacroTotalsFrom(parsed.ingredients) ?? foodMacroTotalsFrom(parsed.items);

  const summary = asStr(parsed.summary);
  if (summary !== undefined) { merged.summary = summary; changed = true; }
  if (Array.isArray(parsed.items)) {
    const items = coerceFoodItems(parsed.items) ?? [];
    if (items.length) {
      merged.items = items;
      changed = true;
    }
  }
  // The photo path is where the portion is INFERRED, so this is exactly where
  // structure is worth the most: rows with their own amounts and macros, rather
  // than quantities embedded in a display string nothing can reason over. It is
  // only safe because provenance travels with them (stamped below).
  const ingredients = coerceFoodIngredients(parsed.ingredients);
  if (ingredients?.length) {
    merged.ingredients = ingredients;
    changed = true;
  }
  const kcal = asNum(parsed.kcal ?? inferredTotals?.kcal); if (kcal !== undefined) { merged.kcal = clampFoodMacro("kcal", kcal); changed = true; usableMacro = true; }
  const protein = asNum(parsed.protein_g ?? inferredTotals?.protein_g); if (protein !== undefined) { merged.protein_g = clampFoodMacro("protein_g", protein); changed = true; usableMacro = true; }
  const carbs = asNum(parsed.carbs_g ?? inferredTotals?.carbs_g); if (carbs !== undefined) { merged.carbs_g = clampFoodMacro("carbs_g", carbs); changed = true; usableMacro = true; }
  const fat = asNum(parsed.fat_g ?? inferredTotals?.fat_g); if (fat !== undefined) { merged.fat_g = clampFoodMacro("fat_g", fat); changed = true; usableMacro = true; }
  const fiber = asNum(parsed.fiber_g ?? inferredTotals?.fiber_g); if (fiber !== undefined) { merged.fiber_g = clampFoodMacro("fiber_g", fiber); changed = true; usableMacro = true; }
  const notes = asStr(parsed.notes);
  if (notes !== undefined) {
    merged.notes = notes;
    changed = true;
  } else if (isImageAccessFailureNote(merged.notes)) {
    merged.notes = null;
    changed = true;
  }

  const pattern = coerceNutritionPattern(parsed.nutrition_pattern, "photo", parsed.fat_g ?? merged.fat_g);
  if (pattern) {
    merged.nutrition_pattern = pattern;
    changed = true;
  }
  // The estimate came from the plate photo — mark provenance so the surface can say
  // "estimated from your photo" rather than implying a precise hand-entered log.
  if (!usableMacro) return false;
  if (changed) {
    merged.from_photo = true;
    // Coarse band + how it was obtained, on EVERY stored estimate. A missing or
    // scored ("92%") confidence lands on the honest floor instead of being dropped:
    // an absent band is precisely the ambiguity this field exists to remove, and a
    // per-ingredient breakdown read off a picture must never end up looking like a
    // weighed log. Never a percentage, never a score.
    const provenance = coerceFoodProvenance(parsed, "photo");
    merged.confidence = provenance.confidence;
    merged.basis = provenance.basis;
  }

  if (changed) repo.updateFoodNoteParsed(id, merged);
  return changed;
}

function isImageAccessFailureNote(v: any): boolean {
  const s = String(v ?? "").toLowerCase();
  return !!s && /(unable|cannot|can't|could not|failed|blocked).{0,80}(image|photo|file|viewer|sandbox|access|open)/i.test(s);
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

export type HealthIngestApplyResult =
  | { status: "applied" }
  | { status: "not_applied" }
  | { status: "stale"; reason: "attachments_changed" | "user_state_changed" };

export function applyHealthIngestResult(
  id: number,
  parsed: any,
  opts: {
    imagingBaseRevision?: string | null;
    imagingBaseRevisionState?: repo.ImagingStudyRevisionState | null;
    ccda?: repo.CcdaHealthExtraction | null;
  } = {}
): HealthIngestApplyResult {
  const row = repo.getHealthDocumentRaw(id) as any;
  if (row?.kind === "imaging") {
    const result = repo.applyImagingAnalysisResult(id, parsed, {
      sourceKind: repo.imagingStudySourceKind(id),
      extractor: "health-enrichment",
      sourceDocId: row.source_doc_id ?? null,
      sha256: repo.imagingStudySourceHash(id),
      baseRevision: opts.imagingBaseRevision,
      baseRevisionState: opts.imagingBaseRevisionState,
    });
    return result.status === "applied"
      ? { status: "applied" }
      : result.status === "stale"
        ? { status: "stale", reason: result.reason }
        : { status: "not_applied" };
  }
  return applyHealthIngestNonImaging(id, parsed, opts.ccda) ? { status: "applied" } : { status: "not_applied" };
}

export function applyHealthIngest(
  id: number,
  parsed: any,
  opts: {
    imagingBaseRevision?: string | null;
    imagingBaseRevisionState?: repo.ImagingStudyRevisionState | null;
    ccda?: repo.CcdaHealthExtraction | null;
  } = {}
): boolean {
  return applyHealthIngestResult(id, parsed, opts).status === "applied";
}

// One panel per draw date: an import that carries a draw the record already
// holds (the same export uploaded twice, a re-export, the agent's read of what
// the CCDA pass already filed) folds into the record that holds it. Scoped to
// this upload's own rows so an ingest never rewrites what it did not touch.
function foldDuplicateHealthPanels(id: number): void {
  try {
    const folded = repo.dedupeHealthDocuments({ scopeSourceId: id });
    if (folded.merged) {
      console.log(
        `[enrich] health#${id}: folded ${folded.merged} duplicate panel(s) into ${folded.clusters.length} existing record(s) (+${folded.added_markers} marker(s)).`
      );
    }
  } catch (e: any) {
    console.warn(`[enrich] health#${id}: duplicate fold failed: ${e?.message ?? e}`);
  }
}

function applyHealthIngestNonImaging(id: number, parsed: any, ccda?: repo.CcdaHealthExtraction | null): boolean {
  const row = repo.getHealthDocumentRaw(id) as any;
  // MyChart/CCDA bundles may carry radiology reports alongside labs. Persist
  // those as derived first-class imaging records linked to the source artifact;
  // they are never flattened into lab panels or markers.
  const derivedImaging = Array.isArray(parsed?.imaging_studies)
    ? repo.replaceDerivedImagingStudies(id, parsed.imaging_studies, row?.original_name ?? null, {
        complete: parsed?.imaging_studies_complete === true,
      })
    : [];
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
      .filter((m: any) => m.name && !repo.isNonAnalyteMarkerName(m.name))
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

  let cleaned = panels
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

  // An undated panel is placed by its readings against the export's own dated
  // panels, or dropped: a derived record with no date reads as nothing in every
  // series and shows as "Set date" forever. The sole panel of a single-record
  // upload keeps riding the source row, which carries the athlete's own date.
  const undated = cleaned.filter((p) => !p.doc_date).length;
  if (undated && cleaned.length > 1) {
    const placed = repo.dateUndatedPanels(cleaned, ccda);
    console.warn(
      `[enrich] health#${id}: ${undated} undated panel(s) — ${placed.dated} placed by matching readings, ${placed.dropped} dropped.`
    );
    cleaned = placed.panels as typeof cleaned;
  }

  const markerCount = cleaned.reduce((n, p) => n + p.markers.length, 0);
  // A health-document result with only prose is not an ingest. This catches agent
  // sandbox/file-access failures like "I could not read the upload" before they
  // overwrite a previously valid marker panel with {"markers":[]}.
  if (!markerCount && !clinicalFacts.length) return derivedImaging.length > 0;
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

  // food: merge the agent's coerced estimate over the existing parsed_json blob,
  // through the SHARED food-capture coercion (src/foodCapture.ts) so this path, the
  // photo path and chat's log_food agree on one shape.
  const cur = (repo.getFoodNote(job.id) as any)?.parsed ?? {};
  const merged: Record<string, any> = { ...cur };
  let changed = false;
  // Meal totals are BUILT UP from the ingredient rows when the agent gave no
  // top-level number — which is how fiber stops being a top-down guess. A stated
  // total always wins over the sum.
  const inferredTotals = foodMacroTotalsFrom(structured.ingredients) ?? foodMacroTotalsFrom(structured.items);
  const summary = asStr(structured.summary);
  if (summary !== undefined) { merged.summary = summary; changed = true; }
  const items = coerceFoodItems(structured.items);
  if (items) {
    merged.items = items;
    changed = true;
  }
  const ingredients = coerceFoodIngredients(structured.ingredients);
  if (ingredients) {
    merged.ingredients = ingredients;
    changed = true;
  }
  const kcal = asNum(structured.kcal ?? inferredTotals?.kcal);
  if (kcal !== undefined) {
    merged.kcal = clampFoodMacro("kcal", kcal);
    changed = true;
  }
  const protein = asNum(structured.protein_g ?? inferredTotals?.protein_g);
  if (protein !== undefined) {
    merged.protein_g = clampFoodMacro("protein_g", protein);
    changed = true;
  }
  const carbs = asNum(structured.carbs_g ?? inferredTotals?.carbs_g);
  if (carbs !== undefined) {
    merged.carbs_g = clampFoodMacro("carbs_g", carbs);
    changed = true;
  }
  const fat = asNum(structured.fat_g ?? inferredTotals?.fat_g);
  if (fat !== undefined) {
    merged.fat_g = clampFoodMacro("fat_g", fat);
    changed = true;
  }
  const fiber = asNum(structured.fiber_g ?? inferredTotals?.fiber_g);
  if (fiber !== undefined) {
    merged.fiber_g = clampFoodMacro("fiber_g", fiber);
    changed = true;
  }
  const pattern = coerceNutritionPattern(structured.nutrition_pattern, "estimated_from_foods", structured.fat_g ?? merged.fat_g);
  if (pattern) {
    merged.nutrition_pattern = pattern;
    changed = true;
  }
  const fnotes = asStr(structured.notes);
  if (fnotes !== undefined) {
    merged.notes = fnotes;
    changed = true;
  }
  // How the numbers were obtained, on every stored estimate. A free-text note that
  // stated a real quantity ("205 g chicken") is a user_report the agent may mark
  // high-confidence; everything it filled in from ordinary servings defaults to
  // estimated_from_foods at the honest floor.
  if (changed) {
    const provenance = coerceFoodProvenance(structured, "estimated_from_foods");
    merged.confidence = provenance.confidence;
    merged.basis = provenance.basis;
  }
  if (changed) repo.updateFoodNoteParsed(job.id, merged);
  return changed;
}

// Crash recovery: re-enqueue every row left 'pending' (queued, never started) or
// 'in_progress' (started but interrupted by a restart). Called once at startup
// from server.ts. A re-run ends in 'done' or 'failed', so jobs don't loop.
export function recoverPendingEnrich(): {
  activities: number;
  food: number;
  health: number;
  exercises: number;
  symptoms: number;
} {
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
  // A verbatim pain report whose extraction never ran. The words survived the crash
  // (they were written synchronously); only the structuring is owed.
  const symptoms = repo.listPendingSymptomReports();
  for (const a of acts) enqueueEnrich("activity", a.id);
  for (const f of foods) enqueueEnrich(f.image_path ? "food_photo" : "food", f.id);
  for (const h of health) enqueueEnrich("health", h.id);
  for (const x of exercises) enqueueEnrich("exercise", x.id);
  for (const s of symptoms) enqueueEnrich("symptom", s.id);
  if (acts.length || foods.length || health.length || exercises.length || symptoms.length) {
    console.log(`[enrich] recovered ${acts.length} activity + ${foods.length} food + ${health.length} health + ${exercises.length} exercise + ${symptoms.length} symptom pending job(s).`);
  }
  return {
    activities: acts.length,
    food: foods.length,
    health: health.length,
    exercises: exercises.length,
    symptoms: symptoms.length,
  };
}
