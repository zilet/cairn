import { getRecoverySummary } from "./coach.js";
import { bpRead, listBloodPressureReadings } from "./health.js";
import { getProfile, listWeight } from "./profile.js";
import { healthFocus, prioritizeMarkers } from "./propagation.js";
import { getWeeklyStats } from "./sessions.js";

// The reference-curve machinery is shared with the performance/training-standing
// read (src/repo/performance.ts) so strength capacity and VO2max both render in the
// SAME percentile-for-age language — exported here rather than re-implemented.
export type Sex = "male" | "female";
type CurveDirection = "higher" | "lower";
export type Tone = "strong" | "steady" | "watch" | "missing";

export interface PercentilePoint { p: number; value: number; }
export interface ReferenceCurve {
  key: string;
  label: string;
  unit: string;
  direction: CurveDirection;
  source: string;
  // The warm, plain-language verb for the percentile read ("fitter than 72% of men
  // your age"). Always reads higher = better (the percentile is direction-normalized).
  compare_verb?: string;
  bands: Record<Sex, Record<number, PercentilePoint[]>>;
}

const REF_AGES = [20, 30, 40, 50, 60, 70];

// Curated reference curves used only for a pull-based orientation read. VO2max is
// from FRIEND treadmill reference standards; body-fat bands are coarse NHANES/DXA
// orientation bands. These are not clinical targets and never become a grade.
export const VO2_CURVE: ReferenceCurve = {
  key: "vo2max",
  label: "VO2max",
  unit: "mL/kg/min",
  direction: "higher",
  compare_verb: "fitter than",
  source: "FRIEND registry CPET treadmill reference standards",
  bands: {
    male: {
      20: [[10, 28.6], [20, 35.2], [30, 40.0], [40, 43.6], [50, 46.5], [60, 49.0], [70, 51.9], [80, 54.5], [90, 58.6]].map(([p, value]) => ({ p, value })),
      30: [[10, 24.9], [20, 29.8], [30, 33.5], [40, 37.0], [50, 39.7], [60, 43.4], [70, 46.4], [80, 50.0], [90, 55.5]].map(([p, value]) => ({ p, value })),
      40: [[10, 22.1], [20, 26.7], [30, 29.7], [40, 32.4], [50, 35.3], [60, 37.9], [70, 40.9], [80, 45.2], [90, 50.8]].map(([p, value]) => ({ p, value })),
      50: [[10, 18.6], [20, 22.2], [30, 24.5], [40, 26.9], [50, 29.2], [60, 31.8], [70, 34.3], [80, 38.3], [90, 43.4]].map(([p, value]) => ({ p, value })),
      60: [[10, 15.8], [20, 18.5], [30, 20.7], [40, 22.8], [50, 24.6], [60, 26.5], [70, 28.7], [80, 32.0], [90, 37.1]].map(([p, value]) => ({ p, value })),
      70: [[10, 13.6], [20, 15.9], [30, 17.3], [40, 19.1], [50, 20.6], [60, 22.2], [70, 23.8], [80, 25.9], [90, 29.4]].map(([p, value]) => ({ p, value })),
    },
    female: {
      20: [[10, 22.5], [20, 27.2], [30, 30.8], [40, 34.0], [50, 36.6], [60, 39.0], [70, 41.8], [80, 44.8], [90, 49.0]].map(([p, value]) => ({ p, value })),
      30: [[10, 18.6], [20, 21.9], [30, 24.2], [40, 26.4], [50, 28.3], [60, 31.0], [70, 33.6], [80, 37.0], [90, 42.1]].map(([p, value]) => ({ p, value })),
      40: [[10, 17.2], [20, 19.7], [30, 21.8], [40, 23.9], [50, 25.7], [60, 27.7], [70, 30.0], [80, 33.0], [90, 37.8]].map(([p, value]) => ({ p, value })),
      50: [[10, 16.5], [20, 18.5], [30, 20.1], [40, 21.5], [50, 22.9], [60, 24.6], [70, 26.3], [80, 28.4], [90, 32.4]].map(([p, value]) => ({ p, value })),
      60: [[10, 13.4], [20, 15.4], [30, 17.0], [40, 18.3], [50, 19.6], [60, 20.9], [70, 22.4], [80, 24.3], [90, 27.3]].map(([p, value]) => ({ p, value })),
      70: [[10, 12.3], [20, 14.0], [30, 15.2], [40, 16.2], [50, 17.2], [60, 18.3], [70, 19.6], [80, 20.8], [90, 22.8]].map(([p, value]) => ({ p, value })),
    },
  },
};

