// ============================================================================
// run-progression.ts — the deterministic RUNNING program engine.
//
// The endurance analogue of progression.ts. It reads the athlete's goal phase,
// their actual logged mileage + trajectory (enduranceState), last week's run
// compliance, recovery, the active periodization block and their real HR-zone
// bpm bands, and emits a PERIODIZED weekly run mix — N easy Z2 runs + 1 long +
// 1 rotated quality session (tempo / threshold / VO2 intervals / hills) — each
// as a RunPrescription the existing setWeeklyRuns apply path accepts, with
// concrete distances/durations, a bpm-bearing zone, and (for interval sessions)
// a populated interval structure.
//
// This is the deterministic FLOOR the agentic evolveProgram loop REFINES — never
// reinvents — exactly as program-state.ts floors the strength evolution prompt.
//
// Constitution: everything is PLAIN words + recognized reference reads. Zones are
// concrete prescriptions ("6 × 800m @ Z5 (165–175 bpm)"), never a 0-100 grade.
// Every read is null-safe and quiet by default — {available:false} / null when
// there's nothing to say (no age + no HR → no zones; no running → no plan). The
// plan is a SUGGESTION applied only through the usual propose→apply path, never
// auto-applied; this module computes, it never writes plan rows.
// ============================================================================
import { db } from "../db.js";
import { getRecoverySummary } from "./coach.js";
import { activitySportWhere, enduranceSportPatterns } from "./endurance-sports.js";
import type { RunPrescription } from "./plan.js";
import { getActiveBlock, type ProgramBlock } from "./program-blocks.js";
import { type EnduranceState, getProgramState, type ProgramState } from "./program-state.js";
import { createProposal, getEnduranceGoal, getPrimaryDiscipline, getProfile, supersedeAutoRunPlanDrafts } from "./profile.js";
import { getRunCompliance, type RunCompliance } from "./sessions.js";
import { localDateISO } from "./shared.js";

