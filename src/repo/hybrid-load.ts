// Hybrid load reader: recent strength + endurance stress folded onto the muscle
// groups it actually loads. This is the shared floor for "do not squat heavy the
// day after a long/hard run" style coaching. Plain words only, no scores.
import { db } from "../db.js";
import { addDaysISO, daysBetweenISO, localDateISO } from "./shared.js";
import {
  canonicalGroup,
  classifyMuscleGroup,
  isMobility,
  type MuscleGroup,
  recoveryHalfLifeHours,
} from "./exercise-canon.js";
import { effectiveVolumeByGroup, type VolumeSet } from "./exercise-variations.js";
import {
  CARDIO_GRADE,
  HARD_EFFORT,
  HEAVY_SETS,
  type EnduranceModality,
  matchEnduranceModality,
} from "./heavy-load.js";

export interface RecentLoad {
  group: MuscleGroup;
  last_date: string;
  days_ago: number;
  heavy: boolean;
  source: "strength" | "endurance" | "both";
  activity: string | null;
  detail: string;
}

export interface EnduranceImpact {
  date: string;
  days_ago: number;
  type: string;
  label: string;
  duration_min: number | null;
  distance_km: number | null;
  aerobic_te: number | null;
  anaerobic_te: number | null;
  training_load: number | null;
  ascent_m: number | null;
  elevation_loss_m: number | null;
  intensity: "easy" | "moderate" | "hard";
  load: "light" | "moderate" | "heavy";
  load_character: EnduranceModality["loadCharacter"];
  aerobic_volume: "full" | "mixed" | "limited";
  regions: MuscleGroup[];
  detail: string;
  why: string;
  // How far past this modality's own heavy bar the effort went — 1.0 means it
  // landed right on the bar, 2.4 means a 3 h ride against a 75-min bar. The old
  // boolean model had nowhere to put this, so a 75-minute ride and a 3-hour ride
  // were the same event; muscleResidual scales the dose by it so a genuinely huge
  // day still reads loaded once a fast-recovering group has had a night. Never
  // rendered — a magnitude is machinery, not something an athlete is shown.
  heavy_ratio: number;
}

export function isLoadRelevantEnduranceImpact(impact: EnduranceImpact): boolean {
  if (impact.load === "moderate" || impact.load === "heavy") return true;
  if (impact.label === "hike") return false;
  if (impact.aerobic_volume === "limited") return false;
  return (
    (impact.duration_min != null && impact.duration_min >= CARDIO_GRADE.moderateMin) ||
    (impact.distance_km != null && impact.distance_km >= CARDIO_GRADE.moderateKm)
  );
}

function durPhrase(min: number | null, km: number | null): string {
  if (min != null && min > 0) return min >= 90 ? `~${Math.round(min / 60)} h` : `~${Math.round(min / 5) * 5} min`;
  if (km != null && km > 0) return `~${Math.round(km)} km`;
  return "";
}