const BODY_FAT_CURVE: ReferenceCurve = {
  key: "body_fat_pct",
  label: "Body fat",
  unit: "%",
  direction: "lower",
  compare_verb: "leaner than",
  source: "NHANES DXA body-composition orientation bands",
  bands: {
    male: {
      20: [[10, 11], [25, 16], [50, 23], [75, 29], [90, 35]].map(([p, value]) => ({ p, value })),
      30: [[10, 13], [25, 18], [50, 25], [75, 31], [90, 37]].map(([p, value]) => ({ p, value })),
      40: [[10, 15], [25, 21], [50, 28], [75, 34], [90, 40]].map(([p, value]) => ({ p, value })),
      50: [[10, 17], [25, 23], [50, 30], [75, 36], [90, 42]].map(([p, value]) => ({ p, value })),
      60: [[10, 19], [25, 25], [50, 31], [75, 38], [90, 44]].map(([p, value]) => ({ p, value })),
      70: [[10, 20], [25, 26], [50, 32], [75, 39], [90, 45]].map(([p, value]) => ({ p, value })),
    },
    female: {
      20: [[10, 20], [25, 25], [50, 32], [75, 38], [90, 45]].map(([p, value]) => ({ p, value })),
      30: [[10, 22], [25, 28], [50, 35], [75, 41], [90, 48]].map(([p, value]) => ({ p, value })),
      40: [[10, 24], [25, 30], [50, 37], [75, 44], [90, 51]].map(([p, value]) => ({ p, value })),
      50: [[10, 26], [25, 32], [50, 39], [75, 46], [90, 53]].map(([p, value]) => ({ p, value })),
      60: [[10, 28], [25, 34], [50, 42], [75, 49], [90, 56]].map(([p, value]) => ({ p, value })),
      70: [[10, 29], [25, 35], [50, 43], [75, 50], [90, 57]].map(([p, value]) => ({ p, value })),
    },
  },
};

export function sexOf(profile: any): Sex {
  return String(profile?.sex || "male").toLowerCase() === "female" ? "female" : "male";
}

function decade(age: number | null | undefined): number {
  const n = Number(age);
  if (!Number.isFinite(n)) return 40;
  return Math.max(20, Math.min(70, Math.floor(n / 10) * 10));
}

function valueAt(points: PercentilePoint[], pct: number): number {
  const sorted = [...points].sort((a, b) => a.p - b.p);
  if (pct <= sorted[0].p) return sorted[0].value;
  for (let i = 1; i < sorted.length; i++) {
    if (pct <= sorted[i].p) {
      const a = sorted[i - 1], b = sorted[i];
      const t = (pct - a.p) / Math.max(1, b.p - a.p);
      return a.value + (b.value - a.value) * t;
    }
  }
  return sorted[sorted.length - 1].value;
}

function rawPercentile(points: PercentilePoint[], value: number): number {
  const sorted = [...points].sort((a, b) => a.value - b.value);
  if (value <= sorted[0].value) return sorted[0].p;
  for (let i = 1; i < sorted.length; i++) {
    if (value <= sorted[i].value) {
      const a = sorted[i - 1], b = sorted[i];
      const t = (value - a.value) / Math.max(1e-9, b.value - a.value);
      return a.p + (b.p - a.p) * t;
    }
  }
  return sorted[sorted.length - 1].p;
}

// The next motivational rung for an orientation curve: how much improvement reaches
// the next percentile tier (the top half / quartile / 10%) for THIS age band, and the
// younger equivalent-age it unlocks. This is the "where to head" line — a target the
// athlete is heading toward, never a gate. Returns null when already near the top.
const STANDING_RUNGS: { pct: number; label: string }[] = [
  { pct: 50, label: "the top half" },
  { pct: 75, label: "the top quartile" },
  { pct: 90, label: "the top 10%" },
];
export interface WhereToHead {
  target_pct: number;
  target_value: number;
  delta: number; // improvement needed in the curve's own unit (always > 0)
  direction: "up" | "down"; // raise the number, or lower it
  label: string; // the rung being aimed at
  equivalent_age: number; // the age that value reads like
}
export function whereToHead(curve: ReferenceCurve, value: number, sex: Sex, age: number, currentPct: number): WhereToHead | null {
  const band = decade(age);
  const points = curve.bands[sex][band] ?? curve.bands[sex][40];
  // The first rung meaningfully above where you sit (≥3 percentile points of headroom).
  const rung = STANDING_RUNGS.find((r) => r.pct >= Math.round(currentPct) + 3);
  if (!rung) return null; // already at/near the top of the band — affirm, don't chase
  // Percentile is direction-normalized (higher = better); for a "lower is better" curve
  // the raw value-rank we need is the mirror.
  const rawTarget = curve.direction === "lower" ? 100 - rung.pct : rung.pct;
  const targetValue = valueAt(points, rawTarget);
  const delta = curve.direction === "lower" ? value - targetValue : targetValue - value;
  if (!(delta > 0.05)) return null;
  return {
    target_pct: rung.pct,
    target_value: Math.round(targetValue * 10) / 10,
    delta: Math.round(delta * 10) / 10,
    direction: curve.direction === "lower" ? "down" : "up",
    label: rung.label,
    equivalent_age: equivalentAge(curve, targetValue, sex),
  };
}

