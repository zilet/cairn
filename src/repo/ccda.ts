import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanClinicalFacts, dropDuplicateMarkersByDate, getHealthDocumentRaw, replaceHealthPanelsByType, updateHealthDocFields, upsertBloodPressureReading, type HealthPanelInput } from "./health.js";
import { canonicalMarker, normalizeMarkerName } from "./marker-canon.js";
import { localDateISO } from "./shared.js";

export const CCDA_VITALS_TYPE = "ccda_vitals";

const MAX_CCDA_XML_FILES = 500;
const MAX_CCDA_XML_BYTES = 40 * 1024 * 1024;
const DATE_RE = String.raw`\d{1,2}\/\d{1,2}\/\d{4}`;
const DATETIME_RE = String.raw`(${DATE_RE})\s+(\d{1,2}:\d{2})\s*(AM|PM)(?:\s+[A-Z]{2,4})?`;

interface CcdaSection {
  title: string;
  text: string;
  file: string;
}

interface VitalRow {
  measured_at: string;
  systolic?: number;
  diastolic?: number;
  pulse?: number;
  temperature?: number;
  temperature_unit?: string;
  spo2?: number;
  respiratory_rate?: number;
  weight_lb?: number;
  height_in?: number;
  bmi?: number;
}

export interface CcdaHealthExtraction {
  files: number;
  clinical_facts: any[];
  vitals_panels: HealthPanelInput[];
  results_panels: HealthPanelInput[];
  blood_pressure_readings: Array<{
    measured_at: string;
    systolic: number;
    diastolic: number;
    pulse?: number | null;
    source: string;
    note: string;
  }>;
}

export interface CcdaBackfillResult {
  files: number;
  clinicalFacts: number;
  storedClinicalFacts: number;
  vitalsPanels: number;
  vitalMarkers: number;
  resultPanels: number;
  resultMarkers: number;
  bpReadings: number;
  extractedBpReadings: number;
  wrote: boolean;
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCharCode(parseInt(dec, 10)));
}

