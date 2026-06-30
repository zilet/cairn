import { z } from "zod";
import { consolidateMemory, growAboutMe, reconcileOutcomes } from "../../coachOps.js";
import {
  addMemory,
  deleteMemory,
  listMemory,
  listSuggestions,
  supersedeMemory,
  updateMemory,
} from "../../domain/person/index.js";
import { asText, type McpToolRegistrar } from "./shared.js";

export function registerMemoryLearningTools(server: McpToolRegistrar) {
  server.tool("add_memory",
    "Add a durable note Cairn should remember (preference, constraint, insight, observation).",
    { content: z.string(), kind: z.string().optional(), source: z.string().optional() },
    async (m) => asText(addMemory(m.content, m.kind, m.source ?? "agent")));

  server.tool("list_memory",
    "List accumulated memory notes (most recent first, superseded rows hidden). Set include_superseded for the full history.",
    { limit: z.number().int().optional(), include_superseded: z.boolean().optional() },
    async ({ limit, include_superseded }) => asText(listMemory(limit ?? 50, { includeSuperseded: include_superseded })));

  server.tool("update_memory",
    "Edit an existing memory note's content/kind/confidence by id. Use when a remembered fact CHANGED and should be corrected in place.",
    { id: z.number().int(), content: z.string().optional(), kind: z.string().optional(), confidence: z.number().optional() },
    async ({ id, content, kind, confidence }) => asText(updateMemory(id, { content, kind, confidence }) ?? { error: "not found", id }));

  server.tool("supersede_memory",
    "Mark a memory note superseded (it CONTRADICTS/REPLACES an older one). Never hard-deletes — the old fact stays in history. Optionally supply a replacement content (a new row is created) or replacement_id.",
    { id: z.number().int(), replacement: z.string().optional(), kind: z.string().optional(), replacement_id: z.number().int().optional(), reason: z.string().optional() },
    async ({ id, replacement, kind, replacement_id, reason }) =>
      asText(supersedeMemory(id, { content: replacement, kind, replacementId: replacement_id, reason }) ?? { error: "not found", id }));

  server.tool("delete_memory",
    "Delete a memory note by id.",
    { id: z.number().int() },
    async ({ id }) => asText(deleteMemory(id)));

  server.tool("consolidate_memory",
    "Quietly tidy the memory store: merge near-duplicates, supersede contradictions, promote recurring observations to durable traits. Marks, never hard-deletes. Returns the counts.",
    { agent: z.string().optional().describe("omit or 'auto' to use the configured rotation") },
    async ({ agent }) => asText(await consolidateMemory(agent)));

  server.tool("grow_about_me",
    "Grow profile.about_me into a coherent person-model from typed memory + family + check-ins. Augments existing (user-authored) content, never overwrites blindly. changed:false is the common answer.",
    { agent: z.string().optional().describe("omit or 'auto' to use the configured rotation") },
    async ({ agent }) => asText(await growAboutMe(agent)));

  server.tool("list_suggestions",
    "List recorded suggestions (Brief / session-suggest / nutrition check-in) and their reconciled outcomes — the outcome-learning audit trail.",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(listSuggestions(limit ?? 50)));

  server.tool("reconcile_outcomes",
    "Compare past suggestions to what actually happened (logged sets, weight trend, autoregulation) and write durable learning memories. Deterministic, no agent. Returns the counts.",
    { max: z.number().int().optional() },
    async ({ max }) => asText(reconcileOutcomes({ maxPerPass: max })));
}