export function compareCurve(curve: ReferenceCurve, value: number, sex: Sex, age: number, referenceAge: number) {
  const actualBand = decade(age);
  const refBand = decade(referenceAge);
  const actualPoints = curve.bands[sex][actualBand] ?? curve.bands[sex][40];
  const refPoints = curve.bands[sex][refBand] ?? curve.bands[sex][20];
  const actualRaw = rawPercentile(actualPoints, value);
  const refRaw = rawPercentile(refPoints, value);
  const actualPct = curve.direction === "lower" ? 100 - actualRaw : actualRaw;
  const refPct = curve.direction === "lower" ? 100 - refRaw : refRaw;
  const median = valueAt(actualPoints, 50);
  const refMedian = valueAt(refPoints, 50);
  const equivalent = equivalentAge(curve, value, sex);
  return {
    key: curve.key,
    label: curve.label,
    value: Math.round(value * 10) / 10,
    unit: curve.unit,
    percentile: Math.round(actualPct),
    reference_percentile: Math.round(refPct),
    actual_age_band: `${actualBand}s`,
    reference_age_band: `${refBand}s`,
    median: Math.round(median * 10) / 10,
    reference_median: Math.round(refMedian * 10) / 10,
    equivalent_age: equivalent,
    direction: curve.direction,
    // The plain-language read ("fitter than 72% of men your age") + where-to-head target.
    verb: curve.compare_verb ?? "ahead of",
    next: whereToHead(curve, value, sex, age, actualPct),
    source: curve.source,
  };
}

function equivalentAge(curve: ReferenceCurve, value: number, sex: Sex): number {
  for (const band of REF_AGES) {
    const pts = curve.bands[sex][band];
    if (!pts) continue;
    const med = valueAt(pts, 50);
    if (curve.direction === "higher" ? value >= med : value <= med) return band + 5;
  }
  return 75;
}

function latestNumber(marker: any): number | null {
  const n = Number(marker?.latest?.value);
  return Number.isFinite(n) ? n : null;
}

function plausibleNumber(value: any, min: number, max: number): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function findMarker(markers: any[], re: RegExp): any | null {
  return markers.find((m) => re.test(String(m?.name ?? "")) || re.test(String(m?.key ?? ""))) ?? null;
}

export function bandForPercentile(p: number | null | undefined): Tone {
  if (p == null || !Number.isFinite(Number(p))) return "missing";
  return p >= 75 ? "strong" : p >= 50 ? "steady" : "watch";
}

function labAge(markers: any[], age: number): { equivalent: number | null; out: any[]; inCount: number } {
  const focus = markers.filter((m) => /apob|ldl|non-hdl|triglyceride|hdl|hba1c|glucose|insulin|alt|ast|ggt|uric|vitamin d|ferritin|lp\(a\)|lipoprotein/i.test(`${m?.name ?? ""} ${m?.key ?? ""}`));
  if (!focus.length) return { equivalent: null, out: [], inCount: 0 };
  const out = focus.filter((m) => m.in_optimal === false || m.latest?.flag === "high" || m.latest?.flag === "low").slice(0, 5);
  const inCount = focus.filter((m) => m.in_optimal === true || m.latest?.flag === "normal").length;
  const equivalent = out.length === 0 ? Math.max(20, age - 8) : out.length <= 2 ? age : age + Math.min(10, out.length * 2);
  return { equivalent, out, inCount };
}

function activityRead(age: number) {
  let stats: any = null;
  try { stats = getWeeklyStats(); } catch { stats = null; }
  const activeDays = Number(stats?.week_sessions ?? 0) + Number(stats?.week_cardio ?? 0);
  const km = Number(stats?.week_cardio_km ?? 0);
  const sets = Number(stats?.week_sets ?? 0);
  const strong = activeDays >= 4 || sets >= 24 || km >= 25;
  const steady = activeDays >= 2 || sets >= 10 || km >= 10;
  return {
    stats,
    tone: strong ? "strong" : steady ? "steady" : activeDays > 0 ? "watch" : "missing",
    equivalent: strong ? Math.max(20, age - 7) : steady ? Math.max(25, age - 3) : null,
    text: strong ? "training rhythm is a real asset" : steady ? "consistent enough to build from" : activeDays > 0 ? "some movement, but the week is light" : "not enough recent training data",
  };
}

function weightedAge(inputs: { age: number | null; weight: number }[], fallback: number): number | null {
  const usable = inputs.filter((x) => x.age != null && Number.isFinite(Number(x.age)) && x.weight > 0);
  if (!usable.length) return null;
  const total = usable.reduce((s, x) => s + x.weight, 0);
  const avg = usable.reduce((s, x) => s + Number(x.age) * x.weight, 0) / total;
  return Math.max(20, Math.min(fallback + 18, Math.round(avg)));
}

