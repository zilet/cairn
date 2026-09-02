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
import { forwardTimeline } from "../../repo/forward-timeline.js";
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
    "Read deterministic journey milestones (weight-loss thresholds, percent-to-goal crossings, body-fat bands). Calm in-app progress markers only.",
    { date: z.string().optional().describe("YYYY-MM-DD; defaults to today") },
    async ({ date }) => asText(journeyMilestones(date))
  );

  server.tool(
    "get_journey_timeline",
    "Read the road ahead: one ordered forward-looking timeline composed from the goal date, the phase projection window, scheduled lab re-checks and strength re-tests, a DEXA re-scan window, the program block boundary, and the nearest strength standards. Dated entries carry a real date, projections are windows, and standards are undated direction-of-travel. Empty when there is nothing to plan yet.",
    { date: z.string().optional().describe("YYYY-MM-DD; defaults to today") },
    async ({ date }) => asText(forwardTimeline(date))
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
      kind: phaseKind.describe("phase type: cut, maintenance, diet_break, reverse (post-cut calorie ramp-up), or gain"),
      start_date: z.string().nullable().optional().describe("YYYY-MM-DD the phase begins. Omit, null, empty, or an unparseable value defaults to today"),
      end_date: z.string().nullable().optional().describe("YYYY-MM-DD the phase is expected to end. Omit, null, empty, or an unparseable value leaves it open-ended (null)"),
      start_weight_lb: z.number().nullable().optional().describe("starting bodyweight in pounds, clamped to 50-700 and rounded to 1 decimal. Omitting the field defaults to the profile's current weight; passing null explicitly stores no value instead — it does not trigger that default"),
      target_weight_lb: z.number().nullable().optional().describe("target bodyweight in pounds, clamped to 50-700 and rounded to 1 decimal. Omitting the field defaults to the profile's goal_weight_lb; passing null explicitly stores no value instead — it does not trigger that default"),
      start_bodyfat_pct: z.number().nullable().optional().describe("starting body-fat percentage, clamped to 3-70 and rounded to 1 decimal. Omitting the field defaults to the current estimated body-fat reading; passing null explicitly stores no value instead — it does not trigger that default"),
      target_bodyfat_pct: z.number().nullable().optional().describe("target body-fat percentage, clamped to 3-70 and rounded to 1 decimal. Omitting the field defaults to the profile's goal_bodyfat_pct; passing null explicitly stores no value instead — it does not trigger that default"),
      planned_rate_lb_wk: z.number().nullable().optional().describe("intended pounds per week, negative for a cut; clamped to -5..5 and rounded to 1 decimal. Omitting the field picks a computed default: the goal check's recommended weekly rate for a cut, a lean-gain rate for a gain, or 0 for other kinds — this stored value is a plan input, not itself the lean-safe clamp applied elsewhere at apply time. Passing null explicitly stores no value instead of computing that default"),
      status: phaseStatus.optional().describe("lifecycle status to create the row with. Omit, or an unrecognized value, defaults to 'proposed' — the normal path, since a phase should go through explicit activate_journey_phase rather than being created already active"),
      reason: z.string().nullable().optional().describe("free-text rationale for the phase, trimmed and capped at 400 characters. Omit or null stores null"),
      source: z.string().nullable().optional().describe("free-text origin tag for the phase (e.g. 'coach', 'chat'), trimmed and capped at 80 characters. Omit or null defaults to 'manual'"),
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
