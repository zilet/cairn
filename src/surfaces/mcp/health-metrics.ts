import { z } from "zod";
import { getRecoverySummary } from "../../domain/health/index.js";
import { asText, type McpToolRegistrar } from "./shared.js";

export function registerHealthMetricsTools(server: McpToolRegistrar) {
  server.tool("get_recovery",
    "Unified recovery view: Garmin + Apple/other daily metrics merged into one sleep / HRV / resting-HR / steps picture over the window, plus acute training load / training readiness / fitness age when present. Also returns acute-vs-chronic baselines: recent (last 7d avg), baseline (30d avg) and delta (recent − baseline) for sleep/hrv/rhr — compare against the user's OWN norm, not a population. Graceful (has_data:false) when empty. Use as context, not plan authority.",
    { days: z.number().int().optional() },
    async ({ days }) => asText(getRecoverySummary(days ?? 14)));
}