function whenWord(daysAgo: number): string {
  return daysAgo <= 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo} days ago`;
}

function z45Seconds(raw: unknown): number {
  try {
    const zones = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(zones)) return 0;
    return zones.reduce((sum, z) => {
      const zone = Number(z?.zone);
      if (!Number.isFinite(zone) || zone < 4) return sum;
      return sum + (Number(z?.secs ?? z?.seconds ?? 0) || 0);
    }, 0);
  } catch {
    return 0;
  }
}

function classifyImpactLoad(
  region: EnduranceModality,
  dur: number | null,
  km: number | null,
  ate: number | null,
  anate: number | null,
  trainingLoad: number | null,
  label: string | null,
  zones45: number,
  ascent: number | null,
  descent: number | null,
): Pick<EnduranceImpact, "intensity" | "load" | "why"> {
  // One shared definition of a hard effort (heavy-load.HARD_EFFORT) — this test
  // used to carry its own weaker label pattern, so a logged sprint or interval
  // session read as hard to the day grade and merely moderate here.
  const hardLabel = HARD_EFFORT.label.test(String(label ?? ""));
  const hard =
    hardLabel ||
    (trainingLoad != null && trainingLoad >= HARD_EFFORT.trainingLoadFloor) ||
    (anate != null && anate >= HARD_EFFORT.anaerobicTe) ||
    (ate != null && ate >= HARD_EFFORT.aerobicTe) ||
    zones45 >= HARD_EFFORT.z4Seconds;
  const long = (dur != null && dur >= region.heavyMin) || (km != null && km >= region.heavyKm);
  const moderate =
    hard ||
    (dur != null && dur >= region.heavyMin * 0.7) ||
    (km != null && km >= region.heavyKm * 0.7) ||
    (ate != null && ate >= 2);
  const intensity: EnduranceImpact["intensity"] = hard ? "hard" : moderate ? "moderate" : "easy";
  const load: EnduranceImpact["load"] = hard || long ? "heavy" : moderate ? "moderate" : "light";
  const whyParts: string[] = [];
  if (long && region.loadCharacter === "technical-eccentric") {
    whyParts.push("long enough for sustained braking, handling and trunk demand");
  } else if (long && region.loadCharacter === "eccentric") {
    whyParts.push("long enough for sustained turning, braking and leg-control demand");
  } else if (long) {
    whyParts.push("long enough to fatigue the prime movers");
  }
  if (hard) whyParts.push("hard enough to count as quality stress");
  if (!whyParts.length && moderate) {
    whyParts.push(
      region.loadCharacter === "technical-eccentric" || region.loadCharacter === "eccentric"
        ? "moderate technical and eccentric load"
        : "moderate aerobic load",
    );
  }
  if (!whyParts.length) {
    whyParts.push(
      region.loadCharacter === "technical-eccentric" || region.loadCharacter === "eccentric"
        ? "short technical and eccentric exposure"
        : "easy aerobic work",
    );
  }
  if (region.mode === "ride-trail-mtb") {
    if ((ascent ?? 0) > 0 && (descent ?? 0) > 0) {
      whyParts.push("climbing loads the legs while technical descending also asks for trunk, back and grip control");
    } else if ((ascent ?? 0) > 0) {
      whyParts.push("logged climbing adds leg and aerobic demand alongside trail handling");
    } else {
      whyParts.push("trail riding combines pedaling with trunk, back and grip demand");
    }
  } else if (region.mode === "ride-downhill-mtb") {
    whyParts.push("lift-served or downhill time is technical load, not equivalent aerobic cycling volume");
  } else if (region.mode === "ski-alpine") {
    whyParts.push("alpine turns and braking add eccentric leg and core demand");
  } else if (region.mode === "ski-nordic") {
    whyParts.push("Nordic skiing carries aerobic full-body demand");
  } else if (region.mode === "ski-touring") {
    whyParts.push("touring climbs load the legs and core, with additional control on the descent");
  }
  return { intensity, load, why: whyParts.join(" and ") };
}

export function recentEnduranceImpacts(days = 3, date = localDateISO()): EnduranceImpact[] {
  const today = String(date).slice(0, 10);
  const since = addDaysISO(today, -(Math.max(1, days) - 1)) ?? today;
  const dAgo = (iso: string): number => Math.max(0, daysBetweenISO(today, String(iso).slice(0, 10)) ?? 0);
  try {
    const acts = db.prepare(
      `SELECT a.date AS date, a.type AS type, a.raw_text AS raw_text, a.notes AS notes,
              a.duration_min AS duration_min, a.distance_km AS distance_km,
              ga.te_label AS te_label, ga.aerobic_te AS ate, ga.anaerobic_te AS anate,
              ga.training_load AS training_load,
              ga.hr_zones_json AS hr_zones_json,
              ga.type AS garmin_type, ga.name AS garmin_name,
              ga.ascent_m AS ascent_m, ga.elevation_loss_m AS elevation_loss_m
         FROM activities a
         LEFT JOIN garmin_activities ga ON ga.activity_id = a.id
        WHERE a.date >= ? AND a.date <= ?
        ORDER BY a.date DESC, a.id DESC`
    ).all(since, today) as any[];
    return acts
      .map((a): EnduranceImpact | null => {
        const region = matchEnduranceModality(
          String(a.type || ""),
          `${a.raw_text || ""} ${a.notes || ""} ${a.garmin_type || ""} ${a.garmin_name || ""}`,
        );
        if (!region) return null;
        const dur = a.duration_min != null ? Number(a.duration_min) : null;
        const km = a.distance_km != null ? Number(a.distance_km) : null;
        const ate = a.ate != null ? Number(a.ate) : null;
        const anate = a.anate != null ? Number(a.anate) : null;
        const trainingLoad = a.training_load != null ? Number(a.training_load) : null;
        const ascent = a.ascent_m != null ? Number(a.ascent_m) : null;
        const descent = a.elevation_loss_m != null ? Number(a.elevation_loss_m) : null;
        const z45 = z45Seconds(a.hr_zones_json);
        const load = classifyImpactLoad(
          region,
          dur,
          km,
          ate,
          anate,
          trainingLoad,
          a.te_label ?? null,
          z45,
          Number.isFinite(ascent) ? ascent : null,
          Number.isFinite(descent) ? descent : null,
        );
        const detail = durPhrase(dur, km);
        const aerobicVolume =
          region.loadCharacter === "technical-eccentric" || region.loadCharacter === "eccentric"
            ? "limited"
            : region.loadCharacter === "mixed-terrain"
              ? "mixed"
              : "full";
        return {
          date: String(a.date),
          days_ago: dAgo(String(a.date)),
          type: String(a.type || region.label),
          label: region.label,
          duration_min: Number.isFinite(dur) ? dur : null,
          distance_km: Number.isFinite(km) ? km : null,
          aerobic_te: Number.isFinite(ate) ? ate : null,
          anaerobic_te: Number.isFinite(anate) ? anate : null,
          training_load: Number.isFinite(trainingLoad) ? trainingLoad : null,
          ascent_m: Number.isFinite(ascent) ? ascent : null,
          elevation_loss_m: Number.isFinite(descent) ? descent : null,
          intensity: load.intensity,
          load: load.load,
          load_character: region.loadCharacter,
          aerobic_volume: aerobicVolume,
          regions: region.regions,
          detail,
          why: load.why,
          heavy_ratio: Math.max(
            1,
            dur != null && region.heavyMin > 0 ? dur / region.heavyMin : 0,
            km != null && region.heavyKm > 0 ? km / region.heavyKm : 0
          ),
        };
      })
      .filter((x): x is EnduranceImpact => !!x)
      .sort((a, b) => {
        const weight = { heavy: 0, moderate: 1, light: 2 };
        return weight[a.load] - weight[b.load] || a.days_ago - b.days_ago;
      });
  } catch {
    return [];
  }
}

// ---- the temporal muscle model: a per-group decaying residual ---------------
// Fatigue used to be a BOOLEAN with a cliff — `sets >= 4` inside a 2-day window —
// so a muscle was equally smoked by 4 sets and by 30, and went from smoked to
// fresh at midnight on an arbitrary day. Every decision downstream inherited that
// flatness. The residual replaces it with a DOSE that decays:
//
//   residual(group) = Σ_days  dose(day) × 0.5 ^ (hours_since / half_life(group))
//
// * DOSE is measured in "one heavy session" units, so it is comparable across
//   groups and modalities. For strength that is effective working sets (shared
//   effectiveVolumeByGroup — warmups excluded, RIR-weighted, indirect credit at
//   half) over HEAVY_SETS. Raw rows are NEVER re-counted here.
// * HALF-LIFE is per group (exercise-canon.MUSCLE_RECOVERY_HALF_LIFE_H), so a
//   hamstring day still reads loaded on Wednesday while rear delts do not.
// * The residual is INTERNAL. It is a float, and the no-scores law means it never
//   reaches an athlete surface — consumers read the BANDS (fresh / loaded /
//   saturated) and speak in plain muscle words.
export const RESIDUAL_LOOKBACK_DAYS = 7; // ~3 half-lives of the slowest group; older work contributes <0.1

// Band thresholds on the residual, in heavy-session units.
//
// SATURATED (0.75) is calibrated to REPRODUCE the old `sets >= HEAVY_SETS` bar at
// the boundary. The old rule counted RAW logged rows, warmups included; effective
// volume excludes the ramp-up, so a typical "4 logged sets" day is ~3 effective
// working sets = 0.75 of a heavy dose. Same-day work therefore crosses at the same
// place it always did, while yesterday's work now crosses it only for the slower
// groups — which is the correction this model exists to make.
export const SATURATED_RESIDUAL = 0.75;
export const LOADED_RESIDUAL = 0.35; // still carrying real work; not a reason to hold load

// An endurance effort's dose on each of the prime movers the modality loads.
// ENDURANCE_MODALITIES lists conservative prime movers only, so the dose is
// credited evenly across them rather than invented per-region. A "light" effort
// only counts when it clears isLoadRelevantEnduranceImpact — a casual walk is not
// a dose on anything.
const ENDURANCE_DOSE: Record<EnduranceImpact["load"], number> = { heavy: 1, moderate: 0.6, light: 0.25 };

// A heavy effort scales past one session-equivalent by how far it went past the
// modality's own heavy bar, capped so a single enormous day cannot dominate the
// whole week's picture. Sub-heavy efforts do not scale — they sit below the bar by
// definition, and inflating them would re-introduce the flatness this replaces.
const MAX_ENDURANCE_MAGNITUDE = 2.5;

export function enduranceDose(impact: EnduranceImpact): number {
  const base = ENDURANCE_DOSE[impact.load];
  if (!(base > 0)) return 0;
  if (impact.load === "light" && !isLoadRelevantEnduranceImpact(impact)) return 0;
  if (impact.load !== "heavy") return base;
  const ratio = Number.isFinite(impact.heavy_ratio) ? Math.max(1, impact.heavy_ratio) : 1;
  return base * Math.min(ratio, MAX_ENDURANCE_MAGNITUDE);
}

export type AcuteBand = "fresh" | "loaded" | "saturated";

export interface MuscleResidual {
  group: MuscleGroup;
  residual: number; // INTERNAL — never rendered
  band: AcuteBand;
  strength: number; // residual contributed by logged sets
  endurance: number; // residual contributed by endurance regions
  half_life_h: number;
  last_date: string | null;
  days_ago: number | null;
  source: "strength" | "endurance" | "both" | "none";
  activity: string | null;
  detail: string;
}

export function residualBand(residual: number): AcuteBand {
  if (residual >= SATURATED_RESIDUAL) return "saturated";
  if (residual >= LOADED_RESIDUAL) return "loaded";
  return "fresh";
}

// Decay one dose laid down `daysAgo` days back. Logged sets carry a date, not a
// clock time, so a day is 24 h and today's work has not decayed at all.
function decayFactor(daysAgo: number, halfLifeH: number): number {
  const hours = Math.max(0, daysAgo) * 24;
  return 0.5 ** (hours / Math.max(1, halfLifeH));
}

// The decaying residual per canonical group. Pure-ish (reads logged sets +
// activities); null-safe — any read problem yields an empty map, never a throw.
export function muscleResidual(
  days = RESIDUAL_LOOKBACK_DAYS,
  date = localDateISO()
): Map<MuscleGroup, MuscleResidual> {
  const today = String(date).slice(0, 10);
  const lookback = Math.max(1, days);
  const since = addDaysISO(today, -(lookback - 1)) ?? today;
  const dAgo = (iso: string): number => Math.max(0, daysBetweenISO(today, String(iso).slice(0, 10)) ?? 0);

  const acc = new Map<
    MuscleGroup,
    { strength: number; endurance: number; last: string | null; activity: string | null; detail: string }
  >();
  const touch = (g: MuscleGroup, when: string) => {
    const cur = acc.get(g) ?? { strength: 0, endurance: 0, last: null, activity: null, detail: "" };
    if (!cur.last || when > cur.last) cur.last = when;
    acc.set(g, cur);
    return cur;
  };

  // ---- strength: effective working volume per DAY, then decayed -------------
  try {
    const rows = db
      .prepare(
        `SELECT e.muscle_group AS muscle_group, e.name AS exercise, s.date AS date,
                ls.weight AS weight, ls.reps AS reps, ls.rir AS rir
           FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
           JOIN sessions s ON s.id = ls.session_id
          WHERE s.date >= ? AND s.date <= ?`
      )
      .all(since, today) as any[];
    const byDate = new Map<string, VolumeSet[]>();
    for (const r of rows) {
      const d = String(r.date).slice(0, 10);
      const bucket = byDate.get(d);
      if (bucket) bucket.push(r as VolumeSet);
      else byDate.set(d, [r as VolumeSet]);
    }
    for (const [day, sets] of byDate) {
      const factorDays = dAgo(day);
      // ONE effective-volume truth, per day so each day's dose decays on its own.
      for (const [group, volume] of effectiveVolumeByGroup(sets)) {
        if (isMobility(group)) continue;
        const halfLife = recoveryHalfLifeHours(group);
        if (halfLife == null) continue;
        const dose = volume.sets / HEAVY_SETS;
        if (!(dose > 0)) continue;
        const cur = touch(group, day);
        cur.strength += dose * decayFactor(factorDays, halfLife);
      }
    }
  } catch {
    // Missing/older tables: stay quiet, exactly as recentMuscleLoad always has.
  }

  // ---- endurance: regional contributions, same decay ------------------------
  for (const impact of recentEnduranceImpacts(lookback, today)) {
    const dose = enduranceDose(impact);
    if (!(dose > 0)) continue;
    for (const group of impact.regions) {
      if (isMobility(group)) continue;
      const halfLife = recoveryHalfLifeHours(group);
      if (halfLife == null) continue;
      const cur = touch(group, impact.date);
      cur.endurance += dose * decayFactor(impact.days_ago, halfLife);
      // Name the endurance effort a consumer can blame — which is NOT simply the
      // most recent one. recentEnduranceImpacts arrives heaviest-first and only
      // then by recency, and `cur.last` already counts strength days, so the
      // heaviest effort takes the name whenever something more recent touched the
      // group, and otherwise it passes to whichever effort last matched the
      // running-latest date.
      if (!cur.activity || impact.date >= (cur.last ?? impact.date)) {
        cur.activity = impact.label;
        cur.detail = impact.detail;
      }
    }
  }

  const out = new Map<MuscleGroup, MuscleResidual>();
  for (const [group, v] of acc) {
    const residual = v.strength + v.endurance;
    const source: MuscleResidual["source"] =
      v.strength > 0 && v.endurance > 0 ? "both" : v.strength > 0 ? "strength" : v.endurance > 0 ? "endurance" : "none";
    out.set(group, {
      group,
      residual,
      band: residualBand(residual),
      strength: v.strength,
      endurance: v.endurance,
      half_life_h: recoveryHalfLifeHours(group) ?? 0,
      last_date: v.last,
      days_ago: v.last ? dAgo(v.last) : null,
      source,
      activity: v.activity,
      detail: v.detail,
    });
  }
  return out;
}

// ---- acuteGate: the ONE acute-recovery question every consumer asks ---------
// Four call sites used to ask it four different ways — `rl?.heavy` alone, `heavy
// && days_ago <= 2`, `heavy && days_ago <= 1`, and a bare `heavy` inside the
// progression brake — so the same muscle could be "recovering" to the plan-day
// picker and "fresh" to the balance card on the same morning. They all read this
// now, and two surfaces that never asked at all (forwardLook, weekAheadPlan) ask
// it too.
export interface AcuteGateReading {
  group: MuscleGroup;
  band: AcuteBand;
  residual: number; // INTERNAL — never rendered
  // The shared gate: this group carries close to a full session's worth of
  // undissipated work. Do not add load to it, and do not call it "due" today.
  saturated: boolean;
  last_date: string | null;
  days_ago: number | null;
  source: MuscleResidual["source"];
  activity: string | null;
  detail: string;
}

