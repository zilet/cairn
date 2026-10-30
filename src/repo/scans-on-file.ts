// SCANS ON FILE — which scans and tracings the record already holds, and when.
//
// Two reads over the same table:
//   - `unremarkableScanDatesOnFile()`: for each scan topic a clinical ask can name (a
//     coronary calcium scan, a carotid ultrasound, an echo, a DEXA, an ECG), the newest
//     date a matching record with an unremarkable result is on file. The visit questions
//     drop a scan topic the record has already answered since the ask was raised
//     (src/repo/brain/clinician-ask.ts); a positive or abnormal result keeps the question.
//   - `cardiovascularImagingOnFile()`: the current cardiovascular imaging studies, as
//     dated facts the cardiovascular risk read shows beside the lipid picture. A coronary
//     calcium study carries its total Agatston score and percentile when the report
//     states them. Informational only: nothing here feeds PREVENT, and nothing here
//     softens, clears or rewrites a lipid finding.
//
// Pure reads (no writes). Matching is a small table — extend the table, never add a
// per-scan branch.

import { db } from "../db.js";
import { listImagingStudiesStructured } from "./imaging.js";
import { clipText } from "./shared.js";

export type ScanTopic = "cac" | "carotid" | "echo" | "dexa" | "ecg";

interface ScanRecordRule {
  topic: ScanTopic;
  /** Matched against what the study IS — procedure, modality wording, anatomy — never report prose. */
  imaging?: RegExp;
  /** Also matched against measurement names (an Agatston row makes a calcium study). */
  measurements?: RegExp;
  /** Health-document kinds that ARE this record (a DEXA report, an ECG tracing). */
  kinds?: readonly string[];
}

const CAC_PATTERN = /\bcac\b|coronary (?:artery )?calcium|agatston|calcium scor/i;

const SCAN_RECORD_RULES: readonly ScanRecordRule[] = [
  { topic: "cac", imaging: CAC_PATTERN, measurements: /agatston|\bcac\b|calcium score/i },
  { topic: "carotid", imaging: /\bcarotid\b/i },
  { topic: "echo", imaging: /\bechocardiogra|\btransthoracic echo|\btransesophageal echo|\b(?:tte|tee)\b/i },
  { topic: "dexa", imaging: /\bdexa\b|\bdxa\b|bone densitometr/i, kinds: ["dexa"] },
  { topic: "ecg", kinds: ["ecg"] },
];

// A cardiovascular study by its system, else by what it imaged (procedure / anatomy only).
const CARDIOVASCULAR_PATTERN =
  /\bcac\b|coronary|agatston|calcium scor|\bcarotid\b|echocardiogra|\bcta\b|ct angiogra|angiogra|\baort|cardiac|\bheart\b/i;

// What a study IS: its procedure, modality wording and anatomy. Impression and summary
// prose are never matched — an echo that "considers coronary calcium scoring" is not a
// calcium scan, and an abdominal ultrasound noting a normal aorta is not cardiovascular.
function studyIdentity(study: any): string {
  return [
    study?.study?.procedure,
    study?.study?.raw_modality,
    study?.anatomy?.body_region,
    study?.anatomy?.verbatim_site,
  ]
    .filter(Boolean)
    .join("\n");
}

function measurementNames(study: any): string {
  return (Array.isArray(study?.measurements) ? study.measurements : []).map((m: any) => m?.name ?? "").join("\n");
}

function matchesRule(rule: ScanRecordRule, study: any): boolean {
  return !!(rule.imaging?.test(studyIdentity(study)) || rule.measurements?.test(measurementNames(study)));
}

