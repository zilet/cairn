// @ts-check
// Shared display-format helpers for the vanilla PWA.

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function foodNum(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatFoodNum(value) {
  const n = foodNum(value);
  if (n === null) return "";
  return Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1);
}

/**
 * @param {any} weight
 * @returns {string}
 */
function fmtWeight(weight) {
  if (weight === null || weight === undefined) return "BW";
  return weight < 0 ? `${-weight} assist` : `${weight}`;
}

// ---------- duration helpers (timed exercises) ----------
// "90" -> 90, "1:30" -> 90, "2m" -> 120, "45s" -> 45. null on garbage.
/**
 * @param {unknown} text
 * @returns {number | null}
 */
function parseDur(text) {
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
/**
 * @param {unknown} sec
 * @returns {string}
 */
function fmtDur(sec) {
  const v = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
}

// ---------- endurance formatting (min/km pace, distance, plain-word trend) ----------
// All null-safe. Pace is min/km -> "m:ss/km". Never a score, never a grade.
/**
 * @param {unknown} minPerKm
 * @returns {string}
 */
function fmtPaceKm(minPerKm) {
  const v = Number(minPerKm);
  if (!Number.isFinite(v) || v <= 0) return "—";
  const m = Math.floor(v);
  const s = Math.round((v - m) * 60);
  // 60s rounding carry
  const mm = s === 60 ? m + 1 : m;
  const ss = s === 60 ? 0 : s;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

/**
 * @param {unknown} km
 * @returns {string}
 */
function fmtKm(km) {
  const v = Number(km);
  if (!Number.isFinite(v)) return "—";
  return Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toFixed(1);
}

// Speed in km/h (the metric riders read, the counterpart to a runner's min/km).
// Null-safe, one decimal. Never a score.
/**
 * @param {unknown} kmh
 * @returns {string}
 */
function fmtSpeedKmh(kmh) {
  const v = Number(kmh);
  if (!Number.isFinite(v) || v <= 0) return "—";
  return Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toFixed(1);
}

// Human label for a standard PR distance (1/5/10/half/full + anything else).
/**
 * @param {unknown} km
 * @returns {string}
 */
function prDistLabel(km) {
  const v = Number(km);
  if (Math.abs(v - 21.0975) < 0.01) return "Half";
  if (Math.abs(v - 42.195) < 0.01) return "Full";
  return `${fmtKm(v)} km`;
}
