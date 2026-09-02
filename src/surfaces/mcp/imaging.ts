import { z } from "zod";
import {
  applyImagingAnalysis,
  confirmImagingStudy,
  correctImagingStudy,
  createImagingStudy,
  deleteImagingStudy,
  getImagingStudy,
  getSettings,
  listImagingStudiesStructured,
  setHealthDocEnrichStatus,
  updateImagingRecommendationStatus,
} from "../../domain/health/index.js";
import { asText, type McpToolRegistrar } from "./shared.js";
import { dicomManifest, publicDicomImportJob } from "../../dicomImports.js";

export function registerImagingTools(server: McpToolRegistrar) {
  server.tool(
    "get_dicom_import_job",
    "Read the durable status and path-free result of a DICOM import. Binary upload remains REST-only.",
    { job_id: z.number().int().positive() },
    async ({ job_id }) => asText(publicDicomImportJob(job_id) ?? { ok: false, error: "not found" })
  );

  server.tool(
    "get_dicom_manifest",
    "Read a study-owned DICOM technical manifest with opaque numeric IDs and preview limitations. Raw UIDs and files are omitted.",
    { study_id: z.number().int().positive() },
    async ({ study_id }) => asText(dicomManifest(study_id) ?? { ok: false, error: "not found" })
  );

  server.tool(
    "list_imaging_studies",
    "List every structured imaging study with metadata, report impression, source-distinguished findings, nested measurements, source-stated recommendations, provenance, and confirmation state. No file paths or raw model output.",
    {},
    async () => asText(listImagingStudiesStructured())
  );

  server.tool(
    "get_imaging_study",
    "Get one first-class imaging study and its ordered attachment metadata. Binary paths are private.",
    { id: z.number().int().positive() },
    async ({ id }) => asText(getImagingStudy(id))
  );

  server.tool(
    "create_imaging_study",
    "Create an empty imaging-study draft. Upload JPEG/PNG/PDF attachments through REST, or supply a structured analysis with update_imaging_study.",
    {
      doc_date: z.string().nullable().optional().describe("YYYY-MM-DD study date. Omit, null, or anything not matching that exact format is stored as no date"),
      original_name: z.string().optional().describe("display filename for the study, capped at 240 characters; whitespace-collapsed. Omit to leave it unset"),
      procedure: z.string().optional().describe("free-text procedure name (e.g. 'MRI Lumbar Spine'), stored on the study's `study.procedure` field. Omit to leave it unset"),
      modality: z.string().optional().describe("free-text imaging modality (e.g. 'MRI', 'CT', 'X-ray'), stored on the study's `study.modality` field. Omit to leave it unset"),
    },
    async (input) =>
      asText(
        createImagingStudy({
          ...input,
          study: { procedure: input.procedure, modality: input.modality, study_date: input.doc_date },
        })
      )
  );

  server.tool(
    "analyze_imaging_study",
    "Queue joint analysis of an imaging study's sequentially uploaded report/images. Idempotent while already pending/running; written radiologist reports remain authoritative.",
    { id: z.number().int().positive() },
    async ({ id }) => {
      const study = getImagingStudy(id) as any;
      if (!study) return asText({ ok: false, error: "not found" });
      if (!study.study_files?.length) return asText({ ok: false, error: "no study files" });
      if (!getSettings().enrich_enabled) return asText({ ok: false, error: "analysis disabled" });
      if (!["pending", "in_progress"].includes(study.enrichment_status)) {
        setHealthDocEnrichStatus(id, "pending");
        void import("../../enrich.js").then((m) => m.enqueueEnrich("health", id)).catch(() => {});
      }
      return asText({ ok: true, study: getImagingStudy(id) });
    }
  );

  server.tool(
    "update_imaging_study",
    "Correct a study with a FHIR DiagnosticReport-shaped imaging_study payload. Strongly coerced; resets user confirmation until reconfirmed.",
    { id: z.number().int().positive(), imaging_study: z.any(), notes: z.string().optional() },
    async ({ id, imaging_study, notes }) =>
      asText(correctImagingStudy(id, imaging_study, notes) ?? { ok: false, error: "valid imaging structure required" })
  );

  server.tool(
    "record_imaging_analysis",
    "Store a source-grounded imaging extraction already produced by a file-capable client. Image-AI observations stay unconfirmed and cannot create follow-up recommendations.",
    {
      id: z.number().int().positive().describe("id of the imaging study (from create_imaging_study or list_imaging_studies)"),
      imaging_study: z.any().describe("FHIR DiagnosticReport-shaped extraction (same imaging_study structure as update_imaging_study), coerced and merged onto the study; source-authority rules decide which fields a lower-trust source is allowed to overwrite"),
      source_kind: z.enum(["report", "images", "report_and_images", "mychart", "patient"]).optional().describe("what the extraction was grounded in: a written 'report', the 'images' themselves, both, a 'mychart' export, or 'patient'-reported. Omitting it falls back to the submitted payload's own provenance.source_kind, then to 'patient' when that is absent or unrecognized — it is never left unset, and the study's existing source kind is not carried over"),
    },
    async ({ id, imaging_study, source_kind }) =>
      asText(
        applyImagingAnalysis(id, imaging_study, { sourceKind: source_kind, extractor: "mcp-client" }) ?? {
          ok: false,
          error: "valid imaging structure required",
        }
      )
  );

  server.tool(
    "confirm_imaging_study",
    "Confirm the current extraction as reviewed by the user. Idempotent and preserves the original confirmation timestamp.",
    { id: z.number().int().positive(), notes: z.string().optional() },
    async ({ id, notes }) => asText(confirmImagingStudy(id, notes))
  );

  server.tool(
    "update_imaging_followup_status",
    "Update the user's source-stated follow-up status without changing the report recommendation itself.",
    {
      id: z.number().int().positive().describe("id of the imaging study that owns the recommendation"),
      recommendation_id: z.string().describe("id of the specific recommendation within the study's `recommendations` array (from get_imaging_study/list_imaging_studies); a recommendation_id not found on the study returns no update"),
      status: z.enum(["recommended", "scheduled", "completed", "declined", "not_needed", "unknown"]).describe("the athlete's own follow-through status for this recommendation. Never changes the source-stated recommendation text itself, only this status field"),
    },
    async ({ id, recommendation_id, status }) =>
      asText(updateImagingRecommendationStatus(id, recommendation_id, status))
  );

  server.tool(
    "delete_imaging_study",
    "Delete an imaging study and all owned attachment files.",
    { id: z.number().int().positive() },
    async ({ id }) => asText(deleteImagingStudy(id))
  );
}
