// WHAT A RUN WAS MADE OF — its segments and laps, as the watch recorded them.
//
// A run's summary (distance, time, average heart rate) hides its shape: six hill
// repeats with walked recoveries average out to an easy-looking 149 bpm. Garmin sends
// the shape two ways, and this module is the one reader of both:
//
//   • `splitSummaries` rides in the activity LIST payload the sync already receives —
//     one aggregate per segment type: the warm-up, the work bouts of a structured
//     workout (count, total time, distance, climb), its recoveries, the cool-down, and
//     the run/walk detection. Stored normalized as `garmin_activities.structure_json`
//     (no extra call, and backfilled from `raw_json` by migration v117).
//   • the per-lap list — each lap's time, distance, heart rate, pace, grade-adjusted
//     pace, climb and cadence, LABELLED warm-up / work / recovery from
//     `/activity-service/activity/{id}/typedsplits` (the plain `/splits` list calls
//     every workout lap "INTERVAL", so it is only the fallback). One bounded call per
//     run that HAS laps, stored as `laps_json`.
//
// Two consumers read through here: the coach's run line (a short `structureNote` —
// the summary the brain always sees) and the `read_activity_detail` coach read (the
// laps themselves, on demand). And one rule: `intervalSessionEvidence` — a run the
// athlete EXECUTED as a structured interval workout is quality work whatever its
// average, the same standing as a title that names it (run-intensity.ts).
//
// Never a grade: nothing here scores a run. Garmin's training-effect label does not
// ride here either (the owner law in run-intensity.ts).

import { KM_PER_MI } from "./display-words.js";

export type RunSegmentKind = "warmup" | "work" | "recovery" | "rest" | "cooldown" | "run" | "walk" | "stand";

export interface RunStructureSegment {
  kind: RunSegmentKind;
  bouts: number;
  secs: number | null;
  meters: number | null;
  ascent_m: number | null;
  descent_m: number | null;
  /** m/s */
  avg_speed: number | null;
}

export type RunLapKind = "warmup" | "work" | "recovery" | "rest" | "cooldown" | "other";

export interface RunLap {
  n: number;
  kind: RunLapKind;
  secs: number | null;
  meters: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  /** m/s */
  avg_speed: number | null;
  /** grade-adjusted, m/s */
  gap_speed: number | null;
  ascent_m: number | null;
  descent_m: number | null;
  cadence: number | null;
  avg_power: number | null;
}

// A structured workout the athlete RAN as intervals: at least three work bouts with
// recoveries between them, and enough work that it is a session rather than a few
// strides tacked onto an easy run (6 × 20 s strides is two minutes; six hill repeats
// of a minute and a half are nine).
export const INTERVAL_MIN_WORK_BOUTS = 3;
export const INTERVAL_MIN_RECOVERIES = 2;
export const INTERVAL_MIN_WORK_SECS = 360;

const SPLIT_TYPE_KIND: Record<string, RunSegmentKind> = {
  INTERVAL_WARMUP: "warmup",
  INTERVAL_ACTIVE: "work",
  INTERVAL_RECOVERY: "recovery",
  INTERVAL_REST: "rest",
  INTERVAL_COOLDOWN: "cooldown",
  RWD_RUN: "run",
  RWD_WALK: "walk",
  RWD_STAND: "stand",
};

// The plain lap list's `intensityType`. Verified live (2026-10-02): a watch workout's
// laps ALL come back "INTERVAL" there — warm-up and recoveries included — so that word
// says nothing about a lap and maps to "other". The typed list below is the one that
// names each lap.
const LAP_INTENSITY_KIND: Record<string, RunLapKind> = {
  WARMUP: "warmup",
  ACTIVE: "work",
  RECOVERY: "recovery",
  REST: "rest",
  COOLDOWN: "cooldown",
};

// `/typedsplits` → `splits[]`: the same per-lap metrics, each with a `type`. Its
// INTERVAL_* entries are the laps, one for one, labelled; its RWD_* entries are the
// run/walk detection over the same time and are not laps.
const TYPED_LAP_KIND: Record<string, RunLapKind> = {
  INTERVAL_WARMUP: "warmup",
  INTERVAL_ACTIVE: "work",
  INTERVAL_RECOVERY: "recovery",
  INTERVAL_REST: "rest",
  INTERVAL_COOLDOWN: "cooldown",
  INTERVAL_OTHER: "other",
};


function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pick(obj: any, keys: string[]): number | null {
  for (const key of keys) {
    const v = num(obj?.[key]);
    if (v != null) return v;
  }
  return null;
}

const r1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);
const r3 = (v: number | null) => (v == null ? null : Math.round(v * 1000) / 1000);