// The date a study is filed under: a date the person set on the record (doc_date) wins
// over the report's own study date.
function studyDate(study: any): string | null {
  const date = String(study?.doc_date ?? study?.study?.study_date ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function currentStudies(): any[] {
  try {
    return listImagingStudiesStructured();
  } catch {
    return [];
  }
}

// A finding the report graded as abnormal, or a follow-up still open, makes the result
// remarkable — exactly when the question to the doctor still matters.
const ABNORMAL_SEVERITY = new Set(["minimal", "mild", "moderate", "severe", "critical"]);
const CLOSED_RECOMMENDATION = new Set(["completed", "not_needed"]);

function studyUnremarkable(rule: ScanRecordRule, study: any): boolean {
  if (rule.topic === "cac") return coronaryCalcium(study)?.agatston_total === 0;
  const findings = Array.isArray(study?.findings) ? study.findings : [];
  if (findings.some((f: any) => ABNORMAL_SEVERITY.has(String(f?.severity ?? "")))) return false;
  const recs = Array.isArray(study?.recommendations) ? study.recommendations : [];
  return !recs.some((r: any) => !CLOSED_RECOMMENDATION.has(String(r?.status ?? "recommended")));
}

function docUnremarkable(parsedJson: unknown): boolean {
  let parsed: any = null;
  try {
    parsed = typeof parsedJson === "string" ? JSON.parse(parsedJson) : parsedJson;
  } catch {
    parsed = null;
  }
  const markers = Array.isArray(parsed?.markers) ? parsed.markers : [];
  return !markers.some((m: any) => /^(?:high|low|abnormal|critical)$/i.test(String(m?.flag ?? "")));
}

/**
 * For each scan topic, the newest date a matching record with an UNREMARKABLE result is on
 * file (a calcium score of 0; no finding graded abnormal and no follow-up still open; no
 * flagged reading). A positive or abnormal result answers nothing — it keeps the question.
 * Undated records never count.
 */
export function unremarkableScanDatesOnFile(): Map<ScanTopic, string> {
  const out = new Map<ScanTopic, string>();
  const note = (topic: ScanTopic, date: string | null) => {
    if (!date) return;
    const prior = out.get(topic);
    if (!prior || date > prior) out.set(topic, date);
  };
  for (const study of currentStudies()) {
    for (const rule of SCAN_RECORD_RULES) {
      if (matchesRule(rule, study) && studyUnremarkable(rule, study)) note(rule.topic, studyDate(study));
    }
  }
  const kinds = [...new Set(SCAN_RECORD_RULES.flatMap((rule) => rule.kinds ?? []))];
  if (kinds.length) {
    try {
      const rows = db
        .prepare(
          `SELECT kind, doc_date, parsed_json FROM health_documents
            WHERE kind IN (${kinds.map(() => "?").join(",")}) AND doc_date IS NOT NULL
              AND COALESCE(enrichment_status,'') != 'pending_confirm'`
        )
        .all(...kinds) as any[];
      for (const row of rows) {
        const date = String(row.doc_date ?? "").slice(0, 10);
        if (!docUnremarkable(row.parsed_json)) continue;
        for (const rule of SCAN_RECORD_RULES) {
          if (rule.kinds?.includes(String(row.kind))) note(rule.topic, /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null);
        }
      }
    } catch {
      /* the record is optional context; no rows means no topic is answered */
    }
  }
  return out;
}

export interface CardiovascularImagingFact {
  study_id: number;
  date: string | null;
  procedure: string | null;
  impression: string | null;
  coronary_calcium: { agatston_total: number | null; percentile: string | null } | null;
  note: string | null;
}

// The calcium total: a row naming the total/overall Agatston or calcium SCORE, else a
// single unqualified score row ("Agatston score", "CAC score"). Per-artery rows are never
// the total, and a volume or mass row (mm³, mg) is never a score whatever it is named.
const TOTAL_ROW = /\b(?:total|overall|combined)\b/i;
const SCORE_ROW = /agatston|calcium|\bcac\b/i;
const NAMES_SCORE = /agatston|\bscore\b/i;
const NOT_A_SCORE = /volume|\bmass\b|mm3|mm\^3|mm³|\bmg\b/i;
const BARE_SCORE_ROW = /^\s*(?:total\s+)?(?:agatston|coronary (?:artery )?calcium|calcium|cac)(?:\s+score)?\s*$/i;

function numberFrom(measurement: any): number | null {
  if (typeof measurement?.value === "number" && Number.isFinite(measurement.value)) return measurement.value;
  const match = String(measurement?.value_text ?? "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function coronaryCalcium(study: any): CardiovascularImagingFact["coronary_calcium"] {
  const measurements = Array.isArray(study?.measurements) ? study.measurements : [];
  const scoreRows = measurements.filter((m: any) => {
    const name = String(m?.name ?? "");
    return SCORE_ROW.test(name) && !NOT_A_SCORE.test(`${name} ${m?.unit ?? ""}`) && numberFrom(m) != null;
  });
  const name = (m: any) => String(m?.name ?? "");
  const total =
    scoreRows.find((m: any) => TOTAL_ROW.test(name(m)) && NAMES_SCORE.test(name(m))) ??
    scoreRows.find((m: any) => BARE_SCORE_ROW.test(name(m))) ??
    scoreRows.find((m: any) => TOTAL_ROW.test(name(m))) ??
    null;
  const pctRow = measurements.find((m: any) => /percentile/i.test(String(m?.name ?? "")));
  const pctRaw = pctRow ? (pctRow.value_text ?? (pctRow.value != null ? String(pctRow.value) : null)) : null;
  const percentile = pctRaw ? clipText(pctRaw, 40, { collapseWhitespace: true }) || null : null;
  return { agatston_total: total ? numberFrom(total) : null, percentile };
}

// Fixed, informational wording. A zero states what the scan saw and what it cannot
// see; a positive score states the number and percentile, never a verdict.
export const CAC_ZERO_NOTE =
  "No calcified plaque was seen on that date. It does not see soft plaque, and it does not change what your ApoB and Lp(a) readings are.";

function percentileText(percentile: string): string {
  return /percentile/i.test(percentile) ? percentile : `${percentile} percentile`;
}

function cacNote(cac: NonNullable<CardiovascularImagingFact["coronary_calcium"]>): string | null {
  if (cac.agatston_total == null) return null;
  if (cac.agatston_total === 0) return CAC_ZERO_NOTE;
  return `Agatston score ${cac.agatston_total}${cac.percentile ? ` (${percentileText(cac.percentile)})` : ""} on that date.`;
}

/** The current cardiovascular imaging on file, newest first, as dated facts. */
export function cardiovascularImagingOnFile(limit = 6): CardiovascularImagingFact[] {
  const out: CardiovascularImagingFact[] = [];
  const cacRule = SCAN_RECORD_RULES.find((rule) => rule.topic === "cac")!;
  for (const study of currentStudies()) {
    const cardiovascular =
      study?.anatomy?.clinical_system === "cardiovascular" || CARDIOVASCULAR_PATTERN.test(studyIdentity(study));
    if (!cardiovascular) continue;
    const cac = matchesRule(cacRule, study) ? coronaryCalcium(study) : null;
    out.push({
      study_id: Number(study.id),
      date: studyDate(study),
      procedure: clipText(study?.study?.procedure ?? study?.study?.raw_modality ?? "", 160, { collapseWhitespace: true, wordBoundary: true }) || null,
      impression:
        clipText(study?.impression ?? study?.summary ?? "", 200, {
          collapseWhitespace: true,
          wordBoundary: true,
          sentenceBoundary: true,
        }) || null,
      coronary_calcium: cac,
      note: cac ? cacNote(cac) : null,
    });
  }
  return out
    .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")) || b.study_id - a.study_id)
    .slice(0, Math.max(1, limit));
}
