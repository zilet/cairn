import { z } from "zod";
import {
  applyMeasurementAction,
  getBodyMeasurement,
  getBodyMetricTrends,
  getBodyMetricsSummary,
} from "../../repo/body-metrics.js";
import { asText, type McpToolRegistrar } from "./shared.js";

export function registerBodyMetricsTools(server: McpToolRegistrar) {
  server.tool(
    "log_body_measurement",
    "Log an at-home body measuring session (circumferences, in inches by default — pass unit:'cm' to log the same site fields in centimeters). Any subset of sites — the user logs what they measured. Optional height_in updates the profile so BMI / body-fat can compute. Returns the logged row plus fresh plain-language indicators (BMI, waist-to-height, waist-to-hip, Navy body-fat % estimate). Nothing auto-applies.",
    {
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
      unit: z.enum(["in", "cm"]).optional().describe("unit the site values (and height_in) are given in; storage stays inches"),
      waist_in: z
        .number()
        .optional()
        .describe(
          "at the navel, relaxed, end of a normal exhale (follows `unit`, inches by default); drives waist-to-height and the Navy body-fat estimate"
        ),
      hip_in: z
        .number()
        .optional()
        .describe(
          "around the widest point of the glutes, feet together, tape level (follows `unit`); with waist_in drives waist-to-hip, and required (with neck_in) for the female Navy body-fat estimate"
        ),
      chest_in: z.number().optional().describe("at nipple line, tape level, end of a normal exhale (follows `unit`)"),
      shoulder_in: z
        .number()
        .optional()
        .describe("around the widest point of both shoulders over the delts, arms relaxed at sides (follows `unit`)"),
      neck_in: z
        .number()
        .optional()
        .describe(
          "just below the Adam's apple, tape sloping slightly down toward the front, relaxed (follows `unit`); required for the Navy body-fat estimate"
        ),
      thigh_in: z
        .number()
        .optional()
        .describe("widest point of the upper thigh, standing tall, weight even on both feet (follows `unit`)"),
      upper_arm_in: z
        .number()
        .optional()
        .describe("arm relaxed at side, halfway between shoulder and elbow, not flexed (follows `unit`)"),
      calf_in: z.number().optional().describe("widest point of the calf, standing, weight even on both feet (follows `unit`)"),
      forearm_in: z
        .number()
        .optional()
        .describe("widest point of the forearm, arm relaxed, palm facing up (follows `unit`)"),
      height_in: z.number().optional().describe("user height (follows `unit`, inches by default) — sets the profile so BMI/body-fat light up"),
      note: z.string().optional().describe("free-text note stored with this measurement row"),
      source: z.string().optional().describe("who/what recorded this reading, e.g. 'manual'; free text, capped at 40 characters. Omitting it stores 'chat'; an empty string stores 'manual'"),
    },
    async (a) => asText(applyMeasurementAction(a))
  );

  server.tool(
    "get_body_measurements",
    "Read logged body measurements + the latest reading + derived indicators (BMI, waist-to-height, waist-to-hip, Navy body-fat % estimate) over the window. Indicators are plain-language with optimal framing. Body-fat is a tape ESTIMATE, not a DEXA. Degrades to a 'set your height' hint when height is unset.",
    {
      days: z.number().int().optional(),
      id: z.number().int().optional().describe("read one measurement row by id"),
      unit: z.enum(["in", "cm"]).optional().describe("re-express circumferences in this unit (default in)"),
    },
    async ({ days, id, unit }) => {
      if (id != null) return asText(getBodyMeasurement(id) ?? { error: "not found", id });
      return asText(getBodyMetricsSummary(days ?? 365, unit));
    }
  );

  server.tool(
    "get_body_metric_trends",
    "Per-site least-squares trends across the window (waist, hips, chest, arms, …) plus bodyweight — each in plain language ('waist down 0.8 in over 6 weeks') with the raw points for a sparkline. Null-safe: a site with one reading reports no trend yet.",
    { days: z.number().int().optional(), unit: z.enum(["in", "cm"]).optional() },
    async ({ days, unit }) => asText(getBodyMetricTrends(days ?? 365, unit))
  );
}
