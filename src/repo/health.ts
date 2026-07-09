import { db } from "../db.js";
import { emitEnrichTransition } from "../enrichBus.js";
import { inferHealthDocumentKind, normalizeHealthDocumentKind } from "../healthDocumentKinds.js";
import { activeTimeZone } from "../tz.js";
import { invalidateDayRead } from "./intelligence.js";
import { daysBetweenISO, localDateISO } from "./shared.js";
import { listExercises } from "./exercises.js";
import { normalizeMarkerReading, parseLabNumber, seriesUnitsCompatible } from "./lab-units.js";
import { canonicalMarker, canonicalMarkerForReading } from "./marker-canon.js";
import { bumpMarkerDataVersion, currentMarkerDataVersion, resetMarkerDataVersion } from "./marker-cache.js";
import { bumpTrainingDataVersion } from "./training-cache.js";
import { capStr } from "./nutrition.js";
import { getPlan } from "./plan.js";
import { getProfile, listWeight } from "./profile.js";
import { matchClinicalReferenceRange } from "./reference-ranges.js";
import { getSettings, pickHealthAgentOrder } from "./settings.js";
import { type OptimalZone, applyReviewDirectives, isNonClinicalMarker, markerGroup, matchOptimalZone, optimalDistance, presentGroups } from "./propagation.js";

// A modern comprehensive panel (e.g. Function Health) lists 100+ markers. Cap
// generously so a complete transcription is never silently clipped, while still
// bounding a runaway/garbage response. Shared by both the in-place enrich apply
// path (enrich.ts cleanMarkers) and the derived-panel writer below.
export const MAX_MARKERS_PER_PANEL = 250;
export const MAX_CLINICAL_FACTS_PER_DOC = 200;

const CLINICAL_FACT_KINDS = new Set([
  "condition",
  "medication",
  "allergy",
  "procedure",
  "immunization",
  "encounter",
  "family_history",
  "social_history",
  "care_team",
  "other",
]);

export function cleanClinicalFacts(raw: any, max = MAX_CLINICAL_FACTS_PER_DOC): any[] {
  const out: any[] = [];
  const seen = new Set<string>();
  for (const f of Array.isArray(raw) ? raw : []) {
    if (!f || typeof f !== "object") continue;
    const kindRaw = String(f.kind ?? "").trim();
    const kind = CLINICAL_FACT_KINDS.has(kindRaw) ? kindRaw : "other";
    const name = capStr(f.name, 180);
    if (!name) continue;
    const dateRaw = String(f.date ?? "").trim();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : null;
    const status = capStr(f.status, 80);
    const detail = capStr(f.detail, 500);
    const source = capStr(f.source, 160);
    const key = [kind, date ?? "", name.toLowerCase(), (status ?? "").toLowerCase(), (detail ?? "").toLowerCase()].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind,
      date,
      name,
      status: status ?? null,
      detail: detail ?? null,
      source: source ?? null,
    });
    if (out.length >= max) break;
  }
  return out;
}

// Active medications the user is on, read from the clinical_facts extracted out of
// uploaded health records (a MyChart/CCDA medication list, kind === 'medication'). This
// is the ONLY place meds are captured — there is NO meds CRUD — so it degrades to [] when
// no uploaded record carries a medication section. Deduped by name (most-recent record
// wins), with clearly inactive/discontinued entries dropped. Names are returned verbatim
// for the connected brain to reason WITH (e.g. an off-optimal marker despite a medication
// that targets it). INFORMATIONAL, never a prescription.
const INACTIVE_MED_STATUS = /\b(discontinued|inactive|stopped|resolved|completed|historical|no longer|d\/c'?d|expired|held)\b/i;
export function activeMedications(): Array<{ name: string; status: string | null; date: string | null }> {
  const rows = db
    .prepare(
      `SELECT doc_date, created_at, parsed_json FROM health_documents
       ORDER BY COALESCE(doc_date, substr(created_at, 1, 10)) DESC, id DESC`
    )
    .all() as any[];
  const byName = new Map<string, { name: string; status: string | null; date: string | null }>();
  for (const row of rows) {
    let parsed: any = null;
    try { parsed = row.parsed_json ? JSON.parse(row.parsed_json) : null; } catch { continue; }
    for (const f of cleanClinicalFacts(parsed?.clinical_facts, 500)) {
      if (f.kind !== "medication") continue;
      if (f.status && INACTIVE_MED_STATUS.test(f.status)) continue;
      const key = f.name.toLowerCase();
      if (!byName.has(key)) byName.set(key, { name: f.name, status: f.status ?? null, date: f.date ?? null }); // DESC order → first seen is most recent
    }
  }
  return [...byName.values()];
}

function isNonResultMarkerValue(value: unknown): boolean {
  const v = String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!v) return true;
  return /^(?:tnp(?:\s+index)?|test not performed|not performed|not tested|not done|cancelled|canceled|not run)$/i.test(v);
}

function isAnthropometricMarkerKey(key: string): boolean {
  return key === "body weight" || key === "height";
}

// Coarse, provider-agnostic estimate of how many results a pasted lab panel
// contains. Used ONLY to DETECT a grossly incomplete extraction (a model that
// curated 111 markers down to 44) so the ingest path can re-run with a stricter
// prompt — it is never used to build markers. Counts "value lines": a marker's
// value sits on its own line and starts with a number/comparator, or is one of a
// small set of qualitative results. Section headers and marker NAMES start with a
// letter (and aren't in the qualitative set), and the "In/Above/Below Range" flag
// lines are deliberately excluded — so this approximates one count per marker.
// Deliberately rough (±20% is fine for "is this way short?"); never exact.
// Deliberately excludes flag-ish words (in/above/below range, normal) so a flag
// line is not mistaken for a value line and double-counted.
const QUALITATIVE_RESULT =
  /^(negative|positive|none seen|not seen|detected|not detected|reactive|non[- ]?reactive|clear|cloudy|hazy|turbid|yellow|colorless|straw|amber|trace|rh\(d\)|a|b|ab|o)\b/i;

export function estimateMarkerCandidates(text: string): number {
  if (!text || typeof text !== "string") return 0;
  let n = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // A value line: starts with a number, sign, comparator or decimal point…
    if (/^[<>≤≥=]?\s*[+-]?(\d|\.\d)/.test(line)) { n++; continue; }
    // …or is a short qualitative result (not a flag word, not a sentence).
    if (line.length <= 24 && QUALITATIVE_RESULT.test(line)) n++;
  }
  return n;
}

function clampInt(value: any, min: number, max: number): number | null {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

// ---------- numeric plausibility / unit guard at lab ingest (defensive) ----------
// A transcription typo (glucose 5000 mg/dL) or a unit mix-up (cholesterol entered in
// mmol/L against a mg/dL band) would otherwise propagate a clinically-WRONG directive
// through the connected brain. This is a CONSERVATIVE last-line guard: it flags ONLY
// clear physiologic impossibilities — a negative, or a value an order of magnitude
// beyond anything a real lab reports — using GENEROUS per-analyte ceilings that sit
// well past the worst real disease value, so a merely-unusual-but-real reading is never
// rejected. Unit-aware: when a recognized marker carries a CONVERTIBLE unit, the value
// is converted to the band's expected unit FIRST (so a "200 mmol/L" LDL is judged as the
// ~7700 mg/dL it really is, and caught). Markers with no known family are left untouched —
// we never reject what we don't understand. It NEVER mutates a value; the caller simply
// SKIPS an implausible reading so it can't reach getMarkerHistory / deriveDirectives.
//
// Bounds are [floor, ceiling] in the analyte's optimal-zone unit. Floors are mostly 0,
// so the floor's real job is rejecting an impossible NEGATIVE; ceilings sit far beyond
// the worst real value, so only a typo / unit error trips them.
const MARKER_PLAUSIBILITY: Record<string, [number, number]> = {
  "ApoB": [0, 400],
  "LDL-C": [0, 600],
  "Non-HDL-C": [0, 700],
  "Triglycerides": [0, 15000],
  "HDL-C": [0, 250],
  "Total cholesterol": [0, 900],
  "hs-CRP": [0, 600],
  "Homocysteine": [0, 300],
  "HbA1c": [0, 25],
  "Fasting glucose": [0, 3000],
  "Fasting insulin": [0, 2000],
  "Ferritin": [0, 100000],
  "Vitamin D": [0, 400],
  "eGFR": [0, 250],
  "Creatinine": [0, 50],
  "ALT": [0, 20000],
  "AST": [0, 20000],
  "GGT": [0, 20000],
  "TSH": [0, 500],
  "Free T3": [0, 60],
  "Free T4": [0, 30],
  "Vitamin B12": [0, 50000],
  "Folate": [0, 200],
  "Magnesium": [0, 20],
  "Testosterone": [0, 5000],
  "Estradiol": [0, 10000],
  "Lp(a)": [0, 2000],
  "Uric acid": [0, 50],
  "Body fat": [0, 80],
  "Mercury": [0, 1000],
  "Systolic BP": [30, 350],
  "Diastolic BP": [15, 250],
  "VO2max": [0, 120],
  "Resting HR": [10, 300],
  "HRV": [0, 600],
};

export interface MarkerPlausibility {
  plausible: boolean;
  reason: string | null;
  value: number | null; // the parsed number, for the caller's convenience (null = non-numeric)
}

function roundForMsg(n: number): number {
  const a = Math.abs(n);
  return a >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
}

// Conservative physiologic-plausibility check for ONE marker reading. Returns
// plausible:true for anything qualitative (non-numeric, e.g. "Negative") or any analyte
// family we don't recognize — we only ever REJECT a clear impossibility. Unit-aware when
// the marker is recognized + the unit is convertible.
export function plausibleMarkerValue(name: string, value: unknown, unit?: string | null): MarkerPlausibility {
  const num = parseLabNumber(value);
  if (num === null) return { plausible: true, reason: null, value: null }; // qualitative / empty — not judged
  if (!Number.isFinite(num)) return { plausible: false, reason: "value is not a finite number", value: null };
  const zone = matchOptimalZone(name);
  const bounds = zone ? MARKER_PLAUSIBILITY[zone.label] : null;
  // Unknown analyte family → no defensible bounds, so accept (never reject what we don't
  // understand). A non-finite was already caught above.
  if (!zone || !bounds) return { plausible: true, reason: null, value: num };

  // Convert to the band's expected unit when the unit is recognized + convertible, so a
  // unit mix-up surfaces as the absurd magnitude it really is. When the unit can't be
  // safely converted (an incompatible family, e.g. Lp(a) mg/dL vs nmol/L) we judge sign
  // only — never magnitude — so we can't false-reject an un-convertible-but-real value.
  let v = num;
  let comparable = true;
  if (unit != null && String(unit).trim()) {
    const norm = normalizeMarkerReading(name, value, String(unit), zone);
    if (norm && typeof norm.value === "number") {
      if (norm.unit_mismatch) comparable = false; // couldn't safely convert → don't magnitude-judge
      else v = norm.value;                         // expected-unit value (possibly converted)
    }
  }

  const [floor, ceil] = bounds;
  // Sign is universally meaningful across every family here (all are non-negative).
  if (num < 0 || v < 0) return { plausible: false, reason: `${zone.label} can't be negative (${num})`, value: num };
  if (!comparable) return { plausible: true, reason: null, value: num };
  if (v < floor) return { plausible: false, reason: `${zone.label} ${roundForMsg(v)} sits below any physiologic value`, value: num };
  if (v > ceil) return { plausible: false, reason: `${zone.label} ${roundForMsg(v)} exceeds any physiologic value — likely a unit or transcription error`, value: num };
  return { plausible: true, reason: null, value: num };
}

function localTimeHMS(d: Date): string {
  const tz = activeTimeZone();
  if (!tz) return d.toTimeString().slice(0, 8);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(d);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "00";
    return `${part("hour")}:${part("minute")}:${part("second")}`;
  } catch {
    return d.toTimeString().slice(0, 8);
  }
}

