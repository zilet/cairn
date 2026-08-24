import { z } from "zod";
import {
  addContextEvent,
  addFamily,
  CONTEXT_TAG_VOCAB,
  deleteContextEvent,
  deleteFamily,
  deleteSupplement,
  getInjuryImpacts,
  listContextEvents,
  listContextTags,
  listFamily,
  listSupplements,
  resolveContextEvent,
  toggleContextTag,
  understandSupplements,
  updateContextEvent,
  updateFamily,
  updateSupplement,
} from "../../domain/person/index.js";
import { asText, type McpToolRegistrar } from "./shared.js";
import { queueMcpAgentJob } from "./background.js";

export function registerPersonContextTools(server: McpToolRegistrar) {
  // ---- context events (life timeline the coach plans around) ----
  server.tool(
    "add_context_event",
    "Record a life-timeline event the coach should plan around: a trip (training disruption), an injury (deload/swap affected movements), a life_event (high stress / poor sleep / illness → reduce volume), or a family_event (a family/kids commitment like 'Tue 17:00 soccer' → keep that day shorter / more flexible). meta is kind-specific: trip {location}, injury {area, severity}, life_event {impact}, family_event {member, recurrence}.",
    {
      kind: z.enum(["trip", "injury", "life_event", "family_event"]),
      title: z.string(),
      detail: z.string().nullable().optional(),
      start_date: z.string().nullable().optional().describe("YYYY-MM-DD"),
      end_date: z.string().nullable().optional().describe("YYYY-MM-DD; null/omit = ongoing/open-ended"),
      meta: z
        .any()
        .optional()
        .describe(
          "kind-specific: trip {location}, injury {area,severity}, life_event {impact}, family_event {member,recurrence}"
        ),
    },
    async (a) => asText(addContextEvent(a))
  );

  server.tool(
    "list_context_events",
    "List life-timeline events. Pass active=true for only active/upcoming (not archived and not past their end_date).",
    { active: z.boolean().optional() },
    async ({ active }) => asText(listContextEvents({ activeOnly: !!active }))
  );

  server.tool(
    "update_context_event",
    "Update a life-timeline event by id (any subset of fields). Set archived=true to retire it.",
    {
      id: z.number().int(),
      kind: z.enum(["trip", "injury", "life_event", "family_event"]).optional(),
      title: z.string().optional(),
      detail: z.string().nullable().optional(),
      start_date: z.string().nullable().optional(),
      end_date: z.string().nullable().optional(),
      meta: z.any().optional(),
      archived: z.boolean().optional(),
    },
    async ({ id, ...patch }) => asText(updateContextEvent(id, patch) ?? { error: "not found", id })
  );

  server.tool(
    "resolve_context_event",
    "Close a life-timeline event as healed/over (e.g. an injury the user confirms is no longer bothering them) WITHOUT deleting it — it stays on the timeline and in exports but stops gating the day-read/coach as a hard constraint. Use this instead of delete when a niggle/injury has passed. `date` defaults to today.",
    {
      id: z.number().int(),
      date: z.string().nullable().optional().describe("YYYY-MM-DD healed-on date; defaults to today"),
    },
    async ({ id, date }) => asText(resolveContextEvent(id, date ?? undefined) ?? { error: "not found", id })
  );

  server.tool(
    "delete_context_event",
    "Delete a life-timeline event by id. To close a healed injury while KEEPING the record, prefer resolve_context_event.",
    { id: z.number().int() },
    async ({ id }) => asText(deleteContextEvent(id))
  );

  server.tool(
    "get_injury_impacts",
    "For each ACTIVE injury on the life timeline, the planned exercises it loads (with where they appear in the plan + any existing constraint note) and a few safe alternative exercises to consider. Deterministic, offline. Suggestions only — it never changes the plan.",
    {},
    async () => asText(getInjuryImpacts())
  );

  // ---- context tags (cheap one-tap life context, controlled vocabulary) ----
  const contextTagKeys = CONTEXT_TAG_VOCAB.map((t) => t.key) as [string, ...string[]];
  server.tool(
    "list_context_tags",
    `List the context tags (${CONTEXT_TAG_VOCAB.map((t) => t.key).join("/")}) tapped for a given day (default today). Cheap volunteered life context the insight generator quietly tests against outcomes — never advice, never surfaced as a lecture.`,
    { date: z.string().nullable().optional().describe("YYYY-MM-DD; defaults to today") },
    async ({ date }) => asText(listContextTags(date ?? undefined))
  );

  server.tool(
    "toggle_context_tag",
    `Tag or untag one day with a controlled-vocabulary context tag (${CONTEXT_TAG_VOCAB.map((t) => t.key).join("/")}). Tapping an already-tagged day untags it (archives the row). Never invent a key outside the vocabulary.`,
    {
      key: z.enum(contextTagKeys),
      date: z.string().nullable().optional().describe("YYYY-MM-DD; defaults to today"),
    },
    async ({ key, date }) => asText(toggleContextTag(key, date ?? undefined))
  );

  // ---- family roster (people the coach plans life around) ----
  server.tool(
    "list_family",
    "List the household roster (kids, partner, etc.) the coach plans life around. Their recurring commitments live as context_events with kind:'family_event'.",
    {},
    async () => asText(listFamily())
  );

  server.tool(
    "add_family",
    "Add a family member to the roster. relationship is e.g. son / daughter / partner / parent; color is an optional swatch; birthdate is optional YYYY-MM-DD; notes is free-text. allergies are a HARD exclusion in any shared/household meal; dietary_restrictions surface as optional kid-friendly / shared-meal mods.",
    {
      name: z.string(),
      color: z.string().nullable().optional(),
      relationship: z.string().nullable().optional(),
      birthdate: z.string().nullable().optional().describe("YYYY-MM-DD"),
      notes: z.string().nullable().optional(),
      allergies: z.string().nullable().optional(),
      dietary_restrictions: z.string().nullable().optional(),
    },
    async (a) => asText(addFamily(a))
  );

  server.tool(
    "update_family",
    "Update a family member by id (any subset of fields). allergies are a HARD exclusion in shared meals; dietary_restrictions surface as optional household mods.",
    {
      id: z.number().int(),
      name: z.string().nullable().optional(),
      color: z.string().nullable().optional(),
      relationship: z.string().nullable().optional(),
      birthdate: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
      allergies: z.string().nullable().optional(),
      dietary_restrictions: z.string().nullable().optional(),
    },
    async ({ id, ...patch }) => asText(updateFamily(id, patch) ?? { error: "not found", id })
  );

  server.tool("delete_family", "Delete a family member by id.", { id: z.number().int() }, async ({ id }) =>
    asText(deleteFamily(id))
  );

  // ---- supplements (UNDERSTANDING, not a daily log) ----
  server.tool(
    "list_supplements",
    "List the user's understood supplement regimen (canonical name, approximate dose, cadence, the markers/domains each touches). Not a daily log. all=true includes stopped ones.",
    { all: z.boolean().optional() },
    async ({ all }) => asText(listSupplements({ activeOnly: !all }))
  );

  server.tool(
    "understand_supplements",
    "Capture supplements from plain words ('creatine daily, omega-3, some D, whey occasionally') — the system approximates each into name + typical dose + cadence + related markers and stores it (dedup by name). NOT a daily log; say it once. Returns the understood items.",
    { text: z.string().describe("free-text mention of what they take") },
    async ({ text }) => asText(understandSupplements(text))
  );

  server.tool(
    "update_supplement",
    "Edit one understood supplement (dose, frequency, note), or set active=false to mark it stopped (kept for history).",
    {
      id: z.number().int(),
      dose: z.string().optional(),
      frequency: z.string().optional(),
      note: z.string().optional(),
      active: z.boolean().optional(),
    },
    async (args) => asText(updateSupplement(args.id, args) ?? { error: "not found", id: args.id })
  );

  server.tool(
    "delete_supplement",
    "Remove one supplement from the regimen by id.",
    { id: z.number().int() },
    async ({ id }) => asText(deleteSupplement(id))
  );

  server.tool(
    "onboard",
    "Queue frictionless first-run setup from one free-text intro. Returns a job immediately; poll get_agent_job. It understands profile, about-me, supplements, injuries, and memories without a questionnaire and degrades to a deterministic base.",
    { text: z.string().describe("the user's short free-text intro"), agent: z.string().optional() },
    async ({ text, agent }) => asText(queueMcpAgentJob("onboard", { text }, agent))
  );
}
