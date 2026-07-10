import { Router } from "express";
import type { Request, Response } from "express";
import { authEnabled } from "../auth.js";
import { getUpdateStatus, checkForUpdate } from "../updateCheck.js";
import { getVersion } from "../version.js";
import { db } from "../db.js";
import { getBuildInfo } from "../build-info.js";

export const systemRouter = Router();

// Liveness only: process identity plus exact build provenance. It deliberately
// does not probe optional coaching CLIs or other external providers.
systemRouter.get("/health", (_req, res) =>
  res.json({ ok: true, auth_required: authEnabled, version: getVersion(), build: getBuildInfo() })
);

function ageSeconds(value: unknown, nowMs = Date.now()): number | null {
  if (typeof value !== "string" || !value) return null;
  const time = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(time) ? Math.max(0, Math.round((nowMs - time) / 1_000)) : null;
}

export function schedulerReadiness(lastAt: unknown, options: { now_ms?: number; uptime_sec?: number; stale_after_sec?: number } = {}) {
  const age_sec = ageSeconds(lastAt, options.now_ms ?? Date.now());
  const staleAfter = options.stale_after_sec ?? 180;
  const status = age_sec == null
    ? ((options.uptime_sec ?? process.uptime()) < staleAfter ? "starting" : "stale")
    : (age_sec <= staleAfter ? "fresh" : "stale");
  return { status, age_sec, ok: status !== "stale" } as const;
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
    const scheduler = schedulerReadiness(heartbeat?.value ?? heartbeat?.updated_at);
    const ok = scheduler.ok;
    return res.status(ok ? 200 : 503).json({
      ok,
      database: "ok",
      build: getBuildInfo(),
      queues: { agent_jobs: queue("agent_jobs"), chat_turns: queue("chat_turns") },
      scheduler: { status: scheduler.status, last_at: heartbeat?.value ?? null, age_sec: scheduler.age_sec },
    });
  } catch {
    return res.status(503).json({ ok: false, database: "unavailable" });
  }
}

// Readiness is stronger than liveness: prove SQLite is readable and expose only
// compact durable queue counts/ages/failures plus scheduler freshness and build
// provenance. Optional coaching providers never gate readiness.
systemRouter.get("/ready", readinessHandler);

// Semantic version plus exact build SHA/build id for deploy correlation.
systemRouter.get("/version", (_req, res) => res.json({ version: getVersion(), build: getBuildInfo() }));
// Cached release status; the scheduler refreshes it and POST performs an
// explicit operator-pulled check.
systemRouter.get("/update-status", (_req, res) => res.json(getUpdateStatus()));
systemRouter.post("/update-check", async (_req, res) => {
  // checkForUpdate never throws; network failures fold into status.error.
  res.json(await checkForUpdate());
});
