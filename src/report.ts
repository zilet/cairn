// Clinician-facing health report — a doctor-ready, print-to-PDF document.
//
// Distinct from `buildHealthExport()` (the FHIR-inspired JSON interchange slice):
// this is a HUMAN artifact. It renders the same marker history Cairn already
// derives (prioritizeMarkers → latest value + the lab's range + optimal band + trend +
// full dated history, grouped into clinical panels) as a self-contained,
// print-optimized HTML page a physician can read — or "Save as PDF" and attach
// to a MyChart message. A plain-text twin is generated for pasting straight into
// a MyChart message body.
//
// CONSTITUTION: no 0-100 scores anywhere (the internal impact_score never crosses
// the prioritizeMarkers boundary). "Optimal target" bands are evidence-anchored
// preventive/longevity references, clearly labeled as DISTINCT from a lab's
// population reference interval — informational, not medical advice.

import crypto from "node:crypto";
import * as repo from "./repo.js";
import { formatReportDate, formatReportDateShort, reportDateISO, reportDaysBetween, reportTodayISO } from "./reportDates.js";
import { round1 } from "./lib/numbers.js";
import { LB_PER_KG } from "./repo/display-words.js";
import { optimalTrustworthy } from "./repo/optimal-trust.js";
import { labRangeRead } from "./repo/lab-range.js";
import { labUnitSystemWords, presentMarkerRow } from "./repo/lab-display.js";
import { labUnitSystem } from "./repo/settings.js";
import type {
  ClientHealthReportJson,
  ClientReportGroup,
  ClientReportMarker,
  ClientReportMarkerJson,
  ClientReportSectionId,
  ClientReportTargetKind,
} from "./contracts/health-records.js";
import { resolveVisitQuestions, type VisitQuestion } from "./domain/health/visit-questions.js";

export type ReportSectionId = ClientReportSectionId;

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const fmtDate = formatReportDate;
const fmtShort = formatReportDateShort;
const dayISO = reportDateISO;
const daysBetween = reportDaysBetween;

function fmtVal(v: unknown): string {
  if (v == null || v === "") return "—";
  if (typeof v === "number") {
    if (Number.isInteger(v)) return String(v);
    const abs = Math.abs(v);
    const places = abs < 2 ? 3 : abs < 100 ? 2 : 1;
    return String(Math.round(v * (10 ** places)) / (10 ** places));
  }
  return String(v);
}

function parseLabNumberLike(input: unknown): number {
  if (typeof input === "number") return Number.isFinite(input) ? input : Number.NaN;
  const match = String(input ?? "").trim().match(/[+-]?\d+(?:[.,]\d+)?/);
  if (!match) return Number.NaN;
  const out = Number(match[0].replace(",", "."));
  return Number.isFinite(out) ? out : Number.NaN;
}

function heightText(cm?: number | null): string {
  if (!cm || !Number.isFinite(cm)) return "";
  const totalIn = cm / 2.54;
  const ft = Math.floor(totalIn / 12);
  const inch = Math.round(totalIn - ft * 12);
  return `${ft}'${inch}" (${Math.round(cm)} cm)`;
}

// The optimal band as a target phrase. `dir` is the WORSE direction: 'high' →
// lower is better (≤ high), 'low' → higher is better (≥ low), else a band.
function optimalText(o: { low: number; high: number; dir: string } | null): string | null {
  if (!o) return null;
  if (o.dir === "high") return `≤ ${fmtVal(o.high)}`;
  if (o.dir === "low") return `≥ ${fmtVal(o.low)}`;
  return `${fmtVal(o.low)}–${fmtVal(o.high)}`;
}

function rangeText(range: { low?: number | null; high?: number | null } | null): string | null {
  if (!range) return null;
  const hasLow = range.low != null && Number.isFinite(Number(range.low));
  const hasHigh = range.high != null && Number.isFinite(Number(range.high));
  if (!hasLow && !hasHigh) return null;
  if (hasLow && hasHigh) return `${fmtVal(range.low)}–${fmtVal(range.high)}`;
  if (hasHigh) return `≤ ${fmtVal(range.high)}`;
  return `≥ ${fmtVal(range.low)}`;
}

type TargetKind = ClientReportTargetKind;

function qualitativeExpectedText(name: string, value: unknown): string | null {
  const n = name.toLowerCase();
  const v = String(value ?? "").toLowerCase();
  if (/\b(abo|rhesus|rh\s*factor|blood type)\b/.test(n)) return "fixed trait";
  if (/\b(ecg|ekg|rhythm|sinus rhythm|troponin delta)\b/.test(n)) return "clinical context";
  if (/\b(urinalysis|urine|leukocyte esterase|nitrite|ketone|bilirubin|urobilinogen|cast|crystal|bacteria|epithelial)\b/.test(n)) {
    if (/\b(negative|none|not seen|absent|normal)\b/.test(v)) return "expected negative";
    return "urine context";
  }
  if (/\b(hepatitis|hiv|infection|antigen|antibody|ana|screen)\b/.test(n)) {
    if (/\b(negative|nonreactive|not detected|not present)\b/.test(v)) return "expected negative";
    if (Number.isFinite(parseLabNumberLike(value))) return "serology context";
    return "qualitative";
  }
  if (/\b(pattern|genotype|phenotype)\b/.test(n)) return "pattern context";
  if (/\b(negative|nonreactive|not detected|none|not present|absent)\b/.test(v)) return "expected negative";
  return null;
}

function contextualTargetText(name: string, value: unknown, flag: "high" | "low" | null): { text: string; kind: TargetKind } {
  if (flag === "high" || flag === "low") return { text: `source flagged ${flag}`, kind: "source_flag" };
  const qualitative = qualitativeExpectedText(name, value);
  if (qualitative) return { text: qualitative, kind: qualitative.startsWith("expected") ? "expected" : "context" };
  if (isDexaSupportOnlyBodyCompName(name) || isBoneDensityName(name) || isLeanMassIndexName(name)) return { text: "DEXA context", kind: "context" };
  if (/\b(body|weight|height|mass|age|rer|rmr|metabolic|fitness|oxidation|utilization|fuel)\b/i.test(name)) return { text: "tracking context", kind: "context" };
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return { text: "qualitative", kind: "context" };
  return { text: "source context", kind: "context" };
}

function targetSummary(args: {
  name: string;
  value: unknown;
  flag: "high" | "low" | null;
  optimalText: string | null;
  reference?: { low?: number | null; high?: number | null } | null;
}): { text: string; kind: TargetKind; referenceText: string | null } {
  const reference = rangeText(args.reference ?? null);
  if (args.optimalText) return { text: args.optimalText, kind: "optimal", referenceText: reference };
  if (reference) return { text: `ref ${reference}`, kind: "reference", referenceText: reference };
  const fallback = contextualTargetText(args.name, args.value, args.flag);
  return { ...fallback, referenceText: null };
}

