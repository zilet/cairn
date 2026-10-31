// One panel per draw date.
//
// The same lab draw reaches Cairn more than once: a MyChart export uploaded as
// a PDF and again as a zip, a re-export a month later that carries every older
// panel again, or one import read BOTH deterministically (CCDA) and by an agent.
// Each arrival used to become its own dated record, so a single lipid panel
// showed three times and every series carried the same reading in triplicate.
//
// This module recognizes those twins by their READINGS, not their file names:
// two records on the same date whose shared analytes agree are the same draw.
// They fold into one survivor (the uploaded source row when there is one, else
// the deterministic read, else the richer panel), the survivor gains any marker
// the twin knew and it did not, and the twin is removed. Records on the same
// date with nothing in common (an ECG beside a chemistry panel) stay separate;
// records whose shared readings disagree (a morning and an evening blood
// pressure) stay separate too — and so do records that share only what any two
// same-day records share (a weight, a BMI, a pulse), because those are not
// identity: a DEXA and a lab panel both print the athlete's weight.
//
// The fold is deliberately conservative where the write is irreversible: a
// twin that owns an uploaded file folds only when the survivor already holds
// every reading it has (an identical second upload), and a twin that split
// out derived panels of its own never folds. Each call iterates to a fixed
// point, and a dry run reports that same end state without writing.
//
// One clinic encounter is identity too: two deterministic CCDA rows of one type
// (vitals with vitals) on one date, stating the same encounter time to the minute
// and coming from two different exports, are the same visit even when the
// readings alone are too few to say so (a re-export that kept one vital of six).
// Where their readings disagree the LATER export wins (an EHR amends a chart, and
// the later export is the chart as it stands now), and the survivor keeps the
// value it replaced in `superseded_readings`, so nothing is silently lost. Never
// for an agent's read, and never across two encounter times.
//
// It runs the moment a record is added (every creation path settles through
// src/domain/health/record-dedupe.ts, scoped to the new rows but matched against
// the WHOLE record set), on demand across the whole set (the route / MCP tool and
// the Records screen's check), and once at boot whenever DEDUPE_RULES_VERSION
// moves, so better rules clean up what earlier rules left behind.

import { db } from "../db.js";
import { canonicalMarkerForReading, isNonAnalyteMarkerName, normalizeMarkerName } from "./marker-canon.js";
import { deleteHealthDocument, registerUploadWithdrawer, updateHealthDocFields } from "./health.js";
import { dedupeImagingStudies, foldJudgedImagingTwins } from "./imaging-dedupe.js";
import type { FoldAllowList, ImagingDedupeFold, ImagingDedupeResult } from "./imaging-dedupe.js";
import { labUnitSpec, labUnitsCompatible, normalizeLabUnit, toCanonical } from "./lab-units.js";
import { unitAnalyteZone } from "./propagation-data.js";

export const CCDA_DERIVED_TYPES = new Set(["ccda_results", "ccda_vitals"]);

// Bump whenever a rule here (or in imaging-dedupe.ts) learns to recognize a twin
// it used to miss: the boot pass (src/domain/health/record-dedupe.ts) folds the
// whole record set once under the new rules, so records filed before the rule
// existed are cleaned up without any recurring job.
//   1: same draw by agreeing readings; same scan by date, procedure and impression.
//   2: same CCDA encounter across exports; agent-judged imaging near-twins.
export const DEDUPE_RULES_VERSION = 2;

// Readings any two same-day records may share WITHOUT being the same draw: the
// athlete's body at the clinic that morning, printed on the DEXA, the vitals
// sheet and the lab requisition alike. They corroborate a match; they never
// make one on their own. Matched by word against the canonical key, so every
// spelling the canon produces ("body temperature", "o2 sat", "weight lb") is
// caught, not only the ones listed here.
const NON_DISCRIMINATING_KEY =
  /\b(weight|height|body mass index|bmi|pulse|heart rate|systolic|diastolic|blood pressure|bp|temperature|temp|respiratory rate|respiration|respirations|oxygen saturation|o2 sat|o2 saturation|spo2|pain score|pain level|pain scale)\b/;

export function isNonDiscriminatingKey(key: string): boolean {
  return NON_DISCRIMINATING_KEY.test(key);
}

interface DocRow {
  id: number;
  kind: string;
  doc_date: string;
  source_doc_id: number | null;
  file_path: string | null;
  original_name: string | null;
  summary: string | null;
  parsed: Record<string, any>;
  markers: any[];
  readings: Map<string, Reading>;
  children: number;
  created_at: string | null;
  source_created_at: string | null; // when the export this row came out of was uploaded
  mime: string | null;
  status: string; // this row's own read state
  source_status: string; // the read state of the upload it came out of
}

// A read still running on a row, or on the upload it came out of: never folded
// (the read would rewrite or delete what the fold just merged).
const BUSY = new Set(["pending", "in_progress", "running", "pending_confirm"]);

interface Reading {
  value: string; // comparable form as printed ("n:3.2", "s:<0.5" — a qualified value stays text)
  num: number | null; // the printed number in its SOURCE unit; null for text and qualified values
  unit: string | null; // the normalized unit spelling, or null when none was printed
  canonical: number | null; // the number in its analyte's canonical unit, when the table converts that unit
  tolerance: number; // slack on `canonical`: half the source's last printed digit, converted
  incommensurable: boolean; // a unit with no fixed conversion to the analyte's others (Lp(a) mg/dL)
  marker: any; // the stored marker object
}

export type DedupeRule = "same_draw" | "same_encounter" | "same_scan" | "same_scan_judged";

export interface SupersededReading {
  name: string;
  value: unknown;
  unit: string | null;
  from_doc_id: number; // the record whose value was replaced
  replaced_by_doc_id: number; // the record whose value now stands
  from_source_doc_id: number | null; // the export the replaced value came from
  key?: string; // the reading slot (markerReadingKey), so the value can be put back
  marker?: Record<string, unknown>; // the replaced marker whole (flag, printed range), put back whole
}