// ---------------------------------------------------------------------------
// Shared small helpers
// ---------------------------------------------------------------------------
function mondayOf(dateISO: string): string {
  const d = new Date(dateISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function isoDaysAgo(dateISO: string, n: number): string {
  return new Date(new Date(dateISO + "T00:00:00Z").getTime() - n * 864e5).toISOString().slice(0, 10);
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
// A deterministic week ordinal (no app_state side-effects on a read): epoch weeks
// since the Unix Monday. Used for the ~every-4th down week + quality rotation, so a
// context build never mutates state or rotates differently on each call.
function weekOrdinal(mondayISO: string): number {
  return Math.floor(Date.parse(mondayISO + "T00:00:00Z") / (7 * 864e5));
}

// ---------------------------------------------------------------------------
// (1) runZones — HR-zone bpm bands grounded in the athlete's real physiology.
//     "Optimize for pulse" with honest numbers, never an invented score.
// ---------------------------------------------------------------------------
export type ZoneKey = "Z1" | "Z2" | "Z3" | "Z4" | "Z5";

export interface RunZone {
  zone: ZoneKey;
  label: string;     // Recovery | Easy | Tempo | Threshold | VO2max
  low_bpm: number;
  high_bpm: number;
  feel: string;      // plain-words effort cue
}

export interface RunZones {
  available: boolean;
  max_hr: number | null;
  rest_hr: number | null;
  method:
    | "explicit"          // a max-HR the athlete set
    | "age"               // Tanaka 208 − 0.7·age
    | "garmin-observed"   // highest HR Garmin has recorded
    | "garmin-zones"      // Garmin's own zone boundaries (low_hr per zone)
    | null;
  reserve: boolean;       // true = Karvonen (%HRR, resting HR known); false = %HRmax
  zones: RunZone[];
  note: string;
}

// Standard 5-zone fractional bands. Applied to HRmax, or to heart-rate RESERVE
// (Karvonen) when a resting HR is known — the more personal read.
const ZONE_BANDS: { zone: ZoneKey; label: string; lo: number; hi: number; feel: string }[] = [
  { zone: "Z1", label: "Recovery", lo: 0.5, hi: 0.6, feel: "very easy — fully conversational, almost a shuffle" },
  { zone: "Z2", label: "Easy", lo: 0.6, hi: 0.7, feel: "easy aerobic — relaxed, can hold a full conversation" },
  { zone: "Z3", label: "Tempo", lo: 0.7, hi: 0.8, feel: "comfortably hard — short sentences only" },
  { zone: "Z4", label: "Threshold", lo: 0.8, hi: 0.9, feel: "hard — just a few words at a time" },
  { zone: "Z5", label: "VO2max", lo: 0.9, hi: 1.0, feel: "very hard — near all-out, no talking" },
];

const NO_ZONES: RunZones = {
  available: false, max_hr: null, rest_hr: null, method: null, reserve: false, zones: [],
  note: "Add your age (or sync a watch with heart-rate) and Cairn can ground your run zones in real bpm bands.",
};

function latestGarminMaxHr(): number | null {
  try {
    const a = db.prepare(`SELECT MAX(max_hr) AS m FROM garmin_activities WHERE max_hr IS NOT NULL`).get() as any;
    const d = db.prepare(`SELECT MAX(max_hr) AS m FROM garmin_daily_metrics WHERE max_hr IS NOT NULL`).get() as any;
    const vals = [Number(a?.m), Number(d?.m)].filter((v) => Number.isFinite(v) && v >= 120 && v <= 230);
    return vals.length ? Math.max(...vals) : null;
  } catch { return null; }
}

function latestGarminRestHr(): number | null {
  try {
    const r = db.prepare(
      `SELECT resting_hr FROM garmin_daily_metrics WHERE resting_hr IS NOT NULL ORDER BY date DESC LIMIT 1`
    ).get() as any;
    const n = Number(r?.resting_hr);
    return Number.isFinite(n) && n >= 25 && n <= 90 ? Math.round(n) : null;
  } catch { return null; }
}

// Garmin's own zone boundaries from the most recent activity that carries them.
// hr_zones_json = [{zone, secs, low_hr}] — each zone's low_hr is its lower bound.
function garminZoneBoundaries(): { zone: ZoneKey; low_bpm: number; high_bpm: number }[] | null {
  try {
    const rows = db.prepare(
      `SELECT hr_zones_json FROM garmin_activities WHERE hr_zones_json IS NOT NULL ORDER BY date DESC LIMIT 8`
    ).all() as any[];
    for (const r of rows) {
      let zones: any = null;
      try { zones = r.hr_zones_json ? JSON.parse(r.hr_zones_json) : null; } catch { zones = null; }
      if (!Array.isArray(zones)) continue;
      const lows: { z: number; low: number }[] = [];
      for (const z of zones) {
        const zn = Number(z?.zone);
        const low = Number(z?.low_hr ?? z?.lowHr ?? z?.low);
        if (Number.isFinite(zn) && zn >= 1 && zn <= 5 && Number.isFinite(low) && low > 60 && low < 230) {
          lows.push({ z: zn, low: Math.round(low) });
        }
      }
      if (lows.length < 3) continue;
      lows.sort((a, b) => a.z - b.z);
      const out: { zone: ZoneKey; low_bpm: number; high_bpm: number }[] = [];
      for (let i = 0; i < lows.length; i++) {
        const next = lows[i + 1]?.low;
        const high = next != null ? next - 1 : lows[i].low + 15;
        out.push({ zone: `Z${lows[i].z}` as ZoneKey, low_bpm: lows[i].low, high_bpm: high });
      }
      return out;
    }
    return null;
  } catch { return null; }
}

export function runZones(opts?: { profile?: any; recovery?: any; maxHr?: number | null; restHr?: number | null }): RunZones {
  const profile = opts?.profile ?? getProfile();
  // Resting HR (for Karvonen) — explicit, else recovery aggregate, else latest Garmin night.
  const recovery = opts?.recovery;
  const restHr =
    (Number.isFinite(Number(opts?.restHr)) ? Number(opts?.restHr) : null) ??
    (Number.isFinite(Number(profile?.resting_hr)) ? Number(profile?.resting_hr) : null) ??
    (Number.isFinite(Number(recovery?.recovery?.avg_resting_hr)) ? Math.round(Number(recovery.recovery.avg_resting_hr)) : null) ??
    latestGarminRestHr();

  // Max HR: explicit (a set value) → Tanaka from age → Garmin observed → Garmin's
  // own zone boundaries (used directly when there's no age to model from).
  const explicitMax =
    (Number.isFinite(Number(opts?.maxHr)) ? Number(opts?.maxHr) : null) ??
    (Number.isFinite(Number(profile?.max_hr)) ? Number(profile?.max_hr) : null);
  const age = Number(profile?.age);
  let maxHr: number | null = null;
  let method: RunZones["method"] = null;
  if (explicitMax != null && explicitMax >= 120 && explicitMax <= 230) {
    maxHr = Math.round(explicitMax); method = "explicit";
  } else if (Number.isFinite(age) && age > 0 && age < 110) {
    maxHr = Math.round(208 - 0.7 * age); method = "age";
  } else {
    const observed = latestGarminMaxHr();
    if (observed != null) { maxHr = observed; method = "garmin-observed"; }
  }

  // No modellable max HR → fall to Garmin's own zone boundaries if present.
  if (maxHr == null) {
    const gz = garminZoneBoundaries();
    if (gz) {
      return {
        available: true, max_hr: gz[gz.length - 1]?.high_bpm ?? null, rest_hr: restHr, method: "garmin-zones",
        reserve: false,
        zones: gz.map((z) => {
          const band = ZONE_BANDS.find((b) => b.zone === z.zone);
          return { zone: z.zone, label: band?.label ?? z.zone, low_bpm: z.low_bpm, high_bpm: z.high_bpm, feel: band?.feel ?? "" };
        }),
        note: "Run zones read straight from your watch's recorded HR zones.",
      };
    }
    return NO_ZONES;
  }

  const useReserve = restHr != null && restHr < maxHr - 30; // Karvonen only with a credible resting HR
  const bpm = (frac: number): number =>
    useReserve ? Math.round(restHr! + frac * (maxHr! - restHr!)) : Math.round(frac * maxHr!);
  const zones: RunZone[] = ZONE_BANDS.map((b) => ({
    zone: b.zone, label: b.label, low_bpm: bpm(b.lo), high_bpm: bpm(b.hi), feel: b.feel,
  }));
  const note =
    method === "explicit" ? `Zones from your max HR (${maxHr})${useReserve ? ` and resting HR (${restHr}), Karvonen` : ""}.`
    : method === "age" ? `Zones estimated from your age (max HR ≈ ${maxHr})${useReserve ? `, personalised with resting HR ${restHr}` : ""}.`
    : `Zones from your watch's highest recorded HR (${maxHr})${useReserve ? `, resting HR ${restHr}` : ""}.`;

  return { available: true, max_hr: maxHr, rest_hr: useReserve ? restHr : null, method, reserve: useReserve, zones, note };
}

// A "Z2 (135–145 bpm)" tag for a prescription's target_zone, falling back to the
// bare zone key when no bands are available. This is what carries the bpm into the
// applied plan + every prompt/PWA render.
function zoneTag(zoneKey: ZoneKey, zones: RunZones): string {
  if (!zones.available) return zoneKey;
  const z = zones.zones.find((x) => x.zone === zoneKey);
  return z ? `${zoneKey} (${z.low_bpm}–${z.high_bpm} bpm)` : zoneKey;
}

// ---------------------------------------------------------------------------
// (2) weeklyRunPlan — the keystone periodized weekly run mix.
// ---------------------------------------------------------------------------
export interface IntervalRep {
  reps: number;
  on: string;   // e.g. "800m" / "3 min" / "45s uphill"
  off: string;  // recovery, e.g. "90s jog" / "jog down"
  zone: ZoneKey;
}

// A RunPrescription extended with interval STRUCTURE. Assignable to RunPrescription
// for setWeeklyRuns; the `interval` field is what the integrator must wire into
// setWeeklyRuns (persist as interval_json) + the renderers/PWA.
export interface RunPlanPrescription extends RunPrescription {
  kind_label: "easy" | "long" | "quality"; // internal mix bucket (plain, never a score)
  interval?: IntervalRep[] | null;
}

export interface WeeklyRunPlan {
  available: boolean;
  week_start: string;
  runs: RunPlanPrescription[];
  rationale: string[];      // the per-decision plain-words "why this week looks like this"
  quality_focus: string | null; // e.g. "Threshold intervals" (null on an all-easy/taper week)
  mix_summary: string;      // e.g. "3 easy + 1 long + 1 threshold"
  why: string;              // one calm headline sentence
}

const NO_RUN_PLAN = (week_start: string): WeeklyRunPlan => ({
  available: false, week_start, runs: [], rationale: [], quality_focus: null, mix_summary: "",
  why: "No running in the picture yet — set a running goal or log a few runs and Cairn will shape a week.",
});

// Quality-session candidates per periodization phase (rotated deterministically by
// week ordinal so it cycles without app_state side-effects on a read).
const QUALITY_BY_PHASE: Record<string, ("tempo" | "threshold" | "vo2" | "hills")[]> = {
  base: ["tempo", "hills"],
  build: ["threshold", "vo2", "tempo"],
  sharpen: ["vo2", "threshold"],
  taper: ["vo2"],
  standing: ["tempo", "threshold", "hills"],
};

function qualitySpec(
  type: "tempo" | "threshold" | "vo2" | "hills",
  phase: string,
  zones: RunZones,
  workKm: number
): { label: string; zoneKey: ZoneKey; interval: IntervalRep[] | null; distance: number | null; duration: number | null; note: string } {
  switch (type) {
    case "tempo":
      // Continuous comfortably-hard effort — no rep structure, a sustained block.
      return {
        label: "Tempo run", zoneKey: "Z3", interval: null,
        distance: round1(Math.max(4, workKm)), duration: null,
        note: `Continuous tempo at ${zoneTag("Z3", zones)} after an easy warm-up.`,
      };
    case "threshold": {
      const reps = phase === "sharpen" ? 4 : 5;
      return {
        label: "Threshold intervals", zoneKey: "Z4",
        interval: [{ reps, on: "1km", off: "60s jog", zone: "Z4" }],
        distance: round1(Math.max(5, workKm)), duration: null,
        note: `${reps} × 1km at ${zoneTag("Z4", zones)}, 60s easy jog between, with warm-up + cool-down.`,
      };
    }
    case "vo2": {
      const reps = phase === "taper" ? 4 : phase === "sharpen" ? 5 : 6;
      return {
        label: "VO2 intervals", zoneKey: "Z5",
        interval: [{ reps, on: "800m", off: "90s jog", zone: "Z5" }],
        distance: round1(Math.max(5, workKm)), duration: null,
        note: `${reps} × 800m hard at ${zoneTag("Z5", zones)}, 90s jog recovery, bookended by easy running.`,
      };
    }
    default: {
      // hills
      const reps = phase === "base" ? 8 : 10;
      return {
        label: "Hill repeats", zoneKey: "Z4",
        interval: [{ reps, on: "45s uphill", off: "jog down", zone: "Z4" }],
        distance: round1(Math.max(4, workKm)), duration: null,
        note: `${reps} × 45s uphill at ${zoneTag("Z4", zones)} effort, jog down to recover — strength + economy.`,
      };
    }
  }
}

export function weeklyRunPlan(
  date?: string,
  opts?: {
    programState?: ProgramState;
    recovery?: any;
    goal?: ReturnType<typeof getEnduranceGoal>;
    compliance?: RunCompliance;
    block?: ProgramBlock | null;
    zones?: RunZones;
  }
): WeeklyRunPlan {
  const d = date || localDateISO();
  const week_start = mondayOf(d);

  const discipline = getPrimaryDiscipline();
  const goal = opts?.goal ?? getEnduranceGoal(d);
  const recovery = opts?.recovery ?? (() => { try { return getRecoverySummary(14); } catch { return null; } })();
  const programState = opts?.programState ?? getProgramState(d, recovery);
  const es: EnduranceState | null = programState.endurance;
  const compliance = opts?.compliance ?? (() => { try { return getRunCompliance(week_start); } catch { return null; } })();

  // Gate: only shape a week for a runner — an endurance/hybrid athlete, a set
  // running goal, or someone with real logged mileage. Otherwise stay quiet.
  const lastActualKm = compliance?.actual_km ?? 0;
  const baseKm = es?.last_week_km ?? 0;
  const isRunner = discipline === "endurance" || discipline === "hybrid" || !!goal || lastActualKm > 0 || baseKm > 0;
  if (!isRunner) return NO_RUN_PLAN(week_start);

  const zones = opts?.zones ?? runZones({ profile: getProfile(), recovery });
  const block = opts?.block ?? getActiveBlock();
  const phase = goal?.is_race && goal.phase && goal.phase !== "past" ? goal.phase : "standing";
  const ord = block?.week_index ?? weekOrdinal(week_start);

  const rationale: string[] = [];

  // --- weekly volume target (periodized, conservative ~10% caps) ---
  // Anchor to what actually happened last week (or the chronic base), seed a gentle
  // starter when there's no history.
  let anchorKm = Math.max(lastActualKm, baseKm);
  if (anchorKm <= 0) {
    anchorKm = goal?.weekly_km && goal.weekly_km > 0 ? Math.min(goal.weekly_km, 20) : 15;
    rationale.push(`No mileage logged yet — starting conservatively around ${Math.round(anchorKm)} km.`);
  }

  const hrvDown = recovery?.delta?.hrv != null && recovery.delta.hrv < 0;
  const rhrUp = recovery?.delta?.rhr != null && recovery.delta.rhr > 2;
  const sleepDown = recovery?.delta?.sleep != null && recovery.delta.sleep < -30;
  const recoveryDown = hrvDown || rhrUp || sleepDown;
  const spiking = es?.status === "spiking";
  const downWeek = ord % 4 === 0; // a reset week roughly every 4th
  const taper = phase === "taper";

  let factor = 1.1; // default ~10% build
  if (taper) { factor = 0.55; rationale.push("Race week — tapering volume right down so you arrive fresh."); }
  else if (recoveryDown) { factor = 0.9; rationale.push("Recovery's down this week (sleep / HRV / resting HR) — easing volume and keeping it gentle."); }
  else if (spiking) { factor = 1.0; rationale.push("Mileage jumped recently — holding it here to let it absorb before adding more."); }
  else if (downWeek) { factor = 0.8; rationale.push("Scheduled down week — a lighter reset before the next build."); }
  else if (es?.status === "detraining") { factor = 1.0; rationale.push("Rebuilding the base back gently — steady, not a jump."); }
  else { rationale.push("Building conservatively — about a 10% step on last week."); }

  const weeklyKm = Math.max(6, round1(anchorKm * factor));

  // --- run-day count ---
  let runDays = goal?.weekly_sessions && goal.weekly_sessions > 0
    ? Math.min(6, Math.max(2, Math.round(goal.weekly_sessions)))
    : weeklyKm >= 35 ? 5 : weeklyKm >= 20 ? 4 : 3;
  if (recoveryDown && runDays > 3) runDays -= 1; // one fewer run when run-down

  // --- quality session: include unless we're protecting recovery / tapering hard / very thin base ---
  const baseTooThin = weeklyKm < 12;
  const includeQuality =
    !recoveryDown && !baseTooThin && es?.status !== "spiking" && runDays >= 3;
  let qualityType: "tempo" | "threshold" | "vo2" | "hills" | null = null;
  if (includeQuality) {
    const pool = QUALITY_BY_PHASE[phase] ?? QUALITY_BY_PHASE.standing;
    qualityType = pool[ord % pool.length];
    // Base with no quality at all yet → make sure the first quality is gentle (tempo).
    if (!es?.has_quality && phase !== "sharpen" && phase !== "build") qualityType = pool.includes("tempo") ? "tempo" : qualityType;
    rationale.push(
      es?.has_quality
        ? `Rotating in a ${qualityType} session — varying the hard stimulus keeps progress honest.`
        : "It's been all one pace lately — adding a single quality session to lift your ceiling."
    );
  } else if (recoveryDown) {
    rationale.push("Skipping the hard session this week — all easy aerobic while you recover.");
  } else if (baseTooThin) {
    rationale.push("Base is still thin — keeping every run easy until aerobic volume is established.");
  }

  // --- distance distribution ---
  const easyCount = Math.max(1, runDays - 1 - (qualityType ? 1 : 0));
  // Long run ~32–38% of weekly volume, but never a >10% jump on the recent longest.
  const prevLong = es?.longest_km_4wk ?? 0;
  let longKm = round1(weeklyKm * (taper ? 0.3 : 0.35));
  if (prevLong > 0) longKm = round1(Math.min(longKm, prevLong * 1.1));
  longKm = Math.max(longKm, round1(weeklyKm * 0.25));
  if (taper) longKm = round1(Math.min(longKm, Math.max(6, prevLong * 0.6)));

  const q = qualityType ? qualitySpec(qualityType, phase, zones, round1(weeklyKm * 0.18)) : null;
  const qualityKm = q?.distance ?? 0;
  const easyTotal = Math.max(easyCount * 3, round1(weeklyKm - longKm - qualityKm));
  const easyEach = round1(easyTotal / easyCount);

  // --- slot assignment (day_number 1–7): quality mid-week, long late, easy spread —
  //     never two hard days back-to-back (quality on 2, long on 6). ---
  const runs: RunPlanPrescription[] = [];
  const z2 = zoneTag("Z2", zones);
  // Easy slots, prefer non-adjacent to the hard days.
  const easySlots = [1, 4, 7, 3, 5].slice(0, easyCount);
  for (const slot of easySlots) {
    runs.push({
      day_number: slot, label: "Easy run", kind_label: "easy",
      target_distance_km: easyEach, target_duration_min: null, target_zone: z2,
      note: `Easy aerobic at ${z2} — relaxed and conversational.`,
      day_name: "Easy run", focus: "Endurance", interval: null,
    });
  }
  if (q) {
    runs.push({
      day_number: 2, label: q.label, kind_label: "quality",
      target_distance_km: q.distance, target_duration_min: q.duration,
      target_zone: zoneTag(q.zoneKey, zones), note: q.note,
      day_name: q.label, focus: "Endurance · quality", interval: q.interval,
    });
  }
  runs.push({
    day_number: 6, label: "Long run", kind_label: "long",
    target_distance_km: longKm, target_duration_min: null, target_zone: z2,
    note: `Long, steady at ${z2} — build aerobic durability, keep it easy throughout.`,
    day_name: "Long run", focus: "Endurance · long", interval: null,
  });

  // De-dupe day slots (an easy slot must never collide with the quality/long days).
  const used = new Set<number>([2, 6]);
  for (const r of runs) {
    if (r.kind_label !== "easy") continue;
    if (used.has(r.day_number)) {
      const free = [1, 3, 4, 5, 7].find((s) => !used.has(s));
      if (free) r.day_number = free;
    }
    used.add(r.day_number);
  }
  runs.sort((a, b) => a.day_number - b.day_number);

  const quality_focus = q ? q.label : null;
  const easyLabel = `${easyCount} easy`;
  const mix_summary = `${easyLabel} + 1 long${q ? ` + 1 ${qualityType}` : ""}`;
  const phaseWord = goal?.is_race && goal.phase ? `${goal.phase} phase` : "steady";
  const why = `~${Math.round(weeklyKm)} km this week (${phaseWord}): ${mix_summary}${q ? `, with ${q.label.toLowerCase()} as the quality work` : ", all easy aerobic"}.`;

  return { available: true, week_start, runs, rationale, quality_focus, mix_summary, why };
}

// ---------------------------------------------------------------------------
// (3) runVarietyRead — the endurance mirror of performance.varietyRead.
//     Flags mono-stimulus running and names the missing stimulus.
// ---------------------------------------------------------------------------
const RUN_VARIETY_WINDOW_DAYS = 42; // ~6 weeks
const RUN_VARIETY_MIN_RUNS = 6;

export function runVarietyRead(date?: string): { note: string; suggestions: string[] } | null {
  const d = date || localDateISO();
  const since = isoDaysAgo(d, RUN_VARIETY_WINDOW_DAYS);
  const patterns = enduranceSportPatterns(getProfile()?.endurance_sport);
  const aSport = activitySportWhere("a", patterns);

  let rows: any[] = [];
  try {
    rows = db.prepare(
      `SELECT a.date AS date, a.distance_km AS km,
              g.te_label AS te_label, g.anaerobic_te AS anaerobic_te, g.hr_zones_json AS hr_zones_json
         FROM activities a LEFT JOIN garmin_activities g ON g.activity_id = a.id
        WHERE a.date >= ? AND a.date <= ? AND (${aSport.sql})
        ORDER BY a.date`
    ).all(since, d, ...aSport.params) as any[];
  } catch { return null; }

  if (rows.length < RUN_VARIETY_MIN_RUNS) return null; // not enough runs to read variety honestly

  const HARD = new Set(["TEMPO", "THRESHOLD", "VO2MAX", "ANAEROBIC", "LACTATE_THRESHOLD"]);
  let hardRuns = 0;
  let longest = 0;
  const distances: number[] = [];
  for (const r of rows) {
    const label = String(r.te_label ?? "").toUpperCase();
    const anaerobic = Number(r.anaerobic_te ?? 0);
    let z45 = 0;
    try {
      const z = r.hr_zones_json ? JSON.parse(r.hr_zones_json) : null;
      if (Array.isArray(z)) for (const it of z) { if (Number(it?.zone) >= 4) z45 += Number(it?.secs ?? it?.seconds ?? 0) || 0; }
    } catch { /* ignore */ }
    if (HARD.has(label) || anaerobic >= 2 || z45 >= 240) hardRuns++;
    const km = Number(r.km);
    if (Number.isFinite(km) && km > 0) { distances.push(km); if (km > longest) longest = km; }
  }

  // Mono-stimulus tells, most useful first.
  if (hardRuns === 0) {
    return {
      note: `All ${rows.length} of your last runs have been easy aerobic — no faster work in 6 weeks. A weekly tempo, threshold or interval session would lift your ceiling without adding much mileage.`,
      suggestions: ["A tempo run (sustained comfortably-hard)", "Threshold intervals (e.g. 5 × 1km)", "VO2 intervals (e.g. 6 × 800m)"],
    };
  }
  // Same distance over and over (low spread) → missing a long run / variety.
  if (distances.length >= RUN_VARIETY_MIN_RUNS) {
    const mean = distances.reduce((a, b) => a + b, 0) / distances.length;
    const spread = Math.sqrt(distances.reduce((a, b) => a + (b - mean) ** 2, 0) / distances.length);
    if (mean > 0 && spread / mean < 0.15) {
      return {
        note: `Almost every run is the same ~${round1(mean)} km — your training is one distance on repeat. Mixing in a genuinely long run and a shorter, faster session would round it out.`,
        suggestions: ["A longer easy run (build aerobic durability)", "A short quality session (tempo or intervals)", "A recovery-paced shakeout"],
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// (4) enduranceTestsDue — running fitness re-tests (the endurance mirror of
//     performance.testsDue). Plain-words "why", kind:'endurance'.
// ---------------------------------------------------------------------------
const HARD_EFFORT_STALE_DAYS = 28;  // no quality effort in ~4 weeks → time-trial worth it
const VO2_STALE_DAYS = 90;          // VO2max reading older than ~3 months → refresh it

export function enduranceTestsDue(date?: string): { exercise: string; kind: "endurance"; why: string }[] {
  const d = date || localDateISO();
  const discipline = getPrimaryDiscipline();
  const goal = getEnduranceGoal(d);

  // Gate: only for a runner — endurance/hybrid, a running goal, or real history.
  const patterns = enduranceSportPatterns(getProfile()?.endurance_sport);
  const aSport = activitySportWhere("a", patterns);
  let runCount = 0;
  try {
    const c = db.prepare(
      `SELECT COUNT(*) AS n FROM activities a WHERE a.date >= ? AND (${aSport.sql})`
    ).get(isoDaysAgo(d, 90), ...aSport.params) as any;
    runCount = Number(c?.n ?? 0);
  } catch { /* keep 0 */ }
  const isRunner = discipline === "endurance" || discipline === "hybrid" || !!goal || runCount > 0;
  if (!isRunner) return [];

  const out: { exercise: string; kind: "endurance"; why: string }[] = [];

  // (a) No hard/quality effort in N weeks → a time-trial re-reads pace + estimates fitness.
  let lastHard: string | null = null;
  try {
    const r = db.prepare(
      `SELECT MAX(a.date) AS last FROM activities a JOIN garmin_activities g ON g.activity_id = a.id
        WHERE (${aSport.sql})
          AND (UPPER(COALESCE(g.te_label,'')) IN ('TEMPO','THRESHOLD','VO2MAX','ANAEROBIC','LACTATE_THRESHOLD')
               OR COALESCE(g.anaerobic_te,0) >= 2)`
    ).get(...aSport.params) as any;
    lastHard = r?.last ?? null;
  } catch { /* keep null */ }
  const hardDays = lastHard ? Math.round((Date.parse(d + "T00:00:00Z") - Date.parse(lastHard + "T00:00:00Z")) / 864e5) : null;
  if (runCount >= 3 && (hardDays == null || hardDays > HARD_EFFORT_STALE_DAYS)) {
    out.push({
      exercise: "1-mile or 5k time-trial",
      kind: "endurance",
      why: hardDays == null
        ? "You've been running all easy — a 1-mile or 5k time-trial would re-read your real pace and estimate your current fitness."
        : `It's been ~${Math.round(hardDays / 7)} weeks since a hard effort — a 1-mile or 5k time-trial re-anchors your pace and fitness.`,
    });
  }

  // (b) VO2max reading older than ~90 days → a max-effort Garmin run refreshes it.
  let lastVo2: string | null = null;
  try {
    const a = db.prepare(`SELECT MAX(date) AS last FROM garmin_daily_metrics WHERE vo2max IS NOT NULL`).get() as any;
    const b = db.prepare(`SELECT MAX(date) AS last FROM garmin_activities WHERE vo2max IS NOT NULL`).get() as any;
    const cands = [a?.last, b?.last].filter((x) => typeof x === "string" && x);
    lastVo2 = cands.length ? cands.sort().slice(-1)[0] : null;
  } catch { /* keep null */ }
  if (lastVo2) {
    const vo2Days = Math.round((Date.parse(d + "T00:00:00Z") - Date.parse(lastVo2 + "T00:00:00Z")) / 864e5);
    if (vo2Days > VO2_STALE_DAYS) {
      out.push({
        exercise: "Max-effort outdoor run (VO2max refresh)",
        kind: "endurance",
        why: `Your VO2max estimate is ~${Math.round(vo2Days / 30)} months old — a hard, sustained outdoor run lets your watch refresh it.`,
      });
    }
  }

  return out.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Apply path — map this week's deterministic run plan into a DRAFT plan proposal.
// Shared by REST (`POST /api/program/run-plan/apply`) and MCP (`apply_run_plan`)
// so the two near-mirror surfaces never drift (it was the one spot they did — a
// `run(s)` vs grammatical-plural summary). applyProposal walks `parsed.cardio[]`
// → setWeeklyRuns, which attaches each run to its day_number, REPLACES that day's
// cardio while leaving strength intact, and carries the interval structure. Never
// auto-applied. Returns the designed {ok:false} signal when there's no plan to propose.
// ---------------------------------------------------------------------------
export function buildRunPlanProposal(date?: string): { ok: false; error: string } | { ok: true; proposal: any } {
  const plan = weeklyRunPlan(date);
  if (!plan.available || !plan.runs.length) return { ok: false, error: "no run plan to propose" };
  const cardio = plan.runs.map((r: any) => ({
    day_number: r.day_number,
    label: r.label ?? r.day_name ?? "Run",
    target_distance_km: r.target_distance_km ?? null,
    target_duration_min: r.target_duration_min ?? null,
    target_zone: r.target_zone ?? null,
    note: r.note ?? null,
    day_name: r.day_name ?? r.label ?? "Run",
    focus: r.focus ?? "Endurance",
    interval: r.interval ?? null,
  }));
  const parsed = {
    summary: `This week's runs — ${plan.mix_summary || `${cardio.length} run${cardio.length === 1 ? "" : "s"}`}`,
    cardio,
  };
  supersedeAutoRunPlanDrafts();
  const proposal = createProposal("auto-run-plan", "run plan", "", parsed);
  return { ok: true, proposal };
}
