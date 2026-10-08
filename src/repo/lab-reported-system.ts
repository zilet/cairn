// The unit system the athlete's OWN labs are printed in — what "Automatic" lab units
// means. A kilogram scale says nothing about it (Germany, Italy and Japan weigh in kg
// and print mg/dL), so Automatic reads the evidence instead: the majority of the most
// recent draw's readings whose unit tells the two systems apart. No such draw — nothing
// uploaded yet, or only analytes both systems print alike (ferritin ng/mL = µg/L) —
// reads conventional (US), the canonical system. SI is therefore shown only when the
// athlete's labs arrive in SI, or when they choose it.
//
// Display only; every comparison stays canonical (lab-units.ts).

import { db, sqliteRollbackCount } from "../db.js";
import { type LabUnitSystem, labUnitSpec, labUnitsCompatible } from "./lab-units.js";
import { unitAnalyteZone } from "./propagation-data.js";

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

function compute(): LabUnitSystem | null {
  const rows = db
    .prepare(
      `SELECT doc_date, parsed_json FROM health_documents
       WHERE parsed_json LIKE '%"markers"%'
       ORDER BY COALESCE(doc_date, substr(created_at, 1, 10)) DESC, id DESC
       LIMIT 40`
    )
    .all() as Array<{ doc_date: string | null; parsed_json: string | null }>;
  let date: string | null | undefined;
  let us = 0;
  let si = 0;
  for (const row of rows) {
    // Rows arrive newest date first: once a date has a verdict, older draws never speak.
    if (date !== undefined && row.doc_date !== date && us + si > 0) break;
    if (row.doc_date !== date) {
      date = row.doc_date;
      us = 0;
      si = 0;
    }
    let markers: unknown;
    try {
      markers = row.parsed_json ? (JSON.parse(row.parsed_json) as { markers?: unknown })?.markers : null;
    } catch {
      continue;
    }
    if (!Array.isArray(markers)) continue;
    for (const m of markers) {
      const system = systemOfReading((m as any)?.name, (m as any)?.unit);
      if (system === "si") si++;
      else if (system === "us") us++;
    }
  }
  if (us + si === 0) return null;
  return si > us ? "si" : "us";
}

// Cached on SQLite's total_changes() odometer (one connection, synchronous): an unmoved
// odometer means no row anywhere changed, so the answer is the same one a recompute gives.
// A rollback undoes rows without lowering it, hence the rollback count in the key.
let cache: { key: string; value: LabUnitSystem | null } | null = null;
let changesStatement: ReturnType<typeof db.prepare> | null = null;

/** The system the most recent lab draw was printed in, or null when no draw can say. */
export function reportedLabSystem(): LabUnitSystem | null {
  try {
    changesStatement ??= db.prepare(`SELECT total_changes() AS n`);
    const n = (changesStatement.get() as { n?: unknown } | undefined)?.n;
    const key = `${String(n)}:${sqliteRollbackCount()}`;
    if (cache?.key === key) return cache.value;
    const value = compute();
    cache = { key, value };
    return value;
  } catch {
    return null;
  }
}