// Span in human words from a day count.
function spanText(days?: number | null): string {
  if (!days || days < 1) return "";
  if (days < 60) return `${days} d`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months} mo`;
  return `${Math.round((days / 365.25) * 10) / 10} yr`;
}

function freshnessWindowDays(name: string): number | null {
  const n = name.toLowerCase();
  if (/lipoprotein\s*\(?a\)?|\blp\s*\(?a\)?|blood type|genotype/i.test(n)) return null;
  if (/hs[-\s]?crp|c[-\s]?reactive protein|\bcrp\b|sedimentation|sed rate|\besr\b|fibrinogen/i.test(n)) return 45;
  if (/body fat|fat mass|lean mass|total mass|visceral|android|gynoid|almi|ffmi|bone mineral|bmd|t[\s-]?score|z[\s-]?score/i.test(n)) return 120;
  if (/glucose|insulin|homa|c[-\s]?peptide|alt\b|ast\b|ggt|bilirubin|creatinine|egfr|bun\b|uric|tsh|testosterone|estradiol|cortisol|vitamin d|ferritin|iron|b12|folate|wbc|rbc|hemoglobin|hematocrit|platelet/i.test(n)) return 180;
  if (/cholesterol|\bldl\b|\bhdl\b|triglyceride|apolipoprotein|\bapo\s?b\b|non[-\s]?hdl/i.test(n)) return 365;
  return 365;
}

function findingFreshness(name: string, latestDate: string | null, asOf: string): { stale: boolean; note: string | null } {
  const maxDays = freshnessWindowDays(name);
  const ageDays = daysBetween(latestDate, asOf);
  if (maxDays == null || ageDays == null || ageDays <= maxDays) return { stale: false, note: null };
  return {
    stale: true,
    note: `Older result (${spanText(ageDays)} old); not highlighted as current for this marker.`,
  };
}

export type ReportMarker = ClientReportMarker;
export type ReportGroup = ClientReportGroup;

export interface ClinicalReportData {
  subject: { name: string | null; sex: string | null; age: number | null; heightText: string; weightLb: number | null };
  generated: string;
  dateRange: { from: string; to: string } | null;
  findings: ReportMarker[];
  groups: ReportGroup[];
  bodyComp: { label: string; summary: string; asOf: string | null } | null;
  supplements: Array<{ name: string; dose: string | null; frequency: string | null }>;
  sources: Array<{ date: string | null; kind: string; name: string }>;
  // The toggled-on sections, in catalog order. A renderer prints only these; the header
  // and the informational line are never a section and always print.
  sections: ReportSectionId[];
  visitQuestions: VisitQuestion[];
  disclaimer: string;
}

// ---- section toggles ----
//
// The ids name what the report already had (findings lead, clinical panels, the body
// composition caption, the supplement list, the source documents) plus the visit
// questions. Default = every section EXCEPT the source documents: the file-name list is
// opt-in (`sources`), so a packet never hands the athlete's raw upload names to a
// clinician unless asked. A section toggled off is ABSENT from HTML, text and JSON; the
// header and REPORT_DISCLAIMER print whatever is toggled.
export const REPORT_SECTIONS: ReadonlyArray<{ id: ReportSectionId; label: string }> = [
  { id: "findings", label: "Findings to discuss" },
  { id: "visit_questions", label: "Questions for the visit" },
  { id: "body_composition", label: "Body composition" },
  { id: "panels", label: "Results by panel" },
  { id: "supplements", label: "Supplements" },
  { id: "sources", label: "Source documents" },
];
export const REPORT_SECTION_IDS: ReadonlyArray<ReportSectionId> = REPORT_SECTIONS.map((s) => s.id);
const OPT_IN_SECTIONS: ReadonlySet<ReportSectionId> = new Set<ReportSectionId>(["sources"]);
export const REPORT_DEFAULT_SECTION_IDS: ReadonlyArray<ReportSectionId> = REPORT_SECTION_IDS.filter(
  (id) => !OPT_IN_SECTIONS.has(id)
);

export const REPORT_DISCLAIMER = "Informational, not medical advice.";

// `?sections=` → the toggled-on ids, in catalog order. Missing or blank = the default
// (every section but `sources`); `all` = every section; `none` = header and the
// informational line only; unknown ids are ignored (so a list of only unknown ids also
// falls back to the default rather than printing an empty page).
export function parseReportSections(raw: unknown): ReportSectionId[] {
  const parts = (Array.isArray(raw) ? raw : [raw])
    .flatMap((v) => (typeof v === "string" ? v.split(",") : []))
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length) return [...REPORT_DEFAULT_SECTION_IDS];
  if (parts.length === 1 && parts[0] === "none") return [];
  if (parts.length === 1 && parts[0] === "all") return [...REPORT_SECTION_IDS];
  const wanted = new Set(parts);
  const picked = REPORT_SECTION_IDS.filter((id) => wanted.has(id));
  return picked.length ? picked : [...REPORT_DEFAULT_SECTION_IDS];
}

function hasSection(data: ClinicalReportData, id: ReportSectionId): boolean {
  return data.sections.includes(id);
}

// The optimal-band trust guard lives with the zone data it guards
// (src/repo/optimal-trust.ts) so the repo-layer reads — the Records rows, the doctor
// loop's spoken reasons — apply the same test the packet does.
export { optimalTrustworthy } from "./repo/optimal-trust.js";

function isDirectLdlName(name: string): boolean {
  const n = name.toLowerCase();
  return /\bldl\b/.test(n) && /\bdirect\b/.test(n);
}

function isStandardLdlName(name: string): boolean {
  const n = name.toLowerCase();
  if (!/\bldl\b/.test(n)) return false;
  if (isDirectLdlName(n)) return false;
  if (/\bnon[-\s]?hdl\b/.test(n)) return false;
  if (/\bvldl\b/.test(n)) return false;
  if (/\b(particle|small|medium|peak|pattern|large)\b/.test(n)) return false;
  return /\bchol(?:esterol)?\b|\bcalc(?:ulated)?\b|\bc\b/.test(n);
}

function methodNote(name: string): string | null {
  if (isDirectLdlName(name)) return "Direct LDL-C assay; tracked separately from standard lipid-panel LDL-C.";
  if (isStandardLdlName(name)) return "Standard lipid-panel LDL-C; tracked separately from direct LDL-C assays.";
  return null;
}

function sourceNames(m: any, displayName: string): string[] {
  const raw = Array.isArray(m?.source_names) ? m.source_names : (m?.source_name ? [m.source_name] : []);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const name = String(item ?? "").replace(/\s+/g, " ").trim();
    if (!name || name === displayName || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out.slice(0, 4);
}

function sourceNote(m: ReportMarker): string | null {
  if (!m.sourceNames.length) return null;
  const label = m.sourceNames.length === 1 ? "Source label" : "Source labels";
  const suffix = m.sourceNames.length >= 4 ? "…" : "";
  return `${label}: ${m.sourceNames.join("; ")}${suffix}`;
}

function referenceSourceNote(m: ReportMarker): string | null {
  if (!m.referenceSource || m.referenceSource === "source_lab") return null;
  return `Reference source: ${m.referenceSource}`;
}

function isBodyFatPctName(name: string): boolean {
  const n = name.toLowerCase();
  return /\bbody fat\b/.test(n) && !/\b(trunk|arms|legs|android|gynoid)\b/.test(n);
}

function isTotalFatMassName(name: string): boolean {
  return /fat mass\s*\(total\)|^fat mass total$|^total fat mass$/i.test(name);
}

function isTotalLeanMassName(name: string): boolean {
  const n = name.toLowerCase();
  return /\blean mass\b/.test(n) && (/\btotal\b/.test(n) || /\(total\)/.test(n));
}

function isBodyWeightName(name: string): boolean {
  return /\bbody weight\b|^weight$|\btotal (?:body )?mass\b/i.test(name);
}

function isProfileHeightName(name: string): boolean {
  return /^height$|\bstature\b/i.test(name);
}

function isBodyMassIndexName(name: string): boolean {
  return /\bbmi\b|body mass index/i.test(name);
}

function isLeanMassIndexName(name: string): boolean {
  return /\b(almi|ffmi|appendicular|skeletal muscle mass index|lean mass index|fat[-\s]?free mass index)\b/i.test(name);
}

function isBoneDensityName(name: string): boolean {
  return /\b(bone mineral density|bmd|t[-\s]?score|z[-\s]?score)\b/i.test(name);
}

function isDexaSupportOnlyBodyCompName(name: string): boolean {
  const n = name.toLowerCase();
  if (isBodyFatPctName(name)) return false;
  if (isLeanMassIndexName(name)) return false;
  if (isBoneDensityName(name)) return false;
  if (isBodyWeightName(name) || isProfileHeightName(name)) return false;
  return (
    isTotalLeanMassName(name) ||
    isTotalFatMassName(name) ||
    /\bvisceral\b/.test(n) ||
    /\bandroid\b|\bgynoid\b/.test(n) ||
    /\bbone mineral content\b|\bbmc\b/.test(n) ||
    /\b(fat mass|lean mass|body fat)\b.*\b(trunk|arms?|legs?|android|gynoid)\b/.test(n)
  );
}

function appendNote(base: string | null, note: string): string {
  return base ? `${base} ${note}` : note;
}

interface BodyMetricEstimate {
  measurementDate: string;
  bodyFatPct: number;
  bodyFatZone: string | null;
  currentWeightLb: number | null;
  weightDate: string | null;
  fatMassLb: number | null;
  heightIn: number | null;
  measurements: Record<string, number>;
}

interface CurrentBodyContext {
  currentWeightLb: number | null;
  weightDate: string | null;
  heightCm: number | null;
  generatedDay: string;
}

function bodyMetricEstimate(bodyMetrics: any, currentWeightLb: unknown, weightDate: string | null, asOfISO?: string): BodyMetricEstimate | null {
  const latestDate = dayISO(bodyMetrics?.latest_date, { notAfter: asOfISO });
  const indicators = Array.isArray(bodyMetrics?.indicators) ? bodyMetrics.indicators : [];
  const bf = indicators.find((i: any) => String(i?.label || "").toLowerCase() === "body fat" && i?.estimate);
  const bodyFatPct = Number(bf?.value);
  if (!latestDate || !Number.isFinite(bodyFatPct)) return null;
  const weight = Number(currentWeightLb);
  const currentWeight = Number.isFinite(weight) ? weight : null;
  const measurements: Record<string, number> = {};
  const rawMeasurements = bodyMetrics?.measurements && typeof bodyMetrics.measurements === "object" ? bodyMetrics.measurements : {};
  for (const [key, value] of Object.entries(rawMeasurements)) {
    const n = Number(value);
    if (Number.isFinite(n)) measurements[key] = round1(n);
  }
  const fatMassLb = currentWeight != null ? round1(currentWeight * (bodyFatPct / 100)) : null;
  const h = Number(bodyMetrics?.height_in);
  return {
    measurementDate: latestDate,
    bodyFatPct: round1(bodyFatPct),
    bodyFatZone: bf?.zone ? String(bf.zone) : null,
    currentWeightLb: currentWeight,
    weightDate: dayISO(weightDate, { notAfter: asOfISO }),
    fatMassLb,
    heightIn: Number.isFinite(h) ? round1(h) : null,
    measurements,
  };
}

function measurementParts(est: BodyMetricEstimate): string {
  const labels: Record<string, string> = {
    waist_in: "waist",
    neck_in: "neck",
    hip_in: "hip",
    chest_in: "chest",
    shoulder_in: "shoulders",
    upper_arm_in: "upper arm",
    thigh_in: "thigh",
    calf_in: "calf",
  };
  return Object.entries(labels)
    .map(([key, label]) => (est.measurements[key] != null ? `${label} ${fmtVal(est.measurements[key])} in` : ""))
    .filter(Boolean)
    .slice(0, 5)
    .join(", ");
}

function appendSyntheticHistory(m: ReportMarker, value: number, date: string, flag: string | null): void {
  if (!date) return;
  const normalizedDate = dayISO(date);
  if (!normalizedDate) return;
  const exists = m.history.some((h) => h.date === normalizedDate && String(h.value) === String(value));
  if (!exists) m.history.push({ value, date: normalizedDate, flag });
  m.history.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

// A value Cairn re-derived (a logged weight, a calculated BMI, a tape estimate) is not
// the lab's reading, so it carries no lab flag and makes no claim about the lab's range.
function clearLabRange(m: ReportMarker): void {
  m.flag = null;
  m.labRange = "unranged";
  m.labRangeSide = null;
  m.labRangeBasis = null;
}

function refreshTargetText(m: ReportMarker): void {
  const target = targetSummary({ name: m.name, value: m.value, flag: m.flag, optimalText: m.optimalText, reference: m.reference });
  m.referenceText = target.referenceText;
  m.targetText = target.text;
  m.targetKind = target.kind;
}

function latestNumericHistory(m: ReportMarker): { value: number; date: string | null } | null {
  for (let i = m.history.length - 1; i >= 0; i--) {
    const value = Number(m.history[i]?.value);
    if (Number.isFinite(value)) return { value, date: m.history[i]?.date ?? null };
  }
  const value = Number(m.value);
  return Number.isFinite(value) ? { value, date: m.latestDate } : null;
}

function latestNumericHistoryExcluding(m: ReportMarker, date: string | null, value: number | null): { value: number; date: string | null } | null {
  for (let i = m.history.length - 1; i >= 0; i--) {
    const hValue = Number(m.history[i]?.value);
    if (!Number.isFinite(hValue)) continue;
    const sameDate = !!date && m.history[i]?.date === date;
    const sameValue = value != null && Number.isFinite(value) && Math.abs(hValue - value) < 0.05;
    if (sameDate && sameValue) continue;
    return { value: hValue, date: m.history[i]?.date ?? null };
  }
  return null;
}

function setSimpleTrendFromPrior(m: ReportMarker, prior: { value: number; date: string | null } | null, current: number): void {
  if (!prior || !Number.isFinite(prior.value)) return;
  const delta = current - prior.value;
  m.trendDir = Math.abs(delta) < 0.05 ? "stable" : delta > 0 ? "rising" : "falling";
}

function bodyWeightSourceLabel(m: ReportMarker): string {
  const source = [m.name, ...m.sourceNames].join(" ").toLowerCase();
  if (/\bdexa\b|\btotal mass\b/.test(source)) return "DEXA/source body weight";
  return "source body weight";
}

function applyCurrentBodyContext(m: ReportMarker, ctx: CurrentBodyContext): ReportMarker {
  const weight = Number(ctx.currentWeightLb);
  const weightDate = dayISO(ctx.weightDate, { notAfter: ctx.generatedDay });
  const hasLoggedWeight = Number.isFinite(weight) && !!weightDate;

  if (isBodyWeightName(m.name)) {
    const sourceLabel = bodyWeightSourceLabel(m);
    m.name = "Body Weight";
    m.unit = "lb";
    clearLabRange(m);
    m.optimal = null;
    m.optimalText = null;
    m.reference = null;
    m.referenceSource = null;
    m.referenceSourceUrl = null;
    m.referenceText = null;
    m.inOptimal = null;
    m.abnormal = false;
    m.estimated = false;
    m.history = m.history.map((h) => ({ ...h, flag: null }));
    m.targetText = "tracking context";
    m.targetKind = "context";
    if (hasLoggedWeight && weightDate && (!m.latestDate || weightDate >= m.latestDate)) {
      const prior = latestNumericHistoryExcluding(m, weightDate, weight);
      const priorDate = prior?.date ?? m.latestDate;
      m.value = round1(weight);
      m.latestDate = weightDate;
      m.dateLabel = null;
      appendSyntheticHistory(m, round1(weight), weightDate, null);
      setSimpleTrendFromPrior(m, prior, weight);
      m.trendText = prior && priorDate
        ? `logged weight ${fmtVal(weight)} lb ${fmtShort(weightDate)}; previous body weight ${fmtVal(prior.value)} lb ${fmtShort(priorDate)}`
        : `logged weight ${fmtVal(weight)} lb ${fmtShort(weightDate)}`;
      m.methodNote = `Latest logged body weight; dated ${sourceLabel} readings are kept in history.`;
      m.findingSuppressed = false;
      m.findingSuppressionNote = null;
      return m;
    }
    m.methodNote = appendNote(m.methodNote, "Dated body-weight reading from a source document; current profile/logged weight may be newer.");
    return m;
  }

  if (isBodyMassIndexName(m.name) && hasLoggedWeight && weightDate) {
    const heightCm = Number(ctx.heightCm);
    if (Number.isFinite(heightCm) && heightCm > 0 && (!m.latestDate || weightDate >= m.latestDate)) {
      const prior = latestNumericHistory(m);
      const heightM = heightCm / 100;
      const bmi = round1(weight / LB_PER_KG / (heightM * heightM));
      m.value = bmi;
      m.latestDate = weightDate;
      m.unit = "kg/m2";
      m.dateLabel = "calc. as of";
      clearLabRange(m);
      m.optimal = null;
      m.optimalText = null;
      m.reference = { low: 18.5, high: 24.9 };
      m.referenceSource = "CDC Adult BMI Categories";
      m.referenceSourceUrl = "https://www.cdc.gov/bmi/adult-calculator/bmi-categories.html";
      m.inOptimal = null;
      m.abnormal = false;
      m.estimated = true;
      m.history = m.history.map((h) => ({ ...h, flag: null }));
      appendSyntheticHistory(m, bmi, weightDate, null);
      setSimpleTrendFromPrior(m, prior, bmi);
      const priorText = prior && prior.date ? ` Source BMI was ${fmtVal(prior.value)} on ${fmtDate(prior.date)}.` : "";
      m.methodNote = `Calculated from ${fmtVal(weight)} lb logged weight on ${fmtDate(weightDate)} and profile height ${fmtVal(heightCm)} cm. CDC treats BMI as a screening measure to interpret with other health factors.${priorText}`;
      refreshTargetText(m);
    }
  }

  return m;
}

function normalizeHistory(points: any[], asOfISO: string): ReportMarker["history"] {
  const out: ReportMarker["history"] = [];
  const seen = new Set<string>();
  for (const p of points) {
    const date = dayISO(p?.date, { notAfter: asOfISO });
    if (!date) continue;
    // Only a document reading has a lab behind its flag; a home cuff reading's high/low
    // is Cairn's own threshold and never travels as a flag.
    const fromDocument = p?.doc_id != null && p.doc_id !== "";
    const flag = fromDocument ? (p?.flag ?? null) : null;
    const key = `${date}|${String(p?.value)}|${String(flag)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ value: p?.value, date, flag });
  }
  return out;
}

