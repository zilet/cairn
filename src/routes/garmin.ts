import { Router } from "express";
import { ensureGarminSyncJob } from "../agentJobs.js";
import {
  getGarminCoachSummary,
  listGarminActivities,
  listGarminDailyMetrics,
  listGarminSources,
  listStrengthGarminActivities,
  listUnreconciledGarminStrength,
  reconcileGarminStrength,
  upsertGarminActivity,
  upsertGarminDailyMetric,
  upsertGarminSource,
  withoutGarminDailyAuditFields,
} from "../domain/training/index.js";

export const garminRouter = Router();

// ---- Garmin source data (normalized ingest boundary) ----
garminRouter.get("/garmin/sources", (_req, res) => res.json(listGarminSources()));
// A sync is a few dozen Garmin Connect round trips (15 s typical, 50 s at worst), so
// the request does not wait for it: it answers at once with the background job, and
// the PWA follows GET /api/agent-jobs/:id to the job's `done`, whose result is the
// body this route used to return. A second POST while a sync is queued or running
// gets the SAME job (`joined: true`), never a second pull. MCP sync_garmin still
// waits for the result, and joins a sync already in progress.
garminRouter.post("/garmin/sync", async (req, res, next) => {
  try {
    const { garminSyncWindow } = await import("../garmin.js");
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const { job, created } = ensureGarminSyncJob(
      garminSyncWindow({ days: body.days, limit: body.limit, daily: body.daily })
    );
    res.json({ ok: true, queued: true, joined: !created, job_id: Number(job.id), job });
  } catch (e) {
    // One error path: the shared handler logs it privately and answers the fixed
    // {ok:false,error:'internal error'} envelope instead of leaking e.message.
    next(e);
  }
});
// Send FINISHED Cairn strength sessions from before the 7-day sync window back to
// Garmin. Dry run unless {apply:true}: the preview says what each session would do
// and which lifts the FIT catalog cannot place, and nothing is written or queued.
// Applying enqueues ordinary garmin_export jobs, oldest first, on the serial queue.
garminRouter.post("/garmin/export-backfill", async (req, res) => {
  try {
    const body = req.body ?? {};
    const { garminExportBackfill } = await import("../garminExportBackfill.js");
    res.json(
      await garminExportBackfill({
        since: body.since ? String(body.since) : undefined,
        until: body.until ? String(body.until) : undefined,
        limit: body.limit != null ? Number(body.limit) : undefined,
        apply: body.apply === true,
        refine_unmapped: body.refine_unmapped === true,
      })
    );
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
garminRouter.post("/garmin/sources", (req, res) => {
  try {
    res.json(upsertGarminSource(req.body ?? {}));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
garminRouter.get("/garmin/activities", (req, res) =>
  res.json(listGarminActivities(req.query.limit ? Number(req.query.limit) : 30))
);
garminRouter.post("/garmin/activities", (req, res) => {
  try {
    // nullsClear: a hand correction through the API states null to CLEAR a field;
    // omitting it still preserves. The sync path never opts in (its sparse payloads
    // carry explicit nulls that must stay "preserve").
    res.json(
      upsertGarminActivity(req.body ?? {}, req.body?.source_id ? Number(req.body.source_id) : undefined, {
        nullsClear: true,
      })
    );
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
// `raw_json` (device wire payload, ~57 KB/row) is dropped by default; `?raw=1`
// includes it. Nothing on the read side uses it — only ingest writes it.
garminRouter.get("/garmin/daily", (req, res) =>
  res.json(listGarminDailyMetrics(req.query.limit ? Number(req.query.limit) : 30, { raw: req.query.raw === "1" }))
);
garminRouter.post("/garmin/daily", (req, res) => {
  try {
    res.json(
      upsertGarminDailyMetric(withoutGarminDailyAuditFields(req.body ?? {}), req.body?.source_id ? Number(req.body.source_id) : undefined, {
        nullsClear: true,
      })
    );
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
garminRouter.get("/garmin/summary", (req, res) =>
  res.json(getGarminCoachSummary(req.query.days ? Number(req.query.days) : 14))
);
// Synced Garmin strength activities not yet linked to a Cairn session — the watch
// logged a lift Cairn doesn't know about. Drives the calm "reconcile?" Today card;
// [] when Garmin isn't configured (no rows). Reconciling (POST /garmin/reconcile)
// clears the list.
garminRouter.get("/garmin/unreconciled", (req, res) =>
  res.json(listUnreconciledGarminStrength(req.query.days ? Number(req.query.days) : 30))
);
// Reconcile synced Garmin strength activities into the day's Cairn session: the
// deterministic physiology merge runs now; the agentic narrative/extrapolation
// is queued on the serial enrichment queue. {date} for one day, else {days} window.
garminRouter.post("/garmin/reconcile", async (req, res) => {
  try {
    const date = req.body?.date ? String(req.body.date) : undefined;
    const days = req.body?.days != null ? Number(req.body.days) : undefined;
    const rows = listStrengthGarminActivities(date ? { date } : { days });
    const sessions: any[] = [];
    for (const r of rows) {
      const out = reconcileGarminStrength(r.id);
      if (out?.session) sessions.push(out.session);
    }
    if (rows.length) {
      const { enqueueEnrich } = await import("../enrich.js");
      for (const r of rows) enqueueEnrich("garmin_strength", r.id);
    }
    res.json({ ok: true, reconciled: rows.length, sessions });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
