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
// It runs after every health ingest, scoped to what that import touched, and
// on demand across the whole record set (the route / MCP tool).

import { db } from "../db.js";
import { canonicalMarkerForReading, isNonAnalyteMarkerName, normalizeMarkerName } from "./marker-canon.js";
import { deleteHealthDocument, updateHealthDocFields } from "./health.js";

export const CCDA_DERIVED_TYPES = new Set(["ccda_results", "ccda_vitals"]);

// Readings any two same-day records may share WITHOUT being the same draw: the
// athlete's body at the clinic that morning, printed on the DEXA, the vitals
// sheet and the lab requisition alike. They corroborate a match; they never
// make one on their own. Matched by word against the canonical key, so every
// spelling the canon produces ("body temperature", "o2 sat", "weight lb") is
// caught, not only the ones listed here.
const NON_DISCRIMINATING_KEY =
  /\b(weight|height|body mass index|bmi|pulse|heart rate|systolic|diastolic|blood pressure|bp|temperature|temp|respiratory rate|respiration|respirations|oxygen saturation|o2 sat|o2 saturation|spo2)\b/;

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
}

interface Reading {
  value: string; // comparable form
  marker: any; // the stored marker object
}

export interface DedupeClusterPlan {
  date: string;
  survivor: { id: number; kind: string; doc_date: string; markers: number };
  merged: Array<{ id: number; kind: string; doc_date: string; markers: number; source_doc_id: number | null; file: boolean }>;
  added_markers: number;
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

function readingsAgree(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.startsWith("n:") && b.startsWith("n:")) {
    const x = Number(a.slice(2));
    const y = Number(b.slice(2));
    const scale = Math.max(Math.abs(x), Math.abs(y));
    return scale === 0 ? x === y : Math.abs(x - y) <= scale * 0.005;
  }
  return false;
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
    const value = comparableReading(marker?.value);
    if (!key || value == null || out.has(key)) continue;
    out.set(key, { value, marker });
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
    if (readingsAgree(reading.value, other.value)) {
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
      `SELECT d.id, d.kind, d.doc_date, d.source_doc_id, d.file_path, d.original_name, d.summary, d.parsed_json,
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

function hasRefRange(marker: any): boolean {
  return marker && (marker.ref_low != null || marker.ref_high != null);
}

// The survivor's marker list after the twins fold in: its own readings keep
// their place; an analyte only a twin carried is appended; where both carry the
// same reading, the one that kept the lab's printed range wins the slot.
function mergedMarkers(survivor: DocRow, twins: DocRow[]): { markers: any[]; added: number } {
  const markers = survivor.markers.slice();
  const slot = new Map<string, number>();
  markers.forEach((marker, index) => {
    const key = markerReadingKey(marker);
    if (key && !slot.has(key)) slot.set(key, index);
  });
  let added = 0;
  for (const twin of twins) {
    for (const marker of twin.markers) {
      const key = markerReadingKey(marker);
      if (!key) continue;
      const at = slot.get(key);
      if (at == null) {
        slot.set(key, markers.length);
        markers.push(marker);
        added++;
        continue;
      }
      if (hasRefRange(marker) && !hasRefRange(markers[at])) markers[at] = marker;
    }
  }
  return { markers, added };
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
function foldableTwins(survivor: DocRow, group: DocRow[]): DocRow[] {
  return group.filter((row) => {
    if (row.id === survivor.id || row.children > 0) return false;
    if (!sameDraw(survivor, row)) return false;
    if (!row.file_path) return true;
    const o = overlap(survivor, row);
    return o.twinOnly === 0 && o.conflict === 0;
  });
}

interface Fold {
  survivor: DocRow;
  twins: DocRow[];
  parsed: Record<string, any>;
  summary: string | null;
  added: number;
}

// One pass over an in-memory record set: the folds it would make, and the set
// as it stands after them (survivors carrying their merged readings, twins
// gone) — so the next pass, and a dry run, see the same state a real fold
// would leave behind.
function foldPass(rows: DocRow[], scopeSourceId: number | null): { folds: Fold[]; rows: DocRow[] } {
  let clusters = clustersOf(rows);
  if (scopeSourceId != null) clusters = clusters.filter((group) => group.some((row) => touchesSource(row, scopeSourceId)));
  const folds: Fold[] = [];
  const gone = new Set<number>();
  const replaced = new Map<number, DocRow>();
  for (const group of clusters) {
    const survivor = pickSurvivor(group);
    const twins = foldableTwins(survivor, group);
    if (!twins.length) continue;
    const { markers, added } = mergedMarkers(survivor, twins);
    const parsed: Record<string, any> = { ...survivor.parsed, markers };
    const facts = unionFacts(survivor, twins);
    if (facts) parsed.clinical_facts = facts;
    const provenance = Array.isArray(parsed.merged_from) ? parsed.merged_from : [];
    parsed.merged_from = [
      ...provenance,
      ...twins.map((row) => ({ id: row.id, source_doc_id: row.source_doc_id, original_name: row.original_name, doc_date: row.doc_date })),
    ].slice(-20);
    const summary = survivor.summary ?? twins.find((row) => row.summary)?.summary ?? null;
    folds.push({ survivor, twins, parsed, summary, added });
    for (const twin of twins) gone.add(twin.id);
    replaced.set(survivor.id, { ...survivor, parsed, markers, summary, readings: readingsOf(markers) });
  }
  const next = rows.filter((row) => !gone.has(row.id)).map((row) => replaced.get(row.id) ?? row);
  return { folds, rows: next };
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
  const clusterPlan = (fold: Fold, twins: DocRow[], added: number): DedupeClusterPlan => ({
    date: fold.survivor.doc_date,
    survivor: { id: fold.survivor.id, kind: fold.survivor.kind, doc_date: fold.survivor.doc_date, markers: fold.survivor.markers.length },
    merged: twins.map((row) => ({
      id: row.id,
      kind: row.kind,
      doc_date: row.doc_date,
      markers: row.markers.length,
      source_doc_id: row.source_doc_id,
      file: !!row.file_path,
    })),
    added_markers: added,
  });
  for (let pass = 0; pass < MAX_PASSES && !result.errors.length; pass++) {
    const step = foldPass(rows, scope);
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
          const deleted = deleteHealthDocument(twin.id) as any;
          if (deleted?.error || !deleted?.deleted) {
            result.errors.push(`health#${twin.id}: ${deleted?.error ?? "not deleted"}`);
            break;
          }
          kept.push(twin);
          if (twin.file_path) result.deleted_files++;
        }
        if (kept.length < fold.twins.length) {
          if (kept.length) {
            const partial = mergedMarkers(fold.survivor, kept);
            const parsed: Record<string, any> = { ...fold.survivor.parsed, markers: partial.markers };
            const facts = unionFacts(fold.survivor, kept);
            if (facts) parsed.clinical_facts = facts;
            parsed.merged_from = [
              ...(Array.isArray(parsed.merged_from) ? parsed.merged_from : []),
              ...kept.map((row) => ({ id: row.id, source_doc_id: row.source_doc_id, original_name: row.original_name, doc_date: row.doc_date })),
            ].slice(-20);
            updateHealthDocFields(fold.survivor.id, { parsed_json: parsed, summary: fold.survivor.summary ?? kept.find((row) => row.summary)?.summary ?? null });
            result.clusters.push(clusterPlan(fold, kept, partial.added));
            result.merged += kept.length;
            result.added_markers += partial.added;
          }
          break;
        }
        updateHealthDocFields(fold.survivor.id, { parsed_json: fold.parsed, summary: fold.summary });
      }
      result.clusters.push(clusterPlan(fold, fold.twins, fold.added));
      result.merged += fold.twins.length;
      result.added_markers += fold.added;
    }
    rows = step.rows;
  }
  if (result.errors.length) result.converged = false;
  return result;
}