function parseMaybe(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Garmin's `splitSummaries` → the segments Cairn keeps. Null when there are none. */
export function normalizeSplitSummaries(raw: unknown): RunStructureSegment[] | null {
  const list = parseMaybe(raw);
  if (!Array.isArray(list)) return null;
  const out: RunStructureSegment[] = [];
  for (const s of list) {
    const kind = SPLIT_TYPE_KIND[String(s?.splitType ?? "").toUpperCase()];
    if (!kind) continue;
    const secs = num(s?.duration);
    const bouts = Math.max(0, Math.trunc(num(s?.noOfSplits) ?? 0));
    if (!bouts || !secs || secs <= 0) continue; // an empty RWD_STAND carries nothing
    out.push({
      kind,
      bouts,
      secs: r1(secs),
      meters: r1(num(s?.distance)),
      ascent_m: r1(num(s?.totalAscent)),
      descent_m: r1(num(s?.elevationLoss)),
      avg_speed: r3(num(s?.averageSpeed)),
    });
  }
  return out.length ? out : null;
}

/**
 * The laps Cairn keeps, from the typed list (`{splits:[{type,…}]}`, preferred — it
 * names warm-up, work and recovery) or the plain one (`lapDTOs`, or a bare array).
 */
export function normalizeGarminLaps(raw: unknown): RunLap[] | null {
  const parsed = parseMaybe(raw) as any;
  let list: any[] | null = null;
  let kindOf = (lap: any): RunLapKind => LAP_INTENSITY_KIND[String(lap?.intensityType ?? "").toUpperCase()] ?? "other";
  if (Array.isArray(parsed?.splits)) {
    list = parsed.splits.filter((s: any) =>
      String(s?.type ?? "")
        .toUpperCase()
        .startsWith("INTERVAL_")
    );
    kindOf = (lap) => TYPED_LAP_KIND[String(lap?.type ?? "").toUpperCase()] ?? "other";
  } else {
    list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.lapDTOs) ? parsed.lapDTOs : null;
  }
  if (!list?.length) return null;
  const out: RunLap[] = [];
  list.forEach((lap: any, i: number) => {
    const secs = pick(lap, ["movingDuration", "duration", "elapsedDuration"]);
    const meters = num(lap?.distance);
    if ((secs == null || secs <= 0) && (meters == null || meters <= 0)) return;
    const index = num(lap?.lapIndex) ?? null;
    out.push({
      n: index != null ? Math.trunc(index) : i + 1,
      kind: kindOf(lap),
      secs: r1(secs),
      meters: r1(meters),
      avg_hr: pick(lap, ["averageHR", "averageHeartRate"]),
      max_hr: pick(lap, ["maxHR", "maxHeartRate"]),
      avg_speed: r3(pick(lap, ["averageMovingSpeed", "averageSpeed"])),
      gap_speed: r3(pick(lap, ["avgGradeAdjustedSpeed", "averageGradeAdjustedSpeed"])),
      ascent_m: r1(num(lap?.elevationGain)),
      descent_m: r1(num(lap?.elevationLoss)),
      cadence: r1(pick(lap, ["averageRunCadence", "averageRunningCadenceInStepsPerMinute"])),
      avg_power: r1(pick(lap, ["averagePower", "avgPower"])),
    });
  });
  return out.length ? out : null;
}

function segment(structure: RunStructureSegment[] | null, kind: RunSegmentKind): RunStructureSegment | null {
  return structure?.find((s) => s.kind === kind) ?? null;
}

/** Was this run executed as a structured interval workout? */
export function isStructuredIntervalSession(structureRaw: unknown): boolean {
  const structure = Array.isArray(structureRaw)
    ? (structureRaw as RunStructureSegment[])
    : normalizeStoredStructure(structureRaw);
  const work = segment(structure, "work");
  const recovery = segment(structure, "recovery") ?? segment(structure, "rest");
  return (
    !!work &&
    work.bouts >= INTERVAL_MIN_WORK_BOUTS &&
    (work.secs ?? 0) >= INTERVAL_MIN_WORK_SECS &&
    (recovery?.bouts ?? 0) >= INTERVAL_MIN_RECOVERIES
  );
}

/** A stored `structure_json` (already normalized) back to segments. */
export function normalizeStoredStructure(value: unknown): RunStructureSegment[] | null {
  const list = parseMaybe(value);
  if (!Array.isArray(list)) return null;
  const out = list.filter((s: any) => s && typeof s.kind === "string" && Number(s.bouts) > 0) as RunStructureSegment[];
  return out.length ? out : null;
}

export function normalizeStoredLaps(value: unknown): RunLap[] | null {
  const list = parseMaybe(value);
  if (!Array.isArray(list)) return null;
  const out = list.filter((l: any) => l && typeof l === "object" && Number.isFinite(Number(l.n))) as RunLap[];
  return out.length ? out : null;
}

/**
 * Interval evidence for the hard read. A structured interval workout counts as
 * quality — unless its own work laps, read against the athlete's OWN easy line, were
 * all easy (a run/walk workout, a jog-and-stroll), which the laps can prove and the
 * segment summary cannot.
 */