const FRESH_GATE: Omit<AcuteGateReading, "group"> = {
  band: "fresh",
  residual: 0,
  saturated: false,
  last_date: null,
  days_ago: null,
  source: "none",
  activity: null,
  detail: "",
};

// Read the gate for one group. Pass a residual map computed once when gating a
// whole list — the map is a couple of queries, and callers in a loop should not
// repeat them.
export function acuteGate(
  group: MuscleGroup | string,
  date = localDateISO(),
  residuals?: Map<MuscleGroup, MuscleResidual>
): AcuteGateReading {
  const canonical = canonicalGroup(group) ?? null;
  if (!canonical) return { group: group as MuscleGroup, ...FRESH_GATE };
  const map = residuals ?? muscleResidual(RESIDUAL_LOOKBACK_DAYS, date);
  const r = map.get(canonical);
  if (!r) return { group: canonical, ...FRESH_GATE };
  return {
    group: canonical,
    band: r.band,
    residual: r.residual,
    saturated: r.band === "saturated",
    last_date: r.last_date,
    days_ago: r.days_ago,
    source: r.source,
    activity: r.activity,
    detail: r.detail,
  };
}

// Gates for every group carrying any residual, for callers that filter a list.
export function acuteGates(date = localDateISO()): Map<MuscleGroup, AcuteGateReading> {
  const residuals = muscleResidual(RESIDUAL_LOOKBACK_DAYS, date);
  const out = new Map<MuscleGroup, AcuteGateReading>();
  for (const group of residuals.keys()) out.set(group, acuteGate(group, date, residuals));
  return out;
}