function applyBodyMetricEstimate(m: ReportMarker, estimate: BodyMetricEstimate | null, bodyComp: any, asOfISO: string): ReportMarker {
  if (!estimate) return m;
  const measuredDate = dayISO(bodyComp?.measured?.date, { notAfter: asOfISO });
  const measuredPct = Number(bodyComp?.measured?.value);
  const dexaFat = Number(bodyComp?.fat_mass?.dexa);
  const parts = measurementParts(estimate);
  const fromTape = `Tape-based Navy body-fat estimate from measurements on ${fmtDate(estimate.measurementDate)}${parts ? ` (${parts})` : ""}${estimate.heightIn != null ? ` and height ${fmtVal(estimate.heightIn)} in` : ""}`;
  const freshness = findingFreshness(m.name, estimate.measurementDate, dayISO(asOfISO) || reportTodayISO());

  if (isBodyFatPctName(m.name)) {
    const priorValue = Number(m.value);
    const priorDate = m.latestDate;
    m.value = estimate.bodyFatPct;
    m.latestDate = estimate.measurementDate;
    m.estimated = true;
    m.dateLabel = "tape est.";
    clearLabRange(m);
    m.methodNote = `${fromTape}. ${Number.isFinite(measuredPct) && measuredDate ? `DEXA measured ${round1(measuredPct)}% on ${fmtDate(measuredDate)}.` : "DEXA, when present, remains a dated scan anchor."}`;
    m.trendDir = Number.isFinite(priorValue) ? estimate.bodyFatPct < priorValue - 0.4 ? "falling" : estimate.bodyFatPct > priorValue + 0.4 ? "rising" : "stable" : m.trendDir;
    m.trendText = `tape estimate ${fmtVal(m.value)}% ${fmtShort(estimate.measurementDate)}${Number.isFinite(priorValue) && priorDate ? `; DEXA ${round1(priorValue)}% ${fmtShort(priorDate)}` : ""}`;
    const num = Number(m.value);
    if (m.optimal && Number.isFinite(num)) m.inOptimal = num >= m.optimal.low && num <= m.optimal.high;
    m.abnormal = m.inOptimal === false;
    m.staleForFinding = freshness.stale;
    m.freshnessNote = freshness.note;
    appendSyntheticHistory(m, estimate.bodyFatPct, estimate.measurementDate, null);
    refreshTargetText(m);
  } else if (isTotalFatMassName(m.name) && estimate.fatMassLb != null) {
    const priorValue = Number(m.value);
    const priorDate = m.latestDate;
    const resultDate = estimate.weightDate || estimate.measurementDate;
    m.value = estimate.fatMassLb;
    m.latestDate = resultDate;
    m.estimated = true;
    m.dateLabel = "est. as of";
    clearLabRange(m);
    m.inOptimal = null;
    m.abnormal = false;
    m.methodNote = `Estimated from the ${fmtDate(estimate.measurementDate)} tape body-fat estimate (${fmtVal(estimate.bodyFatPct)}%)${estimate.currentWeightLb != null ? ` and ${fmtVal(estimate.currentWeightLb)} lb weight${estimate.weightDate ? ` on ${fmtDate(estimate.weightDate)}` : ""}` : ""}. ${Number.isFinite(dexaFat) && measuredDate ? `DEXA fat mass was ${round1(dexaFat)} lb on ${fmtDate(measuredDate)}.` : ""}`.trim();
    m.trendDir = Number.isFinite(priorValue) ? estimate.fatMassLb < priorValue - 0.4 ? "falling" : estimate.fatMassLb > priorValue + 0.4 ? "rising" : "stable" : m.trendDir;
    m.trendText = `tape+weight estimate ${fmtVal(m.value)} lb${Number.isFinite(priorValue) && priorDate ? `; DEXA ${round1(priorValue)} lb ${fmtShort(priorDate)}` : ""}`;
    const resultFreshness = findingFreshness(m.name, resultDate, dayISO(asOfISO) || reportTodayISO());
    m.staleForFinding = resultFreshness.stale;
    m.freshnessNote = resultFreshness.note;
    appendSyntheticHistory(m, estimate.fatMassLb, resultDate, null);
    refreshTargetText(m);
  }
  return m;
}

function toMarkerView(m: any, asOfISO: string): ReportMarker {
  const name = String(m?.name ?? "");
  // "Out of range" per the LAB — the one rule (src/repo/lab-range.ts): the lab's own
  // flag, or the value outside the range the lab printed. A home reading has no lab.
  const lab = labRangeRead(m);
  const flag = lab.flag;
  const trusted = optimalTrustworthy(name, m?.latest?.value);
  const inOptimal = trusted && typeof m?.in_optimal === "boolean" ? m.in_optimal : null;
  const optimal = trusted && m?.optimal && Number.isFinite(m.optimal.low) && Number.isFinite(m.optimal.high)
    ? { low: m.optimal.low, high: m.optimal.high, dir: m.optimal.dir }
    : null;
  const optText = optimalText(optimal);
  const reference = m?.reference && (m.reference.low != null || m.reference.high != null)
    ? { low: m.reference.low ?? null, high: m.reference.high ?? null }
    : null;
  const target = targetSummary({ name, value: m?.latest?.value ?? null, flag, optimalText: optText, reference });
  const points = Array.isArray(m?.points) ? m.points : [];
  const t = m?.trend || {};
  // Build a plain-language trend phrase: direction + first→last over the span.
  let trendText: string | null = null;
  if (points.length >= 2 && t.dir) {
    const first = points[0];
    const last = points[points.length - 1];
    const span = spanText(t.span_days);
    trendText = `${t.dir} · ${fmtVal(first.value)}→${fmtVal(last.value)}${span ? ` over ${span}` : ""}`;
  } else if (t.projection) {
    trendText = String(t.projection);
  }
  const latestDate = dayISO(m?.latest?.date, { notAfter: asOfISO });
  const freshness = findingFreshness(name, latestDate, dayISO(asOfISO) || reportTodayISO());
  return {
    name,
    unit: m?.unit ?? null,
    value: m?.latest?.value ?? null,
    flag,
    labRange: lab.state,
    labRangeSide: lab.side,
    labRangeBasis: lab.basis,
    abnormal: lab.state === "out" || inOptimal === false,
    optimal,
    optimalText: optText,
    reference,
    referenceSource: m?.reference_source ?? null,
    referenceSourceUrl: m?.reference_source_url ?? null,
    referenceText: target.referenceText,
    targetText: target.text,
    targetKind: target.kind,
    inOptimal,
    latestDate,
    trendDir: t.dir ?? null,
    trendText,
    // A value its lab printed in another unit system says so, beside the shown value.
    methodNote: m?.latest?.reported
      ? appendNote(methodNote(name), `As reported: ${String(m.latest.reported)}.`)
      : methodNote(name),
    sourceNames: sourceNames(m, name),
    estimated: false,
    dateLabel: null,
    staleForFinding: freshness.stale,
    freshnessNote: freshness.note,
    findingSuppressed: false,
    findingSuppressionNote: null,
    history: normalizeHistory(points, asOfISO),
    source: m?.source ?? m?.latest?.kind ?? null,
  };
}