function xmlText(input: string): string {
  return decodeEntities(input)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<\/(?:tr|td|th|li|item|paragraph|content|section|title|text|br)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readCcdaXmlFiles(rootPath: string): Array<{ file: string; xml: string }> {
  const out: Array<{ file: string; xml: string }> = [];
  let totalBytes = 0;
  const visit = (fp: string) => {
    if (out.length >= MAX_CCDA_XML_FILES || totalBytes >= MAX_CCDA_XML_BYTES) return;
    let st: fs.Stats;
    try { st = fs.statSync(fp); } catch { return; }
    if (st.isDirectory()) {
      const base = path.basename(fp).toLowerCase();
      if (base === "__macosx" || base === ".git") return;
      for (const entry of fs.readdirSync(fp)) visit(path.join(fp, entry));
      return;
    }
    if (!st.isFile() || !/\.xml$/i.test(fp)) return;
    if (st.size > 5 * 1024 * 1024) return;
    totalBytes += st.size;
    if (totalBytes > MAX_CCDA_XML_BYTES) return;
    try {
      out.push({ file: fp, xml: fs.readFileSync(fp, "utf8") });
    } catch {
      /* skip unreadable files */
    }
  };
  visit(rootPath);
  return out;
}

function sectionsFromXml(xml: string, file: string): CcdaSection[] {
  const sections: CcdaSection[] = [];
  for (const m of xml.matchAll(/<section\b[\s\S]*?<\/section>/gi)) {
    const raw = m[0];
    const title = xmlText(raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").slice(0, 160);
    if (!title) continue;
    const text = xmlText(raw.match(/<text\b[^>]*>([\s\S]*?)<\/text>/i)?.[1] ?? raw);
    if (!text) continue;
    sections.push({ title, text, file });
  }
  return sections;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isoDateFromUS(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function isoDateTimeFromUS(dateRaw: string, timeRaw: string, ampmRaw: string): string | null {
  const date = isoDateFromUS(dateRaw);
  if (!date) return null;
  const tm = timeRaw.match(/^(\d{1,2}):(\d{2})$/);
  if (!tm) return null;
  let hour = Number(tm[1]);
  const minute = Number(tm[2]);
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
  const ampm = ampmRaw.toUpperCase();
  if (ampm === "PM" && hour !== 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;
  return `${date} ${pad2(hour)}:${pad2(minute)}:00`;
}

function numberInRange(value: string | number, min: number, max: number): number | null {
  const n = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 10) / 10 : null;
}

function vitalFor(rows: Map<string, VitalRow>, measuredAt: string): VitalRow {
  let row = rows.get(measuredAt);
  if (!row) {
    row = { measured_at: measuredAt };
    rows.set(measuredAt, row);
  }
  return row;
}

function extractVitals(sections: CcdaSection[]): VitalRow[] {
  const rows = new Map<string, VitalRow>();
  const vitalSections = sections.filter((s) => /vital|last filed vital|physical exam|functional status/i.test(`${s.title} ${s.text}`));
  for (const section of vitalSections) {
    const text = section.text;
    for (const m of text.matchAll(new RegExp(String.raw`\bBlood Pressure\s+(\d{2,3})\s*\/\s*(\d{2,3})\s+${DATETIME_RE}`, "gi"))) {
      const measuredAt = isoDateTimeFromUS(m[3], m[4], m[5]);
      const systolic = numberInRange(m[1], 60, 260);
      const diastolic = numberInRange(m[2], 35, 160);
      if (!measuredAt || systolic == null || diastolic == null || diastolic >= systolic) continue;
      const row = vitalFor(rows, measuredAt);
      row.systolic = systolic;
      row.diastolic = diastolic;
    }
    for (const m of text.matchAll(new RegExp(String.raw`\bPulse\s+(\d{2,3})\s+${DATETIME_RE}`, "gi"))) {
      const measuredAt = isoDateTimeFromUS(m[2], m[3], m[4]);
      const pulse = numberInRange(m[1], 25, 240);
      if (!measuredAt || pulse == null) continue;
      vitalFor(rows, measuredAt).pulse = pulse;
    }
    for (const m of text.matchAll(new RegExp(String.raw`\bTemperature\s+([0-9]+(?:\.[0-9]+)?)\s*(?:deg|°|º)?\s*([CF])(?:\s*\([^)]*\))?\s+${DATETIME_RE}`, "gi"))) {
      const measuredAt = isoDateTimeFromUS(m[3], m[4], m[5]);
      const temp = numberInRange(m[1], 20, 110);
      if (!measuredAt || temp == null) continue;
      const row = vitalFor(rows, measuredAt);
      row.temperature = temp;
      row.temperature_unit = m[2].toUpperCase() === "F" ? "deg F" : "deg C";
    }
    for (const m of text.matchAll(new RegExp(String.raw`\bOxygen Saturation\s+(\d{2,3})\s*%?\s+${DATETIME_RE}`, "gi"))) {
      const measuredAt = isoDateTimeFromUS(m[2], m[3], m[4]);
      const spo2 = numberInRange(m[1], 40, 100);
      if (!measuredAt || spo2 == null) continue;
      vitalFor(rows, measuredAt).spo2 = spo2;
    }
    for (const m of text.matchAll(new RegExp(String.raw`\bRespiratory Rate\s+(\d{1,3})\s+${DATETIME_RE}`, "gi"))) {
      const measuredAt = isoDateTimeFromUS(m[2], m[3], m[4]);
      const rr = numberInRange(m[1], 4, 80);
      if (!measuredAt || rr == null) continue;
      vitalFor(rows, measuredAt).respiratory_rate = rr;
    }
    for (const m of text.matchAll(new RegExp(String.raw`\bWeight\s+([0-9]+(?:\.[0-9]+)?)\s*(?:lb|lbs|pounds)\s+${DATETIME_RE}`, "gi"))) {
      const measuredAt = isoDateTimeFromUS(m[2], m[3], m[4]);
      const weight = numberInRange(m[1], 40, 800);
      if (!measuredAt || weight == null) continue;
      vitalFor(rows, measuredAt).weight_lb = weight;
    }
    for (const m of text.matchAll(new RegExp(String.raw`\bHeight\s+([0-9]+(?:\.[0-9]+)?)\s*(?:in|inches)\s+${DATETIME_RE}`, "gi"))) {
      const measuredAt = isoDateTimeFromUS(m[2], m[3], m[4]);
      const height = numberInRange(m[1], 30, 100);
      if (!measuredAt || height == null) continue;
      vitalFor(rows, measuredAt).height_in = height;
    }
    for (const m of text.matchAll(new RegExp(String.raw`\bBody Mass Index\s+([0-9]+(?:\.[0-9]+)?)\s+${DATETIME_RE}`, "gi"))) {
      const measuredAt = isoDateTimeFromUS(m[2], m[3], m[4]);
      const bmi = numberInRange(m[1], 10, 90);
      if (!measuredAt || bmi == null) continue;
      vitalFor(rows, measuredAt).bmi = bmi;
    }
  }
  return [...rows.values()].sort((a, b) => a.measured_at.localeCompare(b.measured_at));
}

function panelsFromVitals(vitals: VitalRow[]): HealthPanelInput[] {
  return vitals
    .map((v) => {
      const markers: any[] = [];
      if (v.systolic != null) markers.push({ name: "Systolic BP", value: v.systolic, unit: "mmHg", flag: v.systolic >= 130 ? "high" : v.systolic < 90 ? "low" : "normal" });
      if (v.diastolic != null) markers.push({ name: "Diastolic BP", value: v.diastolic, unit: "mmHg", flag: v.diastolic >= 80 ? "high" : v.diastolic < 60 ? "low" : "normal" });
      if (v.pulse != null) markers.push({ name: "Pulse", value: v.pulse, unit: "bpm", flag: v.pulse > 100 ? "high" : v.pulse < 50 ? "low" : null });
      if (v.temperature != null) markers.push({ name: "Temperature", value: v.temperature, unit: v.temperature_unit ?? null, flag: null });
      if (v.spo2 != null) markers.push({ name: "Oxygen Saturation", value: v.spo2, unit: "%", flag: v.spo2 < 95 ? "low" : "normal" });
      if (v.respiratory_rate != null) markers.push({ name: "Respiratory Rate", value: v.respiratory_rate, unit: "breaths/min", flag: null });
      if (v.weight_lb != null) markers.push({ name: "Weight", value: v.weight_lb, unit: "lb", flag: null });
      if (v.height_in != null) markers.push({ name: "Height", value: v.height_in, unit: "in", flag: null });
      if (v.bmi != null) markers.push({ name: "BMI", value: v.bmi, unit: null, flag: null });
      if (!markers.length) return null;
      const at = v.measured_at;
      return {
        doc_date: at.slice(0, 10),
        kind: "other",
        type: CCDA_VITALS_TYPE,
        summary: `MyChart vitals recorded ${at.slice(0, 16)}`,
        markers,
      } satisfies HealthPanelInput;
    })
    .filter(Boolean) as HealthPanelInput[];
}

function compactName(raw: string): string {
  return raw
    .replace(/\b(?:Ended Medications|Current Medications|Medications at Time of Discharge|Prescription Last Filled End|Last Filled End|Medication Sig|Prescription)\b/gi, " ")
    .replace(/\b(?:Problem|Noted Date|Diagnosed Date|Diagnosis|Start Date|Medication|Sig|Dispense Quantity|Refills|Status|Date|Vaccine|Dose|Route|Manufacturer|Lot Number)\b/gi, " ")
    .replace(/\b(?:documented|entered|updated|resolved|ordered|administered)\b.*$/i, " ")
    .replace(/\s*\((?:Started|Expired)[^)]+\)/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[,;:\s-]+|[,;:\s-]+$/g, "")
    .slice(0, 180);
}

function addFact(out: any[], seen: Set<string>, fact: any) {
  const cleaned = cleanClinicalFacts([fact], 1)[0];
  if (!cleaned) return;
  const key = [cleaned.kind, cleaned.date ?? "", cleaned.name.toLowerCase(), cleaned.status ?? "", cleaned.source ?? ""].join("|");
  if (seen.has(key)) return;
  seen.add(key);
  out.push(cleaned);
}

function namedDatedFacts(text: string, max = 12): Array<{ name: string; date: string | null }> {
  const out: Array<{ name: string; date: string | null }> = [];
  for (const m of text.matchAll(new RegExp(String.raw`(.{3,180}?)\s+(${DATE_RE})(?=\s|$)`, "g"))) {
    const name = compactName(m[1]);
    const date = isoDateFromUS(m[2]);
    if (!name || !date) continue;
    if (/^(from|to|on|as of|start|end)$/i.test(name)) continue;
    out.push({ name, date });
    if (out.length >= max) break;
  }
  return out;
}

function extractMedicationNames(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ");
  const out: string[] = [];
  for (const m of normalized.matchAll(/\b([A-Za-z][A-Za-z0-9 ()/.-]{2,140}?\b(?:tablet|capsule|solution|injection|spray|inhaler|drops?|mg|mcg|mL)\b[^.]{0,60}?)(?=\s+(?:Take|Inject|Apply|Use|Chew|Place|Dissolve|documented|ordered|given|$))/gi)) {
    const name = compactName(m[1]);
    if (/^(?:take|inject|apply|use|chew|place|dissolve)\b/i.test(name)) continue;
    if (name && !out.some((x) => x.toLowerCase() === name.toLowerCase())) out.push(name);
    if (out.length >= 20) break;
  }
  return out;
}

function finalizedClinicalFacts(raw: any[]): any[] {
  const cleaned = cleanClinicalFacts(raw, 200);
  const hasDated = new Set(
    cleaned
      .filter((f) => f.date)
      .map((f) => `${f.kind}|${String(f.name).toLowerCase()}|${String(f.status ?? "").toLowerCase()}`)
  );
  const medicationSeen = new Set<string>();
  return cleaned.filter((f) => {
    const name = String(f.name ?? "").trim();
    if (!name) return false;
    if (/^(?:type department|care team description|latest contact info)\b/i.test(name)) return false;
    if (/^\d{1,2}:\d{2}\s*(?:AM|PM)\b/i.test(name)) return false;
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(name)) return false;
    if (!f.date && hasDated.has(`${f.kind}|${name.toLowerCase()}|${String(f.status ?? "").toLowerCase()}`)) return false;
    if (f.kind === "medication") {
      if (/^(?:last filled|prescription|ended medications|current medications)\b/i.test(name)) return false;
      const key = name.toLowerCase().replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
      if (medicationSeen.has(key)) return false;
      medicationSeen.add(key);
    }
    return true;
  });
}

function extractClinicalFacts(sections: CcdaSection[]): any[] {
  const out: any[] = [];
  const seen = new Set<string>();
  for (const s of sections) {
    const title = s.title.replace(/\s+/g, " ").trim();
    const text = s.text.replace(/\s+/g, " ").trim();
    const source = title;
    if (/allerg/i.test(title)) {
      if (/no known active allergies|no known allergies|nkda/i.test(text)) {
        addFact(out, seen, { kind: "allergy", name: "No known active allergies", status: "none reported", source });
      } else {
        for (const f of namedDatedFacts(text, 10)) addFact(out, seen, { kind: "allergy", name: f.name, date: f.date, status: "active", source });
      }
    }
    if (/(active problems|problem list|problems)/i.test(title)) {
      for (const f of namedDatedFacts(text, 20)) {
        if (/diagnosed|noted/i.test(f.name)) continue;
        addFact(out, seen, { kind: "condition", name: f.name, date: f.date, status: "active", source });
      }
    }
    if (/visit diagnoses|diagnos/i.test(title)) {
      for (const f of namedDatedFacts(text, 20)) addFact(out, seen, { kind: "condition", name: f.name, date: f.date, status: "encounter diagnosis", source });
      if (!namedDatedFacts(text, 1).length) {
        const name = compactName(text.replace(/^Diagnosis\b/i, ""));
        if (name && name.length <= 180) addFact(out, seen, { kind: "condition", name, status: "encounter diagnosis", source });
      }
    }
    if (/medication|prescription/i.test(title)) {
      for (const name of extractMedicationNames(text)) addFact(out, seen, { kind: "medication", name, status: /expired|discontinued/i.test(text) ? "historical" : "listed", source });
    }
    if (/social history/i.test(title)) {
      const smoking = text.match(/\bSmoking Tobacco:\s*([^:]{2,80}?)(?=\s+(?:Smokeless Tobacco:|Alcohol Use|Drug Use|Sexual Activity|$))/i);
      if (smoking) addFact(out, seen, { kind: "social_history", name: `Smoking tobacco: ${compactName(smoking[1])}`, source });
      const smokeless = text.match(/\bSmokeless Tobacco:\s*([^:]{2,80}?)(?=\s+(?:Alcohol Use|Drug Use|Sexual Activity|$))/i);
      if (smokeless) addFact(out, seen, { kind: "social_history", name: `Smokeless tobacco: ${compactName(smokeless[1])}`, source });
      const sex = text.match(/\bLegal Sex\s+([A-Za-z]+)/i);
      if (sex) addFact(out, seen, { kind: "social_history", name: `Legal sex: ${sex[1]}`, source });
    }
    if (/care team|providers?/i.test(title)) {
      const pcp = text.match(/\bPrimary Care Provider\s+(.{3,120}?)(?=\s+(?:From|To|Relationship|Care Team|$))/i);
      if (pcp) addFact(out, seen, { kind: "care_team", name: compactName(pcp[1]), status: "primary care provider", source });
    }
    if (out.length >= 200) break;
  }
  return finalizedClinicalFacts(out);
}

export function extractCcdaHealthData(rootPath: string): CcdaHealthExtraction {
  const files = readCcdaXmlFiles(rootPath);
  const sections = files.flatMap((f) => sectionsFromXml(f.xml, f.file));
  const vitals = extractVitals(sections);
  return {
    files: files.length,
    clinical_facts: extractClinicalFacts(sections),
    vitals_panels: panelsFromVitals(vitals),
    results_panels: extractResultPanels(files),
    blood_pressure_readings: vitals
      .filter((v) => v.systolic != null && v.diastolic != null)
      .map((v) => ({
        measured_at: v.measured_at,
        systolic: v.systolic!,
        diastolic: v.diastolic!,
        pulse: v.pulse ?? null,
        source: "mychart",
        note: "Imported from MyChart vitals",
      })),
  };
}

const EMPTY_BACKFILL = (files: number): CcdaBackfillResult => ({
  files,
  clinicalFacts: 0,
  storedClinicalFacts: 0,
  vitalsPanels: 0,
  vitalMarkers: 0,
  resultPanels: 0,
  resultMarkers: 0,
  bpReadings: 0,
  extractedBpReadings: 0,
  wrote: false,
});

function parsedJson(row: any): any {
  try {
    const parsed = row?.parsed_json ? JSON.parse(row.parsed_json) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function applyCcdaHealthBackfill(sourceId: number, extraction: CcdaHealthExtraction): CcdaBackfillResult {
  const row = getHealthDocumentRaw(sourceId) as any;
  if (!row) {
    return EMPTY_BACKFILL(extraction.files);
  }

  const facts = cleanClinicalFacts(extraction.clinical_facts, 200);
  const parsed = parsedJson(row);
  const existingFacts = cleanClinicalFacts(parsed.clinical_facts, 200);
  let wroteFacts = false;
  if (facts.length && JSON.stringify(facts) !== JSON.stringify(existingFacts)) {
    const nextParsed = { ...parsed, clinical_facts: facts };
    if (!Array.isArray(nextParsed.markers)) nextParsed.markers = Array.isArray(parsed.markers) ? parsed.markers : [];
    updateHealthDocFields(sourceId, { parsed_json: nextParsed });
    wroteFacts = true;
  }

  const panels = extraction.vitals_panels.filter((p) => Array.isArray(p.markers) && p.markers.length);
  const created = panels.length ? replaceHealthPanelsByType(sourceId, CCDA_VITALS_TYPE, panels, row.original_name ?? null) : [];

  // Lab results, read straight out of the CCDA <organizer classCode="BATTERY">
  // entries — one derived panel per collection date, refreshed as its own typed
  // stream so a re-run is idempotent and the agent's dated timeline is untouched.
  const resultPanels = extraction.results_panels.filter((p) => Array.isArray(p.markers) && p.markers.length);
  const resultsCreated = resultPanels.length
    ? replaceHealthPanelsByType(sourceId, CCDA_RESULTS_TYPE, resultPanels, row.original_name ?? null)
    : [];
  // …then the same analyte transcribed by an agent for that date steps aside, so
  // one panel never reads twice.
  if (resultPanels.length) dropDuplicateMarkersByDate(sourceId, CCDA_RESULTS_TYPE, resultMarkerKeysByDate(resultPanels));

  let bpCreated = 0;
  for (const bp of extraction.blood_pressure_readings) {
    try {
      const result = upsertBloodPressureReading(bp);
      if (result.created) bpCreated++;
    } catch {
      /* one malformed source row should not block the rest of the CCDA import */
    }
  }
  const vitalMarkers = panels.reduce((n, p) => n + (Array.isArray(p.markers) ? p.markers.length : 0), 0);
  const resultMarkers = resultPanels.reduce((n, p) => n + (Array.isArray(p.markers) ? p.markers.length : 0), 0);
  return {
    files: extraction.files,
    clinicalFacts: facts.length,
    storedClinicalFacts: facts.length,
    vitalsPanels: created.length,
    vitalMarkers,
    resultPanels: resultsCreated.length,
    resultMarkers,
    bpReadings: bpCreated,
    extractedBpReadings: extraction.blood_pressure_readings.length,
    wrote: wroteFacts || panels.length > 0 || resultPanels.length > 0 || extraction.blood_pressure_readings.length > 0,
  };
}

function materializeHealthDocSource(filePath: string): { root: string; cleanup?: () => void } | null {
  if (!filePath || !path.isAbsolute(filePath)) return null;
  try {
    if (fs.statSync(filePath).isDirectory()) return { root: filePath };
  } catch {
    return null;
  }
  if (!/\.zip$/i.test(filePath)) return { root: filePath };
  const stableExtracted = `${filePath}-x`;
  try {
    if (fs.statSync(stableExtracted).isDirectory()) return { root: stableExtracted };
  } catch {
    /* not already extracted */
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-ccda-"));
  execFileSync("unzip", ["-o", "-qq", filePath, "-d", tmp], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  return { root: tmp, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

export function backfillCcdaHealthDocument(sourceId: number): CcdaBackfillResult {
  const row = getHealthDocumentRaw(sourceId) as any;
  const source = materializeHealthDocSource(String(row?.file_path ?? ""));
  if (!source) {
    return EMPTY_BACKFILL(0);
  }
  try {
    const extraction = extractCcdaHealthData(source.root);
    return applyCcdaHealthBackfill(sourceId, extraction);
  } finally {
    try { source.cleanup?.(); } catch { /* best-effort temp cleanup */ }
  }
}

// ---------- CCDA Results (lab panels) ----------
//
// The `Results` section of a CCDA document is fully structured: one
// <organizer classCode="BATTERY"> per ordered panel, one <observation> per
// analyte, each with a LOINC code, a typed <value>, an interpretation flag and
// a printed reference range. That is a deterministic read — it needs no agent,
// and it is the part of a MyChart export the athlete most cares about.
//
// What deliberately STAYS the agent's job: imaging/ECG narratives (an <ED>
// blob or an "XR Chest 2 views" battery), the PDF/HTML summaries, and visit
// prose. Those are readings, not results.

export const CCDA_RESULTS_TYPE = "ccda_results";

export interface CcdaResultMarker {
  name: string;
  value: number | string;
  unit: string | null;
  flag: "low" | "normal" | "high" | null;
  ref_low: number | null;
  ref_high: number | null;
  loinc: string | null;
  source_name: string;
}

// A battery (or a single observation) that carries a narrative rather than a
// result. Its content is prose an agent reads, never a marker series.
const NARRATIVE_BATTERY_RE = /\b(xr|x-ray|xray|ct|mri|ultrasound|us|ekg|ecg|echo|radiology|imaging)\b/i;

// LOINC → the canonical analyte label Cairn already keys series by
// (marker-canon.ts). MyChart prints verbatim upper-case order names ("LOW
// DENSITY LIPOPROTEIN DIRECT", "HIGH DENSITY LIPOPROTEIN") that the alias KB
// does NOT recognize, which would split one analyte's history into a parallel
// series per lab. The code is unambiguous where the printed name is not, so it
// resolves the name; the verbatim label stays on `source_name`.
const LOINC_CANONICAL_NAMES: Record<string, string> = {
  // Lipids
  "2093-3": "Total Cholesterol",
  "2571-8": "Triglycerides",
  "2085-9": "HDL Cholesterol",
  "18262-6": "LDL-C (Direct)",
  "13457-7": "LDL-C",
  // Metabolic / vitamins
  "4548-4": "Hemoglobin A1c",
  "1989-3": "25-OH Vitamin D",
  "2132-9": "Vitamin B12",
  "2284-8": "Folate",
  // BMP / CMP
  "2951-2": "Sodium",
  "2823-3": "Potassium",
  "2075-0": "Chloride",
  "2028-9": "CO2",
  "2345-7": "Glucose",
  "3094-0": "Blood Urea Nitrogen (BUN)",
  "2160-0": "Creatinine",
  "17861-6": "Calcium",
  "1742-6": "ALT",
  "1920-8": "AST",
  "6768-6": "Alkaline Phosphatase",
  "1975-2": "Total Bilirubin",
  "2885-2": "Total Protein",
  "1751-7": "Albumin",
  // CBC
  "718-7": "Hemoglobin",
  "4544-3": "Hematocrit",
  "6690-2": "WBC",
  "789-8": "Red Blood Cell Count",
  "777-3": "Platelets",
  "787-2": "Mean Corpuscular Volume",
  "785-6": "Mean Corpuscular Hemoglobin",
  "786-4": "Mean Corpuscular Hemoglobin Concentration",
  "788-0": "Red Cell Distribution Width (RDW)",
};

// Depth-aware element scan. A CCDA <section> nests <section>s (and an
// <organizer> can nest), so a non-greedy `<tag>...</tag>` regex silently
// truncates at the FIRST close tag. Counting depth keeps each block whole.
function elementBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<(/?)${tag}\\b([^>]*)>`, "gi");
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (const m of xml.matchAll(re)) {
    const closing = m[1] === "/";
    const selfClosing = /\/\s*$/.test(m[2] ?? "");
    if (closing) {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(xml.slice(start, (m.index ?? 0) + m[0].length));
        start = -1;
      }
      continue;
    }
    if (selfClosing) continue;
    if (depth === 0) start = m.index ?? 0;
    depth++;
  }
  return out;
}

function attr(tagText: string, name: string): string | null {
  const m = tagText.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m ? decodeEntities(m[1]) : null;
}

// The FIRST occurrence of `<tag ...>` (its whole start tag) inside a block.
function firstTag(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>`, "i"));
  return m ? m[0] : null;
}

// The <code>…</code> element with children, or "" when the code is self-closing
// (a bare `<code …/>` has no originalText, and a greedy match would otherwise
// run to some LATER element's closing tag).
function codeBlockOf(block: string): string {
  const tag = firstTag(block, "code");
  if (!tag || /\/\s*>$/.test(tag)) return "";
  return block.match(/<code\b[^>]*>[\s\S]*?<\/code>/i)?.[0] ?? "";
}

function innerText(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return null;
  const text = xmlText(m[1]);
  return text || null;
}

// A CCDA timestamp is a local wall clock plus an OFFSET ("20260224114303-0500").
// Convert it to the real instant, then to the app's local calendar day — a
// 23:30-05:00 draw is still that evening at home, never the next morning.
export function ccdaLocalDate(stamp: string | null | undefined): string | null {
  const raw = String(stamp ?? "").trim();
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?(?:\.\d+)?(Z|[+-]\d{4})?$/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, zone] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dateISO = `${y}-${mo}-${d}`;
  // No clock time, or no zone to anchor it: the printed calendar day IS the
  // answer — inventing an instant would be guessing at which day it belongs to.
  if (!hh || !zone) return dateISO;
  const offset = zone === "Z" ? "+00:00" : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const t = Date.parse(`${dateISO}T${hh}:${mm}:${ss ?? "00"}${offset}`);
  if (!Number.isFinite(t)) return dateISO;
  return localDateISO(new Date(t));
}

/**
 * The same stamp as an INSTANT, for ordering two readings of one analyte on one
 * day. Null when the stamp carries no clock time or no offset — an unorderable
 * pair falls back to "last seen wins".
 */
export function ccdaInstant(stamp: string | null | undefined): number | null {
  const raw = String(stamp ?? "").trim();
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?(?:\.\d+)?(Z|[+-]\d{4})?$/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, zone] = m;
  if (!hh || !zone) return null;
  const offset = zone === "Z" ? "+00:00" : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const t = Date.parse(`${y}-${mo}-${d}T${hh}:${mm}:${ss ?? "00"}${offset}`);
  return Number.isFinite(t) ? t : null;
}

function titleCased(raw: string): string {
  const text = String(raw ?? "").trim();
  // Only rewrite a SHOUTED order name; a mixed-case label is already how the
  // lab prints it, and lowercasing it would lose real casing ("pH", "HbA1c").
  if (!/[a-z]/.test(text)) {
    return text
      .toLowerCase()
      .replace(/\b([a-z])/g, (c) => c.toUpperCase())
      .replace(/\s+/g, " ")
      .trim();
  }
  return text.replace(/\s+/g, " ").trim();
}

// "136 - 145" / "4.6-" / "<130" / ">= 40" → numeric bounds.
function parseRangeText(text: string | null): { low: number | null; high: number | null } {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return { low: null, high: null };
  const between = raw.match(/^(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)$/);
  if (between) return { low: Number(between[1]), high: Number(between[2]) };
  const openHigh = raw.match(/^(-?\d+(?:\.\d+)?)\s*-\s*$/);
  if (openHigh) return { low: Number(openHigh[1]), high: null };
  const openLow = raw.match(/^-\s*(-?\d+(?:\.\d+)?)$/);
  if (openLow) return { low: null, high: Number(openLow[1]) };
  const lt = raw.match(/^<\s*=?\s*(-?\d+(?:\.\d+)?)$/);
  if (lt) return { low: null, high: Number(lt[1]) };
  const gt = raw.match(/^>\s*=?\s*(-?\d+(?:\.\d+)?)$/);
  if (gt) return { low: Number(gt[1]), high: null };
  return { low: null, high: null };
}

function numericAttr(tagText: string | null, name: string): number | null {
  if (!tagText) return null;
  const raw = attr(tagText, name);
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function xsiType(tagText: string | null): string {
  return String(attr(tagText ?? "", "xsi:type") ?? "").trim().toUpperCase();
}

// H/L/N are unambiguous. "A" (abnormal) is NOT in Cairn's marker vocabulary —
// it says "off" without saying which way — so it is resolved against the
// printed range, and left null when the range cannot settle it.
function resolveFlag(code: string | null, value: number | string, refLow: number | null, refHigh: number | null): "low" | "normal" | "high" | null {
  const c = String(code ?? "").trim().toUpperCase();
  if (!c) return null;
  if (/^H/.test(c)) return "high";
  if (/^L/.test(c)) return "low";
  if (c === "N") return "normal";
  if (/^A/.test(c) && typeof value === "number") {
    if (refHigh != null && value > refHigh) return "high";
    if (refLow != null && value < refLow) return "low";
  }
  return null;
}

function resultObservation(
  block: string,
  batteryName: string,
  fallbackDate: string | null
): { date: string | null; at: number | null; marker: CcdaResultMarker } | null {
  // The reference range carries its own <value>; strip it before reading the
  // observation's own result so the two can never be confused.
  const ranges = block.match(/<referenceRange\b[\s\S]*?<\/referenceRange>/gi) ?? [];
  const body = block.replace(/<referenceRange\b[\s\S]*?<\/referenceRange>/gi, " ");

  const codeTag = firstTag(body, "code");
  const loinc =
    codeTag && /2\.16\.840\.1\.113883\.6\.1/.test(codeTag) ? (attr(codeTag, "code") || null) : null;
  const sourceName =
    innerText(codeBlockOf(body), "originalText") || (codeTag ? attr(codeTag, "displayName") : null) || "";
  if (!sourceName && !loinc) return null;
  const name = (loinc && LOINC_CANONICAL_NAMES[loinc]) || titleCased(sourceName);
  if (!name) return null;
  if (NARRATIVE_BATTERY_RE.test(name) || NARRATIVE_BATTERY_RE.test(batteryName)) return null;

  const valueTag = firstTag(body, "value");
  if (!valueTag) return null;
  if (attr(valueTag, "nullFlavor")) return null;
  const type = xsiType(valueTag);
  // An embedded narrative (ED) is a report, not a result — the agent's job.
  if (type === "ED") return null;
  let value: number | string | null = null;
  let unit: string | null = null;
  if (type === "PQ" || type === "REAL" || type === "INT") {
    const n = numericAttr(valueTag, "value");
    if (n == null) return null;
    value = n;
    unit = attr(valueTag, "unit");
  } else if (type === "ST" || type === "" || type === "CD") {
    const text = innerText(body, "value") || attr(valueTag, "displayName");
    if (!text) return null;
    value = text.slice(0, 80);
  } else {
    return null;
  }
  if (value == null || value === "") return null;

  let refLow: number | null = null;
  let refHigh: number | null = null;
  for (const range of ranges) {
    const low = firstTag(range, "low");
    const high = firstTag(range, "high");
    if (low || high) {
      refLow = numericAttr(low, "value");
      refHigh = numericAttr(high, "value");
    }
    if (refLow == null && refHigh == null) {
      const parsed = parseRangeText(innerText(range, "text"));
      refLow = parsed.low;
      refHigh = parsed.high;
    }
    if (refLow != null || refHigh != null) break;
  }

  const interpretation = firstTag(body, "interpretationCode");
  const flag = resolveFlag(interpretation ? attr(interpretation, "code") : null, value, refLow, refHigh);
  const effective = firstTag(body, "effectiveTime");
  const effectiveValue = effective ? attr(effective, "value") : null;
  const date = ccdaLocalDate(effectiveValue) ?? fallbackDate;

  return {
    date,
    at: ccdaInstant(effectiveValue),
    marker: {
      name: name.slice(0, 120),
      value,
      unit: unit ? unit.slice(0, 40) : null,
      flag,
      ref_low: refLow,
      ref_high: refHigh,
      loinc,
      source_name: (sourceName || name).slice(0, 120),
    },
  };
}

function isResultsSection(section: string): boolean {
  const codeTag = firstTag(section, "code");
  if (codeTag && attr(codeTag, "code") === "30954-2") return true;
  const title = innerText(section, "title");
  return !!title && /results/i.test(title);
}

// One panel per collection DATE, markers deduped across the four or five
// encounter summaries a MyChart export repeats the same lipid panel in.
function extractResultPanels(files: Array<{ file: string; xml: string }>): HealthPanelInput[] {
  const byDate = new Map<
    string,
    {
      markers: Array<{ marker: CcdaResultMarker; at: number | null }>;
      batteries: string[];
      seen: Map<string, { index: number }>;
    }
  >();
  for (const { xml } of files) {
    for (const section of elementBlocks(xml, "section")) {
      if (!isResultsSection(section)) continue;
      for (const organizer of elementBlocks(section, "organizer")) {
        if (!/classCode\s*=\s*"BATTERY"/i.test(organizer.slice(0, 200))) continue;
        const codeTag = firstTag(organizer, "code");
        const batteryName =
          innerText(codeBlockOf(organizer), "originalText") || (codeTag ? attr(codeTag, "displayName") : null) || "";
        if (NARRATIVE_BATTERY_RE.test(batteryName)) continue;
        const effective = organizer.match(/<effectiveTime\b[\s\S]*?<\/effectiveTime>/i)?.[0] ?? "";
        const lowTag = effective ? firstTag(effective, "low") : null;
        const selfTag = firstTag(organizer, "effectiveTime");
        const organizerDate =
          ccdaLocalDate(lowTag ? attr(lowTag, "value") : null) ??
          ccdaLocalDate(selfTag ? attr(selfTag, "value") : null);
        for (const observation of elementBlocks(organizer, "observation")) {
          const parsed = resultObservation(observation, batteryName, organizerDate);
          if (!parsed || !parsed.date) continue;
          let bucket = byDate.get(parsed.date);
          if (!bucket) {
            bucket = { markers: [], batteries: [], seen: new Map() };
            byDate.set(parsed.date, bucket);
          }
          const m = parsed.marker;
          // The key identifies the ANALYTE, not the reading. With the value in it,
          // an amended (or merely re-rounded) repeat of one analyte on one date —
          // the same battery arriving in two exported documents — read as two
          // separate markers and the panel showed the athlete both.
          const key = `${m.loinc || normalizeMarkerName(m.name)}|${parsed.date}|${m.unit ?? ""}`;
          const prior = bucket.seen.get(key);
          if (prior) {
            // Duplicates that agree cost nothing either way. When they disagree the
            // LATER observation is the amendment, so it wins; an unorderable pair
            // (no clock time or no offset on either stamp) falls back to last seen.
            const priorAt = bucket.markers[prior.index]?.at ?? null;
            if (priorAt !== null && parsed.at !== null && parsed.at < priorAt) continue;
            bucket.markers[prior.index] = { marker: m, at: parsed.at };
            continue;
          }
          bucket.seen.set(key, { index: bucket.markers.length });
          bucket.markers.push({ marker: m, at: parsed.at });
          const battery = titleCased(batteryName);
          if (battery && !bucket.batteries.includes(battery)) bucket.batteries.push(battery);
        }
      }
    }
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, bucket]) => ({
      doc_date: date,
      kind: "bloodwork",
      type: CCDA_RESULTS_TYPE,
      summary: bucket.batteries.length ? bucket.batteries.join(" · ").slice(0, 1000) : null,
      markers: bucket.markers.map((entry) => entry.marker),
    }))
    .filter((p) => p.markers.length > 0);
}

// The analyte key a deterministic result and an agent's transcription of the
// same reading are matched on — canonical, so "HDL Cholesterol" and "HDL-C" are
// recognized as one analyte rather than two.
export function resultMarkerKeysByDate(panels: HealthPanelInput[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const panel of panels) {
    const date = String(panel?.doc_date ?? "");
    if (!date) continue;
    let keys = out.get(date);
    if (!keys) {
      keys = new Set<string>();
      out.set(date, keys);
    }
    for (const marker of Array.isArray(panel.markers) ? panel.markers : []) {
      const name = String((marker as any)?.name ?? "");
      if (!name) continue;
      keys.add(canonicalMarker(name).key || normalizeMarkerName(name));
    }
  }
  return out;
}
