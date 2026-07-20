export const IMAGING_STUDY_SCHEMA = `{
  "imaging_study": {
    "schema_version": 1,
    "report_status": "draft|preliminary|final|amended|corrected|unknown",
    "study": { "modality": "CT|MR|US|XR|MG|NM|PET|OTHER|UNKNOWN", "raw_modality": "<verbatim>", "procedure": "<verbatim>", "accession": "<verbatim|null>", "study_instance_uid": null, "study_date": "YYYY-MM-DD|null", "issued_at": "ISO timestamp|null", "facility": "<verbatim|null>", "ordering_clinician": "<verbatim|null>", "interpreting_clinician": "<verbatim|null>" },
    "anatomy": { "clinical_system": "musculoskeletal|neurologic|cardiovascular|pulmonary|gastrointestinal|genitourinary|reproductive|endocrine|head_and_neck|breast|whole_body|other|unknown", "body_region": "<hierarchical region or unknown>", "verbatim_site": "<source wording|null>", "laterality": "left|right|bilateral|midline|not_applicable|unknown", "code": null },
    "report": { "history": null, "technique": null, "comparison": null, "findings": null, "impression": null, "addendum": null },
    "findings": [{ "id": "<stable id>", "source": "report|image_ai|mychart|patient", "clinical_system": "<enum above>", "body_region": "<hierarchical region>", "verbatim_site": "<source wording|null>", "laterality": "<enum above>", "finding_text": "<source-grounded text>", "severity": "minimal|mild|moderate|severe|critical|not_stated|unknown", "certainty": "confirmed|probable|possible|indeterminate|unconfirmed|not_stated|unknown", "measurements": [{ "name": "<what was measured>", "value": 12.3, "value_text": null, "unit": "mm", "qualifier": null, "method": null }], "source_spans": [{ "file_id": 1, "page": 2, "start": null, "end": null, "text": "<short supporting excerpt>" }] }],
    "recommendations": [{ "id": "<stable id>", "source": "report|mychart|patient", "recommendation_text": "<source-stated wording>", "timeframe": "<source-stated|null>", "action": "<source-stated|null>", "status": "recommended|scheduled|completed|declined|not_needed|unknown", "source_spans": [] }],
    "provenance": { "source_kind": "report|images|report_and_images|mychart|patient", "extraction": "agent", "extractor": "<agent>", "source_doc_id": null, "source_hash": null, "confidence": "low|medium|high|unknown" },
    "verification": { "needs_confirmation": true, "user_confirmed": false, "clinician_confirmed": false, "user_confirmed_at": null, "clinician_confirmed_at": null, "corrected_at": null, "notes": null },
    "dicom": { "study_instance_uid": null, "series": [] }
  }
}`;

export interface ImagingPromptFile {
  id: number;
  sequence: number;
  path: string;
  mime: string;
  source_kind: string;
  original_name?: string | null;
}

export function buildImagingStudyPrompt(files: ImagingPromptFile[], existing?: unknown): string {
  const ordered = files.map((file) => ({
    file_id: file.id,
    sequence: file.sequence,
    // Agent processes run from Cairn's data directory. Only a bounded relative
    // upload reference crosses the prompt boundary; host/container paths do not.
    relative_path: `uploads/${
      String(file.path)
        .split(/[\\/]/)
        .pop()
        ?.replace(/[^a-zA-Z0-9._-]/g, "_") ?? "file"
    }`,
    mime: file.mime,
    source_kind: file.source_kind,
    original_name: file.original_name ?? null,
  }));
  const safeExisting = existing && typeof existing === "object" ? structuredClone(existing as any) : null;
  if (safeExisting?.study) safeExisting.study.study_instance_uid = null;
  if (safeExisting?.dicom) {
    safeExisting.dicom = {
      series_count: Array.isArray(safeExisting.dicom.series) ? safeExisting.dicom.series.length : 0,
      note: "Technical DICOM identity is held by the server and is not provided to this prompt.",
    };
  }
  return `You are structuring ONE imaging study from its sequentially uploaded report and image files.
Read every file below. The files collectively belong to one study; do not create separate studies.

CAIRN_AGENT_DATA_FILES: paths below are relative to the provided Cairn data working directory.

FILES (ordered):
${JSON.stringify(ordered)}

CLINICAL AUTHORITY AND SAFETY:
- A written radiologist report is authoritative. Transcribe its sections faithfully, preserving negation, uncertainty, comparison, severity, measurements, impression, addenda, and source-stated follow-up.
- Findings extracted from a radiologist report use source="report" (or source="mychart" when the written report is explicitly a MyChart rendering/export) and MUST cite the supporting owned file_id in source_spans.
- Generic image-model observations use source="image_ai" and MUST remain visibly unconfirmed. They may describe only directly visible, non-diagnostic observations.
- Files with source_kind="dicom_preview" are bounded, server-derived representative PNGs from DICOM pixels. They are non-diagnostic previews, may omit frames/series and must never be treated as the full study or a radiologist report.
- Image AI may NOT invent or assign a diagnosis, severity, certainty, prognosis, or follow-up; may NOT override, contradict, or silently merge into the written report; and may NOT turn a report's normal/negative statement into a positive finding.
- Recommendations come ONLY from the written report/MyChart/patient-provided text. Never create a recommendation from image AI.
- Do not create training restrictions, injury events, treatment, or medical advice. This is informational transcription for user/clinician confirmation.
- Measurements remain nested under their finding. Never emit lab markers, marker scores, optimal zones, or health directives.
- Missing/uncertain source attribution must use source="image_ai", severity="not_stated", certainty="unconfirmed". Never default to report authority.
- Preserve source distinctions and include short source_spans only with the owned file_id/page that supports them. Never emit a span without file_id, cite another study's file, or include a path in output.
- DICOM technical identity is server-owned. Preserve the EXISTING STUDY's dicom object exactly; never infer, copy, reveal, or alter UIDs from a preview.
- A prose-only written report is valid: populate report findings/impression even when findings[] or measurements[] is empty.
- Verification is server-owned: always emit clinician_confirmed=false and clinician_confirmed_at=null. Do not infer verification from report signatures or prose.
- Use unknown/other instead of guessing anatomy or clinical system. Use source-stated severity/certainty only.

EXISTING STUDY (path-free and UID-redacted; use only as context, never as authority over the files):
${JSON.stringify(safeExisting)}

Return ONE JSON object, no prose and no fences:
${IMAGING_STUDY_SCHEMA}`;
}