function applyBodyCompositionFindingPolicy(m: ReportMarker): ReportMarker {
  if (!isDexaSupportOnlyBodyCompName(m.name)) return m;
  if (m.estimated && isTotalFatMassName(m.name)) return m;

  if (isTotalLeanMassName(m.name)) {
    m.findingSuppressed = true;
    m.findingSuppressionNote =
      "DEXA lean mass is lean soft tissue, not a direct muscle/function diagnosis; shown as dated scan context, not a top finding without appendicular index, strength, or function evidence.";
    m.methodNote = appendNote(m.methodNote, m.findingSuppressionNote);
    m.targetText = "DEXA context";
    m.targetKind = "context";
    return m;
  }

  m.findingSuppressed = true;
  m.findingSuppressionNote =
    "DEXA body-composition submetric; kept as dated scan context while the body-fat/measurement estimate is the headline.";
  m.methodNote = appendNote(m.methodNote, m.findingSuppressionNote);
  m.targetText = "DEXA context";
  m.targetKind = "context";
  return m;
}

function applyVariableMetricFindingPolicy(m: ReportMarker): ReportMarker {
  if (m.source !== "wearable") return m;
  if (!/\b(hrv|heart rate variability|vo2\s?max|resting heart rate|resting hr|\brhr\b)\b/i.test(m.name)) return m;
  m.findingSuppressed = true;
  m.findingSuppressionNote =
    "Wearable-derived fitness/recovery metric; shown as longitudinal context, not a lab or diagnostic finding.";
  m.methodNote = appendNote(m.methodNote, m.findingSuppressionNote);
  return m;
}

type MarkerRankRule = { rank: number; re: RegExp };

const MARKER_ORDER: Record<string, MarkerRankRule[]> = {
  lipids: [
    { rank: 10, re: /^(?:total cholesterol|cholesterol,?\s*total)$/i },
    { rank: 20, re: /^(?!.*\bdirect\b)ldl\s*-?\s*(?:c|chol(?:esterol)?|calc(?:ulated)?)\b/i },
    { rank: 22, re: /\bldl\b.*\bdirect\b|\bdirect\b.*\bldl\b/i },
    { rank: 30, re: /^hdl\s*-?\s*(?:c|cholesterol)$/i },
    { rank: 40, re: /^non[-\s]?hdl/i },
    { rank: 50, re: /^triglycerides?$/i },
    { rank: 55, re: /\bvldl\b/i },
    { rank: 60, re: /total cholesterol.*hdl.*ratio|cholesterol.*hdl.*ratio/i },
    { rank: 70, re: /apolipoprotein b|\bapo\s?b\b/i },
    { rank: 80, re: /lipoprotein\s*\(?a\)?|\blp\s*\(?a\)?/i },
    { rank: 100, re: /ldl particle|ldl[-\s]?p\b/i },
    { rank: 110, re: /ldl small/i },
    { rank: 120, re: /ldl medium/i },
    { rank: 130, re: /ldl peak/i },
    { rank: 140, re: /hdl large/i },
    { rank: 150, re: /ldl pattern/i },
  ],
  metabolic: [
    { rank: 10, re: /^(?!.*\burine\b)(?!.*estimated average).*\bglucose\b/i },
    { rank: 20, re: /hemoglobin\s*a1c|\bhb\s?a1c\b|\ba1c\b/i },
    { rank: 30, re: /estimated average glucose|\beag\b/i },
    { rank: 40, re: /\binsulin\b/i },
    { rank: 50, re: /\bhoma\b/i },
    { rank: 60, re: /c[-\s]?peptide/i },
    { rank: 70, re: /fructosamine/i },
    { rank: 90, re: /\burine\b.*\bglucose\b|\bglucose\b.*\burine\b/i },
  ],
  inflammation: [
    { rank: 10, re: /high[-\s]?sensitivity.*c[-\s]?reactive|hs[-\s]?crp/i },
    { rank: 20, re: /\bc[-\s]?reactive protein\b|\bcrp\b/i },
    { rank: 30, re: /erythrocyte sedimentation|sedimentation rate|\besr\b|\bsed rate\b/i },
    { rank: 40, re: /fibrinogen/i },
    { rank: 50, re: /homocysteine/i },
    { rank: 60, re: /rheumatoid factor/i },
  ],
  iron: [
    { rank: 10, re: /\brbc\b|red blood cell/i },
    { rank: 20, re: /hemoglobin|\bhgb\b/i },
    { rank: 30, re: /hematocrit|\bhct\b/i },
    { rank: 40, re: /\bmcv\b|mean corpuscular volume/i },
    { rank: 50, re: /\bmch\b|mean corpuscular hemoglobin/i },
    { rank: 60, re: /\bmchc\b/i },
    { rank: 70, re: /\brdw\b|red cell distribution/i },
    { rank: 90, re: /ferritin/i },
    { rank: 100, re: /transferrin saturation|% saturation|iron saturation/i },
    { rank: 110, re: /serum iron|^iron\b/i },
    { rank: 120, re: /\btibc\b|total iron binding/i },
    { rank: 130, re: /transferrin/i },
  ],
  blood: [
    { rank: 10, re: /\bwbc\b|white blood cell|leukocyte/i },
    { rank: 20, re: /neutrophil/i },
    { rank: 30, re: /lymphocyte/i },
    { rank: 40, re: /monocyte/i },
    { rank: 50, re: /eosinophil/i },
    { rank: 60, re: /basophil/i },
    { rank: 70, re: /platelet|\bplt\b/i },
    { rank: 80, re: /mpv|mean platelet/i },
  ],
  liver: [
    { rank: 10, re: /^albumin\b(?!.*urine)/i },
    { rank: 20, re: /total protein/i },
    { rank: 30, re: /bilirubin.*total|total bilirubin/i },
    { rank: 40, re: /bilirubin.*direct|direct bilirubin/i },
    { rank: 50, re: /alkaline phosphatase|\balp\b/i },
    { rank: 60, re: /\bast\b|aspartate aminotransferase/i },
    { rank: 70, re: /\balt\b|alanine aminotransferase/i },
    { rank: 80, re: /\bggt\b|gamma[-\s]?glutamyl/i },
  ],
  electrolytes: [
    { rank: 10, re: /sodium|\bna\b/i },
    { rank: 20, re: /potassium|\bk\b/i },
    { rank: 30, re: /chloride|\bcl\b/i },
    { rank: 40, re: /carbon dioxide|bicarbonate|\bco2\b|\btco2\b/i },
    { rank: 50, re: /anion gap/i },
  ],
  kidney: [
    { rank: 10, re: /\bbun\b|blood urea nitrogen|urea nitrogen/i },
    { rank: 20, re: /creatinine(?!.*urine)/i },
    { rank: 30, re: /\begfr\b|glomerular filtration/i },
    { rank: 40, re: /cystatin c/i },
    { rank: 50, re: /uric acid|urate/i },
    { rank: 70, re: /microalbumin|albumin.*urine|urine.*albumin/i },
    { rank: 80, re: /albumin.?creatinine|acr\b/i },
  ],
  thyroid: [
    { rank: 10, re: /\btsh\b|thyroid stimulating/i },
    { rank: 20, re: /free t4|\bft4\b|thyroxine.*free/i },
    { rank: 30, re: /total t4|thyroxine/i },
    { rank: 40, re: /free t3|\bft3\b|triiodothyronine.*free/i },
    { rank: 50, re: /total t3|triiodothyronine/i },
    { rank: 60, re: /tpo|thyroid peroxidase/i },
    { rank: 70, re: /thyroglobulin.*antibody|tgab/i },
  ],
  hormones: [
    { rank: 10, re: /total testosterone|testosterone,\s*total/i },
    { rank: 20, re: /free testosterone|testosterone,\s*free/i },
    { rank: 30, re: /\bshbg\b|sex hormone binding/i },
    { rank: 40, re: /estradiol|estrogen/i },
    { rank: 50, re: /luteinizing hormone|\blh\b/i },
    { rank: 60, re: /follicle stimulating hormone|\bfsh\b/i },
    { rank: 70, re: /prolactin/i },
    { rank: 80, re: /cortisol/i },
    { rank: 90, re: /\bdhea\b/i },
    { rank: 100, re: /\bigf\b|insulin-like growth/i },
  ],
  infectious: [
    { rank: 10, re: /hepatitis b|hbv/i },
    { rank: 20, re: /hepatitis c|hcv/i },
    { rank: 30, re: /\bhiv\b/i },
  ],
  vitamins: [
    { rank: 10, re: /25[-\s]?oh vitamin d|vitamin d|25[-\s]?hydroxy/i },
    { rank: 20, re: /vitamin b12|cobalamin|\bb12\b/i },
    { rank: 30, re: /folate|folic acid/i },
    { rank: 40, re: /sodium/i },
    { rank: 50, re: /potassium/i },
    { rank: 60, re: /calcium/i },
    { rank: 70, re: /magnesium/i },
    { rank: 80, re: /zinc/i },
    { rank: 90, re: /omega/i },
  ],
  vitals: [
    { rank: 10, re: /systolic/i },
    { rank: 20, re: /diastolic/i },
    { rank: 30, re: /resting heart rate|resting hr|\brhr\b/i },
    { rank: 40, re: /\bhrv\b|heart rate variability/i },
    { rank: 50, re: /pain score/i },
  ],
  fitness: [
    { rank: 10, re: /vo2\s?max/i },
    { rank: 20, re: /\bhrv\b|heart rate variability/i },
    { rank: 30, re: /resting metabolic|predicted rmr|\brmr\b/i },
    { rank: 40, re: /respiratory exchange|\brer\b/i },
    { rank: 50, re: /carbohydrate oxidation|carbohydrate utilization/i },
    { rank: 60, re: /fat oxidation|fat utilization/i },
    { rank: 70, re: /biological age|metabolic age|fitness age/i },
  ],
  body: [
    { rank: 5, re: /body weight|\bweight\b|total mass/i },
    { rank: 10, re: /\bbmi\b|body mass index/i },
    { rank: 20, re: /body fat|fat percentage|fat %/i },
    { rank: 30, re: /fat mass/i },
    { rank: 40, re: /lean mass|lean tissue/i },
    { rank: 50, re: /visceral/i },
    { rank: 60, re: /android.*gynoid|gynoid.*android/i },
    { rank: 70, re: /bone mineral density|\bbmd\b/i },
    { rank: 80, re: /t[-\s]?score/i },
    { rank: 90, re: /z[-\s]?score/i },
    { rank: 100, re: /\brmr\b|resting metabolic/i },
  ],
};

function markerRank(groupKey: string, name: string): number {
  const rules = MARKER_ORDER[groupKey] || [];
  for (const entry of rules) {
    if (entry.re.test(name)) return entry.rank;
  }
  return 900;
}

function lipidSubgroup(name: string): string | null {
  const r = markerRank("lipids", name);
  if (r < 70) return "Standard lipid panel";
  if (r < 100) return "Atherogenic particle risk";
  if (r < 900) return "Advanced lipoprotein detail";
  return null;
}

function markerSubgroup(groupKey: string, name: string): string | null {
  if (groupKey === "lipids") return lipidSubgroup(name);
  return null;
}

// A marker's clinical place inside its panel (lower first; 900 = after every named
// analyte). Shared with the Records search so "by panel" reads in the packet's order.
export function reportMarkerRank(groupKey: string, name: string): number {
  return markerRank(groupKey, name);
}

