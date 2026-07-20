import { db } from "../db.js";
import { listActiveDirectives } from "./coach.js";
import { cleanClinicalFacts } from "./health.js";
import { dicomTechnicalExport, listImagingStudiesStructured } from "./imaging.js";
import { getProfile } from "./profile.js";
import { prioritizeMarkers } from "./propagation.js";
import { listSupplements } from "./supplements.js";

// ---------- FHIR-inspired structured health export (F4) ----------
// A pragmatic, self-describing JSON summary of the athlete's health markers over
// time (plus the understood supplement regimen and active connected-brain
// directives) — something to hand a physician or another tool. NOT a real FHIR
// Bundle (no dependency, no full resource graph): a hand-rolled, Observation-like
// shape that's familiar to anyone who's seen FHIR, but readable on its own.
//
// Read-only / serialization: it assembles from the SAME marker history the app
// already derives (getMarkerHistory + prioritizeMarkers + OPTIMAL_ZONES). One
// Observation record per marker (the latest reading) carries every historical
// reading under `history[]`, the optimal band, an optimal-zone status (in/out +
// which direction is worse), and the deterministic trend. CONSTITUTION: no 0-100
// score anywhere — `status` is optimal-zone framing, never a grade; the internal
// impact_score never crosses this boundary (prioritizeMarkers already strips it).
export const HEALTH_EXPORT_VERSION = 3;

// Optimal-zone status for one marker, in plain FHIR-ish words. `interpretation`
// mirrors FHIR's interpretation concept loosely: "within-optimal" or, when out,
// the direction that's worse ("above-optimal"/"below-optimal"). `null` zone →
// "no-optimal-reference" (we track the trend but have no target band for it).
function exportOptimalStatus(m: any): {
  interpretation: string;
  inOptimal: boolean | null;
  worseDirection: "high" | "low" | "band" | null;
} {
  const o = m?.optimal; // {low, high, dir} from prioritizeMarkers, or null
  if (!o) return { interpretation: "no-optimal-reference", inOptimal: null, worseDirection: null };
  if (m.in_optimal === true)
    return { interpretation: "within-optimal", inOptimal: true, worseDirection: o.dir ?? null };
  if (m.in_optimal === false) {
    const num = typeof m?.latest?.value === "number" ? m.latest.value : Number(m?.latest?.value);
    // Which side it fell on (only meaningful when out of optimal + numeric).
    let side: string = o.dir ?? "band";
    if (Number.isFinite(num)) {
      if (num > o.high) side = "above-optimal";
      else if (num < o.low) side = "below-optimal";
      else side = "outside-optimal";
    } else {
      side = o.dir === "high" ? "above-optimal" : o.dir === "low" ? "below-optimal" : "outside-optimal";
    }
    return { interpretation: side, inOptimal: false, worseDirection: o.dir ?? null };
  }
  // Zone exists but value wasn't numeric → can't place it.
  return { interpretation: "indeterminate", inOptimal: null, worseDirection: o.dir ?? null };
}

function healthExportClinicalFacts() {
  const rows = db
    .prepare(
      `SELECT id, doc_date, created_at, original_name, parsed_json
         FROM health_documents
        ORDER BY COALESCE(doc_date, substr(created_at, 1, 10)) ASC, id ASC`
    )
    .all() as any[];
  const out: any[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    let parsed: any = null;
    try {
      parsed = row.parsed_json ? JSON.parse(row.parsed_json) : null;
    } catch {
      parsed = null;
    }
    const facts = cleanClinicalFacts(parsed?.clinical_facts, 500);
    const recordDate =
      (row.doc_date && String(row.doc_date).slice(0, 10)) || String(row.created_at ?? "").slice(0, 10) || null;
    for (const f of facts) {
      const key = [
        f.kind,
        f.date ?? "",
        f.name.toLowerCase(),
        (f.status ?? "").toLowerCase(),
        (f.detail ?? "").toLowerCase(),
      ].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: f.kind,
        date: f.date ?? null,
        name: f.name,
        status: f.status ?? null,
        detail: f.detail ?? null,
        source: f.source ?? row.original_name ?? null,
        sourceDocId: row.id,
        recordDate,
      });
      if (out.length >= 500) return out;
    }
  }
  return out;
}

