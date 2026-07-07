export const HEALTH_DOCUMENT_KINDS = [
  "bloodwork",
  "dexa",
  "ecg",
  "vitals",
  "metabolic_test",
  "visit_note",
  "after_visit_summary",
  "clinical_summary",
  "imaging",
  "vision",
  "procedure_note",
  "medication_list",
  "immunization_record",
  "other",
] as const;

export type HealthDocumentKind = (typeof HEALTH_DOCUMENT_KINDS)[number];

const HEALTH_DOCUMENT_KIND_SET = new Set<string>(HEALTH_DOCUMENT_KINDS);

export const HEALTH_DOCUMENT_KIND_SCHEMA = HEALTH_DOCUMENT_KINDS.join("|");

export function isHealthDocumentKind(value: unknown): value is HealthDocumentKind {
  return typeof value === "string" && HEALTH_DOCUMENT_KIND_SET.has(value);
}

export function normalizeHealthDocumentKind(value: unknown): HealthDocumentKind {
  if (isHealthDocumentKind(value)) return value;
  const s = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!s) return "other";
  if (/^(lab|labs|laboratory|blood|blood_work|bloodwork|lab_report|lab_panel|lipid_panel|cbc|metabolic_panel|ccda_labs?|ccda_lab_results?)$/.test(s)) return "bloodwork";
  if (/^(dexa|dx[a]?|body_comp|body_composition|bone_density|bmd)$/.test(s)) return "dexa";
  if (/^(ecg|ekg|electrocardiogram|garmin_ecg)$/.test(s)) return "ecg";
  if (/^(vital|vitals|vital_signs|blood_pressure|bp|home_bp|ccda_vitals?)$/.test(s)) return "vitals";
  if (/^(metabolic|metabolic_test|rmr|resting_metabolic_rate|indirect_calorimetry)$/.test(s)) return "metabolic_test";
  if (/^(visit|visit_note|progress_note|office_visit|televisit|consult_note|clinical_note|encounter_note)$/.test(s)) return "visit_note";
  if (/^(after_visit|after_visit_summary|avs|visit_summary|discharge_instructions|patient_instructions)$/.test(s)) return "after_visit_summary";
  if (/^(clinical_summary|health_summary|mychart_summary|ccda|ccd|continuity_of_care_document)$/.test(s)) return "clinical_summary";
  if (/^(imaging|radiology|xray|x_ray|mri|ct|ultrasound|scan)$/.test(s)) return "imaging";
  if (/^(vision|vision_rx|eyeglass|eyeglasses|glasses|prescription|optometry|eye_exam)$/.test(s)) return "vision";
  if (/^(procedure|procedures|procedure_note|operative_note|surgery_note|ccda_procedures?)$/.test(s)) return "procedure_note";
  if (/^(medication|medications|medication_list|med_list|rx|ccda_medications?)$/.test(s)) return "medication_list";
  if (/^(immunization|immunizations|vaccine|vaccines|immunization_record|ccda_immunizations?)$/.test(s)) return "immunization_record";
  return "other";
}

export function healthDocumentKindLabel(kind: unknown): string {
  switch (normalizeHealthDocumentKind(kind)) {
    case "bloodwork": return "Bloodwork";
    case "dexa": return "DEXA";
    case "ecg": return "ECG";
    case "vitals": return "Vitals";
    case "metabolic_test": return "Metabolic Test";
    case "visit_note": return "Visit Note";
    case "after_visit_summary": return "After Visit Summary";
    case "clinical_summary": return "Clinical Summary";
    case "imaging": return "Imaging";
    case "vision": return "Vision";
    case "procedure_note": return "Procedure Note";
    case "medication_list": return "Medication List";
    case "immunization_record": return "Immunization Record";
    default: return "Other";
  }
}

