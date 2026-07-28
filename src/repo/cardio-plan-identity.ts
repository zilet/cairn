// Deterministic server-side identity for stored cardio prescriptions.
//
// Cardio rows deliberately keep exercise_id NULL and preserve athlete-facing
// coaching detail in `note`. That means server safety code cannot treat the raw
// note as a canonical movement name. These rules mirror the client cardio-plan
// helpers: sport cues may come from exercise/note/interval text, descriptive
// notes derive a short label from zone/interval semantics, and an otherwise
// unspecified planned-cardio modality deliberately defaults to running.

export type CardioPlanSport = "run" | "ride" | "swim" | "row" | "hike";

export interface CardioPlanIdentityInput {
  exercise?: unknown;
  note?: unknown;
  interval?: unknown;
  interval_note?: unknown;
  target_distance_km?: unknown;
  target_zone?: unknown;
}

export interface CardioPlanIdentity {
  sport: CardioPlanSport;
  athlete_label: string;
  movement_label: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function intervalNote(interval: unknown): string {
  if (interval == null) return "";
  if (typeof interval === "string") return interval.trim();
  if (Array.isArray(interval)) {
    return interval
      .map((item) => {
        const segment = record(item);
        const on = String(segment.on ?? "").trim();
        if (!on) return "";
        return segment.reps != null ? `${Number(segment.reps)} × ${on}` : on;
      })
      .filter(Boolean)
      .join(", ");
  }
  const row = record(interval);
  return typeof row.note === "string" ? row.note.trim() : "";
}

function descriptiveNote(note: unknown): boolean {
  const value = String(note ?? "").trim();
  if (!value) return false;
  return value.length > 38 || value.split(/\s+/).length > 7 || /[.!?]\s/.test(value);
}

function sportFor(item: CardioPlanIdentityInput): CardioPlanSport {
  const text =
    `${item.exercise ?? ""} ${item.note ?? ""} ${intervalNote(item.interval) || item.interval_note || ""}`.toLowerCase();
  // Token boundaries matter: ordinary running prose such as "finish with
  // relaxed strides" must not turn into a ride because "strides" contains
  // the substring "ride".
  if (/\b(?:ride|riding|bike|biking|cycle|cycling|spin|spinning)\b/.test(text)) return "ride";
  if (/\b(?:swim|swimming)\b/.test(text)) return "swim";
  if (/\b(?:row|rowing|erg)\b/.test(text)) return "row";
  if (/\b(?:hike|hiking)\b/.test(text)) return "hike";
  return "run";
}

function derivedLabel(item: CardioPlanIdentityInput, sport: CardioPlanSport): string {
  const capSport = sport.charAt(0).toUpperCase() + sport.slice(1);
  const interval = String(intervalNote(item.interval) || item.interval_note || "").toLowerCase();
  const zone = String(item.target_zone ?? "").toLowerCase();
  const blob = `${item.exercise ?? ""} ${item.note ?? ""} ${zone}`.toLowerCase();
  if (/interval|fartlek|\d\s*[×x]\s*\d/.test(`${interval} ${blob}`)) return `${capSport} intervals`;
  const km = item.target_distance_km != null ? Number(item.target_distance_km) : null;
  let mood = "";
  if (/tempo|threshold|z3|z4|z5/.test(zone)) mood = "Tempo";
  else if (/easy|recovery|z1|z2/.test(zone)) mood = "Easy";
  else if (/tempo|threshold|hard|fast/.test(blob)) mood = "Tempo";
  else if (/easy|relaxed|nasal|recovery|shakeout/.test(blob)) mood = "Easy";
  else if (km != null && km >= 12) mood = "Long";
  return mood ? `${mood} ${sport}` : capSport;
}

function labelNamesSport(label: string, sport: CardioPlanSport): boolean {
  if (sport === "run") return /\b(?:run|running|jog|jogging|sprint|treadmill)\b/i.test(label);
  if (sport === "ride") return /\b(?:ride|riding|bike|biking|cycle|cycling|spin)\b/i.test(label);
  if (sport === "swim") return /\b(?:swim|swimming)\b/i.test(label);
  if (sport === "row") return /\b(?:row|rowing|erg)\b/i.test(label);
  return /\b(?:hike|hiking)\b/i.test(label);
}

function labelIsExplicitGenericOrOtherModality(label: string): boolean {
  // Preserve deliberately generic cardio for low-confidence cross-modality
  // reconciliation, and preserve named modalities whose load map is more
  // accurate than silently relabelling them as Cairn's default run.
  return (
    !descriptiveNote(label) &&
    /\b(?:cardio|aerobic|conditioning|movement|elliptical|stairmaster|stairs?|stepper)\b/i.test(label)
  );
}

export function cardioPlanIdentity(item: CardioPlanIdentityInput): CardioPlanIdentity {
  const sport = sportFor(item);
  const derived = derivedLabel(item, sport);
  const note = String(item.note ?? "").trim();
  const exercise = String(item.exercise ?? "").trim();
  let athleteLabel = "";
  if (note && !descriptiveNote(note)) athleteLabel = note;
  else if (note) athleteLabel = derived;
  else if (exercise) athleteLabel = exercise;
  else if (item.target_distance_km != null && Number(item.target_distance_km) >= 12) athleteLabel = "Long run";
  else athleteLabel = "Cardio";

  // Safety and composition need a movement-bearing identity even when a short
  // athlete label is prose ("Continuous tempo at Z3"). Preserve that label for
  // display, but classify it through the same derived sport/effort semantics.
  // Explicit generic cardio stays generic: reconciliation intentionally lets
  // it match any recognized endurance effort at low confidence.
  const movementLabel =
    labelNamesSport(athleteLabel, sport) || labelIsExplicitGenericOrOtherModality(athleteLabel)
      ? athleteLabel
      : derived;
  return { sport, athlete_label: athleteLabel, movement_label: movementLabel };
}