// Where the value standing in one reading slot came from, kept on a survivor that
// folded exports of one encounter (`parsed.reading_sources`, by reading key): the
// next export compares itself with THIS, never with the survivor's own export.
interface ReadingSource {
  source_doc_id: number | null;
  exported_at: string | null;
}

export interface DedupeClusterPlan {
  date: string;
  survivor: { id: number; kind: string; doc_date: string; markers: number; label: string | null };
  merged: Array<{
    id: number;
    kind: string;
    doc_date: string;
    markers: number;
    source_doc_id: number | null;
    file: boolean;
    label: string | null;
  }>;
  added_markers: number;
  // Which rule recognized the twins, and why, in plain words for the Records screen.
  rule: DedupeRule;
  reason: string;
  superseded: SupersededReading[];
  // Uploads the fold deletes with a twin, and the same in plain words (null when none).
  removes: Array<{ id: number; what: "file" | "paste"; label: string | null }>;
  removes_note: string | null;
}

export interface DedupeHealthDocumentsResult {
  dry_run: boolean;
  scanned: number;
  passes: number;
  clusters: DedupeClusterPlan[];
  merged: number; // records folded into a survivor
  added_markers: number;
  deleted_files: number;
  errors: string[]; // a twin that could not be removed — the fold stops there
  converged: boolean; // false only if the pass cap was hit before a fixed point
}

export interface DedupeOptions {
  dryRun?: boolean;
  // Only fold clusters that include this upload or one of its derived panels
  // (the ingest hook): an import never rewrites records it did not touch. The
  // upload itself is still mid-ingest when the hook runs, so it is read
  // regardless of its enrichment status.
  scopeSourceId?: number | null;
  // Fold only these approved pairs, `${survivorId}:${twinId}` (the Records apply).
  allow?: FoldAllowList;
}

// Numbers agree within half a percent (27.21 vs 27.2 is one BMI, 5.4 vs 5.5 is
// not one HbA1c); text agrees case- and whitespace-insensitively ("< 6" / "<6").
export function comparableReading(value: unknown): string | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (Number.isFinite(n)) return `n:${n}`;
  const s = String(value).toLowerCase().replace(/\s+/g, "");
  return s ? `s:${s}` : null;
}

function numbersAgree(x: number, y: number, tolerance: number): boolean {
  const scale = Math.max(Math.abs(x), Math.abs(y));
  if (scale === 0) return x === y;
  return Math.abs(x - y) <= Math.max(scale * 0.005, tolerance);
}

// Two transcriptions of one reading agree when their numbers do, compared in the units
// they can BOTH speak to:
//   - same unit, or either side printed no unit or one the table does not know: the
//     raw printed numbers (one draw's two copies, one of which dropped or misspelled
//     the unit, still agree — the pre-conversion behaviour);
//   - two different units the analyte converts between: the canonical numbers, with
//     the slack each source's printed precision implies;
//   - two different units one of which has no fixed conversion (Lp(a) mg/dL beside
//     nmol/L): never, whatever the numbers say.
// Text and qualified values ("<0.5") compare only as text, so a "<0.5" is never 0.5.
function readingsAgree(a: Reading, b: Reading): boolean {
  if (a.num == null || b.num == null) return a.value === b.value;
  const unitsDiffer = !!a.unit && !!b.unit && !labUnitsCompatible(a.unit, b.unit);
  if (unitsDiffer && (a.incommensurable || b.incommensurable)) return false;
  if (unitsDiffer && a.canonical != null && b.canonical != null) {
    return numbersAgree(a.canonical, b.canonical, Math.max(a.tolerance, b.tolerance));
  }
  return numbersAgree(a.num, b.num, 0);
}

// Digits printed after the decimal mark ("5.20" → 2, "3,2" → 1, 201 → 0).
function printedDecimals(value: unknown): number {
  const m = String(value ?? "").trim().match(/[.,](\d+)\s*$/);
  return m ? m[1].length : 0;
}

// The number a value prints, or null. Only a PLAIN number ("5.2", 201, a comma-decimal
// "3,2") reads as one: a qualified "<0.5" / ">90" is a bound, not the number beside it,
// and anything else ("1:160", "5.2 H") stays text exactly as the pre-unit compare kept it.
function plainLabNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = String(value ?? "").trim();
  if (!/^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(s)) return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// One reading with everything readingsAgree needs: its printed number and unit, and —
// for a recognized analyte whose unit the table converts (src/repo/lab-units.ts) — the
// same number in the canonical unit, so the same draw printed as LDL 3.2 mmol/L and LDL
// 124 mg/dL is ONE reading, not a conflict. A converted value carries the slack its
// source's own rounding implies (an HDL printed "1.3 mmol/L" is anything from 1.25 to
// 1.35, i.e. ±1.9 mg/dL). A unit on a scale with no fixed conversion (Lp(a) mg/dL) is
// marked incommensurable, so it never agrees with a reading in another unit.
function comparableMarkerReading(marker: any): Omit<Reading, "marker"> | null {
  const raw = marker?.value;
  const num = plainLabNumber(raw);
  const value = num != null ? `n:${num}` : comparableReading(raw);
  if (value == null) return null;
  const unit = normalizeLabUnit(marker?.unit);
  const out = { value, num, unit, canonical: null, tolerance: 0, incommensurable: false };
  if (num == null || !unit) return out;
  const name = String(marker?.name ?? "");
  const zone = unitAnalyteZone(canonicalMarkerForReading(name, marker.unit).name) ?? unitAnalyteZone(name);
  const spec = labUnitSpec(zone?.label);
  if (!zone || !spec || !labUnitsCompatible(spec.canonical, zone.unit)) return out;
  const canonical = toCanonical(zone.label, num, unit);
  if (canonical == null) {
    return { ...out, incommensurable: !!spec.never?.some((u) => labUnitsCompatible(u, unit)) };
  }
  if (labUnitsCompatible(unit, spec.canonical)) return { ...out, canonical };
  const lower = toCanonical(zone.label, num - 0.5 * 10 ** -printedDecimals(raw), unit);
  return { ...out, canonical, tolerance: lower == null ? 0 : Math.abs(canonical - lower) };
}

