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

Object.assign(globalThis, {
  foodNum,
  formatFoodNum,
  fmtWeight,
  parseDur,
  fmtDur,
  fmtPaceKm,
  fmtKm,
  fmtSpeedKmh,
  prDistLabel,
});
