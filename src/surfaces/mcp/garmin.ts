import { z } from "zod";
import {
  getGarminCoachSummary,
  listGarminSources,
  listStrengthGarminActivities,
  listUnreconciledGarminStrength,
  reconcileGarminStrength,
  upsertGarminActivity,
  upsertGarminDailyMetric,
  upsertGarminSource,
} from "../../domain/training/index.js";
import { asText, type McpToolRegistrar } from "./shared.js";

export function registerGarminTools(server: McpToolRegistrar) {
  server.tool("upsert_garmin_source",
    "Create/update the local Garmin source record. Garmin remains one data source; this stores connector mode/status/cursor only.",
    {
      mode: z.enum(["unofficial", "official", "manual"]).optional(),
      label: z.string().nullable().optional(),
      auth_status: z.string().nullable().optional(),
      sync_cursor: z.string().nullable().optional(),
      last_sync_at: z.string().nullable().optional(),
    },
    async (a) => asText(upsertGarminSource(a)));

  server.tool("list_garmin_sources", "List configured Garmin source records without token material.", {},
    async () => asText(listGarminSources()));

  server.tool("sync_garmin",
    "Run a manual Garmin Connect sync using local GARMIN_USERNAME/GARMIN_PASSWORD or stored token files. Experimental unofficial connector. The scheduler also auto-syncs ~every 6h when configured; the result is recorded as garmin_last_sync_at/garmin_last_sync_status (visible via get_settings).",
    {
      days: z.number().int().optional().describe("Backfill window, default 30, max 180"),
      limit: z.number().int().optional().describe("Activity list fetch limit, default 100, max 200"),
      daily: z.boolean().optional().describe("Whether to sync daily metrics; default true"),
    },
    async (opts) => {
      const { syncGarmin } = await import("../../garmin.js");
      return asText(await syncGarmin(opts));
    });

  server.tool("upsert_garmin_activity",
    "Ingest one normalized Garmin activity. It is deduped by external_id and mirrored into Cairn activities for calendar/load context.",
    {
      source_id: z.number().int().optional(),
      external_id: z.string(),
      date: z.string().optional(),
      start_time: z.string().nullable().optional(),
      type: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
      duration_min: z.number().nullable().optional(),
      distance_km: z.number().nullable().optional(),
      calories: z.number().nullable().optional(),
      avg_hr: z.number().nullable().optional(),
      max_hr: z.number().nullable().optional(),
      ascent_m: z.number().nullable().optional(),
      training_load: z.number().nullable().optional(),
      training_effect: z.number().nullable().optional(),
      hr_zones: z.array(z.any()).nullable().optional(),
      exercise_sets: z.array(z.any()).nullable().optional().describe("Detected strength sets: [{category,name,reps,weight_kg,duration_sec,set_type}]"),
    },
    async ({ source_id, ...activity }) => asText(upsertGarminActivity(activity, source_id)));

  server.tool("upsert_garmin_daily_metric",
    "Ingest one normalized Garmin all-day/recovery metric row for a date.",
    {
      source_id: z.number().int().optional(),
      date: z.string(),
      steps: z.number().int().nullable().optional(),
      sleep_min: z.number().nullable().optional(),
      sleep_score: z.number().nullable().optional(),
      resting_hr: z.number().nullable().optional(),
      hrv_ms: z.number().nullable().optional(),
      stress_avg: z.number().nullable().optional(),
      body_battery_avg: z.number().nullable().optional(),
      body_battery_min: z.number().nullable().optional(),
      body_battery_max: z.number().nullable().optional(),
      active_calories: z.number().nullable().optional(),
    },
    async ({ source_id, ...metric }) => asText(upsertGarminDailyMetric(metric, source_id)));

  server.tool("get_garmin_summary",
    "Compact coach-facing Garmin summary: recent endurance load and recovery metrics. Use as context, not as plan authority.",
    { days: z.number().int().optional() },
    async ({ days }) => asText(getGarminCoachSummary(days ?? 14)));

  server.tool("list_unreconciled_garmin_strength",
    "List synced Garmin strength activities not yet linked to a Cairn session (session_id null) over a recent window — the watch logged a lift Cairn doesn't know about. Empty when Garmin isn't configured. Follow with reconcile_garmin_strength to merge them in.",
    { days: z.number().int().optional() },
    async ({ days }) => asText(listUnreconciledGarminStrength(days ?? 30)));

  server.tool("reconcile_garmin_strength",
    "Reconcile synced Garmin strength activities into the day's Cairn session: merge the physiology layer (HR/zones/calories/training effect) now, and queue the agentic narrative + extrapolation of the detected exercises the user didn't already log. Pass {date} for one day, else {days} for a recent window.",
    { date: z.string().optional(), days: z.number().int().optional() },
    async ({ date, days }) => {
      const rows = listStrengthGarminActivities(date ? { date } : { days });
      const sessions: any[] = [];
      for (const r of rows) {
        const out = reconcileGarminStrength(r.id);
        if (out?.session) sessions.push(out.session);
      }
      if (rows.length) {
        const { enqueueEnrich } = await import("../../enrich.js");
        for (const r of rows) enqueueEnrich("garmin_strength", r.id);
      }
      return asText({ ok: true, reconciled: rows.length, sessions });
    });
}