function sortReportMarkers(groupKey: string, markers: ReportMarker[]): ReportMarker[] {
  return markers
    .map((marker, index) => ({ marker, index }))
    .sort((a, b) => {
      const ar = reportMarkerRank(groupKey, a.marker.name);
      const br = reportMarkerRank(groupKey, b.marker.name);
      if (ar !== br) return ar - br;
      return a.index - b.index;
    })
    .map((x) => x.marker);
}

function isBloodPressureName(name: string): boolean {
  return /\bsystolic\b|\bdiastolic\b|\bblood pressure\b|\bbp\b/i.test(name);
}

function isRestingHeartRateName(name: string): boolean {
  return /\bresting heart rate\b|\bresting hr\b|\brhr\b/i.test(name);
}

function isPointInTimeVitalName(name: string): boolean {
  if (isBloodPressureName(name) || isRestingHeartRateName(name)) return false;
  return /\boxygen saturation\b|\bspo2\b|\bo2 sat\b|\bpulse\b|\brespiratory rate\b|\brespiration\b|\btemperature\b|\bbody temp\b|\bpain score\b|\baverage heart rate\b|^heart rate$/i.test(name);
}

function reportMarkerRelevant(groupKey: string, marker: ReportMarker): boolean {
  // Normal spot vitals add noise to a PCP handoff: a months-old pulse ox, pulse,
  // temperature, respiratory rate, or ECG average HR is app context, not a current
  // clinical finding. Keep BP, resting HR, and any spot vital out of the lab's range.
  if (groupKey !== "vitals" || !isPointInTimeVitalName(marker.name)) return true;
  return marker.abnormal;
}

function duplicateProfileFieldMarker(marker: ReportMarker, profile: any): boolean {
  if (isProfileHeightName(marker.name) && Number.isFinite(Number(profile?.height_cm))) return true;
  return false;
}

export interface ClinicalReportOptions {
  // Toggled-on section ids (parseReportSections); omitted = REPORT_DEFAULT_SECTION_IDS.
  sections?: ReportSectionId[];
  // The athlete's final visit-question list (parseVisitQuestionList); omitted = the
  // proposals from visitQuestionsRead stand.
  questions?: string[];
}

export function buildClinicalReportData(opts: ClinicalReportOptions = {}): ClinicalReportData {
  const sections = opts.sections ? REPORT_SECTION_IDS.filter((id) => opts.sections!.includes(id)) : [...REPORT_DEFAULT_SECTION_IDS];
  const profile = (repo.getProfile() as any) || {};
  const { markers, groups } = repo.prioritizeMarkers() as any;
  const generatedDay = reportTodayISO();
  const generated = generatedDay;
  let weightAsOf = generatedDay;
  let loggedWeightDate: string | null = null;
  let currentWeightLb: number | null = Number.isFinite(Number(profile.weight_lb)) ? Number(profile.weight_lb) : null;
  try {
    const weights = repo.listWeight(1) as any[];
    const latest = Array.isArray(weights) && weights.length ? weights[weights.length - 1] : null;
    if (latest?.date) {
      loggedWeightDate = dayISO(latest.date, { notAfter: generatedDay });
      weightAsOf = loggedWeightDate || generatedDay;
    }
    const w = Number(latest?.weight_lb);
    if (Number.isFinite(w)) currentWeightLb = w;
  } catch {
    weightAsOf = generatedDay;
  }
  let bodyCompRead: any = null;
  try {
    bodyCompRead = repo.bodyCompositionRead(Array.isArray(markers) ? markers : [], currentWeightLb ?? profile.weight_lb ?? null, weightAsOf);
  } catch {
    bodyCompRead = null;
  }
  let bodyMetricRead: BodyMetricEstimate | null = null;
  try {
    bodyMetricRead = bodyMetricEstimate(repo.bodyMetricsContextSlice(), currentWeightLb, weightAsOf, generatedDay);
  } catch {
    bodyMetricRead = null;
  }

  // Shown in the athlete's lab-unit system (src/repo/lab-display.ts); every judgement on
  // the row (lab range, optimal band) was already made in canonical units.
  const labSystem = labUnitSystem();
  const markerViews = (Array.isArray(markers) ? markers : [])
    .map((raw) => presentMarkerRow(raw, labSystem))
    .map((m) => {
      const groupKey = m?.group || "other";
      const groupName = m?.group_label || "Other Markers";
      const view = applyVariableMetricFindingPolicy(
        applyBodyCompositionFindingPolicy(
          applyCurrentBodyContext(
            applyBodyMetricEstimate(toMarkerView(m, generatedDay), bodyMetricRead, bodyCompRead, generatedDay),
            {
              currentWeightLb,
              weightDate: loggedWeightDate,
              heightCm: Number.isFinite(Number(profile.height_cm)) ? Number(profile.height_cm) : null,
              generatedDay,
            },
          ),
        ),
      );
      return { groupKey, groupName, view };
    })
    .filter(({ groupKey, view }) => reportMarkerRelevant(groupKey, view) && !duplicateProfileFieldMarker(view, profile));
  const views: ReportMarker[] = markerViews.map(({ view }) => view);

  // Group in canonical order (groups[] from prioritizeMarkers is already ordered).
  const order: Array<{ key: string; label: string }> = Array.isArray(groups) ? groups : [];
  const byGroup = new Map<string, ReportMarker[]>();
  const groupLabel = new Map<string, string>();
  for (const { groupKey: k, groupName, view } of markerViews) {
    groupLabel.set(k, groupName);
    if (!byGroup.has(k)) byGroup.set(k, []);
    byGroup.get(k)!.push(view);
  }
  const grouped: ReportGroup[] = [];
  const seen = new Set<string>();
  for (const g of order) {
    const list = byGroup.get(g.key);
    if (list && list.length) {
      grouped.push({ key: g.key, label: g.label || groupLabel.get(g.key) || g.key, markers: sortReportMarkers(g.key, list) });
      seen.add(g.key);
    }
  }
  // Any group present in the data but not in the canonical order (defensive).
  for (const [k, list] of byGroup) {
    if (!seen.has(k) && list.length) grouped.push({ key: k, label: groupLabel.get(k) || k, markers: sortReportMarkers(k, list) });
  }
  // Findings to discuss follow the same clinical panel/order as the report body.
  const findings = grouped.flatMap((g) => g.markers.filter((v) => v.abnormal && !v.staleForFinding && !v.findingSuppressed));

  // Whole date span covered by every reading.
  let from: string | null = null;
  let to: string | null = null;
  for (const v of views) {
    for (const h of v.history) {
      if (!h.date) continue;
      if (!from || h.date < from) from = h.date;
      if (!to || h.date > to) to = h.date;
    }
  }

  // Body-composition caption — prefer actual at-home measurements when present.
  // A DEXA+weight projection is useful context, but it is NOT a fresh body-fat
  // measurement and should never relabel DEXA rows as today's readings.
  let bodyComp: ClinicalReportData["bodyComp"] = null;
  try {
    const docs = (repo.listHealthDocuments() as any[]) || [];
    const dexa = docs
      .filter((d) => (d.kind === "dexa" || /dexa|dxa/i.test(String(d.original_name || ""))) && d.summary)
      .sort((a, b) => String(b.doc_date || "").localeCompare(String(a.doc_date || "")))[0];
    if (bodyMetricRead) {
      const bits: string[] = [];
      bits.push(`Tape estimate ${fmtVal(bodyMetricRead.bodyFatPct)}% body fat on ${fmtDate(bodyMetricRead.measurementDate)}`);
      if (bodyMetricRead.fatMassLb != null) {
        bits.push(`${fmtVal(bodyMetricRead.fatMassLb)} lb fat mass using ${fmtVal(bodyMetricRead.currentWeightLb)} lb weight${bodyMetricRead.weightDate ? ` on ${fmtDate(bodyMetricRead.weightDate)}` : ""}`);
      }
      const parts = measurementParts(bodyMetricRead);
      if (parts) bits.push(`measurements: ${parts}`);
      if (bodyCompRead?.measured?.value != null) {
        const measuredDate = dayISO(bodyCompRead.measured.date, { notAfter: generatedDay });
        bits.push(`DEXA anchor ${fmtVal(bodyCompRead.measured.value)}%${measuredDate ? ` on ${fmtDate(measuredDate)}` : ""}`);
      }
      bodyComp = { label: "At-home body estimate", summary: bits.join("; "), asOf: bodyMetricRead.weightDate || bodyMetricRead.measurementDate };
    } else if (bodyCompRead?.estimated) {
      const bits: string[] = [];
      bits.push(`Current-weight-only projection ${fmtVal(bodyCompRead.estimated.value)}% body fat`);
      if (bodyCompRead?.fat_mass?.est_now != null) bits.push(`${fmtVal(bodyCompRead.fat_mass.est_now)} lb fat mass`);
      if (bodyCompRead?.measured?.value != null) {
        const measuredDate = dayISO(bodyCompRead.measured.date, { notAfter: generatedDay });
        bits.push(`from DEXA ${fmtVal(bodyCompRead.measured.value)}%${measuredDate ? ` on ${fmtDate(measuredDate)}` : ""}`);
      }
      if (bodyCompRead?.weight?.current != null) bits.push(`using current weight ${fmtVal(bodyCompRead.weight.current)} lb`);
      bits.push("not a fresh body-fat measurement");
      bodyComp = { label: "DEXA projection context", summary: bits.join("; "), asOf: dayISO(bodyCompRead.estimated.as_of, { notAfter: generatedDay }) };
    } else if (dexa) bodyComp = { label: "DEXA", summary: String(dexa.summary), asOf: dayISO(dexa.doc_date, { notAfter: generatedDay }) };
  } catch {
    bodyComp = null;
  }

  // Active supplements — what the athlete takes (a clinician wants the list).
  let supplements: ClinicalReportData["supplements"] = [];
  try {
    supplements = ((repo.listSupplements({ activeOnly: true }) as any[]) || []).map((s) => ({
      name: String(s.name ?? ""),
      dose: s.dose ?? null,
      frequency: s.frequency ?? null,
    }));
  } catch {
    supplements = [];
  }

  // Source provenance — the documents these readings came from, by date.
  let sources: ClinicalReportData["sources"] = [];
  try {
    sources = ((repo.listHealthDocuments() as any[]) || [])
      .map((d) => ({ date: dayISO(d.doc_date, { notAfter: generatedDay }), kind: String(d.kind || "other"), name: String(d.original_name || "document") }))
      .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  } catch {
    sources = [];
  }

  // Visit questions are read only when the section is on — the read touches the doctor
  // loop and the decision ledger, and a packet without the section needs neither.
  let visitQuestions: VisitQuestion[] = [];
  if (sections.includes("visit_questions")) {
    try {
      visitQuestions = resolveVisitQuestions(opts.questions, { asOf: generatedDay });
    } catch {
      visitQuestions = [];
    }
  }

  return {
    subject: {
      name: (profile.name && String(profile.name).trim()) || null,
      sex: profile.sex ?? null,
      age: profile.age ?? null,
      heightText: heightText(profile.height_cm),
      weightLb: currentWeightLb ?? profile.weight_lb ?? null,
    },
    generated,
    dateRange: from && to ? { from, to } : null,
    findings,
    groups: grouped,
    bodyComp,
    supplements,
    sources,
    sections,
    visitQuestions,
    disclaimer: `${REPORT_DISCLAIMER} Lab values are in ${labUnitSystemWords(labSystem)}; a value its lab printed in another unit is noted as reported.`,
  };
}

