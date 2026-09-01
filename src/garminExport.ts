// Cairn → Garmin strength write-back.
//
// Garmin stays the INPUT for runs, sleep and recovery — that direction is unchanged.
// What was missing is the other half: an athlete who lifts with Cairn on their phone
// and never starts a watch activity had a blank strength history on Garmin, and one
// who *did* start the watch got a recording with no exercises in it. So a finished
// Cairn strength session is pushed back as the day's exercise sets, in one of three
// shapes:
//
//   1. CAIRN-ONLY (no watch activity that day) — create a manual strength activity,
//      then write the sets onto it.
//   2. PARALLEL (Cairn sets AND a same-day watch strength activity) — write onto the
//      EXISTING activity, in place. Never a second upload: the watch's heart rate,
//      duration and calories are the physiology we want to keep, and a duplicate
//      activity would double-count the day everywhere Garmin aggregates.
//   3. GARMIN-ONLY (`cairn_sets_authoritative === false`) — Garmin's own detected
//      sets are the truth for that day and are never overwritten.
//
// And one repair: if we already created a manual activity and the watch's own
// recording of the same workout syncs afterwards, the sets move onto the watch
// activity and the manual shell is deleted — the day ends up with one activity.
// Physiology ranks which watch recording is the richer home; it does not gate the
// move.
//
// The endpoints are UNOFFICIAL (the same undocumented connectapi surface the read
// path already uses), so every failure is a quiet no-op: the athlete's Cairn log is
// the record of truth, and a Garmin write that didn't land costs nothing but a retry
// on the next sync.
import { createHash } from "node:crypto";
import { garminErrorStatus, makeGarminClient, rawDelete, rawGet, rawPost, rawPut } from "./garmin.js";
import * as repo from "./repo.js";
import { localDateISO } from "./repo/shared.js";
import type {
  GarminExportSetRow,
  GarminLinkedStrengthActivity,
  GarminSessionExportRecord,
} from "./repo/garmin-strength-export.js";

// ---- the write surface -----------------------------------------------------
export interface GarminStrengthWriteApi {
  getExerciseSets(activityId: string | number): Promise<any>;
  putExerciseSets(activityId: string | number, payload: any): Promise<void>;
  createManualActivity(input: { name: string; startTimeGmt: string; durationSec: number }): Promise<{
    activityId: number;
  }>;
  deleteActivity(activityId: string | number): Promise<void>;
}

// The Garmin client carries no request timeout of its own, and this queue is SERIAL —
// one stalled write would park every later enrichment job behind it. A write that has
// not answered in a minute has failed as far as Cairn is concerned; the next sync
// retries from the same fingerprint.
const GARMIN_WRITE_TIMEOUT_MS = 60_000;
const GARMIN_EXPORT_JOB_MS = 90_000;

