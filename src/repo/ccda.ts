import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanClinicalFacts, getHealthDocumentRaw, replaceHealthPanelsByType, updateHealthDocFields, upsertBloodPressureReading, type HealthPanelInput } from "./health.js";

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
    return { files: extraction.files, clinicalFacts: 0, storedClinicalFacts: 0, vitalsPanels: 0, vitalMarkers: 0, bpReadings: 0, extractedBpReadings: 0, wrote: false };
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
  return {
    files: extraction.files,
    clinicalFacts: facts.length,
    storedClinicalFacts: facts.length,
    vitalsPanels: created.length,
    vitalMarkers,
    bpReadings: bpCreated,
    extractedBpReadings: extraction.blood_pressure_readings.length,
    wrote: wroteFacts || panels.length > 0 || extraction.blood_pressure_readings.length > 0,
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
    return { files: 0, clinicalFacts: 0, storedClinicalFacts: 0, vitalsPanels: 0, vitalMarkers: 0, bpReadings: 0, extractedBpReadings: 0, wrote: false };
  }
  try {
    const extraction = extractCcdaHealthData(source.root);
    return applyCcdaHealthBackfill(sourceId, extraction);
  } finally {
    try { source.cleanup?.(); } catch { /* best-effort temp cleanup */ }
  }
}
