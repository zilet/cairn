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
      mode: z.enum(["unofficial", "official", "manual"]).optional().describe("connector mode: 'unofficial' (username/password scraping), 'official' (Garmin Health API), or 'manual' (no live sync). Defaults to 'unofficial' on create; omitting it on an update leaves the stored mode unchanged, like every other field here"),
      label: z.string().nullable().optional().describe("source instance label; identifies which stored source row this upserts (there can be more than one). Defaults to 'default' when omitted, null, or blank"),
      auth_status: z.string().nullable().optional().describe("free-text connector auth state, e.g. 'not_configured', 'ok', or an error message. Omitting on an update leaves the stored value unchanged; defaults to 'not_configured' on create"),
      sync_cursor: z.string().nullable().optional().describe("opaque pagination/resume cursor from the last sync. Omitting leaves the stored value unchanged"),
      last_sync_at: z.string().nullable().optional().describe("ISO timestamp of the last successful sync. Omitting leaves the stored value unchanged"),
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

  server.tool("garmin_export_backfill",
    "Send finished Cairn strength sessions older than the 7-day sync window back to Garmin, in batches, oldest first. Dry run by default: reports per session what would happen (unchanged / fill_or_replace / create / retarget / drop_surplus / skip_no_mapped_sets), naming the target activity and any Cairn-made shells it would withdraw, and which lifts the FIT catalog could not place, writing and queueing nothing. Pass apply:true to enqueue the exports on the serial queue.",
    {
      since: z.string().optional().describe("Earliest session date (YYYY-MM-DD); omit for all history"),
      until: z.string().optional().describe("Latest session date (YYYY-MM-DD)"),
      limit: z.number().int().optional().describe("Batch size, default 25, clamped 1..100"),
      apply: z.boolean().optional().describe("Actually enqueue the exports; default false (dry run)"),
      refine_unmapped: z.boolean().optional().describe("Also queue the agentic exercise enrichment for movements in the batch the catalog could not place (reason 'unmapped') or that have never been enriched at all (reason 'never_enriched'). Needs apply:true and enrich_enabled; a dry run only lists them as refine_candidates."),
    },
    async (opts) => {
      const { garminExportBackfill } = await import("../../garminExportBackfill.js");
      return asText(await garminExportBackfill(opts));
    });

  server.tool("upsert_garmin_activity",
    "Ingest one normalized Garmin activity. It is deduped by external_id and mirrored into Cairn activities for calendar/load context. Omitting a field leaves whatever is already stored for that external_id, and passing a measurement field as null clears the stored value. The four identity fields are the exception and never clear: date, start_time, type and name are resolved from what is already stored for this external_id — see their own notes.",
    {
      source_id: z.number().int().optional().describe("id of the garmin_sources row to attach to (from list_garmin_sources/upsert_garmin_source); omit to use or create the default source labelled by GARMIN_SOURCE_LABEL"),
      external_id: z.string().describe("Garmin's own activity id; the upsert key (unique per source) that dedupes retries/re-syncs of the same activity"),
      date: z.string().optional().describe("YYYY-MM-DD to file the activity under; omit to derive it from start_time, else fall back to the previously stored date for this external_id, else today"),
      start_time: z.string().nullable().optional().describe("ISO timestamp the activity started. Omitting or passing null on a re-sync preserves the previously stored value — it never clears an already-stored start_time"),
      type: z.string().nullable().optional().describe("Garmin's raw activity type string (e.g. 'running', 'strength_training'). A strength-like type (matching /strength|weight|lifting/i) is stored verbatim and deliberately gets NO row in the general `activities` table — it surfaces only via reconcile_garmin_strength as a Cairn session. Every other type is folded to a coarse modality (run/ride/swim/hike/other) before being mirrored into `activities`"),
      name: z.string().nullable().optional().describe("Garmin's activity title. Falls back to 'Garmin <type>' when omitted and nothing was previously stored for this external_id"),
      duration_min: z.number().nullable().optional().describe("total duration in minutes. Omit to leave the stored value alone; pass null to clear it"),
      distance_km: z.number().nullable().optional().describe("distance in kilometers. Omit to leave the stored value alone; pass null to clear it"),
      calories: z.number().nullable().optional().describe("calories burned (kcal). Omit to leave the stored value alone; pass null to clear it"),
      avg_hr: z.number().nullable().optional().describe("average heart rate in bpm. Omit to leave the stored value alone; pass null to clear it"),
      max_hr: z.number().nullable().optional().describe("max heart rate in bpm. Omit to leave the stored value alone; pass null to clear it"),
      ascent_m: z.number().nullable().optional().describe("elevation gain in meters. Omit to leave the stored value alone; pass null to clear it"),
      training_load: z.number().nullable().optional().describe("Garmin's own training load figure, passed through as-is (unitless, Garmin-defined) — never recomputed by Cairn. Omit to leave the stored value alone; pass null to clear it"),
      training_effect: z.number().nullable().optional().describe("Garmin's aerobic training effect, on Garmin's own 0-5 scale. Omit to leave the stored value alone; pass null to clear it"),
      hr_zones: z.array(z.any()).nullable().optional().describe("heart-rate-zone time samples, [{zone,secs,low_hr}], stored as-is with no validation against a fixed zone count. Omit to leave the stored value alone; pass null to clear it"),
      exercise_sets: z.array(z.any()).nullable().optional().describe("Detected strength sets: [{category,name,reps,weight_kg,duration_sec,set_type}]. Omit to leave the stored list alone; pass null to clear it"),
    },
    async ({ source_id, ...activity }) => asText(upsertGarminActivity(activity, source_id, { nullsClear: true })));

  server.tool("upsert_garmin_daily_metric",
    "Ingest one normalized Garmin all-day/recovery metric row for a date. Omitting a field leaves whatever is already stored for that date; passing it as null clears the stored value.",
    {
      source_id: z.number().int().optional().describe("id of the garmin_sources row to attach to (from list_garmin_sources/upsert_garmin_source); omit to use or create the default source labelled by GARMIN_SOURCE_LABEL"),
      date: z.string().describe("YYYY-MM-DD, must be a real calendar date; the upsert key together with source_id (one row per source per day)"),
      steps: z.number().int().nullable().optional().describe("step count for the day. Omit to leave the stored value for this date alone; pass null to clear it"),
      sleep_min: z.number().nullable().optional().describe("total sleep duration in minutes. Omit to leave the stored value alone; pass null to clear it"),
      sleep_score: z.number().nullable().optional().describe("Garmin's own sleep quality score (Garmin's 0-100 scale, not a Cairn score). Omit to leave the stored value alone; pass null to clear it"),
      resting_hr: z.number().nullable().optional().describe("resting heart rate in bpm. Omit to leave the stored value alone; pass null to clear it"),
      hrv_ms: z.number().nullable().optional().describe("heart rate variability in milliseconds. Omit to leave the stored value alone; pass null to clear it"),
      stress_avg: z.number().nullable().optional().describe("Garmin's average all-day stress reading (Garmin's 0-100 scale). Omit to leave the stored value alone; pass null to clear it"),
      body_battery_avg: z.number().nullable().optional().describe("Garmin's average Body Battery reading for the day (Garmin's 0-100 scale). Omit to leave the stored value alone; pass null to clear it"),
      body_battery_min: z.number().nullable().optional().describe("Garmin's minimum Body Battery reading for the day. Omit to leave the stored value alone; pass null to clear it"),
      body_battery_max: z.number().nullable().optional().describe("Garmin's maximum Body Battery reading for the day. Omit to leave the stored value alone; pass null to clear it"),
      active_calories: z.number().nullable().optional().describe("active (non-BMR) calories burned in the day (kcal). Omit to leave the stored value alone; pass null to clear it"),
    },
    async ({ source_id, ...metric }) => asText(upsertGarminDailyMetric(metric, source_id, { nullsClear: true })));

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
