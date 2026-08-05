// The MCP mirror of GET /api/calibration/status (MCP ⊆ REST). Read-only: the
// coach can ask how well-anchored a quantity is before leaning on it, but a
// calibration is only ever RECORDED from work the athlete actually logged.
import { z } from "zod";
import { calibrationStatus, dueCalibrations } from "../../repo/calibration.js";
import { asText, type McpToolRegistrar } from "./shared.js";

export function registerCalibrationTools(server: McpToolRegistrar) {
  server.tool(
    "get_calibration_status",
    "How well-anchored the quantities steering training are — per endurance/strength item: an athlete-facing freshness word ('anchored' | 'aging' | 'stale' | 'never'), when it was last anchored, and whether a test is worth suggesting because the stale value is actually steering a live decision. Also returns `due`: the tests worth suggesting right now, each with the prose line and how it folds into existing work. Never a days-stale number, never a score, and nothing here gates training. Empty status.items / due are the normal quiet answer.",
    { date: z.string().optional().describe("YYYY-MM-DD to read as of; defaults to today") },
    async ({ date }) =>
      asText({ status: calibrationStatus(date || undefined), due: dueCalibrations(date || undefined) })
  );
}