function withDeadline<T>(label: string, work: Promise<T>, ms = GARMIN_WRITE_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Garmin ${label} timed out`)), ms);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** A refused credential, not a transient write failure — the memoized login is dead. */
function isGarminAuthFailure(error: unknown): boolean {
  const status = garminErrorStatus(error);
  return status === 401 || status === 403;
}

/**
 * The live write surface. `makeClient` is injectable so the memo behaviour can be
 * tested without an account; production always uses the real login.
 */
export function createLiveGarminStrengthApi(makeClient: () => Promise<any> = makeGarminClient): GarminStrengthWriteApi {
  // One login per export, resolved on first use: the client is expensive (it may
  // refresh tokens) and a skip must never pay for it. The LOGIN sits inside each
  // call's deadline too — a stalled token refresh parks the serial queue exactly the
  // same way a stalled write does.
  let pending: Promise<any> | null = null;
  const client = () => {
    if (!pending) {
      pending = makeClient().catch((error) => {
        pending = null;
        throw error;
      });
    }
    return pending;
  };
  // A memoized client outlives the process, so an expired session would 401 on every
  // export until a restart. Drop the login — and the module-level handle built from
  // it — the moment Garmin refuses the credential, so the next export signs in again.
  const guard = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (isGarminAuthFailure(error)) {
        pending = null;
        liveWriteApi = null;
      }
      throw error;
    }
  };
  const api: GarminStrengthWriteApi = {
    async getExerciseSets(activityId) {
      return guard(() =>
        withDeadline("read", (async () =>
          rawGet(await client(), `/activity-service/activity/${activityId}/exerciseSets`))())
      );
    },
    async putExerciseSets(activityId, payload) {
      // The PUT body mirrors the GET envelope exactly: {activityId, exerciseSets}.
      // Omitting the top-level activityId 400s ("Activity ID should not be Null in
      // the Exercises Object") — verified against a live activity's GET shape.
      const body = { activityId: Number(activityId), ...payload };
      await guard(() =>
        withDeadline("write", (async () =>
          rawPut(await client(), `/activity-service/activity/${activityId}/exerciseSets`, body))())
      );
    },
    async createManualActivity(input) {
      // POST /activity-service/activity — the /manual suffix 405s. The body is the
      // DTO shape the Connect web app sends; startTimeLocal is LOCAL wall-clock
      // time, and the process TZ is the athlete's (container TZ env), so a plain
      // local format of the UTC instant is correct.
      const startMs = Date.parse(`${input.startTimeGmt.replace(" ", "T")}Z`);
      const created = await guard(() =>
        withDeadline("create", (async () =>
          rawPost(await client(), "/activity-service/activity", {
            activityName: input.name,
            activityTypeDTO: { typeKey: "strength_training" },
            eventTypeDTO: { typeKey: "uncategorized" },
            timeZoneUnitDTO: { unitKey: localTimeZoneKey() },
            summaryDTO: {
              startTimeLocal: localWallClockIso(Number.isFinite(startMs) ? startMs : Date.now()),
              duration: input.durationSec,
              distance: 0,
            },
          }))())
      );
      const activityId = Number(created?.activityId ?? created?.activityIds?.[0] ?? created?.id);
      if (!Number.isFinite(activityId) || activityId <= 0) throw new Error("Garmin returned no activity id");
      return { activityId };
    },
    async deleteActivity(activityId) {
      await guard(() =>
        withDeadline("delete", (async () => rawDelete(await client(), `/activity-service/activity/${activityId}`))())
      );
    },
  };
  return api;
}

let apiFactory: (() => GarminStrengthWriteApi | Promise<GarminStrengthWriteApi>) | null = null;
let liveWriteApi: GarminStrengthWriteApi | null = null;

/**
 * Inject a fake write surface. The suite is offline and deterministic, so the tests
 * drive the whole decision tree (create / fill / replace / retarget / skip) against a
 * recording fake rather than a live account. Pass null to restore the live client.
 */
export function setGarminStrengthApiForTests(
  factory: (() => GarminStrengthWriteApi | Promise<GarminStrengthWriteApi>) | null
): void {
  apiFactory = factory;
  if (factory) liveWriteApi = null;
}

async function strengthApi(): Promise<GarminStrengthWriteApi> {
  if (apiFactory) return apiFactory();
  return (liveWriteApi ??= createLiveGarminStrengthApi());
}

// ---- the payload -----------------------------------------------------------
// A REST slot and an implausibly long ACTIVE slot are both left alone: the watch
// records rest between sets as its own entry, and a multi-minute "ACTIVE" block is
// the watch mis-segmenting rather than a set we should claim.
const ACTIVE_SLOT_MAX_SEC = 600;
const DEFAULT_SET_SEC = 45;
const FALLBACK_SESSION_MIN = 30;

export interface GarminExportPayloadSet {
  exercise: string;
  set_number: number;
  weight: number | null;
  reps: number | null;
  duration_sec: number | null;
  mode: string | null;
  garmin_category: string | null;
  garmin_exercise: string | null;
}

export interface GarminExportPayload {
  mode: "fill" | "replace";
  body: { exerciseSets: any[] };
  written: number;
}

function isRestSlot(slot: any): boolean {
  return String(slot?.setType ?? "").toUpperCase() === "REST";
}

function isFillableActiveSlot(slot: any): boolean {
  if (isRestSlot(slot)) return false;
  const duration = Number(slot?.duration);
  return !Number.isFinite(duration) || duration <= ACTIVE_SLOT_MAX_SEC;
}

function existingSlots(existing: any): any[] {
  const raw = Array.isArray(existing?.exerciseSets) ? existing.exerciseSets : Array.isArray(existing) ? existing : null;
  return raw ? raw.filter((slot: any) => slot && typeof slot === "object") : [];
}

// Garmin's exerciseSets timestamps have no zone suffix; the read path parses the
// same shape, so mirror it exactly rather than inventing an offset.
function garminSlotTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}.0`;
}