// ---- live body composition ---------------------------------------------------
// A DEXA is a precise snapshot, but it ages: as weight comes off with strength work
// holding lean mass, today's body fat is LOWER than the scan says. We anchor fat-free
// mass to the DEXA (measured lean + bone) and project it onto the current weight — so
// the read shows PROGRESS, clearly labeled as an estimate, instead of freezing a stale
// number that reads "age 75" while the athlete is actively leaning out.
// ---- regional DEXA read ------------------------------------------------------
// A modern DEXA reports far more than one body-fat number: regional fat % and lean
// mass (trunk / arms / legs), visceral fat, ALMI/FFMI, and bone density by region with
// T/Z-scores. This reads that detail into plain-language, tone-tagged notes so the
// standing read USES the whole scan — and so the coach can target the right work (where
// fat sits, where lean is light, how bone is loading). Informational, never a grade.
function dexaRegional(markers: any[]) {
  const num = (re: RegExp, min: number, max: number) => plausibleNumber(latestNumber(findMarker(markers, re)), min, max);
  const visceral_fat_lbs = num(/visceral fat/i, 0, 25);
  const almi = num(/\balmi\b|appendicular lean mass index/i, 3, 20);
  const ffmi = num(/\bffmi\b|fat[\s-]?free mass index/i, 10, 40);
  const bmd_total = num(/bmd[\s-]*total body|total body bmd/i, 0.4, 2.5);
  const t_score = plausibleNumber(latestNumber(findMarker(markers, /^t[\s-]?score\b/i)), -6, 6);
  const z_score = plausibleNumber(latestNumber(findMarker(markers, /^z[\s-]?score\b/i)), -6, 6);
  const android_gynoid = num(/android\/gynoid|a\/g ratio/i, 0.3, 2.5);
  const fat = {
    trunk: num(/body fat[\s-]*trunk/i, 3, 70),
    arms: num(/body fat[\s-]*arms/i, 3, 70),
    legs: num(/body fat[\s-]*legs/i, 3, 70),
  };
  const lean = {
    trunk: num(/lean mass[\s-]*trunk/i, 5, 160),
    arms: num(/lean mass[\s-]*arms/i, 2, 90),
    legs: num(/lean mass[\s-]*legs/i, 5, 160),
  };
  const present = [visceral_fat_lbs, almi, ffmi, bmd_total, t_score, z_score, android_gynoid, fat.trunk, lean.legs].some((x) => x != null);
  if (!present) return null;

  const fmt = (n: number) => (Math.round(n * 10) / 10).toString();
  const notes: { kind: string; tone: Tone; text: string }[] = [];
  if (visceral_fat_lbs != null) {
    notes.push({
      kind: "visceral",
      tone: visceral_fat_lbs <= 2 ? "strong" : visceral_fat_lbs <= 4 ? "steady" : "watch",
      text: visceral_fat_lbs <= 2
        ? `Visceral fat is low (${fmt(visceral_fat_lbs)} lb) — the metabolically risky kind is well controlled.`
        : `Visceral fat ${fmt(visceral_fat_lbs)} lb — the metabolic kind; zone-2 cardio and a modest deficit move it first.`,
    });
  }
  if (t_score != null) {
    notes.push({
      kind: "bone",
      tone: t_score >= -1 ? "strong" : t_score >= -2.5 ? "steady" : "watch",
      text: t_score >= 1
        ? `Bone density is above average (T-score +${fmt(t_score)}) — heavy loading is paying off; keep lifting and add impact.`
        : t_score >= -1
          ? `Bone density is healthy (T-score ${t_score >= 0 ? "+" : ""}${fmt(t_score)}) — progressive lifting holds it there.`
          : `Bone density is below average (T-score ${fmt(t_score)}) — loaded carries, impact and progressive lifting protect it.`,
    });
  }
  if (almi != null) {
    notes.push({
      kind: "lean",
      tone: almi >= 8 ? "strong" : almi >= 7 ? "steady" : "watch",
      text: almi >= 7.5
        ? `Lean-mass index is healthy (ALMI ${fmt(almi)}) — comfortably above the age-related loss line.`
        : `Lean-mass index ALMI ${fmt(almi)} — protein at ~0.8 g/lb and progressive lifting build the buffer.`,
    });
  }
  if (fat.trunk != null && fat.arms != null && fat.legs != null) {
    const top = Math.max(fat.trunk, fat.arms, fat.legs);
    if (top === fat.trunk && fat.trunk - Math.min(fat.arms, fat.legs) >= 2) {
      notes.push({
        kind: "distribution",
        tone: "steady",
        text: `Fat sits in the trunk (${fmt(fat.trunk)}% vs ${fmt(fat.legs)}% legs, ${fmt(fat.arms)}% arms) — the metabolic pattern, and the first to move with a cut and zone-2 work.`,
      });
    }
  }
  return { visceral_fat_lbs, almi, ffmi, bmd_total, t_score, z_score, android_gynoid, fat, lean, notes };
}

