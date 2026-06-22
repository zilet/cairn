// The day_reads cache is keyed by the server's LOCAL calendar date (the PWA drives
// every read with its local date, and a home server shares the owner's timezone) —
// mirror dayread.localToday() here so getCoachContext reads the same row the Brief
// wrote. Defined locally to avoid a circular import (dayread.ts imports repo.ts).
export function localDateISO(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Pounds per kilogram — the single conversion constant (was duplicated in profile.ts
// and, less precisely as 2.2046, in enrich.ts's Garmin kg→lb path).
export const LB_PER_KG = 2.2046226218;

// Round a load to the nearest 2.5 lb plate — the smallest realistic gym increment.
// Shared by the progression engine's step math and the Garmin kg→lb conversion.
export function round2_5(n: number): number {
  return Math.round(n / 2.5) * 2.5;
}