export function buildHealthExport() {
  const profile = getProfile() || {};
  // prioritizeMarkers is the superset: per-marker latest + full points[] history +
  // optimal band + in_optimal + group + trend + forecast (impact_score stripped).
  const { markers, groups, flagged_count } = prioritizeMarkers();

  const observations = markers.map((m: any) => {
    const status = exportOptimalStatus(m);
    // Every historical reading as a tiny Observation-component (ascending by date).
    const history = (Array.isArray(m.points) ? m.points : []).map((p: any) => ({
      effectiveDate: p.date,
      value: p.value,
      flag: p.flag ?? null, // the lab's own low/normal/high flag, when present
      ...(p.unit_converted || p.unit_mismatch
        ? {
            sourceValue: p.source_value ?? null,
            sourceUnit: p.source_unit ?? null,
          }
        : {}),
    }));
    const t = m.trend || {};
    return {
      // Observation-like identity.
      name: m.name,
      key: m.key,
      category: m.group || "other",
      categoryLabel: m.group_label || "Other Markers",
      // The latest reading (FHIR "valueQuantity" + "effectiveDateTime").
      value: m.latest?.value ?? null,
      unit: m.unit ?? null,
      ...(m.latest?.unit_converted || m.latest?.unit_mismatch
        ? {
            sourceValue: m.latest?.source_value ?? null,
            sourceUnit: m.latest?.source_unit ?? null,
          }
        : {}),
      effectiveDate: m.latest?.date ?? null,
      // The lab's own reference flag (low/normal/high) for the latest reading.
      labFlag: m.latest?.flag ?? null,
      // Optimal-zone reference band (DISTINCT from the lab's population range) +
      // the optimal-zone interpretation. Informational; never a numeric grade.
      optimalRange: m.optimal ? { low: m.optimal.low, high: m.optimal.high, worseDirection: m.optimal.dir } : null,
      status: status.interpretation,
      inOptimal: status.inOptimal,
      // Deterministic trend across the whole series + the plain-language forecast.
      trend: {
        direction: t.dir ?? null,
        change: t.change ?? null,
        spanDays: t.span_days ?? null,
        readings: t.n ?? history.length,
        projection: t.projection ?? null, // words, never a score
      },
      history,
    };
  });

  // Understood supplement regimen (active only) — typical-dose approximations,
  // never a prescription; carried so a physician sees what the athlete takes.
  const supplements = listSupplements({ activeOnly: true }).map((s: any) => ({
    name: s.name,
    dose: s.dose ?? null,
    frequency: s.frequency ?? null,
    category: s.category ?? null,
    relatedMarkers: Array.isArray(s.related_markers) ? s.related_markers : [],
    note: s.note ?? null,
  }));

  // Active connected-brain directives (the cross-domain consequences of a flagged
  // marker). INFORMATIONAL; `uncertain` marks a real-but-unsettled lever.
  const directives = listActiveDirectives().map((d: any) => ({
    domain: d.domain,
    marker: d.marker ?? null,
    directive: d.directive ?? null,
    rationale: d.rationale ?? null,
    citation: d.citation ?? null,
    uncertain: !!d.uncertain,
  }));

  // A compact body-composition slice surfaced separately (it's the "body" marker
  // group — body fat %, lean mass, BMD, visceral, …). The same rows are in
  // `observations`; this is a convenience pointer, not a duplicate source.
  const bodyComposition = observations
    .filter((o: any) => o.category === "body")
    .map((o: any) => ({
      name: o.name,
      value: o.value,
      unit: o.unit,
      effectiveDate: o.effectiveDate,
      trend: o.trend.direction,
    }));
  const clinicalFacts = healthExportClinicalFacts();
  const imagingStudies = listImagingStudiesStructured().map((study: any) => ({
    resourceType: "DiagnosticReport",
    id: `imaging-${study.id}`,
    status: study.report_status,
    category: "imaging",
    effectiveDate: study.study?.study_date ?? study.doc_date ?? null,
    issued: study.study?.issued_at ?? null,
    code: {
      text: study.study?.procedure ?? null,
      modality: study.study?.modality ?? "UNKNOWN",
      rawModality: study.study?.raw_modality ?? null,
    },
    performer: study.study?.interpreting_clinician ?? null,
    facility: study.study?.facility ?? null,
    anatomy: study.anatomy,
    conclusion: study.impression ?? null,
    result: study.findings.map((finding: any) => ({
      resourceType: "Observation",
      id: finding.id,
      status: finding.source === "image_ai" ? "preliminary" : "final",
      category: "imaging",
      source: finding.source,
      bodySite: {
        system: finding.clinical_system,
        region: finding.body_region,
        text: finding.verbatim_site,
        laterality: finding.laterality,
      },
      valueString: finding.finding_text,
      interpretation: { severity: finding.severity, certainty: finding.certainty },
      components: finding.measurements.map((measurement: any) => ({
        code: { text: measurement.name },
        valueQuantity: measurement.value == null ? null : { value: measurement.value, unit: measurement.unit },
        valueString: measurement.value_text ?? null,
        qualifier: measurement.qualifier ?? null,
        method: measurement.method ?? null,
      })),
      sourceSpans: finding.source_spans,
    })),
    recommendations: study.recommendations,
    provenance: study.provenance,
    verification: study.verification,
    dicom: dicomTechnicalExport(Number(study.id)),
  }));

  return {
    // Self-describing metadata header (FHIR-ish Bundle-meta, hand-rolled).
    meta: {
      resourceType: "CairnHealthSummary",
      format: "fhir-inspired",
      profile: "https://cairn.health/health-export",
      exportVersion: HEALTH_EXPORT_VERSION,
      generated: new Date().toISOString(),
      generatedFrom: "cairn",
      note: "Optimal-zone bands are evidence-anchored longevity/preventive targets, DISTINCT from a lab's population reference interval. Informational, not medical advice. No 0-100 scores.",
      subject: {
        sex: profile.sex ?? null,
        age: profile.age ?? null,
        heightCm: profile.height_cm ?? null,
        weightLb: profile.weight_lb ?? null,
      },
    },
    summary: {
      markerCount: observations.length,
      flaggedCount: flagged_count, // markers the lab flagged low/high (count, not a grade)
      clinicalFactCount: clinicalFacts.length,
      imagingStudyCount: imagingStudies.length,
      categories: Array.isArray(groups) ? groups : [],
    },
    observations,
    clinicalFacts,
    imagingStudies,
    bodyComposition,
    supplements,
    directives,
  };
}
