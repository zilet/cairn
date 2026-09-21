// @ts-check
// Shared display-format helpers for the vanilla PWA.

function foodNum(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatFoodNum(value: unknown): string {
  const n = foodNum(value);
  if (n === null) return "";
  return Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1);
}

function fmtWeight(weight: unknown): string {
  if (weight === null || weight === undefined) return "BW";
  const n = Number(weight);
  return Number.isFinite(n) && n < 0 ? `${-n} assist` : `${weight}`;
}

// ---------- duration helpers (timed exercises) ----------
// "90" -> 90, "1:30" -> 90, "2m" -> 120, "45s" -> 45. null on garbage.
function parseDur(text: unknown): number | null {
  const s = String(text || "").trim().toLowerCase();
  if (!s) return null;
  let m = s.match(/^(\d+):([0-5]?\d)$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = s.match(/^(\d+(?:\.\d+)?)\s*m(?:in)?$/);
  if (m) return Math.round(Number(m[1]) * 60);
  m = s.match(/^(\d+)\s*s(?:ec)?$/);
  if (m) return Number(m[1]);
  m = s.match(/^(\d+)$/);
  if (m) return Number(m[1]);
  return null;
}

// 90 -> "1:30", 45 -> "0:45"
function fmtDur(sec: unknown): string {
  const v = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
}

// ---------- endurance formatting (min/km pace, distance, plain-word trend) ----------
// All null-safe. Pace is min/km -> "m:ss/km". Never a score, never a grade.
function fmtPaceKm(minPerKm: unknown): string {
  const v = Number(minPerKm);
  if (!Number.isFinite(v) || v <= 0) return "—";
  const m = Math.floor(v);
  const s = Math.round((v - m) * 60);
  // 60s rounding carry
  const mm = s === 60 ? m + 1 : m;
  const ss = s === 60 ? 0 : s;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

function fmtKm(km: unknown): string {
  const v = Number(km);
  if (!Number.isFinite(v)) return "—";
  return Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toFixed(1);
}

// Athlete-facing run units. The engine stores km; the PWA converts for display.
const KM_PER_MILE = 1.609344;

function runUnits(value: unknown): "km" | "mi" {
  const s = String(value || "").trim().toLowerCase();
  return s === "mi" || s === "mile" || s === "miles" ? "mi" : "km";
}

function fmtRunUnitSuffix(units: unknown): string {
  return runUnits(units) === "mi" ? "/mi" : "/km";
}

function fmtDist(km: unknown, units?: unknown): string {
  const v = Number(km);
  if (!Number.isFinite(v)) return "—";
  const n = runUnits(units) === "mi" ? v / KM_PER_MILE : v;
  return runUnits(units) === "mi" ? `${fmtKm(n)} mi` : `${fmtKm(n)} km`;
}

function fmtPaceFromSecPerKm(secPerKm: unknown, units?: unknown): string {
  const sec = Number(secPerKm);
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const adj = runUnits(units) === "mi" ? sec * KM_PER_MILE : sec;
  const total = Math.round(adj);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtPaceBand(band: { slow_sec_per_km?: unknown; fast_sec_per_km?: unknown; text?: unknown } | null | undefined, units?: unknown): string {
  if (!band) return "";
  const fast = fmtPaceFromSecPerKm(band.fast_sec_per_km, units);
  const slow = fmtPaceFromSecPerKm(band.slow_sec_per_km, units);
  if (fast === "—" && slow === "—") return String(band.text || "");
  const suffix = fmtRunUnitSuffix(units);
  if (fast === slow || slow === "—") return `${fast} ${suffix}`;
  if (fast === "—") return `${slow} ${suffix}`;
  return `${fast}–${slow} ${suffix}`;
}

// Speed in km/h (the metric riders read, the counterpart to a runner's min/km).
// Null-safe, one decimal. Never a score.
function fmtSpeedKmh(kmh: unknown): string {
  const v = Number(kmh);
  if (!Number.isFinite(v) || v <= 0) return "—";
  return Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toFixed(1);
}

// Human label for a standard PR distance (1/5/10/half/full + anything else).
function prDistLabel(km: unknown): string {
  const v = Number(km);
  if (Math.abs(v - 21.0975) < 0.01) return "Half";
  if (Math.abs(v - 42.195) < 0.01) return "Full";
  return `${fmtKm(v)} km`;
}

// Join a list into natural, Oxford-comma prose: "a" / "a and b" / "a, b, and c".
// Client-side mirror of src/repo/shared.ts's joinList (the client shares one
// global scope, not modules, with the server — see CLAUDE.md).
function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

Object.assign(globalThis, {
  foodNum,
  formatFoodNum,
  fmtWeight,
  parseDur,
  fmtDur,
  fmtPaceKm,
  fmtKm,
  runUnits,
  fmtRunUnitSuffix,
  fmtDist,
  fmtPaceFromSecPerKm,
  fmtPaceBand,
  fmtSpeedKmh,
  prDistLabel,
  joinList,
});
