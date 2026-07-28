import { db } from "../db.js";
import { localDateISO } from "./shared.js";

export const LOCATION_TEXT_MAX = 160;

export interface EffectiveLocationContext {
  home: string | null;
  effective: string | null;
  source: "home" | "trip" | "unknown";
  trip_id: number | null;
  trip_title: string | null;
  weather_available: false;
  planning_role: "context_only";
}

export function normalizeLocationText(value: unknown): string | null {
  if (value == null) return null;
  const clean = String(value).trim().replace(/\s+/g, " ").slice(0, LOCATION_TEXT_MAX);
  return clean || null;
}

function validDay(value: unknown): string | null {
  const day = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/**
 * Resolve where the athlete is today without mutating durable identity.
 * A dated, unarchived, unresolved trip with meta.location wins only inside its
 * active window. Upcoming/past trips remain stored context, not current location.
 */
export function getLocationContext(
  opts: { on?: string; profile?: any } = {}
): EffectiveLocationContext {
  const on = validDay(opts.on) ?? localDateISO();
  // Query directly when no already-fetched profile is supplied. Keeping this
  // read independent of profile.ts lets the profile write boundary reuse the
  // same location normalizer without introducing a module cycle.
  const profile = opts.profile ?? db.prepare(`SELECT * FROM profile WHERE id = 1`).get() ?? null;
  const home = normalizeLocationText(profile?.home_location);
  const candidates = db
    .prepare(
      `SELECT id, title, meta_json
         FROM context_events
        WHERE kind = 'trip'
          AND archived = 0
          AND resolved_at IS NULL
          AND start_date IS NOT NULL
          AND start_date <= ?
          AND (end_date IS NULL OR end_date >= ?)
        ORDER BY start_date DESC, id DESC`
    )
    .all(on, on) as any[];
  for (const candidate of candidates) {
    let meta: any = null;
    try {
      meta = candidate.meta_json ? JSON.parse(candidate.meta_json) : null;
    } catch {
      meta = null;
    }
    const location = normalizeLocationText(meta?.location);
    if (!location) continue;
    return {
      home,
      effective: location,
      source: "trip",
      trip_id: Number(candidate.id),
      trip_title: normalizeLocationText(candidate.title),
      weather_available: false,
      planning_role: "context_only",
    };
  }
  return {
    home,
    effective: home,
    source: home ? "home" : "unknown",
    trip_id: null,
    trip_title: null,
    weather_available: false,
    planning_role: "context_only",
  };
}
