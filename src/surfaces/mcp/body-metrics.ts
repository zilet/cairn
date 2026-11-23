import { z } from "zod";
import {
  applyMeasurementAction,
  getBodyMeasurement,
  getBodyMetricTrends,
  getBodyMetricsSummary,
} from "../../repo/body-metrics.js";
import {
  deleteMobilityCheck,
  listMobilityChecks,
  logMobilityCheck,
  MOBILITY_CHECKS,
  mobilityStanding,
} from "../../repo/mobility-checks.js";
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
  // Mobility self-checks: the same repo functions GET/POST /api/mobility-checks,
  // DELETE /api/mobility-checks/:id and GET /api/mobility-standing call.
  const checkKeys = MOBILITY_CHECKS.map((c) => c.key) as [string, ...string[]];
  server.tool(
    "log_mobility_check",
    "Log one mobility self-check reading (one side): ankle_knee_to_wall (knee-to-wall distance, cm, per side, higher = more range), toe_touch (fingertip to floor, cm, lower = more range, past the floor is negative), shoulder_back_scratch (fingertip gap as negative or overlap as positive, cm, per side, side = the hand over the top), deep_squat_hold (seconds held heels-down, or reached:true|false untimed). list_mobility_checks returns each check's how-to. Lengths are stored in cm (pass unit:'in' to give inches). Compared only with the athlete's own earlier readings; no norms, no grade. Two sides are two calls.",
    {
      check: z.enum(checkKeys).describe("the catalog key"),
      side: z.enum(["left", "right"]).optional().describe("required for per-side checks (ankle, shoulder); ignored otherwise"),
      value: z
        .number()
        .optional()
        .describe(
          "the reading: cm (or `unit`) for lengths; seconds for deep_squat_hold. toe_touch past the floor and a back-scratch gap are negative"
        ),
      unit: z.enum(["cm", "in", "mm", "s", "min"]).optional().describe("unit of `value`; cm for lengths and s for the squat hold by default"),
      reached: z
        .boolean()
        .optional()
        .describe("deep_squat_hold only, when no seconds were given: true = heels stayed down at the bottom, false = they lifted"),
      date: z.string().optional().describe("YYYY-MM-DD on or before today; defaults to today"),
      note: z.string().optional().describe("free-text note stored with the reading"),
    },
    async (a) => asText(logMobilityCheck({ ...a, source: "chat" }))
  );

  server.tool(
    "list_mobility_checks",
    "Read logged mobility self-check readings, newest first, with the catalog (each check's how-to, unit, side rule, which way is more range). Values are in the athlete's display units in `value_text`.",
    {
      check: z.enum(checkKeys).optional().describe("only this check"),
      days: z.number().int().optional().describe("only readings from the last N days"),
      limit: z.number().int().optional(),
    },
    async ({ check, days, limit }) => asText(listMobilityChecks({ check_key: check, days, limit }))
  );

  server.tool(
    "get_mobility_standing",
    "Where mobility stands: the latest reading per check and side in words, its direction against the first reading at least three weeks older (a move under the check's smallest meaningful change reads holding), days with logged mobility work in the last four weeks, and a quiet invite when no checks (or only old ones) exist. Words and directions only, never a score.",
    {},
    async () => asText(mobilityStanding())
  );

  server.tool(
    "delete_mobility_check",
    "Delete one mobility self-check reading by id (a mis-entry).",
    { id: z.number().int() },
    async ({ id }) => asText(deleteMobilityCheck(id))
  );
}