// Drop the groups a "due" list should not be naming today, because they are still
// carrying the work that made them tired. Volume balance answers "has this group
// had enough work lately" over two WEEKS; the gate answers "can it take work
// today". Both can be true at once — a group can be genuinely under-trained AND
// flattened by yesterday's long run — and telling the athlete to go train it in
// that state is the connected read failing. Fail-soft: a read problem leaves the
// list exactly as it was rather than silently emptying the surface.
export function suppressSaturatedDue(due: string[], date = localDateISO()): string[] {
  if (!Array.isArray(due) || !due.length) return [];
  try {
    const gates = acuteGates(date);
    const kept = due.filter((g) => {
      const canonical = canonicalGroup(g);
      return !(canonical && gates.get(canonical)?.saturated);
    });
    return kept;
  } catch {
    return due;
  }
}

// ---- strengthLegLoad: what the LIFTING has left in the running legs ---------
// The run builder's mirror of the strength side's autoregulation brake. Endurance
// load already reaches strength decisions in real time through acuteGate; the reverse
// direction was a static calendar lookup (the plan's fixed leg-day weekday slots), so
// a long run could be sized and placed with no idea that the legs had squatted heavy
// twice since Friday.
//
// It reads the STRENGTH-sourced share of the residual ON PURPOSE, not the total. The
// run builder can already see its own lane from every angle — the volume anchor is
// last week's real mileage, `spiking` reads the endurance ACWR, and the recovery gates
// read the wearable — so folding the athlete's own running back in as a second reason
// to hold would double-count it, and a runner training normally would then have every
// build week deferred by the running that earned it. What the run builder genuinely
// cannot see is the other lane. That is what this answers.
//
// The prime movers are the run modality's own regions (heavy-load.ENDURANCE_MODALITIES)
// MINUS core: core is loaded by nearly everything, recovers on its own clock, and is
// never the tissue that decides whether a long run is a good idea.
export const RUN_PRIME_GROUPS: readonly MuscleGroup[] = ["quads", "hamstrings", "glutes", "calves"];

