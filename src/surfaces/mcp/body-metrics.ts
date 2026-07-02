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
      waist_in: z.number().optional(),
      hip_in: z.number().optional(),
      chest_in: z.number().optional(),
      shoulder_in: z.number().optional(),
      neck_in: z.number().optional(),
      thigh_in: z.number().optional(),
      upper_arm_in: z.number().optional(),
      calf_in: z.number().optional(),
      forearm_in: z.number().optional(),
      height_in: z.number().optional().describe("user height (follows `unit`, inches by default) — sets the profile so BMI/body-fat light up"),
      note: z.string().optional(),
      source: z.string().optional(),
    },
    async (a) => asText(applyMeasurementAction(a))
  );

  server.tool(
    "get_body_measurements",
    "Read logged body measurements + the latest reading + derived indicators (BMI, waist-to-height, waist-to-hip, Navy body-fat % estimate) over the window. Indicators are plain-language with optimal framing — no scores. Body-fat is a tape ESTIMATE, not a DEXA. Degrades to a 'set your height' hint when height is unset.",
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
