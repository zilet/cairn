import { z } from "zod";
import { HEALTH_DOCUMENT_KINDS } from "../../healthDocumentKinds.js";
import {
  addHealthDocument,
  dedupeHealthDocuments,
  deleteHealthDocument,
  deleteImagingStudy,
  deriveDirectives,
  getHealthDocument,
  listHealthDocuments,
} from "../../domain/health/index.js";
import { asText, type McpToolRegistrar } from "./shared.js";

export function registerHealthRecordTools(server: McpToolRegistrar) {
  server.tool(
    "list_health_records",
    "List recent health documents (bloodwork / DEXA / other) with their kind, test date, summary, key markers and analysis status. Does not include the binary file.",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(listHealthDocuments(limit ?? 50))
  );

  server.tool(
    "add_health_record",
    "Record a health-document ANALYSIS without uploading a binary (e.g. after reading a lab report image in a Claude client). Stores extracted markers + summary directly; status is 'done'.",
    {
      kind: z.enum(HEALTH_DOCUMENT_KINDS),
      doc_date: z.string().nullable().optional().describe("the test date, YYYY-MM-DD"),
      summary: z.string().describe("plain-language summary, 1-3 sentences"),
      parsed: z.any().optional().describe("structured markers, e.g. { markers: [{name,value,unit,flag}], type }"),
    },
    async (record) => {
      if (record.kind === "imaging") {
        return asText({ ok: false, error: "use create_imaging_study and record_imaging_analysis" });
      }
      const doc = addHealthDocument({
        kind: record.kind,
        doc_date: record.doc_date ?? null,
        summary: record.summary,
        parsed_json: record.parsed ?? null,
        enrichment_status: "done",
      });
      try {
        deriveDirectives();
      } catch {
        /* never fail the record */
      }
      return asText(doc);
    }
  );

  server.tool(
    "dedupe_health_records",
    "Fold duplicate health records — the same lab draw filed more than once (same date, agreeing readings) — into one record per draw date. Without apply:true this only reports the plan; apply:true performs the fold (twin records are deleted).",
    { apply: z.boolean().optional().describe("true to perform the fold; omitted = dry run") },
    async ({ apply }) => {
      const result = dedupeHealthDocuments({ dryRun: apply !== true });
      if (!result.dry_run && result.merged) {
        try {
          deriveDirectives();
        } catch {
          /* never fail the fold */
        }
      }
      return asText(result);
    }
  );

  server.tool("delete_health_record", "Delete a health document by id.", { id: z.number().int() }, async ({ id }) => {
    if (getHealthDocument(id)?.kind === "imaging") return asText(deleteImagingStudy(id));
    const result = deleteHealthDocument(id);
    // Removing a panel WITHDRAWS what it propagated: re-derive so directives grounded in
    // markers that no longer exist are soft-resolved instead of outliving their evidence.
    try {
      deriveDirectives();
    } catch {
      /* never fail the delete */
    }
    return asText(result);
  });
}