// A packet marker for data consumers: `abnormal` stays for back-compat, and the two
// facts it merges — out of the lab's range and sitting outside the optimal target — are
// named on their own so nothing downstream can blur them.
function markerJson(m: ReportMarker): ClientReportMarkerJson {
  return { ...m, lab_flagged: m.labRange === "out", outside_optimal: m.inOptimal === false };
}

// The packet as JSON — the same data the HTML and text formats render, with every
// toggled-off section's key ABSENT (not empty). The header, the section catalog and the
// informational line are always present.
export function clinicalReportJson(data: ClinicalReportData): ClientHealthReportJson {
  const out: ClientHealthReportJson = {
    subject: data.subject,
    generated: data.generated,
    dateRange: data.dateRange,
    sections: [...data.sections],
    section_catalog: REPORT_SECTIONS.map((s) => ({ id: s.id, label: s.label, included: data.sections.includes(s.id) })),
    disclaimer: data.disclaimer,
  };
  if (hasSection(data, "findings")) out.findings = data.findings.map(markerJson);
  if (hasSection(data, "visit_questions")) out.visit_questions = data.visitQuestions;
  if (hasSection(data, "body_composition")) out.bodyComp = data.bodyComp;
  if (hasSection(data, "panels"))
    out.groups = data.groups.map((g) => ({ key: g.key, label: g.label, markers: g.markers.map(markerJson) }));
  if (hasSection(data, "supplements")) out.supplements = data.supplements;
  if (hasSection(data, "sources")) out.sources = data.sources;
  return out;
}

// ---- flag / result rendering ----

// The lab-range mark, worded for what the lab actually said: "Lab: High" is the lab's
// own flag; "Above the lab's range" is a value outside the range the lab printed that
// the lab did not flag. Null when the reading is not out of the lab's range — a home
// reading (Cairn's threshold) or an estimate never carries one.
function labRangeMark(m: ReportMarker): string | null {
  if (m.labRange !== "out") return null;
  if (m.labRangeBasis === "printed_range") {
    return m.labRangeSide === "low" ? "Below the lab's range" : "Above the lab's range";
  }
  if (m.flag === "high") return "Lab: High";
  if (m.flag === "low") return "Lab: Low";
  return "Lab: Flagged";
}

function flagChip(m: ReportMarker): string {
  const mark = labRangeMark(m);
  if (!mark) return "";
  const cls = m.labRangeBasis === "printed_range" ? "flag-r" : m.labRangeSide === "low" ? "flag-l" : "flag-h";
  return `<span class="flag ${cls}">${esc(mark)}</span>`;
}

// Plain wording for a lab-normal value sitting outside its optimal band — relative
// to the optimal target, not an alarm ("above optimal" / "below optimal").
function optimalSide(m: ReportMarker): string {
  if (!m.optimal) return "outside optimal";
  const num = typeof m.value === "number" ? m.value : Number(m.value);
  if (!Number.isFinite(num)) return "outside optimal";
  return num > m.optimal.high ? "above optimal" : num < m.optimal.low ? "below optimal" : "outside optimal";
}

// A subtle "vs target" note when a value is lab-normal but outside the optimal band.
function optimalNote(m: ReportMarker): string {
  if (m.labRange === "out" || m.inOptimal !== false || !m.optimal) return "";
  const num = typeof m.value === "number" ? m.value : Number(m.value);
  if (!Number.isFinite(num)) return "";
  return `<span class="offt">${optimalSide(m)}</span>`;
}

function resultDateLabel(m: ReportMarker): string {
  if (m.dateLabel) return m.dateLabel;
  return m.estimated ? "est. as of" : "as of";
}

function resultDateText(m: ReportMarker): string {
  return m.latestDate ? `${resultDateLabel(m)} ${fmtShort(m.latestDate)}` : "";
}

function resultCell(m: ReportMarker): string {
  // Out-of-range values are HIGHLIGHTED (calm amber), not painted red.
  const cls = m.abnormal ? "res hl" : "res";
  const date = m.latestDate ? `<div class="res-date">${esc(resultDateLabel(m))} ${esc(fmtShort(m.latestDate))}</div>` : "";
  return `<div class="resline"><span class="${cls}">${esc(fmtVal(m.value))}${m.unit ? ` <span class="u">${esc(m.unit)}</span>` : ""}</span> ${flagChip(m)}${optimalNote(m)}</div>${date}`;
}

function historyCell(m: ReportMarker): string {
  // A single reading is not a history — show only WHEN it was drawn, never a lone
  // "previous value" or a trend (there is nothing to trend off one point).
  if (m.history.length <= 1) {
    const only = m.history[0]?.date || m.latestDate;
    return only ? `<span class="hist-one">single reading</span> <span class="dt">${esc(fmtShort(only))}</span>` : "—";
  }
  const seq = m.history
    .slice(-6)
    .map((h) => {
      const fc = h.flag === "high" || h.flag === "low" ? " hi" : "";
      return `<span class="hv${fc}">${esc(fmtVal(h.value))}</span> <span class="dt">${esc(fmtShort(h.date))}</span>`;
    })
    .join(`<span class="sep">·</span>`);
  const dir = m.trendDir;
  const arrow = dir === "rising" ? "↗" : dir === "falling" ? "↘" : dir === "stable" ? "→" : "";
  const trend = arrow ? `<span class="trend ${esc(dir || "")}">${arrow} ${esc(dir || "")}</span> ` : "";
  return `${trend}${seq}`;
}

function lipidGroupNote(markers: ReportMarker[]): string {
  const standard = markers.find((m) => isStandardLdlName(m.name));
  const direct = markers.find((m) => isDirectLdlName(m.name));
  if (!standard || !direct) return "";
  const sDate = standard.latestDate ? ` (${fmtShort(standard.latestDate)})` : "";
  const dDate = direct.latestDate ? ` (${fmtShort(direct.latestDate)})` : "";
  return `<p class="group-note">LDL-C rows are separated by assay/source method: ${esc(standard.name)}${esc(sDate)} and ${esc(direct.name)}${esc(dDate)} are not merged, so each history only covers comparable draws.</p>`;
}

function groupTable(g: ReportGroup): string {
  const rows: string[] = [];
  let lastSubgroup = "";
  for (const m of g.markers) {
    const subgroup = markerSubgroup(g.key, m.name);
    if (subgroup && subgroup !== lastSubgroup) {
      rows.push(`<tr class="subrow"><th colspan="4">${esc(subgroup)}</th></tr>`);
      lastSubgroup = subgroup;
    }
    const notes = [m.methodNote, sourceNote(m), referenceSourceNote(m), m.freshnessNote].filter(Boolean);
    rows.push(`<tr class="${m.abnormal ? "row-abn" : ""}">
      <td class="m-name">${esc(m.name)}${notes.map((n) => `<div class="m-note">${esc(n)}</div>`).join("")}</td>
      <td class="m-res">${resultCell(m)}</td>
      <td class="m-tgt ${esc(m.targetKind)}">${esc(m.targetText)}</td>
      <td class="m-hist">${historyCell(m)}</td>
    </tr>`);
  }
  return `<section class="group">
    <h2>${esc(g.label)}</h2>
    ${g.key === "lipids" ? lipidGroupNote(g.markers) : ""}
    <table class="markers">
      <thead><tr><th>Marker</th><th>Result</th><th>Target / reference<span class="th-note">†</span></th><th>History</th></tr></thead>
      <tbody>${rows.join("\n")}</tbody>
    </table>
  </section>`;
}

function abnormalGroups(groups: ReportGroup[], opts: { includeStale?: boolean } = {}): ReportGroup[] {
  return groups
    .map((g) => ({ ...g, markers: g.markers.filter((m) => m.abnormal && !m.findingSuppressed && (opts.includeStale || !m.staleForFinding)) }))
    .filter((g) => g.markers.length);
}

// Where the older out-of-range readings live, worded for whether the dated panels are
// in this packet at all — a note never points the reader at a section that is not there.
function staleFindingsNote(count: number, panelsIncluded: boolean): string {
  const readings = `${count} older out-of-range reading${count === 1 ? "" : "s"}`;
  return panelsIncluded
    ? `${readings} ${count === 1 ? "is" : "are"} kept in the dated panels below, not highlighted as current.`
    : `${readings} ${count === 1 ? "is" : "are"} not highlighted as current and not included in this packet.`;
}

function findingsBox(groups: ReportGroup[], opts: { panelsIncluded: boolean }): string {
  const grouped = abnormalGroups(groups);
  const staleTotal = abnormalGroups(groups, { includeStale: true })
    .reduce((sum, g) => sum + g.markers.filter((m) => m.staleForFinding).length, 0);
  if (!grouped.length) {
    const msg = staleTotal
      ? `No current highlighted findings. ${staleFindingsNote(staleTotal, opts.panelsIncluded)}`
      : "No markers fall outside their lab reference range or optimal target.";
    return `<section class="findings none"><h2>Findings</h2><p>${esc(msg)}</p></section>`;
  }
  // The cap keeps a long findings list a summary when the full panels follow; without the
  // panels the findings ARE the record, so every one is printed.
  const CAP = opts.panelsIncluded ? 24 : Number.POSITIVE_INFINITY;
  let shown = 0;
  const blocks = grouped
    .map((g) => {
      const items = g.markers
        .map((m) => {
          if (shown >= CAP) return "";
          shown++;
      const status = labRangeMark(m) ?? (m.inOptimal === false ? optimalSide(m) : "");
      const date = m.latestDate ? ` <span class="f-date">${esc(resultDateText(m))}</span>` : "";
      const tgt = m.targetKind === "optimal" && m.optimalText
        ? ` <span class="f-tgt">optimal ${esc(m.optimalText)}</span>`
        : m.targetKind === "reference"
          ? ` <span class="f-tgt">${esc(m.targetText)}</span>`
          : "";
      const tr = m.trendText ? ` <span class="f-tr">${esc(m.trendText)}</span>` : "";
      const note = m.estimated && m.history[0]?.date ? ` <span class="f-note">DEXA ${esc(fmtShort(m.history[0].date))}</span>` : "";
      return `<li><span class="f-name">${esc(m.name)}</span> <span class="f-val">${esc(fmtVal(m.value))}${m.unit ? ` ${esc(m.unit)}` : ""}</span>${date} <span class="f-flag ${m.labRange === "out" ? m.labRangeSide || "high" : "off"}">${esc(status)}</span>${tgt}${tr}${note}</li>`;
    })
        .filter(Boolean)
    .join("\n");
      if (!items) return "";
      return `<div class="fg"><h3>${esc(g.label)} <span>${g.markers.length}</span></h3><ul class="f-list">${items}</ul></div>`;
    })
    .filter(Boolean)
    .join("\n");
  const total = grouped.reduce((sum, g) => sum + g.markers.length, 0);
  const omitted = staleTotal ? ` ${staleFindingsNote(staleTotal, opts.panelsIncluded)}` : "";
  const more = total > CAP || omitted ? `<p class="f-more">${total > CAP ? `+ ${total - CAP} more outside range — see panels below.` : ""}${omitted}</p>` : "";
  return `<section class="findings">
    <h2>Findings by panel</h2>
    <div class="f-groups">${blocks}</div>${more}
  </section>`;
}

