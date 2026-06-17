// The day_reads cache is keyed by the server's LOCAL calendar date (the PWA drives
// every read with its local date, and a home server shares the owner's timezone) —
// mirror dayread.localToday() here so getCoachContext reads the same row the Brief
// wrote. Defined locally to avoid a circular import (dayread.ts imports repo.ts).
export function localDateISO(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
