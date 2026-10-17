// ONE fold of a run edit onto a day's stored runs.
//
// Two callers need identical merge semantics at two different moments. Chat BUILDS a
// run edit (src/chatTurns.ts) and the apply path RE-FOLDS it onto whatever the day
// actually holds when the proposal lands (src/repo/profile.ts) — which may be minutes
// or a scheduled boundary later. A snapshot taken at build time would silently
// overwrite a sibling run edited in between, so the payload carries the EDIT and this
// module is the single place that knows what an edit means.
//
// Deliberately dependency-free: the repo layer imports it, so anything it pulled in
// would risk an import cycle back through the barrel.

/** A run prescription in the shape the plan stores it (one `kind:'cardio'` row). */
export interface StoredRun {
  label: string;
  target_distance_km: number | null;
  target_duration_min: number | null;
  target_zone: string | null;
  interval: unknown;
}

/**
 * ONE requested change to ONE run, already resolved to what would be stored: the zone
 * rendered to the athlete's own band (never a population formula's), the kind kept as
 * the word used to FIND the run. This is what travels inside a marked cardio payload
 * entry, so the apply path can re-fold it against the current rows.
 */
export interface RunEditPatch {
  kind: string | null;
  label: string | null;
  match_label: string | null;
  distance_km: number | null;
  duration_min: number | null;
  zone_tag: string | null;
}

export const RUN_KIND_LABELS: Record<string, string> = {
  easy: "Easy run",
  quality: "Quality run",
  long: "Long run",
};

/** A prescription number is a positive quantity or nothing — 0 and junk are absence. */
export function runNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function runLabelKey(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
