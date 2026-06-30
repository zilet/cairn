// @ts-check
// Shared planned-cardio helpers for Today, Progress, and Plan surfaces.

type CardioIntervalSegment = {
  reps?: unknown;
  on?: unknown;
  off?: unknown;
  zone?: unknown;
};

type CardioPlanItem = {
  kind?: unknown;
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
      let zone = String(segment.zone || "").trim().toUpperCase();
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

function cardioArtPhrase(item: CardioPlanItem | null | undefined): string {
  const row = cardioRecord(item);
  const label = String(row.note || "").trim();
  return label || "run";
}

function cardioNoteIsDescriptive(note: unknown): boolean {
  const text = String(note || "").trim();
  if (!text) return false;
  return text.length > 38 || text.split(/\s+/).length > 7 || /[.!?]\s/.test(text);
}

function cardioSport(item: CardioPlanItem | null | undefined): string {
  const row = cardioRecord(item);
  const text = `${row.note || ""} ${cardioIntervalNote(row.interval) || row.interval_note || ""}`.toLowerCase();
  if (/ride|bike|cycl|spin/.test(text)) return "ride";
  if (/swim/.test(text)) return "swim";
  if (/\brow|erg\b/.test(text)) return "row";
  return "run";
}

function derivedCardioLabel(item: CardioPlanItem | null | undefined): string {
  const row = cardioRecord(item);
  const sport = cardioSport(row);
  const cap = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);
  const interval = String(cardioIntervalNote(row.interval) || row.interval_note || "").toLowerCase();
  const zone = String(row.target_zone || "").toLowerCase();
  const blob = `${row.note || ""} ${zone}`.toLowerCase();
  if (/interval|fartlek|\d\s*[×x]\s*\d/.test(`${interval} ${blob}`)) return `${cap(sport)} intervals`;
  const km = row.target_distance_km != null ? Number(row.target_distance_km) : null;
  let mood = "";
  if (/tempo|threshold|z3|z4|z5/.test(zone)) mood = "Tempo";
  else if (/easy|recovery|z1|z2/.test(zone)) mood = "Easy";
  else if (/tempo|threshold|hard|fast/.test(blob)) mood = "Tempo";
  else if (/easy|relaxed|nasal|recovery|shakeout/.test(blob)) mood = "Easy";
  else if (km != null && km >= 12) mood = "Long";
  return mood ? `${mood} ${sport}` : cap(sport);
}

function cardioLabel(item: CardioPlanItem | null | undefined): string {
  const row = cardioRecord(item);
  const note = String(row.note || "").trim();
  if (note && !cardioNoteIsDescriptive(note)) return note;
  if (note) return derivedCardioLabel(row);
  if (row.target_distance_km != null && Number(row.target_distance_km) >= 12) return "Long run";
  return "Cardio";
}

function cardioDescription(item: CardioPlanItem | null | undefined): string {
  const row = cardioRecord(item);
  const note = String(row.note || "").trim();
  return cardioNoteIsDescriptive(note) ? note : "";
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
  cardioIntervalNote,
  cardioIntervalStructure,
  cardioArtPhrase,
  cardioNoteIsDescriptive,
  cardioSport,
  derivedCardioLabel,
  cardioLabel,
  cardioDescription,
  cardioPrescription,
};

Object.assign(globalThis, {
  CairnCardioPlan: CAIRN_CARDIO_PLAN,
  isCardioItem,
  cardioIntervalNote,
  cardioIntervalStructure,
  cardioArtPhrase,
  cardioNoteIsDescriptive,
  cardioSport,
  derivedCardioLabel,
  cardioLabel,
  cardioDescription,
  cardioPrescription,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnCardioPlan: CAIRN_CARDIO_PLAN,
    isCardioItem,
    cardioIntervalNote,
    cardioIntervalStructure,
    cardioArtPhrase,
    cardioNoteIsDescriptive,
    cardioSport,
    derivedCardioLabel,
    cardioLabel,
    cardioDescription,
    cardioPrescription,
  });
}
