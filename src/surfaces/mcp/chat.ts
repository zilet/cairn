import { z } from "zod";
import { distillChat } from "../../coachOps.js";
import {
  archiveChat,
  getArchivedConversation,
  listArchivedSessions,
  listChatMessages,
  searchChatMessages,
} from "../../domain/person/index.js";
import { asText, type McpToolRegistrar } from "./shared.js";

export function registerChatTools(server: McpToolRegistrar) {
  server.tool("get_chat_history",
    "Read the live coaching chat log (the PWA's Chat tab; archived turns excluded) — useful context on what the user has recently asked or been told.",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(listChatMessages(limit ?? 50)));

  server.tool("list_chat_sessions",
    "List past (archived) coaching conversations, newest first — each is a thread a 'fresh start' archived, with its message count, time span, and a one-line preview. Browse history without deleting anything.",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(listArchivedSessions(limit ?? 50)));

  server.tool("get_chat_session",
    "Read one archived conversation in full (chronological), keyed by its stable session_id from list_chat_sessions. archived_at is accepted as a legacy fallback.",
    {
      session_id: z.string().optional().describe("the stable session_id value from list_chat_sessions"),
      archived_at: z.string().optional().describe("legacy archived_at value from list_chat_sessions"),
    },
    async ({ session_id, archived_at }) => asText(getArchivedConversation(session_id || archived_at || "")));

  server.tool("search_chat",
    "Keyword-search the whole coaching history (live + archived turns). Returns matches with a snippet and the session they belong to (session_id for archived, null for live).",
    { q: z.string(), limit: z.number().int().optional() },
    async ({ q, limit }) => asText(searchChatMessages(q, limit ?? 40)));

  server.tool("reset_chat",
    "Start a fresh coaching conversation: distill durable facts (preferences, constraints, decisions) from the live chat into memory via one agent call, then archive every current message. Never deletes — archived turns stay in the DB and exports. Archiving never blocks on the agent; on agent failure the chat is still reset with distilled=0.",
    { agent: z.string().optional().describe("agent name, or omit/'auto' for the configured rotation") },
    async ({ agent }) => {
      const history = listChatMessages(200);
      if (!history.length) return asText({ ok: true, distilled: 0, archived: 0 });
      // MCP is a synchronous request/response surface (a job id is useless to a
      // one-shot call), so it distills INLINE via the shared helper, then archives.
      const r = await distillChat(agent, history.map((m: any) => ({ role: m.role, content: m.content })));
      const { archived, session_id } = archiveChat();
      return asText({ ok: true, distilled: r.distilled, archived, session_id, ...(r.note ? { note: r.note } : {}) });
    });
}