export function intervalSessionEvidence(structure: unknown, laps: unknown, easyCeilingBpm: number | null): boolean {
  if (!isStructuredIntervalSession(structure)) return false;
  const work = (normalizeStoredLaps(laps) ?? []).filter((l) => l.kind === "work" && l.avg_hr != null);
  if (!work.length || easyCeilingBpm == null) return true;
  return work.some((l) => Number(l.avg_hr) > easyCeilingBpm || Number(l.max_hr ?? 0) > easyCeilingBpm);
}

// ---------- athlete-unit formatting ----------

export function clockFromSecs(secs: number | null | undefined): string | null {
  const s = num(secs);
  if (s == null || s <= 0) return null;
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

/** A speed (m/s) as pace in the athlete's unit, e.g. "6:31/km". */
export function paceFromSpeed(mps: number | null | undefined, units: "km" | "mi"): string | null {
  const v = num(mps);
  if (v == null || v <= 0.3) return null; // standing still is not a pace
  const secsPerUnit = (units === "mi" ? KM_PER_MI * 1000 : 1000) / v;
  const clock = clockFromSecs(secsPerUnit);
  return clock ? `${clock}/${units}` : null;
}

export function distanceLabel(meters: number | null | undefined, units: "km" | "mi"): string | null {
  const m = num(meters);
  if (m == null || m <= 0) return null;
  return units === "mi" ? `${(m / 1000 / KM_PER_MI).toFixed(2)} mi` : `${(m / 1000).toFixed(2)} km`;
}

const MAX_NOTE_REPS = 10;

/**
 * The one-line shape of a run for the coach's run line, or null when the watch
 * recorded nothing beyond the summary (a plain run with no workout and no walking).
 * "intervals: warm-up 5:12 · 7 work bouts 20:12 total, 3.56 km, +53 m · 6 recoveries
 * 13:57 · walked 5:05 · work reps 1) 2:51 6:02/km 171 bpm …"
 */
export function structureNote(
  structureRaw: unknown,
  lapsRaw: unknown,
  units: "km" | "mi",
  extra: { gap_speed?: number | null; ascent_m?: number | null } = {}
): string | null {
  const structure = normalizeStoredStructure(structureRaw);
  const laps = normalizeStoredLaps(lapsRaw);
  const parts: string[] = [];
  const intervals = isStructuredIntervalSession(structure);
  const work = segment(structure, "work");
  if (work && work.bouts >= 2) {
    const warm = segment(structure, "warmup");
    const recovery = segment(structure, "recovery") ?? segment(structure, "rest");
    const cool = segment(structure, "cooldown");
    const bits: string[] = [];
    if (warm?.secs) bits.push(`warm-up ${clockFromSecs(warm.secs)}`);
    const workBits = [`${clockFromSecs(work.secs)} total`, distanceLabel(work.meters, units)];
    if ((work.ascent_m ?? 0) >= 5) workBits.push(`+${Math.round(work.ascent_m as number)} m`);
    bits.push(`${work.bouts} work bouts ${workBits.filter(Boolean).join(", ")}`);
    if (recovery?.secs) bits.push(`${recovery.bouts} recoveries ${clockFromSecs(recovery.secs)}`);
    if (cool?.secs) bits.push(`cool-down ${clockFromSecs(cool.secs)}`);
    parts.push(`${intervals ? "intervals" : "workout"}: ${bits.join(" · ")}`);
  }
  const walk = segment(structure, "walk");
  if (walk?.secs && walk.secs >= 60) parts.push(`walked ${clockFromSecs(walk.secs)}`);
  const gap = paceFromSpeed(extra.gap_speed, units);
  if (gap && (extra.ascent_m ?? 0) >= 30) parts.push(`grade-adjusted pace ${gap}`);
  const workLaps = (laps ?? []).filter((l) => l.kind === "work");
  if (intervals && workLaps.length >= 2) {
    const reps = workLaps.slice(0, MAX_NOTE_REPS).map((l, i) => {
      const bits = [clockFromSecs(l.secs), paceFromSpeed(l.avg_speed, units)];
      if (l.avg_hr != null)
        bits.push(`${Math.round(l.avg_hr)}${l.max_hr != null ? `/${Math.round(l.max_hr)}` : ""} bpm`);
      if ((l.ascent_m ?? 0) >= 3) bits.push(`+${Math.round(l.ascent_m as number)} m`);
      return `${i + 1}) ${bits.filter(Boolean).join(" ")}`;
    });
    parts.push(`work reps (avg/max HR): ${reps.join(" · ")}${workLaps.length > MAX_NOTE_REPS ? " …" : ""}`);
  }
  if (laps && laps.length >= 2) parts.push(`${laps.length} laps on record`);
  return parts.length ? parts.join("; ") : null;
}
