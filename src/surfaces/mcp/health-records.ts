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
  applyPlannedDedupe,
  settleNewHealthRecords,
} from "../../domain/health/index.js";
import { asText, type McpToolRegistrar } from "./shared.js";
import { queueMcpAgentJob } from "./background.js";
import { labDraws } from "../../repo/lab-draws.js";

export function registerHealthRecordTools(server: McpToolRegistrar) {
  server.tool(
    "list_health_records",
    "List recent health documents (bloodwork / DEXA / other) with their kind, test date, summary, key markers and analysis status. Does not include the binary file.",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(listHealthDocuments(limit ?? 50))
  );

  server.tool(
    "list_lab_draws",
    "The record's labs and scans as DRAWS, newest first: one row per (kind, date) → [{ date, date_words, kind: bloodwork|dexa|imaging|metabolic_test|ecg, label, doc_id, doc_ids[] }]. A draw's uploaded file and the panels split out of it are one row (doc_id is the uploaded source, else the newest; doc_ids lists every document of the draw). Read-only; mirrors GET /api/health-docs/draws.",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(labDraws({ limit: limit ?? undefined }))
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
      // The same draw already on file absorbs this one (the record returned is then
      // the survivor it folded into).
      const folded = settleNewHealthRecords(Number(doc.id), { label: `mcp health#${doc.id}` });
      try {
        deriveDirectives();
      } catch {
        /* never fail the record */
      }
      const survivor = folded?.clusters.find((c) => c.merged.some((m) => m.id === Number(doc.id)))?.survivor.id;
      return asText(survivor != null ? { ...getHealthDocument(survivor), folded_into: survivor } : doc);
    }
  );

  server.tool(
    "dedupe_health_records",
    "Fold duplicate health records — the same lab draw filed more than once (same date, agreeing readings), the same clinic encounter filed by two exports (same CCDA type, date and encounter time; the later export's reading wins and the replaced one is kept as superseded), the same imaging study filed twice (same day, procedure, impression and side/region), and imaging near-twins an agent has judged the same study at high confidence. Without apply:true this only reports the plan (each cluster names its rule and reason); apply:true performs the fold (twin records are deleted); pass the dry run's clusters (each {survivor, merged, rule}) with apply:true to fold exactly those or nothing ({ok:false, changed:true} when the records moved since the plan). judge:true (dry run only) first asks an agent about unjudged imaging near-twins and returns a queued job; poll get_agent_job for the plan.",
    {
      apply: z.boolean().optional().describe("true to perform the fold; omitted = dry run"),
      judge: z.boolean().optional().describe("dry run only: judge imaging near-twins first (returns a job)"),
      agent: z.string().optional().describe("for judge: agent name from list_agents; omit/'auto' for the health order"),
      clusters: z
        .array(z.object({ survivor: z.number().int(), merged: z.array(z.number().int()), rule: z.string() }))
        .optional()
        .describe("with apply:true: the planned clusters to fold, exactly as the dry run returned them"),
    },
    async ({ apply, judge, agent, clusters }) => {
      if (apply !== true && judge === true) return asText(queueMcpAgentJob("health_dedupe_check", {}, agent));
      if (apply === true && clusters) return asText(applyPlannedDedupe(clusters));
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

  server.tool(
    "delete_health_record",
    "Delete one health document by id, along with its stored markers. An imaging document is removed as a full imaging study, including its attachment files. Deleting a panel withdraws what it propagated: connected-brain directives are re-derived afterwards, so directives grounded only in the removed markers are soft-resolved. This is not reversible and it is not a deduplication tool; use dedupe_health_records to fold repeated filings of one draw.",
    { id: z.number().int() },
    async ({ id }) => {
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
