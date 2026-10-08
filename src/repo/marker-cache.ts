// In-process invalidation signal for the getMarkerHistory memo (see repo/health.ts).
// It lives in its own leaf module so EVERY table whose contents feed getMarkerHistory
// — health_documents, blood_pressure_readings, and marker_aliases (the learned
// canonicalization) — can bump the same counter without a circular import between
// health.ts (the memo + doc/BP writes) and marker-canon.ts (the alias writes).
//
// getMarkerHistory memoizes its heavy per-marker walk on a signature that folds this
// counter (the fast, exact invalidation) together with a cheap SQL backstop. Bumped by
// every marker-data write path; test/_isolate.mjs wipes tables out-of-band (bypassing
// these paths) and rowids can collide across a wipe, so it calls resetMarkerHistoryCache()
// (health.ts), which moves this counter on too. The Automatic lab-unit verdict
// (lab-reported-system.ts) is cached on it alone.
let markerDataVersion = 0;

export function bumpMarkerDataVersion(): void {
  markerDataVersion++;
}

export function currentMarkerDataVersion(): number {
  return markerDataVersion;
}

// After an out-of-band wipe every cache keyed on the version must miss, so a reset moves
// the version FORWARD — back to 0 it could land on a value a pre-wipe cache still holds.
export function resetMarkerDataVersion(): void {
  markerDataVersion++;
}