function normalizeBpInput(input: {
  measured_at?: string | null;
  systolic: number;
  diastolic: number;
  pulse?: number | string | null;
  source?: string | null;
  position?: string | null;
  note?: string | null;
}) {
  const systolic = clampInt(input?.systolic, 60, 260);
  const diastolic = clampInt(input?.diastolic, 35, 160);
  if (systolic == null || diastolic == null) throw new Error("systolic and diastolic BP required");
  if (diastolic >= systolic) throw new Error("diastolic must be below systolic");
  const pulse = input.pulse == null || input.pulse === "" ? null : clampInt(input.pulse, 25, 240);
  const source = capStr(String(input.source ?? "manual").trim() || "manual", 40) ?? "manual";
  const position = capStr(input.position, 40);
  const note = capStr(input.note, 240);
  const measured_at = normalizeBpMeasuredAt(input.measured_at);
  return { measured_at, systolic, diastolic, pulse, source, position, note };
}

export function normalizeBpMeasuredAt(input?: string | null, now = new Date()): string {
  const raw = String(input ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw} 12:00:00`;
  const dt = raw.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?/);
  if (dt) return `${dt[1]} ${dt[2]}:${dt[3] ?? "00"}`;
  return `${localDateISO(now)} ${localTimeHMS(now)}`;
}

export function addBloodPressureReading(input: {
  measured_at?: string | null;
  systolic: number;
  diastolic: number;
  pulse?: number | string | null;
  source?: string | null;
  position?: string | null;
  note?: string | null;
}) {
  const row = normalizeBpInput(input);
  const info = db.prepare(
    `INSERT INTO blood_pressure_readings (measured_at, systolic, diastolic, pulse, source, position, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(row.measured_at, row.systolic, row.diastolic, row.pulse, row.source, row.position, row.note);
  bumpMarkerHistoryVersion(); // BP readings feed getMarkerHistory's Systolic/Diastolic/Pulse series
  return db.prepare(`SELECT * FROM blood_pressure_readings WHERE id = ?`).get(info.lastInsertRowid);
}

export function upsertBloodPressureReading(input: {
  measured_at?: string | null;
  systolic: number;
  diastolic: number;
  pulse?: number | string | null;
  source?: string | null;
  position?: string | null;
  note?: string | null;
}): { row: any; created: boolean } {
  const row = normalizeBpInput(input);
  const existing = db
    .prepare(
      `SELECT * FROM blood_pressure_readings
        WHERE measured_at = ?
          AND systolic = ?
          AND diastolic = ?
          AND COALESCE(pulse, -1) = COALESCE(?, -1)
          AND source = ?
        ORDER BY id ASC
        LIMIT 1`
    )
    .get(row.measured_at, row.systolic, row.diastolic, row.pulse, row.source);
  if (existing) return { row: existing, created: false };
  const inserted = addBloodPressureReading(row);
  return { row: inserted, created: true };
}

export function listBloodPressureReadings(limit = 60) {
  return db
    .prepare(`SELECT * FROM blood_pressure_readings ORDER BY measured_at DESC, id DESC LIMIT ?`)
    .all(Math.max(1, Math.min(500, Math.round(Number(limit) || 60)))) as any[];
}

export function deleteBloodPressureReading(id: number) {
  const ok = db.prepare(`DELETE FROM blood_pressure_readings WHERE id = ?`).run(id).changes > 0;
  if (ok) bumpMarkerHistoryVersion();
  return { ok };
}

// A plain-language read of blood pressure: where the latest reading sits against the
// calm home target, and which way the trend has moved. Optimal-zone framing, no score —
// answers the "is this a good one?" question the bare number never does, and surfaces an
// improving trend (e.g. 144→113) as the real win it is. `rows` come newest-first.
export type BpCategory = "optimal" | "elevated" | "high" | "low";
export function bpRead(rows: any[]): {
  latest: any | null;
  category: BpCategory | null;
  label: string;
  tone: "strong" | "steady" | "watch";
  trajectory: { from: { systolic: number; diastolic: number; at: string | null }; to: { systolic: number; diastolic: number; at: string | null }; dir: "improving" | "rising" | "holding" } | null;
  read: string;
} {
  const list = Array.isArray(rows) ? rows.filter((r) => r && Number.isFinite(Number(r.systolic)) && Number.isFinite(Number(r.diastolic))) : [];
  const latest = list[0] ?? null;
  if (!latest) return { latest: null, category: null, label: "No readings yet", tone: "watch", trajectory: null, read: "Log a couple of resting home readings and Cairn can read the pattern." };
  const sys = Number(latest.systolic);
  const dia = Number(latest.diastolic);
  const category: BpCategory =
    sys < 90 || dia < 60 ? "low" : sys >= 130 || dia >= 80 ? "high" : sys >= 120 ? "elevated" : "optimal";
  const label =
    category === "optimal" ? "in a calm, optimal home range" :
    category === "elevated" ? "a touch above the optimal target" :
    category === "high" ? "above the calm home target" :
    "running on the low side";
  const tone: "strong" | "steady" | "watch" = category === "optimal" ? "strong" : category === "elevated" ? "steady" : "watch";

  // Trajectory: the most striking honest move — the highest prior systolic vs the latest.
  let trajectory: any = null;
  const prior = list.slice(1);
  if (prior.length) {
    const priorMax = prior.reduce((a, b) => (Number(b.systolic) > Number(a.systolic) ? b : a));
    const priorMin = prior.reduce((a, b) => (Number(b.systolic) < Number(a.systolic) ? b : a));
    const at = (r: any) => (r?.measured_at ? String(r.measured_at).replace(" ", "T") : null);
    if (sys <= Number(priorMax.systolic) - 10) {
      trajectory = { from: { systolic: Number(priorMax.systolic), diastolic: Number(priorMax.diastolic), at: at(priorMax) }, to: { systolic: sys, diastolic: dia, at: at(latest) }, dir: "improving" };
    } else if (sys >= Number(priorMin.systolic) + 10) {
      trajectory = { from: { systolic: Number(priorMin.systolic), diastolic: Number(priorMin.diastolic), at: at(priorMin) }, to: { systolic: sys, diastolic: dia, at: at(latest) }, dir: "rising" };
    } else {
      trajectory = { from: { systolic: Number(priorMax.systolic), diastolic: Number(priorMax.diastolic), at: at(priorMax) }, to: { systolic: sys, diastolic: dia, at: at(latest) }, dir: "holding" };
    }
  }

  const read =
    trajectory?.dir === "improving"
      ? `${sys}/${dia} ${label} — down from ${trajectory.from.systolic}/${trajectory.from.diastolic}. That's a real win.`
      : category === "optimal"
        ? `${sys}/${dia} — ${label}. Nice and steady.`
        : category === "elevated"
          ? `${sys}/${dia} — ${label}. Worth a few more resting readings to confirm the pattern.`
          : category === "high"
            ? `${sys}/${dia} — ${label}. Repeated home readings here are worth a conversation with your doctor.`
            : `${sys}/${dia} — ${label}.`;
  return { latest, category, label, tone, trajectory, read };
}

function bpFlag(name: "systolic" | "diastolic" | "pulse", value: number): string | null {
  if (name === "systolic") {
    if (value >= 130) return "high";
    if (value < 90) return "low";
    return "normal";
  }
  if (name === "diastolic") {
    if (value >= 80) return "high";
    if (value < 60) return "low";
    return "normal";
  }
  if (value > 100) return "high";
  if (value < 50) return "low";
  return null;
}

function expandBloodPressureMarker(rawName: string, marker: any): any[] {
  const value = marker?.value;
  const unit = marker?.unit ?? "mmHg";
  const text = String(value ?? "").trim();
  const bp = text.match(/\b(\d{2,3})\s*\/\s*(\d{2,3})\b/);
  if (!bp || !/\b(bp|blood pressure)\b/i.test(rawName)) return [{ ...marker, name: rawName }];
  return [
    { name: "Systolic BP", value: Number(bp[1]), unit, flag: marker.flag ?? null },
    { name: "Diastolic BP", value: Number(bp[2]), unit, flag: marker.flag ?? null },
  ];
}

// ---------- health documents ----------
export function hydrateHealthDoc(row: any) {
  if (!row) return row;
  let parsed: any = null;
  try { parsed = row.parsed_json ? JSON.parse(row.parsed_json) : null; } catch { parsed = null; }
  return { ...row, parsed };
}

// Strip the on-disk path from API payloads — it's an internal detail and the
// file is served via a dedicated streaming endpoint, not exposed as a path.
function publicHealthDoc(row: any) {
  if (!row) return row;
  const { file_path, ...rest } = hydrateHealthDoc(row);
  return { ...rest, has_file: !!file_path };
}

export interface HealthDocInput {
  kind?: string;
  doc_date?: string | null;
  original_name?: string | null;
  mime?: string | null;
  file_path?: string | null;
  enrichment_status?: string | null;
  parsed_json?: any;
  summary?: string | null;
  source_doc_id?: number | null;
}

export function addHealthDocument(input: HealthDocInput) {
  const kind = inferHealthDocumentKind({
    kind: input.kind,
    type: input.parsed_json?.type,
    summary: input.summary,
    original_name: input.original_name,
    markers: input.parsed_json?.markers,
    clinical_facts: input.parsed_json?.clinical_facts,
    mime: input.mime,
  });
  const info = db
    .prepare(
      `INSERT INTO health_documents (kind, doc_date, original_name, mime, file_path, parsed_json, summary, enrichment_status, source_doc_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      kind,
      input.doc_date ?? null,
      input.original_name ?? null,
      input.mime ?? null,
      input.file_path ?? null,
      input.parsed_json != null ? JSON.stringify(input.parsed_json) : null,
      input.summary ?? null,
      input.enrichment_status ?? null,
      input.source_doc_id ?? null
    );
  bumpMarkerHistoryVersion(); // a new doc (or a derived panel) can add marker series
  return getHealthDocument(Number(info.lastInsertRowid));
}

// A single dated panel split out of a multi-record import (one lab visit, scan
// date, etc.). Coerced/clamped like the enrichment apply path.
export interface HealthPanelInput {
  doc_date?: string | null;
  kind?: string;
  summary?: string | null;
  markers?: any[];
  type?: string | null;
  clinical_facts?: any[];
}

// Replace the derived panels of a source upload with a fresh set (used by
// multi-record ingestion + re-analysis). Each panel becomes its own dated row
// pointing back at `sourceId`; the binary stays only on the source row. Returns
// the rows created. `original_name` is carried through for provenance.
export function replaceHealthPanels(sourceId: number, panels: HealthPanelInput[], originalName?: string | null) {
  deleteDerivedHealthDocs(sourceId);
  return insertHealthPanels(sourceId, panels, originalName);
}

function insertHealthPanels(sourceId: number, panels: HealthPanelInput[], originalName?: string | null) {
  const created: any[] = [];
  for (const p of Array.isArray(panels) ? panels : []) {
    if (!p || typeof p !== "object") continue;
    const markers = Array.isArray(p.markers)
      ? p.markers
        .filter((m: any) => m && typeof m === "object")
        .slice(0, MAX_MARKERS_PER_PANEL)
        .map((m: any) => ({
          name: String(m.name ?? "").slice(0, 120),
          value: typeof m.value === "number" ? m.value : (m.value == null ? null : String(m.value).slice(0, 80)),
          unit: m.unit == null ? null : String(m.unit).slice(0, 40),
          flag: ["low", "normal", "high"].includes(m.flag) ? m.flag : null,
        }))
        // Drop a physiologically-impossible numeric reading (a transcription typo / unit
        // error) so it can't poison the connected brain's directives. Conservative — only
        // CLEAR impossibilities are skipped; qualitative + unknown-family values pass.
        .filter((m: any) => m.name && plausibleMarkerValue(m.name, m.value, m.unit).plausible)
      : [];
    const date = typeof p.doc_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.doc_date) ? p.doc_date : null;
    const summary = p.summary == null ? null : String(p.summary).slice(0, 1000);
    const clinicalFacts = cleanClinicalFacts((p as any).clinical_facts, 80);
    if (!markers.length && !summary && !clinicalFacts.length) continue; // an empty panel is noise
    const parsed: Record<string, any> = { markers };
    if (p.type) parsed.type = String(p.type).slice(0, 80);
    if (clinicalFacts.length) parsed.clinical_facts = clinicalFacts;
    const row = addHealthDocument({
      kind: inferHealthDocumentKind({
        kind: p.kind,
        type: p.type,
        summary,
        original_name: originalName,
        markers,
        clinical_facts: clinicalFacts,
      }),
      doc_date: date,
      original_name: originalName ?? null,
      file_path: null,             // the binary lives on the source row only
      parsed_json: parsed,
      summary,
      enrichment_status: "done",
      source_doc_id: sourceId,
    });
    created.push(row);
  }
  return created;
}

function deleteDerivedHealthDocs(sourceId: number) {
  const changes = db.prepare(`DELETE FROM health_documents WHERE source_doc_id = ?`).run(sourceId).changes;
  if (changes) bumpMarkerHistoryVersion();
  return changes;
}

function deleteDerivedHealthDocsByType(sourceId: number, type: string) {
  const rows = db
    .prepare(`SELECT id, parsed_json FROM health_documents WHERE source_doc_id = ?`)
    .all(sourceId) as any[];
  let deleted = 0;
  for (const row of rows) {
    let parsed: any = null;
    try { parsed = row.parsed_json ? JSON.parse(row.parsed_json) : null; } catch { parsed = null; }
    if (String(parsed?.type ?? "") !== type) continue;
    deleted += Number(db.prepare(`DELETE FROM health_documents WHERE id = ?`).run(row.id).changes);
  }
  if (deleted) bumpMarkerHistoryVersion();
  return deleted;
}

// Refresh one deterministic derived stream without disturbing the agent-split
// lab timeline. Used for CCDA vitals, which are facts adjacent to a MyChart
// export rather than a replacement for its dated lab panels.
export function replaceHealthPanelsByType(sourceId: number, type: string, panels: HealthPanelInput[], originalName?: string | null) {
  deleteDerivedHealthDocsByType(sourceId, type);
  const typed = (Array.isArray(panels) ? panels : []).map((p) => ({ ...p, type }));
  return insertHealthPanels(sourceId, typed, originalName);
}

// Raw row incl. file_path — for internal use (enrichment, file streaming, delete).
export function getHealthDocumentRaw(id: number) {
  return db.prepare(`SELECT * FROM health_documents WHERE id = ?`).get(id) ?? null;
}

// Hydrated row WITHOUT file_path — for API responses.
export function getHealthDocument(id: number) {
  const row = getHealthDocumentRaw(id) as any;
  return row ? publicHealthDoc(row) : null;
}

export function listHealthDocuments(limit = 50) {
  // Newest results first — order by the effective result date (doc_date, falling
  // back to upload time) so a split multi-year import reads as a clean timeline.
  // A 'pending_confirm' draft (a bulk lab pasted in chat, awaiting one-tap confirm)
  // is NOT a record yet — hide it from Records until the user confirms it.
  return (db
    .prepare(`SELECT * FROM health_documents WHERE COALESCE(enrichment_status,'') != 'pending_confirm' ORDER BY COALESCE(doc_date, substr(created_at,1,10)) DESC, id DESC LIMIT ?`)
    .all(limit) as any[]).map(publicHealthDoc);
}

// The single source of truth for "newest health document date" — the effective
// result date (doc_date, falling back to the upload day), as a YYYY-MM-DD string or
// null when there are no docs. Used to STAMP the health synthesis (source_doc_at) and
// to READ whether it's gone stale, so both sides derive the date the same way.
export function newestHealthDocDate(): string | null {
  try {
    const row = db.prepare(
      `SELECT COALESCE(doc_date, substr(created_at, 1, 10)) AS d
         FROM health_documents
        WHERE COALESCE(enrichment_status,'') != 'pending_confirm'
        ORDER BY COALESCE(doc_date, substr(created_at, 1, 10)) DESC, id DESC
        LIMIT 1`
    ).get() as any;
    const d = row?.d ? String(row.d).trim().slice(0, 10) : "";
    return d || null;
  } catch {
    return null; // table absent / no docs
  }
}

export function updateHealthDocFields(id: number, fields: { parsed_json?: any; summary?: string | null; kind?: string | null; doc_date?: string | null }) {
  const sets: string[] = [];
  const vals: any[] = [];
  if (fields.parsed_json !== undefined) { sets.push("parsed_json = ?"); vals.push(fields.parsed_json != null ? JSON.stringify(fields.parsed_json) : null); }
  if (fields.summary !== undefined) { sets.push("summary = ?"); vals.push(fields.summary ?? null); }
  if (fields.kind !== undefined) {
    const kind = normalizeHealthDocumentKind(fields.kind);
    sets.push("kind = ?");
    vals.push(kind);
  }
  if (fields.doc_date !== undefined) { sets.push("doc_date = ?"); vals.push(fields.doc_date ?? null); }
  if (!sets.length) return getHealthDocument(id);
  vals.push(id);
  db.prepare(`UPDATE health_documents SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  // parsed_json/kind/doc_date all shift the marker series (re-analysis, confirm-lab
  // commit, panel re-date); bump regardless of which field changed — cheap + exact.
  bumpMarkerHistoryVersion();
  return getHealthDocument(id);
}

export function setHealthDocEnrichStatus(id: number, status: string) {
  db.prepare(`UPDATE health_documents SET enrichment_status = ? WHERE id = ?`).run(status, id);
  const row = getHealthDocument(id); // public shape — never leaks file_path
  emitEnrichTransition("health", id, row); // wake any SSE watcher on this row
  return row;
}

// ---------- pasted-lab confirm (chat propose→apply gate) ----------
// A substantial lab pasted in chat is persisted as a 'pending_confirm' health document
// (raw text on disk, no markers committed yet — see src/chatTurns.ts persistPendingLabDraft)
// so a big write follows propose→apply instead of the immediate safe path.

// Whether confirming can reach a faithful transcriber right now. Pure so the routing
// decision is unit-testable without the DB/agent state.
export function labConfirmCanTranscribe(enrichOn: boolean, hasAgent: boolean): boolean {
  return enrichOn && hasAgent;
}

export interface ConfirmLabResult {
  ok: boolean;
  reason?: string;
  doc?: any;
  enqueue?: boolean;   // caller should enqueue the health enrich job (reliable path)
  committed?: boolean; // markers were committed inline (graceful degrade)
}

// Confirm a pending_confirm lab paste. When a faithful transcriber is reachable
// (enrichment on + a usable health agent), flip it to 'pending' and let the caller
// enqueue the completeness-first, Claude-first health ingest — the SAME path the Health
// tab's paste box uses (enrich.ts → pickHealthAgentOrder + buildHealthIngestPrompt).
// Otherwise gracefully DEGRADE: commit the chat agent's inline markers (stashed under
// parsed.pending_markers) directly so results aren't lost. Idempotent: a non-
// pending_confirm doc is returned unchanged. `opts` injects the enrich/agent state for tests.
export function confirmPendingLab(id: number, opts?: { enrichOn?: boolean; hasAgent?: boolean }): ConfirmLabResult {
  const row = getHealthDocumentRaw(id) as any;
  if (!row) return { ok: false, reason: "not found" };
  if (row.enrichment_status !== "pending_confirm") {
    // Already confirmed / not a draft — idempotent success, nothing to do.
    return { ok: true, doc: getHealthDocument(id), enqueue: false, committed: false };
  }
  const enrichOn = opts?.enrichOn ?? (() => { try { return !!getSettings().enrich_enabled; } catch { return false; } })();
  const hasAgent = opts?.hasAgent ?? (() => { try { return pickHealthAgentOrder().length > 0; } catch { return false; } })();
  if (labConfirmCanTranscribe(enrichOn, hasAgent)) {
    setHealthDocEnrichStatus(id, "pending");
    return { ok: true, doc: getHealthDocument(id), enqueue: true, committed: false };
  }
  // Graceful degrade: no transcriber reachable → commit the chat agent's inline markers
  // (better than dropping them). Coerce/clamp + plausibility-filter like insertHealthPanels.
  let parsed: any = null;
  try { parsed = row.parsed_json ? JSON.parse(row.parsed_json) : null; } catch { parsed = null; }
  const rawMarkers = Array.isArray(parsed?.pending_markers) ? parsed.pending_markers : [];
  const markers = rawMarkers
    .filter((m: any) => m && typeof m === "object")
    .slice(0, MAX_MARKERS_PER_PANEL)
    .map((m: any) => ({
      name: String(m.name ?? "").slice(0, 120),
      value: typeof m.value === "number" ? m.value : (m.value == null ? null : String(m.value).slice(0, 80)),
      unit: m.unit == null ? null : String(m.unit).slice(0, 40),
      flag: ["low", "normal", "high"].includes(m.flag) ? m.flag : null,
    }))
    .filter((m: any) => m.name && plausibleMarkerValue(m.name, m.value, m.unit).plausible);
  updateHealthDocFields(id, {
    parsed_json: { markers },
    summary: (typeof parsed?.pending_summary === "string" ? parsed.pending_summary : null) ?? row.summary ?? null,
  });
  setHealthDocEnrichStatus(id, "done");
  return { ok: true, doc: getHealthDocument(id), enqueue: false, committed: true };
}

export function deleteHealthDocument(id: number) {
  // Deleting a source upload takes its derived dated panels with it (they have
  // no binary of their own and are meaningless without the source).
  const derived = deleteDerivedHealthDocs(id);
  const deleted = db.prepare(`DELETE FROM health_documents WHERE id = ?`).run(id).changes;
  if (deleted) bumpMarkerHistoryVersion();
  return { deleted, derived };
}

// ---------- marker forecasting (least-squares slope → plain-language projection) ----------
// A marker series read as a TREND, not a two-point delta: an ordinary
// least-squares line over the (date→value) points gives a per-day slope that's
// robust to one noisy reading. From the slope plus the optimal band we derive a
// PLAIN-LANGUAGE projection ("trending toward optimal, roughly 6 weeks out" /
// "drifting away from optimal" / "stable") — words and a direction only, NEVER a
// number-as-score (the constitution bans 0-100 grades). `eta_weeks` is kept
// internal for ordering (prioritizeMarkers); only the text is ever surfaced.
interface MarkerForecast {
  // direction RELATIVE TO OPTIMAL: improving = heading toward the band,
  // worsening = drifting away the bad way, stable = no meaningful drift,
  // null = not enough data / no zone to judge against.
  direction: "improving" | "worsening" | "stable" | null;
  eta_text: string | null;      // human ETA to reach (or leave) optimal, or null
  eta_weeks: number | null;     // INTERNAL ordering signal — never surfaced as a grade
  crossing: "entering" | "leaving" | null; // projected to cross the optimal edge
}

// Some markers are genetically fixed / set-for-life — Lp(a), ApoE genotype, MTHFR —
// so a "trend" or an ETA drawn across a couple of noisy readings is meaningless and
// actively misleading (a real n=2 Lp(a) once read "falling, ~3 weeks to optimal" off
// two dots). These never carry a confident direction or projection; the honest read
// is 'stable'. Matched on the display name, substring, case-insensitive.
export function isNonTrendingMarker(name?: string | null): boolean {
  if (!name) return false;
  return /lp\s?\(a\)|lipoprotein\s?\(a\)|apo\s?e\b|apolipoprotein e|mthfr|\bgenotype\b|\bgenetic\b|\bhla\b/i.test(String(name));
}

// Ordinary least-squares slope (value per DAY) over ascending (date,value)
// points. Returns null with <2 points or a degenerate (single-day) span.
export function lsqSlopePerDay(points: { date: string; value: number }[]): number | null {
  if (!points || points.length < 2) return null;
  const xs = points.map((p) => Date.parse(p.date + "T00:00:00Z") / 864e5);
  const ys = points.map((p) => p.value);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  if (den <= 0) return null;
  return num / den; // value units per day
}

// Plain-language ETA for a count of weeks — words only.
function weeksText(weeks: number): string {
  if (weeks <= 1.5) return "roughly a week out";
  if (weeks <= 8) return `roughly ${Math.round(weeks)} weeks out`;
  if (weeks <= 16) return `a few months out`;
  if (weeks <= 78) return `roughly ${Math.round(weeks / 4.345)} months out`;
  return "well over a year out at this pace";
}

// From a marker's series + its optimal zone, derive a forecast relative to the
// OPTIMAL band (not the lab range). Slope sign vs the "worse" direction decides
// improving / worsening; an ETA is projected only when the line will actually
// cross the relevant edge. No zone (or a flat/short series) → a stable/unknown,
// never a fabricated trend. Everything is plain language + direction. Exported so
// the wearable-fitness marker builder (propagation.ts) reuses the SAME forecast.
export function forecastMarker(
  points: { date: string; value: number }[],
  slopePerDay: number | null,
  zone: OptimalZone | null
): MarkerForecast {
  if (slopePerDay == null || !points.length) {
    return { direction: null, eta_text: null, eta_weeks: null, crossing: null };
  }
  const latest = points[points.length - 1].value;
  const weekly = slopePerDay * 7;
  // Span and spread gate "stable": a slope that won't move the value materially
  // across the series' own window reads as stable, not a trend to act on.
  const xs = points.map((p) => Date.parse(p.date + "T00:00:00Z") / 864e5);
  const spanDays = Math.max(1, xs[xs.length - 1] - xs[0]);
  const projectedMove = Math.abs(slopePerDay) * spanDays;
  const vals = points.map((p) => p.value);
  const spread = Math.max(...vals) - Math.min(...vals);
  // Need a zone to speak "toward / away from optimal".
  if (!zone) {
    if (projectedMove < Math.max(spread * 0.05, 1e-9)) {
      return { direction: "stable", eta_text: null, eta_weeks: null, crossing: null };
    }
    return { direction: null, eta_text: null, eta_weeks: null, crossing: null };
  }
  const [lo, hi] = zone.optimal;
  const width = Math.max(hi - lo, 1);
  // "Stable" when the slope barely moves the value vs the optimal band's width.
  if (projectedMove < width * 0.1 && projectedMove < Math.max(spread * 0.05, 1e-9)) {
    return { direction: "stable", eta_text: null, eta_weeks: null, crossing: null };
  }
  const dist = optimalDistance(latest, zone); // 0 when inside optimal
  const inside = dist === 0;
  // Which way is the value moving, and is that toward or away from optimal?
  // dir 'high' = high is worse, 'low' = low is worse, 'band' = either side worse.
  let improving: boolean;
  let edge: number | null = null; // the optimal edge it would cross
  if (zone.dir === "high") {
    improving = weekly < 0;                 // falling = toward optimal
    edge = hi;                              // crossing the upper edge either way
  } else if (zone.dir === "low") {
    improving = weekly > 0;                 // rising = toward optimal
    edge = lo;
  } else {
    // band: judge against the nearer edge it's heading at.
    if (latest > hi) { improving = weekly < 0; edge = hi; }
    else if (latest < lo) { improving = weekly > 0; edge = lo; }
    else { improving = weekly < 0 ? latest <= (lo + hi) / 2 : latest >= (lo + hi) / 2; edge = weekly > 0 ? hi : lo; }
  }
  // ETA to cross the relevant edge, when the slope actually heads there.
  let eta_weeks: number | null = null;
  let crossing: MarkerForecast["crossing"] = null;
  let eta_text: string | null = null;
  if (edge != null && Math.abs(weekly) > 1e-9) {
    const weeksToEdge = (edge - latest) / weekly;
    if (weeksToEdge > 0 && weeksToEdge < 260) {
      eta_weeks = Math.round(weeksToEdge * 10) / 10;
      crossing = inside ? "leaving" : "entering";
    }
  }
  const direction: MarkerForecast["direction"] = improving ? "improving" : "worsening";
  if (eta_weeks != null) {
    const when = weeksText(eta_weeks);
    eta_text = inside
      ? `drifting toward the edge of optimal, ${when}`
      : improving
        ? `trending toward optimal, ${when}`
        : `drifting further from optimal, ${when}`;
  } else {
    eta_text = inside
      ? "holding within optimal"
      : improving
        ? "trending toward optimal"
        : "drifting away from optimal";
  }
  return { direction, eta_text, eta_weeks, crossing };
}

// ---------- getMarkerHistory memoization ----------
// getMarkerHistory walks EVERY health_documents row (JSON.parse + canonicalize +
// unit-normalize every marker), reads all blood_pressure_readings, then computes a
// least-squares trend + forecast per marker — heavy, and a single Stand tab load
// calls it 3-4× (markers/priority → prioritizeMarkers, health/synthesis → healthFocus
// → prioritizeMarkers again, coaching-focus → getCoachContext, health/standing). Its
// output is a pure function of (health_documents, blood_pressure_readings, marker_aliases
// — the learned canonicalization — and the profile's sex/age, which personalizes the
// optimal bands), so memoize on a signature of those. Two invalidation paths: (1) an
// in-process WRITE VERSION (marker-cache.ts, shared with marker-canon.ts's alias writes)
// bumped by every repo write that can change marker data — the fast, exact path; (2) a
// cheap SQL signature BACKSTOP (row counts + max(id) of all three tables + profile
// sex/age) for any write that bypasses the counter. Both fold into one key string.
//
// test/_isolate.mjs wipes ALL tables directly (bypassing these repo functions) before
// every test, and rowids can COLLIDE across a wipe — so the SQL signature alone can
// serve a stale cache from a prior test. The wipe therefore calls resetMarkerHistoryCache().
let markerHistoryCache: { key: string; value: { markers: any[]; groups: any[] } } | null = null;

// Bumped by every marker-data write path (add/update/delete health docs, BP insert/
// delete). Also drops the cached value eagerly so memory doesn't hold a stale copy.
function bumpMarkerHistoryVersion(): void {
  bumpMarkerDataVersion();
  markerHistoryCache = null;
}

// Explicit reset for the test isolate (which wipes tables out-of-band). Exported and
// called from test/_isolate.mjs so a pristine-floor test never reads a prior test's
// cached markers despite colliding rowids.
export function resetMarkerHistoryCache(): void {
  resetMarkerDataVersion();
  markerHistoryCache = null;
}

// Cheap read-time signature: the shared write version plus row counts + max(id) of all
// three source tables and the profile's sex/age (the only profile fields that shift the
// personalized optimal bands, hence the trend/forecast). A query failure returns a
// never-matching key so we rebuild rather than risk serving stale data.
function markerHistorySignature(): string {
  try {
    const r = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM health_documents) AS dc,
           (SELECT COALESCE(MAX(id), 0) FROM health_documents) AS dm,
           (SELECT COUNT(*) FROM blood_pressure_readings) AS bc,
           (SELECT COALESCE(MAX(id), 0) FROM blood_pressure_readings) AS bm,
           (SELECT COUNT(*) FROM marker_aliases) AS ac,
           (SELECT COALESCE(MAX(rowid), 0) FROM marker_aliases) AS am`
      )
      .get() as any;
    const p = db.prepare(`SELECT sex, age FROM profile WHERE id = 1`).get() as any;
    return `${currentMarkerDataVersion()}|${r?.dc ?? 0}|${r?.dm ?? 0}|${r?.bc ?? 0}|${r?.bm ?? 0}|${r?.ac ?? 0}|${r?.am ?? 0}|${p?.sex ?? ""}|${p?.age ?? ""}`;
  } catch {
    return `nocache:${currentMarkerDataVersion()}:${Math.random()}`;
  }
}

// ---------- health insights: marker history across all documents ----------
// Aggregates every marker from every health document into one per-marker series.
// Docs are walked in effective-date order (doc_date, falling back to the upload
// date), so "latest" is the most recent reading and points form a time series.
//
// MEMOIZED: this thin wrapper serves a structuredClone of the cached result when the
// signature is unchanged (a clone because callers — prioritizeMarkers, healthStanding,
// healthFocus, report.ts — build/sort derived views off it; cloning keeps the exact
// current semantics, where every call returns brand-new objects). The heavy walk lives
// in computeMarkerHistory below.
export function getMarkerHistory(): { markers: any[]; groups: any[] } {
  const key = markerHistorySignature();
  if (markerHistoryCache && markerHistoryCache.key === key) {
    return structuredClone(markerHistoryCache.value);
  }
  const value = computeMarkerHistory();
  markerHistoryCache = { key, value };
  return structuredClone(value);
}

function computeMarkerHistory() {
  const docs = db
    .prepare(
      `SELECT id, kind, doc_date, created_at, parsed_json FROM health_documents
       ORDER BY COALESCE(doc_date, substr(created_at,1,10)) ASC, id ASC`
    )
    .all() as any[];
  // Personalize the sex/age-dependent optimal bands (testosterone, ferritin, eGFR, …)
  // so the trend/forecast reads "toward optimal" against the athlete's OWN band, not
  // the male/generic default. Null-safe: a fresh DB profile yields the default.
  const zoneProfile = (() => {
    try { const p = getProfile(); return p ? { sex: p.sex ?? null, age: p.age ?? null } : null; }
    catch { return null; }
  })();

  interface Reading {
    date: string;
    value: number | string;
    flag: string | null;
    unit: string | null;
    source_value?: number | string | null;
    source_unit?: string | null;
    unit_converted?: boolean;
    unit_mismatch?: boolean;
    expected_unit?: string | null;
    ref_low?: number | null;
    ref_high?: number | null;
    ref_source?: string | null;
    ref_source_url?: string | null;
    name: string;
    doc_id: number | null;
    kind: string;
  }
  const readingValueKey = (value: number | string) => {
    if (typeof value === "number") return String(Math.round(value * 1_000_000) / 1_000_000);
    return String(value ?? "").trim().toLowerCase();
  };
  const readingDedupeKey = (r: Reading) => [r.date, readingValueKey(r.value), String(r.unit ?? "").trim().toLowerCase()].join("|");
  const flagRank = (flag: string | null) => flag === "high" || flag === "low" ? 3 : flag === "normal" ? 2 : 1;
  const mergeDuplicateReading = (first: Reading, next: Reading): Reading => ({
    ...first,
    // Prefer the later upload for display/source identity, but keep any extra
    // clinical context either copy carried. The docs are already walked ASC.
    name: next.name || first.name,
    doc_id: next.doc_id ?? first.doc_id,
    kind: next.kind || first.kind,
    flag: flagRank(next.flag) > flagRank(first.flag) ? next.flag : first.flag ?? next.flag,
    ref_low: first.ref_low ?? next.ref_low,
    ref_high: first.ref_high ?? next.ref_high,
    ref_source: first.ref_source ?? next.ref_source,
    ref_source_url: first.ref_source_url ?? next.ref_source_url,
    source_value: first.source_value ?? next.source_value,
    source_unit: first.source_unit ?? next.source_unit,
    unit_converted: first.unit_converted || next.unit_converted,
    unit_mismatch: first.unit_mismatch || next.unit_mismatch,
    expected_unit: first.expected_unit ?? next.expected_unit,
  });
  const dedupeReadings = (readings: Reading[]) => {
    const out: Reading[] = [];
    const seen = new Map<string, number>();
    for (const r of readings) {
      const key = readingDedupeKey(r);
      const idx = seen.get(key);
      if (idx == null) {
        seen.set(key, out.length);
        out.push(r);
      } else {
        out[idx] = mergeDuplicateReading(out[idx], r);
      }
    }
    return out;
  };
  const byKey = new Map<string, Reading[]>();

  for (const d of docs) {
    let parsed: any = null;
    try { parsed = d.parsed_json ? JSON.parse(d.parsed_json) : null; } catch { parsed = null; }
    const markers = Array.isArray(parsed?.markers) ? parsed.markers : [];
    const date = (d.doc_date && String(d.doc_date).trim()) || String(d.created_at ?? "").slice(0, 10);
    for (const m of markers) {
      if (!m || typeof m !== "object") continue;
      const rawName = String(m.name ?? "").replace(/\s+/g, " ").trim();
      if (!rawName) continue;
      const expanded = expandBloodPressureMarker(rawName, m);
      for (const em of expanded) {
        const name = String(em.name ?? rawName).replace(/\s+/g, " ").trim();
        if (!name) continue;
        // Drop non-clinical extractions (e.g. an eyeglass Rx pulled from an eye-exam
        // doc) so they never form a marker series — non-destructive, the doc stays.
        if (isNonClinicalMarker(name)) continue;
        // Drop non-results from imported panels. MyChart-style HIV/viral screens
        // often include supplemental components with value "TNP" / "test not
        // performed" after the parent screen is non-reactive; those are not
        // dated clinical findings and should not become marker series.
        if (isNonResultMarkerValue(em.value)) continue;
        // A reading is usable when the value is a finite number, a string with a
        // parseable lab number, or a non-empty qualitative result (e.g. "negative").
        // Recognized markers are normalized to the unit their optimal band expects
        // here, while source_value/source_unit keep the lab transcription inspectable.
        // The series KEY is the CANONICAL marker key (marker-canon.ts): different labs'
        // names for the same analyte ("Glucose (random)"/"Glucose Random"; "Vitamin D"/
        // "25-OH Vitamin D"; "eGFR"/the long form) collapse onto one series. The
        // display name is the curated internal label, while raw source labels stay
        // attached for verification in app/report provenance.
        let flag = ["low", "normal", "high"].includes(em.flag) ? em.flag : null;
        const sourceUnit = em.unit !== null && em.unit !== undefined && String(em.unit).trim() ? String(em.unit).trim() : null;
        const resolved = canonicalMarkerForReading(name, sourceUnit);
        const key = resolved.key || name.toLowerCase();
        if (isAnthropometricMarkerKey(key)) flag = null;
        const normalized = normalizeMarkerReading(name, em.value, sourceUnit, matchOptimalZone(resolved.name));
        if (!normalized) continue;
        // The lab's printed reference range (source unit). Scale it by the same
        // factor the value was converted by, so range + value stay comparable after
        // a recognized-unit normalization; pass-through markers keep it verbatim.
        const refFactor =
          normalized.unit_converted &&
          typeof normalized.value === "number" &&
          typeof normalized.source_value === "number" &&
          normalized.source_value !== 0
            ? normalized.value / normalized.source_value
            : 1;
        const scaleRef = (v: unknown): number | null => {
          const n = Number(v);
          if (v == null || v === "" || !Number.isFinite(n)) return null;
          return Math.round(n * refFactor * 1000) / 1000;
        };
        const refLow = scaleRef(em.ref_low);
        const refHigh = scaleRef(em.ref_high);
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key)!.push({
          date,
          value: normalized.value,
          flag,
          unit: normalized.unit,
          source_value: normalized.source_value,
          source_unit: normalized.source_unit,
          unit_converted: normalized.unit_converted,
          unit_mismatch: normalized.unit_mismatch,
          expected_unit: normalized.expected_unit,
          ref_low: refLow,
          ref_high: refHigh,
          ref_source: refLow != null || refHigh != null ? "source_lab" : null,
          ref_source_url: null,
          name,
          doc_id: d.id,
          kind: d.kind ?? "other",
        });
      }
    }
  }

  const bpRows = db
    .prepare(`SELECT * FROM blood_pressure_readings ORDER BY measured_at ASC, id ASC LIMIT 1000`)
    .all() as any[];
  const addBpMarker = (name: "Systolic BP" | "Diastolic BP" | "Pulse", value: any, unit: string, flag: string | null, row: any) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    const key = canonicalMarker(name).key || name.toLowerCase();
    const date = String(row.measured_at || "").slice(0, 10);
    if (!byKey.has(key)) byKey.set(key, []);
    const arr = byKey.get(key)!;
    // De-dupe by date: the same vital lives in blood_pressure_readings AND — for
    // MyChart-style imports — as a health-doc marker, so without this the series
    // double-counts (doubling the least-squares forecast weight). One point per date.
    if (arr.some((r) => r.date === date)) return;
    arr.push({ date, value: numeric, flag, unit, name, doc_id: null, kind: "vitals" });
  };
  for (const row of bpRows) {
    addBpMarker("Systolic BP", row.systolic, "mmHg", bpFlag("systolic", Number(row.systolic)), row);
    addBpMarker("Diastolic BP", row.diastolic, "mmHg", bpFlag("diastolic", Number(row.diastolic)), row);
    if (row.pulse != null) addBpMarker("Pulse", row.pulse, "bpm", bpFlag("pulse", Number(row.pulse)), row);
  }

  try {
    const weightKey = canonicalMarker("Body Weight").key;
    for (const row of listWeight(1000) as any[]) {
      const numeric = Number(row?.weight_lb);
      const date = String(row?.date || "").slice(0, 10);
      if (!Number.isFinite(numeric) || !date) continue;
      if (!byKey.has(weightKey)) byKey.set(weightKey, []);
      const arr = byKey.get(weightKey)!;
      const value = Math.round(numeric * 10) / 10;
      if (arr.some((r) => readingDedupeKey(r) === [date, readingValueKey(value), "lb"].join("|"))) continue;
      arr.push({
        date,
        value,
        flag: null,
        unit: "lb",
        name: "Body Weight",
        doc_id: null,
        kind: "measurement",
      });
    }
  } catch {
    // Bodyweight logging is app context. If it is unavailable for any reason,
    // uploaded health-document markers still render normally.
  }

  const markers = [...byKey.entries()].map(([key, rawReadings]) => {
    const readings = dedupeReadings(rawReadings);
    const last = readings[readings.length - 1];
    const before = readings.length > 1 ? readings[readings.length - 2] : null;
    const displayName = canonicalMarkerForReading(last.name, last.unit).name || last.name;
    const sourceNames = [...new Set(readings.map((r) => r.name).filter(Boolean))];
    // Most recent non-null unit seen for this marker.
    let unit: string | null = null;
    for (let i = readings.length - 1; i >= 0; i--) {
      if (readings[i].unit) { unit = readings[i].unit; break; }
    }
    const sameUnitReadings = readings.filter((r) => seriesUnitsCompatible(r.unit, unit));
    // Readings in an INCOMPATIBLE unit family are kept out of the trend (we never
    // guess a conversion across units we can't safely convert — e.g. Lp(a) in
    // mg/dL vs nmol/L). But dropping them silently truncates the series with no
    // signal, so surface a small non-destructive count: how many older readings
    // sit on a different unit and aren't in the trend below. 0 in the normal case.
    const dropped_other_units = readings.length - sameUnitReadings.length;
    const toPublicReading = (r: Reading, includeKind = false) => {
      const out: any = { value: r.value, date: r.date };
      if (r.name && r.name !== displayName) out.source_name = r.name;
      if (includeKind) {
        out.flag = r.flag;
        out.doc_id = r.doc_id;
        out.kind = r.kind;
        if (r.ref_low != null) out.ref_low = r.ref_low;
        if (r.ref_high != null) out.ref_high = r.ref_high;
        if (r.ref_source) out.ref_source = r.ref_source;
      }
      if (r.unit_converted) {
        out.source_value = r.source_value ?? null;
        out.source_unit = r.source_unit ?? null;
        out.unit_converted = true;
      }
      if (r.unit_mismatch) {
        out.source_value = r.source_value ?? r.value;
        out.source_unit = r.source_unit ?? r.unit ?? null;
        out.unit_mismatch = true;
        out.expected_unit = r.expected_unit ?? null;
      }
      return out;
    };
    // Chart points carry NUMERIC values only (a "5.4" string still counts);
    // readings are already ascending by effective date from the SQL ordering. If
    // a marker has incompatible source units we keep only the latest unit family
    // in the series, never mixing e.g. Lp(a) nmol/L and mg/dL in one trend.
    const points = sameUnitReadings
      .map((r) => ({
        date: r.date,
        value: typeof r.value === "number" ? r.value : Number(r.value),
        flag: r.flag,
        doc_id: r.doc_id,
        ...(r.name && r.name !== displayName ? { source_name: r.name } : {}),
        ...(r.unit_converted ? { source_value: r.source_value ?? null, source_unit: r.source_unit ?? null, unit_converted: true } : {}),
        ...(r.unit_mismatch ? { source_value: r.source_value ?? r.value, source_unit: r.source_unit ?? r.unit ?? null, unit_mismatch: true, expected_unit: r.expected_unit ?? null } : {}),
      }))
      .filter((p) => Number.isFinite(p.value));
    // Deterministic trend over the numeric series (ascending by date). n<2 is
    // unknowable; otherwise dir is 'stable' when the net change is small vs the
    // series' own spread (so a marker that barely moved doesn't read as a trend),
    // else 'rising'/'falling'. No score — just direction + raw change + span.
    const n = points.length;
    const zone = last.unit_mismatch ? null : matchOptimalZone(displayName, zoneProfile);
    const sourceReference =
      last.ref_low != null || last.ref_high != null
        ? { low: last.ref_low ?? null, high: last.ref_high ?? null, source: last.ref_source ?? "source_lab", source_url: last.ref_source_url ?? null }
        : null;
    const curatedReference = sourceReference || last.unit_mismatch
      ? null
      : matchClinicalReferenceRange(displayName, unit, zoneProfile) ?? matchClinicalReferenceRange(last.name, unit, zoneProfile);
    const reference = sourceReference
      ? { low: sourceReference.low, high: sourceReference.high }
      : curatedReference
        ? { low: curatedReference.low, high: curatedReference.high }
        : null;
    let trend: {
      dir: "rising" | "falling" | "stable" | null;
      change: number | null;
      span_days: number | null;
      n: number;
      slope_per_week: number | null;        // least-squares slope, value/week (rounded)
      projection: string | null;            // PLAIN-LANGUAGE forecast vs optimal — words, no score
    };
    let forecast: MarkerForecast = { direction: null, eta_text: null, eta_weeks: null, crossing: null };
    if (n < 2) {
      trend = { dir: null, change: null, span_days: null, n, slope_per_week: null, projection: null };
    } else {
      const first = points[0];
      const lastP = points[n - 1];
      // round to 2 decimals so float noise (5.6-5.8 = -0.1999…) never leaks into the JSON/agent prompt
      const change = Math.round((lastP.value - first.value) * 100) / 100;
      const vals = points.map((p) => p.value);
      const range = Math.max(...vals) - Math.min(...vals);
      const span_days = Math.round((Date.parse(lastP.date) - Date.parse(first.date)) / 86_400_000) || 0;
      // Least-squares slope over the whole series (robust to a single noisy
      // reading) — supersedes the two-point delta for direction. `change` (the raw
      // first→last delta) stays for back-compat. dir 'stable' when the line barely
      // moves the value across the series' own window vs its spread.
      const slope = lsqSlopePerDay(points);
      const weekly = slope != null ? slope * 7 : null;
      const projectedMove = slope != null ? Math.abs(slope) * Math.max(1, span_days) : 0;
      const dir: "rising" | "falling" | "stable" | null =
        weekly == null
          ? (range > 0 && Math.abs(change) < range * 0.05 ? "stable" : change > 0 ? "rising" : change < 0 ? "falling" : "stable")
          : projectedMove < Math.max(range * 0.05, 1e-9)
            ? "stable"
            : weekly > 0 ? "rising" : weekly < 0 ? "falling" : "stable";
      // Forecast vs the OPTIMAL band — plain-language projection + eta direction.
      forecast = forecastMarker(points, slope, zone);
      // Don't project a confident trend the data can't support:
      //  • genetically-fixed markers (Lp(a), ApoE, MTHFR) don't "trend" — the honest
      //    read is 'stable', with no ETA.
      //  • n<3 readings can't sustain a projection (an n=2 Lp(a) once read "falling,
      //    ~3 weeks to optimal" off two dots) — keep the raw direction, drop the ETA.
      //  • an implausibly steep slope (>50%/week of the value) won't hold — drop the ETA.
      const nonTrending = isNonTrendingMarker(displayName);
      const implausibleSlope = weekly != null && Number.isFinite(lastP.value) && lastP.value !== 0 && Math.abs(weekly) > Math.abs(lastP.value) * 0.5;
      const suppressProjection = nonTrending || n < 3 || implausibleSlope;
      if (nonTrending) forecast = { direction: "stable", eta_text: null, eta_weeks: null, crossing: null };
      else if (suppressProjection) forecast = { direction: null, eta_text: null, eta_weeks: null, crossing: null };
      trend = {
        dir: nonTrending ? "stable" : dir,
        change,
        span_days,
        n,
        slope_per_week: weekly == null ? null : Math.round(weekly * 1000) / 1000,
        projection: suppressProjection ? null : forecast.eta_text,
      };
    }
    const grp = markerGroup(displayName);
    return {
      key,
      name: displayName,
      source_name: last.name !== displayName ? last.name : null,
      source_names: sourceNames.filter((n) => n !== displayName),
      unit,
      group: grp.key,
      group_label: grp.label,
      // The lab's printed reference range for the latest reading (source-of-truth
      // when there's no evidence-anchored optimal zone). If the upload omitted
      // a range for a standard marker, a curated source-backed clinical reference
      // interval may fill it; source_lab always wins over this fallback.
      reference,
      reference_source: sourceReference ? "source_lab" : curatedReference?.source ?? null,
      reference_source_url: sourceReference ? null : curatedReference?.source_url ?? null,
      latest: toPublicReading(last, true),
      prev: before && seriesUnitsCompatible(before.unit, unit) ? toPublicReading(before) : null,
      trend,
      // Forecast vs the OPTIMAL band: {direction:'improving'|'worsening'|'stable',
      // eta_text (plain language), crossing}. eta_weeks is kept INTERNAL (ordering
      // only) and never surfaced as a grade. Null fields when there's nothing to say.
      forecast: { direction: forecast.direction, eta_text: forecast.eta_text, crossing: forecast.crossing },
      // How many older readings were left OUT of the trend because they sit on an
      // incompatible unit (no safe conversion). 0 when nothing was dropped — so the
      // series is never silently truncated without a signal a consumer can show.
      dropped_other_units,
      points,
    };
  });

  // Flagged-latest markers (low/high) first, then alphabetical by display name.
  markers.sort((a, b) => {
    const af = a.latest.flag === "low" || a.latest.flag === "high" ? 0 : 1;
    const bf = b.latest.flag === "low" || b.latest.flag === "high" ? 0 : 1;
    if (af !== bf) return af - bf;
    return a.name.localeCompare(b.name);
  });

  const sliced = markers.slice(0, 200);
  return { markers: sliced, groups: presentGroups(sliced) };
}

// ---------- health reviews (agentic whole-picture read) ----------
function hydrateHealthReview(row: any) {
  if (!row) return null;
  let parsed: any = null;
  try { parsed = row.parsed_json ? JSON.parse(row.parsed_json) : null; } catch { parsed = null; }
  return { ...row, parsed };
}

// Agent-provided reviews are coerced/clamped before write, same discipline as
// coerceMeal/coerceRecipe. Returns the hydrated row, or null when the parsed
// shape is unusable (headline, focus AND watchlist all empty — e.g. a stray
// coach-proposal response).
export function addHealthReview(parsed: any, agent: string | null, raw?: string) {
  if (!parsed || typeof parsed !== "object") return null;
  const STATUSES = new Set(["low", "high", "watch"]);
  const headline = capStr(parsed.headline, 240);
  const wins = (Array.isArray(parsed.wins) ? parsed.wins : [])
    .map((w: any) => capStr(w, 200))
    .filter(Boolean)
    .slice(0, 5);
  const watchlist = (Array.isArray(parsed.watchlist) ? parsed.watchlist : [])
    .filter((w: any) => w && typeof w === "object")
    .map((w: any) => ({
      marker: capStr(w.marker, 60),
      status: STATUSES.has(String(w.status)) ? String(w.status) : "watch",
      why: capStr(w.why, 240),
      action: capStr(w.action, 240),
    }))
    .filter((w: any) => w.marker)
    .slice(0, 8);
  const focus = (Array.isArray(parsed.focus) ? parsed.focus : [])
    .filter((f: any) => f && typeof f === "object")
    .map((f: any) => ({ title: capStr(f.title, 80), why: capStr(f.why, 240), action: capStr(f.action, 240) }))
    .filter((f: any) => f.title)
    .slice(0, 4);
  const followups = (Array.isArray(parsed.followups) ? parsed.followups : [])
    .filter((f: any) => f && typeof f === "object")
    .map((f: any) => ({ what: capStr(f.what, 200), when: capStr(f.when, 80) }))
    .filter((f: any) => f.what)
    .slice(0, 6);
  const training_impact = capStr(parsed.training_impact, 400);
  const nutrition_impact = capStr(parsed.nutrition_impact, 400);
  // Cross-domain directives the agent emitted (the connected brain). Coerced/
  // clamped like the rest; carried on the review so the propagation engine
  // (Stage-2 T4) can persist them into health_directives. Additive — older
  // consumers ignore it.
  const DOMAINS = new Set(["nutrition", "training", "watch"]);
  const directives = (Array.isArray(parsed.directives) ? parsed.directives : [])
    .filter((d: any) => d && typeof d === "object")
    .map((d: any) => ({
      domain: DOMAINS.has(String(d.domain)) ? String(d.domain) : "watch",
      marker: d.marker != null && String(d.marker).trim() ? capStr(d.marker, 60) : null,
      directive: capStr(d.directive, 600),
      rationale: capStr(d.rationale, 600),
      citation: d.citation == null || String(d.citation).trim() === "" ? null : capStr(d.citation, 600) || null,
    }))
    .filter((d: any) => d.directive)
    .slice(0, 12);
  if (!headline && !focus.length && !watchlist.length) return null;
  const clean = { headline, wins, watchlist, focus, followups, training_impact, nutrition_impact, directives };
  const info = db
    .prepare(`INSERT INTO health_reviews (agent, parsed_json, raw_output) VALUES (?, ?, ?)`)
    .run(agent ?? null, JSON.stringify(clean), raw ?? null);
  // Propagate the review's directives into health_directives (source
  // 'health_review', coexisting with the deterministic 'markers' source).
  // Never auto-applies anything beyond recording the directive for review. Only
  // rewrite when the agent actually addressed directives: an explicit array (even
  // empty = "nothing flagged now") replaces the set; an ABSENT field preserves it.
  if (Array.isArray(parsed.directives)) applyReviewDirectives(directives);
  return hydrateHealthReview(db.prepare(`SELECT * FROM health_reviews WHERE id = ?`).get(info.lastInsertRowid));
}

export function getLatestHealthReview() {
  return hydrateHealthReview(db.prepare(`SELECT * FROM health_reviews ORDER BY id DESC LIMIT 1`).get() ?? null);
}

export function listHealthReviews(limit = 10) {
  return (db.prepare(`SELECT * FROM health_reviews ORDER BY id DESC LIMIT ?`).all(limit) as any[]).map(hydrateHealthReview);
}

// ---------- context events (life timeline the coach plans around) ----------
function hydrateContextEvent(row: any) {
  if (!row) return row;
  let meta: any = null;
  try { meta = row.meta_json ? JSON.parse(row.meta_json) : null; } catch { meta = null; }
  const { meta_json, ...rest } = row;
  return { ...rest, meta };
}

export interface ContextEventInput {
  kind?: string;
  title?: string | null;
  detail?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  meta?: any;
  archived?: boolean;
  expected_recovery_days?: number | null;
  resolved_at?: string | null;
}

// Default healing window (days) for an injury with no explicit expected_recovery_days,
// keyed off self-reported severity. Minor things (a cut, a blister, a tweak) fade in
// days; a real strain lingers; a tear/fracture lingers for weeks. Conservative and
// deterministic — an injury with no severity defaults to a short-ish week so a passing
// niggle stops gating the day-read once it's clearly outlived its window.
const INJURY_WINDOW_BY_SEVERITY: Record<string, number> = { mild: 5, moderate: 14, severe: 42 };
const DEFAULT_INJURY_WINDOW_DAYS = 7;

export function defaultInjuryWindow(severity?: string | null): number {
  const s = String(severity ?? "").trim().toLowerCase();
  return INJURY_WINDOW_BY_SEVERITY[s] ?? DEFAULT_INJURY_WINDOW_DAYS;
}

export function addContextEvent(input: ContextEventInput) {
  const kind = input.kind && ["trip", "injury", "life_event", "family_event"].includes(input.kind) ? input.kind : "life_event";
  // Injuries get an expected healing window so the brain can let them fade: honor an
  // explicit value, else default from severity. Non-injury events stay open-ended.
  let erd: number | null = null;
  if (input.expected_recovery_days != null && Number.isFinite(Number(input.expected_recovery_days))) {
    erd = Math.max(1, Math.round(Number(input.expected_recovery_days)));
  } else if (kind === "injury") {
    erd = defaultInjuryWindow(input.meta?.severity);
  }
  const info = db
    .prepare(
      `INSERT INTO context_events (kind, title, detail, start_date, end_date, meta_json, archived, expected_recovery_days, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      kind,
      input.title ?? null,
      input.detail ?? null,
      input.start_date ?? null,
      input.end_date ?? null,
      input.meta != null ? JSON.stringify(input.meta) : null,
      input.archived ? 1 : 0,
      erd,
      input.resolved_at ?? null
    );
  // A just-added trip/injury/life event shapes TODAY (ease the load / expect worse
  // sleep / plan around it) — bust the cached Brief so the next open reflects it,
  // from EVERY surface (REST/MCP/chat), not just the chat path.
  try { invalidateDayRead(); } catch { /* best-effort */ }
  bumpTrainingDataVersion(); // an active trip/illness suppresses expenditure confidence
  return getContextEvent(Number(info.lastInsertRowid));
}

export function listContextEvents(opts: { activeOnly?: boolean } = {}) {
  let rows: any[];
  if (opts.activeOnly) {
    // Active/upcoming = not archived, not explicitly resolved, AND (no end_date OR
    // end_date >= today). A confirmed-healed injury drops out of the active set.
    const today = localDateISO();
    rows = db
      .prepare(
        `SELECT * FROM context_events
         WHERE archived = 0 AND (resolved_at IS NULL OR resolved_at > ?) AND (end_date IS NULL OR end_date >= ?)
         ORDER BY (start_date IS NULL), start_date, id`
      )
      .all(today, today) as any[];
  } else {
    rows = db.prepare(`SELECT * FROM context_events ORDER BY (start_date IS NULL), start_date DESC, id DESC`).all() as any[];
  }
  return rows.map((r) => annotateHealing(hydrateContextEvent(r)));
}

export function getContextEvent(id: number) {
  const row = db.prepare(`SELECT * FROM context_events WHERE id = ?`).get(id) as any;
  return row ? annotateHealing(hydrateContextEvent(row)) : null;
}

export function updateContextEvent(id: number, patch: ContextEventInput) {
  const cur = db.prepare(`SELECT * FROM context_events WHERE id = ?`).get(id) as any;
  if (!cur) return null;
  const kind = patch.kind && ["trip", "injury", "life_event", "family_event"].includes(patch.kind) ? patch.kind : cur.kind;
  const merged = {
    kind,
    title: patch.title !== undefined ? patch.title : cur.title,
    detail: patch.detail !== undefined ? patch.detail : cur.detail,
    start_date: patch.start_date !== undefined ? patch.start_date : cur.start_date,
    end_date: patch.end_date !== undefined ? patch.end_date : cur.end_date,
    meta_json: patch.meta !== undefined ? (patch.meta != null ? JSON.stringify(patch.meta) : null) : cur.meta_json,
    archived: patch.archived !== undefined ? (patch.archived ? 1 : 0) : cur.archived,
    expected_recovery_days: patch.expected_recovery_days !== undefined
      ? (patch.expected_recovery_days == null || !Number.isFinite(Number(patch.expected_recovery_days)) ? null : Math.max(1, Math.round(Number(patch.expected_recovery_days))))
      : cur.expected_recovery_days,
    resolved_at: patch.resolved_at !== undefined ? patch.resolved_at : cur.resolved_at,
  };
  db.prepare(
    `UPDATE context_events SET kind=?, title=?, detail=?, start_date=?, end_date=?, meta_json=?, archived=?, expected_recovery_days=?, resolved_at=? WHERE id=?`
  ).run(merged.kind, merged.title, merged.detail, merged.start_date, merged.end_date, merged.meta_json, merged.archived, merged.expected_recovery_days, merged.resolved_at, id);
  // An edited event can change what shapes today (a new end date, a resolution) —
  // refresh the Brief from every surface.
  try { invalidateDayRead(); } catch { /* best-effort */ }
  bumpTrainingDataVersion(); // an in-place edit (end date/resolution) the backstop can't see
  return getContextEvent(id);
}

// Close a context event as healed/over WITHOUT hard-deleting it: stamp resolved_at so
// it drops out of the active set (stops gating the day-read/conductor) but stays on the
// timeline and in exports. `date` defaults to today; returns the hydrated row or null.
export function resolveContextEvent(id: number, date?: string) {
  const cur = db.prepare(`SELECT id FROM context_events WHERE id = ?`).get(id) as any;
  if (!cur) return null;
  const when = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : localDateISO();
  db.prepare(`UPDATE context_events SET resolved_at = ? WHERE id = ?`).run(when, id);
  // A resolved injury no longer eases load — the next Brief should reflect that.
  try { invalidateDayRead(); } catch { /* best-effort */ }
  bumpTrainingDataVersion(); // resolving an event re-opens expenditure confidence
  return getContextEvent(id);
}

export interface HealthDocContextEventMatch {
  event_id: number;
  health_document_id: number;
  score: number;
  resolved_at: string;
  reason: string;
}

const VISIT_DOCUMENT_TEXT =
  /\b(after visit summary|visit note|progress note|office visit|televisit|adult patient visit|primary care|pcp|assessment\/plan|follow[-\s]?up)\b/i;
const PCP_CONTEXT_TEXT =
  /\b(pcp|primary care|doctor|clinician|clinic|appointment|visit|follow[-\s]?up|televisit|check[-\s]?up|physical)\b/i;

function compactText(...parts: unknown[]): string {
  return parts
    .flatMap((p) => Array.isArray(p) ? p : [p])
    .filter((p) => p != null)
    .map((p) => String(p).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function healthDocEventDate(doc: any): string | null {
  const own = String(doc?.doc_date ?? "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(own)) return own;
  const facts = Array.isArray(doc?.parsed?.clinical_facts) ? doc.parsed.clinical_facts : [];
  for (const f of facts) {
    const d = String(f?.date ?? "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  }
  return null;
}

function healthDocVisitText(doc: any): string {
  const facts = Array.isArray(doc?.parsed?.clinical_facts) ? doc.parsed.clinical_facts : [];
  return compactText(
    doc?.kind,
    doc?.summary,
    doc?.original_name,
    facts.flatMap((f: any) => [f?.kind, f?.name, f?.status, f?.source, f?.detail]),
  );
}

function healthDocLooksLikeCompletedVisit(doc: any): boolean {
  const kind = String(doc?.kind ?? "");
  if (kind === "visit_note" || kind === "after_visit_summary") return true;
  const facts = Array.isArray(doc?.parsed?.clinical_facts) ? doc.parsed.clinical_facts : [];
  if (facts.some((f: any) => f?.kind === "encounter" && /\b(completed|done|visit|televisit|office)\b/i.test(compactText(f?.status, f?.name, f?.detail)))) {
    return true;
  }
  return VISIT_DOCUMENT_TEXT.test(healthDocVisitText(doc));
}

function scoreVisitEventMatch(event: any, docDate: string | null, docText: string): { score: number; reason: string } {
  if (!event || event.archived) return { score: 0, reason: "" };
  if (!["life_event", "family_event"].includes(String(event.kind ?? ""))) return { score: 0, reason: "" };
  if (event.meta?.matched_health_doc?.id) return { score: 0, reason: "" };
  const eventText = compactText(event.title, event.detail, event.meta && JSON.stringify(event.meta));
  if (!PCP_CONTEXT_TEXT.test(eventText)) return { score: 0, reason: "" };

  let score = 2;
  const reasons: string[] = ["planned clinical event"];
  if (/\b(pcp|primary care)\b/i.test(eventText)) { score += 3; reasons.push("PCP wording"); }
  if (/\b(appointment|visit|follow[-\s]?up|televisit)\b/i.test(eventText)) { score += 1; reasons.push("visit wording"); }
  if (/\b(pcp|primary care|after visit summary|visit note|televisit|office visit|adult patient visit)\b/i.test(docText)) {
    score += 2;
    reasons.push("matching visit document");
  }

  const eventDate = String(event.start_date ?? "").slice(0, 10);
  if (docDate && /^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
    const delta = Math.abs(daysBetweenISO(docDate, eventDate) ?? 99);
    if (delta === 0) { score += 5; reasons.push("same date"); }
    else if (delta === 1) { score += 3; reasons.push("one-day date match"); }
    else if (delta <= 3) { score += 1; reasons.push("nearby date"); }
    else return { score: 0, reason: "" };
  } else if (docDate || eventDate) {
    score += 1;
  }

  return { score, reason: reasons.join(", ") };
}

// When a processed visit note / after-visit summary clearly corresponds to a planned
// PCP-style life event, close the active event but keep it on the timeline with a
// provenance link to the health document. This prevents a completed appointment from
// continuing to shape the day-read as an upcoming obligation.
export function reconcileHealthDocumentContextEvents(healthDocumentId: number): HealthDocContextEventMatch[] {
  const doc = getHealthDocument(healthDocumentId) as any;
  if (!doc || !healthDocLooksLikeCompletedVisit(doc)) return [];
  const docDate = healthDocEventDate(doc);
  const docText = healthDocVisitText(doc);
  const events = listContextEvents({ activeOnly: false }) as any[];
  let best: { event: any; score: number; reason: string } | null = null;
  for (const event of events) {
    const scored = scoreVisitEventMatch(event, docDate, docText);
    if (scored.score < 8) continue;
    if (!best || scored.score > best.score) best = { event, ...scored };
  }
  if (!best) return [];

  const resolvedAt = docDate ?? localDateISO();
  const existingMeta = best.event.meta && typeof best.event.meta === "object" && !Array.isArray(best.event.meta)
    ? best.event.meta
    : {};
  const matched = {
    id: doc.id,
    kind: doc.kind,
    doc_date: docDate,
    summary: capStr(doc.summary, 240),
  };
  updateContextEvent(best.event.id, {
    meta: { ...existingMeta, matched_health_doc: matched },
    resolved_at: best.event.resolved_at ?? resolvedAt,
  });
  return [{
    event_id: best.event.id,
    health_document_id: doc.id,
    score: best.score,
    resolved_at: resolvedAt,
    reason: best.reason,
  }];
}

export function deleteContextEvent(id: number) {
  const r = { deleted: db.prepare(`DELETE FROM context_events WHERE id = ?`).run(id).changes };
  try { invalidateDayRead(); } catch { /* best-effort */ }
  if (r.deleted) bumpTrainingDataVersion();
  return r;
}

// ---- injury healing (temporal decay) ----------------------------------------
// An injury heals over time. Rather than gating training forever on a one-mention
// niggle, compute a deterministic healing read: past its expected window, with the
// affected area TRAINED since, and not explicitly resolved → LIKELY-RESOLVED (a soft
// note, no longer a hard constraint), without ever hard-deleting the record. Pure vs
// DB is split: `past_window` is computed from the event's own fields (testable
// offline); `trained_since` reads the log. Re-mention resets the clock naturally —
// the athlete (or the chat resolve hook) updates start_date / the window.
export interface ContextEventHealing {
  resolved: boolean;          // explicitly closed (resolved_at on/before today)
  past_window: boolean;       // an injury past start_date + expected_recovery_days
  trained_since: boolean;     // the injured area was trained after the window ended
  likely_resolved: boolean;   // past_window && trained_since && !resolved → soft, not a gate
  window_end: string | null;  // YYYY-MM-DD the expected window closes, or null
}

function addDaysISOLocal(iso: string, days: number): string | null {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t + days * 864e5).toISOString().slice(0, 10);
}

// Did the athlete train the injury's affected area on/after `sinceDate`? When the
// injury maps to known body-areas we require a matching movement to have been logged;
// when it maps to nothing recognizable (e.g. "foot sole cuts"), ANY logged training
// after the window is taken as "training resumed" (they're clearly moving through it).
function trainedAffectedAreaSince(ev: any, sinceDate: string): boolean {
  const sessions = db
    .prepare(
      `SELECT DISTINCT s.id FROM sessions s
       JOIN logged_sets ls ON ls.session_id = s.id
       WHERE s.date > ?`
    )
    .all(sinceDate) as any[];
  if (!sessions.length) return false;
  const areas = injuryAreas(ev);
  if (!areas.length) return true; // unmappable area → any training after the window counts
  const rows = db
    .prepare(
      `SELECT DISTINCT e.name AS name, e.muscle_group AS muscle_group FROM logged_sets ls
       JOIN sessions s ON s.id = ls.session_id
       JOIN exercises e ON e.id = ls.exercise_id
       WHERE s.date > ?`
    )
    .all(sinceDate) as any[];
  return rows.some((ex) => injuryAffectsExercise(ev, ex, areas));
}

export function contextEventHealing(ev: any, today = localDateISO()): ContextEventHealing {
  const resolved = !!(ev?.resolved_at && String(ev.resolved_at).slice(0, 10) <= today);
  const isInjury = ev?.kind === "injury";
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(ev?.start_date ?? "")) ? String(ev.start_date) : null;
  const erd = Number(ev?.expected_recovery_days);
  const window_end = isInjury && start && Number.isFinite(erd) ? addDaysISOLocal(start, erd) : null;
  const past_window = !!window_end && today > window_end;
  const trained_since = isInjury && past_window && !resolved ? trainedAffectedAreaSince(ev, window_end!) : false;
  const likely_resolved = isInjury && !resolved && past_window && trained_since;
  return { resolved, past_window, trained_since, likely_resolved, window_end };
}

// Attach the healing read to a hydrated context event (additive, null-safe). Non-injury
// events get resolved/likely_resolved=false and stay untouched.
function annotateHealing(ev: any) {
  if (!ev || typeof ev !== "object") return ev;
  const h = contextEventHealing(ev);
  return { ...ev, resolved: h.resolved, past_window: h.past_window, likely_resolved: h.likely_resolved };
}

// ============================================================================
// STRUCTURED INJURY TIMELINE — correlate active injuries with the exercises they
// touch, and suggest calm swaps (F3). DETERMINISTIC: works offline, agent-down.
//
// Today an injury is a free-form context_event (kind:'injury', meta {area,
// severity}) and an exercise carries an optional constraint_note — but nothing
// connects them. This is the connective tissue: for each active injury, which
// planned movements load the injured area, and a few safe alternatives for each.
// Suggestions ONLY — never mutates the plan (constitution: suggestion-not-gate).
// ============================================================================

// A body-area vocabulary: each region maps the words an athlete uses for the
// injury (matched against the injury title + detail + meta.area) to the
// muscle_group / exercise-name tokens that LOAD it. Matching mirrors
// matchOptimalZone / markerGroup — lowercased substring, evaluated against both
// the injury text and the exercise's muscle_group + name. Order is not
// significant (an exercise is affected if ANY of a matched region's load-tokens
// hit it). Kept intentionally small and conservative.
interface BodyArea {
  key: string;
  label: string;
  // words in the INJURY text that name this region
  injury: string[];
  // muscle_group / exercise-name tokens that LOAD this region
  load: string[];
}
const BODY_AREAS: BodyArea[] = [
  { key: "knee", label: "knee", injury: ["knee", "patella", "patellar", "acl", "mcl", "meniscus", "quad tendon", "vmo"],
    load: ["leg", "quad", "squat", "lunge", "split squat", "leg extension", "leg press", "step up", "calf"] },
  { key: "hip", label: "hip", injury: ["hip", "glute", "groin", "adductor", "hip flexor"],
    load: ["hip", "glute", "squat", "lunge", "split squat", "deadlift", "hinge", "thrust", "leg"] },
  { key: "lower_back", label: "lower back", injury: ["lower back", "low back", "lumbar", "spine", "disc", "si joint", "sciatic", "back strain"],
    load: ["deadlift", "romanian", "rdl", "hinge", "squat", "good morning", "bent-over row", "barbell row", "posterior", "back extension"] },
  { key: "hamstring", label: "hamstring", injury: ["hamstring", "ham string"],
    load: ["hamstring", "leg curl", "deadlift", "romanian", "rdl", "hinge", "posterior", "good morning"] },
  { key: "calf", label: "calf", injury: ["calf", "achilles", "ankle", "shin"],
    load: ["calf", "calves", "jump", "sprint", "run"] },
  { key: "shoulder", label: "shoulder", injury: ["shoulder", "rotator cuff", "deltoid", "delt", "ac joint", "labrum", "impingement"],
    load: ["shoulder", "delt", "press", "overhead", "bench", "incline", "lateral raise", "chest", "push-up", "dip"] },
  { key: "elbow", label: "elbow", injury: ["elbow", "tricep tendon", "tennis elbow", "golfer", "forearm"],
    load: ["tricep", "bicep", "curl", "pushdown", "press", "pull-up", "chin-up", "row", "extension"] },
  { key: "wrist", label: "wrist", injury: ["wrist", "hand", "thumb", "carpal"],
    load: ["curl", "press", "pull-up", "chin-up", "row", "deadlift", "grip", "front squat"] },
  { key: "chest", label: "chest", injury: ["chest", "pec", "sternum", "rib"],
    load: ["chest", "bench", "incline", "press", "fly", "dip", "push-up"] },
  { key: "neck", label: "neck", injury: ["neck", "cervical", "trap"],
    load: ["overhead", "shrug", "press", "deadlift", "row", "face pull"] },
];

// Tokens drawn from an exercise to match against a body-area's load list:
// its muscle_group + name, lowercased. (constraint_note is matched separately,
// as an independent affected-signal — a hand-noted limit on a movement is itself
// evidence it's risky for whatever it constrains.)
function exerciseTokens(ex: { name?: string; muscle_group?: string | null }): string {
  return `${ex.muscle_group ?? ""} ${ex.name ?? ""}`.toLowerCase();
}

// The injury's searchable text: title + detail + meta.area (the most specific
// signal). meta may arrive parsed (hydrateContextEvent) or as a raw string.
function injuryText(ev: any): string {
  let meta: any = ev?.meta;
  if (meta == null && ev?.meta_json) { try { meta = JSON.parse(ev.meta_json); } catch { meta = null; } }
  const area = meta && typeof meta === "object" ? meta.area : null;
  return `${ev?.title ?? ""} ${ev?.detail ?? ""} ${area ?? ""}`.toLowerCase();
}

// Which body-areas an injury names (an injury can implicate more than one — e.g.
// "knee and hip" — though usually one). Returns the matched BodyArea rows.
function injuryAreas(ev: any): BodyArea[] {
  const text = injuryText(ev);
  return BODY_AREAS.filter((a) => a.injury.some((w) => text.includes(w)));
}

// Does this injury load-affect this exercise? True when any matched area's
// load-token appears in the exercise's muscle_group/name. Exported as the small,
// well-tested deterministic core. `areas` may be precomputed for a batch.
export function injuryAffectsExercise(
  ev: any,
  ex: { name?: string; muscle_group?: string | null },
  areas?: BodyArea[]
): boolean {
  const matched = areas ?? injuryAreas(ev);
  if (!matched.length) return false;
  const toks = exerciseTokens(ex);
  return matched.some((a) => a.load.some((t) => toks.includes(t)));
}

// Suggest up to `limit` safe alternative exercises for an affected one: movements
// from the existing exercise list that do NOT load any of the injury's areas and
// sit in a DIFFERENT muscle group, preferring same-mode (reps↔reps, timed↔timed)
// and an explicitly-uninvolved muscle group. Suggestions only — never applied.
function suggestSwapsFor(
  affected: any,
  areas: BodyArea[],
  allExercises: any[],
  limit = 3
): { name: string; muscle_group: string | null; mode: "reps" | "timed"; why: string }[] {
  const affectedTokens = exerciseTokens(affected);
  const affectedMode = affected.mode === "timed" ? "timed" : "reps";
  const candidates = allExercises.filter((c) => {
    if (!c || !c.name) return false;
    if (String(c.name).toLowerCase() === String(affected.name ?? "").toLowerCase()) return false;
    // never suggest something that loads the injured area (areas are passed
    // explicitly, so the first arg is unused here)
    if (injuryAffectsExercise(null, c, areas)) return false;
    // skip another exercise that's already constraint-noted (likely also limited)
    if (c.constraint_note && String(c.constraint_note).trim()) return false;
    // a different muscle group than the affected movement
    const cmg = String(c.muscle_group ?? "").toLowerCase();
    if (cmg && affectedTokens.includes(cmg) && cmg.length > 2) {
      // same primary muscle group as the affected lift — only allow if it clearly
      // doesn't load the area (already checked) AND isn't an exact group echo
      return cmg !== String(affected.muscle_group ?? "").toLowerCase();
    }
    return true;
  });
  // rank: same mode first, then those whose muscle group differs from affected,
  // then alphabetical for stable, deterministic output.
  candidates.sort((a, b) => {
    const am = (a.mode === "timed" ? "timed" : "reps") === affectedMode ? 0 : 1;
    const bm = (b.mode === "timed" ? "timed" : "reps") === affectedMode ? 0 : 1;
    if (am !== bm) return am - bm;
    return String(a.name).localeCompare(String(b.name));
  });
  return candidates.slice(0, limit).map((c) => ({
    name: c.name,
    muscle_group: c.muscle_group ?? null,
    mode: (c.mode === "timed" ? "timed" : "reps") as "timed" | "reps",
    why: c.muscle_group ? `hits ${c.muscle_group}, clear of the area` : "clear of the area",
  }));
}

// The full structured read: for each ACTIVE injury context_event, the planned
// exercises it touches (with where they appear in the plan + any existing
// constraint_note) and a few safe swap suggestions per affected movement. Pure
// read — surfaced calmly in the Life tab / on Today, never auto-applied.
//
// Shape: { injuries: [{ id, title, area, severity, since, areas:[label],
//   affected:[{ exercise, muscle_group, mode, constraint_note, days:[{day_number,
//   day_name}], swaps:[{name,muscle_group,mode,why}] }] }], count }
export function getInjuryImpacts() {
  // A likely-resolved injury (past its window with the area trained since) no longer
  // gates exercises as a hard constraint — it's downgraded to a soft note elsewhere.
  const injuries = (listContextEvents({ activeOnly: true }) as any[]).filter((e) => e.kind === "injury" && !e.likely_resolved);
  if (!injuries.length) return { injuries: [], count: 0 };

  const allExercises = listExercises() as any[];
  const plan = getPlan() as any[]; // [{ day_number, name, items:[{exercise, muscle_group, mode, constraint_note, ...}] }]

  // Build a unique set of planned exercises with the days they appear on.
  const plannedByName = new Map<string, { ex: any; days: { day_number: number; day_name: string }[] }>();
  for (const d of plan) {
    for (const it of d.items ?? []) {
      const key = String(it.exercise ?? "").toLowerCase();
      if (!key) continue;
      if (!plannedByName.has(key)) {
        plannedByName.set(key, {
          ex: { name: it.exercise, muscle_group: it.muscle_group ?? null, mode: it.mode ?? "reps", constraint_note: it.constraint_note ?? null },
          days: [],
        });
      }
      plannedByName.get(key)!.days.push({ day_number: d.day_number, day_name: d.name });
    }
  }

  const out = injuries.map((inj) => {
    const areas = injuryAreas(inj);
    let meta: any = inj.meta;
    if (meta == null && inj.meta_json) { try { meta = JSON.parse(inj.meta_json); } catch { meta = null; } }
    meta = meta && typeof meta === "object" ? meta : {};
    const affected = [...plannedByName.values()]
      .filter(({ ex }) =>
        injuryAffectsExercise(inj, ex, areas) ||
        // a constraint_note that names the injured area is itself an affected signal
        (ex.constraint_note && areas.some((a) => String(ex.constraint_note).toLowerCase().includes(a.label) || a.injury.some((w) => String(ex.constraint_note).toLowerCase().includes(w)))))
      .map(({ ex, days }) => ({
        exercise: ex.name,
        muscle_group: ex.muscle_group,
        mode: (ex.mode === "timed" ? "timed" : "reps") as "timed" | "reps",
        constraint_note: ex.constraint_note || null,
        days,
        swaps: areas.length ? suggestSwapsFor(ex, areas, allExercises) : [],
      }))
      .sort((a, b) => String(a.exercise).localeCompare(String(b.exercise)));
    return {
      id: inj.id,
      title: inj.title || "Injury",
      area: meta.area || (areas[0] ? areas[0].label : null),
      severity: meta.severity || null,
      since: inj.start_date || null,
      areas: areas.map((a) => a.label),
      affected,
    };
  });

  const count = out.reduce((n, i) => n + i.affected.length, 0);
  return { injuries: out, count };
}