export interface StrengthLegLoad {
  /** The COMPOSITE band across the prime movers — not any single group's band. */
  band: AcuteBand;
  /** The shared bar: the legs are carrying a real lower-body session, not an accessory. */
  saturated: boolean;
  saturated_groups: MuscleGroup[];
  loaded_groups: MuscleGroup[];
  /** False when no lifting has touched a running muscle at all — absence is neutral. */
  has_data: boolean;
}

export const NO_LEG_LOAD: StrengthLegLoad = {
  band: "fresh",
  saturated: false,
  saturated_groups: [],
  loaded_groups: [],
  has_data: false,
};

export function strengthLegLoad(
  date = localDateISO(),
  residuals?: Map<MuscleGroup, MuscleResidual>
): StrengthLegLoad {
  let map: Map<MuscleGroup, MuscleResidual>;
  try {
    map = residuals ?? muscleResidual(RESIDUAL_LOOKBACK_DAYS, date);
  } catch {
    return NO_LEG_LOAD;
  }
  const saturated_groups: MuscleGroup[] = [];
  const loaded_groups: MuscleGroup[] = [];
  for (const group of RUN_PRIME_GROUPS) {
    const strength = map.get(group)?.strength ?? 0;
    if (!(strength > 0)) continue;
    const band = residualBand(strength);
    if (band === "saturated") saturated_groups.push(group);
    else if (band === "loaded") loaded_groups.push(group);
  }
  // SATURATED wants one group at the full-session bar AND a second carrying real work —
  // that is a leg day (a squat saturates the quads and leaves the glutes and hamstrings
  // loaded), where one group alone is an accessory block and no reason to shrink a long
  // run. Anything else that is carrying work at all reads LOADED, which nudges placement
  // but defers nothing.
  const carrying = saturated_groups.length + loaded_groups.length;
  const band: AcuteBand =
    saturated_groups.length >= 1 && carrying >= 2 ? "saturated" : carrying >= 1 ? "loaded" : "fresh";
  return {
    band,
    saturated: band === "saturated",
    saturated_groups,
    loaded_groups,
    has_data: carrying > 0,
  };
}