export function markerReadingKey(marker: any): string | null {
  const name = String(marker?.name ?? "").trim();
  if (!name || isNonAnalyteMarkerName(name)) return null;
  return canonicalMarkerForReading(name, marker?.unit ?? null).key || normalizeMarkerName(name) || null;
}

function readingsOf(markers: any[]): Map<string, Reading> {
  const out = new Map<string, Reading>();
  for (const marker of markers) {
    const key = markerReadingKey(marker);
    const reading = comparableMarkerReading(marker);
    if (!key || reading == null || out.has(key)) continue;
    out.set(key, { ...reading, marker });
  }
  return out;
}

interface Overlap {
  agree: number;
  discriminating: number; // agreeing readings that are identity evidence
  conflict: number;
  twinOnly: number; // readings b carries that a does not
}

function overlap(a: DocRow, b: DocRow): Overlap {
  const out: Overlap = { agree: 0, discriminating: 0, conflict: 0, twinOnly: 0 };
  for (const [key, reading] of b.readings) {
    const other = a.readings.get(key);
    if (!other) {
      out.twinOnly++;
      continue;
    }
    if (readingsAgree(reading, other)) {
      out.agree++;
      if (!isNonDiscriminatingKey(key)) out.discriminating++;
    } else {
      out.conflict++;
    }
  }
  return out;
}

function pureVitals(row: DocRow): boolean {
  for (const key of row.readings.keys()) if (!isNonDiscriminatingKey(key)) return false;
  return true;
}

function derivedType(row: DocRow): string {
  return String(row.parsed?.type ?? "");
}

// The encounter time a deterministic CCDA row states, to the minute: the stored
// `recorded_at`, else (rows written before it was stored) the time the vitals
// summary prints ("MyChart vitals recorded 2026-03-10 15:52").
export function encounterStamp(row: { parsed?: any; summary?: string | null }): string | null {
  const read = (value: unknown): string | null => {
    const m = String(value ?? "").match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
    return m ? `${m[1]} ${m[2]}` : null;
  };
  const stored = read(row.parsed?.recorded_at);
  if (stored) return stored;
  const summary = String(row.summary ?? "").match(/\brecorded\s+(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2})/i);
  return summary ? read(summary[1]) : null;
}

// The vitals the CCDA pass writes, by the exact names it writes them under.
const CCDA_VITAL_NAMES = new Set([
  "Systolic BP",
  "Diastolic BP",
  "Pulse",
  "Temperature",
  "Oxygen Saturation",
  "Respiratory Rate",
  "Weight",
  "Height",
  "BMI",
]);
const CCDA_VITALS_SUMMARY = /^MyChart vitals recorded \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

// A row the deterministic CCDA pass wrote. Since this round the pass marks its own
// rows (`parsed.ccda_pass`, set only by replaceHealthPanelsByType; an agent's panel
// cannot carry it). Rows filed before the mark are recognized by what only that pass
// writes: a `ccda_vitals` row whose summary is exactly its "MyChart vitals recorded
// <time>" line and whose every marker is one of its vitals, by its own name.
export function isDeterministicCcdaRow(row: { parsed?: any; summary?: string | null; markers?: any[] }): boolean {
  const parsed = row.parsed ?? {};
  if (!CCDA_DERIVED_TYPES.has(String(parsed.type ?? ""))) return false;
  if (parsed.ccda_pass === true) return true;
  const markers = Array.isArray(row.markers) ? row.markers : Array.isArray(parsed.markers) ? parsed.markers : [];
  return (
    parsed.type === "ccda_vitals" &&
    CCDA_VITALS_SUMMARY.test(String(row.summary ?? "").trim()) &&
    markers.length > 0 &&
    markers.every((m: any) => CCDA_VITAL_NAMES.has(String(m?.name ?? "")))
  );
}

// One clinic encounter filed by two exports: the same CCDA type, the same date,
// the same stated encounter time, two different source exports. Only rows the
// deterministic CCDA pass wrote (isDeterministicCcdaRow), never an agent's read,
// never two times.
export function sameEncounter(a: DocRow, b: DocRow): boolean {
  const type = derivedType(a);
  if (!CCDA_DERIVED_TYPES.has(type) || type !== derivedType(b)) return false;
  if (!isDeterministicCcdaRow(a) || !isDeterministicCcdaRow(b)) return false;
  if (a.doc_date !== b.doc_date || a.file_path || b.file_path) return false;
  if (a.source_doc_id == null || b.source_doc_id == null || a.source_doc_id === b.source_doc_id) return false;
  const stamp = encounterStamp(a);
  return stamp != null && stamp === encounterStamp(b) && stamp.slice(0, 10) === a.doc_date;
}

// The export one slot's value came from: the survivor's remembered provenance for
// that reading, else the row's own export.
function readingSource(row: DocRow, key: string): ReadingSource {
  const kept = row.parsed?.reading_sources?.[key];
  if (kept && typeof kept === "object") {
    return {
      source_doc_id: kept.source_doc_id == null ? null : Number(kept.source_doc_id),
      exported_at: kept.exported_at == null ? null : String(kept.exported_at),
    };
  }
  return { source_doc_id: row.source_doc_id, exported_at: row.source_created_at ?? row.created_at };
}

// Which of two exports is the later one: its upload time, then its id (uploads are
// numbered in arrival order).
function laterSource(a: ReadingSource, b: ReadingSource): boolean {
  const ta = a.exported_at ?? "";
  const tb = b.exported_at ?? "";
  if (ta !== tb) return ta > tb;
  return (a.source_doc_id ?? 0) > (b.source_doc_id ?? 0);
}

function isAgentDerived(row: DocRow): boolean {
  return !row.file_path && !CCDA_DERIVED_TYPES.has(derivedType(row));
}