function bodyComposition(markers: any[], currentWeightLb: number | null, nowISO: string) {
  const bfMarker = findMarker(markers, /^body fat\b|body fat %|fat percentage/i);
  const measuredBf = plausibleNumber(latestNumber(bfMarker), 3, 70);
  if (measuredBf == null) return null;
  const dexaDate = bfMarker?.latest?.date ?? null;
  const leanTotal = plausibleNumber(latestNumber(findMarker(markers, /lean mass \(total\)|^lean mass total/i)), 40, 400);
  const bmc = plausibleNumber(latestNumber(findMarker(markers, /bone mineral content|\bbmc\b/i)), 1, 20);
  const fatTotal = plausibleNumber(latestNumber(findMarker(markers, /fat mass \(total\)|^fat mass total/i)), 5, 300);
  const totalMass = plausibleNumber(latestNumber(findMarker(markers, /^total mass\b/i)), 60, 500);
  const trunkFatPct = plausibleNumber(latestNumber(findMarker(markers, /body fat - trunk|trunk body fat/i)), 3, 70);

  const scanWeight = totalMass ?? currentWeightLb ?? null;
  // Fat-free mass measured at the scan: lean + bone, else derived from BF% × scan weight.
  let ffm: number | null = null;
  if (leanTotal != null) ffm = leanTotal + (bmc ?? 0);
  else if (scanWeight != null) ffm = scanWeight * (1 - measuredBf / 100);
  const dexaFatMass = fatTotal ?? (scanWeight != null ? scanWeight * (measuredBf / 100) : null);

  const w = currentWeightLb;
  let estimated: { value: number; as_of: string } | null = null;
  let fat_mass: { dexa: number | null; est_now: number | null; delta_lbs: number | null } | null = null;
  // Only project when we have a measured anchor AND the weight has actually moved since
  // the scan — otherwise the estimate is just the measured value restated.
  const weightMoved = ffm != null && w != null && (scanWeight == null || Math.abs(w - scanWeight) >= 1);
  if (ffm != null && w != null && w > ffm && weightMoved) {
    const estFat = w - ffm;
    const estBf = Math.max(3, Math.min(70, (estFat / w) * 100));
    estimated = { value: Math.round(estBf * 10) / 10, as_of: nowISO };
    fat_mass = {
      dexa: dexaFatMass != null ? Math.round(dexaFatMass * 10) / 10 : null,
      est_now: Math.round(estFat * 10) / 10,
      delta_lbs: dexaFatMass != null ? Math.round((estFat - dexaFatMass) * 10) / 10 : null,
    };
  }

  const deltaBf = estimated ? estimated.value - measuredBf : 0;
  const trend = !estimated ? null : deltaBf <= -0.4 ? "falling" : deltaBf >= 0.4 ? "rising" : "steady";
  const lost = fat_mass?.delta_lbs != null && fat_mass.delta_lbs < 0 ? Math.abs(fat_mass.delta_lbs) : null;
  const note = estimated
    ? lost != null && lost >= 1
      ? "Estimated from your DEXA lean mass held steady as the weight comes off — early loss carries some water, but the direction is real."
      : "Estimated from your DEXA, projected onto your current weight."
    : "From your latest DEXA.";

  return {
    measured: { value: measuredBf, date: dexaDate },
    estimated,
    fat_mass,
    trunk_fat_pct: trunkFatPct,
    weight: { current: w, at_scan: scanWeight },
    trend,
    note,
    // The regional DEXA detail — visceral fat, ALMI/FFMI, bone density, and where fat &
    // lean sit — so the whole scan is read, not just one body-fat number.
    regional: dexaRegional(markers),
    // the value the rest of the read should USE: live when we can project, else measured.
    effective: estimated ? estimated.value : measuredBf,
  };
}

// The lab-measured biological age, when a panel reports one (Function Health et al.).
// Labs encode it as an absolute age OR a +/- delta in years; small magnitude ⇒ a delta.
function bioAge(markers: any[], calendarAge: number | null) {
  const m = findMarker(markers, /biological age|\bbio age\b/i);
  const raw = Number(m?.latest?.value);
  if (!m || !Number.isFinite(raw)) return null;
  let value: number;
  let delta: number | null = null;
  // A negative or small-magnitude number is a +/- delta in years ("younger 7.4"); a larger
  // positive number is an absolute biological age. The |raw|<10 floor guards a young athlete
  // whose absolute bio-age (e.g. 23) would otherwise be misread as a +23-year delta.
  if (calendarAge != null && (raw < 0 || Math.abs(raw) < 10)) { delta = raw; value = calendarAge + raw; }
  else { value = raw; delta = calendarAge != null ? raw - calendarAge : null; }
  value = Math.max(18, Math.min(100, Math.round(value)));
  return { value, delta: delta != null ? Math.round(delta * 10) / 10 : null, source: m?.latest?.kind || "lab", date: m?.latest?.date ?? null };
}

// The single highest-leverage move — reuses the connected brain's one voice
// (`healthFocus().lead`), so Standing points at the SAME priority as everywhere else.
function leadLever() {
  let focus: any = null;
  try { focus = healthFocus(); } catch { focus = null; }
  const lead = focus?.lead;
  if (!lead) return null;
  const move = (lead.moves && (lead.moves.nutrition || lead.moves.training || lead.moves.watch)) || null;
  const marker = Array.isArray(lead.markers) && lead.markers.length ? lead.markers[0] : null;
  return {
    headline: focus.headline || `${lead.group} is the priority right now.`,
    group: lead.group,
    why: lead.why,
    move,
    markers: lead.markers || [],
    marker, // deep-link target for the Markers tab
    tier: lead.tier,
    uncertain: !!lead.uncertain,
  };
}

function goalModeOf(stats: any, profile: any): string {
  if (stats?.goal_mode) return String(stats.goal_mode);
  const gw = Number(profile?.goal_weight_lb);
  const w = Number(profile?.weight_lb);
  if (Number.isFinite(gw) && Number.isFinite(w)) return gw < w - 1 ? "lose" : gw > w + 1 ? "gain" : "maintain";
  return "maintain";
}