// The source documents, newest first, capped so a split multi-year import stays a
// footnote rather than a page. One line each: date · kind · file name.
const SOURCE_LINE_CAP = 12;
function sourceLines(sources: ClinicalReportData["sources"]): string[] {
  const newest = [...sources].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  const lines = newest
    .slice(0, SOURCE_LINE_CAP)
    .map((src) => [src.date ? fmtDate(src.date) : "undated", src.kind.replace(/_/g, " "), src.name].join(" · "));
  if (newest.length > SOURCE_LINE_CAP) lines.push(`+ ${newest.length - SOURCE_LINE_CAP} more`);
  return lines;
}

// ---- plain-text twin (for pasting into a MyChart message body) ----

export function renderClinicalReportText(data: ClinicalReportData, opts: { name?: string } = {}): string {
  const L: string[] = [];
  // An explicit ?name= override wins; otherwise stamp the name set in the profile.
  const name = ((opts.name || "").trim()) || (data.subject.name || "");
  L.push(`HEALTH SUMMARY${name ? ` — ${name}` : ""}`);
  const sub: string[] = [];
  if (data.subject.sex) sub.push(data.subject.sex);
  if (data.subject.age != null) sub.push(`age ${data.subject.age}`);
  if (data.subject.heightText) sub.push(data.subject.heightText.replace(/\s*\(.*\)/, ""));
  if (data.subject.weightLb != null) sub.push(`${data.subject.weightLb} lb`);
  L.push(`Generated ${fmtDate(data.generated.slice(0, 10))}${sub.length ? ` · ${sub.join(", ")}` : ""}`);
  if (data.dateRange) L.push(`Readings ${fmtDate(data.dateRange.from)} – ${fmtDate(data.dateRange.to)}`);
  L.push("");

  if (hasSection(data, "findings")) {
    const groupedFindings = abnormalGroups(data.groups);
    const staleFindings = abnormalGroups(data.groups, { includeStale: true })
      .reduce((sum, g) => sum + g.markers.filter((m) => m.staleForFinding).length, 0);
    if (groupedFindings.length) {
      L.push("FINDINGS TO DISCUSS");
      for (const g of groupedFindings) {
        L.push(`  ${g.label}:`);
        for (const m of g.markers) {
          const status = labRangeMark(m) ?? optimalSide(m);
          const when = m.latestDate ? `, ${resultDateText(m)}` : "";
          const tgt = m.targetKind === "optimal" && m.optimalText
            ? ` · optimal ${m.optimalText}`
            : m.targetKind === "reference" ? ` · ${m.targetText}` : "";
          const tr = m.trendText ? ` · ${m.trendText}` : "";
          L.push(`    • ${m.name} — ${fmtVal(m.value)}${m.unit ? ` ${m.unit}` : ""}${when} (${status})${tgt}${tr}`);
        }
      }
      if (staleFindings) L.push(`  (${staleFindingsNote(staleFindings, hasSection(data, "panels"))})`);
      L.push("");
    } else if (staleFindings) {
      L.push(`FINDINGS TO DISCUSS`);
      L.push(`  No current highlighted findings. ${staleFindingsNote(staleFindings, hasSection(data, "panels"))}`);
      L.push("");
    }
  }

  if (hasSection(data, "visit_questions") && data.visitQuestions.length) {
    L.push("QUESTIONS FOR THE VISIT");
    for (const q of data.visitQuestions) L.push(`  • ${q.text}`);
    L.push("");
  }

  if (hasSection(data, "panels")) {
    for (const g of data.groups) {
      L.push(g.label.toUpperCase());
      if (g.key === "lipids") {
        const standard = g.markers.find((m) => isStandardLdlName(m.name));
        const direct = g.markers.find((m) => isDirectLdlName(m.name));
        if (standard && direct) {
          const sDate = standard.latestDate ? ` (${fmtShort(standard.latestDate)})` : "";
          const dDate = direct.latestDate ? ` (${fmtShort(direct.latestDate)})` : "";
          L.push(`  Note: LDL-C rows are separated by assay/source method: ${standard.name}${sDate} and ${direct.name}${dDate} are not merged.`);
        }
      }
      let lastSubgroup = "";
      for (const m of g.markers) {
        const subgroup = markerSubgroup(g.key, m.name);
        if (subgroup && subgroup !== lastSubgroup) {
          L.push(`  ${subgroup}:`);
          lastSubgroup = subgroup;
        }
        const mark = labRangeMark(m);
        const flag = mark ? ` [${mark}]` : m.inOptimal === false ? ` [${optimalSide(m)}]` : "";
        const hist = m.history.length > 1 ? `   {${m.history.slice(-6).map((h) => `${fmtVal(h.value)} ${fmtShort(h.date)}`).join(" · ")}}` : "";
        const tgt = m.targetKind === "optimal" && m.optimalText ? `  (optimal ${m.optimalText})` : `  (${m.targetText})`;
        const when = m.latestDate ? `, ${resultDateText(m)}` : "";
        const notes = [m.methodNote, sourceNote(m), referenceSourceNote(m), m.freshnessNote].filter(Boolean);
        L.push(`  ${m.name}: ${fmtVal(m.value)}${m.unit ? ` ${m.unit}` : ""}${when}${flag}${tgt}${notes.length ? ` — ${notes.join("; ")}` : ""}${hist}`);
      }
      L.push("");
    }
  }

  if (hasSection(data, "body_composition") && data.bodyComp) {
    L.push(`BODY COMPOSITION (${data.bodyComp.label}${data.bodyComp.asOf ? `, ${fmtDate(data.bodyComp.asOf)}` : ""})`);
    L.push(`  ${data.bodyComp.summary}`);
    L.push("");
  }

  if (hasSection(data, "supplements") && data.supplements.length) {
    L.push("SUPPLEMENTS / WHAT I TAKE");
    for (const s of data.supplements) {
      const detail = [s.dose, s.frequency].filter(Boolean).join(", ");
      L.push(`  • ${s.name}${detail ? ` — ${detail}` : ""}`);
    }
    L.push("");
  }

  if (hasSection(data, "sources") && data.sources.length) {
    L.push("SOURCE DOCUMENTS");
    for (const line of sourceLines(data.sources)) L.push(`  ${line}`);
    L.push("");
  }

  // The legend explains the target column, so it rides with the sections that print one;
  // the informational line prints whatever is toggled.
  const legend = hasSection(data, "findings") || hasSection(data, "panels");
  if (legend) {
    L.push("— Target/reference legend: optimal = evidence-anchored preventive/longevity band;");
    L.push("  ref = the source lab's printed reference interval, or a curated adult reference interval when the upload omitted one; context labels are not targets.");
    L.push("  Lab: High/Low = the lab's own flag; Above/Below the lab's range = outside the range the lab printed, not flagged by the lab.");
  }
  L.push(`${legend ? "  " : "— "}${data.disclaimer} Generated by Cairn.`);
  return L.join("\n");
}

// ---- the self-contained, print-optimized HTML document ----

