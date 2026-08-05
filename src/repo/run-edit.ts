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

/** The cardio rows of a plan day, read through the shape `getPlanDay` returns. */
export function storedRunsFromItems(items: readonly any[] | null | undefined): StoredRun[] {
  return (Array.isArray(items) ? items : [])
    .filter((item: any) => String(item?.kind ?? "") === "cardio")
    .map((item: any) => ({
      // A cardio row has no exercise_id; its label lives in the note column.
      label: String(item?.note ?? "").trim() || "Run",
      target_distance_km: runNumber(item?.target_distance_km),
      target_duration_min: runNumber(item?.target_duration_min),
      target_zone: item?.target_zone == null ? null : String(item.target_zone),
      interval: item?.interval ?? null,
    }));
}

/**
 * Which stored run this edit is about. Named label first, then the kind word, then
 * "the day has exactly one run". Returns -1 when the day has no run yet (the edit ADDS
 * one) and null when several runs could match — an ambiguous run edit is refused by the
 * caller rather than guessed at.
 */
export function resolveRunIndex(runs: readonly StoredRun[], patch: RunEditPatch): number | null {
  if (!runs.length) return -1;
  const wanted = runLabelKey(patch.match_label ?? patch.label);
  if (wanted) {
    const exact = runs.findIndex((run) => runLabelKey(run.label) === wanted);
    if (exact >= 0) return exact;
    const partial = runs.findIndex((run) => {
      const key = runLabelKey(run.label);
      return key.includes(wanted) || wanted.includes(key);
    });
    if (partial >= 0) return partial;
  }
  if (patch.kind) {
    const matches = runs
      .map((run, index) => ({ run, index }))
      .filter((entry) => runLabelKey(entry.run.label).includes(patch.kind as string));
    if (matches.length === 1) return matches[0].index;
  }
  if (runs.length === 1) return 0;
  return null;
}

export function mergeStoredRun(existing: StoredRun | null, patch: RunEditPatch): StoredRun {
  // Distance and duration are two ways to state the same dose, so a stated one
  // REPLACES the pair — an "8k" over a stored 45-minute run must never persist as
  // "8 km for 45 minutes". Zone and label carry forward when unstated.
  const statedDose = patch.distance_km != null || patch.duration_min != null;
  const zone = patch.zone_tag ?? existing?.target_zone ?? null;
  const label = patch.label?.trim() || existing?.label || (patch.kind ? RUN_KIND_LABELS[patch.kind] : null) || "Run";
  return {
    label: label.slice(0, 120),
    target_distance_km: statedDose ? patch.distance_km : (existing?.target_distance_km ?? null),
    target_duration_min: statedDose ? patch.duration_min : (existing?.target_duration_min ?? null),
    target_zone: zone,
    // Interval STRUCTURE describes a specific dose. Restating the dose or the zone
    // retires it; a label-only edit leaves the session's structure intact.
    interval: statedDose || patch.zone_tag ? null : (existing?.interval ?? null),
  };
}

/**
 * Read a run patch back off a cardio payload entry. Only an entry the builder MARKED
 * (`cardio_edit:true`) is an edit — every other `cardio[]` entry is a whole run the
 * writer should store as given, which is what keeps the Monday tick and the run-plan
 * proposal wholesale.
 */
export function runEditPatchFromPayload(entry: any): RunEditPatch | null {
  if (!entry || typeof entry !== "object" || entry.cardio_edit !== true) return null;
  const edit = entry.edit;
  const source =
    edit && typeof edit === "object" ? (edit as Record<string, unknown>) : (entry as Record<string, unknown>);
  const text = (value: unknown): string | null => {
    const s = typeof value === "string" ? value.trim() : "";
    return s ? s : null;
  };
  return {
    kind: text(source.kind === "cardio" ? null : source.kind),
    label: text(source.label),
    match_label: text(source.match_label ?? source.label),
    distance_km: runNumber(source.distance_km ?? source.target_distance_km),
    duration_min: runNumber(source.duration_min ?? source.target_duration_min),
    zone_tag: text(source.zone_tag ?? source.target_zone),
  };
}
