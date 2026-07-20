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
      doc_date: z.string().nullable().optional(),
      original_name: z.string().optional(),
      procedure: z.string().optional(),
      modality: z.string().optional(),
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
      id: z.number().int().positive(),
      imaging_study: z.any(),
      source_kind: z.enum(["report", "images", "report_and_images", "mychart", "patient"]).optional(),
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
      id: z.number().int().positive(),
      recommendation_id: z.string(),
      status: z.enum(["recommended", "scheduled", "completed", "declined", "not_needed", "unknown"]),
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