function dayOffset(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

// Same draw? The evidence has to be DISCRIMINATING: at least two agreeing
// readings of which one is a real analyte — or, between two records that are
// NOTHING BUT vitals (neither carries an analyte), a whole sheet of three or
// more agreeing; a DEXA or a lab panel never folds into a vitals sheet on its
// vitals alone — plus agreement outnumbering disagreement two to one and
// covering half of the smaller record. A day apart: only an agent-authored
// panel can drift a date, and it takes an analyte among two agreeing readings
// and no disagreement (two consecutive weigh-ins are two days, not one).
// The two deterministic CCDA streams of one export (results, vitals) are kept
// apart by design — a re-sync refreshes each by type.
export function sameDraw(a: DocRow, b: DocRow): boolean {
  const gap = Math.abs(dayOffset(a.doc_date, b.doc_date));
  if (gap > 1) return false;
  const ta = derivedType(a);
  const tb = derivedType(b);
  if (CCDA_DERIVED_TYPES.has(ta) && CCDA_DERIVED_TYPES.has(tb) && ta !== tb) return false;
  if (sameEncounter(a, b)) return true;
  const o = overlap(a, b);
  const smaller = Math.min(a.readings.size, b.readings.size);
  if (!smaller || o.agree * 2 < smaller) return false;
  if (gap === 0) {
    const evidence = (o.discriminating >= 1 && o.agree >= 2) || (o.agree >= 3 && pureVitals(a) && pureVitals(b));
    return evidence && o.agree >= o.conflict * 2;
  }
  return (isAgentDerived(a) || isAgentDerived(b)) && o.discriminating >= 1 && o.agree >= 2 && o.conflict === 0;
}

// The record the cluster folds into: the uploaded source row (it owns the file
// and the derived set), else the deterministic read, else the fullest panel,
// else the oldest — so ids the athlete already knows stay put.
function survivorRank(row: DocRow): number[] {
  return [
    row.file_path ? 1 : 0,
    row.children > 0 ? 1 : 0,
    CCDA_DERIVED_TYPES.has(derivedType(row)) ? 1 : 0,
    row.readings.size,
    -row.id,
  ];
}

function pickSurvivor(rows: DocRow[]): DocRow {
  return rows.reduce((best, row) => {
    const a = survivorRank(row);
    const b = survivorRank(best);
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] > b[i] ? row : best;
    }
    return best;
  });
}

function loadRows(includeId: number | null): DocRow[] {
  const rows = db
    .prepare(
      `SELECT d.id, d.kind, d.doc_date, d.source_doc_id, d.file_path, d.original_name, d.summary, d.parsed_json, d.created_at,
              (SELECT s.created_at FROM health_documents s WHERE s.id = d.source_doc_id) AS source_created_at,
              (SELECT s.enrichment_status FROM health_documents s WHERE s.id = d.source_doc_id) AS source_status,
              d.mime, d.enrichment_status AS status,
              (SELECT COUNT(*) FROM health_documents c WHERE c.source_doc_id = d.id) AS children
         FROM health_documents d
        WHERE d.kind != 'imaging'
          AND d.doc_date IS NOT NULL
          AND (COALESCE(d.enrichment_status, '') NOT IN ('pending', 'in_progress', 'running', 'pending_confirm') OR d.id = ?)
        ORDER BY d.doc_date, d.id`
    )
    .all(includeId ?? -1) as any[];
  const out: DocRow[] = [];
  for (const row of rows) {
    let parsed: any = null;
    try {
      parsed = row.parsed_json ? JSON.parse(row.parsed_json) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== "object") parsed = {};
    const markers = Array.isArray(parsed.markers) ? parsed.markers.filter((m: any) => m && typeof m === "object") : [];
    out.push({
      id: Number(row.id),
      kind: String(row.kind ?? "other"),
      doc_date: String(row.doc_date),
      source_doc_id: row.source_doc_id == null ? null : Number(row.source_doc_id),
      file_path: row.file_path ?? null,
      original_name: row.original_name ?? null,
      summary: row.summary ?? null,
      parsed,
      markers,
      readings: readingsOf(markers),
      children: Number(row.children ?? 0),
      created_at: row.created_at ?? null,
      source_created_at: row.source_created_at ?? null,
      mime: row.mime ?? null,
      status: String(row.status ?? ""),
      source_status: String(row.source_status ?? ""),
    });
  }
  return out;
}