// The "this quarter" momentum — the wins in motion, framed as progress, never a score.
// Exported so the Today salience arbiter can decide (pull, ranked) whether a momentum
// card is worth a glance without recomputing the whole standing read.
export function standingMomentum(opts: { markers?: any[]; profile?: any } = {}) {
  const profile = opts.profile ?? getProfile() ?? {};
  const markers = opts.markers ?? (() => { try { return (prioritizeMarkers() as any).markers || []; } catch { return []; } })();
  const weights = (() => { try { return listWeight(60); } catch { return []; } })();
  const lastW = weights.length ? Number(weights[weights.length - 1]?.weight_lb) : Number.NaN;
  const currentWeight = Number.isFinite(lastW) ? lastW : plausibleNumber(profile.weight_lb, 60, 600);
  const stats = (() => { try { return getWeeklyStats(); } catch { return null; } })() as any;
  const comp = bodyComposition(markers, currentWeight, new Date().toISOString());
  const bp = bpRead((() => { try { return listBloodPressureReadings(12); } catch { return []; } })());

  const chips: { kind: string; text: string; dir: string }[] = [];
  if (comp?.fat_mass?.delta_lbs != null && comp.fat_mass.delta_lbs <= -1) {
    chips.push({ kind: "fat", text: `~${Math.abs(Math.round(comp.fat_mass.delta_lbs))} lb of fat off since your DEXA`, dir: "good" });
  }
  const trend = stats ? Number(stats.trend_lb_wk) : Number.NaN;
  const goalMode = goalModeOf(stats, profile);
  if (Number.isFinite(trend)) {
    if (goalMode !== "gain" && trend < -0.2) chips.push({ kind: "weight", text: `down ${Math.abs(Math.round(trend * 10) / 10)} lb/wk`, dir: "good" });
    else if (goalMode === "gain" && trend > 0.1) chips.push({ kind: "weight", text: `building ${Math.round(trend * 10) / 10} lb/wk`, dir: "good" });
  }
  if (bp.trajectory?.dir === "improving") {
    chips.push({ kind: "bp", text: `BP ${bp.trajectory.from.systolic}→${bp.trajectory.to.systolic}`, dir: "good" });
  }
  const has_momentum = chips.some((c) => c.dir === "good");
  return { has_momentum, chips, summary: chips.filter((c) => c.dir === "good").map((c) => c.text).join(" · "), body_comp: comp, bp, current_weight: currentWeight };
}

// A calm, holistic permission line. Health is the long game; the occasional night out,
// a weekend with the kids, a meal off-plan — that's emotional and social well-being, and
// it's PART of doing this well. Never a nag, never a number.
function balanceNote(stats: any, hasMomentum: boolean): string {
  const pace = stats?.pace_status;
  if (hasMomentum && pace === "fast") return "You're a little ahead of pace — that's earned slack. A dinner out or an easy weekend with the kids won't move the trend; enjoy them.";
  if (hasMomentum) return "Weeks this consistent are exactly what let you say yes to the night out without it costing you. Aim for the trend, not perfection — and live the rest of your life.";
  return "This works best woven around a real life — family, friends, the occasional off-plan night. Aim for the direction of travel, not a perfect week.";
}

