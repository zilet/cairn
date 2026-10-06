// @ts-check
// Run-only display helpers (min/km pace, riders' km/h, the PR distance label), kept out of
// the eager shell: only the Program's endurance read uses them (LAZY, "train" bundle).
// Distances and paces in the athlete's units are CairnFmt's (ui-format.ts).
{
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

Object.assign(globalThis, { fmtPaceKm, fmtSpeedKmh, prDistLabel });
}
