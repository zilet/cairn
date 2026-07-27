// Bounded, server-owned interpretation of the equipment constraint supplied for
// one daily session. This is intentionally small and deterministic: recognized
// common phrases become enforceable capabilities; unknown prose remains
// unrecognized so Cairn never claims it enforced a constraint it did not parse.

export type SessionEquipment =
  | "barbell"
  | "dumbbell"
  | "kettlebell"
  | "machine"
  | "cable"
  | "bands"
  | "bodyweight";

export interface EquipmentCapability {
  recognized: boolean;
  restricted: boolean;
  allowed: SessionEquipment[];
  prohibited: SessionEquipment[];
}

const ALL: SessionEquipment[] = [
  "barbell",
  "dumbbell",
  "kettlebell",
  "machine",
  "cable",
  "bands",
  "bodyweight",
];

function unique(values: SessionEquipment[]): SessionEquipment[] {
  return [...new Set(values)];
}

export function parseEquipmentCapability(value: unknown): EquipmentCapability {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!text) return { recognized: false, restricted: false, allowed: [], prohibited: [] };
  if (/\b(full(?:y)? equipped|full gym|commercial gym|everything)\b/.test(text)) {
    return { recognized: true, restricted: false, allowed: [...ALL], prohibited: [] };
  }

  const prohibited: SessionEquipment[] = [];
  if (/\b(no|without|avoid)\s+(?:a\s+)?barbell\b/.test(text)) prohibited.push("barbell");
  if (/\b(no|without|avoid)\s+(?:any\s+)?machines?\b/.test(text)) prohibited.push("machine");
  if (/\b(no|without|avoid)\s+cables?\b/.test(text)) prohibited.push("cable");

  let allowed: SessionEquipment[] = [];
  if (/\b(bodyweight|body weight|no equipment|equipment[- ]?free|calisthenics?)\b/.test(text)) {
    allowed = ["bodyweight"];
  } else if (/\b(hotel|travel|travelling|traveling|minimal(?: equipment| setup)?)\b/.test(text)) {
    allowed = ["dumbbell", "bands", "bodyweight"];
  } else {
    if (/\b(dumbbells?|dumbells?|\bdbs?\b)\b/.test(text)) allowed.push("dumbbell");
    if (/\b(resistance bands?|bands?)\b/.test(text)) allowed.push("bands");
    if (/\b(kettlebells?|\bkbs?\b)\b/.test(text)) allowed.push("kettlebell");
    if (/\b(cables?|pulley)\b/.test(text)) allowed.push("cable");
    if (/\b(machines?|smith)\b/.test(text)) allowed.push("machine");
    if (/\b(barbells?|\bbb\b)\b/.test(text) && !prohibited.includes("barbell")) allowed.push("barbell");
  }

  allowed = unique(allowed);
  // Bodyweight work remains available alongside a named portable implement.
  if (allowed.length && !allowed.includes("bodyweight")) allowed.push("bodyweight");
  const recognized = allowed.length > 0 || prohibited.length > 0;
  return {
    recognized,
    restricted: allowed.length > 0 || prohibited.length > 0,
    allowed,
    prohibited: unique(prohibited),
  };
}

export function inferExerciseEquipment(
  exercise: unknown,
  storedEquipment?: unknown
): SessionEquipment | null {
  const stored = String(storedEquipment ?? "").toLowerCase();
  const name = String(exercise ?? "").toLowerCase();
  // A classified exercise row is authoritative. Consult name heuristics only
  // when that explicit field is absent/unrecognized; otherwise "DB Hip Thrust"
  // or "DB Deadlift" would be mislabeled barbell by its movement-family noun.
  if (/\b(dumbbells?|dumbells?|\bdb\b)\b/.test(stored)) return "dumbbell";
  if (/\b(barbell|\bbb\b)\b/.test(stored)) return "barbell";
  if (/\b(kettlebells?|\bkb\b)\b/.test(stored)) return "kettlebell";
  if (/\b(resistance bands?|banded)\b/.test(stored)) return "bands";
  if (/\b(cables?|pulley)\b/.test(stored)) return "cable";
  if (/\b(machine|smith)\b/.test(stored)) return "machine";
  if (/\b(bodyweight|calisthenics?)\b/.test(stored)) return "bodyweight";

  if (/\b(dumbbells?|dumbells?|\bdb\b)\b/.test(name)) return "dumbbell";
  if (/\b(kettlebells?|\bkb\b)\b/.test(name)) return "kettlebell";
  if (/\b(resistance bands?|banded)\b/.test(name)) return "bands";
  if (/\b(cables?|pulley|rope pushdown)\b/.test(name)) return "cable";
  if (/\b(machine|smith|hack squat|leg press|lat pulldown|assisted pull[ -]?up)\b/.test(name)) return "machine";
  if (/\b(barbell|\bbb\b|back squat|front squat|deadlift|good morning|hip thrust)\b/.test(name)) return "barbell";
  if (
    /\b(bodyweight|push[ -]?up|pull[ -]?up|chin[ -]?up|plank|dead bug|glute bridge|inverted row|pike push[ -]?up|easy walk|easy movement)\b/.test(
      name
    )
  )
    return "bodyweight";
  return null;
}

export function equipmentCompatibility(
  capability: EquipmentCapability,
  equipment: SessionEquipment | null
): "compatible" | "incompatible" | "unknown" {
  if (!capability.recognized || !capability.restricted) return "unknown";
  if (equipment == null) return capability.allowed.length ? "unknown" : "compatible";
  if (capability.prohibited.includes(equipment)) return "incompatible";
  if (capability.allowed.length && !capability.allowed.includes(equipment)) return "incompatible";
  return "compatible";
}
