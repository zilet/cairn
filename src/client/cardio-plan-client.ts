// @ts-check
// Shared run-prescription helpers, plus the one filter that keeps runs out of the
// strength plan's surfaces.

type CardioIntervalSegment = {
  reps?: unknown;
  on?: unknown;
  off?: unknown;
  zone?: unknown;
};

type CardioPlanItem = {
  kind?: unknown;
  exercise?: unknown;
  note?: unknown;
  interval?: unknown;
  interval_note?: unknown;
  target_distance_km?: unknown;
  target_duration_min?: unknown;
  target_zone?: unknown;
};

function cardioRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function isCardioItem(item: unknown): boolean {
  return !!item && typeof item === "object" && (item as { kind?: unknown }).kind === "cardio";
}

// Runs left the strength plan: a plan day holds lifts only, and every run lives in
// Plan -> Endurance (the run engine and the rolling agenda). A payload from before
// that migration can still carry a cardio item, a rest day or a run-only day, so a
// strength surface filters them here rather than drawing a run as a line item.
function strengthPlanItems<T>(items: readonly T[] | null | undefined): T[] {
  return (Array.isArray(items) ? items : []).filter((item) => !isCardioItem(item));
}

// A rest day, or a day that carried only runs, is not a strength day. An empty
// training day still is one: the explicit scaffold an athlete is filling in.
function isStrengthPlanDay(day: unknown): boolean {
  if (!day || typeof day !== "object") return false;
  const row = day as { day_type?: unknown; items?: unknown };
  if (String(row.day_type ?? "training") === "rest") return false;
  const items: unknown[] = Array.isArray(row.items) ? row.items : [];
  return !items.length || items.some((item) => !isCardioItem(item));
}

function strengthPlanDays<T extends { items?: unknown }>(plan: readonly T[] | null | undefined): T[] {
  return (Array.isArray(plan) ? plan : [])
    .filter(isStrengthPlanDay)
    .map((day) => ({ ...day, items: strengthPlanItems(Array.isArray(day.items) ? (day.items as unknown[]) : []) }));
}

function cardioIntervalNote(interval: unknown): string {
  if (interval == null) return "";
  if (typeof interval === "string") return interval.trim();
  if (Array.isArray(interval)) {
    return interval
      .map((item) => {
        const segment = cardioRecord(item) as CardioIntervalSegment;
        const on = String(segment.on || "").trim();
        if (!on) return "";
        return segment.reps != null ? `${Number(segment.reps)} × ${on}` : on;
      })
      .filter(Boolean)
      .join(", ");
  }
  const row = cardioRecord(interval);
  return typeof row.note === "string" ? row.note.trim() : "";
}

function cardioIntervalStructure(interval: unknown, targetZone: unknown): string {
  if (!Array.isArray(interval) || !interval.length) return "";
  const tz = String(targetZone || "").trim();
  const tzZone = (tz.match(/^\s*(Z[1-5])\b/i) || [])[1];
  const tzBand = tzZone ? tz : "";
  const segments = interval
    .map((item) => {
      const segment = cardioRecord(item) as CardioIntervalSegment;
      const on = String(segment.on || "").trim();
      if (!on) return "";
      const reps = segment.reps != null ? Number(segment.reps) : null;
      let zone = String(segment.zone || "")
        .trim()
        .toUpperCase();
      if (zone && tzZone && zone === String(tzZone).toUpperCase() && tzBand) zone = tzBand;
      const head = reps != null && reps > 0 ? `${reps} × ${on}` : on;
      let text = zone ? `${head} @ ${zone}` : head;
      const off = String(segment.off || "").trim();
      if (off) text += `, ${/^\d+\s*(s|sec|secs|m|min|mins)?$/i.test(off) ? `${off} jog` : off}`;
      return text;
    })
    .filter(Boolean);
  return segments.join("; ");
}

function cardioPrescription(item: CardioPlanItem | null | undefined): string {
  const row = cardioRecord(item);
  const bits: string[] = [];
  if (row.target_distance_km != null) bits.push(`${fmtKm(row.target_distance_km)} km`);
  else if (row.target_duration_min != null) bits.push(`${Math.round(Number(row.target_duration_min))} min`);
  const structure = cardioIntervalStructure(row.interval, row.target_zone);
  if (structure) {
    bits.push(structure);
  } else {
    if (row.target_zone) bits.push(String(row.target_zone));
    const interval = cardioIntervalNote(row.interval) || row.interval_note;
    if (interval) bits.push(String(interval));
  }
  return bits.join(" · ");
}

const CAIRN_CARDIO_PLAN = {
  isCardioItem,
  strengthPlanItems,
  isStrengthPlanDay,
  strengthPlanDays,
  cardioIntervalNote,
  cardioIntervalStructure,
  cardioPrescription,
};

Object.assign(globalThis, {
  CairnCardioPlan: CAIRN_CARDIO_PLAN,
  isCardioItem,
  strengthPlanItems,
  isStrengthPlanDay,
  strengthPlanDays,
  cardioIntervalNote,
  cardioIntervalStructure,
  cardioPrescription,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnCardioPlan: CAIRN_CARDIO_PLAN,
    isCardioItem,
    strengthPlanItems,
    isStrengthPlanDay,
    strengthPlanDays,
    cardioIntervalNote,
    cardioIntervalStructure,
    cardioPrescription,
  });
}
