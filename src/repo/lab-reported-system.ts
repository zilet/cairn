// The unit system the athlete's OWN labs are printed in — what "Automatic" lab units
// means. A kilogram scale says nothing about it (Germany, Italy and Japan weigh in kg
// and print mg/dL), so Automatic reads the evidence instead: the majority of every
// reading printed over the last twelve months whose unit tells the two systems apart —
// across all of that year's draws, so one SI lab abroad does not flip an athlete whose
// labs are otherwise US, and a move to an SI country carries over as its draws accrue.
// With no such reading in the year, the most recent draw that has one speaks. A tie, or
// nothing that can tell (nothing uploaded yet, or only analytes both systems print alike,
// ferritin ng/mL = µg/L), reads conventional (US), the canonical system.
//
// Display only; every comparison stays canonical (lab-units.ts).

import { db, sqliteRollbackCount } from "../db.js";
import { type LabUnitSystem, labUnitSpec, labUnitsCompatible } from "./lab-units.js";
import { currentMarkerDataVersion } from "./marker-cache.js";
import { unitAnalyteZone } from "./propagation-data.js";
import { addDaysISO, localDateISO } from "./shared.js";

/** How far back Automatic weighs the athlete's draws. */
export const REPORTED_SYSTEM_WINDOW_DAYS = 365;

/** Which system one reading's unit speaks for, or null when it cannot tell them apart. */
function systemOfReading(name: unknown, unit: unknown): LabUnitSystem | null {
  const label = unitAnalyteZone(String(name ?? ""))?.label;
  const spec = labUnitSpec(label);
  if (!spec?.si || !unit) return null;
  // ferritin ng/mL vs µg/L, TSH µIU/mL vs mIU/L: the same number in both systems.
  if (labUnitsCompatible(spec.canonical, spec.si.unit)) return null;
  if (labUnitsCompatible(unit, spec.canonical)) return "us";
  if (labUnitsCompatible(unit, spec.si.unit)) return "si";
  return null;
}

function tally(markers: unknown): { us: number; si: number } {
  let us = 0;
  let si = 0;
  if (Array.isArray(markers)) {
    for (const m of markers) {
      const system = systemOfReading((m as any)?.name, (m as any)?.unit);
      if (system === "si") si++;
      else if (system === "us") us++;
    }
  }
  return { us, si };
}

function verdict(us: number, si: number): LabUnitSystem | null {
  if (us + si === 0) return null;
  return si > us ? "si" : "us";
}

function compute(today: string): LabUnitSystem | null {
  const rows = db
    .prepare(
      `SELECT COALESCE(doc_date, substr(created_at, 1, 10)) AS draw_date, parsed_json FROM health_documents
       WHERE kind != 'imaging' AND parsed_json LIKE '%"markers"%'
       ORDER BY draw_date DESC, id DESC`
    )
    .all() as Array<{ draw_date: string | null; parsed_json: string | null }>;
  const since = addDaysISO(today, -REPORTED_SYSTEM_WINDOW_DAYS) ?? today;
  // The year's readings, all draws together.
  let us = 0;
  let si = 0;
  // With none in the year: the most recent draw that has any.
  let olderDate: string | null | undefined;
  let olderUs = 0;
  let olderSi = 0;
  for (const row of rows) {
    const inWindow = !!row.draw_date && row.draw_date >= since;
    if (!inWindow && us + si > 0) break; // newest first: the year has spoken
    if (!inWindow && olderDate !== undefined && row.draw_date !== olderDate && olderUs + olderSi > 0) break;
    let markers: unknown;
    try {
      markers = row.parsed_json ? (JSON.parse(row.parsed_json) as { markers?: unknown })?.markers : null;
    } catch {
      continue;
    }
    const counts = tally(markers);
    if (inWindow) {
      us += counts.us;
      si += counts.si;
      continue;
    }
    if (row.draw_date !== olderDate) {
      olderDate = row.draw_date;
      olderUs = 0;
      olderSi = 0;
    }
    olderUs += counts.us;
    olderSi += counts.si;
  }
  return verdict(us, si) ?? verdict(olderUs, olderSi);
}

// Cached on the marker-data version (marker-cache.ts) — bumped by every write that adds,
// edits or removes a health document or its markers — the local date, since a draw ages
// out of the twelve-month window on a day nothing is written, and the rollback count, since
// a rolled-back write undoes rows without moving the version. Never on SQLite's
// total_changes(): the request-metric and diagnostic sinks write on every request, so an
// odometer key recomputed this several times per request.
let cache: { key: string; value: LabUnitSystem | null } | null = null;
let computes = 0;

/** The system the athlete's labs are printed in (see above), or null when no draw can say. */
export function reportedLabSystem(): LabUnitSystem | null {
  try {
    const today = localDateISO();
    const key = `${currentMarkerDataVersion()}:${sqliteRollbackCount()}:${today}`;
    if (cache?.key === key) return cache.value;
    computes++;
    const value = compute(today);
    cache = { key, value };
    return value;
  } catch {
    return null;
  }
}

/** How many times the verdict was recomputed in this process (a test seam for the cache). */
export function reportedLabSystemComputeCount(): number {
  return computes;
}
