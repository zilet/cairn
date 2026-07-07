// Hybrid load reader: recent strength + endurance stress folded onto the muscle
// groups it actually loads. This is the shared floor for "do not squat heavy the
// day after a long/hard run" style coaching. Plain words only, no scores.
import { db } from "../db.js";
import { addDaysISO, daysBetweenISO, localDateISO } from "./shared.js";
import { canonicalGroup, classifyMuscleGroup, isMobility, type MuscleGroup } from "./exercise-canon.js";

const HEAVY_SETS = 4;

type EnduranceRegion = {
  re: RegExp;
  label: string;
  regions: MuscleGroup[];
  heavyMin: number;
  heavyKm: number;
};

// Per-modality thresholds: conservative prime movers only. A real long/hard run
// loads legs and trunk; a casual walk should not block lower-body training.
const ENDURANCE_REGIONS: EnduranceRegion[] = [
  { re: /\b(ride|cycl|bik|mtb|gravel|spin|peloton)/, label: "ride", regions: ["quads", "hamstrings", "glutes", "calves", "core"], heavyMin: 75, heavyKm: 30 },
  { re: /\b(run|jog|sprint|tempo|interval)/, label: "run", regions: ["quads", "hamstrings", "glutes", "calves", "core"], heavyMin: 55, heavyKm: 9 },
  { re: /\b(hik|walk|ruck|trek|stair|stepper|elliptical)/, label: "hike", regions: ["quads", "glutes", "calves", "hamstrings"], heavyMin: 120, heavyKm: 16 },
  { re: /\b(row|erg|kayak|paddle)/, label: "row", regions: ["back", "hamstrings", "glutes", "core"], heavyMin: 45, heavyKm: 8 },
  { re: /\b(swim)/, label: "swim", regions: ["back", "shoulders", "chest", "core"], heavyMin: 45, heavyKm: 2.5 },
  { re: /\b(ski|skat|snowboard)/, label: "session", regions: ["quads", "glutes", "calves", "hamstrings"], heavyMin: 90, heavyKm: 15 },
];

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
  intensity: "easy" | "moderate" | "hard";
  load: "light" | "moderate" | "heavy";
  regions: MuscleGroup[];
  detail: string;
  why: string;
}

function normalizeActivityText(text: string): string {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function matchEnduranceRegion(text: string): EnduranceRegion | null {
  const norm = normalizeActivityText(text);
  if (!norm) return null;
  for (const m of ENDURANCE_REGIONS) if (m.re.test(norm)) return m;
  return null;
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
  region: EnduranceRegion,
  dur: number | null,
  km: number | null,
  ate: number | null,
  anate: number | null,
  label: string | null,
  zones45: number,
): Pick<EnduranceImpact, "intensity" | "load" | "why"> {
  const hardLabel = /TEMPO|THRESHOLD|VO2MAX|ANAEROBIC|LACTATE/i.test(String(label ?? ""));
  const hard = hardLabel || (anate != null && anate >= 2) || (ate != null && ate >= 3) || zones45 >= 240;
  const long = (dur != null && dur >= region.heavyMin) || (km != null && km >= region.heavyKm);
  const moderate =
    hard ||
    (dur != null && dur >= region.heavyMin * 0.7) ||
    (km != null && km >= region.heavyKm * 0.7) ||
    (ate != null && ate >= 2);
  const intensity: EnduranceImpact["intensity"] = hard ? "hard" : moderate ? "moderate" : "easy";
  const load: EnduranceImpact["load"] = hard || long ? "heavy" : moderate ? "moderate" : "light";
  const whyParts: string[] = [];
  if (long) whyParts.push("long enough to fatigue the prime movers");
  if (hard) whyParts.push("hard enough to count as quality stress");
  if (!whyParts.length && moderate) whyParts.push("moderate aerobic load");
  if (!whyParts.length) whyParts.push("easy aerobic work");
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
              ga.hr_zones_json AS hr_zones_json
         FROM activities a
         LEFT JOIN garmin_activities ga ON ga.activity_id = a.id
        WHERE a.date >= ? AND a.date <= ?
        ORDER BY a.date DESC, a.id DESC`
    ).all(since, today) as any[];
    return acts
      .map((a): EnduranceImpact | null => {
        const region = matchEnduranceRegion(`${a.type || ""} ${a.raw_text || ""} ${a.notes || ""}`);
        if (!region) return null;
        const dur = a.duration_min != null ? Number(a.duration_min) : null;
        const km = a.distance_km != null ? Number(a.distance_km) : null;
        const ate = a.ate != null ? Number(a.ate) : null;
        const anate = a.anate != null ? Number(a.anate) : null;
        const z45 = z45Seconds(a.hr_zones_json);
        const load = classifyImpactLoad(region, dur, km, ate, anate, a.te_label ?? null, z45);
        const detail = durPhrase(dur, km);
        return {
          date: String(a.date),
          days_ago: dAgo(String(a.date)),
          type: String(a.type || region.label),
          label: region.label,
          duration_min: Number.isFinite(dur) ? dur : null,
          distance_km: Number.isFinite(km) ? km : null,
          aerobic_te: Number.isFinite(ate) ? ate : null,
          anaerobic_te: Number.isFinite(anate) ? anate : null,
          intensity: load.intensity,
          load: load.load,
          regions: region.regions,
          detail,
          why: load.why,
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

export function recentMuscleLoad(days = 2, date = localDateISO()): Map<MuscleGroup, RecentLoad> {
  const out = new Map<MuscleGroup, RecentLoad>();
  const today = String(date).slice(0, 10);
  const since = addDaysISO(today, -(Math.max(1, days) - 1)) ?? today;
  const dAgo = (iso: string): number => Math.max(0, daysBetweenISO(today, String(iso).slice(0, 10)) ?? 0);
  const bump = (g: MuscleGroup, when: string, heavy: boolean, src: "strength" | "endurance", activity: string | null, detail: string) => {
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
      heavy: prev.heavy || heavy,
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
    const tally = new Map<MuscleGroup, { sets: number; last: string }>();
    for (const r of sets) {
      const group = canonicalGroup(r.mg) ?? classifyMuscleGroup(r.name);
      if (!group || isMobility(group)) continue;
      const cur = tally.get(group) ?? { sets: 0, last: String(r.date) };
      cur.sets += 1;
      if (String(r.date) > cur.last) cur.last = String(r.date);
      tally.set(group, cur);
    }
    for (const [group, v] of tally) bump(group, v.last, v.sets >= HEAVY_SETS, "strength", null, "");
  } catch {
    // Missing/older tables: stay quiet.
  }

  for (const impact of recentEnduranceImpacts(days, today)) {
    for (const group of impact.regions) {
      bump(group, impact.date, impact.load === "heavy", "endurance", impact.label, impact.detail);
    }
  }

  return out;
}

export function loadPhrase(rl: RecentLoad): string {
  const when = whenWord(rl.days_ago);
  if (rl.activity) return `your ${rl.detail ? `${rl.detail} ` : ""}${rl.activity} ${when}`;
  return `the hard ${rl.group} work you did ${when}`;
}
