import { Router } from "express";
import type { Request, Response } from "express";
import { authEnabled } from "../auth.js";
import { getUpdateStatus, checkForUpdate } from "../updateCheck.js";
import { getVersion } from "../version.js";
import { db } from "../db.js";
import { getBuildInfo } from "../build-info.js";

export const systemRouter = Router();

systemRouter.get("/health", (_req, res) =>
  res.json({ ok: true, auth_required: authEnabled, version: getVersion(), build: getBuildInfo() })
);

function ageSeconds(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const time = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(time) ? Math.max(0, Math.round((Date.now() - time) / 1_000)) : null;
}

export function readinessHandler(_req: Request, res: Response) {
  try {
    db.prepare("SELECT 1 AS ok").get();
    const queue = (table: "agent_jobs" | "chat_turns") => {
      const rows = db.prepare(
        `SELECT status, COUNT(*) AS count, MIN(COALESCE(started_at,created_at)) AS oldest_at
           FROM ${table} WHERE status IN ('queued','running') GROUP BY status`
      ).all() as Array<{ status: string; count: number; oldest_at: string | null }>;
      const counts = { queued: 0, running: 0, oldest_age_sec: null as number | null, failed_24h: 0 };
      for (const row of rows) {
        if (row.status === "queued" || row.status === "running") counts[row.status] = Number(row.count);
        const age = ageSeconds(row.oldest_at);
        if (age != null) counts.oldest_age_sec = Math.max(counts.oldest_age_sec ?? 0, age);
      }
      counts.failed_24h = Number(
        (db.prepare(
          `SELECT COUNT(*) AS n FROM ${table} WHERE status='error' AND finished_at >= datetime('now','-1 day')`
        ).get() as any)?.n ?? 0
      );
      return counts;
    };
    const heartbeat = db.prepare(`SELECT value,updated_at FROM app_state WHERE key='scheduler_heartbeat'`).get() as any;
    const heartbeatAge = ageSeconds(heartbeat?.value ?? heartbeat?.updated_at);
    const bootGrace = process.uptime() < 180;
    const schedulerStatus = heartbeatAge == null ? (bootGrace ? "starting" : "stale") : heartbeatAge <= 180 ? "fresh" : "stale";
    const ok = schedulerStatus !== "stale";
    return res.status(ok ? 200 : 503).json({
      ok,
      database: "ok",
      build: getBuildInfo(),
      queues: { agent_jobs: queue("agent_jobs"), chat_turns: queue("chat_turns") },
      scheduler: { status: schedulerStatus, last_at: heartbeat?.value ?? null, age_sec: heartbeatAge },
    });
  } catch {
    return res.status(503).json({ ok: false, database: "unavailable" });
  }
}

// Readiness is stronger than liveness: prove SQLite is readable and expose only
// compact durable queue counts. Optional coaching providers never gate readiness.
systemRouter.get("/ready", readinessHandler);

// The running version, and whether a newer Cairn release exists. The status is
// served from the app_state cache; the scheduler keeps it fresh, and POST forces
// an explicit operator-pulled check.
systemRouter.get("/version", (_req, res) => res.json({ version: getVersion(), build: getBuildInfo() }));
systemRouter.get("/update-status", (_req, res) => res.json(getUpdateStatus()));
systemRouter.post("/update-check", async (_req, res) => {
  // checkForUpdate never throws; network failures fold into status.error.
  res.json(await checkForUpdate());
});