/** "YYYY-MM-DD HH:MM:SS" in UTC — the internal instant carried to the adapter. */
export function garminGmtStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/** The IANA zone this process runs in — the athlete's own (container TZ env). */
function localTimeZoneKey(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** "YYYY-MM-DDTHH:MM:SS.00" LOCAL wall-clock — summaryDTO.startTimeLocal's shape. */
function localWallClockIso(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}.00`;
}

function exerciseEntry(set: GarminExportPayloadSet): any[] {
  return [{ category: set.garmin_category, name: set.garmin_exercise ?? null, probability: 100 }];
}

function slotFor(set: GarminExportPayloadSet): { repetitionCount: number | null; weight: number | null; duration: number } {
  const timed = set.mode === "timed";
  return {
    repetitionCount: timed ? null : set.reps == null ? null : Math.max(0, Math.round(set.reps)),
    weight: timed ? null : repo.garminWeightGrams(set.weight),
    duration: timed && set.duration_sec != null && set.duration_sec > 0 ? Math.round(set.duration_sec) : DEFAULT_SET_SEC,
  };
}

/**
 * Build the exerciseSets body for one session, FILLING the watch's own slots when
 * the ACTIVE count matches Cairn's logged sets and REPLACING them otherwise.
 *
 * FILL matters because the watch's segmentation is real evidence: it knows when each
 * set happened and how long it took, and Cairn only knows what was lifted. So when
 * the slot COUNT MATCHES we write the exercise, reps and load INTO those slots and
 * leave rest periods exactly as they were. A mismatch (the athlete logged three
 * accessories onto an eight-set watch session) is not fillable — dropping Cairn's
 * names onto the first N slots would relabel the squats. REPLACE is then honest.
 *
 * The count that has to match is the athlete's WHOLE log (`totalLoggedSets`), not the
 * mapped subset: three mapped sets out of five logged lining up with three watch slots
 * is a coincidence, and filling positionally would move labels onto the wrong slots.
 *
 * REPLACE is also the fallback for a manual activity (no slots at all): one ACTIVE
 * slot per Cairn set, spread across the session's span so the timeline is plausible
 * rather than all stacked at once.
 *
 * Pure — no HTTP, no DB — so the whole shape is unit-testable.
 */
export function buildGarminExerciseSetsPayload(input: {
  sets: GarminExportPayloadSet[];
  existing?: any;
  sessionStartIso?: string | null;
  durationMin?: number | null;
  /** Every set the athlete logged, mapped or not. Defaults to the mapped count. */
  totalLoggedSets?: number | null;
}): GarminExportPayload {
  const sets = (input.sets ?? []).filter((set) => set && set.garmin_category);
  const slots = existingSlots(input.existing);
  const fillable = slots.filter(isFillableActiveSlot);
  const logged = Number.isFinite(Number(input.totalLoggedSets)) ? Number(input.totalLoggedSets) : sets.length;

  if (sets.length && fillable.length === sets.length && sets.length === logged) {
    let cursor = 0;
    const body = slots.map((slot) => {
      if (!isFillableActiveSlot(slot) || cursor >= sets.length) return slot;
      const set = sets[cursor++];
      const shaped = slotFor(set);
      return {
        ...slot,
        setType: "ACTIVE",
        exercises: exerciseEntry(set),
        repetitionCount: shaped.repetitionCount,
        weight: shaped.weight,
        // A timed hold's duration is the logged evidence; the watch's slot length is
        // not. Reps work keeps the watch's own timing (that is the point of FILL).
        ...(set.mode === "timed" ? { duration: shaped.duration } : {}),
      };
    });
    return { mode: "fill", body: { exerciseSets: body }, written: sets.length };
  }

  const startMs = parseSessionStartMs(input.sessionStartIso);
  const spanSec = Math.max(60, Math.round((Number(input.durationMin) || FALLBACK_SESSION_MIN) * 60));
  const perSet = sets.length ? spanSec / sets.length : spanSec;
  const body = sets.map((set, index) => {
    const shaped = slotFor(set);
    return {
      setType: "ACTIVE",
      startTime: garminSlotTime(startMs + Math.round(index * perSet * 1000)),
      duration: Math.max(10, Math.min(ACTIVE_SLOT_MAX_SEC, shaped.duration)),
      exercises: exerciseEntry(set),
      repetitionCount: shaped.repetitionCount,
      weight: shaped.weight,
      messageIndex: index,
    };
  });
  return { mode: "replace", body: { exerciseSets: body }, written: sets.length };
}

// A stored timestamp is either a SQLite "YYYY-MM-DD HH:MM:SS" (UTC, from
// logged_sets.created_at) or a plain date. Neither parses portably without help.
function parseSessionStartMs(iso: string | null | undefined): number {
  const raw = String(iso ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return Date.parse(`${raw}T12:00:00Z`);
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(raw)) {
    const normalized = raw.replace(" ", "T");
    const stamped = /(Z|[+-]\d{2}:?\d{2})$/.test(normalized) ? normalized : `${normalized}Z`;
    const parsed = Date.parse(stamped);
    if (Number.isFinite(parsed)) return parsed;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** Prefer the set's created_at only when it actually fell on the session's local date. */
export function sessionBoundStartMs(sessionDate: string | null | undefined, createdAt: string | null | undefined): number {
  const date = String(sessionDate ?? "").slice(0, 10);
  const created = createdAt ? parseSessionStartMs(createdAt) : Number.NaN;
  // sessions.date is a local calendar day; created_at is UTC. Comparing UTC
  // dates would reject an evening set west of UTC (20:30 ET is already the next
  // UTC morning) and stamp the Garmin activity at noon instead of when it happened.
  if (date && Number.isFinite(created) && localDateISO(new Date(created)) === date) return created;
  if (date) return Date.parse(`${date}T12:00:00Z`);
  return Number.isFinite(created) ? created : Date.now();
}

// ---- fingerprint -----------------------------------------------------------
/**
 * A stable hash of exactly what would be written: the ordered (exercise, set, load,
 * reps, duration, FIT mapping) tuples. Cheap idempotency — a re-sync, a re-finish or
 * a scheduler pass over the same unchanged session skips before touching the network,
 * while editing a single rep re-exports.
 */
export function garminExportFingerprint(sets: GarminExportPayloadSet[] | GarminExportSetRow[]): string {
  const payload = (sets as any[])
    .map((set) =>
      [
        set.exercise_id ?? set.exercise ?? "",
        set.set_number ?? "",
        set.weight ?? "",
        set.reps ?? "",
        set.duration_sec ?? "",
        set.garmin_category ?? "",
        set.garmin_exercise ?? "",
      ].join(":")
    )
    .join("|");
  return createHash("sha1").update(payload).digest("hex").slice(0, 16);
}

// ---- orchestration ---------------------------------------------------------
export interface GarminExportResult {
  ok: boolean;
  skipped?: string;
  activity_id?: string;
  mode?: "fill" | "replace" | "create" | "retarget";
  error?: string;
}

function hasPhysiology(activity: { avg_hr: number | null; calories: number | null }): boolean {
  return activity.avg_hr != null || activity.calories != null;
}

function payloadSetsFor(rows: GarminExportSetRow[]): GarminExportPayloadSet[] {
  const out: GarminExportPayloadSet[] = [];
  const mappedByExercise = new Map<number, { category: string | null; exercise: string | null; status: string }>();
  for (const row of rows) {
    let category = row.garmin_category;
    let exercise = row.garmin_exercise;
    if (!category) {
      // Persist the floor so a later export does not re-score this row. A remembered
      // miss (status unmapped) is a no-op inside ensureGarminMapping; NULL status is
      // the one-shot for pre-v100 rows. Memoized per exercise so a four-set accessory
      // does not scan the catalog four times.
      let mapped = mappedByExercise.get(row.exercise_id);
      if (!mapped) {
        mapped = repo.ensureGarminMapping(row.exercise_id);
        mappedByExercise.set(row.exercise_id, mapped);
      }
      if (mapped.status !== "mapped" || !mapped.category) continue;
      category = mapped.category;
      exercise = mapped.exercise;
    }
    out.push({
      exercise: row.exercise,
      set_number: row.set_number,
      weight: row.weight,
      reps: row.reps,
      duration_sec: row.duration_sec,
      mode: row.mode,
      garmin_category: category,
      garmin_exercise: exercise,
    });
  }
  return out;
}

// A 400 from the exerciseSets PUT means Garmin refused one of the enum members —
// almost always a sub-exercise that isn't valid under its category on this account's
// firmware. The CATEGORY is always legal, so retry once with the sub-names dropped:
// a slightly less specific label beats no strength history at all.
function withoutSubExercises(body: { exerciseSets: any[] }): { exerciseSets: any[] } {
  return {
    exerciseSets: body.exerciseSets.map((slot: any) =>
      Array.isArray(slot?.exercises)
        ? { ...slot, exercises: slot.exercises.map((entry: any) => ({ ...entry, name: null })) }
        : slot
    ),
  };
}

async function putWithCategoryFallback(
  api: GarminStrengthWriteApi,
  activityId: string,
  body: { exerciseSets: any[] }
): Promise<void> {
  try {
    await api.putExerciseSets(activityId, body);
  } catch (error: any) {
    if (garminErrorStatus(error) !== 400) throw error;
    await api.putExerciseSets(activityId, withoutSubExercises(body));
  }
}

/**
 * Every activity on this session Cairn authored itself — the shells it is allowed to
 * delete. Provenance is READ from the ledger, never inferred from physiology: a watch
 * recording with no heart rate is indistinguishable from a shell by rank alone, and
 * guessing wrong would delete the athlete's own recording. A record written before the
 * ledger existed carries provenance only in `source`, so fall back to that.
 */
// A shell Cairn authors says so in its own name. The ledger can lose an id (a create
// whose response never came back still lands on Garmin), and physiology cannot stand
// in for provenance — a watch strength recording with no heart rate looks exactly like
// an empty shell, and deleting one of those is the single unrecoverable mistake here.
// The marker is the athlete-visible answer: it travels with the activity, survives our
// bookkeeping being wrong, and nothing but Cairn writes it.
const CAIRN_ACTIVITY_MARKER = " · Cairn";
const GARMIN_ACTIVITY_NAME_MAX = 80;

/** The session's title, trimmed so the MARKER always survives the length cap. */
export function cairnShellActivityName(title: string | null | undefined): string {
  const base = String(title ?? "").trim() || "Strength";
  const room = GARMIN_ACTIVITY_NAME_MAX - CAIRN_ACTIVITY_MARKER.length;
  return `${base.slice(0, room).trim() || "Strength"}${CAIRN_ACTIVITY_MARKER}`;
}

/** A delete-only pass writes nothing, so the record keeps the shape it already had. */
function priorWriteMode(prior: GarminSessionExportRecord | null): "fill" | "replace" | "create" | "retarget" {
  const kept = prior?.mode;
  return kept === "fill" || kept === "create" || kept === "retarget" ? kept : "replace";
}

export function isCairnAuthoredName(name: string | null | undefined): boolean {
  return String(name ?? "").trimEnd().endsWith(CAIRN_ACTIVITY_MARKER);
}

/**
 * Did THIS session's write-back author this Garmin activity? The two answers the
 * export ledger can give — the activity we last wrote to, and every shell we created
 * — asked as one question, so an inbound job can tell Cairn's own echo from a
 * workout the watch actually recorded. Provenance only: it says nothing about
 * whether the export is current.
 */
export function sessionOwnsGarminActivity(sessionId: number, externalId: string | null | undefined): boolean {
  const id = String(externalId ?? "").trim();
  if (!id) return false;
  const prior = repo.getSessionGarminExport(sessionId);
  if (!prior) return false;
  if (prior.source === "manual" && prior.activity_id === id) return true;
  return cairnAuthoredIds(prior).includes(id);
}

function cairnAuthoredIds(prior: GarminSessionExportRecord | null): string[] {
  if (!prior) return [];
  const created = prior.created_ids ?? [];
  const legacy = !created.length && prior.source === "manual" ? [prior.activity_id] : [];
  return [...new Set([...created, ...(prior.pending_deletes ?? []), ...legacy])];
}

export interface GarminExportTargetPlan {
  /** The activity that should hold these sets, or null when one has to be created. */
  target_id: string | null;
  source: "watch" | "manual";
  /** Only the moves that are decided before the network: create and retarget. */
  mode: "create" | "retarget" | null;
  /** Activities of ours that are not the target — surplus shells to withdraw. */
  shells_to_drop: string[];
  /** The foreign (watch) recording that ranks as the home, when there is one. */
  watch_activity_id: string | null;
  unchanged: boolean;
}

/**
 * WHERE this session's sets belong, and what has to move to get them there. Pure — no
 * HTTP, no DB — so the backfill preview can answer "what would the exporter do" by
 * calling the exporter's own reasoning instead of restating it. A second copy of these
 * rules is how a preview starts quietly lying about retargets and orphaned shells.
 */
export function planGarminExportTarget(input: {
  prior: GarminSessionExportRecord | null;
  linked: GarminLinkedStrengthActivity[];
  fingerprint: string;
}): GarminExportTargetPlan {
  const prior = input.prior;
  const linked = input.linked.filter((row) => row.external_id);
  // Ours by RECORD (the ledger) or by MARK (the name we gave it). The mark is what
  // rescues a shell whose create response was lost: it never reached the ledger, but it
  // still says who made it, so it can be cleaned up instead of living on as a duplicate.
  const ledgerIds = new Set(cairnAuthoredIds(prior));
  const isOurs = (row: GarminLinkedStrengthActivity) =>
    ledgerIds.has(String(row.external_id)) || isCairnAuthoredName(row.name);
  const ourLinked = linked.filter(isOurs).map((row) => String(row.external_id));
  const notOurs = linked.filter((row) => !isOurs(row));
  // Once the sets live on a watch activity they STAY there. Physiology ranks which
  // recording is the richer home only while we are still choosing one — re-ranking a
  // day that already has a home would PUT the same sets onto a second activity (a
  // later-syncing recording gaining an avg_hr is enough) and Garmin would count the
  // day twice. Retarget only ever moves off a shell we created ourselves.
  const pinned =
    prior?.source === "watch" ? notOurs.find((row) => String(row.external_id) === prior.activity_id) : undefined;
  // Physiology does not GATE retarget either: a watch strength recording with no HR
  // still owns the day — leaving the manual shell next to it would double-count it.
  const watchTarget = pinned ?? notOurs.find(hasPhysiology) ?? notOurs[0];

  let targetId: string | null = null;
  let source: "watch" | "manual" = "manual";
  let mode: "create" | "retarget" | null = null;

  if (ourLinked.length && watchTarget) {
    // The watch's own recording of this workout arrived after we invented a shell for
    // it. The real recording wins: sets move across, every shell we made goes away —
    // including one an earlier pass could not get Garmin to accept the delete for.
    targetId = String(watchTarget.external_id);
    source = "watch";
    mode = "retarget";
  } else if (watchTarget) {
    targetId = String(watchTarget.external_id);
    source = "watch";
  } else if (prior) {
    targetId = prior.activity_id;
    source = prior.source;
  } else if (ourLinked.length) {
    // A shell of ours with no record behind it — the create landed, the answer didn't.
    // Adopt it rather than inventing a second one.
    targetId = ourLinked[0];
    source = "manual";
  } else {
    mode = "create";
  }

  // Every shell of ours that is not the activity holding the sets is surplus, whether
  // this pass moves the sets or not.
  const shellsToDrop = [...new Set([...ourLinked, ...(prior?.pending_deletes ?? [])])].filter((id) => id !== targetId);
  const unchanged =
    !!prior &&
    mode !== "retarget" &&
    !shellsToDrop.length &&
    prior.fingerprint === input.fingerprint &&
    prior.activity_id === targetId;

  return {
    target_id: targetId,
    source,
    mode,
    shells_to_drop: shellsToDrop,
    watch_activity_id: watchTarget ? String(watchTarget.external_id) : null,
    unchanged,
  };
}

/**
 * The work this session described is gone (every set deleted, or every mapping lost).
 * Whatever we already pushed is now a lie on Garmin's side, so withdraw it — but only
 * when the carrier is a shell WE created. A watch recording is the watch's own
 * evidence: its original slot labels cannot be restored, so it is left alone and the
 * skip says so.
 */
async function retractGarminExport(sessionId: number, reason: string): Promise<GarminExportResult> {
  const prior = repo.getSessionGarminExport(sessionId);
  if (!prior) return { ok: true, skipped: reason };
  const marked = repo
    .listSessionGarminStrengthActivities(sessionId)
    .filter((row) => row.external_id && isCairnAuthoredName(row.name))
    .map((row) => String(row.external_id));
  const ours = [...new Set([...cairnAuthoredIds(prior), ...marked])];
  if (!ours.length) return { ok: true, skipped: `${reason}_watch_kept`, activity_id: prior.activity_id };

  const stillPending: string[] = [];
  for (const activityId of ours) {
    try {
      const api = await strengthApi();
      await withDeadline("retract", api.deleteActivity(activityId));
    } catch (e: any) {
      const status = garminErrorStatus(e);
      if (status !== 404 && status !== 410) {
        const message = e?.message ?? String(e);
        console.warn(`[garmin-export] session ${sessionId}: could not retract activity ${activityId}: ${message}`);
        stillPending.push(activityId);
        continue;
      }
      // Already gone on Garmin's side — the local bookkeeping still has to catch up.
    }
    repo.deleteGarminActivityByExternalId(activityId);
  }
  if (stillPending.length) {
    return { ok: false, error: `Garmin kept ${stillPending.length} activity we no longer have sets for` };
  }
  // The sets themselves sat on a watch recording, which stays: its own slot labels
  // cannot be restored. Only the shells beside it were ours to withdraw.
  if (prior.source !== "manual") {
    repo.recordSessionGarminExport(sessionId, { ...prior, created_ids: [], pending_deletes: [] });
    return { ok: true, skipped: `${reason}_watch_kept`, activity_id: prior.activity_id };
  }
  repo.clearSessionGarminExport(sessionId);
  return { ok: true, skipped: `${reason}_retracted`, activity_id: prior.activity_id };
}

/**
 * Push one finished Cairn strength session to Garmin. Returns a plain result rather
 * than throwing — an unconfigured connector, a Garmin-owned day, an unmappable
 * workout and an unchanged one are all ordinary outcomes, not errors.
 */
export async function exportSessionToGarmin(sessionId: number): Promise<GarminExportResult> {
  const settings = repo.getSettings();
  if (!settings.garmin_export_strength) return { ok: true, skipped: "export_disabled" };
  if (!repo.getGarminCredentials().configured) return { ok: true, skipped: "garmin_not_configured" };

  const session = repo.sessionGarminExportContext(sessionId);
  if (!session) return { ok: false, error: `no session ${sessionId}` };
  if (session.cairn_sets_authoritative === false) return { ok: true, skipped: "garmin_owns_sets" };

  const rows = repo.garminExportSetRows(sessionId);
  const sets = rows.length ? payloadSetsFor(rows) : [];
  if (!sets.length) return await retractGarminExport(sessionId, rows.length ? "no_mapped_exercises" : "no_logged_sets");

  const fingerprint = garminExportFingerprint(sets);
  const prior = repo.getSessionGarminExport(sessionId);
  const linked = repo.listSessionGarminStrengthActivities(sessionId).filter((row) => row.external_id);
  const plan = planGarminExportTarget({ prior, linked, fingerprint });
  const shellsToDrop = plan.shells_to_drop;
  let targetId = plan.target_id;
  let source = plan.source;
  let mode: "fill" | "replace" | "create" | "retarget" | null = plan.mode;

  // Nothing changed and nothing moved — the common case on a re-sync.
  if (plan.unchanged && prior) return { ok: true, skipped: "unchanged", activity_id: prior.activity_id };

  // A retarget whose delete failed re-arms retarget on every later pass, which would
  // otherwise re-PUT the whole set list until Garmin finally accepts the drop. When
  // this fingerprint already landed on this target, the sets are where they belong and
  // only the surplus shells are outstanding.
  const deleteOnly = !!prior && prior.fingerprint === fingerprint && prior.activity_id === targetId;

  const firstSetAt = rows.find((row) => row.created_at)?.created_at ?? null;
  const startMs = sessionBoundStartMs(session.date, firstSetAt);
  const targetActivity = targetId ? linked.find((row) => String(row.external_id) === targetId) : undefined;
  const durationMin = session.duration_min ?? targetActivity?.duration_min ?? null;

  try {
    return await withDeadline(
      "export",
      (async () => {
        const api = await strengthApi();
        const createdIds = [...(prior?.created_ids ?? [])];

        if (mode === "create") {
          const created = await api.createManualActivity({
            name: cairnShellActivityName(session.title),
            startTimeGmt: garminGmtStamp(startMs),
            durationSec: Math.max(60, Math.round((Number(durationMin) || FALLBACK_SESSION_MIN) * 60)),
          });
          targetId = String(created.activityId);
          source = "manual";
          if (!createdIds.includes(targetId)) createdIds.push(targetId);
          // Remember the shell BEFORE the PUT. A create that lands and a PUT that then
          // 500s used to leave no local record, so the next retry created another empty
          // activity. An empty fingerprint keeps this attempt from looking "unchanged".
          try {
            // Under the SAME source the sync writes under (repo.garminSourceLabel()).
            // `garmin_activities` is UNIQUE on (source_id, external_id): landing the
            // shell under "default" while a labelled install syncs under its own label
            // gives the same activity two rows, and the day then reads "2 activities".
            const garminSource = repo.upsertGarminSource({ label: repo.garminSourceLabel() }) as any;
            const saved = repo.upsertGarminActivity(
              {
                external_id: targetId,
                date: String(session.date),
                start_time: garminGmtStamp(startMs),
                type: "strength_training",
                // The SAME marked name locally, so the mark is readable without a sync.
                name: cairnShellActivityName(session.title),
                duration_min: durationMin,
              },
              garminSource?.id ?? null
            ) as any;
            if (saved?.id) repo.reconcileGarminStrength(Number(saved.id));
          } catch (e: any) {
            console.warn(`[garmin-export] session ${sessionId}: could not link the manual activity: ${e?.message ?? e}`);
          }
          repo.recordSessionGarminExport(sessionId, {
            activity_id: targetId,
            source,
            fingerprint: "",
            exported_at: new Date().toISOString(),
            mode: "create",
            created_ids: [...createdIds],
          });
        }
        if (!targetId) return { ok: false, error: "no Garmin activity to write to" };

        // Only a watch recording has slots worth filling; a shell we just created has none.
        let existing: any = null;
        if (source === "watch" && !deleteOnly) {
          try {
            existing = await api.getExerciseSets(targetId);
          } catch {
            existing = null; // no slots readable → REPLACE, which is the safe shape anyway
          }
        }

        const payload = deleteOnly
          ? null
          : buildGarminExerciseSetsPayload({
              sets,
              existing,
              sessionStartIso: targetActivity?.start_time ?? garminGmtStamp(startMs),
              durationMin,
              totalLoggedSets: rows.length,
            });
        if (payload) await putWithCategoryFallback(api, targetId, payload.body);

        const stillPending: string[] = [];
        if (shellsToDrop.length) {
          for (const shellId of shellsToDrop) {
            try {
              await api.deleteActivity(shellId);
              repo.deleteGarminActivityByExternalId(shellId);
            } catch (e: any) {
              const status = garminErrorStatus(e);
              if (status === 404 || status === 410) {
                // Garmin no longer has the shell — a lost response or the athlete
                // already deleted it. Drop the local row and do not re-arm retarget.
                repo.deleteGarminActivityByExternalId(shellId);
              } else {
                stillPending.push(shellId);
                console.warn(
                  `[garmin-export] session ${sessionId}: manual activity ${shellId} not deleted: ${e?.message ?? e}`
                );
              }
            }
          }
          const survivor = repo
            .listSessionGarminStrengthActivities(sessionId)
            .find((row) => String(row.external_id) === targetId);
          if (survivor) {
            try {
              repo.reconcileGarminStrength(survivor.id);
            } catch {
              /* the blob rebuild is bookkeeping — the sets are already on the watch */
            }
          }
        }

        // Prune the ledger: a shell Garmin accepted the delete for is gone locally too,
        // so it stops being ours to chase and the list cannot grow without bound.
        const survivingLocally = new Set(
          repo.listSessionGarminStrengthActivities(sessionId).map((row) => String(row.external_id))
        );
        const remainingCreated = createdIds.filter((id) => survivingLocally.has(id) || stillPending.includes(id));

        const resolvedMode: "fill" | "replace" | "create" | "retarget" =
          mode === "create" || mode === "retarget" ? mode : (payload?.mode ?? priorWriteMode(prior));
        repo.recordSessionGarminExport(sessionId, {
          activity_id: targetId,
          source,
          fingerprint,
          // Nothing was written on a delete-only pass, so the export is still as old
          // as the write that actually landed.
          exported_at: deleteOnly && prior ? prior.exported_at : new Date().toISOString(),
          mode: resolvedMode,
          created_ids: remainingCreated,
          pending_deletes: stillPending,
        });
        return { ok: true, activity_id: targetId, mode: resolvedMode };
      })(),
      GARMIN_EXPORT_JOB_MS
    );
  } catch (e: any) {
    const message = e?.message ?? String(e);
    console.warn(`[garmin-export] session ${sessionId} failed: ${message}`);
    return { ok: false, error: message };
  }
}