const STYLE = `
:root{
  --ink:#2b2724; --soft:#6b635c; --faint:#9a9089; --line:#e7e0d6; --paper:#fbf8f3;
  --card:#fffdf9; --terra:#b4533a; --terra-bg:#f7e9e3; --sage:#5f7355; --sage-bg:#eaefe6;
  --amber:#9a6a1c; --amber-bg:#f6ecd9;
}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:var(--paper);color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
  font-size:13px;line-height:1.5}
.wrap{max-width:880px;margin:0 auto;padding:22px 26px 112px}
h1,h2,.brand{font-family:Georgia,'Times New Roman',serif;font-weight:600;letter-spacing:-.01em}
a{color:var(--terra)}

/* screen-only toolbar */
.toolbar{position:sticky;top:0;z-index:5;background:rgba(251,248,243,.94);backdrop-filter:blur(6px);
  border-bottom:1px solid var(--line);padding:11px 26px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.toolbar .hint{color:var(--soft);font-size:11.5px;flex:1 1 240px;min-width:200px}
.btn{font:inherit;font-size:12.5px;font-weight:600;border:1px solid var(--line);background:var(--card);
  color:var(--ink);border-radius:9px;padding:8px 14px;cursor:pointer}
.btn.primary{background:var(--terra);border-color:var(--terra);color:#fff}
.btn.on{background:var(--ink);border-color:var(--ink);color:var(--paper)}
.copied{color:var(--sage);font-size:12px;font-weight:600;display:none}
.actionbar{position:fixed;left:0;right:0;bottom:0;z-index:7;background:rgba(251,248,243,.96);
  border-top:1px solid var(--line);box-shadow:0 -10px 24px rgba(43,39,36,.08);
  backdrop-filter:blur(12px) saturate(1.06);-webkit-backdrop-filter:blur(12px) saturate(1.06);
  padding:10px 18px calc(10px + env(safe-area-inset-bottom,0px))}
.actionbar-in{max-width:880px;margin:0 auto;display:flex;gap:10px;align-items:center;justify-content:flex-end}
.actionbar .btn{min-height:39px}
.actionbar .btn.primary{min-width:190px}
.actionbar .copied{margin-right:auto}

/* header */
.head{display:flex;justify-content:space-between;align-items:flex-end;gap:18px;
  border-bottom:2px solid var(--ink);padding-bottom:12px;margin:8px 0 18px}
h1{font-size:25px;margin:0 0 3px}
.brand{font-size:12px;color:var(--terra);text-transform:uppercase;letter-spacing:.13em;font-weight:600}
.pname{font-size:15px;font-weight:600;outline:none;border-bottom:1px dashed transparent;padding:0 1px}
.pname:empty:before{content:'Add your name';color:var(--faint);font-weight:400}
.pname[contenteditable]:hover,.pname[contenteditable]:focus{border-bottom-color:var(--line)}
.meta{text-align:right;color:var(--soft);font-size:11.5px;line-height:1.7}
.meta .sub{color:var(--ink);font-weight:600;font-size:13px}

/* findings */
.findings{background:var(--amber-bg);border:1px solid #e7d4ac;border-radius:13px;padding:15px 18px;margin:0 0 22px;break-inside:avoid}
.findings.none{background:var(--sage-bg);border-color:#d7e2cf}
.findings h2{font-size:16px;margin:0 0 10px;color:var(--amber)}
.findings.none h2{color:var(--sage)}
.f-groups{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 22px}
.fg{break-inside:avoid}
.fg h3{margin:0 0 4px;font:700 10.5px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;text-transform:uppercase;
  letter-spacing:.05em;color:var(--amber)}
.fg h3 span{color:var(--soft);font-weight:600}
.f-list{list-style:none;margin:0;padding:0}
.f-list li{font-size:12px;line-height:1.45;padding:2px 0;border-bottom:1px solid rgba(180,83,58,.12)}
.f-name{font-weight:600}
.f-val{font-variant-numeric:tabular-nums}
.f-flag{font-weight:700;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--amber)}
.f-flag.low{color:var(--amber)}
.f-flag.off{color:var(--soft)}
.f-tgt,.f-tr,.f-date,.f-note{color:var(--soft);font-size:11px}
.f-date{font-weight:600}
.f-more{margin:9px 0 0;color:var(--soft);font-style:italic;border:0;font-size:12px}

/* group tables */
.group{margin:0 0 18px}
.group h2{font-size:14px;margin:0 0 6px;color:var(--ink);break-after:avoid;
  border-bottom:1px solid var(--line);padding-bottom:4px}
.group-note{margin:-1px 0 7px;color:var(--soft);font-size:11.5px;line-height:1.45}
table.markers{width:100%;border-collapse:collapse;font-size:12px}
table.markers thead th{text-align:left;font-weight:600;color:var(--soft);font-size:10.5px;
  text-transform:uppercase;letter-spacing:.04em;padding:4px 8px;border-bottom:1px solid var(--line)}
.th-note{color:var(--faint);font-weight:400}
table.markers td{padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}
table.markers .subrow th{padding:7px 8px 3px;border-bottom:1px solid var(--line);color:var(--soft);
  font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;text-align:left;background:rgba(95,115,85,.055)}
table.markers tr{break-inside:avoid}
.row-abn{background:rgba(154,106,28,.05)}
.m-name{font-weight:600;width:30%}
.m-note{margin-top:2px;color:var(--soft);font-weight:400;font-size:10.5px;line-height:1.35}
.m-res{width:23%;font-variant-numeric:tabular-nums}
.m-tgt{width:14%;color:var(--soft);font-variant-numeric:tabular-nums}
.m-tgt.reference,.m-tgt.source_flag,.m-tgt.expected,.m-tgt.context{font-size:11px}
.m-tgt.context{font-style:italic}
.m-hist{width:33%;color:var(--soft);font-size:11px}
.resline{white-space:nowrap}
.res{font-weight:600}
.res.hl{background:var(--amber-bg);border-radius:4px;padding:1px 5px}
.res-date,.hist-one{color:var(--faint);font-size:10.5px;margin-top:2px}
.res .u{color:var(--faint);font-weight:400;font-size:11px}
.flag{display:inline-block;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;
  padding:1px 5px;border-radius:5px;vertical-align:1px}
.flag-h{background:var(--amber-bg);color:var(--amber)}
.flag-l{background:var(--amber-bg);color:var(--amber)}
.flag-r{background:transparent;color:var(--amber);box-shadow:inset 0 0 0 1px var(--amber-bg)}
.offt{color:var(--amber);font-size:10.5px;font-style:italic;margin-left:3px}
.hv{font-variant-numeric:tabular-nums;color:var(--ink)}
.hv.hi{color:var(--amber);font-weight:600}
.dt{color:var(--faint)}
.sep{color:var(--faint);margin:0 4px}
/* trend direction is neutral — rising/falling is not good/bad without context */
.trend{font-weight:600;margin-right:5px;font-size:10.5px;color:var(--soft)}
.trend.rising,.trend.falling,.trend.stable{color:var(--soft)}

/* body comp caption + supplements + footnotes */
.cap{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--sage);
  border-radius:0 8px 8px 0;padding:9px 13px;margin:0 0 14px;font-size:12px;color:var(--soft)}
.supps{font-size:12px;color:var(--ink);margin:0 0 16px}
.supps li{margin:2px 0}
.foot{margin-top:26px;padding-top:12px;border-top:1px solid var(--line);color:var(--faint);font-size:10.5px;line-height:1.6}
.foot .srcs{margin-top:6px}
.visitq{margin:0 0 18px;break-inside:avoid}
.visitq h2{font-size:14px;margin:0 0 6px;border-bottom:1px solid var(--line);padding-bottom:4px}
.vq-list{margin:0;padding-left:18px;font-size:12.5px}
.vq-list li{margin:3px 0}
.foot b{color:var(--soft);font-weight:600}

@media print{
  .toolbar,.actionbar,.no-print{display:none!important}
  .wrap{max-width:none;padding:0}
  @page{size:letter;margin:13mm}
  body{font-size:11px;background:#fff}
  .findings{background:#f6ecd9!important}
  thead{display:table-header-group}
}
@media (max-width:640px){
  .toolbar{align-items:flex-start}
  .toolbar .hint{flex-basis:100%;min-width:0}
  .actionbar-in{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .actionbar .btn,.actionbar .btn.primary{width:100%;min-width:0}
  .actionbar .copied{grid-column:1/-1;order:-1;margin:0;text-align:center}
}
.body.findings-only .group,.body.findings-only .bodycomp,.body.findings-only .suppwrap{display:none}
`;

export const REPORT_SCRIPT = `
(function(){
  var copyBtn=document.getElementById('copyBtn'),printBtn=document.getElementById('printBtn'),
      copied=document.getElementById('copied'),toggleBtn=document.getElementById('toggleBtn'),
      body=document.getElementById('body'),plain=document.getElementById('plain');
  copyBtn&&copyBtn.addEventListener('click',function(){
    var text=plain.value;
    function ok(){copied.style.display='inline';setTimeout(function(){copied.style.display='none'},2200);}
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(ok,function(){plain.select();document.execCommand('copy');ok();});}
    else{plain.select();document.execCommand('copy');ok();}
  });
  printBtn&&printBtn.addEventListener('click',function(){window.print();});
  toggleBtn&&toggleBtn.addEventListener('click',function(){
    var on=body.classList.toggle('findings-only');
    toggleBtn.textContent=on?'Show all markers':'Findings only';
    toggleBtn.classList.toggle('on',on);
  });
})();
`.trim();

const REPORT_SCRIPT_HASH = crypto.createHash("sha256").update(REPORT_SCRIPT).digest("base64");

export function reportScriptCspHash(): string {
  return `'sha256-${REPORT_SCRIPT_HASH}'`;
}

export function renderClinicalReportHTML(data: ClinicalReportData, opts: { name?: string } = {}): string {
  // An explicit ?name= override wins; otherwise stamp the name set in the profile.
  // The header span stays contenteditable so it can still be filled/changed on paper.
  const name = esc(((opts.name || "").trim()) || (data.subject.name || ""));
  const sub: string[] = [];
  if (data.subject.sex) sub.push(esc(data.subject.sex));
  if (data.subject.age != null) sub.push(`${esc(data.subject.age)}`);
  if (data.subject.heightText) sub.push(esc(data.subject.heightText));
  if (data.subject.weightLb != null) sub.push(`${esc(data.subject.weightLb)} lb`);

  const bodyComp = hasSection(data, "body_composition") && data.bodyComp
    ? `<div class="cap bodycomp"><b>${esc(data.bodyComp.label)}${data.bodyComp.asOf ? ` · ${esc(fmtDate(data.bodyComp.asOf))}` : ""}:</b> ${esc(data.bodyComp.summary)}</div>`
    : "";

  const supps = hasSection(data, "supplements") && data.supplements.length
    ? `<section class="suppwrap"><h2 style="font-family:Georgia,serif;font-size:14px;border-bottom:1px solid var(--line);padding-bottom:4px;margin:0 0 6px">Supplements</h2>
       <ul class="supps">${data.supplements
         .map((s) => `<li>${esc(s.name)}${[s.dose, s.frequency].filter(Boolean).length ? ` — ${esc([s.dose, s.frequency].filter(Boolean).join(", "))}` : ""}</li>`)
         .join("")}</ul></section>`
    : "";

  const questions = hasSection(data, "visit_questions") && data.visitQuestions.length
    ? `<section class="visitq"><h2>Questions for the visit</h2>
       <ul class="vq-list">${data.visitQuestions.map((q) => `<li>${esc(q.text)}</li>`).join("")}</ul></section>`
    : "";

  const sources = hasSection(data, "sources") && data.sources.length
    ? `<div class="srcs"><b>Source documents</b>: ${sourceLines(data.sources).map(esc).join("; ")}</div>`
    : "";

  const findings = hasSection(data, "findings") ? findingsBox(data.groups, { panelsIncluded: hasSection(data, "panels") }) : "";
  const panels = hasSection(data, "panels") ? data.groups.map(groupTable).join("\n") : "";
  // "Findings only" hides the panels, so it is offered only when both are in the packet.
  const toggle = hasSection(data, "findings") && hasSection(data, "panels");
  const legend = hasSection(data, "findings") || hasSection(data, "panels")
    ? `<b>†&nbsp;Target/reference</b>: <b>optimal</b> bands are evidence-anchored preventive / longevity references; <b>ref</b> means the source lab's printed reference interval, or a curated adult reference interval when the upload omitted one; context labels (for example DEXA context, fixed trait, qualitative) are not targets. <b>Lab: High / Low</b> is the lab's own flag; <b>Above / Below the lab's range</b> means the value sits outside the range the lab printed, not flagged by the lab. `
    : "";

  const plain = renderClinicalReportText(data, opts);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Health Summary${name ? ` — ${name}` : ""}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="toolbar no-print">
  ${toggle ? `<button class="btn" id="toggleBtn">Findings only</button>
  <span class="hint">Use the bottom bar to copy the MyChart text or save the full report as PDF. Findings-only keeps the discussion list in view.</span>` : `<span class="hint">Use the bottom bar to copy the MyChart text or save the report as PDF.</span>`}
</div>
<div class="wrap body" id="body">
  <div class="head">
    <div>
      <div class="brand">Cairn · Health Summary</div>
      <h1><span class="pname" contenteditable="true" spellcheck="false">${name}</span></h1>
      <div style="color:var(--soft);font-size:12px">${sub.join(" · ")}</div>
    </div>
    <div class="meta">
      <div class="sub">Generated ${esc(fmtDate(data.generated.slice(0, 10)))}</div>
      ${data.dateRange ? `<div>Readings ${esc(fmtDate(data.dateRange.from))} – ${esc(fmtDate(data.dateRange.to))}</div>` : ""}
    </div>
  </div>

  ${findings}
  ${questions}
  ${bodyComp}
  ${panels}
  ${supps}

  <div class="foot">
    ${legend}This summary is informational and is not medical advice. No 0–100 scores are used.
    ${sources}
  </div>
</div>
<div class="actionbar no-print" role="region" aria-label="Report export actions">
  <div class="actionbar-in">
    <span class="copied" id="copied">Copied</span>
    <button class="btn primary" id="copyBtn">Copy text for MyChart</button>
    <button class="btn" id="printBtn">Save PDF</button>
  </div>
</div>
<textarea id="plain" style="position:absolute;left:-9999px;top:-9999px" readonly>${esc(plain)}</textarea>
<script>${REPORT_SCRIPT}</script>
</body>
</html>`;
}