// The groups a deferral sentence names, in plain words: "your quads and glutes".
// Deliberately not loadPhrase(): that names the single most recent thing that touched
// the group, which for a hybrid athlete is often a run — and a run is exactly what this
// read is NOT about.
export function legLoadGroupsPhrase(load: StrengthLegLoad): string {
  const groups = [...load.saturated_groups, ...load.loaded_groups];
  if (!groups.length) return "your legs";
  if (groups.length === 1) return `your ${groups[0]}`;
  return `your ${groups.slice(0, -1).join(", ")} and ${groups[groups.length - 1]}`;
}

// Which groups were touched in the last `days`, and what shape that work was in.
// The WINDOW here still scopes what gets REPORTED (last_date / days_ago / source /
// activity are recency facts about the near past), but `heavy` is no longer a raw
// set count inside that window — it is the saturated band of the decaying residual,
// which looks back further and forgets at each group's own rate. So a group can be
// listed as trained yesterday and still read fresh, which the old cliff could not
// express.
//
// This record is spread whole into the coach context as `recent_load`, so it must
// carry NO internal magnitude — a consumer that needs the depth behind `heavy`
// reads acuteGate()/muscleResidual() directly rather than having the float ride
// along into every training prompt.
export function recentMuscleLoad(days = 2, date = localDateISO()): Map<MuscleGroup, RecentLoad> {
  const out = new Map<MuscleGroup, RecentLoad>();
  const today = String(date).slice(0, 10);
  const since = addDaysISO(today, -(Math.max(1, days) - 1)) ?? today;
  const dAgo = (iso: string): number => Math.max(0, daysBetweenISO(today, String(iso).slice(0, 10)) ?? 0);
  const residuals = muscleResidual(RESIDUAL_LOOKBACK_DAYS, today);
  const bump = (g: MuscleGroup, when: string, src: "strength" | "endurance", activity: string | null, detail: string) => {
    const heavy = residuals.get(g)?.band === "saturated";
    const prev = out.get(g);
    if (!prev) {
      out.set(g, { group: g, last_date: when, days_ago: dAgo(when), heavy, source: src, activity, detail });
      return;
    }
    const newer = when > prev.last_date;
    out.set(g, {
      group: g,
      last_date: newer ? when : prev.last_date,
      days_ago: Math.min(prev.days_ago, dAgo(when)),
      heavy,
      source: prev.source === src ? src : "both",
      activity: src === "endurance" ? activity : prev.activity,
      detail: src === "endurance" && detail ? detail : prev.detail,
    });
  };

  try {
    const sets = db.prepare(
      `SELECT e.muscle_group AS mg, e.name AS name, s.date AS date
         FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
         JOIN sessions s ON s.id = ls.session_id
        WHERE s.date >= ? AND s.date <= ?`
    ).all(since, today) as any[];
    const tally = new Map<MuscleGroup, { last: string }>();
    for (const r of sets) {
      const group = canonicalGroup(r.mg) ?? classifyMuscleGroup(r.name);
      if (!group || isMobility(group)) continue;
      const cur = tally.get(group) ?? { last: String(r.date) };
      if (String(r.date) > cur.last) cur.last = String(r.date);
      tally.set(group, cur);
    }
    for (const [group, v] of tally) bump(group, v.last, "strength", null, "");
  } catch {
    // Missing/older tables: stay quiet.
  }

  for (const impact of recentEnduranceImpacts(days, today)) {
    for (const group of impact.regions) {
      bump(group, impact.date, "endurance", impact.label, impact.detail);
    }
  }

  return out;
}

// What loaded this group, in plain words. Reads either shape — the recency record
// or the acute gate — since both carry the same four facts a sentence needs.
export function loadPhrase(rl: RecentLoad | AcuteGateReading): string {
  const when = rl.days_ago == null ? "recently" : whenWord(rl.days_ago);
  if (rl.activity) return `your ${rl.detail ? `${rl.detail} ` : ""}${rl.activity} ${when}`;
  return `the hard ${rl.group} work you did ${when}`;
}
