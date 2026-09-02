import { z } from "zod";
import { reconcileOutcomes } from "../../coachOps.js";
import {
  addMemory,
  deleteMemory,
  listMemory,
  listSuggestions,
  supersedeMemory,
  updateMemory,
} from "../../domain/person/index.js";
import { asText, type McpToolRegistrar } from "./shared.js";
import { queueMcpAgentJob } from "./background.js";

export function registerMemoryLearningTools(server: McpToolRegistrar) {
  server.tool(
    "add_memory",
    "Add a durable note Cairn should remember (preference, constraint, insight, observation).",
    { content: z.string(), kind: z.string().optional(), source: z.string().optional() },
    async (m) => asText(addMemory(m.content, m.kind, m.source ?? "agent"))
  );

  server.tool(
    "list_memory",
    "List accumulated memory notes (most recent first, superseded rows hidden). Set include_superseded for the full history.",
    { limit: z.number().int().optional(), include_superseded: z.boolean().optional() },
    async ({ limit, include_superseded }) => asText(listMemory(limit ?? 50, { includeSuperseded: include_superseded }))
  );

  server.tool(
    "update_memory",
    "Edit an existing memory note's content/kind/confidence by id. Use when a remembered fact CHANGED and should be corrected in place.",
    {
      id: z.number().int().describe("the memory row's id, from list_memory"),
      content: z.string().optional().describe("replacement text; omit to leave unchanged"),
      kind: z.string().optional().describe("replacement kind label (e.g. preference, constraint, fact); omit to leave unchanged"),
      confidence: z.number().optional().describe("0-5; clamped into that range. Omit to leave unchanged"),
    },
    async ({ id, content, kind, confidence }) =>
      asText(updateMemory(id, { content, kind, confidence }) ?? { error: "not found", id })
  );

  server.tool(
    "supersede_memory",
    "Mark a memory note superseded (it CONTRADICTS/REPLACES an older one). Never hard-deletes — the old fact stays in history. Optionally supply a replacement content (a new row is created) or replacement_id.",
    {
      id: z.number().int().describe("the memory row's id to mark superseded, from list_memory"),
      replacement: z
        .string()
        .optional()
        .describe(
          "text for a new replacement row; goes through the same add_memory dedup (an exact/near-duplicate live row is reused rather than a fresh insert). Omit if passing replacement_id, or to supersede with no replacement"
        ),
      kind: z.string().optional().describe("kind for the new replacement row when `replacement` is given; defaults to the superseded row's kind"),
      replacement_id: z.number().int().optional().describe("id of an EXISTING memory row to point at instead of creating one via `replacement`"),
      reason: z.string().optional().describe("free-text reason for the supersession; accepted but currently not persisted anywhere"),
    },
    async ({ id, replacement, kind, replacement_id, reason }) =>
      asText(
        supersedeMemory(id, { content: replacement, kind, replacementId: replacement_id, reason }) ?? {
          error: "not found",
          id,
        }
      )
  );

  server.tool("delete_memory", "Delete a memory note by id.", { id: z.number().int() }, async ({ id }) =>
    asText(deleteMemory(id))
  );

  server.tool(
    "consolidate_memory",
    "Queue a quiet memory consolidation: merge near-duplicates, supersede contradictions, and promote recurring observations. Returns a job immediately; poll get_agent_job. Marks, never hard-deletes.",
    { agent: z.string().optional().describe("omit or 'auto' to use the configured rotation") },
    async ({ agent }) => asText(queueMcpAgentJob("memory_consolidate", {}, agent))
  );

  server.tool(
    "grow_about_me",
    "Queue a coherent about-me refresh from typed memory, family, and check-ins. Returns a job immediately; poll get_agent_job. It augments user-authored content and never overwrites blindly.",
    { agent: z.string().optional().describe("omit or 'auto' to use the configured rotation") },
    async ({ agent }) => asText(queueMcpAgentJob("about_me_grow", {}, agent))
  );

  server.tool(
    "list_suggestions",
    "List recorded suggestions (Brief / session-suggest / nutrition check-in) and their reconciled outcomes — the outcome-learning audit trail.",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(listSuggestions(limit ?? 50))
  );

  server.tool(
    "reconcile_outcomes",
    "Compare past suggestions to what actually happened (logged sets, weight trend, autoregulation) and write durable learning memories. Deterministic, no agent. Returns the counts.",
    { max: z.number().int().optional() },
    async ({ max }) => asText(reconcileOutcomes({ maxPerPass: max }))
  );
}
