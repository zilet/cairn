import { Router } from "express";
import type { Request, Response } from "express";
import { authEnabled } from "../auth.js";
import { getUpdateStatus, checkForUpdate } from "../updateCheck.js";
import { getVersion } from "../version.js";
import { db } from "../db.js";

export const systemRouter = Router();

systemRouter.get("/health", (_req, res) => res.json({ ok: true, auth_required: authEnabled, version: getVersion() }));

export function readinessHandler(_req: Request, res: Response) {
  try {
    db.prepare("SELECT 1 AS ok").get();
    const queue = (table: "agent_jobs" | "chat_turns") => {
      const rows = db
        .prepare(`SELECT status, COUNT(*) AS count FROM ${table} WHERE status IN ('queued', 'running') GROUP BY status`)
        .all() as Array<{ status: string; count: number }>;
      const counts = { queued: 0, running: 0 };
      for (const row of rows) {
        if (row.status === "queued" || row.status === "running") counts[row.status] = Number(row.count);
      }
      return counts;
    };
    return res.json({
      ok: true,
      database: "ok",
      queues: { agent_jobs: queue("agent_jobs"), chat_turns: queue("chat_turns") },
    });
  } catch {
    return res.status(503).json({ ok: false, database: "unavailable" });
  }
}

systemRouter.get("/ready", readinessHandler);

// The running version, and whether a newer Cairn release exists. The status is
// served from the app_state cache; the scheduler keeps it fresh, and POST forces
// an explicit operator-pulled check.
systemRouter.get("/version", (_req, res) => res.json({ version: getVersion() }));
systemRouter.get("/update-status", (_req, res) => res.json(getUpdateStatus()));
systemRouter.post("/update-check", async (_req, res) => {
  // checkForUpdate never throws; network failures fold into status.error.
  res.json(await checkForUpdate());
});