function factKindCounts(facts: any[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of facts) {
    const k = String(f?.kind ?? "").trim();
    if (k) counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

function allMarkersLookLikeVitals(markers: any[]): boolean {
  if (!markers.length) return false;
  return markers.every((m) =>
      /\b(systolic|diastolic|blood pressure|bp|pulse|heart rate|weight|height|bmi|spo2|oxygen|temperature|respiratory rate|pain score)\b/i
      .test(String(m?.name ?? ""))
  );
}

export function inferHealthDocumentKind(input: {
  kind?: unknown;
  type?: unknown;
  summary?: unknown;
  original_name?: unknown;
  markers?: any[];
  clinical_facts?: any[];
  mime?: unknown;
}): HealthDocumentKind {
  const explicit = normalizeHealthDocumentKind(input.kind);
  if (explicit !== "other") return explicit;

  const typed = normalizeHealthDocumentKind(input.type);
  if (typed !== "other") return typed;

  const markers = Array.isArray(input.markers) ? input.markers : [];
  const facts = Array.isArray(input.clinical_facts) ? input.clinical_facts : [];
  const markerText = markers.map((m) => m?.name).filter((v) => v != null).join("\n").toLowerCase();
  const text = [
    input.summary,
    input.original_name,
    input.mime,
    ...facts.flatMap((f) => [f?.kind, f?.name, f?.source, f?.detail]),
    ...markers.map((m) => m?.name),
  ]
    .filter((v) => v != null)
    .join("\n")
    .toLowerCase();

  if (facts.length >= 4 && /\b(my health summary|health_summary|continuity of care|ccda|ccd\b|clinical summary)\b/.test(text)) return "clinical_summary";
  if (markers.length) {
    if (allMarkersLookLikeVitals(markers)) return "vitals";
    if (/\b(body score|body fat|fat mass|lean mass|visceral fat|bone mineral|t-score|z-score|android|gynoid)\b/.test(markerText)) return "dexa";
    if (/\b(resting metabolic rate|measured rmr|rmr\b|indirect calorimetry|metabolic rate)\b/.test(markerText)) return "metabolic_test";
    if (/\b(cholesterol|triglycerides?|ldl|hdl|a1c|glucose|hemoglobin|hematocrit|creatinine|sodium|potassium|vitamin d|troponin|white blood cell|red blood cell|platelet|bilirubin|albumin|alkaline phosphatase|alanine aminotransferase|aspartate aminotransferase)\b/.test(markerText)) {
      return "bloodwork";
    }
    if (/\b(ecg|ekg|electrocardiogram|sinus rhythm|atrial fibrillation)\b/.test(markerText)) return "ecg";
  }

  if (/\b(after visit summary|avs|instructions - labs ordered|labs ordered today|patient instructions)\b/.test(text)) return "after_visit_summary";
  if (/\b(eyeglass|glasses prescription|reading glasses|vision prescription|single vision|right \+\d|left \+\d|od\b|os\b)\b/.test(text)) return "vision";
  if (/\b(dexa|body composition|body fat|lean mass|bone mineral|bmd|visceral adipose)\b/.test(text)) return "dexa";
  if (/\b(ecg|ekg|electrocardiogram|sinus rhythm|atrial fibrillation)\b/.test(text)) return "ecg";
  if (/\b(x-ray|xray|radiology|mri|ct scan|ultrasound|imaging)\b/.test(text)) return "imaging";
  if (/\b(progress notes?|assessment\/plan|televisit|office visit|consult note|presenting for follow-up|chief complaint|history of present illness)\b/.test(text)) return "visit_note";
  if (/\b(dexafit|resting metabolic rate|measured rmr|indirect calorimetry|metabolic assessment|metabolic test)\b/.test(text)) return "metabolic_test";
  if (/\b(vitals?|vital signs?|home blood pressure|blood pressure reading|systolic bp|diastolic bp)\b/.test(text)) return "vitals";
  if (/\b(mychart|health summary|continuity of care|ccda|ccd\b|clinical summary)\b/.test(text)) return "clinical_summary";
  if (/\b(procedure|operative note|surgery|colonoscopy|endoscopy)\b/.test(text)) return "procedure_note";

  const counts = factKindCounts(facts);
  if (facts.length && (counts.medication ?? 0) >= Math.max(2, facts.length * 0.7)) return "medication_list";
  if (facts.length && (counts.immunization ?? 0) >= Math.max(2, facts.length * 0.7)) return "immunization_record";
  if (facts.length && (counts.procedure ?? 0) >= Math.max(2, facts.length * 0.7)) return "procedure_note";
  if (facts.length && (counts.encounter ?? 0) > 0) return "visit_note";
  if (facts.length) return "clinical_summary";

  if (markers.length) return "bloodwork";
  return "other";
}
