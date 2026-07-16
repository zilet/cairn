import { z } from "zod";
import {
  activateJourneyPhase,
  createJourneyPhase,
  discardJourneyPhase,
  getJourneyPhase,
  journeyMilestones,
  journeyRead,
  journeyTransitionSuggestion,
  listJourneyPhases,
} from "../../repo/journey.js";
import { asText, type McpToolRegistrar } from "./shared.js";

const phaseKind = z.enum(["cut", "maintenance", "diet_break", "reverse", "gain"]);
const phaseStatus = z.enum(["proposed", "active", "completed", "discarded"]);

export function registerJourneyTools(server: McpToolRegistrar) {
  server.tool(
    "get_journey",
    "Read the body-composition journey: profile baseline/target, current body-fat estimate, active/proposed phase, transition suggestion, leanness-aware rate, and calm milestones. Read-only; suggestions never auto-apply.",
    { date: z.string().optional().describe("YYYY-MM-DD; defaults to today") },
    async ({ date }) => asText(journeyRead(date))
  );

  server.tool(
    "get_journey_milestones",
    "Read deterministic journey milestones (weight-loss thresholds, percent-to-goal crossings, body-fat bands). Calm in-app progress markers only; no scores or push notifications.",
    { date: z.string().optional().describe("YYYY-MM-DD; defaults to today") },
    async ({ date }) => asText(journeyMilestones(date))
  );

  server.tool(
    "list_journey_phases",
    "List body-composition journey phases. Phases are proposed first; only explicit activation makes one active.",
    { status: z.enum(["all", "proposed", "active", "completed", "discarded"]).optional() },
    async ({ status }) => asText(listJourneyPhases(status ?? "all"))
  );

  server.tool(
    "create_journey_phase",
    "Create a proposed journey phase (cut, maintenance, diet break, reverse, or gain). Does not activate automatically; review then call activate_journey_phase.",
    {
      kind: phaseKind,
      start_date: z.string().nullable().optional(),
      end_date: z.string().nullable().optional(),
      start_weight_lb: z.number().nullable().optional(),
      target_weight_lb: z.number().nullable().optional(),
      start_bodyfat_pct: z.number().nullable().optional(),
      target_bodyfat_pct: z.number().nullable().optional(),
      planned_rate_lb_wk: z.number().nullable().optional(),
      status: phaseStatus.optional(),
      reason: z.string().nullable().optional(),
      source: z.string().nullable().optional(),
    },
    async (input) => asText(createJourneyPhase(input))
  );

  server.tool(
    "activate_journey_phase",
    "Explicitly activate a journey phase. Any other active phase is completed; this never happens automatically from a suggestion.",
    { id: z.number().int() },
    async ({ id }) => asText(activateJourneyPhase(id))
  );

  server.tool(
    "discard_journey_phase",
    "Discard a proposed or inactive journey phase.",
    { id: z.number().int() },
    async ({ id }) => asText(discardJourneyPhase(id))
  );

  server.tool(
    "get_journey_phase",
    "Read one journey phase by id.",
    { id: z.number().int() },
    async ({ id }) => asText(getJourneyPhase(id))
  );

  server.tool(
    "get_journey_transition_suggestion",
    "Read the deterministic possible next-phase suggestion, such as maintenance after arrival or a stabilization break after a long cut. Pure read: it does not schedule, create, or activate a phase. Use it as context for optional Coach discussion; goal-identity changes still require explicit approval.",
    { date: z.string().optional().describe("YYYY-MM-DD; defaults to today") },
    async ({ date }) => asText(journeyTransitionSuggestion(date))
  );
}