function clustersOf(rows: DocRow[]): DocRow[][] {
  const parent = new Map<number, number>();
  const find = (id: number): number => {
    let cur = id;
    while (parent.get(cur) !== cur) cur = parent.get(cur)!;
    return cur;
  };
  for (const row of rows) parent.set(row.id, row.id);
  // rows are date-ordered, so once a candidate is more than a day away the
  // scan for this row can stop.
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i];
    if (!a.readings.size) continue;
    for (let j = i + 1; j < rows.length; j++) {
      const b = rows[j];
      if (dayOffset(b.doc_date, a.doc_date) > 1) break;
      if (!b.readings.size || !sameDraw(a, b)) continue;
      const ra = find(a.id);
      const rb = find(b.id);
      if (ra !== rb) parent.set(rb, ra);
    }
  }
  const groups = new Map<number, DocRow[]>();
  for (const row of rows) {
    const root = find(row.id);
    const group = groups.get(root) ?? [];
    group.push(row);
    groups.set(root, group);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

function touchesSource(row: DocRow, sourceId: number): boolean {
  return row.id === sourceId || row.source_doc_id === sourceId;
}

// A row whose read (or whose upload's read) is still running is left alone, unless
// it belongs to the upload this fold was scoped to: that ingest is the caller.
function busy(row: DocRow, scope: number | null): boolean {
  if (scope != null && touchesSource(row, scope)) return false;
  return BUSY.has(row.status) || BUSY.has(row.source_status);
}

function hasRefRange(marker: any): boolean {
  return marker && (marker.ref_low != null || marker.ref_high != null);
}

function readingOf(marker: any): Reading | null {
  const reading = comparableMarkerReading(marker);
  return reading ? { ...reading, marker } : null;
}

// The survivor's marker list after the twins fold in: its own readings keep
// their place; an analyte only a twin carried is appended; where both carry the
// same reading, the one that kept the lab's printed range wins the slot. Between
// two exports of one encounter a reading that DISAGREES goes to the later export,
// and the value it replaced is kept as superseded (whichever way round).
function mergedMarkers(
  survivor: DocRow,
  twins: DocRow[]
): { markers: any[]; added: number; superseded: SupersededReading[]; sources: Record<string, ReadingSource> | null } {
  // a fold is also the moment a survivor written before the non-analyte filter
  // sheds its "Lab Interpretation" rows
  const markers = survivor.markers.filter((marker) => markerReadingKey(marker) != null);
  const slot = new Map<string, number>();
  markers.forEach((marker, index) => {
    const key = markerReadingKey(marker);
    if (key && !slot.has(key)) slot.set(key, index);
  });
  let added = 0;
  const superseded: SupersededReading[] = [];
  // which row, and which export, each slot's standing value came from
  const holder = new Map<string, DocRow>();
  const standing = new Map<string, ReadingSource>();
  const sourceOf = (key: string): ReadingSource => standing.get(key) ?? readingSource(survivor, key);
  const anyEncounter = twins.some((twin) => sameEncounter(survivor, twin));
  for (const twin of twins) {
    const encounter = sameEncounter(survivor, twin);
    for (const marker of twin.markers) {
      const key = markerReadingKey(marker);
      if (!key) continue;
      const at = slot.get(key);
      if (at == null) {
        slot.set(key, markers.length);
        holder.set(key, twin);
        standing.set(key, readingSource(twin, key));
        markers.push(marker);
        added++;
        continue;
      }
      const current = readingOf(markers[at]);
      const incoming = readingOf(marker);
      if (encounter && current && incoming && !readingsAgree(current, incoming)) {
        // the later EXPORT wins, compared with the export of the value actually
        // standing in this slot (which may have come from an earlier fold)
        const owner = holder.get(key) ?? survivor;
        const mine = sourceOf(key);
        const theirs = readingSource(twin, key);
        const twinWins = laterSource(theirs, mine);
        const lost = twinWins ? markers[at] : marker;
        superseded.push({
          name: String(lost?.name ?? ""),
          value: lost?.value ?? null,
          unit: lost?.unit ?? null,
          from_doc_id: twinWins ? owner.id : twin.id,
          replaced_by_doc_id: twinWins ? twin.id : owner.id,
          from_source_doc_id: twinWins ? mine.source_doc_id : theirs.source_doc_id,
          key,
          marker: lost && typeof lost === "object" ? { ...lost } : undefined,
        });
        if (twinWins) {
          markers[at] = marker;
          holder.set(key, twin);
          standing.set(key, theirs);
        }
        continue;
      }
      if (hasRefRange(marker) && !hasRefRange(markers[at])) markers[at] = marker;
    }
  }
  // Provenance per slot whenever another upload contributes, so deleting that upload
  // can take back exactly what it brought (withdrawUploadReadings).
  const crossUpload = twins.some((twin) => twin.source_doc_id != null && twin.source_doc_id !== survivor.source_doc_id);
  let sources: Record<string, ReadingSource> | null = null;
  if (anyEncounter || crossUpload || survivor.parsed?.reading_sources) {
    sources = {};
    for (const key of slot.keys()) sources[key] = sourceOf(key);
    if (!Object.keys(sources).length) sources = null;
  }
  return { markers, added, superseded, sources };
}

// What it takes to file a twin again as it was, should the record it folded into
// go away with ITS upload while the twin's own upload is still on file
// (restoreOrphanedTwins, src/repo/health.ts). Never for a twin that owned a file
// (its file is deleted with it, and the survivor held every reading it had).
function twinSnapshot(row: DocRow): Record<string, any> | null {
  if (row.file_path) return null;
  const { merged_from: _merged, ...parsed } = row.parsed ?? {};
  return { kind: row.kind, doc_date: row.doc_date, summary: row.summary, original_name: row.original_name, parsed };
}

// The survivor's parsed record once `twins` fold into it.
function foldedParsed(
  survivor: DocRow,
  twins: DocRow[]
): { parsed: Record<string, any>; added: number; superseded: SupersededReading[] } {
  const { markers, added, superseded, sources } = mergedMarkers(survivor, twins);
  const parsed: Record<string, any> = { ...survivor.parsed, markers };
  if (sources) parsed.reading_sources = sources;
  const facts = unionFacts(survivor, twins);
  if (facts) parsed.clinical_facts = facts;
  // a twin's own fold history travels with it, so every export behind the survivor
  // can still be filed again if the survivor's own export goes
  parsed.merged_from = capMergedFrom([
    ...(Array.isArray(parsed.merged_from) ? parsed.merged_from : []),
    ...twins.flatMap((row) => [
      ...(Array.isArray(row.parsed?.merged_from) ? row.parsed.merged_from : []),
      {
        id: row.id,
        source_doc_id: row.source_doc_id,
        original_name: row.original_name,
        doc_date: row.doc_date,
        snapshot: twinSnapshot(row),
      },
    ]),
  ]);
  if (superseded.length) {
    // a re-read of an export folds the same replaced value again: noted once
    const seen = new Set<string>();
    const sig = (r: any) => JSON.stringify([r?.key ?? r?.name, r?.value, r?.unit ?? null, r?.from_source_doc_id ?? null]);
    parsed.superseded_readings = [
      ...(Array.isArray(parsed.superseded_readings) ? parsed.superseded_readings : []),
      ...superseded,
    ]
      .filter((r) => {
        const k = sig(r);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(-50);
  }
  return { parsed, added, superseded };
}

const MERGED_FROM_CAP = 20;

function uploadOnFile(id: unknown): boolean {
  return id != null && !!db.prepare(`SELECT 1 FROM health_documents WHERE id = ?`).get(Number(id));
}

// The fold history a survivor keeps: ONE entry per upload, draw and summary (the
// latest, since a re-read folds the same twin again), and never an entry a restore
// still needs (a snapshot of an upload still on file, or of a standalone record),
// whatever the cap: only entries nothing can restore from any more are evicted.
function capMergedFrom(entries: any[]): any[] {
  const byKey = new Map<string, any>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const snap = entry.snapshot;
    const key = snap
      ? `${entry.source_doc_id ?? `row${entry.id}`}|${snap.doc_date ?? entry.doc_date ?? ""}|${snap.summary ?? ""}`
      : `id${entry.id}`;
    byKey.delete(key); // re-insert so the latest keeps its place at the end
    byKey.set(key, entry);
  }
  const deduped = [...byKey.values()];
  if (deduped.length <= MERGED_FROM_CAP) return deduped;
  const needed = (e: any) => !!e.snapshot && (e.source_doc_id == null || uploadOnFile(e.source_doc_id));
  let excess = deduped.length - MERGED_FROM_CAP;
  return deduped.filter((e) => {
    if (excess > 0 && !needed(e)) {
      excess--;
      return false;
    }
    return true;
  });
}

// An upload is deleted: every OTHER record that folded readings from it takes them
// back. A slot whose standing value came from that upload gets the value it replaced
// back (the latest export still on file, from `superseded_readings`), or, when only
// that upload had the reading, loses it; superseded values from that upload and its
// fold-history entries go too. Exact per slot because a cross-upload fold records
// `reading_sources`; a fold from before that was recorded keeps its readings.
export function withdrawUploadReadings(uploadId: number): number {
  const id = Number(uploadId);
  if (!Number.isInteger(id)) return 0;
  const rows = db
    .prepare(
      `SELECT id, parsed_json FROM health_documents
        WHERE kind != 'imaging' AND COALESCE(source_doc_id, -1) != ?
          AND (parsed_json LIKE '%"reading_sources"%' OR parsed_json LIKE '%"merged_from"%')`
    )
    .all(id) as any[];
  const exportedAt = (sourceId: number): string | null =>
    ((db.prepare(`SELECT created_at FROM health_documents WHERE id = ?`).get(sourceId) as any)?.created_at as string) ?? null;
  let changed = 0;
  for (const row of rows) {
    let parsed: any = null;
    try {
      parsed = row.parsed_json ? JSON.parse(row.parsed_json) : null;
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const sources: Record<string, ReadingSource> = { ...(parsed.reading_sources ?? {}) };
    const mergedFrom: any[] = Array.isArray(parsed.merged_from) ? parsed.merged_from : [];
    const touched =
      Object.values(sources).some((src: any) => Number(src?.source_doc_id) === id) ||
      mergedFrom.some((e) => Number(e?.source_doc_id) === id);
    if (!touched) continue;
    let superseded: any[] = Array.isArray(parsed.superseded_readings) ? [...parsed.superseded_readings] : [];
    const markers: any[] = Array.isArray(parsed.markers) ? [...parsed.markers] : [];
    for (let i = markers.length - 1; i >= 0; i--) {
      const key = markerReadingKey(markers[i]);
      if (!key || Number(sources[key]?.source_doc_id) !== id) continue;
      // who else carried this reading: a value it replaced (superseded), or the same
      // reading in the snapshot of another export still on file; the latest export wins
      type Carrier = { sourceId: number; at: string; marker: any; superseded: any | null };
      const carriers: Carrier[] = [];
      for (const s of superseded) {
        if ((s?.key ?? markerReadingKey(s)) !== key || s?.from_source_doc_id == null) continue;
        const sourceId = Number(s.from_source_doc_id);
        const at = sourceId === id ? null : exportedAt(sourceId);
        if (at == null) continue;
        const marker = s.marker && typeof s.marker === "object" ? { ...s.marker } : { ...markers[i], value: s.value, unit: s.unit ?? null };
        carriers.push({ sourceId, at, marker, superseded: s });
      }
      for (const entry of mergedFrom) {
        const sourceId = Number(entry?.source_doc_id);
        if (!entry?.snapshot || !Number.isInteger(sourceId) || sourceId === id) continue;
        const at = exportedAt(sourceId);
        if (at == null) continue;
        const marker = (Array.isArray(entry.snapshot.parsed?.markers) ? entry.snapshot.parsed.markers : []).find(
          (m: any) => markerReadingKey(m) === key
        );
        if (marker) carriers.push({ sourceId, at, marker: { ...marker }, superseded: null });
      }
      carriers.sort((a, b) => (a.at === b.at ? b.sourceId - a.sourceId : a.at < b.at ? 1 : -1));
      const back = carriers[0];
      if (back) {
        markers[i] = back.marker;
        sources[key] = { source_doc_id: back.sourceId, exported_at: back.at };
        if (back.superseded) superseded = superseded.filter((s) => s !== back.superseded);
      } else {
        markers.splice(i, 1);
        delete sources[key];
      }
    }
    superseded = superseded.filter((s) => Number(s?.from_source_doc_id) !== id);
    const next: Record<string, any> = {
      ...parsed,
      markers,
      merged_from: mergedFrom.filter((e) => Number(e?.source_doc_id) !== id),
    };
    if (Object.keys(sources).length) next.reading_sources = sources;
    else delete next.reading_sources;
    if (superseded.length) next.superseded_readings = superseded;
    else delete next.superseded_readings;
    updateHealthDocFields(Number(row.id), { parsed_json: next });
    changed++;
  }
  return changed;
}

registerUploadWithdrawer(withdrawUploadReadings);

function parsedRowsReferencing(uploadId: number): Array<{ id: number; parsed: any }> {
  return (
    db
      .prepare(
        `SELECT id, parsed_json FROM health_documents
          WHERE kind != 'imaging' AND COALESCE(source_doc_id, -1) != ?
            AND (parsed_json LIKE '%"reading_sources"%' OR parsed_json LIKE '%"merged_from"%' OR parsed_json LIKE '%"superseded_readings"%')`
      )
      .all(uploadId) as any[]
  )
    .map((row) => {
      try {
        return { id: Number(row.id), parsed: JSON.parse(row.parsed_json) };
      } catch {
        return null;
      }
    })
    .filter((row): row is { id: number; parsed: any } => !!row && !!row.parsed && typeof row.parsed === "object");
}

// Does any other record's standing reading come from this upload?
function uploadStandsBehindReadings(uploadId: number): boolean {
  return parsedRowsReferencing(uploadId).some((row) =>
    Object.values(row.parsed.reading_sources ?? {}).some((src: any) => Number(src?.source_doc_id) === uploadId)
  );
}

// A duplicate upload the fold absorbed: every reference to it in other records (who a
// standing reading, a replaced value or a fold-history entry came from) now names the
// survivor's upload, so nothing it brought is ever taken back on its account.
function repointUpload(fromId: number, toId: number): void {
  if (fromId === toId) return;
  for (const row of parsedRowsReferencing(fromId)) {
    const parsed = row.parsed;
    let moved = false;
    const sources = parsed.reading_sources && typeof parsed.reading_sources === "object" ? parsed.reading_sources : null;
    if (sources) {
      for (const src of Object.values(sources) as any[]) {
        if (Number(src?.source_doc_id) === fromId) {
          src.source_doc_id = toId;
          moved = true;
        }
      }
    }
    for (const s of Array.isArray(parsed.superseded_readings) ? parsed.superseded_readings : []) {
      if (Number(s?.from_source_doc_id) === fromId) {
        s.from_source_doc_id = toId;
        moved = true;
      }
    }
    for (const e of Array.isArray(parsed.merged_from) ? parsed.merged_from : []) {
      if (Number(e?.source_doc_id) === fromId) {
        e.source_doc_id = toId;
        moved = true;
      }
    }
    if (moved) db.prepare(`UPDATE health_documents SET parsed_json = ? WHERE id = ?`).run(JSON.stringify(parsed), row.id);
  }
}

function recordLabel(row: { summary?: string | null; original_name?: string | null }): string | null {
  const text = String(row.summary || row.original_name || "")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 120) : null;
}

// Why these folded, in the athlete's words.
function foldReason(rule: DedupeRule, survivor: DocRow, superseded: SupersededReading[]): string {
  if (rule === "same_encounter") {
    const stamp = encounterStamp(survivor);
    const visit = stamp ? `The same clinic visit (${stamp})` : "The same clinic visit";
    return superseded.length
      ? `${visit} came in more than one export. Where the exports differ, the later export's reading is kept and the earlier one is noted.`
      : `${visit} came in more than one export.`;
  }
  return "The same date and the same readings, filed more than once.";
}

function unionFacts(survivor: DocRow, twins: DocRow[]): any[] | undefined {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const row of [survivor, ...twins]) {
    for (const fact of Array.isArray(row.parsed.clinical_facts) ? row.parsed.clinical_facts : []) {
      const sig = JSON.stringify(fact);
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(fact);
    }
  }
  return out.length ? out : undefined;
}

// A twin folds only when it agrees with the SURVIVOR itself (a cluster chains
// through pairwise agreement, and a record that agrees with a twin but not the
// survivor is not the survivor's draw); never when it split out derived panels
// of its own; and, when it owns an uploaded file, only when the survivor
// already holds every reading it has — an identical second upload.
function foldableTwins(survivor: DocRow, group: DocRow[], scope: number | null, allow?: FoldAllowList): DocRow[] {
  return group.filter((row) => {
    if (row.id === survivor.id || row.children > 0) return false;
    if (busy(row, scope)) return false;
    if (allow && !allow.has(`${survivor.id}:${row.id}`)) return false;
    if (!sameDraw(survivor, row)) return false;
    if (!row.file_path) return true;
    const o = overlap(survivor, row);
    if (o.twinOnly !== 0 || o.conflict !== 0) return false;
    // an upload that still stands behind a reading in another record (its derived panel
    // folded there and brought something) holds what the survivor lacks: its file stays
    return !uploadStandsBehindReadings(row.id);
  });
}

interface Fold {
  survivor: DocRow;
  twins: DocRow[];
  parsed: Record<string, any>;
  summary: string | null;
  added: number;
  superseded: SupersededReading[];
}

// One pass over an in-memory record set: the folds it would make, and the set
// as it stands after them (survivors carrying their merged readings, twins
// gone) — so the next pass, and a dry run, see the same state a real fold
// would leave behind.
function foldPass(
  rows: DocRow[],
  scopeSourceId: number | null,
  allow?: FoldAllowList
): { folds: Fold[]; rows: DocRow[] } {
  let clusters = clustersOf(rows);
  if (scopeSourceId != null) clusters = clusters.filter((group) => group.some((row) => touchesSource(row, scopeSourceId)));
  const folds: Fold[] = [];
  const gone = new Set<number>();
  const replaced = new Map<number, DocRow>();
  for (const group of clusters) {
    const survivor = pickSurvivor(group);
    if (busy(survivor, scopeSourceId)) continue;
    const twins = foldableTwins(survivor, group, scopeSourceId, allow);
    if (!twins.length) continue;
    const { parsed, added, superseded } = foldedParsed(survivor, twins);
    const markers = parsed.markers as any[];
    const summary = survivor.summary ?? twins.find((row) => row.summary)?.summary ?? null;
    folds.push({ survivor, twins, parsed, summary, added, superseded });
    for (const twin of twins) gone.add(twin.id);
    replaced.set(survivor.id, { ...survivor, parsed, markers, summary, readings: readingsOf(markers) });
  }
  const next = rows.filter((row) => !gone.has(row.id)).map((row) => replaced.get(row.id) ?? row);
  return { folds, rows: next };
}

// What a fold removes besides the twin record, in plain words for the plan.
function removesNote(removes: DedupeClusterPlan["removes"]): string | null {
  if (!removes.length) return null;
  const pastes = removes.filter((r) => r.what === "paste").length;
  const files = removes.length - pastes;
  const parts: string[] = [];
  if (files) parts.push(files === 1 ? "a duplicate uploaded file" : `${files} duplicate uploaded files`);
  if (pastes) parts.push(pastes === 1 ? "a duplicate pasted report" : `${pastes} duplicate pasted reports`);
  return `Merging also removes ${parts.join(" and ")}; the record that stays holds the same content.`;
}

export function imagingClusterPlan(fold: ImagingDedupeFold): DedupeClusterPlan {
  const removes = fold.merged
    .filter((twin) => twin.removed_source && twin.source_doc_id != null)
    .map((twin) => ({ id: Number(twin.source_doc_id), what: (twin.pasted_source ? "paste" : "file") as "paste" | "file", label: twin.label }));
  return {
    date: fold.date,
    survivor: { id: fold.survivor.id, kind: "imaging", doc_date: fold.date, markers: 0, label: fold.survivor.label },
    merged: fold.merged.map((twin) => ({
      id: twin.id,
      kind: "imaging",
      doc_date: fold.date,
      markers: 0,
      source_doc_id: twin.source_doc_id,
      file: twin.removed_source,
      label: twin.label,
    })),
    added_markers: 0,
    rule: fold.rule,
    reason:
      fold.rule === "same_scan_judged"
        ? `The same scan, read twice in different words.${fold.judged_reason ? ` ${fold.judged_reason}` : ""}`
        : "The same scan: same day, procedure and impression.",
    superseded: [],
    removes,
    removes_note: removesNote(removes),
  };
}

const MAX_PASSES = 6;

export function dedupeHealthDocuments(opts: DedupeOptions = {}): DedupeHealthDocumentsResult {
  const dryRun = opts.dryRun === true;
  const scope = opts.scopeSourceId == null ? null : Number(opts.scopeSourceId);
  let rows = loadRows(scope);
  const result: DedupeHealthDocumentsResult = {
    dry_run: dryRun,
    scanned: rows.length,
    passes: 0,
    clusters: [],
    merged: 0,
    added_markers: 0,
    deleted_files: 0,
    errors: [],
    converged: false,
  };
  const clusterPlan = (fold: Fold, twins: DocRow[], added: number, superseded: SupersededReading[]): DedupeClusterPlan => {
    const rule: DedupeRule = twins.some((row) => sameEncounter(fold.survivor, row)) ? "same_encounter" : "same_draw";
    const removes = twins
      .filter((row) => !!row.file_path)
      .map((row) => ({
        id: row.id,
        what: (/^text\/plain/i.test(row.mime ?? "") ? "paste" : "file") as "paste" | "file",
        label: recordLabel(row),
      }));
    return {
      date: fold.survivor.doc_date,
      survivor: {
        id: fold.survivor.id,
        kind: fold.survivor.kind,
        doc_date: fold.survivor.doc_date,
        markers: fold.survivor.markers.length,
        label: recordLabel(fold.survivor),
      },
      merged: twins.map((row) => ({
        id: row.id,
        kind: row.kind,
        doc_date: row.doc_date,
        markers: row.markers.length,
        source_doc_id: row.source_doc_id,
        file: !!row.file_path,
        label: recordLabel(row),
      })),
      added_markers: added,
      rule,
      reason: foldReason(rule, fold.survivor, superseded),
      superseded,
      removes,
      removes_note: removesNote(removes),
    };
  };
  for (let pass = 0; pass < MAX_PASSES && !result.errors.length; pass++) {
    const step = foldPass(rows, scope, opts.allow);
    if (!step.folds.length) {
      result.converged = true;
      break;
    }
    result.passes++;
    for (const fold of step.folds) {
      if (result.errors.length) break;
      if (!dryRun) {
        // Twins go first, through the full delete path (owned file of an
        // identical second upload, the measured-RMR anchor, marker-series
        // version, brain signals). A twin that will not go — its file refuses
        // to be removed — is not folded: the survivor is left untouched and
        // the pass stops, so the record never claims a merge it did not make.
        const kept: DocRow[] = [];
        for (const twin of fold.twins) {
          // a fold's delete never withdraws: what this twin brought elsewhere stays,
          // re-pointed to the survivor's upload
          const deleted = deleteHealthDocument(twin.id, { withdraw: false }) as any;
          if (deleted?.deleted) repointUpload(twin.id, fold.survivor.file_path ? fold.survivor.id : (fold.survivor.source_doc_id ?? fold.survivor.id));
          if (deleted?.error || !deleted?.deleted) {
            result.errors.push(`health#${twin.id}: ${deleted?.error ?? "not deleted"}`);
            break;
          }
          kept.push(twin);
          if (twin.file_path) result.deleted_files++;
        }
        if (kept.length < fold.twins.length) {
          if (kept.length) {
            const partial = foldedParsed(fold.survivor, kept);
            updateHealthDocFields(fold.survivor.id, { parsed_json: partial.parsed, summary: fold.survivor.summary ?? kept.find((row) => row.summary)?.summary ?? null });
            result.clusters.push(clusterPlan(fold, kept, partial.added, partial.superseded));
            result.merged += kept.length;
            result.added_markers += partial.added;
          }
          break;
        }
        updateHealthDocFields(fold.survivor.id, { parsed_json: fold.parsed, summary: fold.summary });
      }
      result.clusters.push(clusterPlan(fold, fold.twins, fold.added, fold.superseded));
      result.merged += fold.twins.length;
      result.added_markers += fold.added;
    }
    rows = step.rows;
  }
  // One study per scan: the imaging twins fold by their own identity (same day,
  // procedure and impression — src/repo/imaging-dedupe.ts), reported through the
  // same plan so the route's dry run shows both. Only on the whole-record pass:
  // the ingest hook runs while its own upload is still mid-read, and folding a
  // study there could remove that very upload under the running ingest (an
  // identical re-upload never reaches an ingest — the upload route stops it).
  //
  // Then the near-twins an agent already judged the same study (a remembered
  // verdict, high confidence, no measurement disagreeing): deterministic given
  // the verdicts, so a dry run and the fold it plans agree. No agent runs here.
  if (!result.errors.length && scope == null) {
    const absorb = (imaging: ImagingDedupeResult) => {
      for (const fold of imaging.folds) result.clusters.push(imagingClusterPlan(fold));
      result.merged += imaging.merged;
      result.deleted_files += imaging.deleted_files;
      result.errors.push(...imaging.errors);
    };
    const strict = dedupeImagingStudies({ dryRun, allow: opts.allow });
    absorb(strict);
    if (!result.errors.length) {
      // a dry run leaves the strict twins in place: never plan one twice
      const exclude = new Set(strict.folds.flatMap((fold) => fold.merged.map((twin) => twin.id)));
      absorb(foldJudgedImagingTwins({ dryRun, exclude, allow: opts.allow }));
    }
  }
  if (result.errors.length) result.converged = false;
  return result;
}
