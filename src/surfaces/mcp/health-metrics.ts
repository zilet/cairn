import { z } from "zod";
import { getRecoverySummary } from "../../domain/health/index.js";
import { asText, type McpToolRegistrar } from "./shared.js";

export function registerHealthMetricsTools(server: McpToolRegistrar) {
  server.tool(
    "get_recovery",
    "Quality-aware unified recovery view: Garmin + Apple/other fields are resolved per date and per signal (Garmin preferred only on overlaps), with current values distinct from window averages plus per-signal freshness, provenance and coverage. Includes training readiness/status, load, endurance/performance and Apple activity fields when present. Also returns 7d-vs-30d sleep/HRV/resting-HR deltas against the user's own norm. Graceful (has_data:false) when empty; use as planning context, never as a gate.",
    { days: z.number().int().min(1).max(366).optional() },
    async ({ days }) => asText(getRecoverySummary(days ?? 14))
  );
}