export function healthStanding(opts: { referenceAge?: number } = {}) {
  const profile = getProfile() ?? {};
  const age = Number.isFinite(Number(profile.age)) ? Number(profile.age) : null;
  const sex = sexOf(profile);
  const actualAge = age ?? 40;
  const referenceAge = Math.max(20, Math.min(70, decade(opts.referenceAge ?? 20)));
  const { markers } = prioritizeMarkers() as any;
  const recovery = (() => { try { return getRecoverySummary(30); } catch { return null; } })() as any;
  const rec = recovery?.recovery ?? {};
  const bpRows = listBloodPressureReadings(12);
  const bpInterp = bpRead(bpRows);
  const nowISO = new Date().toISOString();
  const stats = (() => { try { return getWeeklyStats(); } catch { return null; } })() as any;
  const weights = (() => { try { return listWeight(60); } catch { return []; } })();
  const lastW = weights.length ? Number(weights[weights.length - 1]?.weight_lb) : Number.NaN;
  const currentWeight = Number.isFinite(lastW) ? lastW : plausibleNumber(profile.weight_lb, 60, 600);

  const vo2Marker = findMarker(markers, /\bvo2\s?max|vo₂max/i);
  const vo2 = plausibleNumber(latestNumber(vo2Marker), 10, 100) ?? plausibleNumber(rec.vo2max, 10, 100);
  // Live body composition — the DEXA anchor projected onto current weight (progress, not a stale snapshot).
  const bodyComp = bodyComposition(markers, currentWeight ?? null, nowISO);
  const bodyFat = bodyComp ? bodyComp.effective : plausibleNumber(rec.body_fat_pct, 3, 70);
  const bioAgeInfo = bioAge(markers, age);
  const rhrMarker = findMarker(markers, /resting hr|resting heart/i);
  const rhr = plausibleNumber(latestNumber(rhrMarker), 25, 120) ?? plausibleNumber(rec.avg_resting_hr, 25, 120);
  const hrvMarker = findMarker(markers, /\bhrv\b|heart rate variability/i);
  const hrv = plausibleNumber(latestNumber(hrvMarker), 5, 300) ?? plausibleNumber(rec.avg_hrv_ms, 5, 300);

  const comparisons: any[] = [];
  const ageInputs: { age: number | null; weight: number }[] = [];
  if (vo2 != null) {
    const c = compareCurve(VO2_CURVE, vo2, sex, actualAge, referenceAge) as any;
    // Provenance: VO2max is most often a Garmin estimate (only refreshed on hard runs),
    // so naming the source + recency lets the athlete weigh how current it is.
    const vo2FromMarker = plausibleNumber(latestNumber(vo2Marker), 10, 100) != null;
    const vo2Kind = String(vo2Marker?.latest?.kind ?? "").toLowerCase();
    c.reading = vo2FromMarker
      ? { source: /garmin|watch|wearable/.test(vo2Kind) ? "Garmin estimate" : vo2Kind === "lab" || vo2Kind === "" ? "lab measure" : vo2Marker.latest.kind, date: vo2Marker?.latest?.date ?? null }
      : { source: "Garmin estimate", date: null };
    comparisons.push(c);
    ageInputs.push({ age: c.equivalent_age, weight: 1.4 });
  }
  if (bodyFat != null) {
    const c = compareCurve(BODY_FAT_CURVE, bodyFat, sex, actualAge, referenceAge) as any;
    if (bodyComp?.estimated) { c.estimated = true; c.measured_value = bodyComp.measured.value; c.as_of = bodyComp.estimated.as_of; }
    c.reading = { source: "DEXA", date: bodyComp?.measured?.date ?? null };
    comparisons.push(c);
    // Body comp is a lever that's MOVING, not an age anchor — lighter weight, so it never
    // alone drags the read old while the athlete is actively leaning out.
    ageInputs.push({ age: c.equivalent_age, weight: 0.6 });
  }
  // The lab's own measured biological age is a heavy, direct anchor when present.
  if (bioAgeInfo) ageInputs.push({ age: bioAgeInfo.value, weight: 1.6 });
  // BP age from the interpreted home readings (markers rarely carry BP).
  const bpAge = bpInterp.category === "optimal" ? 30 : bpInterp.category === "elevated" ? 42 : bpInterp.category === "high" ? actualAge + 4 : bpInterp.category === "low" ? actualAge : null;
  if (bpAge != null) ageInputs.push({ age: bpAge, weight: 1.0 });
  const labs = labAge(markers, actualAge);
  if (labs.equivalent != null) ageInputs.push({ age: labs.equivalent, weight: 1.2 });
  const activity = activityRead(actualAge);
  if (activity.equivalent != null) ageInputs.push({ age: activity.equivalent, weight: 0.9 });

  const signalAge = age != null ? weightedAge(ageInputs, age) : null;

  // The HERO: lead with the lab's measured biological age when present (the athlete's own
  // number), else Cairn's composite — framed by DIRECTION, the motivational truth. No two
  // contradicting "ages" in the same read.
  const heroBioAge = bioAgeInfo?.value ?? signalAge;
  const heroSource = bioAgeInfo ? "lab" : "estimate";
  const direction = heroBioAge == null || age == null
    ? "unknown"
    : heroBioAge < actualAge - 2 ? "younger"
      : heroBioAge > actualAge + 2 ? "older" : "aligned";
  const heroHeadline = direction === "younger"
    ? "You're trending younger."
    : direction === "older"
      ? "A few movable signals are aging the picture up — and they're the movable kind."
      : heroBioAge == null
        ? "Add a few anchor signals and Cairn can build your standing read."
        : "You're right in line with your age — and the levers to tilt it younger are clear.";
  const headline = heroHeadline;

  // The "this quarter" momentum (wins in motion) and the single highest-leverage lever.
  const momentumRead = standingMomentum({ markers, profile });
  const vo2Comp = comparisons.find((c) => c.key === "vo2max");
  if (vo2Comp && Number(vo2Comp.percentile) >= 60) {
    momentumRead.chips.push({ kind: "vo2", text: `VO2max strong for your ${vo2Comp.actual_age_band}`, dir: "good" });
  }
  const hasMomentum = momentumRead.chips.some((c) => c.dir === "good");
  const lever = leadLever();
  const balance = balanceNote(stats, hasMomentum);

  const dimensions = [
    {
      id: "cardio",
      label: "Cardio fitness",
      tone: vo2 == null ? "missing" : bandForPercentile(comparisons.find((c) => c.key === "vo2max")?.percentile),
      headline: vo2 == null ? "No VO2max yet" : `VO2max ${Math.round(vo2)} ${VO2_CURVE.unit}`,
      body: vo2 == null ? "Garmin or a lab test can fill this in." : "This is one of the strongest longevity levers, so it gets real weight in the standing read.",
      measures: [
        vo2 != null ? { label: "VO2max", value: Math.round(vo2), unit: VO2_CURVE.unit } : null,
        rhr != null ? { label: "Resting HR", value: Math.round(rhr), unit: "bpm" } : null,
        hrv != null ? { label: "HRV", value: Math.round(hrv), unit: "ms" } : null,
      ].filter(Boolean),
    },
    {
      id: "bp",
      label: "Blood pressure",
      tone: bpInterp.latest ? bpInterp.tone : "missing",
      headline: bpInterp.latest ? `${Math.round(Number(bpInterp.latest.systolic))}/${Math.round(Number(bpInterp.latest.diastolic))} mmHg` : "No BP trend yet",
      body: bpInterp.latest ? bpInterp.read : "Log a couple of resting home readings and Cairn can read the pattern.",
      measures: [
        bpInterp.latest ? { label: "Systolic", value: Math.round(Number(bpInterp.latest.systolic)), unit: "mmHg" } : null,
        bpInterp.latest ? { label: "Diastolic", value: Math.round(Number(bpInterp.latest.diastolic)), unit: "mmHg" } : null,
      ].filter(Boolean),
    },
    {
      id: "labs",
      label: "Bloodwork",
      tone: labs.equivalent == null ? "missing" : labs.out.length ? "watch" : "strong",
      headline: labs.equivalent == null ? "No lab anchors yet" : labs.out.length ? `${labs.out.length} marker${labs.out.length === 1 ? "" : "s"} to tighten` : "Key labs look well placed",
      body: labs.out.length ? `Lead watch item: ${labs.out[0]?.name ?? "marker"}.` : labs.equivalent == null ? "Upload bloodwork to connect metabolic, lipid, hormone and inflammation signals." : `${labs.inCount} key marker${labs.inCount === 1 ? "" : "s"} are in range or optimal.`,
      measures: labs.out.slice(0, 3).map((m) => ({ label: m.name, value: m.latest?.value, unit: m.unit ?? "" })),
    },
    {
      id: "body",
      label: "Body composition",
      tone: bodyFat == null ? "missing" : bandForPercentile(comparisons.find((c) => c.key === "body_fat_pct")?.percentile),
      headline: bodyFat == null ? "No DEXA/body-fat anchor yet"
        : bodyComp?.estimated ? `~${bodyComp.estimated.value}% body fat · est. now`
          : `${Math.round(bodyFat * 10) / 10}% body fat`,
      body: bodyComp?.estimated && bodyComp.fat_mass?.delta_lbs != null && bodyComp.fat_mass.delta_lbs < 0
        ? `Down from ${bodyComp.measured.value}% at your DEXA — roughly ${Math.abs(Math.round(bodyComp.fat_mass.delta_lbs))} lb of fat off. ${bodyComp.note}`
        : bodyFat == null ? "A DEXA or compatible scale makes this comparison much sharper."
          : "Body composition is a lever — it moves BP, glucose, lipids and hormones together.",
      measures: bodyFat != null ? [
        { label: bodyComp?.estimated ? "Body fat · est." : "Body fat", value: Math.round(bodyFat * 10) / 10, unit: "%" },
        bodyComp?.estimated ? { label: "At DEXA", value: bodyComp.measured.value, unit: "%" } : null,
      ].filter(Boolean) : [],
    },
    {
      id: "activity",
      label: "Activity & achievements",
      tone: activity.tone,
      headline: activity.text,
      body: "This reads logged lifting, cardio, Garmin activity and weekly rhythm as behavior evidence, not a streak.",
      measures: [
        { label: "Strength sets", value: activity.stats?.week_sets ?? 0, unit: "this week" },
        { label: "Cardio", value: activity.stats?.week_cardio_km ?? 0, unit: "km this week" },
        rec.avg_steps != null ? { label: "Steps", value: Math.round(Number(rec.avg_steps)), unit: "/day" } : null,
        rec.fitness_age != null ? { label: "Garmin fitness age", value: Math.round(Number(rec.fitness_age)), unit: "yr" } : null,
      ].filter(Boolean),
    },
  ];

  return {
    generated_at: new Date().toISOString(),
    subject: { age, sex, reference_age: referenceAge, reference_age_band: `${referenceAge}s` },
    headline,
    // The hero: one coherent age read (lab biological age preferred), framed by direction.
    hero: {
      calendar_age: age,
      biological_age: heroBioAge,
      biological_age_source: heroSource, // "lab" | "estimate"
      biological_age_delta: bioAgeInfo?.delta ?? (heroBioAge != null && age != null ? heroBioAge - age : null),
      direction, // "younger" | "older" | "aligned" | "unknown"
      headline: heroHeadline,
    },
    biological_age: bioAgeInfo, // the lab-measured value when a panel reports one, else null
    momentum: { has_momentum: hasMomentum, chips: momentumRead.chips, summary: momentumRead.chips.filter((c) => c.dir === "good").map((c) => c.text).join(" · ") },
    lead_lever: lever,
    body_comp: bodyComp,
    balance,
    signal_age: signalAge,
    signal_age_label: signalAge == null ? null : `${signalAge}`,
    confidence: ageInputs.length >= 5 ? "strong" : ageInputs.length >= 3 ? "observed" : "early",
    comparisons,
    dimensions,
    blood_pressure: {
      latest: bpInterp.latest,
      recent: bpRows,
      category: bpInterp.category,
      label: bpInterp.label,
      tone: bpInterp.tone,
      trajectory: bpInterp.trajectory,
      read: bpInterp.read,
      note: "BP is point-in-time; use repeated home readings to confirm a pattern.",
    },
    sources: [
      "Cairn marker history and optimal-zone model",
      "Garmin / daily metrics when present",
      "Home BP readings when logged",
      "FRIEND VO2max age/sex reference standards",
      "NHANES DXA body-composition orientation bands",
    ],
  };
}
